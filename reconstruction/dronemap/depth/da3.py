"""Depth Anything 3 metric depth (DA3METRIC checkpoints).

DA3 (Nov 2025) supersedes the V2 checkpoints: markedly better depth accuracy
and edge quality from the same single image. It is not in `transformers` yet,
so this adapter goes through the upstream `depth_anything_3` package instead.

Cost on this GPU (RTX 4070 Laptop, measured): DA3METRIC-LARGE is 334M params,
~83 ms per keyframe at process_res=504 and ~1.7 GB of VRAM -- roughly 10x the
latency of DAv2-Small but still far below the keyframe cadence, which is what
depth actually has to keep up with. Not viable per-frame; ideal per-keyframe.

The DA3METRIC head predicts depth normalised by focal length: metric depth is
`net_output * focal_px / 300` with focal expressed at the processed resolution
(300 is DA3's canonical focal). `inference()` returns the normalised value, so
this adapter applies the un-normalisation itself using the *calibrated* focal
length rather than letting anything estimate intrinsics from the image. The
downstream landmark alignment still refines the scale per keyframe.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Optional

import numpy as np

from ..types import CameraIntrinsics
from .base import DepthEstimator

log = logging.getLogger(__name__)

#: DA3's canonical focal length: metric depth = net_output * focal_px / 300.
_DA3_CANONICAL_FOCAL = 300.0


class DepthAnything3Estimator(DepthEstimator):
    metric = True

    def __init__(self, cfg, device: str = "cuda") -> None:
        import torch

        self.cfg = cfg
        self.dcfg = cfg.depth
        self.torch = torch
        self._lock = threading.Lock()

        if device == "cuda" and not torch.cuda.is_available():
            log.warning("CUDA unavailable; DA3 will run on CPU and will not keep up")
            device = "cpu"
        self.device = torch.device(device)

        # The upstream package prints three [INFO] lines per inference, which
        # at keyframe rate buries the pipeline's own log. Its level is read
        # from the environment at import time.
        os.environ.setdefault("DA3_LOG_LEVEL", "WARN")
        from depth_anything_3.api import DepthAnything3

        name = self.dcfg.model
        if "da3" not in name.lower():
            # backend=da3 with a leftover DA2 model string in the config: fall
            # back to the metric checkpoint rather than crashing mid-startup.
            log.warning("depth.model=%s is not a DA3 checkpoint; using DA3METRIC-LARGE", name)
            name = "depth-anything/DA3METRIC-LARGE"
        if "metric" not in name.lower():
            log.warning(
                "%s is not a DA3METRIC checkpoint; its depth is focal-normalised "
                "relative geometry and the map scale will rest entirely on the "
                "landmark alignment", name,
            )
            self.metric = False

        log.info("loading DA3 model %s", name)
        t0 = time.perf_counter()
        # Weights stay fp32: the upstream `inference()` wrapper feeds fp32
        # tensors and handles mixed precision internally, so a manual .half()
        # produces dtype mismatches inside the DPT head. 334M params in fp32 is
        # ~1.4 GB -- within budget. depth.fp16 is intentionally ignored here.
        self.model = DepthAnything3.from_pretrained(name).to(self.device).eval()
        log.info("DA3 ready in %.1fs (%s)", time.perf_counter() - t0, self.device)

    def _forward(self, image: np.ndarray) -> np.ndarray:
        """One inference through the upstream API; returns HxW float32."""
        pred = self.model.inference(
            [image],
            process_res=int(self.dcfg.input_size),
        )
        depth = np.asarray(pred.depth, np.float32)
        if depth.ndim == 3:
            depth = depth[0]
        conf = getattr(pred, "conf", None)
        if conf is not None:
            c = np.asarray(conf, np.float32)
            if c.ndim == 3:
                c = c[0]
            # Zero out what the network itself does not trust; the TSDF weights
            # by confidence-adjacent heuristics downstream but a hard gate on
            # the worst tail keeps flying-pixel edges out of the volume.
            depth = np.where(c >= np.percentile(c, 5.0), depth, 0.0)
        return depth

    def predict(self, image: np.ndarray, intrinsics: Optional[CameraIntrinsics] = None,
                frame_index: Optional[int] = None) -> np.ndarray:
        import cv2

        h, w = image.shape[:2]
        with self._lock, self.torch.inference_mode():
            depth = self._forward(image)

        if self.metric and intrinsics is not None:
            # Un-normalise with the calibrated focal, expressed at the
            # resolution the network actually processed.
            fx_proc = float(intrinsics.fx) * (depth.shape[1] / float(w))
            depth = depth * (fx_proc / _DA3_CANONICAL_FOCAL)

        if depth.shape != (h, w):
            depth = cv2.resize(depth, (w, h), interpolation=cv2.INTER_LINEAR)

        depth[~np.isfinite(depth)] = 0.0
        np.clip(depth, 0.0, self.dcfg.max_depth_m * 4.0, out=depth)
        return depth

    def warmup(self) -> None:
        dummy = np.zeros((480, 640, 3), np.uint8)
        for _ in range(2):
            self.predict(dummy)
        if self.device.type == "cuda":
            self.torch.cuda.synchronize()
        log.info("DA3 warmup complete (%.0f MB VRAM)", self.vram_mb)

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
