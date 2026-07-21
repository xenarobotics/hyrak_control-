import logging
from typing import Any, Dict, Tuple
import cv2
import numpy as np
import torch
from ultralytics import YOLO

from app.vision.base import BaseAnalyzer
from app.vision.drawing import draw_brackets, draw_badge
from app.config import get_settings

logger = logging.getLogger("verocore.vision.object_detector")


# ── Detector ─────────────────────────────────────────────────────────────────

class ObjectDetector(BaseAnalyzer):
    def __init__(self, **kwargs):
        super().__init__(executor_workers=2, **kwargs)
        settings = get_settings()
        self.device = settings.device
        self.resize_width = settings.inference_resize_width

        logger.info(f"Loading YOLO on {self.device}...")
        self.model = YOLO(settings.default_yolo_model)
        self.model.to(self.device)
        # Warm-up so CUDA kernel init doesn't stall the first live frames
        self.model(
            np.zeros((360, 640, 3), dtype=np.uint8),
            device=self.device, half=self.device == "cuda", verbose=False,
        )
        logger.info(f"✅ ObjectDetector ready on {self.device.upper()}")

    def _preprocess(self, frame: np.ndarray) -> np.ndarray:
        if self.resize_width and frame.shape[1] > self.resize_width:
            scale = self.resize_width / frame.shape[1]
            new_h = int(frame.shape[0] * scale)
            return cv2.resize(frame, (self.resize_width, new_h))
        return frame

    @torch.inference_mode()
    def _analyze_frame_blocking(
        self, frame_bgr: np.ndarray
    ) -> Tuple[np.ndarray, Dict[str, Any]]:
        original_h, original_w = frame_bgr.shape[:2]
        frame_proc = self._preprocess(frame_bgr)
        proc_h, proc_w = frame_proc.shape[:2]

        opts: Dict[str, Any] = {"device": self.device, "verbose": False, "conf": 0.4}
        if self.device == "cuda":
            opts["half"] = True

        results = self.model(frame_proc, **opts)

        # Scale box coordinates back to the original frame resolution
        sx = original_w / proc_w
        sy = original_h / proc_h

        annotated = frame_bgr.copy()
        detected: Dict[str, int] = {}

        for box in results[0].boxes:
            name = self.model.names[int(box.cls[0])]
            detected[name] = detected.get(name, 0) + 1

            x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
            x1 = int(x1 * sx); y1 = int(y1 * sy)
            x2 = int(x2 * sx); y2 = int(y2 * sy)

            is_person = name == "person"
            color     = (220, 220, 220) if is_person else (150, 150, 150)
            thickness = 2 if is_person else 1

            draw_brackets(annotated, x1, y1, x2, y2, color, thickness=thickness)
            # Class name only — no confidence percentage
            draw_badge(annotated, name, x1, max(16, y1 - 4))

        meta: Dict[str, Any] = {
            "objects":      detected,
            "person_count": detected.get("person", 0),
            "total_count":  sum(detected.values()),
        }
        return annotated, meta
