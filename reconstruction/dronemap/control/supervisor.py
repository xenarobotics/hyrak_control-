"""Panel-driven session supervisor.

``dronemap run`` executes one session and exits — the right shape for a drone
mission started from a script, but wrong for an operator at a browser who
wants to start and stop reconstructions repeatedly. ``run --serve`` hands the
process to this supervisor instead: the control server (and its panel at
``/``) stays up forever, and each Start builds a *fresh* ``DroneMapApp``, so
no map, queue, or statistic can leak from one session into the next.
"""

from __future__ import annotations

import logging
import threading
import time
from types import SimpleNamespace
from typing import Optional

log = logging.getLogger(__name__)


class _IdleLifecycle:
    """Stands in for a session lifecycle when no session exists yet."""

    running = False
    active = False
    info = SimpleNamespace(state=SimpleNamespace(value="idle"), error="")

    def request_stop(self, reason: str = "idle") -> None:  # noqa: ARG002
        log.info("stop requested but no session is running")


_IDLE_STATUS = {
    "state": "idle", "uptime_s": 0.0, "stop_reason": "", "error": "",
    "frames": 0, "keyframes": 0, "landmarks": 0, "tracking_state": "-",
}


class Supervisor:
    """Owns the control server; delegates everything else to the live app."""

    def __init__(self, cfg) -> None:
        from pathlib import Path

        from .jobs import ScanManager

        self.cfg = cfg
        self.app = None
        self._lock = threading.Lock()
        self._idle = _IdleLifecycle()
        self.scans = ScanManager(Path(cfg.control.data_root) / "photogrammetry",
                                 sessions_root=Path(cfg.export.output_dir))

    # -- the surface ControlServer expects from an app --------------------

    @property
    def lifecycle(self):
        return self.app.lifecycle if self.app is not None else self._idle

    @property
    def latest_frame_jpeg(self):
        return getattr(self.app, "latest_frame_jpeg", None)

    @property
    def latest_depth_jpeg(self):
        return getattr(self.app, "latest_depth_jpeg", None)

    def trajectory(self) -> dict:
        if self.app is None:
            return {"traj": [], "last_T": None}
        return self.app.trajectory()

    def status(self) -> dict:
        return self.app.status() if self.app is not None else dict(_IDLE_STATUS)

    def metrics(self) -> dict:
        if self.app is None:
            return {"session": dict(_IDLE_STATUS)}
        return self.app.metrics()

    def request_start(self, device: str | None = None) -> None:
        with self._lock:
            # Gate on `active`, not `running`: running is False all through
            # STARTING, so two quick Start clicks used to build two pipelines
            # fighting over the camera, with the loser never stopped.
            if self.app is not None and self.app.lifecycle.active:
                raise RuntimeError(
                    "a session is already "
                    f"{self.app.lifecycle.info.state.value}")
            from ..app import DroneMapApp

            cfg = self.cfg.model_copy(deep=True)
            if device:
                cfg.source.uri = device
                cfg.source.kind = "v4l2"
            # The supervisor's server is the only server; a second one would
            # fight for the port.
            cfg.control.enabled = False
            self.app = DroneMapApp(cfg)
            threading.Thread(target=self.app.run, name="session",
                             daemon=True).start()
            log.info("session started from the panel")

    def export_now(self) -> dict:
        if self.app is None:
            raise RuntimeError("no session has been started yet")
        return self.app.export_now()

    def preview_points(self, max_points: int):
        if self.app is None:
            raise RuntimeError("no session has been started yet")
        return self.app.preview_points(max_points)

    # -- entry point ------------------------------------------------------

    def serve_forever(self) -> Optional[dict]:
        from .server import ControlServer

        server = ControlServer(self, self.cfg.control.host, self.cfg.control.port)
        server.start()
        if not server.available:
            raise RuntimeError(
                f"control server could not start on "
                f"{self.cfg.control.host}:{self.cfg.control.port} -- port "
                "already in use, or fastapi/uvicorn not installed "
                "(pip install 'dronemap[serve]')")
        log.info("panel ready at http://%s:%d/ — press Start there "
                 "(Ctrl-C here to quit)", self.cfg.control.host, self.cfg.control.port)
        try:
            while True:
                time.sleep(0.5)
        except KeyboardInterrupt:
            log.info("shutting down")
            if self.app is not None and self.app.lifecycle.running:
                self.app.lifecycle.request_stop("keyboard_interrupt")
                # give the session a moment to export before the process dies
                for _ in range(1200):
                    if not self.app.lifecycle.running:
                        break
                    time.sleep(0.1)
        finally:
            server.stop()
        return None
