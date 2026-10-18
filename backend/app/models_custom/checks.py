"""
Inspect and test a stored model version, each in a fresh runner process.

`python -I runner.py inspect|test` with the request on stdin and one JSON
line back on stdout. A model that crashes onnxruntime, eats all memory or
hangs ends that process (killed at the timeout), never the backend; the
outcome is always a result or a ModelFailure with a code from the error
table. At most `custom_models_parallel_checks` run at once.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import os
import sys
from pathlib import Path

from app.config import get_settings
from app.models_custom.errors import ModelFailure

logger = logging.getLogger("verocore.models.checks")

RUNNER = Path(__file__).with_name("runner.py")
SAMPLES = Path(__file__).with_name("samples")

_gate: asyncio.Semaphore | None = None
_gate_size = 0


def _semaphore() -> asyncio.Semaphore:
    global _gate, _gate_size
    n = max(1, int(get_settings().custom_models_parallel_checks))
    if _gate is None or _gate_size != n:
        _gate, _gate_size = asyncio.Semaphore(n), n
    return _gate


def runner_command(mode: str, *extra: str) -> list[str]:
    # -I: no PYTHONPATH, no user site, not even the script's own folder on
    # sys.path. The runner imports only numpy, cv2 and onnxruntime.
    return [sys.executable, "-I", str(RUNNER), mode, *extra]


def runner_env() -> dict:
    env = {k: v for k, v in os.environ.items()
           if k in ("PATH", "HOME", "LANG", "LC_ALL", "CUDA_VISIBLE_DEVICES", "LD_LIBRARY_PATH",
                    "TMPDIR", "SYSTEMROOT")}
    env["OMP_NUM_THREADS"] = str(max(1, int(get_settings().custom_models_cpu_threads)))
    return env


def sample_frames() -> list[str]:
    """The test pictures: two real photos from the installed ultralytics
    package when present (a COCO model finds people and a bus in them),
    then the bundled synthetic street scenes."""
    out: list[str] = []
    try:
        spec = importlib.util.find_spec("ultralytics")
        if spec and spec.submodule_search_locations:
            assets = Path(list(spec.submodule_search_locations)[0]) / "assets"
            out += [str(assets / n) for n in ("bus.jpg", "zidane.jpg") if (assets / n).is_file()]
    except Exception:
        pass
    out += [str(p) for p in sorted(SAMPLES.glob("*.jpg"))]
    return out[:4]


async def _run(mode: str, request: dict, timeout: float) -> dict:
    async with _semaphore():
        proc = await asyncio.create_subprocess_exec(
            *runner_command(mode), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=runner_env(), cwd=str(RUNNER.parent), start_new_session=True)
        try:
            out, err = await asyncio.wait_for(
                proc.communicate(json.dumps(request).encode()), timeout=timeout)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            await proc.wait()
            raise ModelFailure("timeout", f"{mode} did not finish in {timeout:.0f} s",
                               {"seconds": int(timeout)})
        except asyncio.CancelledError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            raise
    lines = [ln for ln in out.decode(errors="replace").splitlines() if ln.strip()]
    tail = err.decode(errors="replace")[-1500:]
    if not lines:
        raise ModelFailure("crashed", f"{mode}: exit code {proc.returncode}. {tail}".strip())
    try:
        res = json.loads(lines[-1])
    except ValueError:
        raise ModelFailure("crashed", f"{mode}: unreadable answer. {tail}".strip())
    if not res.get("ok"):
        raise ModelFailure(res.get("code") or "load_failed", res.get("detail") or "",
                           res.get("extra") or {})
    return res


async def inspect(model_path: Path, *, config: Path | None = None,
                  preprocessor: Path | None = None, labels: list | None = None,
                  task: str = "") -> dict:
    s = get_settings()
    req = {"model": str(model_path), "use_gpu": bool(s.custom_models_use_gpu),
           "threads": int(s.custom_models_cpu_threads),
           "config": str(config) if config and config.is_file() else None,
           "preprocessor": str(preprocessor) if preprocessor and preprocessor.is_file() else None,
           "labels": labels or None, "task": task or ""}
    res = await _run("inspect", req, float(s.custom_models_inspect_timeout_s))
    return res["info"]


async def test(model_path: Path, spec: dict, *, preview: Path, threshold: float = 0.25) -> dict:
    s = get_settings()
    req = {"model": str(model_path), "spec": spec, "samples": sample_frames(),
           "preview": str(preview), "threshold": threshold,
           "use_gpu": bool(s.custom_models_use_gpu), "threads": int(s.custom_models_cpu_threads),
           "gpu_mem_mb": int(s.custom_models_gpu_mem_limit_mb)}
    res = await _run("test", req, float(s.custom_models_test_timeout_s))
    return res["result"]
