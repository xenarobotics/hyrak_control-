"""Process-wide model weight cache with refcounts and an idle grace period.

WHY. Every analyzer used to load its own copy of every model it needs: one
YOLOv8m per session (five modules build one), InsightFace det+rec sessions
per session, fast-alpr per session, DA3-Large per depth session PLUS a
second DA3 for background obstacle sensing. Two sessions in the same mode
meant two copies of identical weights in an 8 GB card, and every mode switch
re-read the checkpoint from disk. Audit V4.

WHAT IS SHARED AND WHAT IS NOT.
  * The WEIGHTS are shared: the loaded nn.Module for YOLO and DA3, the ORT
    InferenceSessions behind InsightFace and fast-alpr (an ORT session is
    thread-safe for run()).
  * Per-session STATE is not: each session gets its own ultralytics YOLO
    wrapper, so its predictor and therefore its ByteTrack state
    (persist=True) are private. See shared_yolo().
  * Inference on one shared nn.Module is serialised by the handle's lock.
    The ultralytics Detect head caches anchors for the last input shape on
    the module itself (head.py: `if self.shape != shape: self.anchors = ...`),
    so two sessions at different widths racing through it would decode one
    frame with the other's anchors. One GPU executes one kernel stream
    anyway, so the lock costs nothing in throughput.

LIFECYCLE. acquire(key, loader) loads once and bumps a refcount; release()
drops it. A model whose refcount reaches zero is kept for IDLE_GRACE_S (a
mode switch away and back, or a reconnect, should not reload from disk)
and then freed on a timer thread, followed by torch.cuda.empty_cache() -
never on the event loop.

Keys are (kind, weights_path_or_model_id, device, precision).
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, Dict, Hashable, Optional, Tuple

logger = logging.getLogger("verocore.vision.model_cache")

IDLE_GRACE_S = 60.0

Key = Tuple[str, str, str, str]


class _Entry:
    __slots__ = ("key", "obj", "refs", "lock", "load_lock", "idle_since", "timer", "gen")

    def __init__(self, key: Key):
        self.key = key
        self.obj: Any = None
        self.refs = 0
        # Serialises stateful inference on the shared object (see module doc).
        # Re-entrant: a module may call back into itself while holding it.
        self.lock = threading.RLock()
        self.load_lock = threading.Lock()
        self.idle_since: Optional[float] = None
        self.timer: Optional[threading.Timer] = None
        self.gen = 0


class Handle:
    """One acquirer's reference to a cached model.

    `obj` is the shared object, `lock` serialises inference on it, and
    release() drops the reference (idempotent)."""

    def __init__(self, cache: "ModelCache", entry: _Entry):
        self._cache = cache
        self._entry = entry
        self._released = False

    @property
    def key(self) -> Key:
        return self._entry.key

    @property
    def obj(self) -> Any:
        return self._entry.obj

    @property
    def lock(self) -> threading.RLock:
        return self._entry.lock

    @property
    def released(self) -> bool:
        return self._released

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        self._cache._release(self._entry)


class ModelCache:
    def __init__(self, grace_s: float = IDLE_GRACE_S):
        self.grace_s = float(grace_s)
        self._entries: Dict[Key, _Entry] = {}
        self._mu = threading.Lock()
        self.loads = 0          # how many times a loader actually ran
        self.frees = 0

    # ------------------------------------------------------------------ #

    def acquire(self, key: Key, loader: Callable[[], Any]) -> Handle:
        """The cached object for `key`, loading it with `loader` on a miss.

        Concurrent acquirers of the same key wait for one load rather than
        each running the loader. A loader that raises leaves nothing cached
        and the exception reaches the caller."""
        key = tuple(key)  # type: ignore[assignment]
        with self._mu:
            e = self._entries.get(key)
            if e is None:
                e = _Entry(key)
                self._entries[key] = e
            # Counted BEFORE loading so a concurrent release of the same
            # key cannot start the idle timer underneath this acquirer.
            e.refs += 1
            e.idle_since = None
            self._cancel_timer(e)
        with e.load_lock:
            if e.obj is None:
                try:
                    t0 = time.monotonic()
                    e.obj = loader()
                    self.loads += 1
                    logger.info(
                        f"model cache: loaded {key[0]} {key[1]} on {key[2]} "
                        f"({key[3]}) in {time.monotonic() - t0:.1f}s"
                    )
                except Exception:
                    with self._mu:
                        e.refs -= 1
                        if e.refs <= 0 and self._entries.get(key) is e:
                            del self._entries[key]
                    raise
            else:
                logger.info(f"model cache: reused {key[0]} {key[1]} (refs={e.refs})")
        return Handle(self, e)

    def _release(self, e: _Entry) -> None:
        free_now = None
        with self._mu:
            e.refs -= 1
            if e.refs > 0:
                return
            e.refs = 0
            e.idle_since = time.monotonic()
            e.gen += 1
            if self.grace_s <= 0:
                free_now = self._pop_locked(e)
            else:
                self._cancel_timer(e)
                t = threading.Timer(self.grace_s, self._expire, args=(e.key, e.gen))
                t.daemon = True
                e.timer = t
                t.start()
        if free_now is not None:
            self._free(e.key, free_now)

    def _expire(self, key: Key, gen: int) -> None:
        with self._mu:
            e = self._entries.get(key)
            if e is None or e.refs > 0 or e.gen != gen:
                return
            obj = self._pop_locked(e)
        self._free(key, obj)

    def _pop_locked(self, e: _Entry) -> Any:
        self._entries.pop(e.key, None)
        obj, e.obj = e.obj, None
        return obj

    def _cancel_timer(self, e: _Entry) -> None:
        if e.timer is not None:
            e.timer.cancel()
            e.timer = None

    def _free(self, key: Key, obj: Any) -> None:
        """Runs on the timer thread (or the releasing thread with grace 0):
        drop the last reference, then give the allocator's cache back."""
        del obj
        self.frees += 1
        logger.info(f"model cache: freed {key[0]} {key[1]} after idle grace")
        try:
            import gc
            gc.collect()
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    # ------------------------------------------------------------------ #

    def stats(self) -> Dict[Key, Dict[str, Any]]:
        now = time.monotonic()
        with self._mu:
            return {
                k: {"refs": e.refs,
                    "idle_s": None if e.idle_since is None else round(now - e.idle_since, 1),
                    "loaded": e.obj is not None}
                for k, e in self._entries.items()
            }

    def refs(self, key: Key) -> int:
        with self._mu:
            e = self._entries.get(tuple(key))  # type: ignore[arg-type]
            return e.refs if e else 0

    def is_cached(self, key: Key) -> bool:
        with self._mu:
            e = self._entries.get(tuple(key))  # type: ignore[arg-type]
            return bool(e and e.obj is not None)

    def clear(self) -> None:
        """Drop everything now, refcounts or not (shutdown and tests)."""
        with self._mu:
            entries = list(self._entries.values())
            self._entries.clear()
            for e in entries:
                self._cancel_timer(e)
                e.obj = None


CACHE = ModelCache()


# ---------------------------------------------------------------------- #
# Loaders for the models the modules use                                  #
# ---------------------------------------------------------------------- #

def _precision(device: str) -> str:
    return "fp16" if str(device).startswith("cuda") else "fp32"


def shared_yolo(weights: str, device: str, cache: ModelCache = CACHE):
    """A PRIVATE ultralytics YOLO wrapper around SHARED weights.

    Returns (model, handle). `model` behaves like `YOLO(weights).to(device)`:
    it has its own predictor and callbacks, so `track(persist=True)` keeps
    this session's ByteTrack state separate from every other session's. The
    nn.Module underneath (what AutoBackend fuses, halves and runs) is the
    cached one, loaded from disk once per process.

    Built the way Model._load does it (ultralytics 8.3.2 engine/model.py)
    minus the file read: attempt_load_one_weight is the only step that
    touches disk, and its result is exactly what the cache holds.
    """
    from ultralytics.nn.tasks import attempt_load_one_weight

    key: Key = ("yolo", str(weights), str(device), _precision(device))

    def _load():
        module, _ckpt = attempt_load_one_weight(str(weights))
        return module.to(device)

    handle = cache.acquire(key, _load)
    return _SharedYOLO.wrap(handle, str(weights), str(device)), handle


def _make_shared_yolo_class():
    """Deferred so importing this module never imports ultralytics (tests on
    machines without it, and the enhancer, need neither)."""
    import torch
    from ultralytics import YOLO
    from ultralytics.utils import callbacks

    class SharedYOLO(YOLO):
        """YOLO whose nn.Module is borrowed from the cache; predict() holds
        the cache entry's lock (see module doc on the Detect anchor cache)."""

        @classmethod
        def wrap(cls, handle: Handle, weights: str, device: str):
            module = handle.obj
            y = cls.__new__(cls)
            torch.nn.Module.__init__(y)
            y.callbacks = callbacks.get_default_callbacks()
            y.predictor = None
            y.model = module
            y.trainer = None
            y.ckpt = None
            y.cfg = None
            y.ckpt_path = getattr(module, "pt_path", weights)
            y.metrics = None
            y.session = None
            y.task = module.args["task"]
            # A COPY: Model._load aliases overrides to model.args, which would
            # let one session's device/imgsz overrides leak into another's.
            y.overrides = dict(module.args)
            y.overrides["model"] = weights
            y.overrides["task"] = y.task
            y.overrides["device"] = device
            y.model_name = weights
            y._shared_handle = handle
            return y

        def predict(self, *args, **kwargs):
            lock = getattr(self, "_shared_handle", None)
            if lock is None:
                return super().predict(*args, **kwargs)
            with lock.lock:
                return super().predict(*args, **kwargs)

    return SharedYOLO


class _SharedYOLOFactory:
    _cls = None

    @classmethod
    def wrap(cls, handle: Handle, weights: str, device: str):
        if cls._cls is None:
            cls._cls = _make_shared_yolo_class()
        return cls._cls.wrap(handle, weights, device)


_SharedYOLO = _SharedYOLOFactory


def shared_face_app(name: str, device: str, det_size=(640, 640), cache: ModelCache = CACHE):
    """InsightFace FaceAnalysis (det + rec ORT sessions), prepared, shared.

    Returns (face_app, handle). ORT sessions are thread-safe for run() and
    FaceAnalysis keeps no per-call state, so the whole prepared object is
    shared as-is. Providers mirror what person_tracker used: HEURISTIC conv
    search instead of ORT's EXHAUSTIVE default, which benchmarks every
    algorithm on the first inference and freezes the stream for seconds.
    """
    key: Key = ("insightface", f"{name}@{det_size[0]}x{det_size[1]}", str(device), "fp32")

    def _load():
        import insightface
        import numpy as np
        cuda = str(device).startswith("cuda")
        providers = (
            [("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"}),
             "CPUExecutionProvider"]
            if cuda else ["CPUExecutionProvider"]
        )
        app = insightface.app.FaceAnalysis(name=name, providers=providers)
        app.prepare(ctx_id=0 if cuda else -1, det_size=tuple(det_size))
        # Warm both models so the first live face check pays no cuDNN init.
        app.get(np.zeros((360, 640, 3), dtype=np.uint8))
        try:
            rec = app.models.get("recognition")
            if rec is not None:
                rec.get_feat(np.zeros((112, 112, 3), dtype=np.uint8))
        except Exception:
            pass
        return app

    handle = cache.acquire(key, _load)
    return handle.obj, handle


def shared_alpr(detector_model: str, ocr_model: str, device: str, cache: ModelCache = CACHE):
    """fast-alpr (plate detector + OCR ORT sessions), warmed, shared.
    Returns (alpr, handle). Raises if fast-alpr is not installed."""
    key: Key = ("alpr", f"{detector_model}+{ocr_model}", str(device), "fp32")

    def _load():
        import numpy as np
        from fast_alpr import ALPR
        alpr = ALPR(detector_model=detector_model, ocr_model=ocr_model)
        try:
            alpr.predict(np.zeros((384, 384, 3), dtype=np.uint8))
        except Exception as e:
            logger.warning(f"fast-alpr warm-up skipped: {e}")
        return alpr

    handle = cache.acquire(key, _load)
    return handle.obj, handle


def shared_depth_backend(model_name: str, device: str, fov_correct: bool = False,
                         cache: ModelCache = CACHE):
    """A depth backend (app/vision/depth_models) whose network is shared.
    Returns (backend, handle). The backend object itself is per acquirer
    (it carries last_sky and the fov setting); the nn.Module / HF pipeline
    inside it comes from the cache."""
    from app.vision import depth_models
    return depth_models.load_shared(model_name, device, fov_correct=fov_correct, cache=cache)
