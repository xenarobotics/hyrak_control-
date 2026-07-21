"""
Target Person Tracker
=====================
Tracks a specific person identified by a reference photo.

Pipeline:
  1. User uploads reference photo → InsightFace extracts 512-dim ArcFace embedding
  2. Every frame: YOLO ByteTrack finds all persons
  3. Every N frames: InsightFace detects faces, compares embeddings (cosine similarity)
  4. When match exceeds threshold, lock that ByteTrack ID as the target
  5. Between face checks: track by ByteTrack ID (smooth, even when face not visible)
  6. Three-axis PD controller generates drone velocity commands.
     See human_tracker.py for full control design rationale.

Model: InsightFace buffalo_sc (ArcFace backbone, ~80MB, CPU/GPU)
  - buffalo_sc: lightweight, good for real-time (~30ms GPU, ~150ms CPU per frame)
  - buffalo_l: higher accuracy but heavier (~1.2GB)
  - Similarity threshold: 0.45 cosine similarity (0=unrelated, 1=identical)
"""
import logging
from typing import Any, Dict, Optional, Tuple

import cv2
import numpy as np
import torch
from ultralytics import YOLO

from app.vision.base import BaseAnalyzer
from app.vision.drawing import draw_brackets, draw_badge
from app.vision.tracker_config import make_bytetrack_cfg
from app.vision.controllers import PDController, KalmanXY, VelocitySmoother
from app.config import get_settings

logger = logging.getLogger("verocore.vision.person_tracker")

_TRACKER_CFG = make_bytetrack_cfg("verocore_pt_")

_FACE_CHECK_EVERY_N     = 5
_SIMILARITY_THRESHOLD   = 0.45
_DEFAULT_DISTANCE_RATIO = 0.25
_YAW_PRIORITY_THRESHOLD = 0.30
_HEIGHT_EMA_ALPHA       = 0.12

_PHASE_HOLD  = 90
_PHASE_SWEEP = 180


def _draw_pill(img, text, x1, y1, color_bgr, alpha: float = 0.82):
    font, scale, thick = cv2.FONT_HERSHEY_SIMPLEX, 0.42, 1
    (tw, th), baseline = cv2.getTextSize(text, font, scale, thick)
    px, py = 10, 5
    bx1 = x1
    by2 = max(th + py * 2, y1 - 2)
    bx2 = bx1 + tw + px * 2
    by1 = by2 - th - py * 2 - baseline
    H, W = img.shape[:2]
    bx1, bx2 = max(0, bx1), min(W, bx2)
    by1, by2 = max(0, by1), min(H, by2)
    overlay = img.copy()
    cv2.rectangle(overlay, (bx1, by1), (bx2, by2), color_bgr, -1)
    cv2.addWeighted(overlay, alpha, img, 1 - alpha, 0, img)
    b, g, r = color_bgr
    brightness = 0.299 * r + 0.587 * g + 0.114 * b
    txt_color = (20, 20, 20) if brightness > 140 else (240, 240, 240)
    cv2.putText(img, text, (bx1 + px, by2 - py - baseline), font, scale, txt_color, thick, cv2.LINE_AA)


def _draw_corner_status(img, text, color_bgr, alpha: float = 0.75):
    H, W = img.shape[:2]
    font, scale, thick = cv2.FONT_HERSHEY_SIMPLEX, 0.42, 1
    (tw, th), baseline = cv2.getTextSize(text, font, scale, thick)
    margin = 12
    px, py = 10, 6
    bx2 = W - margin
    by2 = H - margin
    bx1 = bx2 - tw - px * 2
    by1 = by2 - th - py * 2 - baseline
    overlay = img.copy()
    cv2.rectangle(overlay, (bx1, by1), (bx2, by2), color_bgr, -1)
    cv2.addWeighted(overlay, alpha, img, 1 - alpha, 0, img)
    b, g, r = color_bgr
    brightness = 0.299 * r + 0.587 * g + 0.114 * b
    txt_color = (20, 20, 20) if brightness > 140 else (240, 240, 240)
    cv2.putText(img, text, (bx1 + px, by2 - py - baseline), font, scale, txt_color, thick, cv2.LINE_AA)


def _make_state() -> Dict[str, Any]:
    return {
        # Face recognition
        "reference_embedding": None,
        "face_confirmed":      False,
        # Body tracking
        "target_track_id":     None,
        "last_known_center":   None,   # normalised (fx/W, fy/H)
        "frames_lost":         0,
        "frame_counter":       0,
        "last_similarity":     0.0,
        # PD controllers — no integral; see human_tracker.py for design rationale
        "yaw_pd":  PDController(kp=30.0, kd=4.0, max_output=40.0, deadband=0.05),
        "alt_pd":  PDController(kp=1.5,  kd=0.3, max_output=0.7,  deadband=0.10),
        "dist_pd": PDController(kp=3.0,  kd=0.8, max_output=0.8,  deadband=0.04),
        # Smoothing
        "kalman":     KalmanXY(),
        "smoother":   VelocitySmoother(alpha=0.28),
        "height_ema": None,
        # Drone control
        "tracking":             False,
        "last_drone_command":   None,
        "last_yaw_dir":         1.0,
        # User-configurable
        "altitude_mode":         "fixed",   # 'fixed' or 'auto'
        "altitude_nudge_v":      0.0,       # m/s NED (−=up, +=down), hold-button control
        "target_distance_ratio": _DEFAULT_DISTANCE_RATIO,
    }


class PersonTracker(BaseAnalyzer):
    """
    Tracks one specific person using face recognition + body tracking.
    No reference photo → shows all persons (no tracking).
    """

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

        import insightface
        providers = (
            ["CUDAExecutionProvider", "CPUExecutionProvider"]
            if torch.cuda.is_available()
            else ["CPUExecutionProvider"]
        )
        self.face_app = insightface.app.FaceAnalysis(name="buffalo_sc", providers=providers)
        ctx_id = 0 if torch.cuda.is_available() else -1
        self.face_app.prepare(ctx_id=ctx_id, det_size=(640, 640))

        self._client_state: Dict[str, Dict[str, Any]] = {}
        logger.info(f"✅ PersonTracker ready on {self.device.upper()} (InsightFace buffalo_sc)")

    # ── Client lifecycle ──────────────────────────────────────────────────────

    def register_client(self, client_id: str):
        super().register_client(client_id)
        self._client_state[client_id] = _make_state()

    async def unregister_client(self, client_id: str):
        await super().unregister_client(client_id)
        self._client_state.pop(client_id, None)

    # ── Reference photo ───────────────────────────────────────────────────────

    def extract_reference_embedding(
        self, img_bgr: np.ndarray
    ) -> Tuple[Optional[np.ndarray], Optional[np.ndarray]]:
        faces = self.face_app.get(img_bgr)
        if not faces:
            return None, None
        face = max(
            faces,
            key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]),
        )
        emb = face.embedding.copy()
        norm = np.linalg.norm(emb)
        if norm > 0:
            emb = emb / norm
        x1, y1, x2, y2 = [int(v) for v in face.bbox]
        pad = max(10, int((x2 - x1) * 0.25))
        H, W = img_bgr.shape[:2]
        face_crop = img_bgr[max(0, y1 - pad):min(H, y2 + pad),
                            max(0, x1 - pad):min(W, x2 + pad)]
        return emb, face_crop

    def set_reference_embedding(self, client_id: str, embedding: np.ndarray):
        if client_id not in self._client_state:
            return
        state = self._client_state[client_id]
        state["reference_embedding"] = embedding
        state["face_confirmed"]      = True
        state["target_track_id"]     = None
        state["frames_lost"]         = 0
        state["last_known_center"]   = None
        state["last_similarity"]     = 0.0
        state["frame_counter"]       = 0
        state["height_ema"]          = None
        state["kalman"].reset()
        logger.info(f"Session {client_id[:8]}: reference embedding stored")

    def clear_reference(self, client_id: str):
        if client_id not in self._client_state:
            return
        state = self._client_state[client_id]
        state["reference_embedding"] = None
        state["face_confirmed"]      = False
        state["target_track_id"]     = None
        state["last_known_center"]   = None
        state["frames_lost"]         = 0
        state["last_similarity"]     = 0.0
        state["frame_counter"]       = 0
        state["tracking"]            = False
        state["last_drone_command"]  = None
        state["height_ema"]          = None
        state["kalman"].reset()
        state["smoother"].reset()
        state["yaw_pd"].reset()
        state["alt_pd"].reset()
        state["dist_pd"].reset()
        logger.info(f"Session {client_id[:8]}: reference cleared")

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
        pd.max_output = min(max_output, 40.0)
        pd.deadband = deadband

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
        self._client_state[client_id]["height_ema"] = None
        logger.info(f"Session {client_id[:8]}: distance ratio → {ratio:.2f}")

    def set_altitude_nudge(self, client_id: str, velocity: float):
        """Set manual altitude velocity for Fixed mode.
        -ve = ascend, +ve = descend (NED). 0 = stop. Cleared on tracking stop."""
        if client_id not in self._client_state:
            return
        v = float(np.clip(velocity, -1.0, 1.0))
        self._client_state[client_id]["altitude_nudge_v"] = v

    # ── Frame analysis ────────────────────────────────────────────────────────

    @torch.inference_mode()
    def _analyze_frame_blocking(
        self, frame_bgr: np.ndarray
    ) -> Tuple[np.ndarray, Dict[str, Any]]:
        H, W = frame_bgr.shape[:2]

        results = self.model.track(
            frame_bgr, classes=[0],
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
                x1, y1, x2, y2 = map(int, box[:4])
                if (x2 - x1) * (y2 - y1) < min_area:
                    continue
                persons.append({
                    "id":           int(track_id),
                    "box":          [x1, y1, x2, y2],
                    "area":         (x2 - x1) * (y2 - y1),
                    "conf":         round(float(conf), 2),
                    "cx_n":         (x1 + x2) / (2 * W),
                    "cy_n":         (y1 + y2) / (2 * H),
                    "height_ratio": (y2 - y1) / H,
                })
        persons.sort(key=lambda p: p["area"], reverse=True)

        drone_command  = None
        target_id      = None
        tracking       = False
        searching      = False
        face_confirmed = False
        similarity     = 0.0
        state          = {}

        for client_id, state in self._client_state.items():
            tracking       = state.get("tracking", False)
            face_confirmed = state.get("face_confirmed", False)
            ref_emb        = state.get("reference_embedding")
            target_id      = state.get("target_track_id")
            yaw_pd         = state["yaw_pd"]
            alt_pd         = state["alt_pd"]
            dist_pd        = state["dist_pd"]
            kalman         = state["kalman"]
            smoother       = state["smoother"]
            dist_target    = state.get("target_distance_ratio", _DEFAULT_DISTANCE_RATIO)

            state["frame_counter"] = state.get("frame_counter", 0) + 1

            # ── Face recognition check (every N frames) ───────────────────
            if ref_emb is not None and (state["frame_counter"] % _FACE_CHECK_EVERY_N == 0):
                faces = self.face_app.get(frame_bgr)
                best_sim    = 0.0
                best_person = None

                for face in faces:
                    fe = face.embedding.copy()
                    fn = np.linalg.norm(fe)
                    if fn > 0:
                        fe = fe / fn
                    sim = float(np.dot(ref_emb, fe))
                    if sim > best_sim:
                        best_sim = sim
                        fcx = (face.bbox[0] + face.bbox[2]) / 2
                        fcy = (face.bbox[1] + face.bbox[3]) / 2
                        for p in persons:
                            x1, y1, x2, y2 = p["box"]
                            if x1 <= fcx <= x2 and y1 <= fcy <= y2:
                                best_person = p
                                break

                if best_sim >= _SIMILARITY_THRESHOLD and best_person is not None:
                    if target_id != best_person["id"]:
                        logger.info(
                            f"Session {client_id[:8]}: face matched "
                            f"#{best_person['id']} (sim={best_sim:.3f})"
                        )
                        kalman.reset()
                        state["height_ema"] = None
                    state["target_track_id"]  = best_person["id"]
                    state["frames_lost"]       = 0
                    state["last_known_center"] = (best_person["cx_n"], best_person["cy_n"])
                    state["last_similarity"]   = round(best_sim, 3)
                    target_id = best_person["id"]
                    similarity = best_sim
                elif best_sim < _SIMILARITY_THRESHOLD * 0.7 and state["frames_lost"] > 60:
                    state["target_track_id"] = None
                    target_id = None

            # ── Body tracking by ByteTrack ID ─────────────────────────────
            target = next((p for p in persons if p["id"] == target_id), None)

            # ── Spatial reacquisition with face verification ───────────────
            if target is None and target_id is not None and persons:
                frames_lost = state.get("frames_lost", 0)
                last_center = state.get("last_known_center")
                if frames_lost > 90 and last_center:
                    lx, ly = last_center
                    closest = min(
                        persons,
                        key=lambda p: (p["cx_n"] - lx) ** 2 + (p["cy_n"] - ly) ** 2,
                    )
                    dist_n = ((closest["cx_n"] - lx) ** 2 + (closest["cy_n"] - ly) ** 2) ** 0.5
                    if dist_n < 0.35:
                        accepted = False
                        if ref_emb is not None:
                            faces = self.face_app.get(frame_bgr)
                            x1, y1, x2, y2 = closest["box"]
                            for face in faces:
                                fcx = (face.bbox[0] + face.bbox[2]) / 2
                                fcy = (face.bbox[1] + face.bbox[3]) / 2
                                if x1 <= fcx <= x2 and y1 <= fcy <= y2:
                                    fe = face.embedding.copy()
                                    fn = np.linalg.norm(fe)
                                    if fn > 0:
                                        fe = fe / fn
                                    if float(np.dot(ref_emb, fe)) >= _SIMILARITY_THRESHOLD:
                                        accepted = True
                                        break
                            if not faces:
                                accepted = True  # face turned away; trust spatial proximity
                        else:
                            accepted = True

                        if accepted:
                            state["target_track_id"] = closest["id"]
                            target_id = closest["id"]
                            target    = closest
                            state["frames_lost"] = 0
                            state["height_ema"]  = None
                            kalman.reset()
                            logger.info(f"Session {client_id[:8]}: spatially reacquired #{closest['id']}")

            if target is not None:
                state["frames_lost"] = 0

                # Kalman in normalised space
                fx_n, fy_n = kalman.update(target["cx_n"], target["cy_n"])
                state["last_known_center"] = (fx_n, fy_n)

                # Bbox height EMA — smooths YOLO size fluctuations before distance PD
                prev_h = state["height_ema"]
                h_raw  = target["height_ratio"]
                h_ema  = h_raw if prev_h is None else (
                    _HEIGHT_EMA_ALPHA * h_raw + (1 - _HEIGHT_EMA_ALPHA) * prev_h
                )
                state["height_ema"] = h_ema

                if tracking:
                    err_yaw  = fx_n - 0.5
                    err_alt  = fy_n - 0.5
                    err_dist = dist_target - h_ema

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

                    yaw_factor = max(0.0, 1.0 - abs(err_yaw) / _YAW_PRIORITY_THRESHOLD)
                    if yaw_factor > 0.0:
                        forward_m_s = dist_pd.compute(err_dist) * yaw_factor
                    else:
                        dist_pd.reset()
                        forward_m_s = 0.0

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
                state["frames_lost"] = state.get("frames_lost", 0) + 1
                fl = state["frames_lost"]
                state["height_ema"] = None

                if tracking and target_id is not None:
                    searching = True
                    if fl <= _PHASE_HOLD:
                        drone_command = state.get("last_drone_command")
                    elif fl <= _PHASE_SWEEP:
                        drone_command = {
                            "type":        "velocity",
                            "forward_m_s": 0.0,
                            "right_m_s":   0.0,
                            "down_m_s":    0.0,
                            "yaw_deg_s":   round(12.0 * state.get("last_yaw_dir", 1.0), 1),
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
            "persons":        [{"id": p["id"], "box": p["box"], "conf": p["conf"]} for p in persons],
            "person_count":   len(persons),
            "target_id":      target_id,
            "tracking":       tracking,
            "searching":      searching,
            "face_confirmed": face_confirmed,
            "frames_lost":    state.get("frames_lost", 0),
            "similarity":     round(similarity, 3),
            "drone_command":  drone_command,
        }
        return frame_bgr, meta

    # Drawing happens per CAMERA frame in stream_track (not per inference)
    # so the video stays as smooth as the fly tab; annotations lag by at
    # most one inference.
    def draw_overlay(self, frame_bgr: np.ndarray, meta: Dict[str, Any]) -> np.ndarray:
        H, W = frame_bgr.shape[:2]
        _C_ACTIVE = (200, 220, 50)
        _C_LOCKED = (30, 190, 255)
        _C_DIM    = (55, 55, 55)
        _C_SCAN   = (200, 130, 60)

        persons        = meta.get("persons", [])
        target_id      = meta.get("target_id")
        tracking       = meta.get("tracking", False)
        searching      = meta.get("searching", False)
        face_confirmed = meta.get("face_confirmed", False)

        if face_confirmed:
            for p in persons:
                if p["id"] == target_id:
                    continue
                x1, y1, x2, y2 = p["box"]
                draw_brackets(frame_bgr, x1, y1, x2, y2, _C_DIM, thickness=1)

        target_p = next((p for p in persons if p["id"] == target_id), None)
        if target_p is not None:
            x1, y1, x2, y2 = target_p["box"]
            tx, ty = (x1 + x2) // 2, (y1 + y2) // 2
            px_cx = W // 2
            px_cy = H // 2

            if tracking:
                draw_brackets(frame_bgr, x1, y1, x2, y2, _C_ACTIVE, thickness=3)
                for px_, py_ in [(x1, y1), (x2, y1), (x1, y2), (x2, y2)]:
                    cv2.circle(frame_bgr, (px_, py_), 4, _C_ACTIVE, -1, cv2.LINE_AA)
                cv2.line(frame_bgr, (px_cx, px_cy), (tx, ty), (*_C_ACTIVE[:2], 80), 1, cv2.LINE_AA)
                cv2.circle(frame_bgr, (px_cx, px_cy), 4, _C_ACTIVE, -1, cv2.LINE_AA)
                cv2.circle(frame_bgr, (tx, ty), 10, _C_ACTIVE, 1, cv2.LINE_AA)
                cv2.line(frame_bgr, (tx - 15, ty), (tx + 15, ty), _C_ACTIVE, 1, cv2.LINE_AA)
                cv2.line(frame_bgr, (tx, ty - 15), (tx, ty + 15), _C_ACTIVE, 1, cv2.LINE_AA)
                _draw_pill(frame_bgr, "  FOLLOWING  ", x1, y1, _C_ACTIVE)
            else:
                draw_brackets(frame_bgr, x1, y1, x2, y2, _C_LOCKED, thickness=2)
                cv2.circle(frame_bgr, (tx, ty), 6, _C_LOCKED, 1, cv2.LINE_AA)
                cv2.line(frame_bgr, (tx - 10, ty), (tx + 10, ty), _C_LOCKED, 1, cv2.LINE_AA)
                cv2.line(frame_bgr, (tx, ty - 10), (tx, ty + 10), _C_LOCKED, 1, cv2.LINE_AA)
                _draw_pill(frame_bgr, "  PERSON FOUND  ", x1, y1, _C_LOCKED)

        if searching:
            fl = meta.get("frames_lost", 0)
            if fl > _PHASE_SWEEP:
                _draw_corner_status(frame_bgr, "  Hovering...  ", _C_SCAN)
            elif fl > _PHASE_HOLD:
                _draw_corner_status(frame_bgr, "  Sweeping...  ", _C_SCAN)
            else:
                _draw_corner_status(frame_bgr, "  Searching...  ", _C_SCAN)
        elif face_confirmed and target_p is None:
            _draw_corner_status(frame_bgr, "  Looking for person...  ", _C_SCAN)

        return frame_bgr
