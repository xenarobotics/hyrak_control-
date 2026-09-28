"""Monocular metric depth backends - one interface, several models.

    backend = load("depth-anything/DA3METRIC-LARGE", device)
    depth_m = backend.predict(frame_bgr, hfov_deg)     # (h, w) metres

The camera's field of view is an INPUT, not an afterthought. A monocular
metric model learns distances for the lenses it was trained on; a different
lens (or a crop) scales every distance by the focal-length ratio. Two ways
of handling it:

  da3:  Depth Anything 3 metric (ByteDance, 2025). Its output is canonical -
        metres = focal_px * output / 300, focal from the camera's hfov at the
        processed resolution (DA3 README). Lens-independent by design.
  hf:   Depth Anything V2 metric via transformers (the previous default).
        Trained on one camera; with fov_correct=True the output is scaled by
        (f_actual / f_train) using TRAIN_HFOV below - a first-order fix.

Which model is better is measured, not assumed:
    simulation/depth_bench.sh              (capture, private Gazebo)
    backend/tools/depth_bench_eval.py      (score vs true depth)

DA3 is loaded from its source checkout (DA3_SRC, default ~/ext/depth-anything-3/src)
plus a small deps folder (DA3_DEPS, default ~/ext/da3-deps: einops, omegaconf,
addict) WITHOUT installing its heavy extras into this venv (xformers would
repin torch). Its export and multi-view pose-alignment modules are stubbed -
single-frame depth never touches them. If DA3 cannot load, load() raises and
the caller falls back (see DepthMapper).
"""
from __future__ import annotations

import logging
import math
import os
import sys
import types
from pathlib import Path

import cv2
import numpy as np

logger = logging.getLogger("verocore.vision.depth_models")

INFER_W, INFER_H = 640, 360
# Depth Anything V2 metric training cameras, horizontal FOV at training
# resolution (Virtual KITTI 2 for outdoor, Hypersim for indoor).
TRAIN_HFOV = {"outdoor": 81.0, "indoor": 60.0}


def focal_px(width_px: int, hfov_deg: float) -> float:
    return (width_px / 2.0) / math.tan(math.radians(hfov_deg) / 2.0)


class HFDepth:
    """Depth Anything V2 metric (transformers pipeline)."""

    def __init__(self, model_name: str, device: str, fov_correct: bool = False):
        import torch
        from PIL import Image
        from transformers import pipeline
        self.name = model_name
        self.kind = "indoor" if "indoor" in model_name.lower() else "outdoor"
        self.fov_correct = fov_correct
        dtype = torch.float16 if device == "cuda" else torch.float32
        self._pipe = pipeline("depth-estimation", model=model_name, device=device, torch_dtype=dtype)
        self._pipe(Image.new("RGB", (INFER_W, INFER_H)))          # CUDA warm-up

    def predict(self, frame_bgr: np.ndarray, hfov_deg: float | None = None) -> np.ndarray:
        import torch
        from PIL import Image
        small = cv2.resize(frame_bgr, (INFER_W, INFER_H))
        with torch.inference_mode():
            res = self._pipe(Image.fromarray(cv2.cvtColor(small, cv2.COLOR_BGR2RGB)))
        depth = res["predicted_depth"].squeeze().float().cpu().numpy()
        if self.fov_correct and hfov_deg:
            w = depth.shape[-1]
            depth = depth * (focal_px(w, hfov_deg) / focal_px(w, TRAIN_HFOV[self.kind]))
        return depth


def _import_da3():
    src = os.path.expanduser(os.environ.get("DA3_SRC", "~/ext/depth-anything-3/src"))
    deps = os.path.expanduser(os.environ.get("DA3_DEPS", "~/ext/da3-deps"))
    for p in (src, deps):
        if not Path(p).is_dir():
            raise ImportError(f"Depth Anything 3 not found at {p} (see docs/avoidance/DEPTH_MODELS.md)")
        if p not in sys.path:
            sys.path.append(p)
    for name, attrs in {"depth_anything_3.utils.export": {"export": None},
                        "depth_anything_3.utils.pose_align": {"align_poses_umeyama": None}}.items():
        if name not in sys.modules:
            m = types.ModuleType(name)
            m.__dict__.update(attrs)
            sys.modules[name] = m
    from depth_anything_3.api import DepthAnything3
    return DepthAnything3


class DA3Depth:
    """Depth Anything 3 metric (canonical output * focal / 300)."""

    def __init__(self, model_name: str, device: str, process_res: int = 504):
        DepthAnything3 = _import_da3()
        # DA3 logs every inference at INFO; keep the backend log readable.
        logging.getLogger("depth_anything_3").setLevel(logging.WARNING)
        try:
            from depth_anything_3.utils.logger import logger as _dl
            _dl.setLevel("WARN") if hasattr(_dl, "setLevel") else None
        except Exception:
            pass
        self.name = model_name
        self.process_res = process_res
        self._model = DepthAnything3.from_pretrained(model_name).to(device).eval()
        self.predict(np.zeros((INFER_H, INFER_W, 3), np.uint8), 70.0)       # warm-up

    def predict(self, frame_bgr: np.ndarray, hfov_deg: float | None = None) -> np.ndarray:
        import torch
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        with torch.inference_mode():
            pred = self._model.inference([rgb], process_res=self.process_res)
        canon = np.asarray(pred.depth[0], dtype=np.float32)
        # Sky mask (0..1), kept for the indoor/outdoor verdict.
        self.last_sky = None if getattr(pred, "sky", None) is None else np.asarray(pred.sky[0])
        h, w = canon.shape
        hf = float(hfov_deg or 70.0)
        # Processed image keeps the frame's aspect (to 14-px multiples):
        # average the x and y focal lengths as the README says.
        fx = focal_px(w, hf)
        vf = 2.0 * math.atan(math.tan(math.radians(hf) / 2.0) * frame_bgr.shape[0] / frame_bgr.shape[1])
        fy = (h / 2.0) / math.tan(vf / 2.0)
        return canon * ((fx + fy) / 2.0) / 300.0


def load(model_name: str, device: str, fov_correct: bool = False):
    """A depth backend for a model id. 'DA3' in the name -> Depth Anything 3."""
    if "da3" in model_name.lower():
        return DA3Depth(model_name, device)
    return HFDepth(model_name, device, fov_correct=fov_correct)
