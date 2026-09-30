"""Person ruler - metric scale for the camera path with no equipment.

A standing person is a ruler everybody carries: at distance D a person H
tall spans  h_px = f_px * H / D  pixels, so  D = f_px * H / h_px.  Comparing
that with the depth model's own reading inside the person's box gives the
model's scale error for THIS camera (lens, mounting, scene type):

    scale = D_ruler / D_model        depth_true ~= depth_model * scale

One tap in the Command window's camera menu ("Calibrate with a person")
starts a run: the person stands 3-8 m from the camera, whole body in view;
~2 s of frames are measured (YOLO person box + the depth model), each frame
gives one scale, and the run is accepted only if the samples agree (MAD
under 12 %). The result is stored per camera profile (frame size + hfov +
depth model) in .data/depth_scale.json and used by:
  - bench mode (mono_bench): the model's metres are multiplied by it;
  - flight: as the STARTING value of the ground-plane calibration, which
    still re-measures every frame (the in-flight ruler is the altitude).
The benchmark (docs/avoidance/DEPTH_MODELS.md) showed a model's scale
wanders from scene to scene, which is why flight keeps measuring and why a
new run is one tap.

Accuracy is set by the height: an adult of unknown height is 1.70 m +- 6 %;
entering the actual height removes most of that.
"""
from __future__ import annotations

import json
import logging
import math
import os
import threading
import time
from pathlib import Path

import numpy as np

from app.config import ROOT_DIR

logger = logging.getLogger("verocore.avoidance.person_ruler")

STORE = Path(str(ROOT_DIR)) / ".data" / "depth_scale.json"
SAMPLES = 10
TIMEOUT_S = 15.0
MAX_SPREAD = 0.12
SCALE_MIN, SCALE_MAX = 0.2, 5.0     # outside this the frame is wrong, not the model

_lock = threading.Lock()
_runs: dict[str, dict] = {}          # drone_id -> run state
_yolo = None


def profile_key(w: int, h: int, hfov_deg: float, model: str) -> str:
    return f"{w}x{h}|{hfov_deg:.1f}|{model.split('/')[-1]}"


def _load() -> dict:
    try:
        return json.loads(STORE.read_text())
    except Exception:
        return {}


def stored_scale(w: int, h: int, hfov_deg: float, model: str) -> float | None:
    rec = _load().get(profile_key(w, h, hfov_deg, model))
    return float(rec["scale"]) if rec and rec.get("scale") else None


def _save(key: str, rec: dict) -> None:
    data = _load()
    data[key] = rec
    STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    os.replace(tmp, STORE)


# -- run control (API) ----------------------------------------------------
def start(drone_id: str, height_m: float = 1.70) -> dict:
    if not (1.0 <= height_m <= 2.3):
        raise ValueError("person height must be 1.0-2.3 m")
    with _lock:
        _runs[drone_id] = {"state": "collecting", "height_m": float(height_m), "samples": [],
                           "started": time.monotonic(), "reason": "stand 3-8 m away, whole body in view"}
        return status(drone_id, _locked=True)


def cancel(drone_id: str) -> None:
    with _lock:
        _runs.pop(drone_id, None)


def pending(drone_id: str) -> bool:
    with _lock:
        r = _runs.get(drone_id)
        if r and r["state"] == "collecting" and time.monotonic() - r["started"] > TIMEOUT_S:
            n = len(r["samples"])
            r.update(state="failed", reason=f"only {n} good frames in {TIMEOUT_S:.0f} s - "
                                            "is one whole person in view, 3-8 m away?")
        return bool(r and r["state"] == "collecting")


def status(drone_id: str, _locked: bool = False) -> dict:
    def _s():
        r = _runs.get(drone_id)
        if not r:
            return {"state": "idle"}
        return {k: v for k, v in r.items() if k not in ("started",)} | {"samples": len(r["samples"])}
    if _locked:
        return _s()
    with _lock:
        return _s()


# -- per-frame measurement (sensing executor thread) ----------------------
def _detector():
    global _yolo
    if _yolo is None:
        from ultralytics import YOLO
        from app.config import get_settings
        _yolo = YOLO(get_settings().default_yolo_model)
    return _yolo


def measure(img_bgr: np.ndarray, depth: np.ndarray, hfov_deg: float, height_m: float) -> tuple[float | None, str]:
    """One frame -> (scale, why). Pure apart from the detector."""
    h, w = img_bgr.shape[:2]
    res = _detector()(img_bgr, classes=[0], conf=0.5, verbose=False)[0]
    boxes = [b.xyxy[0].tolist() for b in res.boxes] if res.boxes is not None else []
    return scale_from_box(boxes, depth, w, h, hfov_deg, height_m)


def scale_from_box(boxes: list, depth: np.ndarray, w: int, h: int, hfov_deg: float,
                   height_m: float) -> tuple[float | None, str]:
    if len(boxes) != 1:
        return None, "need exactly one person in view" if boxes else "no person in view"
    x0, y0, x1, y1 = boxes[0]
    margin = 0.02 * h
    if y0 <= margin or y1 >= h - margin:
        return None, "whole body must be in the frame (head and feet)"
    box_h = y1 - y0
    f_px = (w / 2.0) / math.tan(math.radians(hfov_deg) / 2.0)
    d_ruler = f_px * height_m / box_h
    if not (2.0 <= d_ruler <= 12.0):
        return None, f"person is {d_ruler:.1f} m away - stand 3-8 m from the camera"
    dh, dw = depth.shape
    # Torso region of the box, in depth-map pixels: away from the outline,
    # where depth models blur into the background.
    cx0, cx1 = x0 + 0.3 * (x1 - x0), x1 - 0.3 * (x1 - x0)
    cy0, cy1 = y0 + 0.25 * box_h, y0 + 0.6 * box_h
    r0, r1 = int(cy0 / h * dh), max(int(cy0 / h * dh) + 1, int(cy1 / h * dh))
    c0, c1 = int(cx0 / w * dw), max(int(cx0 / w * dw) + 1, int(cx1 / w * dw))
    patch = depth[r0:r1, c0:c1]
    patch = patch[np.isfinite(patch) & (patch > 0)]
    if patch.size < 4:
        return None, "person too small in the depth map"
    d_model = float(np.median(patch))
    if d_model < 0.5:
        return None, f"model reads {d_model:.2f} m for the person - not a usable frame"
    scale = d_ruler / d_model
    if not (SCALE_MIN <= scale <= SCALE_MAX):
        return None, f"scale x{scale:.1f} is not plausible (model reads {d_model:.1f} m, ruler {d_ruler:.1f} m)"
    return scale, f"{d_ruler:.1f} m by ruler, model reads {d_model:.1f} m"


def add_sample(drone_id: str, scale: float | None, why: str, key: str) -> None:
    with _lock:
        r = _runs.get(drone_id)
        if not r or r["state"] != "collecting":
            return
        r["reason"] = why
        if scale is None:
            return
        r["samples"].append(scale)
        if len(r["samples"]) < SAMPLES:
            return
        s = np.array(r["samples"])
        med = float(np.median(s))
        spread = float(np.median(np.abs(s - med)) / med)
        if spread > MAX_SPREAD:
            r["samples"] = []
            r["reason"] = f"readings disagree by {spread:.0%} - hold still, collecting again"
            return
        r.update(state="done", scale=med, spread=spread,
                 reason=f"calibrated: distances x{med:.2f} (spread {spread:.0%})")
        rec = {"scale": med, "spread": spread, "height_m": r["height_m"],
               "samples": len(s), "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    try:
        _save(key, rec)
        logger.info(f"Person-ruler calibration {key}: x{med:.3f} (spread {spread:.1%})")
    except Exception as e:
        logger.warning(f"could not store depth calibration: {e}")
