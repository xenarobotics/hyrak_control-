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

plus model_id, model_name, model_version and task. A runner that crashed
or is restarting gives an `error` (plain words) and no detections for that
frame; the video keeps flowing.

Alerts: a model may carry one rule, {label, min_score, cooldown_s}. When a
detection (or the top class) matches, the session gets a `model_alert`
socket event and the cv_results frame carries it as `alert` and
`alert_hits [{label, score}]`; staff
consoles watching the workspace get it through the existing admin_alert
path. At most one per cooldown per session.

No drone actions in step 1: nothing here sets `drone_command`, so nothing
can move the drone, and there is nothing for a takeover to stop.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, Tuple

import numpy as np

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
        logger.info(f"CustomModelAnalyzer: {spec.name or spec.model_id[:8]} v{spec.version} "
                    f"({self.task}) on {runner.provider}")

    # ------------------------------------------------------------------ #
    def _label(self, class_id: int) -> str:
        return self.labels[class_id] if 0 <= class_id < len(self.labels) else f"class {class_id}"

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
        try:
            res = self.runner.infer(np.ascontiguousarray(frame), self.spec.threshold)
        except runtime.RunnerError as e:
            f = runtime.as_failure(e)
            msg = describe(f.code, f.extra)[0]
            if e.code == "restarting":
                msg = f"The model is restarting (in {e.retry_in:.0f} s)."
            warn_limited(f"custom:{self.spec.model_id}", f"Custom model {self.spec.model_id[:8]}: "
                                                         f"{e.code} {e.detail}")
            meta.update({"error": msg, "runner": e.code})
            return frame_bgr, meta
        meta["infer_ms"] = res.get("infer_ms")
        inv = 1.0 / scale
        if res.get("task") == "classify":
            classes = [{"name": self._label(t["class_id"]), "score": round(float(t["score"]), 4)}
                       for t in res.get("top", [])]
            meta["classes"] = classes
            meta["predictions"] = classes          # the frontend's name for the same list
            meta["top_class"] = classes[0]["name"] if classes else None
            meta["top_score"] = classes[0]["score"] if classes else None
            hits = [(c["name"], c["score"], None) for c in classes[:1]]
        else:
            counts: Dict[str, int] = {}
            dets = []
            for d in res.get("detections", []):
                name = self._label(int(d["class_id"]))
                counts[name] = counts.get(name, 0) + 1
                x1, y1, x2, y2 = d["box"]
                dets.append({"name": name, "score": round(float(d["score"]), 4),
                             "box": [int(x1 * inv), int(y1 * inv), int(x2 * inv), int(y2 * inv)]})
            meta.update({"objects": counts, "detections": dets,
                         "person_count": counts.get("person", 0),
                         "total_count": sum(counts.values())})
            hits = [(d["name"], d["score"], d["box"]) for d in dets]
        self._check_alert(meta, hits)
        return frame_bgr, meta

    def _check_alert(self, meta: Dict[str, Any], hits) -> None:
        rule = self.spec.alert or {}
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
