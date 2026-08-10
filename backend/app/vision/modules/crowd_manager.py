"""
Crowd management — live people count, density (green/orange/red),
sectional density + sustained-density alerts, per BaseAnalyzer's usual
YOLO+ByteTrack shape (same tracker as human_tracker.py/person_tracker.py).

Density thresholds and the sectional-alert design are ported from the
reference project in sources/crowd management/engine.py (a fixed-camera
CCTV desktop app), adapted to this repo's per-frame analyzer shape.

One deliberate correction vs. that source: it presents "cumulative unique
footfall" (distinct ByteTrack IDs ever seen) as a hard number. On a MOVING
drone camera the same people can be re-seen and get new IDs, or the same
crowd can be revisited — so that number is exposed here as
`distinct_tracks_seen` (an upper-bound-ish diagnostic), never framed as a
real footfall count. `peak_count` (max simultaneous count this session) is
the honest headline stat instead.

DB writes and admin alerts aren't done directly here — this method runs in
a worker thread (BaseAnalyzer's executor), not the asyncio event loop.
Decisions are queued onto the returned meta dict; stream_track.py's recv()
(already back in the event loop) dispatches them — see
app/vision/persistence.py and app/events/admin_events.py.
"""
import logging
import time
from typing import Any, Dict, List, Tuple

import cv2
from collections import deque

import numpy as np
import torch
from ultralytics import YOLO

from app.vision.base import BaseAnalyzer
from app.vision.controllers import (
    KalmanXY, PDController, VelocitySmoother, range_error_ratio,
)
from app.vision.drawing import draw_badge, draw_ring, draw_tint_rect
from app.vision.geometry import (
    blend_weight_for_position, camera_from_settings, deforeshorten_size,
    pose_from_telemetry, size_ratio_from_ground_range,
)
from app.vision.pursuit import (
    PursuitLimits, ROW_NUDGE_STEP, clamp_row_target, decide_elevation,
    distance_axis, foot_row, is_outpaced, limit_climb, limit_descent,
    lock_state_for, new_row_pd, row_reference_is_stale, scale_forward,
)
from app.vision.tracker_config import make_bytetrack_cfg
from app.config import get_settings
from app.vision import calibration as _cal

logger = logging.getLogger("verocore.vision.crowd_manager")

_TRACKER_CFG = make_bytetrack_cfg("verocore_crowd_bt_")

# Operator-adjustable per session via set_thresholds() (Settings page) —
# whole-frame density is FOV-dependent, there's no universally correct
# default (same caveat the source project's own README calls out).
_DEFAULT_LIGHT_MAX = 8
_DEFAULT_MODERATE_MAX = 20

_GRID_ROWS, _GRID_COLS = 3, 3
_ALERT_SUSTAIN_S = 8.0      # a section must stay RED this long before alerting
_ALERT_COOLDOWN_S = 30.0    # ...and won't re-fire for the same section sooner than this
_SNAPSHOT_INTERVAL_S = 2.0
# Trend sampling. 2s x 150 = the last 5 minutes, which is the window that
# actually answers "is this building or settling" — the question a live
# headcount alone cannot answer, and the one that decides whether you act
# before a crush rather than after it.
_HISTORY_INTERVAL_S = 2.0
_HISTORY_POINTS = 150  # live DB sample cadence (not every frame)

# ── Follow, shared with human_tracker ────────────────────────────────────────
# Crowd management already tracks every person with a stable ByteTrack id, so
# following one is a matter of wiring the same PD stack to it rather than new
# perception. Operators watching a crowd are exactly the people who need to
# pull one individual out of it without switching modes and losing the count.
_DEFAULT_DISTANCE_RATIO = 0.25
_SUBJECT_HEIGHT_M = 1.7
_HEIGHT_EMA_ALPHA = 0.12
_YAW_PRIORITY_THRESHOLD = 0.30
_YAW_PRIORITY_FLOOR = 0.35
MAX_PURSUIT_SPEED_M_S = 2.5
_PHASE_HOLD = 90
_PHASE_SWEEP = 180

_LEVEL_COLOR_BGR = {"green": (0, 200, 0), "orange": (0, 165, 255), "red": (0, 0, 230)}


def _density_level(count: int, light_max: int, moderate_max: int) -> str:
    if count <= light_max:
        return "green"
    if count <= moderate_max:
        return "orange"
    return "red"


def _make_state() -> Dict[str, Any]:
    return {
        "peak_count": 0,
        "seen_ids": set(),
        # From the persisted calibration, so an operator's custom values
        # apply from the FIRST frame rather than whenever a socket push
        # happens to land after the analyzer exists.
        "light_max": _cal.effective()["crowd_light_max"],
        "moderate_max": _cal.effective()["crowd_moderate_max"],
        "section_dense_since": {},
        "section_last_alert": {},
        "last_snapshot_t": 0.0,
            # ── Follow ────────────────────────────────────────────────────
        # Operator-assigned names for the 9 cells. "North Gate is red" is
        # actionable over a radio; "cell 4 is red" is not.
        "zone_names": {},
        # Rolling headcount history for the trend readout. Deque, not a list:
        # a session can run for hours and the panel only ever draws the tail.
        "count_history": deque(maxlen=_HISTORY_POINTS),
        "last_history_t": 0.0,
        "selected_id": None,
        "tracking": False,
        "altitude_mode": "fixed",
        "altitude_nudge_v": 0.0,
        "target_distance_ratio": _DEFAULT_DISTANCE_RATIO,
        # Frame row Fixed mode holds the feet on; None = take it from the
        # subject on the next frame. See human_tracker for why it is seeded
        # from an observation rather than fixed at frame centre.
        "target_row": None,
        "height_ema": None,
        "frames_lost": 0,
        "last_seen_t": 0.0,
        "last_drone_command": None,
        "last_yaw_dir": 1.0,
        "elevate": None,
        "yaw_pd": PDController(kp=30.0, kd=4.0, max_output=55.0, deadband=0.05),
        "alt_pd": PDController(kp=1.5, kd=0.3, max_output=1.0, deadband=0.10),
        "dist_pd": PDController(kp=4.0, kd=1.0, max_output=2.5, deadband=0.08),
        # The Fixed-altitude distance axis — see pursuit.new_row_pd.
        "row_pd": new_row_pd(),
        "kalman": KalmanXY(),
        "smoother": VelocitySmoother(alpha=0.4),
    }


class CrowdManager(BaseAnalyzer):
    MODE = "crowd-management"

    def __init__(self, **kwargs):
        super().__init__(executor_workers=2, **kwargs)
        settings = get_settings()
        self.device = settings.device
        self.half = self.device == "cuda"
        self.model = YOLO(settings.default_yolo_model)
        self.model.to(self.device)
        # Warm-up so CUDA kernel init doesn't stall the first live frames
        self.model(
            np.zeros((360, 640, 3), dtype=np.uint8),
            device=self.device, half=self.half, verbose=False,
        )
        self._client_state: Dict[str, Dict[str, Any]] = {}
        logger.info(f"✅ CrowdManager ready on {self.device.upper()}")

    def register_client(self, client_id: str):
        super().register_client(client_id)
        self._client_state[client_id] = _make_state()

    async def unregister_client(self, client_id: str):
        await super().unregister_client(client_id)
        self._client_state.pop(client_id, None)

    def set_thresholds(self, client_id: str, light_max: int, moderate_max: int):
        """
        Apply density thresholds to the running session AND persist them.

        Persisting is what makes them stick: state is rebuilt from scratch
        every time an analyzer is created, so a value that lives only in
        session state is lost on the next stream — which is exactly how custom
        thresholds kept reverting to the defaults a few seconds in.
        """
        lo = max(1, int(light_max))
        hi = max(lo + 1, int(moderate_max))

        state = self._client_state.get(client_id)
        if state:
            state["light_max"], state["moderate_max"] = lo, hi

        try:
            _cal.save({"crowd_light_max": lo, "crowd_moderate_max": hi})
        except Exception as e:
            # A failed write must not break the live session — the running
            # values above are already applied.
            logger.warning(f"Could not persist density thresholds: {e}")
        logger.info(f"Session {client_id[:8]}: density thresholds -> {lo}/{hi} (persisted)")

    @staticmethod
    def _section_bounds(w, h):
        cell_w, cell_h = w // _GRID_COLS, h // _GRID_ROWS
        boxes = []
        for r in range(_GRID_ROWS):
            for c in range(_GRID_COLS):
                x1, y1 = c * cell_w, r * cell_h
                x2 = w if c == _GRID_COLS - 1 else (c + 1) * cell_w
                y2 = h if r == _GRID_ROWS - 1 else (r + 1) * cell_h
                boxes.append((x1, y1, x2, y2))
        return boxes

    @staticmethod
    def _assign_section(cx, cy, boxes) -> int:
        for idx, (x1, y1, x2, y2) in enumerate(boxes):
            if x1 <= cx < x2 and y1 <= cy < y2:
                return idx
        return -1

    @torch.inference_mode()
    def _analyze_frame_blocking(
        self, frame_bgr: np.ndarray
    ) -> Tuple[np.ndarray, Dict[str, Any]]:
        H, W = frame_bgr.shape[:2]
        frame_proc, sx, sy = self.resize_for_inference(frame_bgr)

        # imgsz MUST match the pre-resized width. Ultralytics letterboxes to
        # imgsz (default 640) internally, so handing it a 1280-wide frame
        # without saying so just downscales it straight back and the extra
        # resolution is thrown away — the altitude ceiling would not move.
        results = self.model.track(
            frame_proc, classes=[0], imgsz=self.imgsz_for(frame_proc),
            device=self.device, half=self.half, verbose=False, conf=0.4,
            persist=True, tracker=_TRACKER_CFG,
        )

        people = []
        if results and results[0].boxes is not None and len(results[0].boxes):
            boxes = results[0].boxes
            xyxy = boxes.xyxy.cpu().numpy()
            track_ids = (
                boxes.id.int().cpu().numpy() if boxes.id is not None else range(len(xyxy))
            )
            for tid, box in zip(track_ids, xyxy):
                x1, y1 = int(box[0] * sx), int(box[1] * sy)
                x2, y2 = int(box[2] * sx), int(box[3] * sy)
                people.append({"id": int(tid), "box": [x1, y1, x2, y2]})

        current_count = len(people)
        section_boxes = self._section_bounds(W, H)
        section_counts: Dict[int, int] = {}

        # Single session per analyzer instance (worker_pool loads one
        # instance per session, same as human_tracker.py) — one iteration.
        state = None
        for _client_id, s in self._client_state.items():
            state = s
            for p in people:
                state["seen_ids"].add(p["id"])
                cx = (p["box"][0] + p["box"][2]) // 2
                cy = (p["box"][1] + p["box"][3]) // 2
                sec = self._assign_section(cx, cy, section_boxes)
                if sec >= 0:
                    section_counts[sec] = section_counts.get(sec, 0) + 1
            state["peak_count"] = max(state["peak_count"], current_count)
            break

        light_max = state["light_max"] if state else _DEFAULT_LIGHT_MAX
        moderate_max = state["moderate_max"] if state else _DEFAULT_MODERATE_MAX
        level = _density_level(current_count, light_max, moderate_max)

        pending_db: List[dict] = []
        pending_alerts: List[dict] = []
        now = time.time()

        if state is not None:
            for idx in range(len(section_boxes)):
                cnt = section_counts.get(idx, 0)
                sec_level = _density_level(cnt, light_max, moderate_max)
                if sec_level == "red":
                    since = state["section_dense_since"].setdefault(idx, now)
                    sustained = now - since
                    last_alert = state["section_last_alert"].get(idx, 0.0)
                    if sustained >= _ALERT_SUSTAIN_S and now - last_alert >= _ALERT_COOLDOWN_S:
                        state["section_last_alert"][idx] = now
                        # The operator's own label if they set one. This is
                        # the whole point of naming zones: an alert that says
                        # "North Gate" can be acted on over a radio, and one
                        # that says "section 4" has to be decoded first.
                        where = state["zone_names"].get(str(idx)) or f"section {idx}"
                        msg = f"Crowd {where} DENSE for {sustained:.0f}s ({cnt} people)"
                        pending_db.append({
                            "table": "crowd_alert", "level": "red",
                            "section_idx": idx, "count": cnt, "message": msg,
                        })
                        pending_alerts.append({"level": "danger", "message": msg})
                else:
                    state["section_dense_since"].pop(idx, None)

            if now - state["last_snapshot_t"] >= _SNAPSHOT_INTERVAL_S:
                state["last_snapshot_t"] = now
                pending_db.append({
                    "table": "crowd_snapshot",
                    "current_count": current_count,
                    "peak_count": state["peak_count"],
                    "density_level": level,
                    "section_counts": section_counts,
                })

        # ── Follow ────────────────────────────────────────────────────────
        ctx = self.frame_context(next(iter(self._client_state), ""))
        pose = pose_from_telemetry(ctx.telemetry) if ctx else None
        drone_command = (
            self._follow(state, people, next(iter(self._client_state), ""),
                         W, H, ctx, pose)
            if state is not None else None
        )
        sel = state.get("selected_id") if state else None
        seen_t = state.get("last_seen_t", 0.0) if state else 0.0
        lost_s = (time.monotonic() - seen_t) if seen_t else 0.0
        lock, lock_msg = lock_state_for(
            visible=any(p["id"] == sel for p in people),
            seconds_lost=lost_s,
            tracking=bool(state and state.get("tracking")),
        )

        if state is not None:
            if now - state.get("last_history_t", 0.0) >= _HISTORY_INTERVAL_S:
                state["last_history_t"] = now
                state["count_history"].append(
                    {"t": round(now, 1), "n": current_count}
                )

        hist = list(state["count_history"]) if state else []
        # Rate of change over the last minute, people/min. The headline number
        # for "is this building": a steady 200 and a 200 that was 120 a minute
        # ago are completely different situations and read identically from a
        # live count.
        trend_per_min = None
        if len(hist) >= 2:
            recent = [h for h in hist if now - h["t"] <= 60.0] or hist[-2:]
            span = recent[-1]["t"] - recent[0]["t"]
            if span > 1.0:
                trend_per_min = round(
                    (recent[-1]["n"] - recent[0]["n"]) * 60.0 / span, 1
                )

        meta: Dict[str, Any] = {
            "people": people,
            "current_count": current_count,
            # ── Trend ─────────────────────────────────────────────────────
            "count_history": hist,
            "trend_per_min": trend_per_min,
            "zone_names": dict((state or {}).get("zone_names", {})),
            # ── Follow state, so one person can be pulled out of the crowd
            # without leaving the mode and losing the count.
            "selected_id": sel,
            "tracking": bool(state and state.get("tracking")),
            "altitude_mode": (state or {}).get("altitude_mode", "fixed"),
            "target_distance_ratio": round(
                (state or {}).get("target_distance_ratio", _DEFAULT_DISTANCE_RATIO), 3),
            "frames_lost": (state or {}).get("frames_lost", 0),
            "searching": bool(state and state.get("tracking") and sel is not None
                              and not any(p["id"] == sel for p in people)),
            "lock_state": lock.value,
            "lock_message": lock_msg,
            "elevate": (state or {}).get("elevate"),
            "drone_command": drone_command,
            "peak_count": state["peak_count"] if state else current_count,
            "distinct_tracks_seen": len(state["seen_ids"]) if state else current_count,
            "density_level": level,
            "section_counts": section_counts,
            "section_grid": [_GRID_ROWS, _GRID_COLS],
            # Sent live so the overlay/panel can show real per-zone
            # thresholds ("what count = orange/red") instead of guessing.
            "light_max": light_max,
            "moderate_max": moderate_max,
        }
        if pending_db:
            meta["_pending_db"] = pending_db
        if pending_alerts:
            meta["_pending_admin_alerts"] = pending_alerts
        return frame_bgr, meta

    def set_zone_names(self, client_id: str, names: Dict[str, str]) -> None:
        """Operator labels for the grid cells, keyed by cell index as a string."""
        st = self._client_state.get(client_id)
        if st is None:
            return
        st["zone_names"] = {
            str(k): str(v)[:24] for k, v in (names or {}).items() if str(v).strip()
        }
        logger.info(f"Session {client_id[:8]}: {len(st['zone_names'])} zone name(s) set")

    # ── Follow one person out of the crowd ────────────────────────────────

    def set_selected_person(self, client_id: str, person_id) -> None:
        st = self._client_state.get(client_id)
        if st is None:
            return
        st["selected_id"] = None if person_id is None else int(person_id)
        st["frames_lost"] = 0
        st["height_ema"] = None
        st["kalman"].reset()
        if person_id is None:
            st["tracking"] = False
        logger.info(f"Session {client_id[:8]}: crowd follow target -> {person_id}")

    def set_tracking(self, client_id: str, active: bool) -> None:
        st = self._client_state.get(client_id)
        if st is None:
            return
        st["tracking"] = bool(active)
        if not active:
            for k in ("yaw_pd", "alt_pd", "dist_pd"):
                st[k].reset()
            st["smoother"].reset()
            st["height_ema"] = None
            st["elevate"] = None
            st["last_drone_command"] = None
            st["altitude_nudge_v"] = 0.0
            st["row_pd"].reset()
        # Taken fresh at every lock: the framing on screen when the operator
        # presses start is the framing they asked for.
        st["target_row"] = None
        logger.info(
            f"Session {client_id[:8]}: crowd follow "
            f"{'STARTED' if active else 'STOPPED'}"
        )

    def set_altitude_mode(self, client_id: str, mode: str) -> None:
        st = self._client_state.get(client_id)
        if st is None or mode not in ("fixed", "auto"):
            return
        st["altitude_mode"] = mode
        # Each mode hands the forward axis to a different sensor; reset the
        # incoming PD and re-take the row reference at the height we are at now.
        if mode == "fixed":
            st["alt_pd"].reset()
            st["row_pd"].reset()
            st["target_row"] = None
        else:
            st["altitude_nudge_v"] = 0.0
            st["dist_pd"].reset()

    def set_altitude_nudge(self, client_id: str, velocity: float) -> None:
        st = self._client_state.get(client_id)
        if st is not None:
            st["altitude_nudge_v"] = float(np.clip(velocity, -1.5, 1.5))

    def set_tracking_params(self, client_id: str, target_distance_ratio: float) -> None:
        """In Fixed altitude the forward axis reads the frame row, so the ratio
        alone would not reach it — the DIRECTION of change is applied to the
        target row as well, keeping CLOSER / FURTHER working in both modes."""
        st = self._client_state.get(client_id)
        if st is None:
            return
        previous = st.get("target_distance_ratio", _DEFAULT_DISTANCE_RATIO)
        ratio = float(np.clip(target_distance_ratio, 0.08, 0.70))
        st["target_distance_ratio"] = ratio
        st["height_ema"] = None

        if st.get("altitude_mode") != "auto" and st.get("target_row") is not None:
            # Closer means the feet sit lower in frame, i.e. a larger row.
            if ratio > previous:
                st["target_row"] = clamp_row_target(st["target_row"] + ROW_NUDGE_STEP)
            elif ratio < previous:
                st["target_row"] = clamp_row_target(st["target_row"] - ROW_NUDGE_STEP)
            st["row_pd"].reset()

    def _follow(self, state, people, client_id, W, H, ctx, pose):
        """
        Same PD stack as human_tracker, driven off the crowd tracker's own
        ByteTrack ids. Returns None only when nothing is selected or tracking
        is disarmed — never while armed, because a gap in the Offboard setpoint
        stream hands control to PX4's failsafe (see plate_tracker's
        _search_command for what that cost).
        """
        sel = state.get("selected_id")
        if sel is None or not state.get("tracking"):
            state["elevate"] = None
            return None

        target = next((p for p in people if p["id"] == sel), None)
        if target is None:
            state["frames_lost"] = state.get("frames_lost", 0) + 1
            fl = state["frames_lost"]
            if fl <= _PHASE_HOLD and state.get("last_drone_command"):
                return state["last_drone_command"]
            if fl <= _PHASE_SWEEP:
                return {"type": "velocity", "forward_m_s": 0.0, "right_m_s": 0.0,
                        "down_m_s": 0.0,
                        "yaw_deg_s": round(12.0 * state.get("last_yaw_dir", 1.0), 1)}
            return {"type": "velocity", "forward_m_s": 0.0, "right_m_s": 0.0,
                    "down_m_s": 0.0, "yaw_deg_s": 0.0}

        state["frames_lost"] = 0
        state["last_seen_t"] = time.monotonic()

        x1, y1, x2, y2 = target["box"]
        fx_n, fy_n = state["kalman"].update((x1 + x2) / (2 * W), (y1 + y2) / (2 * H))
        h_raw = (y2 - y1) / H
        prev = state["height_ema"]
        h_ema = h_raw if prev is None else (
            _HEIGHT_EMA_ALPHA * h_raw + (1 - _HEIGHT_EMA_ALPHA) * prev
        )
        state["height_ema"] = h_ema

        # Where the subject meets the ground. Drives the Fixed-mode distance
        # axis, and is the pixel the ground projection inside
        # _range_observable has to use.
        foot_n = foot_row(fy_n, h_ema)
        h_eff, _ = self._range_observable(
            h_ema, pose, ctx, fx_n, fy_n, foot_n, W, H, _SUBJECT_HEIGHT_M
        )
        err_yaw = fx_n - 0.5
        err_dist = range_error_ratio(
            state.get("target_distance_ratio", _DEFAULT_DISTANCE_RATIO), h_eff
        )

        yaw_deg_s = state["yaw_pd"].compute(err_yaw)
        if yaw_deg_s > 0.5:
            state["last_yaw_dir"] = 1.0
        elif yaw_deg_s < -0.5:
            state["last_yaw_dir"] = -1.0

        if state.get("altitude_mode") == "auto":
            down_m_s = state["alt_pd"].compute(fy_n - 0.5)
        else:
            down_m_s = state.get("altitude_nudge_v", 0.0)

        # ── THE DISTANCE AXIS, PER ALTITUDE MODE ──────────────────────────
        # Fixed reads the frame row (height is held, so the row IS range: high
        # in frame far, low in frame near); Auto reads apparent size,
        # unchanged. See pursuit.distance_axis.
        alt_mode = state.get("altitude_mode", "fixed")
        forward_raw, range_err = distance_axis(
            state=state, altitude_mode=alt_mode,
            foot_row_n=foot_n, size_range_error=err_dist,
        )

        yaw_factor = max(_YAW_PRIORITY_FLOOR,
                         1.0 - abs(err_yaw) / _YAW_PRIORITY_THRESHOLD)
        # A retreat is never throttled — see pursuit.scale_forward.
        forward_m_s = scale_forward(forward_raw, yaw_factor, alt_mode)

        elevate = None
        if forward_m_s > 0:
            depression = None
            if pose is not None and ctx is not None:
                cam = camera_from_settings(ctx.width or W, ctx.height or H)
                depression = pose.depression_deg(cam, W / 2.0, H / 2.0)
            limits = PursuitLimits.from_settings()
            elevate = decide_elevation(
                target_outpacing=is_outpaced(
                    forward_m_s, MAX_PURSUIT_SPEED_M_S, limits,
                    target_growing_distance=range_err > 0.01,
                ),
                agl_m=pose.agl_m if pose else None,
                depression_deg=depression, limits=limits,
            )
            if elevate.elevating:
                down_m_s = elevate.climb_m_s
        state["elevate"] = elevate.to_dict() if elevate else None

        # Floor AND ceiling, at the single point every vertical command
        # converges on. The ceiling matters most for the operator's ▲ nudge,
        # which reached down_m_s having passed no altitude check at all.
        _agl = pose.agl_m if pose else None
        _limits = PursuitLimits.from_settings()
        down_m_s, _floor = limit_descent(down_m_s, _agl, _limits)
        down_m_s, _ceiling = limit_climb(down_m_s, _agl, _limits)

        # Row ranging assumes a held altitude; if the aircraft is moving
        # vertically the reference must be re-taken or the drone reads its own
        # climb as the subject approaching.
        if row_reference_is_stale(alt_mode, down_m_s):
            state["target_row"] = clamp_row_target(foot_n)
            state["row_pd"].reset()

        cmd = state["smoother"].smooth({
            "type": "velocity", "forward_m_s": forward_m_s, "right_m_s": 0.0,
            "down_m_s": down_m_s, "yaw_deg_s": yaw_deg_s,
        })
        out = {
            "type": "velocity",
            "forward_m_s": round(cmd["forward_m_s"], 3),
            "right_m_s": 0.0,
            "down_m_s": round(cmd["down_m_s"], 3),
            "yaw_deg_s": round(cmd["yaw_deg_s"], 2),
        }
        state["last_drone_command"] = out
        return out

    def _range_observable(self, h_ema, pose, ctx, fx_n, fy_n, foot_n, W, H, subject_h_m):
        """
        Distance observable in size-ratio units, blending the two estimates a
        single camera can give.

        SIZE (de-foreshortened) is the primary and the only one that works
        without telemetry. POSITION (where the subject's feet meet the ground
        plane) is fused in as the view steepens, because that is exactly where
        the size estimate degrades and the position one sharpens — see
        geometry.blend_weight_for_position for the measured crossover.

        Returns h_ema unchanged when there is no pose, so every no-telemetry
        path behaves exactly as it did before this existed.
        """
        from app.vision import calibration as _cal
        from app.vision.geometry import (
            camera_from_settings,
        )
        if pose is None or ctx is None:
            return h_ema, None

        cam = camera_from_settings(ctx.width or W, ctx.height or H)
        # TWO DIFFERENT PIXELS ON PURPOSE. The de-foreshortening angle belongs
        # at the subject's mid-height, because that is the vertical extent being
        # foreshortened. The ground projection below belongs at the feet. Using
        # one pixel for both is what put a forward bias in the range estimate.
        px, py = fx_n * W, fy_n * H
        phi = pose.depression_deg(cam, px, py)
        if phi is None:
            return h_ema, None

        ref = _cal.effective()["camera_mount_tilt_deg"]
        from_size = deforeshorten_size(h_ema, phi, ref)

        # FEET, NOT CENTRE. The comment here said exactly this while the code
        # passed the box centre, and the centre floats half a subject's height
        # off the ground — so its ray cleared the subject and struck the ground
        # BEYOND them. The over-estimate is AGL/(AGL - h/2), independent of
        # viewing angle: +17% at 6 m AGL, +27% at 4 m, +40% at 3 m. Range too
        # long reads as "further than wanted", which commands FORWARD, and the
        # position estimate is weighted in hardest at steep depression — i.e.
        # exactly when the subject is low in the frame and the drone should have
        # been backing off. Reported from flight as "person on the lower side of
        # frame and it moves forward instead of back".
        projected = pose.project_to_ground(cam, px, foot_n * H)
        if projected is None:
            return from_size, phi
        from_pos = size_ratio_from_ground_range(
            projected[2], subject_h_m, cam, H, ref
        )
        if from_pos is None:
            return from_size, phi

        w = blend_weight_for_position(phi)
        return (1.0 - w) * from_size + w * from_pos, phi

    def draw_overlay(self, frame_bgr: np.ndarray, meta: Dict[str, Any]) -> np.ndarray:
        H, W = frame_bgr.shape[:2]
        level = meta.get("density_level", "green")
        color = _LEVEL_COLOR_BGR.get(level, (0, 200, 0))

        rows, cols = meta.get("section_grid", [_GRID_ROWS, _GRID_COLS])
        section_counts = meta.get("section_counts", {})
        light_max = meta.get("light_max", _DEFAULT_LIGHT_MAX)
        moderate_max = meta.get("moderate_max", _DEFAULT_MODERATE_MAX)
        # The grid is ALWAYS drawn while this mode is active.
        #
        # It used to be gated on `len(section_counts) > 1`, i.e. only once
        # people occupied two different cells. That made the whole sectional
        # view vanish in the most ordinary case — a handful of people standing
        # together, or an empty frame — and "which zone is busiest" is the
        # reason the grid exists. An operator cannot read a density map that
        # only appears once the crowd has already spread out.
        #
        # Empty cells get a faint neutral outline so the zones stay legible;
        # occupied cells are tinted by THEIR OWN density and labelled.
        cell_w, cell_h = W // cols, H // rows
        for r in range(rows):
            for c in range(cols):
                idx = r * cols + c
                cnt = section_counts.get(idx, 0)
                x1, y1 = c * cell_w, r * cell_h
                x2 = W if c == cols - 1 else (c + 1) * cell_w
                y2 = H if r == rows - 1 else (r + 1) * cell_h
                if cnt == 0:
                    # Nothing at all for an empty cell. The separator outline
                    # that used to be drawn here made the grid read as a
                    # lattice laid over the scene rather than as heat on the
                    # regions that matter, and an empty frame became a wire
                    # mesh. The occupied cells are the information.
                    continue
                # Each zone's own density, not the whole-frame level — a packed
                # corner of an otherwise-empty frame should read red locally
                # even if the overall frame is green.
                sec_color = _LEVEL_COLOR_BGR.get(
                    _density_level(cnt, light_max, moderate_max), color
                )
                # border=False: the tinted region IS the boundary. Lines
                # between cells add no information the colour change does not
                # already carry.
                draw_tint_rect(frame_bgr, x1, y1, x2, y2, sec_color,
                               alpha=0.16, border=False)
                draw_badge(frame_bgr, str(cnt), x1 + 6, y1 + 18, fg=sec_color)

        sel = meta.get("selected_id")
        tracking = meta.get("tracking", False)
        for p in meta.get("people", []):
            x1, y1, x2, y2 = p["box"]
            if p["id"] == sel:
                continue        # drawn below, on top of the rest
            draw_ring(frame_bgr, x1, y1, x2, y2, (200, 200, 200), 1)

        # The followed person, drawn last so the crowd never hides them.
        target = next((p for p in meta.get("people", []) if p["id"] == sel), None)
        if target is not None:
            x1, y1, x2, y2 = target["box"]
            col = (255, 255, 255) if tracking else (200, 200, 200)
            draw_ring(frame_bgr, x1, y1, x2, y2, col, 3)
            draw_badge(frame_bgr, f"#{sel}  {'TRACKING' if tracking else 'SELECTED'}",
                       x1, max(16, y1 - 4), fg=col)
            if tracking:
                # Same recentring guide as human tracking.
                tx, ty = (x1 + x2) // 2, (y1 + y2) // 2
                cx, cy = W // 2, H // 2
                cv2.line(frame_bgr, (cx, cy), (tx, ty), (200, 200, 200), 1, cv2.LINE_AA)
                cv2.circle(frame_bgr, (tx, ty), 8, col, 1, cv2.LINE_AA)
                cv2.circle(frame_bgr, (cx, cy), 3, (180, 180, 180), -1, cv2.LINE_AA)

        # No top HUD bar / COUNT-PEAK-LEVEL badges on the video itself —
        # that lives in the results panel now, feed stays clean (Japesh:
        # get rid of the black bar + top-left/top-right annotations).
        return frame_bgr
