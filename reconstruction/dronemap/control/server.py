"""HTTP control plane.

Deliberately small: start, stop, status, metrics, export. Enough for a ground
station or a supervising process to drive a session and watch its health,
without becoming a second interface to the whole system.

Runs uvicorn on a background thread so it never competes with the pipeline for
the main thread, and binds to loopback by default -- there is no authentication
here, so exposing it on a network is an explicit choice the operator makes.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable, Optional

# Module-level, not function-local: with `from __future__ import annotations`
# every annotation is a string that FastAPI resolves against THIS module's
# globals - a Request imported inside a function is invisible there, and the
# stream endpoints' `request: Request` silently became a required query
# parameter (every stream request 422'd). This module is itself imported
# lazily (app.py only pulls it when serving), so fastapi stays optional.
from fastapi import Request

log = logging.getLogger(__name__)


def _mjpeg_stream(get_jpeg, request):
    """Multipart MJPEG response that always serves the newest frame.

    Async, and it checks for client disconnect every frame: a sync
    ``while True`` generator here permanently occupied one anyio threadpool
    thread per viewer, so a handful of panel reloads starved every other
    endpoint. An async generator on the event loop costs nothing to idle and
    ends the moment the browser goes away.
    """
    import asyncio

    from fastapi.responses import StreamingResponse

    async def gen():
        placeholder = None
        while not await request.is_disconnected():
            buf = get_jpeg()
            if buf is None:
                buf = placeholder
            if buf is not None:
                yield (b"--frame\r\nContent-Type: image/jpeg\r\n"
                       b"Content-Length: " + str(len(buf)).encode() + b"\r\n\r\n"
                       + buf + b"\r\n")
                placeholder = buf
            await asyncio.sleep(0.12)

    return StreamingResponse(gen(),
                             media_type="multipart/x-mixed-replace; boundary=frame")


class ControlServer:
    def __init__(self, app_ref: Any, host: str = "127.0.0.1", port: int = 8088) -> None:
        self.app_ref = app_ref
        self.host = host
        self.port = port
        self._thread: Optional[threading.Thread] = None
        self._server = None
        self.available = False
        self._build()

    def _build(self) -> None:
        try:
            from fastapi import FastAPI, HTTPException
            from fastapi.responses import JSONResponse
        except ImportError:
            log.warning("fastapi not installed; control server disabled "
                        "(pip install 'dronemap[serve]')")
            return

        from pathlib import Path


        api = FastAPI(title="dronemap control", version="0.1.0")
        app = self.app_ref

        def _roots() -> tuple:
            """(sessions_root, photogrammetry_root), from config — never from
            the process cwd, which an embedding host does not control."""
            cfg = getattr(app, "cfg", None)
            if cfg is None:
                return Path("data/sessions"), Path("data/photogrammetry")
            return (Path(cfg.export.output_dir),
                    Path(cfg.control.data_root) / "photogrammetry")

        from fastapi.responses import HTMLResponse

        from .panel import PANEL_HTML

        @api.get("/", response_class=HTMLResponse)
        def panel() -> str:
            """Operator panel: status at a glance plus start/stop."""
            return PANEL_HTML

        @api.get("/health")
        def health() -> dict:
            return {"ok": True}

        @api.get("/status")
        def status() -> dict:
            return app.status()

        @api.get("/metrics")
        def metrics() -> dict:
            return app.metrics()

        @api.post("/start")
        def start(device: str = "") -> dict:
            # `active`, not `running`: running is False during STARTING, and a
            # second Start in that window used to build a second pipeline. The
            # supervisor re-checks under its lock; this is the fast path.
            if app.lifecycle.active:
                raise HTTPException(
                    409, f"session already {app.lifecycle.info.state.value}")
            scans = getattr(app, "scans", None)
            if scans is not None and scans.job is not None and scans.job.running:
                raise HTTPException(409, "an offline scan is using the camera")
            try:
                app.request_start(device=device or None)
            except RuntimeError as exc:
                raise HTTPException(409, str(exc)) from exc
            return {"ok": True, "state": app.lifecycle.info.state.value}

        @api.post("/stop")
        def stop(reason: str = "http") -> dict:
            app.lifecycle.request_stop(reason)
            return {"ok": True, "reason": reason}

        @api.post("/export")
        def export() -> dict:
            """Export the current map without ending the session."""
            try:
                return app.export_now()
            except RuntimeError as exc:
                # Not an error in the server -- the caller asked too early.
                raise HTTPException(409, str(exc)) from exc
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(500, str(exc)) from exc

        @api.get("/stream/video")
        async def stream_video(request: Request):
            return _mjpeg_stream(lambda: getattr(app, "latest_frame_jpeg", None),
                                 request)

        @api.get("/stream/depth")
        async def stream_depth(request: Request):
            return _mjpeg_stream(lambda: getattr(app, "latest_depth_jpeg", None),
                                 request)

        @api.get("/trajectory")
        def trajectory() -> dict:
            fn = getattr(app, "trajectory", None)
            return fn() if fn else {"traj": [], "last_T": None}

        @api.post("/viewer")
        def open_viewer() -> dict:
            """Open the full Rerun 3D viewer attached to the live stream."""
            import shutil
            import subprocess
            import sys
            from pathlib import Path as _P

            exe = shutil.which("rerun") or str(_P(sys.executable).parent / "rerun")
            if not _P(exe).exists():
                raise HTTPException(500, "rerun viewer binary not found")
            port = app.cfg.viz.serve_port if hasattr(app, "cfg") else 9876
            url = f"rerun+http://127.0.0.1:{port}/proxy"
            subprocess.Popen([exe, url], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL,
                             start_new_session=True)
            return {"ok": True, "url": url}

        @api.get("/devices")
        def devices() -> list:
            from ..offline import list_video_devices

            return list_video_devices()

        @api.post("/scan")
        def scan(device: str, seconds: int = 60) -> dict:
            """Record a fresh clip and reconstruct it."""
            mgr = getattr(app, "scans", None)
            if mgr is None:
                raise HTTPException(409, "offline scans need --serve mode")
            if app.lifecycle.running:
                raise HTTPException(409, "stop the live session first — it holds the camera")
            try:
                return mgr.start_record(device, seconds)
            except RuntimeError as exc:
                raise HTTPException(409, str(exc)) from exc

        @api.post("/scan_session")
        def scan_session(name: str) -> dict:
            """Photogrammetry over an existing live session's stored keyframes.
            Needs no camera, so it can run any time."""
            mgr = getattr(app, "scans", None)
            if mgr is None:
                raise HTTPException(409, "offline scans need --serve mode")
            try:
                return mgr.start_session(name)
            except (RuntimeError, FileNotFoundError) as exc:
                raise HTTPException(409, str(exc)) from exc

        @api.get("/sessions_scannable")
        def sessions_scannable() -> list:
            """Live sessions that stored keyframes and can be post-processed."""
            out = []
            root, _photo = _roots()
            try:
                if root.exists():
                    for d in sorted(root.iterdir(), reverse=True):
                        imgs = d / "keyframes" / "images"
                        if imgs.is_dir():
                            n = sum(1 for _ in imgs.iterdir())
                            if n >= 10:
                                out.append({"name": d.name, "frames": n})
            except OSError:
                # A directory removed mid-listing is a race, not an error.
                pass
            return out

        @api.get("/scan/status")
        def scan_status() -> dict:
            mgr = getattr(app, "scans", None)
            return mgr.status() if mgr else {"state": "unavailable"}

        @api.get("/results")
        def results() -> list:
            """Every session and scan on disk, newest first, with its files."""
            out = []
            sessions_root, photo_root = _roots()
            try:
                for root, kind in ((sessions_root, "live"),
                                   (photo_root, "offline")):
                    if not root.exists():
                        continue
                    for d in root.iterdir():
                        if not d.is_dir():
                            continue
                        files = [
                            {"name": f.name,
                             "size_mb": round(f.stat().st_size / 1e6, 1),
                             "path": str(f)}
                            for f in sorted(d.iterdir())
                            if f.is_file() and f.suffix in
                            (".ply", ".obj", ".glb", ".stl", ".mp4", ".txt", ".yaml")
                        ]
                        if files:
                            out.append({"name": d.name, "kind": kind,
                                        "mtime": d.stat().st_mtime, "files": files})
            except OSError:
                pass  # a result deleted mid-listing; return what we have
            out.sort(key=lambda r: r["mtime"], reverse=True)
            return out

        @api.get("/download")
        def download(path: str):
            from fastapi.responses import FileResponse
            f = Path(path).resolve()
            allowed = tuple(r.resolve() for r in _roots())
            # is_relative_to, not str.startswith: "data/sessions-evil" passes a
            # prefix check on "data/sessions" but is not under the directory.
            if not any(f.is_relative_to(a) for a in allowed) or not f.is_file():
                raise HTTPException(404, "not a downloadable result file")
            return FileResponse(f, filename=f.name)

        @api.get("/map/preview")
        def preview(max_points: int = 50000) -> dict:
            """Decimated surface points, for a lightweight remote preview."""
            try:
                xyz, rgb = app.preview_points(max_points)
            except RuntimeError:
                # No session yet -- an empty preview, not a 500.
                return JSONResponse({"n": 0, "xyz": [], "rgb": None})
            return JSONResponse({
                "n": len(xyz),
                "xyz": xyz.tolist(),
                "rgb": rgb.tolist() if rgb is not None else None,
            })

        self.api = api
        self.available = True

    def start(self) -> None:
        if not self.available:
            return
        try:
            import uvicorn
        except ImportError:
            log.warning("uvicorn not installed; control server disabled")
            self.available = False
            return

        config = uvicorn.Config(self.api, host=self.host, port=self.port,
                                log_level="warning", access_log=False)
        self._server = uvicorn.Server(config)
        self._thread = threading.Thread(target=self._server.run, name="control",
                                        daemon=True)
        self._thread.start()
        # Wait for the server to actually bind. Without this, a port conflict
        # kills the uvicorn thread silently while `available` stays True and
        # the supervisor announces a panel that does not exist.
        import time as _time
        deadline = _time.monotonic() + 10
        while _time.monotonic() < deadline:
            if self._server.started:
                break
            if not self._thread.is_alive():
                log.error("control server failed to start on %s:%d "
                          "(port already in use?)", self.host, self.port)
                self.available = False
                return
            _time.sleep(0.05)
        else:
            log.error("control server did not bind %s:%d within 10s",
                      self.host, self.port)
            self.available = False
            return
        log.info("control server on http://%s:%d  (/status /metrics /start /stop /export)",
                 self.host, self.port)

    def stop(self) -> None:
        if self._server is not None:
            self._server.should_exit = True
        if self._thread is not None:
            self._thread.join(timeout=5)
