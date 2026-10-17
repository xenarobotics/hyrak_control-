"""
BaseAnalyzer lifecycle fixes from the 2026-10-17 audit:

  V9   captured_at / source_latency_s reach FrameContext.pipeline_latency_s
  V10  stop() waits for the in-flight frame off the loop; VRAM is cleared
       on a thread, after it, by the worker pool
  V11  per-client state lock held by the worker for the whole frame and by
       every module setter
  V16  one executor worker; every YOLO module says so
  V18  warm-up frames match the mode's configured inference width
  V20  the silent except-pass paths now warn, rate-limited
"""
import asyncio
import inspect
import threading
import time
from typing import Any, Dict, Tuple

import numpy as np
import pytest

from app.vision import base as vision_base
from app.vision.base import BaseAnalyzer, locked_setter, warn_limited
from app.vision.modules.__registry__ import ANALYZER_REGISTRY


class _Probe(BaseAnalyzer):
    MODE = "object-detection"

    def __init__(self, **kw):
        super().__init__(**kw)
        self.hold_s = 0.0
        self.started = threading.Event()
        self.finished = threading.Event()
        self.lock_owned_in_frame = None
        self.frames = 0

    def _analyze_frame_blocking(self, frame_bgr) -> Tuple[np.ndarray, Dict[str, Any]]:
        self.started.set()
        self.lock_owned_in_frame = self._state_lock("c")._is_owned()
        if self.hold_s:
            time.sleep(self.hold_s)
        self.frames += 1
        self.finished.set()
        return frame_bgr, {}

    @locked_setter
    def set_thing(self, client_id, value):
        self.thing = value
        return value


def _frame(v=0):
    return np.full((16, 16, 3), v, np.uint8)


async def _wait(ev: threading.Event, timeout=3.0):
    deadline = time.monotonic() + timeout
    while not ev.is_set() and time.monotonic() < deadline:
        await asyncio.sleep(0.01)
    assert ev.is_set(), "timed out"


# --------------------------------------------------------------------------- #
# V9 capture time                                                               #
# --------------------------------------------------------------------------- #

def _stored_context(a: BaseAnalyzer):
    return a._clients["c"]["latest_context"]


def _spy():
    a = _Probe.__new__(_Probe)
    a._clients = {"c": {"latest_frame": None, "latest_context": None, "lock": asyncio.Lock()}}
    a._inflight = {"c"}             # store only, do not start the loop
    a._contexts = {}
    a._frame_counters = {}
    return a


async def test_default_capture_time_is_submit_time_with_zero_pipeline_latency():
    a = _spy()
    before = time.monotonic()
    a.submit_frame("c", _frame())
    await asyncio.sleep(0); await asyncio.sleep(0)
    ctx = _stored_context(a)
    assert before <= ctx.captured_at <= time.monotonic()
    assert ctx.pipeline_latency_s == pytest.approx(0.0, abs=1e-3)


async def test_explicit_capture_time_is_honoured_and_measured():
    a = _spy()
    t_cap = time.monotonic() - 0.25
    a.submit_frame("c", _frame(), captured_at=t_cap)
    await asyncio.sleep(0); await asyncio.sleep(0)
    ctx = _stored_context(a)
    assert ctx.captured_at == pytest.approx(t_cap)
    assert ctx.pipeline_latency_s == pytest.approx(0.25, abs=0.05)


async def test_known_source_latency_shifts_capture_time_back():
    """The SRT path only knows its buffer, not a per-frame stamp."""
    a = _spy()
    a.submit_frame("c", _frame(), source_latency_s=0.15)
    await asyncio.sleep(0); await asyncio.sleep(0)
    ctx = _stored_context(a)
    assert ctx.pipeline_latency_s == pytest.approx(0.15, abs=0.05)
    assert ctx.captured_at < time.monotonic() - 0.1


async def test_a_capture_time_in_the_future_is_clamped():
    a = _spy()
    a.submit_frame("c", _frame(), captured_at=time.monotonic() + 5.0)
    await asyncio.sleep(0); await asyncio.sleep(0)
    ctx = _stored_context(a)
    assert ctx.captured_at <= time.monotonic()
    assert ctx.pipeline_latency_s == 0.0


def test_relay_latency_helper_reads_settings():
    from app.config import get_settings
    assert vision_base.relay_latency_s() == pytest.approx(get_settings().relay_latency_ms / 1000.0)


async def test_pipeline_latency_is_reported_in_meta():
    p = _Probe()
    p.register_client("c")
    p.submit_frame("c", _frame(), captured_at=time.monotonic() - 0.2)
    await _wait(p.finished)
    deadline = time.monotonic() + 2
    while p._clients["c"].get("latest_result") is None and time.monotonic() < deadline:
        await asyncio.sleep(0.01)
    _, meta = p.get_latest_result("c")
    assert meta["pipeline_latency_ms"] == pytest.approx(200.0, abs=60.0)
    await p.unregister_client("c")
    await p.stop()


# --------------------------------------------------------------------------- #
# V10 stop() waits                                                              #
# --------------------------------------------------------------------------- #

async def test_stop_waits_for_the_inflight_frame_and_releases_handles():
    class _Handle:
        released = False
        obj = "weights"

        def release(self):
            self.released = True

    p = _Probe()
    p.hold_s = 0.3
    h = _Handle()
    p.hold(h)
    p.register_client("c")
    p.submit_frame("c", _frame())
    await _wait(p.started)
    assert not p.finished.is_set()
    t0 = time.monotonic()
    await p.stop()
    assert p.finished.is_set(), "stop() returned while the frame was still running"
    assert time.monotonic() - t0 >= 0.1
    assert h.released and p._model_handles == []


async def test_worker_pool_clears_vram_on_a_thread_after_stop(monkeypatch):
    import torch
    from app.vision.worker_pool import VisionWorkerPool

    order = []
    loop_thread = threading.current_thread()

    class _Analyzer:
        async def unregister_client(self, sid):
            order.append("unregister")

        async def stop(self):
            order.append("stop")

    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(torch.cuda, "empty_cache",
                        lambda: order.append(("empty_cache", threading.current_thread())))
    monkeypatch.setattr(torch.cuda, "memory_allocated", lambda *_: 0)

    pool = VisionWorkerPool()
    pool._session_analyzer["s"] = _Analyzer()
    await pool._unload_session("s")

    assert order[:2] == ["unregister", "stop"]
    assert order[2][0] == "empty_cache"
    assert order[2][1] is not loop_thread, "empty_cache ran on the event loop"


def test_executor_shutdown_is_awaited_not_fire_and_forget():
    src = inspect.getsource(BaseAnalyzer.stop)
    assert "executor.shutdown(wait=False" not in src
    assert "to_thread(executor.shutdown, True" in src


# --------------------------------------------------------------------------- #
# V11 state lock                                                                #
# --------------------------------------------------------------------------- #

async def test_worker_holds_the_clients_state_lock_during_the_frame():
    p = _Probe()
    p.register_client("c")
    p.submit_frame("c", _frame())
    await _wait(p.finished)
    assert p.lock_owned_in_frame is True
    await p.unregister_client("c")
    await p.stop()


async def test_setter_waits_for_the_inflight_frame():
    p = _Probe()
    p.hold_s = 0.3
    p.register_client("c")
    p.submit_frame("c", _frame())
    await _wait(p.started)
    t0 = time.monotonic()
    # On a thread: a blocking setter on the loop would stall this test's
    # own awaits. The point is that it does not return mid-frame.
    await asyncio.to_thread(p.set_thing, "c", 7)
    assert p.finished.is_set(), "setter ran while the frame was being analysed"
    assert time.monotonic() - t0 >= 0.1
    assert p.thing == 7
    await p.unregister_client("c")
    await p.stop()


def test_state_lock_is_reentrant_and_lazy():
    """Setters call setters; modules call their own setters from inside the
    frame; tests build analyzers with __new__."""
    p = _Probe.__new__(_Probe)
    lock = p._state_lock("x")
    with lock:
        with lock:
            assert p.set_thing("x", 1) == 1
    assert p._state_lock("x") is lock


_SETTER_PREFIXES = ("set_", "request_follow", "clear_reference")


@pytest.mark.parametrize("mode,cls", list(ANALYZER_REGISTRY.items()),
                         ids=lambda x: getattr(x, "value", None) or getattr(x, "__name__", str(x)))
def test_every_per_session_setter_is_locked(mode, cls):
    """Every public per-client mutator on every module goes through
    locked_setter. set_gallery is excluded on purpose: it replaces a whole
    object atomically and is not per client."""
    unlocked = []
    for name, fn in inspect.getmembers(cls, inspect.isfunction):
        if not name.startswith(_SETTER_PREFIXES) or name == "set_gallery":
            continue
        params = list(inspect.signature(fn).parameters)
        if len(params) < 2 or params[1] != "client_id":
            continue
        if not hasattr(fn, "__wrapped__"):
            unlocked.append(name)
    assert not unlocked, f"{cls.__name__}: unlocked setters {unlocked}"


# --------------------------------------------------------------------------- #
# V16 one worker                                                                #
# --------------------------------------------------------------------------- #

def test_one_executor_worker_by_default_and_in_every_module():
    assert inspect.signature(BaseAnalyzer.__init__).parameters["executor_workers"].default == 1
    for cls in ANALYZER_REGISTRY.values():
        src = inspect.getsource(cls.__init__)
        assert "executor_workers=2" not in src, cls.__name__
    assert "ONE CLIENT PER ANALYZER INSTANCE" in (BaseAnalyzer.__doc__ or "")


# --------------------------------------------------------------------------- #
# V18 warm-up size                                                              #
# --------------------------------------------------------------------------- #

def test_warmup_frame_matches_the_modes_inference_width(monkeypatch):
    from app.config import get_settings
    s = get_settings()
    monkeypatch.setattr(s, "inference_width_by_mode",
                        {"crowd-management": 1280, "vehicle-plate-tracking": 0})

    class _Crowd(BaseAnalyzer):
        MODE = "crowd-management"

        def _analyze_frame_blocking(self, f):
            return f, {}

    class _Plate(_Crowd):
        MODE = "vehicle-plate-tracking"

    crowd = _Crowd.__new__(_Crowd)
    assert crowd.warmup_frame().shape == (720, 1280, 3)
    assert crowd.imgsz_for(crowd.warmup_frame()) == 1280
    plate = _Plate.__new__(_Plate)
    assert plate.warmup_frame().shape == (1080, 1920, 3), "native warms at 1080p"
    assert plate.imgsz_for(plate.warmup_frame()) == 1920


def test_no_module_warms_up_at_a_hardcoded_640x360():
    import pathlib
    import app.vision.modules as pkg
    for path in pathlib.Path(pkg.__file__).parent.glob("*.py"):
        src = path.read_text()
        assert "np.zeros((360, 640, 3)" not in src, (
            f"{path.name} warms at 640x360 instead of warmup_frame()"
        )


# --------------------------------------------------------------------------- #
# V20 warnings instead of silence                                              #
# --------------------------------------------------------------------------- #

def test_warn_limited_logs_once_per_interval(caplog):
    key = f"t:{time.monotonic()}"
    with caplog.at_level("WARNING", logger="verocore.vision.base"):
        assert warn_limited(key, "first")
        assert not warn_limited(key, "second")
    assert [r.message for r in caplog.records] == ["first"]


async def test_results_callback_failure_is_logged_and_does_not_stop_the_loop(caplog):
    def boom(meta):
        raise ValueError("panel gone")

    p = _Probe(results_callback=boom)
    p.register_client("c")
    with caplog.at_level("WARNING", logger="verocore.vision.base"):
        p.submit_frame("c", _frame(1))
        await _wait(p.finished)
        p.finished.clear()
        await asyncio.sleep(0.05)
        p.submit_frame("c", _frame(2))
        await _wait(p.finished)
        await asyncio.sleep(0.05)
    assert p.frames == 2
    assert any("results callback failed" in r.message for r in caplog.records)
    await p.unregister_client("c")
    await p.stop()


def test_submit_outside_the_loop_warns_instead_of_passing(caplog):
    p = _Probe.__new__(_Probe)
    p._clients = {"c": {"latest_frame": None, "latest_context": None, "lock": None}}
    p._inflight = set()
    p._contexts = {}
    p._frame_counters = {}
    with caplog.at_level("WARNING", logger="verocore.vision.base"):
        p.submit_frame("c", _frame())          # no running loop here
    assert any("outside the event loop" in r.message for r in caplog.records)


def test_no_silent_except_pass_left_in_base():
    src = inspect.getsource(vision_base)
    assert "except Exception:\n                        pass" not in src
    assert "except RuntimeError:\n            pass" not in src
