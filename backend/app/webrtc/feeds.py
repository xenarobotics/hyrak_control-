"""Shared air-unit feeds: ONE ffmpeg reader per udp port, any number of viewers.

A udp port can be bound by exactly one process, so the single-view reader
and a camera wall showing the same unit cannot both open it. Instead every
consumer subscribes to a MediaRelay on one shared PlayerStreamTrack per
port; the reader lives while anyone is subscribed and is stopped (port
released) when the last one lets go. Port = 5600 + mesh node id, which is
the unit's identity everywhere in the app.
"""
from __future__ import annotations

import asyncio
import functools
import logging
import time

from aiortc.contrib.media import MediaRelay

from app.webrtc.udp_video_source import open_air_unit_video

logger = logging.getLogger("verocore.webrtc.feeds")

_feeds: dict[int, dict] = {}       # port -> {"track", "relay", "refs"}
_lock: asyncio.Lock | None = None


def _get_lock() -> asyncio.Lock:
    global _lock
    if _lock is None:
        _lock = asyncio.Lock()
    return _lock


# ffmpeg's I/O timeout on the socket. A mesh unit re-parenting through
# another node can go quiet for tens of seconds; with the stock 5 s the reader
# ended, its subscribers saw 0 kbit/s, and the dead reader still held the
# port so the next open failed with "Invalid data found".
QUIET_TOLERANCE_S = 60.0


def _open_with_retry(port: int, timeout: float):
    try:
        return open_air_unit_video(port=port, timeout=timeout)
    except Exception:
        time.sleep(0.6)   # a just-stopped reader releases its socket a beat later
        return open_air_unit_video(port=port, timeout=timeout)


async def acquire(port: int, timeout: float = QUIET_TOLERANCE_S):
    """A relay-subscribed track for this port, opening the shared reader on
    first use. Raises if the port cannot be opened."""
    async with _get_lock():
        f = _feeds.get(port)
        if f is not None and f["track"].readyState == "ended":
            # Stop the dead reader FIRST so it lets go of the socket.
            _feeds.pop(port, None)
            try:
                await asyncio.get_event_loop().run_in_executor(None, f["track"].stop)
            except Exception:
                pass
            logger.info(f"Feed reader on udp:{port} had ended - reopening")
            f = None
        if f is None:
            track = await asyncio.get_event_loop().run_in_executor(
                None, functools.partial(_open_with_retry, port, timeout))
            f = _feeds[port] = {"track": track, "relay": MediaRelay(), "refs": 0}
            logger.info(f"Feed reader opened on udp:{port}")
        f["refs"] += 1
        return f["relay"].subscribe(f["track"])


async def release(port: int) -> None:
    async with _get_lock():
        f = _feeds.get(port)
        if f is None:
            return
        f["refs"] -= 1
        if f["refs"] <= 0:
            _feeds.pop(port, None)
            try:
                await asyncio.get_event_loop().run_in_executor(None, f["track"].stop)
            except Exception:
                pass
            logger.info(f"Feed reader closed on udp:{port}")


def open_ports() -> list[int]:
    return sorted(_feeds)
