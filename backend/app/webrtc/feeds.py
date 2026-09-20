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


async def acquire(port: int, timeout: float = 5.0):
    """A relay-subscribed track for this port, opening the shared reader on
    first use. Raises if the port cannot be opened."""
    async with _get_lock():
        f = _feeds.get(port)
        if f is None or f["track"].readyState == "ended":
            track = await asyncio.get_event_loop().run_in_executor(
                None, functools.partial(open_air_unit_video, port=port, timeout=timeout))
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
