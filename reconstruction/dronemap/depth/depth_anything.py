"""Depth Anything V2 metric depth, via transformers, in FP16 on CUDA.

Chosen for this GPU deliberately: the Small (ViT-S) variant is ~25M parameters,
runs at 518x518 in well under 10 ms on an RTX 4070 Laptop, and holds a steady
~0.7 GB of VRAM. Larger monocular models and feed-forward pointmap transformers
are more accurate but would eat the VRAM budget the TSDF volume needs.

Inference runs under a lock. Two threads call this -- the tracker for the very
first frame (to bootstrap the map metrically) and the local mapper for every
keyframe after -- and CUDA plus a shared HF module is not safe to reenter.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Optional

import numpy as np

from ..types import CameraIntrinsics
from .base import DepthEstimator

log = logging.getLogger(__name__)


class DepthAnythingEstimator(DepthEstimator):
    metric = True

    def __init__(self, cfg, device: str = "cuda") -> None:
        import torch

        self.cfg = cfg
        self.dcfg = cfg.depth
        self.torch = torch
        self._lock = threading.Lock()

        if device == "cuda" and not torch.cuda.is_available():
            log.warning("CUDA unavailable; depth will run on CPU and will not keep up")
            device = "cpu"
        self.device = torch.device(device)
        self.dtype = torch.float16 if (self.dcfg.fp16 and device == "cuda") else torch.float32

        from transformers import AutoImageProcessor, AutoModelForDepthEstimation

        log.info("loading depth model %s", self.dcfg.model)
        t0 = time.perf_counter()
        self.processor = AutoImageProcessor.from_pretrained(self.dcfg.model)
        self.model = AutoModelForDepthEstimation.from_pretrained(
            self.dcfg.model, dtype=self.dtype
        ).to(self.device).eval()
        log.info("depth model ready in %.1fs (%s, %s)",
                 time.perf_counter() - t0, self.device, self.dtype)

        # "Metric" is a property of the checkpoint, not the architecture -- the
        # relative checkpoints share the same class, and fusing their output as
        # metres would be silently, badly wrong.
        name = self.dcfg.model.lower()
        self.metric = "metric" in name
        if not self.metric:
            log.warning(
                "%s is a RELATIVE depth checkpoint; depth.align_to_map must stay "
                "enabled or the reconstruction will have no meaningful scale",
                self.dcfg.model,
            )

        self._mean = np.array([0.485, 0.456, 0.406], np.float32)
        self._std = np.array([0.229, 0.224, 0.225], np.float32)

    def _preprocess(self, image: np.ndarray):
        """Resize + normalise on the GPU.

        The HF image processor does this in numpy on the CPU and costs more than
        the network forward pass at these resolutions.
        """
        import torch
        import torch.nn.functional as F

        t = torch.from_numpy(np.ascontiguousarray(image)).to(self.device)
        t = t.permute(2, 0, 1).unsqueeze(0).float() / 255.0
        size = self.dcfg.input_size
        t = F.interpolate(t, size=(size, size), mode="bicubic", align_corners=False)
        mean = torch.from_numpy(self._mean).to(self.device).view(1, 3, 1, 1)
        std = torch.from_numpy(self._std).to(self.device).view(1, 3, 1, 1)
        return ((t - mean) / std).to(self.dtype)

    def predict(self, image: np.ndarray, intrinsics: Optional[CameraIntrinsics] = None,
                frame_index: Optional[int] = None) -> np.ndarray:
        import torch
        import torch.nn.functional as F

        h, w = image.shape[:2]
        with self._lock, torch.inference_mode():
            x = self._preprocess(image)
            out = self.model(pixel_values=x)
            pred = out.predicted_depth
            if pred.ndim == 3:
                pred = pred.unsqueeze(1)
            pred = F.interpolate(pred.float(), size=(h, w), mode="bilinear",
                                 align_corners=False)
            depth = pred[0, 0].cpu().numpy().astype(np.float32)

        if not self.metric:
            # Relative checkpoints emit inverse depth. Convert to a depth-like
            # quantity so the alignment step has the right functional form;
            # absolute values are meaningless until aligned regardless.
            d = depth
            d = d - d.min()
            denom = max(float(d.max()), 1e-6)
            inv = d / denom
            depth = 1.0 / np.maximum(inv, 1e-3)

        depth[~np.isfinite(depth)] = 0.0
        np.clip(depth, 0.0, self.dcfg.max_depth_m * 4.0, out=depth)
        return depth

    def warmup(self) -> None:
        dummy = np.zeros((self.dcfg.input_size, self.dcfg.input_size, 3), np.uint8)
        for _ in range(2):
            self.predict(dummy)
        if self.device.type == "cuda":
            self.torch.cuda.synchronize()
        log.info("depth warmup complete (%.0f MB VRAM)", self.vram_mb)

    @property
    def vram_mb(self) -> float:
        if self.device.type != "cuda":
            return 0.0
        return self.torch.cuda.memory_allocated(self.device) / (1024**2)

    def close(self) -> None:
        try:
            del self.model
            if self.device.type == "cuda":
                self.torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass
