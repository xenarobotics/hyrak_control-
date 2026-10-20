"""
Running a custom model in a live session: `set_analysis_mode {mode:
"custom:<model_id>"}` puts a CustomModelMode on the session, and the vision
pool builds a CustomModelAnalyzer for it like any built-in mode.

The analyzer does no inference itself. It hands each frame to the model's
runner process (app/models_custom/runtime.py) and turns the answer into
the `cv_results` shape the overlay already draws for object detection:

    detect    objects {name: count}, detections [{name, box, score}],
              person_count, total_count
    classify  predictions (alias classes) [{name, score}] (top 5),
              top_class, top_score, and
              empty objects / detections so every panel stays happy

plus model_id, model_name, model_version, task, infer_ms (the whole
frame, every tile included), threshold, tiling ("off", "2x2", "3x3": what
ran on this frame, "auto" resolved), classes_shown (null or the names) and
the run's tally since the model started on this session: run_frames and
run_counts {name: {peak, frames}} (detect: the most seen at once and the
frames it was in; classify: the frames it was the top answer). A runner that crashed
or is restarting gives an `error` (plain words) and no detections for that
frame; the video keeps flowing.

Settings: the sensitivity (threshold), the shown classes and tiling come
from the RunSpec, and for the owning workspace's own runs from
runtime.live(model_id) when a PATCH changed them since, so a change applies
on the next frame. Hidden classes are dropped before counts and alerts.

Alerts: a model may carry one rule, {label, min_score, cooldown_s}. When a
detection (or the top class) matches, the session gets a `model_alert`
socket event and the cv_results frame carries it as `alert` and
`alert_hits [{label, score}]`; staff
consoles watching the workspace get it through the existing admin_alert
path. At most one per cooldown per session.

Rules (app/models_custom/rules.py): the model's no-code rules are checked
on every frame here (RuleEngine: seen-for with gaps, cooldown). The frame
carries `rules_state` for the panel and, when rules fired, a private
`_rule_fires` that app/models_custom/actions.py picks up on the event loop
(stream_track) and runs behind its guards.

Follow: actions.py starts a follow with start_follow() once the drone is
in Offboard. While it is on, each frame keeps the lock on the followed box
(rules.FollowTarget), shows it as `follow {active, label, score, box,
lost_s}`, and sets `drone_command` (a capped velocity) for the existing
stream_track path; an unseen target gets a zero command, and after
rules.LOST_S the frame says `_follow_lost` so actions.py stops it. No
follow, no `drone_command`: nothing else here can move the drone.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, Optional, Tuple

import numpy as np

from app.models_custom import rules as _rules
from app.models_custom import runtime
from app.models_custom.errors import describe
from app.vision.base import BaseAnalyzer, warn_limited
from app.vision.drawing import draw_badge, draw_brackets

logger = logging.getLogger("verocore.models.analyzer")

PREFIX = "custom:"


class CustomModelMode:
    """Stands in for an AnalysisMode on a session running a custom model.
    `value` is the mode string the client sent ("custom:<model_id>");
    equality is on (workspace, model, version), so re-selecting the same
    model after a new version became ready loads the new one."""

    def __init__(self, spec: runtime.RunSpec):
        self.spec = spec

    @property
    def value(self) -> str:
        return PREFIX + self.spec.model_id

    @property
    def model_id(self) -> str:
        return self.spec.model_id

    def __eq__(self, other) -> bool:
        return isinstance(other, CustomModelMode) and other.spec.key == self.spec.key

    def __hash__(self) -> int:
        return hash(("custom",) + self.spec.key)

    def __repr__(self) -> str:
        return f"CustomModelMode({self.value} v{self.spec.version})"

    def build_analyzer(self, results_callback=None) -> "CustomModelAnalyzer":
        return CustomModelAnalyzer(self.spec, results_callback=results_callback)


class _PoolHandle:
    """BaseAnalyzer.hold() protocol: released by stop()."""

    def __init__(self, spec: runtime.RunSpec, runner: runtime.Runner):
        self.obj = runner
        self._spec = spec
        self._released = False

    def release(self) -> None:
        if not self._released:
            self._released = True
            runtime.pool().release(self._spec)


class CustomModelAnalyzer(BaseAnalyzer):
    MODE = "custom"

    def __init__(self, spec: runtime.RunSpec, results_callback=None):
        super().__init__(executor_workers=1, results_callback=results_callback)
        self.spec = spec
        self.labels = list(spec.labels or spec.spec.get("labels") or [])
        self.task = spec.spec.get("task", "detect")
        try:
            runner = runtime.pool().acquire(spec)
        except runtime.RunnerError as e:
            raise RuntimeError(describe(runtime.as_failure(e).code)[0]) from e
        handle = _PoolHandle(spec, runner)
        try:
            runner.ensure_started()
        except runtime.RunnerError as e:
            handle.release()
            f = runtime.as_failure(e)
            raise RuntimeError(f"{describe(f.code, f.extra)[0]} ({e.detail})"[:400]) from e
        self.hold(handle)
        self.runner = runner
        self._last_alert = 0.0
        self._rule_engine = _rules.RuleEngine()
        # Set and cleared from the event loop (actions.py) by plain
        # assignment; a frame reads it once, so a stop mid-frame at worst
        # lets one command through to actions.py, which drops it.
        self._follow: Optional[_rules.FollowTarget] = None
        self._follow_ctl: Optional[_rules.FollowController] = None
        # The last frame's boxes (monotonic time, hits): a follow confirmed
        # seconds after its rule fired locks on where the target is now.
        self._last_hits: Tuple[float, list] = (0.0, [])
        self._run_frames = 0
        self._run_counts: Dict[str, Dict[str, int]] = {}
        logger.info(f"CustomModelAnalyzer: {spec.name or spec.model_id[:8]} v{spec.version} "
                    f"({self.task}) on {runner.provider}")

    # ------------------------------------------------------------------ #
    def _label(self, class_id: int) -> str:
        return self.labels[class_id] if 0 <= class_id < len(self.labels) else f"class {class_id}"

    def _settings(self) -> Dict[str, Any]:
        """This frame's settings: the spec's, with the owning workspace's
        live edits on top (catalogue runs keep the published snapshot)."""
        out = {"threshold": self.spec.threshold, "classes_shown": self.spec.classes_shown,
               "tiling": self.spec.tiling or "off", "alert": self.spec.alert,
               "rules": self.spec.rules}
        if not self.spec.via_catalogue:
            live = runtime.live(self.spec.model_id)
            if live:
                out.update({k: live[k] for k in out if k in live})
                if live.get("labels") and live.get("labels_version") == self.spec.version:
                    self.labels = list(live["labels"])     # renamed while running
        return out

    def _class_ids(self, shown) -> Any:
        if shown is None:
            return None
        names = {str(n).lower() for n in shown}
        return [i for i, label in enumerate(self.labels) if label.lower() in names]

    def _tally(self, meta: Dict[str, Any], names) -> None:
        """Per-class counts over the run: peak at once and frames seen."""
        self._run_frames += 1
        now: Dict[str, int] = {}
        for n in names:
            now[n] = now.get(n, 0) + 1
        for n, c in now.items():
            t = self._run_counts.setdefault(n, {"peak": 0, "frames": 0})
            t["peak"] = max(t["peak"], c)
            t["frames"] += 1
        meta["run_frames"] = self._run_frames
        meta["run_counts"] = {n: dict(t) for n, t in self._run_counts.items()}

    def _base_meta(self) -> Dict[str, Any]:
        return {"model_id": self.spec.model_id, "model_name": self.spec.name,
                "model_version": self.spec.version, "task": self.task,
                "objects": {}, "detections": [], "person_count": 0, "total_count": 0}

    def _analyze_frame_blocking(self, frame_bgr: np.ndarray) -> Tuple[np.ndarray, Dict[str, Any]]:
        meta = self._base_meta()
        h, w = frame_bgr.shape[:2]
        frame, scale = frame_bgr, 1.0
        if w > runtime.MAX_W or h > runtime.MAX_H:
            import cv2
            scale = min(runtime.MAX_W / w, runtime.MAX_H / h)
            frame = cv2.resize(frame_bgr, (max(1, int(w * scale)), max(1, int(h * scale))))
        st = self._settings()
        shown = st["classes_shown"]
        allow = None if shown is None else {str(n).lower() for n in shown}
        meta.update({"threshold": st["threshold"], "classes_shown": shown})
        try:
            res = self.runner.infer(np.ascontiguousarray(frame), st["threshold"],
                                    {"tiling": st["tiling"], "classes": self._class_ids(shown)})
        except runtime.RunnerError as e:
            f = runtime.as_failure(e)
            msg = describe(f.code, f.extra)[0]
            if e.code == "restarting":
                msg = f"The model is restarting (in {e.retry_in:.0f} s)."
            warn_limited(f"custom:{self.spec.model_id}", f"Custom model {self.spec.model_id[:8]}: "
                                                         f"{e.code} {e.detail}")
            meta.update({"error": msg, "runner": e.code})
            # A follow sees nothing on this frame: zero command, then lost.
            self._follow_frame(meta, [], w, h, time.monotonic())
            return frame_bgr, meta
        meta["infer_ms"] = res.get("infer_ms")
        meta["tiling"] = res.get("tiling", "off")
        inv = 1.0 / scale
        if res.get("task") == "classify":
            classes = [{"name": self._label(t["class_id"]), "score": round(float(t["score"]), 4)}
                       for t in res.get("top", [])]
            if allow is not None:
                classes = [c for c in classes if c["name"].lower() in allow]
            meta["classes"] = classes
            meta["predictions"] = classes          # the frontend's name for the same list
            meta["top_class"] = classes[0]["name"] if classes else None
            meta["top_score"] = classes[0]["score"] if classes else None
            hits = [(c["name"], c["score"], None) for c in classes[:1]]
            self._tally(meta, [classes[0]["name"]] if classes else [])
        else:
            counts: Dict[str, int] = {}
            dets = []
            for d in res.get("detections", []):
                name = self._label(int(d["class_id"]))
                if allow is not None and name.lower() not in allow:
                    continue
                counts[name] = counts.get(name, 0) + 1
                x1, y1, x2, y2 = d["box"]
                dets.append({"name": name, "score": round(float(d["score"]), 4),
                             "box": [int(x1 * inv), int(y1 * inv), int(x2 * inv), int(y2 * inv)]})
            meta.update({"objects": counts, "detections": dets,
                         "person_count": counts.get("person", 0),
                         "total_count": sum(counts.values())})
            hits = [(d["name"], d["score"], d["box"]) for d in dets]
            self._tally(meta, [d["name"] for d in dets])
        self._check_alert(meta, hits, st["alert"])
        now = time.monotonic()
        if st.get("rules"):
            fires, state = self._rule_engine.update(st["rules"], hits, now)
            meta["rules_state"] = state
            if fires:
                meta["_rule_fires"] = fires
        self._last_hits = (now, hits)
        self._follow_frame(meta, hits, w, h, now)
        return frame_bgr, meta

    # ── follow (started and stopped by actions.py) ─────────────────────── #
    def start_follow(self, label: str, box, score: float) -> None:
        self._follow_ctl = _rules.FollowController()
        self._follow = _rules.FollowTarget(label, box, score, time.monotonic())

    def current_box(self, label: str, near) -> Optional[Tuple[Any, float]]:
        """(box, score) of `label` on the latest frame (under 1 s old): the
        box whose centre is nearest `near`, or None when it is not in view."""
        at, hits = self._last_hits
        if time.monotonic() - at > 1.0:
            return None
        want = label.lower()
        boxes = [(b, sc) for n, sc, b in hits if b is not None and n.lower() == want]
        if not boxes:
            return None
        if not near:
            return max(boxes, key=lambda x: x[1])
        cx, cy = (near[0] + near[2]) / 2, (near[1] + near[3]) / 2
        return min(boxes, key=lambda x: ((x[0][0] + x[0][2]) / 2 - cx) ** 2
                   + ((x[0][1] + x[0][3]) / 2 - cy) ** 2)

    def stop_follow(self) -> None:
        self._follow = None

    @property
    def following(self) -> bool:
        return self._follow is not None

    def _follow_frame(self, meta: Dict[str, Any], hits, w: int, h: int, now: float) -> None:
        target, ctl = self._follow, self._follow_ctl
        if target is None or ctl is None:
            return
        if target.update(hits, w, h, now) is not None:
            meta["drone_command"] = ctl.command(target, w, h)
        elif target.lost_s(now) >= _rules.LOST_S:
            meta["_follow_lost"] = True
        else:
            # Unseen for a moment: stay put rather than fly the last command.
            meta["drone_command"] = _rules.velocity()
        meta["follow"] = target.public(now)

    def _check_alert(self, meta: Dict[str, Any], hits, rule=None) -> None:
        rule = rule or {}
        label = str(rule.get("label") or "").strip().lower()
        if not label:
            return
        min_score = float(rule.get("min_score", 0.5))
        cooldown = float(rule.get("cooldown_s", 30.0))
        best = None
        for name, score, box in hits:
            if name.lower() == label and score >= min_score and (best is None or score > best[1]):
                best = (name, score, box)
        if best is None:
            return
        now = time.time()
        if now - self._last_alert < cooldown:
            return
        self._last_alert = now
        name, score, box = best
        message = f"{self.spec.name or 'Custom model'}: {name} seen ({score * 100:.0f}%)"
        alert = {"model_id": self.spec.model_id, "model_name": self.spec.name, "label": name,
                 "score": score, "box": box, "ts": now, "message": message}
        meta["alert"] = alert
        meta["alert_hits"] = [{"label": name, "score": score}]
        meta["_pending_model_alerts"] = [alert]
        meta["_pending_admin_alerts"] = [{"level": "warning", "message": message,
                                          "source": "custom_model",
                                          "model_id": self.spec.model_id}]

    def draw_overlay(self, frame_bgr: np.ndarray, meta: Dict[str, Any]) -> np.ndarray:
        for det in meta.get("detections", []):
            x1, y1, x2, y2 = det["box"]
            draw_brackets(frame_bgr, x1, y1, x2, y2, (220, 220, 220), thickness=2)
            draw_badge(frame_bgr, det["name"], x1, max(16, y1 - 4))
        if meta.get("top_class"):
            draw_badge(frame_bgr, f"{meta['top_class']} {meta.get('top_score', 0) * 100:.0f}%",
                       12, 24)
        return frame_bgr
