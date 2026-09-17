"""Event-loop stall detector - evidence for the "backend hangs" reports.

A hung backend answers nothing (curl -> 000) and leaves no trace of WHAT it
was doing, so every hang so far was fixed by restarting it, never by fixing
it. This watches the loop from a plain thread: an asyncio task stamps a
heartbeat every 0.5 s; if the stamp goes stale for more than STALL_S the
thread dumps the loop thread's live stack to the log, and again every
REPEAT_S while it stays stuck. That stack names the blocking call.

Zero cost while healthy (one timestamp write per 0.5 s). Nothing here can
itself block the loop - the watcher never touches asyncio.
"""
from __future__ import annotations

import asyncio
import logging
import sys
import threading
import time
import traceback

logger = logging.getLogger("verocore.loop_stall")

STALL_S = 3.0     # a loop that misses 6 heartbeats is stuck, not busy
REPEAT_S = 10.0   # keep dumping while stuck so a long hang shows its phases

_beat = 0.0
_loop_thread_id: int | None = None
_task: asyncio.Task | None = None
_thread: threading.Thread | None = None


async def _heartbeat() -> None:
    global _beat, _loop_thread_id
    _loop_thread_id = threading.get_ident()
    while True:
        _beat = time.monotonic()
        await asyncio.sleep(0.5)


def _watch() -> None:
    stalled_since: float | None = None
    last_dump = 0.0
    while True:
        time.sleep(1.0)
        if not _beat or _loop_thread_id is None:
            continue
        age = time.monotonic() - _beat
        if age > STALL_S:
            now = time.monotonic()
            if stalled_since is None:
                stalled_since = _beat
            if now - last_dump >= REPEAT_S:
                last_dump = now
                frame = sys._current_frames().get(_loop_thread_id)
                stack = "".join(traceback.format_stack(frame)) if frame else "<loop thread frame unavailable>"
                logger.error(
                    f"EVENT LOOP STALLED {age:.1f}s - the loop thread is blocked here:\n{stack}")
        elif stalled_since is not None:
            logger.warning(f"Event loop recovered after {time.monotonic() - stalled_since:.1f}s stall")
            stalled_since = None
            last_dump = 0.0


def start() -> None:
    global _task, _thread
    if _task is None or _task.done():
        _task = asyncio.get_event_loop().create_task(_heartbeat(), name="loop_stall_heartbeat")
    if _thread is None:
        _thread = threading.Thread(target=_watch, name="loop-stall-watch", daemon=True)
        _thread.start()
        logger.info(f"Event-loop stall detector armed (>{STALL_S:.0f}s dumps the loop stack)")
