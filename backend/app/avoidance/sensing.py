"""Background obstacle sensing - the drone's eyes, independent of the AI tab.

Avoidance is a flight-safety function tied to the Avoidance toggle, not to
what the operator happens to be looking at. Until now the metric depth model
only ran when the session's AI mode was "Depth mapping", so a pilot flying a
mission from the Fly/Mission tab (manual-control mode, the common case) had
avoidance enabled and a camera streaming - and the aircraft flew blind.

This module runs the same depth module on the session's frames in the
background whenever the session's drone has avoidance enabled and the
operator is NOT already in Depth mapping (which feeds the loop itself). It
takes at most SENSE_HZ frames per second per session, never queues (a frame
arriving while inference is busy is dropped), and runs on its own thread so
the video path never waits. Observations go to loop.observe_from_session
exactly as they do from the Depth mapping mode.
"""
from __future__ import annotations

import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

logger = logging.getLogger("verocore.avoidance.sensing")

SENSE_HZ = 5.0            # 4 m/s -> a frame every 0.8 m; the model does 33 ms

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="avoid-sense")
_depth = None             # lazily built DepthMapper (the same module Depth mapping uses)
_depth_failed = False
_last_at: dict[str, float] = {}
_busy: set[str] = set()
_announced: set[str] = set()


def wants_frame(session_id: str, mode_value: str | None) -> bool:
    """Should this session's next frame go through the sensor? Cheap: a dict
    lookup and a controller check, so it is safe to call per frame."""
    if _depth_failed or mode_value == "depth-mapping":
        return False
    from app.avoidance import service as avoidance
    if not avoidance.any_enabled():
        return False
    from app.avoidance import loop as av_loop
    if av_loop._controller_for_session(session_id) is None:
        return False
    if session_id in _busy:
        return False
    now = time.monotonic()
    if now - _last_at.get(session_id, 0.0) < 1.0 / SENSE_HZ:
        return False
    _last_at[session_id] = now
    return True


def _analyze(img_bgr: np.ndarray) -> list | None:
    global _depth, _depth_failed
    if _depth is None:
        from app.vision.modules.depth_mapper import DepthMapper
        try:
            _depth = DepthMapper()
        except Exception as e:
            _depth_failed = True
            logger.error(f"Background obstacle sensing unavailable - depth model failed to load: {e}")
            return None
    _, meta = _depth._analyze_frame_blocking(img_bgr)
    return meta.get("obstacle_observations")


def submit(session_id: str, img_bgr: np.ndarray) -> None:
    """Hand one BGR frame to the sensor. Returns immediately; the result is
    forwarded to the avoidance loop from the executor's completion."""
    _busy.add(session_id)
    captured_at = time.monotonic()
    loop = asyncio.get_running_loop()
    fut = loop.run_in_executor(_executor, _analyze, img_bgr)

    def _done(f):
        _busy.discard(session_id)
        try:
            obs = f.result()
        except Exception as e:
            logger.debug(f"obstacle sensing frame failed: {e}")
            return
        if session_id not in _announced:
            _announced.add(session_id)
            logger.info(f"Background obstacle sensing active for session {session_id[:8]} "
                        f"(~{SENSE_HZ:.0f} fps, independent of the AI mode)")
        # A processed frame IS the camera feeding, whether or not it held an
        # obstacle and whatever the altitude. Marking freshness only when an
        # observation reached the controller made the pad read "NO VIDEO"
        # (the below-3 m gate drops everything there) - and the arm interlock
        # then refused every takeoff.
        from app.avoidance import loop as av_loop
        c = av_loop._controller_for_session(session_id)
        if c is not None:
            from app.avoidance import sensors as sensor_registry
            sensor_registry.mark_data(c.drone_id, "monocular")
        if obs:
            av_loop.observe_from_session(session_id, obs, captured_at=captured_at)

    fut.add_done_callback(_done)


def warm() -> None:
    """Load the depth model now (when avoidance is switched on) instead of on
    the first frame - the 2-3 s load happened 20 s into a mission once."""
    if _depth is None and not _depth_failed:
        _executor.submit(_analyze, np.zeros((480, 640, 3), np.uint8))
