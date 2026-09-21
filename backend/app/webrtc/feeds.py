"""Shared air-unit feeds: ONE reader per udp port, two kinds of consumers.

A udp port can be bound by exactly one process, so everything that wants a
unit's video shares one reader per port (port = 5600 + mesh node id, the
unit's identity throughout the app). The reader thread demuxes the RTP/H.265
once and hands out:

  * RAW access units (Annex-B, keyframes carry VPS/SPS/PPS in-band) - for the
    bit-exact path: the browser decodes the unit's own bytes with WebCodecs,
    no re-encode, the picture the gst window shows. subscribe_raw()/unsubscribe_raw().
  * DECODED frames through a MediaRelay track - for WebRTC senders and the
    AI/avoidance pipelines. acquire()/release(), refcounted; the reader stops
    and the port is released when the last consumer lets go.

The reader re-opens its socket on ffmpeg's short I/O timeout instead of
dying: a mesh unit re-parenting through another node goes quiet for tens of
seconds, and a dead reader that still held the port made the next open fail.
"""
from __future__ import annotations

import asyncio
import fractions
import logging
import struct
import threading
import time

import av
from aiortc import MediaStreamTrack
from aiortc.contrib.media import MediaRelay

from app.webrtc.udp_video_source import _sdp_file

logger = logging.getLogger("verocore.webrtc.feeds")

IO_TIMEOUT_S = 3.0          # ffmpeg socket timeout; reader reopens, never dies
QUIET_LOG_S = 60.0          # complain once a minute while a port stays silent
AU_HEADER = struct.Struct(">IBI")   # [uint32 len][uint8 key][uint32 seq] (annexb.ts)


class DecodedTrack(MediaStreamTrack):
    """Latest-frame track fed from the reader thread. Never queues: a slow
    consumer sees the newest frame, not a growing backlog."""
    kind = "video"

    def __init__(self, loop: asyncio.AbstractEventLoop):
        super().__init__()
        self._loop = loop
        self._frame = None
        self._event = asyncio.Event()

    def push(self, frame) -> None:            # reader thread
        self._loop.call_soon_threadsafe(self._set, frame)

    def _set(self, frame) -> None:
        self._frame = frame
        self._event.set()

    async def recv(self):
        if self.readyState != "live":
            raise Exception("track ended")
        await self._event.wait()
        self._event.clear()
        return self._frame


class SharedReader:
    def __init__(self, port: int, loop: asyncio.AbstractEventLoop):
        self.port = port
        self.loop = loop
        self.track = DecodedTrack(loop)
        self.relay = MediaRelay()
        self.refs = 0
        self.raw_subs: list[asyncio.Queue] = []
        self.raw_refs = 0
        self._stop = threading.Event()
        self._seq = 0
        self.last_packet_t = 0.0
        self.width = self.height = 0
        self._thread = threading.Thread(target=self._run, name=f"feed-{port}", daemon=True)
        self._thread.start()

    # ---- consumers ---------------------------------------------------------
    def subscribe_decoded(self):
        return self.relay.subscribe(self.track)

    def subscribe_raw(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=90)   # ~3 s at 30 fps
        q.wait_key = True                              # start at a keyframe
        self.raw_subs.append(q)
        self.raw_refs += 1
        return q

    def unsubscribe_raw(self, q: asyncio.Queue) -> None:
        if q in self.raw_subs:
            self.raw_subs.remove(q)
            self.raw_refs -= 1

    @property
    def idle(self) -> bool:
        return self.refs <= 0 and self.raw_refs <= 0

    def stop(self) -> None:
        self._stop.set()
        self.track.stop()

    # ---- reader thread -------------------------------------------------------
    def _deliver_raw(self, data: bytes, key: bool, seq: int) -> None:
        payload = AU_HEADER.pack(len(data), 1 if key else 0, seq & 0xFFFFFFFF) + data
        for q in list(self.raw_subs):
            if getattr(q, "wait_key", False):
                if not key:
                    continue
                q.wait_key = False
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                # Consumer is behind: drop its backlog and resync on a keyframe.
                try:
                    while True:
                        q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                q.wait_key = True

    def _run(self) -> None:
        opts = {"protocol_whitelist": "file,udp,rtp", "fflags": "nobuffer", "flags": "low_delay",
                "reorder_queue_size": "0", "max_delay": "0"}
        quiet_since = None
        while not self._stop.is_set():
            container = None
            try:
                container = av.open(_sdp_file(self.port), format="sdp", options=opts, timeout=IO_TIMEOUT_S)
                vs = container.streams.video[0]
                cc = vs.codec_context
                cc.thread_type = "AUTO"
                for pkt in container.demux(vs):
                    if self._stop.is_set():
                        break
                    if pkt.pts is None and pkt.dts is None:
                        continue
                    data = bytes(pkt)
                    if not data:
                        continue
                    self.last_packet_t = time.monotonic()
                    quiet_since = None
                    self._seq += 1
                    if self.raw_subs:
                        self.loop.call_soon_threadsafe(self._deliver_raw, data, bool(pkt.is_keyframe), self._seq)
                    if self.refs > 0:
                        try:
                            for frame in cc.decode(pkt):
                                if frame.time_base is None:
                                    frame.time_base = fractions.Fraction(1, 90000)
                                self.width, self.height = frame.width, frame.height
                                self.track.push(frame)
                        except av.AVError as e:
                            logger.debug(f"udp:{self.port} decode: {e}")
            except Exception as e:
                if self._stop.is_set():
                    break
                now = time.monotonic()
                if quiet_since is None:
                    quiet_since = now
                elif now - quiet_since > QUIET_LOG_S:
                    logger.warning(f"udp:{self.port}: no video for {now - quiet_since:.0f}s ({e})")
                    quiet_since = now
                time.sleep(0.3)
            finally:
                if container is not None:
                    try:
                        container.close()
                    except Exception:
                        pass
        logger.info(f"Feed reader on udp:{self.port} stopped")


_feeds: dict[int, SharedReader] = {}
_lock: asyncio.Lock | None = None


def _get_lock() -> asyncio.Lock:
    global _lock
    if _lock is None:
        _lock = asyncio.Lock()
    return _lock


def _get_or_start(port: int) -> SharedReader:
    r = _feeds.get(port)
    if r is None:
        r = _feeds[port] = SharedReader(port, asyncio.get_event_loop())
        logger.info(f"Feed reader opened on udp:{port}")
    return r


def _maybe_stop(port: int) -> None:
    r = _feeds.get(port)
    if r is not None and r.idle:
        _feeds.pop(port, None)
        r.stop()
        logger.info(f"Feed reader closed on udp:{port}")


async def acquire(port: int, timeout: float = 5.0):
    """A relay-subscribed DECODED track for this port. `timeout` is how long
    to wait for the first frame before raising - the reader itself never
    gives up on a quiet port."""
    async with _get_lock():
        r = _get_or_start(port)
        r.refs += 1
        sub = r.subscribe_decoded()
    t0 = time.monotonic()
    while r.last_packet_t == 0.0 and time.monotonic() - t0 < timeout:
        await asyncio.sleep(0.1)
    if r.last_packet_t == 0.0:
        await release(port)
        raise RuntimeError(f"No video on udp:{port} within {timeout:.0f}s - is the unit transmitting?")
    return sub


async def release(port: int) -> None:
    async with _get_lock():
        r = _feeds.get(port)
        if r is None:
            return
        r.refs -= 1
        _maybe_stop(port)


async def subscribe_raw(port: int) -> asyncio.Queue:
    async with _get_lock():
        r = _get_or_start(port)
        return r.subscribe_raw()


async def unsubscribe_raw(port: int, q: asyncio.Queue) -> None:
    async with _get_lock():
        r = _feeds.get(port)
        if r is None:
            return
        r.unsubscribe_raw(q)
        _maybe_stop(port)


def open_ports() -> list[int]:
    return sorted(_feeds)


def status(port: int) -> dict | None:
    r = _feeds.get(port)
    if r is None:
        return None
    return {"port": port, "decoded_refs": r.refs, "raw_refs": r.raw_refs,
            "width": r.width, "height": r.height,
            "quiet_s": round(time.monotonic() - r.last_packet_t, 1) if r.last_packet_t else None}
