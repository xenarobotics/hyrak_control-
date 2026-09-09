"""Background job for the offline photogrammetry scan.

One job at a time: it owns the camera while recording and the GPU while
densifying, so concurrency would only produce two broken results. Status is a
plain dict the panel polls.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)


class ScanJob:
    def __init__(self, out_dir: Path, *, device: str = "", seconds: int = 0,
                 session_images: Optional[Path] = None) -> None:
        self.out_dir = out_dir
        self.device = device
        self.seconds = seconds
        self.session_images = session_images
        self.status: dict = {"state": "running", "phase": "starting",
                             "detail": "", "started": time.time(),
                             "dir": str(self.out_dir)}
        self._thread = threading.Thread(target=self._run, name="scan", daemon=True)

    def start(self) -> None:
        self._thread.start()

    @property
    def running(self) -> bool:
        return self._thread.is_alive()

    def _progress(self, phase: str, detail: str) -> None:
        self.status["phase"] = phase
        self.status["detail"] = detail

    def _run(self) -> None:
        from ..offline import full_scan, scan_from_images

        try:
            if self.session_images is not None:
                result = scan_from_images(self.session_images, self.out_dir,
                                          progress=self._progress)
            else:
                result = full_scan(self.device, self.seconds, self.out_dir,
                                   progress=self._progress)
            self.status.update(state="done", phase="done", detail="",
                               result=result,
                               elapsed=round(time.time() - self.status["started"], 1))
        except Exception as exc:  # noqa: BLE001
            log.exception("scan failed")
            self.status.update(state="failed", phase="failed", detail=str(exc))


class ScanManager:
    def __init__(self, out_root: Path = Path("data/photogrammetry"),
                 sessions_root: Path = Path("data/sessions")) -> None:
        self.out_root = out_root
        self.sessions_root = sessions_root
        self.job: Optional[ScanJob] = None

    def _launch(self, job: ScanJob) -> dict:
        if self.job is not None and self.job.running:
            raise RuntimeError("a scan is already running")
        self.job = job
        job.start()
        return job.status

    def start_record(self, device: str, seconds: int) -> dict:
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        return self._launch(ScanJob(self.out_root / f"scan_{stamp}",
                                    device=device, seconds=seconds))

    def start_session(self, name: str) -> dict:
        if "/" in name or name.startswith("."):
            raise RuntimeError("invalid session name")
        imgs = self.sessions_root / name / "keyframes" / "images"
        if not imgs.is_dir():
            raise FileNotFoundError(
                f"session {name} has no stored keyframes to process")
        return self._launch(ScanJob(self.out_root / name,
                                    session_images=imgs))

    def status(self) -> dict:
        if self.job is None:
            return {"state": "idle"}
        st = dict(self.job.status)
        if st.get("state") == "running":
            st["elapsed"] = round(time.time() - st["started"], 1)
        return st
