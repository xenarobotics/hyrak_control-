"""
Process-wide model cache (audit V4).

What is pinned: one load per (kind, weights, device, precision) however many
analyzers ask; refcounts; a released model survives the idle grace and is
freed after it; a loader failure caches nothing; and, for YOLO, that two
wrappers over the same weights keep SEPARATE predictors (ByteTrack state is
per session) while sharing one nn.Module.
"""
import os
import threading
import time

import numpy as np
import pytest

from app.vision.model_cache import ModelCache, shared_yolo

KEY = ("fake", "weights.pt", "cpu", "fp32")


def _loader(calls, obj="model"):
    def load():
        calls.append(1)
        return obj
    return load


def test_second_acquire_reuses_the_first_load():
    cache = ModelCache(grace_s=0)
    calls = []
    a = cache.acquire(KEY, _loader(calls))
    b = cache.acquire(KEY, _loader(calls))
    assert a.obj is b.obj == "model"
    assert len(calls) == 1 and cache.loads == 1
    assert cache.refs(KEY) == 2


def test_last_release_with_no_grace_frees_immediately():
    cache = ModelCache(grace_s=0)
    a = cache.acquire(KEY, _loader([]))
    b = cache.acquire(KEY, _loader([]))
    a.release()
    assert cache.is_cached(KEY), "a model still referenced must not be freed"
    b.release()
    assert not cache.is_cached(KEY)
    assert cache.frees == 1
    b.release()                      # idempotent
    assert cache.frees == 1


def test_idle_grace_keeps_the_model_then_frees_it():
    cache = ModelCache(grace_s=0.1)
    calls = []
    cache.acquire(KEY, _loader(calls)).release()
    assert cache.is_cached(KEY), "released model should survive the grace window"
    deadline = time.monotonic() + 2.0
    while cache.is_cached(KEY) and time.monotonic() < deadline:
        time.sleep(0.02)
    assert not cache.is_cached(KEY)
    assert cache.frees == 1


def test_reacquire_within_grace_cancels_the_free_and_skips_the_load():
    cache = ModelCache(grace_s=0.15)
    calls = []
    cache.acquire(KEY, _loader(calls)).release()
    h = cache.acquire(KEY, _loader(calls))      # a mode switch back
    time.sleep(0.3)
    assert cache.is_cached(KEY) and cache.refs(KEY) == 1
    assert len(calls) == 1 and cache.frees == 0
    h.release()


def test_failed_loader_caches_nothing_and_the_next_acquire_retries():
    cache = ModelCache(grace_s=0)
    calls = []

    def bad():
        calls.append(1)
        raise RuntimeError("no checkpoint")

    with pytest.raises(RuntimeError):
        cache.acquire(KEY, bad)
    assert not cache.is_cached(KEY) and cache.refs(KEY) == 0
    h = cache.acquire(KEY, _loader(calls))
    assert h.obj == "model" and len(calls) == 2


def test_concurrent_acquirers_share_one_load():
    """Two sessions starting the same mode at once (the worker pool loads on
    threads) must not both run the loader."""
    cache = ModelCache(grace_s=0)
    started = threading.Event()
    calls = []

    def slow():
        calls.append(1)
        started.set()
        time.sleep(0.2)
        return object()

    out = []
    threads = [threading.Thread(target=lambda: out.append(cache.acquire(KEY, slow).obj))
               for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(calls) == 1
    assert len(out) == 3 and all(o is out[0] for o in out)
    assert cache.refs(KEY) == 3


def test_stats_report_refs_and_idle():
    cache = ModelCache(grace_s=10)
    h = cache.acquire(KEY, _loader([]))
    assert cache.stats()[KEY]["refs"] == 1
    assert cache.stats()[KEY]["idle_s"] is None
    h.release()
    assert cache.stats()[KEY]["refs"] == 0
    assert cache.stats()[KEY]["idle_s"] is not None
    cache.clear()
    assert cache.stats() == {}


# --------------------------------------------------------------------------- #
# YOLO: shared weights, private wrapper                                        #
# --------------------------------------------------------------------------- #

_NANO = os.path.expanduser("~/hyrak_control/backend/yolov8n.pt")


@pytest.mark.skipif(not os.path.exists(_NANO), reason="yolov8n.pt not present")
def test_two_yolo_wrappers_share_one_module_but_not_one_predictor():
    """CPU, the nano model, 64 px frames: a few hundred ms. The point is the
    object graph, not detections."""
    cache = ModelCache(grace_s=0)
    a, ha = shared_yolo(_NANO, "cpu", cache=cache)
    b, hb = shared_yolo(_NANO, "cpu", cache=cache)
    assert a is not b
    assert a.model is b.model, "the nn.Module must be the cached one"
    assert cache.loads == 1 and cache.refs(ha.key) == 2
    assert a.overrides is not b.overrides, "overrides aliased: one session's args would leak"
    assert a.names == b.names

    frame = np.zeros((64, 64, 3), np.uint8)
    a.track(frame, imgsz=64, persist=True, verbose=False, device="cpu")
    b.track(frame, imgsz=64, persist=True, verbose=False, device="cpu")
    assert a.predictor is not None and b.predictor is not None
    assert a.predictor is not b.predictor
    assert a.predictor.trackers[0] is not b.predictor.trackers[0], (
        "ByteTrack state must be per session"
    )
    assert a.predictor.model.model is b.predictor.model.model, (
        "AutoBackend wrapped a different module: weights were copied"
    )

    ha.release()
    assert cache.is_cached(ha.key)
    hb.release()
    assert not cache.is_cached(ha.key)
