import logging
import time
from typing import Any, Dict, Tuple

import cv2
import numpy as np
import torch
from ultralytics import YOLO

from app.vision.base import BaseAnalyzer
from app.vision.drawing import draw_brackets, draw_badge
from app.vision.tracker_config import make_bytetrack_cfg
from app.vision.controllers import (
    PDController, KalmanXY, VelocitySmoother, range_error_ratio,
)
from app.vision.geometry import (
    camera_from_settings, deforeshorten_size, pose_from_telemetry,
)
from app.vision.pursuit import (
    PursuitLimits, decide_elevation, is_outpaced, limit_descent,
    lock_state_for,
)
from app.config import get_settings

logger = logging.getLogger("verocore.vision.human_tracker")

_TRACKER_CFG = make_bytetrack_cfg("verocore_bt_")

# ── Control design notes ─────────────────────────────────────────────────────
#
# Three independent axes on a mono-camera non-gimbal drone:
#
#   YAW   : keep person horizontally centred (err_x → yaw_deg_s)
#            Primary axis. Fast response. Person exits frame if this lags.
#
#   ALTITUDE: keep person vertically centred (err_y → down_m_s)
#            Secondary axis. Slow + large deadband so it doesn't fight distance.
#
#   DISTANCE: maintain visual size via bbox height ratio (→ forward_m_s)
#            Tertiary axis. Slowest + widest deadband.
#            Suppressed while yaw error is large (drone is still turning to find person).
#
# Key constraint: DO NOT use integral on distance or altitude axes.
# Integral windup causes the drone to keep moving in one direction long after
# the error has resolved (especially during manoeuvres where error accumulates
# fast then suddenly reverses).
#
# The bbox height ratio is smoothed with a separate EMA (α=0.12) before it
# hits the PD controller. YOLO bbox sizes fluctuate ±3–5% per frame naturally;
# without input smoothing the derivative term amplifies this noise.
# ─────────────────────────────────────────────────────────────────────────────

# Person fills ~25% of frame height at the default follow distance.
# Wide-angle cameras (90° FoV): 0.20 ≈ 6 m, 0.30 ≈ 4 m, 0.40 ≈ 2.5 m.
# Narrower cameras need a smaller value. Adjustable via set_tracking_params().
_DEFAULT_DISTANCE_RATIO = 0.25

# Yaw-priority blend: forward motion is scaled by how centred the person is.
# At err_yaw=0 → full forward; at err_yaw≥threshold → zero forward.
# Using a soft blend (not a hard cutoff) so forward doesn't suddenly disappear.
# 0.30 means only completely blocked when person is 30%+ off horizontal centre.
_YAW_PRIORITY_THRESHOLD = 0.30
# Forward authority never drops below this fraction, however far off
# boresight the subject sits. A hard zero stalls the chase exactly when
# it matters, and the gap that opens then makes the yaw error worse.
_YAW_PRIORITY_FLOOR = 0.35
# Standing adult, the ruler position-based ranging needs.
_SUBJECT_HEIGHT_M = 1.7

# Bbox height EMA smoothing factor — lower = smoother but slower to react.
# 0.12 gives ~8-frame time constant, which at 20fps ≈ 0.4 s lag (acceptable).
_HEIGHT_EMA_ALPHA = 0.12

# Search phase thresholds (frames lost)
# The airframe speed the distance PD is already clamped to
# (dist_pd max_output). Auto-elevate compares against this, so the
# two must stay in step.
MAX_PURSUIT_SPEED_M_S = 2.5

_PHASE_HOLD  = 90    # keep last yaw command
_PHASE_SWEEP = 180   # slow sweep in last-known direction
# > _PHASE_SWEEP → hover in place


def _make_state() -> Dict[str, Any]:
    return {
        # ── PD controllers ────────────────────────────────────────────────
        # Yaw: fast, tight deadband — keeps person in frame
        # max_output=55: PX4 stock MPC_YAWRAUTO_MAX is 60deg/s — stay under it
        # with a small margin so offboard setpoints aren't rate-limited upstream.
        "yaw_pd": PDController(kp=30.0, kd=4.0, max_output=55.0, deadband=0.05),
        # Altitude: gentle, wide deadband — avoids fighting distance axis
        "alt_pd": PDController(kp=1.5,  kd=0.3, max_output=1.0,  deadband=0.10),
        # Distance: slow deadband — bbox size is noisy but 0.04 still filters YOLO jitter.
        # max_output=2.5m/s: the old 0.8 was below normal walking pace (~1.4m/s),
        # so the drone could never close distance on a person walking away from
        # it. 2.5 covers a jogging pace with headroom under PX4's 10m/s cap.
        # Units are FRACTION OF RANGE, not fill difference — see
        # controllers.range_error_ratio for why, and for the measured
        # dead zone this replaced (1.4m at 8.6m, 46m at 50m).
        "dist_pd": PDController(kp=4.0, kd=1.0, max_output=2.5, deadband=0.08),
        # ── Smoothing ─────────────────────────────────────────────────────
        "kalman":     KalmanXY(),
        "smoother":   VelocitySmoother(alpha=0.4),
        "height_ema": None,
        # ── Tracking state ────────────────────────────────────────────────
        "selected_id":        None,
        "tracking":           False,
        "last_drone_command": None,
        "last_known_center":  None,   # normalised (fx/W, fy/H)
        "frames_lost":        0,
        # Monotonic time the target was last actually SEEN — the
        # reacquisition ladder is keyed on seconds, not frames.
        "last_seen_t":        0.0,
        "last_yaw_dir":       1.0,
        # ── User-configurable ─────────────────────────────────────────────
        # 'fixed' = hold takeoff altitude; altitude_nudge_v applied instead
        # 'auto'  = altitude PD keeps person vertically centred
        "altitude_mode":         "fixed",
        "altitude_nudge_v":      0.0,   # m/s in NED (−=up, +=down), set by hold buttons
        "target_distance_ratio": _DEFAULT_DISTANCE_RATIO,
    }


class HumanTracker(BaseAnalyzer):
    MODE = "human-tracking"

    def __init__(self, **kwargs):
        super().__init__(executor_workers=2, **kwargs)
        settings = get_settings()
        self.device = settings.device
        self.model = YOLO(settings.default_yolo_model)
        self.model.to(self.device)
        self.half = self.device == "cuda"
        # Warm-up so CUDA kernel init doesn't stall the first live frames
        self.model(
            np.zeros((360, 640, 3), dtype=np.uint8),
            device=self.device, half=self.half, verbose=False,
        )
        self._client_state: Dict[str, Dict[str, Any]] = {}
        logger.info(f"✅ HumanTracker ready on {self.device.upper()}")

    def register_client(self, client_id: str):
        super().register_client(client_id)
        self._client_state[client_id] = _make_state()

    async def unregister_client(self, client_id: str):
        await super().unregister_client(client_id)
        self._client_state.pop(client_id, None)

    def set_selected_person(self, client_id: str, person_id: int):
        if client_id not in self._client_state:
            return
        state = self._client_state[client_id]
        state["selected_id"]       = person_id
        state["frames_lost"]       = 0
        state["last_known_center"] = None
        state["height_ema"]        = None
        state["kalman"].reset()
        logger.info(f"Session {client_id[:8]}: selected person #{person_id}")

    def set_tracking(self, client_id: str, active: bool):
        if client_id not in self._client_state:
            return
        state = self._client_state[client_id]
        state["tracking"] = active
        if not active:
            state["yaw_pd"].reset()
            state["alt_pd"].reset()
            state["dist_pd"].reset()
            state["smoother"].reset()
            state["height_ema"]         = None
            state["last_drone_command"] = None
            state["frames_lost"]        = 0
            state["altitude_nudge_v"]   = 0.0
        logger.info(f"Session {client_id[:8]}: tracking {'STARTED' if active else 'STOPPED'}")

    def set_pd_params(self, client_id: str, kp: float, kd: float,
                      max_output: float, deadband: float):
        """Backward-compatible hook: updates yaw PD gains only."""
        if client_id not in self._client_state:
            return
        pd = self._client_state[client_id]["yaw_pd"]
        pd.kp = kp
        pd.kd = kd
        pd.max_output = min(max_output, 55.0)
        pd.deadband = deadband
        logger.info(f"Session {client_id[:8]}: yaw PD kp={kp} kd={kd}")

    def set_altitude_mode(self, client_id: str, mode: str):
        """'fixed' = hold current altitude (down_m_s=0). 'auto' = altitude PD active."""
        if client_id not in self._client_state or mode not in ("fixed", "auto"):
            return
        state = self._client_state[client_id]
        state["altitude_mode"] = mode
        if mode == "fixed":
            state["alt_pd"].reset()
        logger.info(f"Session {client_id[:8]}: altitude mode → {mode}")

    def set_tracking_params(self, client_id: str, target_distance_ratio: float):
        """Adjust target follow distance.
        0.15 → far (~8–10 m), 0.25 → default (~5–6 m), 0.40 → close (~2–3 m)."""
        if client_id not in self._client_state:
            return
        ratio = float(np.clip(target_distance_ratio, 0.10, 0.60))
        self._client_state[client_id]["target_distance_ratio"] = ratio
        self._client_state[client_id]["height_ema"] = None  # reset so new target applies immediately
        logger.info(f"Session {client_id[:8]}: distance ratio → {ratio:.2f}")

    def set_altitude_nudge(self, client_id: str, velocity: float):
        """Set a manual altitude velocity for Fixed mode.
        -ve = ascend, +ve = descend (NED convention). 0 = stop.
        Sent while the user holds the ▲/▼ button; cleared on release."""
        if client_id not in self._client_state:
            return
        v = float(np.clip(velocity, -1.0, 1.0))
        self._client_state[client_id]["altitude_nudge_v"] = v

    @torch.inference_mode()
    def _analyze_frame_blocking(
        self, frame_bgr: np.ndarray
    ) -> Tuple[np.ndarray, Dict[str, Any]]:
        H, W = frame_bgr.shape[:2]
        cx_n, cy_n = 0.5, 0.5   # normalised frame centre

        # Pre-resizing with cv2 skips the Python-side cost of letterboxing at
        # 1080p every frame. imgsz must be passed alongside it — see the note
        # in crowd_manager: without it ultralytics rescales back to 640 and
        # any width above 640 buys nothing.
        frame_proc, sx, sy = self.resize_for_inference(frame_bgr)

        results = self.model.track(
            frame_proc, classes=[0], imgsz=self.imgsz_for(frame_proc),
            device=self.device, half=self.half, verbose=False, conf=0.5,
            persist=True, tracker=_TRACKER_CFG,
        )

        persons = []
        if results and results[0].boxes is not None and len(results[0].boxes):
            boxes     = results[0].boxes
            xyxy      = boxes.xyxy.cpu().numpy()
            confs     = boxes.conf.cpu().numpy()
            track_ids = (
                boxes.id.int().cpu().numpy()
                if boxes.id is not None else range(len(xyxy))
            )
            min_area = 0.002 * W * H
            for track_id, box, conf in zip(track_ids, xyxy, confs):
                # Scale box coordinates back to the original frame resolution
                x1, y1 = int(box[0] * sx), int(box[1] * sy)
                x2, y2 = int(box[2] * sx), int(box[3] * sy)
                if (x2 - x1) * (y2 - y1) < min_area:
                    continue
                persons.append({
                    "id":           int(track_id),
                    "box":          [x1, y1, x2, y2],
                    "area":         (x2 - x1) * (y2 - y1),
                    "conf":         round(float(conf), 2),
                    # Normalised to [0, 1] — consistent with Kalman noise tuning
                    "cx_n":         (x1 + x2) / (2 * W),
                    "cy_n":         (y1 + y2) / (2 * H),
                    "height_ratio": (y2 - y1) / H,
                })
        persons.sort(key=lambda p: p["area"], reverse=True)

        drone_command = None
        selected_id   = None
        tracking      = False
        searching     = False
        state         = {}

        for client_id, state in self._client_state.items():
            selected_id  = state.get("selected_id")
            tracking     = state.get("tracking", False)
            yaw_pd       = state["yaw_pd"]
            alt_pd       = state["alt_pd"]
            dist_pd      = state["dist_pd"]
            kalman       = state["kalman"]
            smoother     = state["smoother"]
            dist_target  = state.get("target_distance_ratio", _DEFAULT_DISTANCE_RATIO)

            # ── 1. Find target by ByteTrack ID ────────────────────────────
            target = next((p for p in persons if p["id"] == selected_id), None)

            # ── 2. Spatial reacquisition after ByteTrack ID expires ───────
            if target is None and selected_id is not None and persons:
                frames_lost = state["frames_lost"]
                last_center = state["last_known_center"]
                if frames_lost > 90 and last_center:
                    lx, ly = last_center
                    closest = min(
                        persons,
                        key=lambda p: (p["cx_n"] - lx) ** 2 + (p["cy_n"] - ly) ** 2,
                    )
                    dist_n = ((closest["cx_n"] - lx) ** 2 + (closest["cy_n"] - ly) ** 2) ** 0.5
                    if dist_n < 0.40:   # within 40% of frame diagonal (normalised)
                        state["selected_id"] = closest["id"]
                        selected_id          = closest["id"]
                        target               = closest
                        state["frames_lost"] = 0
                        state["height_ema"]  = None
                        kalman.reset()
                        logger.info(f"Session {client_id[:8]}: reacquired #{closest['id']}")

            if target is not None:
                state["frames_lost"] = 0
                state["last_seen_t"] = time.monotonic()

                # ── Kalman filter in normalised space ─────────────────────
                # Passing [0,1] coords keeps noise parameters meaningful across
                # different camera resolutions.
                fx_n, fy_n = kalman.update(target["cx_n"], target["cy_n"])
                state["last_known_center"] = (fx_n, fy_n)

                # ── Bbox height EMA ───────────────────────────────────────
                # YOLO bbox heights fluctuate ±3–5% between frames. Smoothing
                # the input prevents the derivative term from amplifying noise.
                prev_h = state["height_ema"]
                h_raw  = target["height_ratio"]
                h_ema  = h_raw if prev_h is None else (
                    _HEIGHT_EMA_ALPHA * h_raw + (1 - _HEIGHT_EMA_ALPHA) * prev_h
                )
                state["height_ema"] = h_ema

                if tracking:
                    # Pose read once, up front: the foreshortening correction
                    # below and the altitude floor further down both need it,
                    # not just the elevate decision.
                    ctx = self.frame_context(client_id)
                    pose = pose_from_telemetry(ctx.telemetry) if ctx else None
                    agl_for_floor = pose.agl_m if pose else None

                    # ── Undo viewing-angle foreshortening ─────────────────
                    # A standing person is a VERTICAL extent, so its projection
                    # shrinks by cos(depression). Apparent size then goes as
                    # sin(2*phi) and PEAKS at 45deg — meaning past that point a
                    # subject moving closer looks SMALLER, the controller reads
                    # "moving away" and drives forward, bringing them closer
                    # still. A feedback loop aimed at the subject. Measured at
                    # 6m AGL: 18.0% fill at 6m out, 14.4% at 3m, 5.8% at 1m.
                    h_eff, _phi = self._range_observable(
                        h_ema, pose, ctx, fx_n, fy_n, W, H, _SUBJECT_HEIGHT_M
                    )
                    # ── Error signals (all in normalised [-0.5, 0.5] range) ──
                    err_yaw  = fx_n - cx_n               # horizontal centering
                    err_alt  = fy_n - cy_n               # vertical centering
                    # Fraction-of-range, not raw fill difference: the old
                    # form let the subject move 1.4m at close range and
                    # 46m at 50m before reacting. See range_error_ratio.
                    err_dist = range_error_ratio(dist_target, h_eff)

                    yaw_deg_s = yaw_pd.compute(err_yaw)

                    if yaw_deg_s > 0.5:
                        state["last_yaw_dir"] = 1.0
                    elif yaw_deg_s < -0.5:
                        state["last_yaw_dir"] = -1.0

                    down_m_s = (
                        alt_pd.compute(err_alt)
                        if state.get("altitude_mode") == "auto"
                        else state.get("altitude_nudge_v", 0.0)
                    )

                    # Soft yaw-priority blend: scale forward speed by how centred the person is.
                    # Full speed when centred; zero only when severely off-axis (≥ threshold).
                    # This prevents complete forward-motion lockout during normal yaw corrections.
                    # Floor, not a hard gate: zeroing forward whenever the
                    # subject drifts off-axis stalls the chase exactly when
                    # it matters, and the growing gap then makes the yaw
                    # error worse. Both axes correct together.
                    yaw_factor = max(_YAW_PRIORITY_FLOOR,
                                     1.0 - abs(err_yaw) / _YAW_PRIORITY_THRESHOLD)
                    forward_m_s = dist_pd.compute(err_dist) * yaw_factor

                    # ── Auto-elevate: the chase fallback ──────────────────
                    # Only when the target is genuinely pulling away, and only
                    # inside both ceilings. Overrides the altitude axis because
                    # holding the subject in frame at all outranks holding them
                    # vertically centred — a perfectly framed empty sky is
                    # worse than an off-centre target.
                    elevate = None
                    if forward_m_s > 0:
                        agl = agl_for_floor
                        depression = None
                        if pose is not None and ctx is not None:
                            cam = camera_from_settings(ctx.width or W, ctx.height or H)
                            depression = pose.depression_deg(cam, W / 2.0, H / 2.0)
                        # Growing distance = the subject is shrinking in frame,
                        # which is exactly what err_dist > 0 means.
                        limits = PursuitLimits.from_settings()
                        elevate = decide_elevation(
                            target_outpacing=is_outpaced(
                                forward_m_s, MAX_PURSUIT_SPEED_M_S, limits,
                                target_growing_distance=err_dist > 0.01,
                            ),
                            agl_m=agl,
                            depression_deg=depression,
                            limits=limits,
                        )
                        if elevate.elevating:
                            down_m_s = elevate.climb_m_s
                        state["elevate"] = elevate.to_dict()
                    if elevate is None:
                        state["elevate"] = None

                    # THE ALTITUDE FLOOR — see pursuit.limit_descent. Applied
                    # here, at the single point every descent source converges
                    # on, rather than at each of them.
                    down_m_s, floor_reason = limit_descent(
                        down_m_s, agl_for_floor, PursuitLimits.from_settings()
                    )
                    state["altitude_floor_reason"] = floor_reason

                    raw = {
                        "type":        "velocity",
                        "forward_m_s": forward_m_s,
                        "right_m_s":   0.0,
                        "down_m_s":    down_m_s,
                        "yaw_deg_s":   yaw_deg_s,
                    }
                    cmd = smoother.smooth(raw)
                    drone_command = {
                        "type":        "velocity",
                        "forward_m_s": round(cmd["forward_m_s"], 3),
                        "right_m_s":   0.0,
                        "down_m_s":    round(cmd["down_m_s"], 3),
                        "yaw_deg_s":   round(cmd["yaw_deg_s"], 3),
                    }
                    state["last_drone_command"] = drone_command

            else:
                state["frames_lost"] += 1
                fl = state["frames_lost"]
                state["height_ema"] = None   # reset EMA — distance context is stale

                if tracking:
                    searching = True
                    if fl <= _PHASE_HOLD:
                        drone_command = state["last_drone_command"]
                    elif fl <= _PHASE_SWEEP:
                        drone_command = {
                            "type":        "velocity",
                            "forward_m_s": 0.0,
                            "right_m_s":   0.0,
                            "down_m_s":    0.0,
                            "yaw_deg_s":   round(12.0 * state["last_yaw_dir"], 1),
                        }
                    else:
                        drone_command = {
                            "type":        "velocity",
                            "forward_m_s": 0.0,
                            "right_m_s":   0.0,
                            "down_m_s":    0.0,
                            "yaw_deg_s":   0.0,
                        }

            break  # single session per analyzer instance

        meta: Dict[str, Any] = {
            "persons":       [{"id": p["id"], "box": p["box"], "conf": p["conf"]} for p in persons],
            "person_count":  len(persons),
            "selected_id":   selected_id,
            "tracking":      tracking,
            "searching":     searching,
            "frames_lost":   state.get("frames_lost", 0),
            "drone_command": drone_command,
        }
        seen_t = state.get("last_seen_t", 0.0)
        lost_s = (time.monotonic() - seen_t) if seen_t else 0.0
        lock, lock_msg = lock_state_for(
            visible=(selected_id is not None
                 and state.get("frames_lost", 0) == 0),
            seconds_lost=lost_s, tracking=tracking
        )
        meta["lock_state"] = lock.value
        meta["lock_message"] = lock_msg
        meta["seconds_lost"] = round(lost_s, 1)
        meta["elevate"] = state.get("elevate")
        return frame_bgr, meta

    # Drawing happens per CAMERA frame in stream_track (not per inference)
    # so the video stays as smooth as the fly tab; annotations lag by at
    # most one inference.
    def _range_observable(self, h_ema, pose, ctx, fx_n, fy_n, W, H, subject_h_m):
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
            blend_weight_for_position, camera_from_settings, size_ratio_from_ground_range,
        )
        if pose is None or ctx is None:
            return h_ema, None

        cam = camera_from_settings(ctx.width or W, ctx.height or H)
        px, py = fx_n * W, fy_n * H
        phi = pose.depression_deg(cam, px, py)
        if phi is None:
            return h_ema, None

        ref = _cal.effective()["camera_mount_tilt_deg"]
        from_size = deforeshorten_size(h_ema, phi, ref)

        # Feet, not centre: the ground plane is what position ranging
        # intersects, and a box centre floats at half the subject's height.
        projected = pose.project_to_ground(cam, px, py)
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
        persons     = meta.get("persons", [])
        selected_id = meta.get("selected_id")
        tracking    = meta.get("tracking", False)

        for p in persons:
            if p["id"] == selected_id:
                continue
            x1, y1, x2, y2 = p["box"]
            draw_brackets(frame_bgr, x1, y1, x2, y2, (90, 90, 90), thickness=1)

        target_vis = next((p for p in persons if p["id"] == selected_id), None)
        if target_vis is not None:
            x1, y1, x2, y2 = target_vis["box"]
            tx, ty = (x1 + x2) // 2, (y1 + y2) // 2
            px_cx, px_cy = W // 2, H // 2

            if tracking:
                draw_brackets(frame_bgr, x1, y1, x2, y2, (255, 255, 255), thickness=2)
                cv2.line(frame_bgr, (px_cx, px_cy), (tx, ty), (200, 200, 200), 1, cv2.LINE_AA)
                cv2.circle(frame_bgr, (tx, ty), 8, (255, 255, 255), 1, cv2.LINE_AA)
                cv2.line(frame_bgr, (tx - 12, ty), (tx + 12, ty), (255, 255, 255), 1, cv2.LINE_AA)
                cv2.line(frame_bgr, (tx, ty - 12), (tx, ty + 12), (255, 255, 255), 1, cv2.LINE_AA)
                cv2.circle(frame_bgr, (px_cx, px_cy), 3, (180, 180, 180), -1, cv2.LINE_AA)
                draw_badge(frame_bgr, f"#{selected_id}  TRACKING", x1, max(16, y1 - 4))
            else:
                draw_brackets(frame_bgr, x1, y1, x2, y2, (200, 200, 200), thickness=1)
                draw_badge(
                    frame_bgr, f"#{selected_id}  SELECTED", x1, max(16, y1 - 4),
                    fg=(200, 200, 200),
                )

        if meta.get("searching"):
            fl = meta.get("frames_lost", 0)
            if fl > _PHASE_SWEEP:
                label = f"HOVERING  #{selected_id}"
            elif fl > _PHASE_HOLD:
                label = f"SWEEPING  #{selected_id}"
            else:
                label = f"SEARCHING  #{selected_id}"
            draw_badge(frame_bgr, label, W - 220, 28, fg=(255, 165, 0), bg=(10, 10, 10))

        return frame_bgr
