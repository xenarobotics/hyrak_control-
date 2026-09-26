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
    MODE = "depth-mapping"

    def __init__(self, **kwargs):
        super().__init__(executor_workers=1, **kwargs)
        settings = get_settings()
        self.device      = settings.device
        self.viz_min_depth = 0.3   # metres - clip below this
        self.viz_max_depth = float(settings.depth_viz_max_m)   # clip above this
        self.hfov_deg = float(settings.camera_hfov_deg)
        self.obstacle_max_m = float(settings.depth_obstacle_max_m)
        self.model_name = settings.depth_model

        # Downscale input before ZoeDepth to keep inference fast
        # 640x360 gives good quality at ~25ms on 4070
        self.infer_w = 640
        self.infer_h = 360

        try:
            logger.info(f"Loading depth model {self.model_name} on {self.device}...")
            from transformers import pipeline
            dtype = torch.float16 if self.device == "cuda" else torch.float32
            self.estimator = pipeline(
                "depth-estimation",
                model=self.model_name,
                device=self.device,
                torch_dtype=dtype,
            )
            # Warm-up: first CUDA inference pays kernel/alloc init (~1s);
            # do it here so it doesn't stall the first live frames.
            self.estimator(Image.new("RGB", (self.infer_w, self.infer_h)))
            logger.info(f"✅ DepthMapper using {self.model_name.split('/')[-1]} on {self.device.upper()}")
        except Exception as e:
            logger.error(f"DepthMapper load failed: {e}")
            raise

    @torch.inference_mode()
    def predict_metric(self, frame_bgr: np.ndarray) -> np.ndarray:
        """Raw metric depth (metres, model scale, NOT calibrated) at the
        inference resolution. Used by avoidance sensing, which calibrates the
        scale against the ground plane itself (app/avoidance/mono_calibration)."""
        frame_small = cv2.resize(frame_bgr, (self.infer_w, self.infer_h))
        frame_rgb   = cv2.cvtColor(frame_small, cv2.COLOR_BGR2RGB)
        result = self.estimator(Image.fromarray(frame_rgb))
        depth  = result["predicted_depth"].squeeze().cpu().numpy()
        if depth.ndim != 2:
            depth = depth.squeeze()
        return depth

    @torch.inference_mode()
    def _analyze_frame_blocking(
        self, frame_bgr: np.ndarray
    ) -> Tuple[np.ndarray, Dict[str, Any]]:
        H, W = frame_bgr.shape[:2]
        depth = self.predict_metric(frame_bgr)

        # Fix NaN/inf before any arithmetic - this was the original crash
        depth = np.nan_to_num(depth, nan=0.0, posinf=self.viz_max_depth, neginf=0.0)

        # Obstacle extraction for avoidance is NOT done here any more: it runs
        # in app/avoidance/sensing/camera.py for every AI mode, where the frame's
        # capture time and the aircraft's pose are known (ground-plane scale
        # calibration + geometric ground rejection need both).
        obstacle_obs = None

        depth = np.clip(depth, self.viz_min_depth, self.viz_max_depth)

        # Normalize to 0-255 for colormap
        depth_norm = ((depth - self.viz_min_depth) / (self.viz_max_depth - self.viz_min_depth) * 255)
        depth_norm = np.clip(depth_norm, 0, 255).astype(np.uint8)

        # Upscale back to original resolution
        depth_full = cv2.resize(depth_norm, (W, H), interpolation=cv2.INTER_LINEAR)
        colormap   = cv2.applyColorMap(depth_full, cv2.COLORMAP_JET)

        # Metric stats from the same clipped depth the colormap uses, so UI
        # values match the visualization. (No per-frame empty_cache here -
        # it forces a GPU sync/allocator flush every frame, which caused
        # visible stutter; the worker pool clears VRAM on mode switch.)
        meta: Dict[str, Any] = {
            "min_depth_m":  round(float(depth.min()), 2),
            "max_depth_m":  round(float(depth.max()), 2),
            "mean_depth_m": round(float(depth.mean()), 2),
        }
        if obstacle_obs is not None:
            meta["obstacle_observations"] = obstacle_obs
        return colormap, meta