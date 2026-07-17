import logging
from typing import Any, Dict, Tuple
import cv2
import numpy as np
import torch
from PIL import Image

from app.vision.base import BaseAnalyzer
from app.config import get_settings

logger = logging.getLogger("verocore.vision.depth_mapper")


class DepthMapper(BaseAnalyzer):
    def __init__(self, **kwargs):
        super().__init__(executor_workers=1, **kwargs)
        settings = get_settings()
        self.device      = settings.device
        self.viz_min_depth = 0.3   # metres — clip below this
        self.viz_max_depth = 5.0   # metres — clip above this

        # Downscale input before ZoeDepth to keep inference fast
        # 640x360 gives good quality at ~25ms on 4070
        self.infer_w = 640
        self.infer_h = 360

        try:
            logger.info(f"Loading ZoeDepth on {self.device}...")
            from transformers import pipeline
            dtype = torch.float16 if self.device == "cuda" else torch.float32
            self.estimator = pipeline(
                "depth-estimation",
                model="Intel/zoedepth-nyu-kitti",
                device=self.device,
                torch_dtype=dtype,
            )
            logger.info(f"✅ DepthMapper using ZoeDepth on {self.device.upper()}")
        except Exception as e:
            logger.error(f"DepthMapper load failed: {e}")
            raise

    @torch.inference_mode()
    def _analyze_frame_blocking(
        self, frame_bgr: np.ndarray
    ) -> Tuple[np.ndarray, Dict[str, Any]]:
        H, W = frame_bgr.shape[:2]

        # Downscale for faster inference
        frame_small = cv2.resize(frame_bgr, (self.infer_w, self.infer_h))
        frame_rgb   = cv2.cvtColor(frame_small, cv2.COLOR_BGR2RGB)
        pil_image   = Image.fromarray(frame_rgb)

        result = self.estimator(pil_image)
        depth  = result["predicted_depth"].squeeze().cpu().numpy()

        if depth.ndim != 2:
            depth = depth.squeeze()

        # Fix NaN/inf before any arithmetic — this was the original crash
        depth = np.nan_to_num(depth, nan=0.0, posinf=self.viz_max_depth, neginf=0.0)
        depth = np.clip(depth, self.viz_min_depth, self.viz_max_depth)

        # Normalize to 0-255 for colormap
        depth_norm = ((depth - self.viz_min_depth) / (self.viz_max_depth - self.viz_min_depth) * 255)
        depth_norm = np.clip(depth_norm, 0, 255).astype(np.uint8)

        # Upscale back to original resolution
        depth_full = cv2.resize(depth_norm, (W, H), interpolation=cv2.INTER_LINEAR)
        colormap   = cv2.applyColorMap(depth_full, cv2.COLORMAP_JET)

        # Free VRAM between frames
        if self.device == "cuda":
            torch.cuda.empty_cache()

        # Metric stats — clipped to the same viz range so UI values match the colormap
        depth_orig = result["predicted_depth"].squeeze().cpu().numpy()
        depth_orig = np.nan_to_num(depth_orig, nan=0.0, posinf=self.viz_max_depth, neginf=0.0)
        depth_orig = np.clip(depth_orig, self.viz_min_depth, self.viz_max_depth)

        meta: Dict[str, Any] = {
            "min_depth_m":  round(float(depth_orig.min()), 2),
            "max_depth_m":  round(float(depth_orig.max()), 2),
            "mean_depth_m": round(float(depth_orig.mean()), 2),
        }
        return colormap, meta