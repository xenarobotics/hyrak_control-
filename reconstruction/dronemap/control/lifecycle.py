"""Session lifecycle: the state machine and its hooks.

Exposes the `on_stream_start` / `on_stream_stop` contract from the spec, as both
callable hooks and OS signal handlers, and guarantees the stop path runs exactly
once no matter how many ways it gets triggered -- SIGINT, an HTTP call, EOF and a
transport stall can easily arrive together, and a double export would race two
writers into the same directory.
"""

from __future__ import annotations

import enum
import logging
import signal
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

log = logging.getLogger(__name__)


class SessionState(enum.Enum):
    IDLE = "idle"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    EXPORTING = "exporting"
    FINISHED = "finished"
    FAILED = "failed"


@dataclass
class SessionInfo:
    state: SessionState = SessionState.IDLE
    started_at: Optional[float] = None
    stopped_at: Optional[float] = None
    stop_reason: str = ""
    error: str = ""
    export_manifest: dict = field(default_factory=dict)

    @property
    def uptime_s(self) -> float:
        if self.started_at is None:
            return 0.0
        end = self.stopped_at or time.monotonic()
        return end - self.started_at


class SessionLifecycle:
    """Coordinates start/stop across signals, HTTP and the pipeline itself."""

    def __init__(self) -> None:
        self.info = SessionInfo()
        self._lock = threading.RLock()
        self._stop_event = threading.Event()
        self._finished = threading.Event()
        self._start_hooks: list[Callable[[], None]] = []
        self._stop_hooks: list[Callable[[str], None]] = []
        self._stop_done = False
        self._original_handlers: dict[int, object] = {}

    # -- hook registration --------------------------------------------------

    def on_stream_start(self, fn: Callable[[], None]) -> Callable[[], None]:
        """Register a start hook. Usable as a decorator."""
        self._start_hooks.append(fn)
        return fn

    def on_stream_stop(self, fn: Callable[[str], None]) -> Callable[[str], None]:
        """Register a stop hook, called with the stop reason. Usable as a decorator."""
        self._stop_hooks.append(fn)
        return fn

    # -- transitions --------------------------------------------------------

    def start(self) -> bool:
        """Run the start hooks. Returns False when a stop request arrived
        before startup began -- the caller must then not run the session.

        The pre-check matters: clearing ``_stop_event`` unconditionally used to
        erase a /stop that raced the startup thread, and the session ran anyway.
        """
        with self._lock:
            if self.info.state in (SessionState.RUNNING, SessionState.STARTING):
                log.warning("session already running; ignoring start")
                return False
            if self._stop_event.is_set():
                log.info("stop was requested before startup; not starting")
                self.info.state = SessionState.FINISHED
                self._finished.set()
                return False
            self.info = SessionInfo(state=SessionState.STARTING,
                                    started_at=time.monotonic())
            self._finished.clear()
            self._stop_done = False

        log.info("=== stream start ===")
        for hook in self._start_hooks:
            try:
                hook()
            except Exception as exc:  # noqa: BLE001
                log.exception("start hook failed: %s", exc)
                with self._lock:
                    self.info.state = SessionState.FAILED
                    self.info.error = str(exc)
                raise
        with self._lock:
            self.info.state = SessionState.RUNNING
        return True

    def request_stop(self, reason: str = "requested") -> None:
        """Signal the pipeline to wind down. Safe from any thread or a handler."""
        with self._lock:
            if self._stop_event.is_set():
                return
            self.info.stop_reason = reason
        log.info("stop requested: %s", reason)
        self._stop_event.set()

    def run_stop(self, reason: Optional[str] = None) -> None:
        """Execute the stop hooks exactly once."""
        with self._lock:
            if self._stop_done:
                return
            self._stop_done = True
            reason = reason or self.info.stop_reason or "unknown"
            self.info.stop_reason = reason
            self.info.stopped_at = time.monotonic()
            self.info.state = SessionState.STOPPING

        log.info("=== stream stop (%s) after %.1fs ===", reason, self.info.uptime_s)
        for hook in self._stop_hooks:
            try:
                hook(reason)
            except Exception as exc:  # noqa: BLE001 - later hooks must still run
                log.exception("stop hook failed: %s", exc)
                with self._lock:
                    self.info.error = str(exc)
        with self._lock:
            if self.info.state is not SessionState.FAILED:
                self.info.state = SessionState.FINISHED
        self._finished.set()

    # -- signals ------------------------------------------------------------

    def install_signal_handlers(self) -> None:
        """SIGINT/SIGTERM request a graceful stop; a second one aborts.

        The escalation matters: export can take a while, and an operator who
        pressed Ctrl-C twice wants out now, not another wait.
        """
        def handler(signum, _frame):  # noqa: ANN001
            name = signal.Signals(signum).name
            if self._stop_event.is_set():
                log.warning("%s received again -- aborting immediately", name)
                raise KeyboardInterrupt(f"{name} (forced)")
            self.request_stop(f"signal:{name}")

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                self._original_handlers[sig] = signal.getsignal(sig)
                signal.signal(sig, handler)
            except (ValueError, OSError):
                # Not the main thread; the HTTP path still provides stop.
                log.debug("could not install handler for %s", sig)

    def restore_signal_handlers(self) -> None:
        for sig, original in self._original_handlers.items():
            try:
                signal.signal(sig, original)
            except (ValueError, OSError, TypeError):
                pass
        self._original_handlers.clear()

    # -- queries ------------------------------------------------------------

    @property
    def should_stop(self) -> bool:
        return self._stop_event.is_set()

    @property
    def running(self) -> bool:
        return self.info.state is SessionState.RUNNING

    @property
    def active(self) -> bool:
        """True in every state where starting another session must be refused.

        ``running`` is False during STARTING/STOPPING/EXPORTING, and gating a
        second /start on it opened a race: two clicks during startup built two
        pipelines fighting over the camera and the GPU.
        """
        return self.info.state in (SessionState.STARTING, SessionState.RUNNING,
                                   SessionState.STOPPING, SessionState.EXPORTING)

    def wait_for_stop(self, timeout: Optional[float] = None) -> bool:
        return self._stop_event.wait(timeout)

    def wait_finished(self, timeout: Optional[float] = None) -> bool:
        return self._finished.wait(timeout)

    def status(self) -> dict:
        with self._lock:
            return {
                "state": self.info.state.value,
                "uptime_s": round(self.info.uptime_s, 2),
                "stop_reason": self.info.stop_reason,
                "error": self.info.error,
            }
