"""WebRTC ingest (optional; requires ``pip install dronemap[webrtc]``).

Runs an aiortc peer connection on a private asyncio loop in its own thread and
hands decoded frames to the synchronous pipeline through a small queue. Signalling
is deliberately minimal -- a single HTTP POST offer/answer exchange -- because
every deployment has its own signalling server and wiring one in here would be
guesswork.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from typing import Optional

import numpy as np

from ..config import Config
from .base import FrameSource

log = logging.getLogger(__name__)


class WebRTCSource(FrameSource):
    def __init__(self, cfg: Config) -> None:
        super().__init__(cfg)
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._queue: "asyncio.Queue[np.ndarray]" = None  # type: ignore[assignment]
        self._ready = threading.Event()
        self._pc = None
        self._error: Optional[BaseException] = None

    def open(self) -> None:
        try:
            import aiortc  # noqa: F401
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "aiortc required for the webrtc source: pip install 'dronemap[webrtc]'"
            ) from exc
        self._thread = threading.Thread(target=self._run_loop, name="webrtc", daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout=30):
            raise RuntimeError("WebRTC negotiation timed out")
        if self._error:
            raise RuntimeError(f"WebRTC setup failed: {self._error}")

    def _run_loop(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._queue = asyncio.Queue(maxsize=4)
        try:
            self._loop.run_until_complete(self._negotiate())
            self._loop.run_forever()
        except Exception as exc:  # noqa: BLE001
            self._error = exc
            self._ready.set()
            log.error("webrtc loop failed: %s", exc)

    async def _negotiate(self) -> None:
        from aiortc import RTCPeerConnection, RTCSessionDescription
        from aiortc.contrib.media import MediaRelay

        pc = RTCPeerConnection()
        self._pc = pc
        relay = MediaRelay()

        @pc.on("track")
        def on_track(track):  # noqa: ANN001
            if track.kind != "video":
                return
            log.info("webrtc: video track received")
            asyncio.ensure_future(self._consume(relay.subscribe(track)))
            self._ready.set()

        pc.addTransceiver("video", direction="recvonly")
        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)

        answer = await self._exchange(pc.localDescription)
        await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type=answer["type"]))

    async def _exchange(self, desc) -> dict:  # noqa: ANN001
        """POST the SDP offer to the signalling URL and read back the answer."""
        import urllib.request

        payload = json.dumps({"sdp": desc.sdp, "type": desc.type}).encode()
        req = urllib.request.Request(
            self.src.uri, data=payload, headers={"Content-Type": "application/json"}
        )
        return await asyncio.get_running_loop().run_in_executor(
            None, lambda: json.loads(urllib.request.urlopen(req, timeout=15).read())
        )

    async def _consume(self, track) -> None:  # noqa: ANN001
        while not self._closed:
            try:
                frame = await track.recv()
            except Exception:  # noqa: BLE001 - track ended
                break
            img = frame.to_ndarray(format="rgb24")
            if self._queue.full():
                try:
                    self._queue.get_nowait()  # drop oldest, stay at the live edge
                except asyncio.QueueEmpty:
                    pass
            await self._queue.put(img)

    def _read(self) -> Optional[np.ndarray]:
        if self._loop is None or self._closed:
            return None
        fut = asyncio.run_coroutine_threadsafe(
            asyncio.wait_for(self._queue.get(), timeout=max(self.src.stall_timeout_s, 1.0)),
            self._loop,
        )
        try:
            return fut.result(timeout=max(self.src.stall_timeout_s, 1.0) + 1.0)
        except Exception:  # noqa: BLE001 - timeout means the stream went quiet
            return None

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._loop is not None and self._pc is not None:
            asyncio.run_coroutine_threadsafe(self._pc.close(), self._loop)
            self._loop.call_soon_threadsafe(self._loop.stop)
