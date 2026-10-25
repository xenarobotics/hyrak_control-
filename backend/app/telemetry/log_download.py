"""Config > Logs: the flight controller's ULog files, as in QGroundControl's
Log Download page (MAVSDK `log_files` plugin: LOG_REQUEST_LIST / LOG_DATA).

  list      entries on the SD card (id, date, size)
  download  one log at a time per drone. The server pulls it from the
            aircraft into a fresh folder under <hyrak_data_dir>/log_downloads,
            reports progress, then hands the browser a one-time link
            (/api/logs/file/<token>) bound to the account that asked. The
            file is streamed from disk and deleted once sent, or when the
            link runs out unused.
  erase     every log on the card, disarmed and on the ground only.

Nothing here takes a path from the client: the folder and file name are
made on the server, and a token names exactly one of them.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
import shutil
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger("verocore.log_download")

MAX_LOG_BYTES = 2 * 1024 ** 3          # refuse anything bigger than 2 GiB
FREE_SPACE_MARGIN = 1024 ** 3          # keep 1 GiB free on the data disk
TOKEN_TTL_S = 600.0                    # an unused download link lasts 10 min
STALE_DIR_S = 3600.0                   # leftovers from a crash, swept on use
LIST_TIMEOUT_S = 30.0
ERASE_TIMEOUT_S = 20.0
STALL_TIMEOUT_S = 30.0                 # no progress for this long = give up


def base_dir() -> Path:
    from app.config import get_settings
    return Path(get_settings().hyrak_data_dir) / "log_downloads"


def entry_dict(e) -> dict:
    return {"id": int(e.id), "date": str(getattr(e, "date", "") or ""), "size_bytes": int(getattr(e, "size_bytes", 0) or 0)}


def busy_refusal(tel) -> str | None:
    """Why a download or erase may not run now (armed, in the air, Offboard,
    no link), or None. Listing is always allowed."""
    from app.telemetry import actuator_control
    why = actuator_control.refusal(tel)
    if why and why.startswith("Disarm first"):
        return "Disarm first. Logs are downloaded and erased on the ground only"
    return why


@dataclass
class Job:
    key: int
    log_id: int
    size: int
    folder: Path
    file: Path
    session_id: str
    user_id: str
    started: float = field(default_factory=time.monotonic)
    progress: float = 0.0
    task: asyncio.Task | None = None
    entry: object = None


@dataclass
class Ready:
    file: Path
    folder: Path
    user_id: str
    session_id: str
    name: str
    expires: float


class LogDownloads:
    """Per-process registry: running downloads (one per telemetry link) and
    finished files waiting for the browser."""

    def __init__(self):
        self.jobs: dict[int, Job] = {}
        self.ready: dict[str, Ready] = {}
        self._swept = False

    # ── housekeeping ───────────────────────────────────────────────────
    def sweep(self, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        for tok in [t for t, r in self.ready.items() if r.expires <= now]:
            self._drop(self.ready.pop(tok))
        if not self._swept:
            self._swept = True
            root = base_dir()
            if root.is_dir():
                cutoff = time.time() - STALE_DIR_S
                for d in root.iterdir():
                    try:
                        if d.is_dir() and d.stat().st_mtime < cutoff:
                            shutil.rmtree(d, ignore_errors=True)
                    except OSError:
                        pass

    @staticmethod
    def _drop(r) -> None:
        shutil.rmtree(r.folder, ignore_errors=True)

    def cancel(self, key: int) -> bool:
        job = self.jobs.get(key)
        if job is None or job.task is None or job.task.done():
            return False
        job.task.cancel()
        return True

    # ── download ───────────────────────────────────────────────────────
    def preflight(self, tel, key: int, log_id, size) -> str | None:
        why = busy_refusal(tel)
        if why:
            return why
        job = self.jobs.get(key)
        if job is not None and job.task is not None and not job.task.done():
            return f"Log {job.log_id} is still downloading. Wait for it or cancel it first"
        try:
            size = int(size)
        except (TypeError, ValueError):
            return "Unknown log size"
        if size <= 0:
            return "That log is empty"
        if size > MAX_LOG_BYTES:
            return f"That log is {size / 1024 ** 3:.1f} GB; HYRAK downloads logs up to 2 GB. Copy it off the SD card instead"
        root = base_dir()
        root.mkdir(parents=True, exist_ok=True)
        try:
            free = shutil.disk_usage(root).free
        except OSError:
            free = 0
        if free < size + FREE_SPACE_MARGIN:
            return "The server is short of disk space for this log. Try again later"
        return None

    async def run(self, tel, job: Job, emit) -> None:
        """Pull one log into job.file, calling `emit(event, payload)` with
        progress and the result. Always leaves nothing behind on failure."""
        entry = job.entry
        last_emit = 0.0
        ok = False
        try:
            gen = tel._drone.log_files.download_log_file(entry, str(job.file))
            it = gen.__aiter__()
            while True:
                try:
                    p = await asyncio.wait_for(it.__anext__(), timeout=STALL_TIMEOUT_S)
                except StopAsyncIteration:
                    break
                job.progress = max(0.0, min(1.0, float(getattr(p, "progress", 0.0) or 0.0)))
                now = time.monotonic()
                if now - last_emit >= 0.25:
                    last_emit = now
                    await emit("log_progress", {"id": job.log_id, "progress": job.progress,
                                                "bytes": int(job.progress * job.size)})
                if job.file.exists() and job.file.stat().st_size > MAX_LOG_BYTES:
                    raise RuntimeError("the file grew past the 2 GB limit")
            if not job.file.is_file():
                raise RuntimeError("the drone sent no data")
            got = job.file.stat().st_size
            if got > MAX_LOG_BYTES:
                raise RuntimeError("the file grew past the 2 GB limit")
            token = secrets.token_urlsafe(32)
            self.ready[token] = Ready(file=job.file, folder=job.folder, user_id=job.user_id,
                                      session_id=job.session_id, name=f"log_{job.log_id}.ulg",
                                      expires=time.monotonic() + TOKEN_TTL_S)
            ok = True
            await emit("log_ready", {"id": job.log_id, "bytes": got, "path": f"/api/logs/file/{token}"})
        except asyncio.CancelledError:
            await emit("log_failed", {"id": job.log_id, "error": "Download cancelled", "cancelled": True})
        except asyncio.TimeoutError:
            await emit("log_failed", {"id": job.log_id, "error": "The drone stopped sending the log (no data for 30 s)"})
        except Exception as e:
            logger.info(f"log {job.log_id} download failed: {e}")
            await emit("log_failed", {"id": job.log_id, "error": f"Download failed: {e}"})
        finally:
            if not ok:
                shutil.rmtree(job.folder, ignore_errors=True)
            if self.jobs.get(job.key) is job:
                self.jobs.pop(job.key, None)

    def start(self, tel, key: int, entry, session_id: str, user_id: str, emit) -> Job:
        """`entry` is the drone's own list entry (never built from client
        input), so the id exists and the size is the drone's."""
        self.sweep()
        log_id, size = int(entry.id), int(entry.size_bytes)
        root = base_dir()
        root.mkdir(parents=True, exist_ok=True)
        folder = Path(tempfile.mkdtemp(prefix="log_", dir=root))
        job = Job(key=key, log_id=int(log_id), size=int(size), folder=folder,
                  file=folder / f"log_{log_id}.ulg", session_id=session_id, user_id=user_id,
                  entry=entry)
        self.jobs[key] = job
        job.task = asyncio.create_task(self.run(tel, job, emit), name=f"log_download_{log_id}")
        return job

    # ── serving ────────────────────────────────────────────────────────
    def claim(self, token: str, user_id: str) -> Ready | None:
        """The file behind a one-time token, for this user only. Removes the
        token, so a second request finds nothing."""
        self.sweep()
        if not isinstance(token, str) or len(token) > 128:
            return None
        r = self.ready.get(token)
        if r is None or r.user_id != user_id:
            return None
        self.ready.pop(token, None)
        try:
            root = base_dir().resolve()
            if root not in r.file.resolve().parents or not r.file.is_file():
                self._drop(r)
                return None
        except OSError:
            return None
        return r

    def release(self, r: Ready) -> None:
        self._drop(r)


downloads = LogDownloads()


async def entries(tel) -> list:
    return list(await asyncio.wait_for(tel._drone.log_files.get_entries(), timeout=LIST_TIMEOUT_S))


async def list_logs(tel) -> list[dict]:
    return sorted((entry_dict(e) for e in await entries(tel)), key=lambda d: d["id"], reverse=True)


async def erase_all(tel) -> None:
    await asyncio.wait_for(tel._drone.log_files.erase_all_log_files(), timeout=ERASE_TIMEOUT_S)
