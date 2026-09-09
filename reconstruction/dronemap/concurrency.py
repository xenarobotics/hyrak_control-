"""Thread plumbing: drop-oldest queues, worker stages, and latency accounting.

The whole pipeline is built on one rule: **a slow consumer must never stall the
producer.** A network video stream cannot be back-pressured -- if we stop
draining the socket, the decoder desynchronises and we lose far more than the
frames we were trying to protect. So every inter-stage link is a bounded queue
that discards its oldest item when full, and the number of discards is counted
and reported rather than silently swallowed.

The one exception is the fusion queue, which is lossless: dropping a keyframe
there would punch a permanent hole in the reconstruction.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Generic, Optional, TypeVar

log = logging.getLogger(__name__)

T = TypeVar("T")


class DropOldestQueue(Generic[T]):
    """Bounded queue that evicts the oldest entry instead of blocking the writer.

    ``lossless=True`` turns it into a normal blocking bounded queue, for links
    where dropping data is not acceptable.
    """

    def __init__(self, maxsize: int, name: str = "", lossless: bool = False) -> None:
        self._dq: deque[T] = deque()
        self._maxsize = maxsize
        self._name = name
        self._lossless = lossless
        self._lock = threading.Lock()
        self._not_empty = threading.Condition(self._lock)
        self._not_full = threading.Condition(self._lock)
        self._closed = False
        self.dropped = 0
        self.pushed = 0

    def put(self, item: T, timeout: Optional[float] = None) -> bool:
        """Enqueue. Returns False only if the queue is closed (or a lossless
        queue timed out)."""
        with self._not_full:
            if self._closed:
                return False
            if self._lossless:
                deadline = None if timeout is None else time.monotonic() + timeout
                while len(self._dq) >= self._maxsize and not self._closed:
                    remaining = None if deadline is None else deadline - time.monotonic()
                    if remaining is not None and remaining <= 0:
                        return False
                    self._not_full.wait(remaining)
                if self._closed:
                    return False
            elif len(self._dq) >= self._maxsize:
                self._dq.popleft()
                self.dropped += 1
            self._dq.append(item)
            self.pushed += 1
            self._not_empty.notify()
            return True

    def get(self, timeout: Optional[float] = None) -> Optional[T]:
        """Dequeue the oldest item, or None if closed/timed out."""
        with self._not_empty:
            deadline = None if timeout is None else time.monotonic() + timeout
            while not self._dq:
                if self._closed:
                    return None
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    return None
                self._not_empty.wait(remaining)
            item = self._dq.popleft()
            self._not_full.notify()
            return item

    def get_latest(self) -> Optional[T]:
        """Take the newest item and discard everything older.

        Used by the visualiser, which only ever wants the current state.
        """
        with self._not_empty:
            if not self._dq:
                return None
            item = self._dq.pop()
            self.dropped += len(self._dq)
            self._dq.clear()
            self._not_full.notify_all()
            return item

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._not_empty.notify_all()
            self._not_full.notify_all()

    def drain(self) -> list[T]:
        with self._lock:
            items = list(self._dq)
            self._dq.clear()
            self._not_full.notify_all()
            return items

    @property
    def full(self) -> bool:
        with self._lock:
            return len(self._dq) >= self._maxsize

    @property
    def maxsize(self) -> int:
        return self._maxsize

    @property
    def closed(self) -> bool:
        with self._lock:
            return self._closed

    def __len__(self) -> int:
        with self._lock:
            return len(self._dq)

    @property
    def stats(self) -> dict[str, Any]:
        with self._lock:
            return {
                "name": self._name,
                "depth": len(self._dq),
                "maxsize": self._maxsize,
                "pushed": self.pushed,
                "dropped": self.dropped,
            }


@dataclass
class StageStats:
    """Rolling latency/throughput accounting for one pipeline stage."""

    name: str
    window: int = 120
    _times: deque[float] = field(default_factory=lambda: deque(maxlen=120))
    _stamps: deque[float] = field(default_factory=lambda: deque(maxlen=120))
    count: int = 0
    errors: int = 0

    def record(self, elapsed_s: float) -> None:
        self._times.append(elapsed_s)
        self._stamps.append(time.monotonic())
        self.count += 1

    @property
    def fps(self) -> float:
        """Throughput measured from wall-clock arrival, not 1/latency.

        These differ whenever a stage is idle waiting on input, and the arrival
        rate is the number that actually matters for keeping up with the stream.
        """
        if len(self._stamps) < 2:
            return 0.0
        span = self._stamps[-1] - self._stamps[0]
        return (len(self._stamps) - 1) / span if span > 1e-9 else 0.0

    def _pct(self, q: float) -> float:
        if not self._times:
            return 0.0
        s = sorted(self._times)
        idx = min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))
        return s[idx] * 1000.0

    @property
    def ms_mean(self) -> float:
        return (sum(self._times) / len(self._times) * 1000.0) if self._times else 0.0

    @property
    def ms_p50(self) -> float:
        return self._pct(0.50)

    @property
    def ms_p95(self) -> float:
        return self._pct(0.95)

    def summary(self) -> dict[str, Any]:
        return {
            "stage": self.name,
            "count": self.count,
            "errors": self.errors,
            "fps": round(self.fps, 2),
            "ms_mean": round(self.ms_mean, 2),
            "ms_p50": round(self.ms_p50, 2),
            "ms_p95": round(self.ms_p95, 2),
        }


class Stage(threading.Thread):
    """A pipeline thread: pull from an input queue, process, push downstream.

    Exceptions in ``process`` are counted and logged but never kill the thread --
    a single corrupt frame must not take down a live mapping session.
    """

    def __init__(
        self,
        name: str,
        fn: Callable[[Any], Any],
        inq: Optional[DropOldestQueue] = None,
        outq: Optional[DropOldestQueue] = None,
        on_error: Optional[Callable[[BaseException], None]] = None,
        poll_timeout: float = 0.25,
    ) -> None:
        super().__init__(name=name, daemon=True)
        self._fn = fn
        self._inq = inq
        self._outq = outq
        self._on_error = on_error
        self._poll = poll_timeout
        # NOT `_stop`: threading.Thread already defines a private `_stop()`
        # method that join() calls internally, and shadowing it with an Event
        # makes every join raise "'Event' object is not callable".
        self._stop_event = threading.Event()
        self.stats = StageStats(name)
        #: True while an item is being processed. Shutdown drains wait on
        #: "queue empty AND not busy" -- queue length alone misses the item
        #: currently in flight, which then gets pushed to an already-closed
        #: downstream queue and silently dropped.
        self.busy = False

    def run(self) -> None:
        log.debug("stage %s started", self.name)
        while not self._stop_event.is_set():
            try:
                item = None
                if self._inq is not None:
                    item = self._inq.get(timeout=self._poll)
                    if item is None:
                        if self._inq.closed and len(self._inq) == 0:
                            break
                        continue
                self.busy = True
                try:
                    t0 = time.perf_counter()
                    result = self._fn(item)
                    self.stats.record(time.perf_counter() - t0)
                    if result is not None and self._outq is not None:
                        self._outq.put(result)
                finally:
                    self.busy = False
            except Exception as exc:  # noqa: BLE001 - stage must survive bad data
                self.stats.errors += 1
                log.exception("stage %s error: %s", self.name, exc)
                if self._on_error is not None:
                    try:
                        self._on_error(exc)
                    except Exception:  # noqa: BLE001
                        log.exception("error handler for %s raised", self.name)
        if self._outq is not None:
            self._outq.close()
        log.debug("stage %s stopped", self.name)

    def stop(self) -> None:
        self._stop_event.set()

    @property
    def stopping(self) -> bool:
        return self._stop_event.is_set()


class RateLimiter:
    """Sleep just enough to hold a target rate, without accumulating drift."""

    def __init__(self, hz: float) -> None:
        self.period = 1.0 / hz if hz > 0 else 0.0
        self._next = time.monotonic()

    def wait(self) -> None:
        if self.period <= 0:
            return
        now = time.monotonic()
        self._next += self.period
        if self._next < now:
            # We fell behind; resync rather than sprinting to catch up.
            self._next = now
            return
        time.sleep(self._next - now)
