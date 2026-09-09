"""ZeroMQ ingest for a companion process that already has decoded frames.

Wire format, in order of preference:

1. **Multipart** ``[topic?, header_json, payload]`` -- header carries
   ``{h, w, c, dtype, encoding, ts}``. ``encoding`` is ``raw`` or ``jpeg``.
2. **Single part** -- a JPEG/PNG buffer, decoded with OpenCV.

SUB with ``CONFLATE`` keeps only the newest message, which is the right
behaviour for a live view: if we cannot keep up, we want the current frame, not
a backlog of stale ones.
"""

from __future__ import annotations

import json
import logging
from typing import Optional

import cv2
import numpy as np

from ..config import Config
from .base import FrameSource

log = logging.getLogger(__name__)


class ZmqSource(FrameSource):
    def __init__(self, cfg: Config) -> None:
        super().__init__(cfg)
        self._ctx = None
        self._sock = None

    def open(self) -> None:
        try:
            import zmq
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError("pyzmq required for the zmq source: pip install pyzmq") from exc

        self._ctx = zmq.Context.instance()
        self._sock = self._ctx.socket(zmq.SUB)
        self._sock.setsockopt(zmq.RCVHWM, 4)
        # CONFLATE is incompatible with multipart; only enable it for a plain
        # single-frame publisher.
        self._sock.setsockopt(zmq.LINGER, 0)
        topic = self.src.zmq_topic.encode()
        self._sock.setsockopt(zmq.SUBSCRIBE, topic)
        uri = self.src.uri
        if uri.startswith("bind://"):
            self._sock.bind(uri[len("bind://"):])
            log.info("zmq SUB bound at %s topic=%r", uri[7:], self.src.zmq_topic)
        else:
            self._sock.connect(uri)
            log.info("zmq SUB connected to %s topic=%r", uri, self.src.zmq_topic)

    def _read(self) -> Optional[np.ndarray]:
        import zmq

        assert self._sock is not None
        timeout_ms = int(max(self.src.stall_timeout_s, 1.0) * 1000)
        try:
            if not self._sock.poll(timeout_ms):
                log.warning("zmq: no message for %.1fs; treating as stream end",
                            timeout_ms / 1000)
                return None
            parts = self._sock.recv_multipart(zmq.NOBLOCK)
        except zmq.ZMQError as exc:
            log.error("zmq receive failed: %s", exc)
            return None
        if self._closed:
            return None
        return self._decode(parts)

    def _decode(self, parts: list[bytes]) -> Optional[np.ndarray]:
        if not parts:
            return None
        if self.src.zmq_topic and len(parts) > 1:
            parts = parts[1:]  # strip the topic frame

        if len(parts) >= 2:
            try:
                header = json.loads(parts[0].decode())
            except (UnicodeDecodeError, json.JSONDecodeError):
                header = None
            if isinstance(header, dict) and "h" in header and "w" in header:
                payload = parts[1]
                if header.get("encoding", "raw") == "raw":
                    dtype = np.dtype(header.get("dtype", "uint8"))
                    c = int(header.get("c", 3))
                    arr = np.frombuffer(payload, dtype=dtype)
                    expected = int(header["h"]) * int(header["w"]) * c
                    if arr.size != expected:
                        log.warning("zmq payload size %d != declared %d", arr.size, expected)
                        return None
                    img = arr.reshape(int(header["h"]), int(header["w"]), c)
                    if header.get("order", "rgb").lower() == "bgr":
                        img = img[..., ::-1]
                    return np.ascontiguousarray(img)
                return self._imdecode(payload)

        return self._imdecode(parts[-1])

    @staticmethod
    def _imdecode(buf: bytes) -> Optional[np.ndarray]:
        arr = np.frombuffer(buf, dtype=np.uint8)
        bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if bgr is None:
            log.warning("zmq: could not decode %d-byte payload", len(buf))
            return None
        return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._sock is not None:
            self._sock.close(0)
