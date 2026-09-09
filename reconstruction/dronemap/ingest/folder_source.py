"""Deterministic image-folder replay.

The workhorse for testing and for the synthetic ground-truth harness: no codec,
no network, byte-identical frames every run. Optionally paced in real time so
timing-dependent behaviour (keyframe timeouts, stall detection) is exercised the
same way it would be on a live link.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

from ..config import Config
from .base import FrameSource

log = logging.getLogger(__name__)

_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"}


class FolderSource(FrameSource):
    def __init__(self, cfg: Config) -> None:
        super().__init__(cfg)
        self._paths: list[Path] = []
        self._pos = 0
        self._period = 1.0 / cfg.source.target_fps if cfg.source.target_fps > 0 else 0.0
        self._next_due = 0.0

    def open(self) -> None:
        root = Path(self.src.uri)
        if not root.is_dir():
            raise NotADirectoryError(f"folder source needs a directory: {root}")
        # Natural sort so frame_10 follows frame_9, not frame_1.
        self._paths = sorted(
            (p for p in root.iterdir() if p.suffix.lower() in _EXTS),
            key=lambda p: _natural_key(p.name),
        )
        if not self._paths:
            raise FileNotFoundError(f"no images found in {root}")
        log.info("folder source: %d images from %s", len(self._paths), root)
        self._next_due = time.monotonic()
        # Replaying faster than real time: drive timestamps from the frame rate.
        self._use_media_time = not self.src.realtime_replay

    def _read(self) -> Optional[np.ndarray]:
        if self._pos >= len(self._paths):
            if not self.src.loop:
                return None
            self._pos = 0
        path = self._paths[self._pos]
        self._pos += 1

        if self.src.realtime_replay and self._period > 0:
            now = time.monotonic()
            if self._next_due > now:
                time.sleep(self._next_due - now)
            self._next_due = max(self._next_due + self._period, now)

        bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if bgr is None:
            log.warning("unreadable image, skipping: %s", path)
            return self._read()
        # Sole BGR->RGB conversion point for this transport.
        return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

    def __len__(self) -> int:
        return len(self._paths)


def _natural_key(name: str) -> list:
    import re

    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]
