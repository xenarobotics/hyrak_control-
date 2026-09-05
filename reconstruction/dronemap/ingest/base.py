"""FrameSource: the single interface every transport implements.

A source is an iterator of :class:`~dronemap.types.Frame`. It owns its own
threading (if any), reports whether it is still live, and must be safe to
``close()`` twice. Everything downstream is transport-agnostic.
"""

from __future__ import annotations

import abc
import logging
import time
from typing import Iterator, Optional

import cv2
import numpy as np

from ..config import Config
from ..types import CameraIntrinsics, Frame

log = logging.getLogger(__name__)


class FrameSource(abc.ABC):
    """Abstract video source."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.src = cfg.source
        self._index = 0
        self._closed = False
        self._t_start = time.monotonic()
        #: Use media time rather than wall-clock time for frame timestamps.
        #: Keyframe selection has time-based triggers (a minimum spacing and a
        #: timeout), so stamping frames with wall time makes the keyframe set --
        #: and therefore the whole reconstruction -- depend on how fast the
        #: machine happens to replay the file. Media time keeps a replay
        #: reproducible and identical to the live behaviour it simulates.
        self._use_media_time = False
        self._media_fps = cfg.source.target_fps or 30.0
        self._last_frame_time = time.monotonic()
        #: Intrinsics at the *source* resolution; set once the geometry is known.
        self.source_intrinsics: Optional[CameraIntrinsics] = None
        self._track_intrinsics: Optional[CameraIntrinsics] = None

    # -- lifecycle ----------------------------------------------------------

    @abc.abstractmethod
    def open(self) -> None:
        """Connect / start decoding. Raises on unrecoverable failure."""

    @abc.abstractmethod
    def _read(self) -> Optional[np.ndarray]:
        """Return the next full-resolution RGB frame, or None at end of stream."""

    def close(self) -> None:
        self._closed = True

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def stalled(self) -> bool:
        """True when the transport has gone quiet for longer than configured.

        This is how a live stream signals "the drone landed / the link dropped"
        without an explicit end-of-stream marker.
        """
        if self.src.stall_timeout_s <= 0:
            return False
        return (time.monotonic() - self._last_frame_time) > self.src.stall_timeout_s

    # -- iteration ----------------------------------------------------------

    def __iter__(self) -> Iterator[Frame]:
        return self.frames()

    def frames(self) -> Iterator[Frame]:
        """Yield prepared frames until the source ends."""
        while not self._closed:
            raw = self._read()
            if raw is None:
                break
            self._last_frame_time = time.monotonic()
            yield self._prepare(raw)

    def _prepare(self, raw_rgb: np.ndarray) -> Frame:
        """Resize for tracking, attach intrinsics, and stamp the frame."""
        h, w = raw_rgb.shape[:2]
        if self.source_intrinsics is None:
            self.source_intrinsics = self._resolve_intrinsics(w, h)

        tw, th = self.src.track_width, self.src.track_height
        if (w, h) != (tw, th):
            # INTER_AREA is the correct filter for downscaling: it integrates
            # over the source footprint instead of point-sampling, which
            # preserves corner structure that KLT depends on.
            track_img = cv2.resize(raw_rgb, (tw, th), interpolation=cv2.INTER_AREA)
        else:
            track_img = raw_rgb

        if self._track_intrinsics is None:
            self._track_intrinsics = self.source_intrinsics.scaled(tw, th)

        frame = Frame(
            index=self._index,
            timestamp=(self._index / self._media_fps if self._use_media_time
                       else time.monotonic()),
            image=track_img,
            full=raw_rgb if self.src.retain_full_res else None,
            intrinsics=self._track_intrinsics,
        )
        self._index += 1
        return frame

    def _resolve_intrinsics(self, width: int, height: int) -> CameraIntrinsics:
        """Reconcile configured intrinsics with the resolution actually received.

        Config is written for an expected resolution; if the stream delivers
        something else (a drone downscaling on a weak link, say), the intrinsics
        must be rescaled or every projection will be wrong.
        """
        K = self.cfg.build_intrinsics()
        if (K.width, K.height) != (width, height):
            if K.width and K.height:
                cfg_aspect = K.width / K.height
                if abs(width / height - cfg_aspect) > 0.02 * cfg_aspect:
                    # A different ASPECT is not a rescale of the calibrated
                    # sensor (different crop/sensor mode); rescaling anyway
                    # warps the fx/fy ratio into something no camera has and
                    # PnP dies on the first real motion. Square-pixel
                    # intrinsics from the configured FOV are the honest
                    # fallback.
                    log.warning(
                        "stream is %dx%d (aspect %.3f) but camera config is "
                        "%dx%d (aspect %.3f); not a rescale of the calibrated "
                        "sensor -- deriving square-pixel intrinsics from hfov",
                        width, height, width / height,
                        K.width, K.height, cfg_aspect,
                    )
                    K = CameraIntrinsics.from_fov(width, height,
                                                  self.cfg.camera.hfov_deg)
                else:
                    log.warning(
                        "stream is %dx%d but camera config is %dx%d; "
                        "rescaling intrinsics",
                        width, height, K.width, K.height,
                    )
                    K = K.scaled(width, height)
            else:
                K = CameraIntrinsics.from_fov(width, height, self.cfg.camera.hfov_deg)
        return K

    @property
    def stats(self) -> dict:
        elapsed = max(time.monotonic() - self._t_start, 1e-9)
        return {
            "frames": self._index,
            "elapsed_s": round(elapsed, 2),
            "fps": round(self._index / elapsed, 2),
            "closed": self._closed,
            "stalled": self.stalled,
        }


def build_source(cfg: Config) -> FrameSource:
    """Factory: instantiate the transport named in the config."""
    kind = cfg.source.kind
    if kind in ("rtsp", "udp", "http", "file", "v4l2"):
        from .ffmpeg_source import FFmpegSource

        return FFmpegSource(cfg)
    if kind == "folder":
        from .folder_source import FolderSource

        return FolderSource(cfg)
    if kind == "zmq":
        from .zmq_source import ZmqSource

        return ZmqSource(cfg)
    if kind == "webrtc":
        from .webrtc_source import WebRTCSource

        return WebRTCSource(cfg)
    raise ValueError(f"unknown source kind: {kind}")
