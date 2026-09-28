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
        self._viz_range: tuple[float, float] | None = None       # smoothed colour range
        self.hfov_deg = float(settings.camera_hfov_deg)
        self.obstacle_max_m = float(settings.depth_obstacle_max_m)
        self.model_name = settings.depth_model

        # Downscale input before ZoeDepth to keep inference fast
        # 640x360 gives good quality at ~25ms on 4070
        self.infer_w = 640
        self.infer_h = 360

        # Backend per model id (app/vision/depth_models.py). Depth Anything 3
        # loads from its source checkout; if that is missing or broken the
        # previous default (V2 metric outdoor) keeps avoidance and the depth
        # mode working, and the log says why.
        from app.vision import depth_models
        try:
            logger.info(f"Loading depth model {self.model_name} on {self.device}...")
            self.backend = depth_models.load(self.model_name, self.device)
        except Exception as e:
            fallback = "depth-anything/Depth-Anything-V2-Metric-Outdoor-Small-hf"
            if self.model_name == fallback:
                logger.error(f"DepthMapper load failed: {e}")
                raise
            logger.error(f"Depth model {self.model_name} failed to load ({e}) - falling back to {fallback}")
            self.model_name = fallback
            self.backend = depth_models.load(fallback, self.device)
        logger.info(f"DepthMapper using {self.model_name.split('/')[-1]} on {self.device.upper()}")

    def predict_metric(self, frame_bgr: np.ndarray, hfov_deg: float | None = None) -> np.ndarray:
        """Metric depth (metres, the model's own scale - NOT ground-calibrated)
        at the model's output resolution. hfov_deg is the frame's horizontal
        field of view (default: the camera calibration); lens-aware models
        use it to put distances in metres. Avoidance sensing calibrates the
        scale on top (app/avoidance/sensing/mono_calibration)."""
        if hfov_deg is None:
            # This analyzer's session (one per session) decides the lens.
            from app.vision import camera_profiles
            hfov_deg = camera_profiles.hfov_for(next(iter(getattr(self, "_clients", {})), None))
        return self.backend.predict(frame_bgr, hfov_deg)

    @staticmethod
    def _draw_scale(img: np.ndarray, lo: float, hi: float) -> None:
        """Colour bar with its metres, bottom-left."""
        h, w = img.shape[:2]
        bw, bh, x0 = max(120, w // 5), max(10, h // 45), 12
        y0 = h - bh - 28
        bar = cv2.applyColorMap(np.tile(np.linspace(0, 255, bw).astype(np.uint8), (bh, 1)), cv2.COLORMAP_TURBO)
        img[y0:y0 + bh, x0:x0 + bw] = bar
        cv2.rectangle(img, (x0 - 1, y0 - 1), (x0 + bw, y0 + bh), (255, 255, 255), 1)
        for txt, x in ((f"{lo:.1f} m", x0), (f"{hi:.1f} m", x0 + bw - 44)):
            cv2.putText(img, txt, (x, y0 + bh + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 3, cv2.LINE_AA)
            cv2.putText(img, txt, (x, y0 + bh + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)

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

        # Colour range follows the SCENE, not a fixed 0.3-60 m: with a fixed
        # scale a 5 m room used 8 % of it and came out uniformly blue. The
        # 2nd-98th percentile, smoothed across frames (no flicker), at least
        # 1.5 m wide; the metres are printed on the image so colours stay
        # readable. Blue = near, red = far.
        valid = depth[depth > self.viz_min_depth]
        if valid.size > 50:
            lo, hi = np.percentile(valid, 2), np.percentile(valid, 98)
            if self._viz_range is None:
                self._viz_range = (lo, hi)
            else:
                a = 0.2
                self._viz_range = (self._viz_range[0] * (1 - a) + lo * a,
                                   self._viz_range[1] * (1 - a) + hi * a)
        lo, hi = self._viz_range or (self.viz_min_depth, self.viz_max_depth)
        hi = max(hi, lo + 1.5)
        depth_norm = np.clip((depth - lo) / (hi - lo) * 255, 0, 255).astype(np.uint8)

        # Upscale back to original resolution
        depth_full = cv2.resize(depth_norm, (W, H), interpolation=cv2.INTER_LINEAR)
        colormap   = cv2.applyColorMap(depth_full, cv2.COLORMAP_TURBO)
        self._draw_scale(colormap, lo, hi)

        # Metric stats from the same clipped depth the colormap uses, so UI
        # values match the visualization. (No per-frame empty_cache here -
        # it forces a GPU sync/allocator flush every frame, which caused
        # visible stutter; the worker pool clears VRAM on mode switch.)
        meta: Dict[str, Any] = {
            "min_depth_m":  round(float(depth.min()), 2),
            "max_depth_m":  round(float(depth.max()), 2),
            "mean_depth_m": round(float(depth.mean()), 2),
            "viz_range_m":  [round(float(lo), 2), round(float(hi), 2)],
        }
        if obstacle_obs is not None:
            meta["obstacle_observations"] = obstacle_obs
        return colormap, meta