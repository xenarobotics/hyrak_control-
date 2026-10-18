"""
Runner processes for running custom models (docs/custom_models/DESIGN.md
section 0, "Run").

One process per running model and workspace: the key is (workspace_id,
model_id, version). Every session of that workspace running that model
shares it; another workspace running the same catalogue model gets its own.

  * Frames go through a shared buffer file (/dev/shm when it exists): the
    analyzer writes the frame's pixels into it and sends ("infer", h, w, c,
    threshold, {tiling, classes}) over a socketpair; the answer is the decoded result. One
    request at a time per runner (a lock); each session's analyzer already
    keeps only its newest frame, so frames that arrive meanwhile are
    dropped there, not queued here.
  * Crash isolation: the runner is `python -I runner.py serve`, its own
    process group. A crash, an exit or an answer later than
    custom_models_infer_timeout_s kills it; the next frame restarts it
    after a backoff (1, 2, 4 ... 30 s). Five crashes inside five minutes
    and it stays down (`runner_failed`) until every session has left it.
  * Idle stop: when the last session releases it, it is stopped after
    custom_models_runner_idle_s unless a session takes it again first.
  * At most custom_models_max_runners run at once (`busy` otherwise).
  * Live settings: a PATCH of a model's sensitivity, shown classes, tiling
    or alert lands in `set_live` and the analyzers of the owning
    workspace read it on their next frame (no restart). Catalogue runs keep
    the published snapshot's settings.

Everything here is blocking and thread-safe: it is called from the
analyzer's executor thread (frames) and from the pool's load executor.
"""
from __future__ import annotations

import json
import logging
import mmap
import os
import signal
import socket
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Optional

import numpy as np

from app.config import get_settings
from app.models_custom import checks, storage
from app.models_custom.errors import ModelFailure

logger = logging.getLogger("verocore.models.runtime")

# Largest frame the shared buffer takes; bigger frames are scaled down by
# the analyzer first (the model resizes to its own input anyway).
MAX_W, MAX_H = 1920, 1088
SHM_SIZE = MAX_W * MAX_H * 3
BACKOFF_S = (1.0, 2.0, 4.0, 8.0, 16.0, 30.0)
CRASH_WINDOW_S = 300.0
MAX_CRASHES = 5


@dataclass
class RunSpec:
    """What a runner needs: the stored file and its inspect result."""
    workspace_id: str              # whose runner (the SESSION's workspace)
    model_id: str
    version: int
    model_path: str
    spec: dict                     # inspect info, labels included
    name: str = ""
    threshold: float = 0.25
    alert: Optional[dict] = None
    labels: list = field(default_factory=list)
    # Only these class names reach cv_results, counts and alerts (None: all).
    classes_shown: Optional[list] = None
    # Small objects: "off", "auto", "2x2" or "3x3" (runner.py tile_grid).
    tiling: str = "off"
    # sha256 of each file next to model_path, checked before every start.
    files: dict = field(default_factory=dict)
    # Run from the HYRAK catalogue's pinned copy (not the workspace's own).
    via_catalogue: bool = False

    @property
    def key(self) -> tuple:
        return (self.workspace_id, self.model_id, self.version,
                "catalogue" if self.via_catalogue else "own")


class RunnerError(Exception):
    def __init__(self, code: str, detail: str = "", retry_in: float = 0.0):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail
        self.retry_in = retry_in


def _shm_dir() -> Optional[str]:
    return "/dev/shm" if os.path.isdir("/dev/shm") and os.access("/dev/shm", os.W_OK) else None


class Runner:
    def __init__(self, spec: RunSpec):
        self.spec = spec
        self._lock = threading.Lock()
        self._proc: Optional[subprocess.Popen] = None
        self._conn: Optional[Connection] = None
        self._buf: Optional[mmap.mmap] = None
        self._buf_path: Optional[str] = None
        self.state = "stopped"          # stopped | ready | backoff | failed
        self.provider = ""
        self.crashes: list[float] = []
        self.next_start_at = 0.0
        self.last_error: Optional[RunnerError] = None
        self.started_at = 0.0
        self.frames = 0

    # lifecycle ------------------------------------------------------------
    def ensure_started(self) -> None:
        with self._lock:
            self._ensure_started_locked()

    def _ensure_started_locked(self) -> None:
        if self._proc is not None and self.state == "ready":
            code = self._proc.poll()
            if code is None:
                return
            # Died between frames: a crash like any other (backoff, count).
            self._crashed_locked("crashed", f"runner exited (code {code})")
        if self.state == "failed":
            raise self.last_error or RunnerError("runner_failed")
        now = time.monotonic()
        if now < self.next_start_at:
            raise RunnerError("restarting", "the model is restarting after a crash",
                              retry_in=self.next_start_at - now)
        self._teardown_locked()
        self._start_locked()

    def _start_locked(self) -> None:
        s = get_settings()
        # The file must still be the one that was checked (or published).
        bad = storage.verify_files(Path(self.spec.model_path).parent, self.spec.files)
        if not self.spec.files or bad:
            self.state = "failed"
            self.last_error = RunnerError("file_changed", ", ".join(bad) or "no recorded hash")
            logger.error(f"Runner {self.spec.model_id[:8]}: refused, files changed: {bad}")
            raise self.last_error
        fd, path = tempfile.mkstemp(prefix="hyrak-frame-", dir=_shm_dir())
        os.ftruncate(fd, SHM_SIZE)
        self._buf = mmap.mmap(fd, SHM_SIZE)
        os.close(fd)
        self._buf_path = path
        parent, child = socket.socketpair()
        req = {"model": self.spec.model_path, "spec": self.spec.spec,
               "use_gpu": bool(s.custom_models_use_gpu),
               "threads": int(s.custom_models_cpu_threads),
               "gpu_mem_mb": int(s.custom_models_gpu_mem_limit_mb),
               "shm": path, "shm_size": SHM_SIZE}
        try:
            self._proc = subprocess.Popen(
                checks.runner_command("serve", "--fd", str(child.fileno())),
                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                pass_fds=(child.fileno(),), env=checks.runner_env(),
                cwd=str(checks.RUNNER.parent), start_new_session=True)
        finally:
            child.close()
        self._conn = Connection(parent.detach())
        try:
            self._proc.stdin.write(json.dumps(req).encode())
            self._proc.stdin.close()
        except Exception:
            pass
        threading.Thread(target=self._drain_stderr, args=(self._proc,), daemon=True).start()
        timeout = float(s.custom_models_runner_start_timeout_s)
        if not self._conn.poll(timeout):
            self._crashed_locked("load_failed", f"did not start in {timeout:.0f} s")
        try:
            msg = self._conn.recv()
        except (EOFError, OSError) as e:
            self._crashed_locked("crashed", f"exited while loading ({e!r})")
        if msg[0] == "fatal":
            # A model that cannot load will not load on a retry either.
            self._teardown_locked()
            self.state = "failed"
            self.last_error = RunnerError(msg[1], msg[2] if len(msg) > 2 else "")
            raise self.last_error
        info = msg[1] if len(msg) > 1 else {}
        self.provider = info.get("provider", "")
        self.state = "ready"
        self.started_at = time.monotonic()
        logger.info(f"Runner {self.spec.name or self.spec.model_id[:8]} v{self.spec.version} "
                    f"for workspace {self.spec.workspace_id[:8]} up on {self.provider} "
                    f"(pid {self._proc.pid})")

    def _drain_stderr(self, proc) -> None:
        try:
            for line in proc.stderr:
                text = line.decode(errors="replace").rstrip()
                if text:
                    logger.debug(f"runner {proc.pid}: {text[:300]}")
        except Exception:
            pass

    def _crashed_locked(self, code: str, detail: str):
        now = time.monotonic()
        self.crashes = [t for t in self.crashes if now - t < CRASH_WINDOW_S] + [now]
        self._teardown_locked()
        if len(self.crashes) >= MAX_CRASHES:
            self.state = "failed"
            self.last_error = RunnerError("runner_failed", f"{len(self.crashes)} crashes: {detail}")
            logger.error(f"Runner {self.spec.model_id[:8]}: gave up ({detail})")
            raise self.last_error
        delay = BACKOFF_S[min(len(self.crashes) - 1, len(BACKOFF_S) - 1)]
        self.next_start_at = now + delay
        self.state = "backoff"
        self.last_error = RunnerError(code, detail, retry_in=delay)
        logger.warning(f"Runner {self.spec.model_id[:8]}: {code} ({detail}); restart in {delay:.0f} s")
        raise self.last_error

    def _teardown_locked(self) -> None:
        proc, self._proc = self._proc, None
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                if proc is not None and proc.poll() is None:
                    conn.send(("bye",))
            except Exception:
                pass
            try:
                conn.close()
            except Exception:
                pass
        if proc is not None:
            _kill(proc)
        if self._buf is not None:
            try:
                self._buf.close()
            except Exception:
                pass
            self._buf = None
        if self._buf_path:
            try:
                os.unlink(self._buf_path)
            except FileNotFoundError:
                pass
            self._buf_path = None
        if self.state == "ready":
            self.state = "stopped"

    def stop(self) -> None:
        with self._lock:
            self._teardown_locked()
            self.state = "stopped" if self.state != "failed" else "failed"

    @property
    def pid(self) -> Optional[int]:
        p = self._proc
        return p.pid if p is not None and p.poll() is None else None

    # frames ---------------------------------------------------------------
    def infer(self, frame_bgr, threshold: float, options: Optional[dict] = None) -> dict:
        """Run one frame (uint8 HxWx3, at most MAX_W x MAX_H). `options`:
        {"tiling", "classes": [class ids] | None}. Raises RunnerError on a
        crash, a timeout or while restarting."""
        h, w = frame_bgr.shape[:2]
        c = frame_bgr.shape[2] if frame_bgr.ndim == 3 else 1
        n = h * w * c
        if n > SHM_SIZE:
            raise RunnerError("run_failed", f"frame {w}x{h} larger than the buffer")
        with self._lock:
            self._ensure_started_locked()
            dst = np.frombuffer(self._buf, dtype=np.uint8, count=n)
            dst[:] = frame_bgr.reshape(-1)
            del dst                       # no view may outlive the buffer (close() refuses)
            try:
                self._conn.send(("infer", h, w, c, float(threshold), dict(options or {})))
                timeout = float(get_settings().custom_models_infer_timeout_s)
                if not self._conn.poll(timeout):
                    self._crashed_locked("timeout", f"no answer in {timeout:.0f} s")
                msg = self._conn.recv()
            except RunnerError:
                raise
            except (EOFError, OSError, BrokenPipeError) as e:
                code = self._proc.poll() if self._proc is not None else None
                self._crashed_locked("crashed", f"runner exited (code {code}, {e!r})")
            self.frames += 1
            if msg[0] == "ok":
                return msg[1]
            raise RunnerError(msg[1] if len(msg) > 1 else "run_failed",
                              msg[2] if len(msg) > 2 else "")


def _kill(proc: subprocess.Popen) -> None:
    """Our own child only, by its process group (it is the group leader)."""
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        proc.wait(timeout=3)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass


class RunnerPool:
    def __init__(self):
        self._lock = threading.Lock()
        self._runners: dict[tuple, Runner] = {}
        self._refs: dict[tuple, int] = {}
        self._timers: dict[tuple, threading.Timer] = {}

    def acquire(self, spec: RunSpec) -> Runner:
        with self._lock:
            key = spec.key
            t = self._timers.pop(key, None)
            if t is not None:
                t.cancel()
            r = self._runners.get(key)
            if r is None:
                limit = int(get_settings().custom_models_max_runners)
                if len(self._runners) >= limit:
                    raise RunnerError("busy", f"{len(self._runners)} of {limit} runners in use")
                r = self._runners[key] = Runner(spec)
            r.spec.labels = spec.labels or r.spec.labels
            self._refs[key] = self._refs.get(key, 0) + 1
            return r

    def release(self, spec_or_key) -> None:
        key = spec_or_key.key if isinstance(spec_or_key, RunSpec) else spec_or_key
        with self._lock:
            n = self._refs.get(key, 0) - 1
            if n > 0:
                self._refs[key] = n
                return
            self._refs.pop(key, None)
            r = self._runners.get(key)
            if r is None:
                return
            if r.state == "failed":
                # Nobody left on a runner that gave up: forget it, so the
                # next selection starts clean.
                self._runners.pop(key, None)
                threading.Thread(target=r.stop, daemon=True).start()
                return
            idle = float(get_settings().custom_models_runner_idle_s)
            t = threading.Timer(idle, self._idle_stop, args=(key, r))
            t.daemon = True
            self._timers[key] = t
            t.start()

    def _idle_stop(self, key, runner: Runner) -> None:
        with self._lock:
            if self._refs.get(key, 0) > 0 or self._runners.get(key) is not runner:
                return
            self._runners.pop(key, None)
            self._timers.pop(key, None)
        logger.info(f"Runner {runner.spec.model_id[:8]} v{runner.spec.version}: idle, stopped")
        runner.stop()

    def stop_model(self, model_id: str) -> list[tuple]:
        """Stop every runner of a model now (it was deleted or replaced)."""
        with self._lock:
            keys = [k for k in self._runners if k[1] == model_id]
            runners = [self._runners.pop(k) for k in keys]
            for k in keys:
                t = self._timers.pop(k, None)
                if t is not None:
                    t.cancel()
                self._refs.pop(k, None)
        for r in runners:
            r.stop()
        return keys

    def stop_all(self) -> None:
        with self._lock:
            runners = list(self._runners.values())
            for t in self._timers.values():
                t.cancel()
            self._runners.clear()
            self._refs.clear()
            self._timers.clear()
        for r in runners:
            r.stop()

    def get(self, key) -> Optional[Runner]:
        return self._runners.get(key)

    def status(self) -> list[dict]:
        with self._lock:
            return [{"workspace_id": k[0], "model_id": k[1], "version": k[2], "via": k[3],
                     "sessions": self._refs.get(k, 0), "state": r.state, "pid": r.pid,
                     "provider": r.provider, "frames": r.frames}
                    for k, r in self._runners.items()]


_pool = RunnerPool()

# model id -> the owning workspace's current run settings (threshold,
# classes_shown, tiling, alert), set by a PATCH, read by analyzers per frame.
_live: dict[str, dict] = {}


def set_live(model_id: str, settings: Optional[dict]) -> None:
    if settings is None:
        _live.pop(model_id, None)
    else:
        _live[model_id] = dict(settings)


def live(model_id: str) -> Optional[dict]:
    return _live.get(model_id)


def pool() -> RunnerPool:
    return _pool


def as_failure(e: RunnerError) -> ModelFailure:
    code = {"restarting": "runner_failed", "crashed": "runner_failed"}.get(e.code, e.code)
    return ModelFailure(code, e.detail)

