import logging
from typing import Any, Dict, Tuple
import numpy as np
import torch
from ultralytics import YOLO

from app.vision.base import BaseAnalyzer
from app.vision.drawing import draw_brackets, draw_badge
from app.config import get_settings

logger = logging.getLogger("verocore.vision.object_detector")


# ── Detector ─────────────────────────────────────────────────────────────────

class ObjectDetector(BaseAnalyzer):
    MODE = "object-detection"

    def __init__(self, **kwargs):
        super().__init__(executor_workers=2, **kwargs)
        settings = get_settings()
        self.device = settings.device

        logger.info(f"Loading YOLO on {self.device}...")
        self.model = YOLO(settings.default_yolo_model)
        self.model.to(self.device)
        # Warm-up so CUDA kernel init doesn't stall the first live frames
        self.model(
            np.zeros((360, 640, 3), dtype=np.uint8),
            device=self.device, half=self.device == "cuda", verbose=False,
        )
        logger.info(f"✅ ObjectDetector ready on {self.device.upper()}")

    @torch.inference_mode()
    def _analyze_frame_blocking(
        self, frame_bgr: np.ndarray
    ) -> Tuple[np.ndarray, Dict[str, Any]]:
        # Shared with every other module now (BaseAnalyzer.resize_for_inference)
        # so the per-mode width is honoured in one place instead of four.
        frame_proc, sx, sy = self.resize_for_inference(frame_bgr)

        opts: Dict[str, Any] = {
            "device": self.device, "verbose": False, "conf": 0.4,
            # Without this ultralytics letterboxes back to 640 regardless.
            # imgsz_for(), not inference_width: a mode configured to 0 (native)
            # would otherwise raise on every frame inside the worker thread.
            "imgsz": self.imgsz_for(frame_proc),
        }
        if self.device == "cuda":
            opts["half"] = True

        results = self.model(frame_proc, **opts)

        detected: Dict[str, int] = {}
        detections = []

        for box in results[0].boxes:
            name = self.model.names[int(box.cls[0])]
            detected[name] = detected.get(name, 0) + 1

            x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
            detections.append({
                "name": name,
                "box":  [int(x1 * sx), int(y1 * sy), int(x2 * sx), int(y2 * sy)],
            })

        meta: Dict[str, Any] = {
            "objects":      detected,
            "detections":   detections,
            "person_count": detected.get("person", 0),
            "total_count":  sum(detected.values()),
        }
        return frame_bgr, meta

    def draw_overlay(self, frame_bgr: np.ndarray, meta: Dict[str, Any]) -> np.ndarray:
        for det in meta.get("detections", []):
            x1, y1, x2, y2 = det["box"]
            is_person = det["name"] == "person"
            color     = (220, 220, 220) if is_person else (150, 150, 150)
            thickness = 2 if is_person else 1
            draw_brackets(frame_bgr, x1, y1, x2, y2, color, thickness=thickness)
            # Class name only - no confidence percentage
            draw_badge(frame_bgr, det["name"], x1, max(16, y1 - 4))
        return frame_bgr
