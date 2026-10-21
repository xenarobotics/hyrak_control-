"""
Lazy model slots for Copilot's speech and vision models.

One process-wide slot per model, shared by every session with Copilot on.
Loaded on first use (fp16 on CUDA, fp32 on CPU), kept while any session has
Copilot on, and unloaded UNLOAD_AFTER_S after the last one switches it off
(service.py schedules that). The GPU is an 8 GB card shared with the vision
workers, so nothing here loads at import time and an unload empties the
CUDA cache.

Each slot owns a single-thread executor: inference on one model never runs
twice at once (the processors and generate() are not built for it), and a
slow vision call never queues in front of speech.
"""
from __future__ import annotations

import gc
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Optional

logger = logging.getLogger("verocore.copilot.models")

UNLOAD_AFTER_S = 600.0


def device_and_dtype():
    """("cuda", float16) when a GPU is there, else ("cpu", float32)."""
    import torch
    if torch.cuda.is_available():
        return "cuda", torch.float16
    return "cpu", torch.float32


class ModelSlot:
    """One model, loaded on first get(). `loader()` returns the loaded
    object; it runs on the slot's own worker thread."""

    def __init__(self, name: str, loader: Callable[[], Any]):
        self.name = name
        self._loader = loader
        self._obj: Any = None
        self._lock = threading.Lock()
        self.loading = False
        self.error: Optional[str] = None
        self.load_s: Optional[float] = None
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"copilot-{name}")

    @property
    def loaded(self) -> bool:
        return self._obj is not None

    def get(self) -> Any:
        """The loaded model, loading it now if needed. Blocking: call it
        on the slot's executor."""
        if self._obj is not None:
            return self._obj
        with self._lock:
            if self._obj is None:
                self.loading = True
                t0 = time.perf_counter()
                try:
                    self._obj = self._loader()
                    self.error = None
                    self.load_s = time.perf_counter() - t0
                    logger.info(f"Copilot {self.name} loaded in {self.load_s:.1f}s")
                except Exception as e:
                    self.error = f"{type(e).__name__}: {e}"
                    logger.error(f"Copilot {self.name} failed to load: {self.error}")
                    raise
                finally:
                    self.loading = False
        return self._obj

    def unload(self) -> bool:
        with self._lock:
            if self._obj is None:
                return False
            self._obj = None
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        logger.info(f"Copilot {self.name} unloaded")
        return True

    def set_for_tests(self, obj: Any) -> None:
        self._obj = obj
