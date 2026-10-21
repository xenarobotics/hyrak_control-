"""
Copilot's eyes: Florence-2 large, through transformers' native
Florence2ForConditionalGeneration (florence-community weights, no
trust_remote_code), fp16 on CUDA.

  caption(frame)          <MORE_DETAILED_CAPTION>: "what do you see?" without Claude
  ground(frame, phrase)   every box matching a description ("man in a red shirt")
  detect(frame)           <OD>: open-class boxes, for counts of what no tracker counts

Frames are BGR numpy arrays (what stream_track holds). They are shrunk to at
most MAX_SIDE before inference and the boxes scaled back to the frame's own
pixels, so they line up with the trackers' boxes and the client overlay.
"""
from __future__ import annotations

import logging
import os
import re
import time
from typing import Dict, List, Optional

import numpy as np

from app.copilot.models import ModelSlot, device_and_dtype

logger = logging.getLogger("verocore.copilot.vision")

MODEL_ID = os.environ.get("COPILOT_VISION_MODEL", "florence-community/Florence-2-large")
MAX_SIDE = 1280

CAPTION = "<MORE_DETAILED_CAPTION>"
GROUNDING = "<CAPTION_TO_PHRASE_GROUNDING>"
OPEN_VOCAB = "<OPEN_VOCABULARY_DETECTION>"
OD = "<OD>"


def _load():
    import torch
    from transformers import AutoProcessor, Florence2ForConditionalGeneration
    device, dtype = device_and_dtype()
    processor = AutoProcessor.from_pretrained(MODEL_ID)
    model = Florence2ForConditionalGeneration.from_pretrained(
        MODEL_ID, dtype=dtype, low_cpu_mem_usage=True).to(device)
    model.eval()
    return {"model": model, "processor": processor, "device": device, "dtype": dtype}


slot = ModelSlot("vision", _load)


def _to_pil(frame_bgr: np.ndarray):
    """(PIL RGB image at most MAX_SIDE, scale from it back to the frame)."""
    import cv2
    from PIL import Image
    h, w = frame_bgr.shape[:2]
    scale = 1.0
    if max(h, w) > MAX_SIDE:
        scale = MAX_SIDE / float(max(h, w))
        frame_bgr = cv2.resize(frame_bgr, (int(round(w * scale)), int(round(h * scale))),
                               interpolation=cv2.INTER_AREA)
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    return Image.fromarray(rgb), 1.0 / scale


def _run(frame_bgr: np.ndarray, task: str, text: str = "", *, beams: int = 3,
         max_new_tokens: int = 512):
    import torch
    m = slot.get()
    image, back = _to_pil(frame_bgr)
    inputs = m["processor"](text=task + text, images=image, return_tensors="pt")
    inputs = inputs.to(m["device"], m["dtype"])
    with torch.inference_mode():
        ids = m["model"].generate(**inputs, max_new_tokens=max_new_tokens, num_beams=beams,
                                  do_sample=False)
    raw = m["processor"].batch_decode(ids, skip_special_tokens=False)[0]
    parsed = m["processor"].post_process_generation(raw, task=task, image_size=image.size)
    return parsed.get(task, parsed), back


def parse_boxes(result, back: float = 1.0, phrase: Optional[str] = None) -> List[Dict]:
    """Florence's {bboxes, labels | bboxes_labels} as [{label, box, score}]
    in frame pixels. Florence gives no confidence; score is 1.0."""
    if not isinstance(result, dict):
        return []
    boxes = result.get("bboxes") or []
    labels = result.get("labels") or result.get("bboxes_labels") or []
    out = []
    for i, b in enumerate(boxes):
        if not isinstance(b, (list, tuple)) or len(b) < 4:
            continue
        x1, y1, x2, y2 = (float(v) * back for v in b[:4])
        if x2 <= x1 or y2 <= y1:
            continue
        label = str(labels[i] if i < len(labels) else (phrase or "")).strip()
        label = re.sub(r"</?s>|<pad>", "", label).strip() or (phrase or "object")
        out.append({"label": label, "box": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
                    "score": 1.0})
    return out


def caption(frame_bgr: np.ndarray) -> str:
    """Blocking: run on slot.executor."""
    t0 = time.perf_counter()
    res, _ = _run(frame_bgr, CAPTION, beams=3, max_new_tokens=256)
    text = res if isinstance(res, str) else str(res)
    logger.info(f"Copilot caption in {time.perf_counter() - t0:.2f}s")
    return re.sub(r"</?s>|<pad>", "", text).strip()


def ground(frame_bgr: np.ndarray, phrase: str, *, every: bool = False) -> List[Dict]:
    """Blocking. The boxes Florence finds for `phrase`, the other task when
    the first finds nothing.

    Measured on Florence-2 large (smoke test): open-vocabulary detection
    tells attributes apart ("man in a dark jacket" -> that one man, or the
    jacket on him) but often returns ONE box for a bare class ("person" in a
    street of four); phrase grounding returns every instance of a class but
    splits a description into its nouns ("man", "jacket") and loses the
    attribute. So a description (follow / track) asks open-vocabulary first,
    and a count (every=True) asks phrase grounding first."""
    t0 = time.perf_counter()
    phrase = phrase.strip()
    order = (GROUNDING, OPEN_VOCAB) if every else (OPEN_VOCAB, GROUNDING)
    boxes: List[Dict] = []
    for task in order:
        res, back = _run(frame_bgr, task, phrase)
        boxes = parse_boxes(res, back, phrase)
        if boxes:
            break
    logger.info(f"Copilot grounding {phrase!r}: {len(boxes)} box(es) in "
                f"{time.perf_counter() - t0:.2f}s")
    return boxes


def detect(frame_bgr: np.ndarray) -> List[Dict]:
    """Blocking. Florence's open-class detector."""
    res, back = _run(frame_bgr, OD)
    return parse_boxes(res, back)
