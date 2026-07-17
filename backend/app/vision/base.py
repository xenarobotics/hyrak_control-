"""
BaseAnalyzer — cleaned up from original project.
Every vision module inherits from this.
Key design: submit_frame() is non-blocking.
The latest frame is always processed, older ones are dropped.
"""
import asyncio
import logging
import time
from abc import ABC, abstractmethod
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, Optional, Tuple
import numpy as np

logger = logging.getLogger("verocore.vision.base")


class BaseAnalyzer(ABC):
    def __init__(
        self,
        executor_workers: int = 2,
        results_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    ):
        self.executor = ThreadPoolExecutor(max_workers=executor_workers)
        self._clients: Dict[str, Dict[str, Any]] = {}
        self._inflight: set[str] = set()
        self._results_callback = results_callback

    # ------------------------------------------------------------------ #
    # Client registration                                                  #
    # ------------------------------------------------------------------ #

    def register_client(self, client_id: str):
        if client_id in self._clients:
            return
        self._clients[client_id] = {
            "latest_frame": None,
            "latest_result": None,
            "lock": asyncio.Lock(),
        }
        logger.info(f"{self.__class__.__name__}: registered {client_id[:8]}")

    async def unregister_client(self, client_id: str):
        data = self._clients.get(client_id)
        if not data:
            return
        async with data["lock"]:
            data["latest_frame"] = None
        self._clients.pop(client_id, None)
        self._inflight.discard(client_id)
        logger.info(f"{self.__class__.__name__}: unregistered {client_id[:8]}")

    # ------------------------------------------------------------------ #
    # Frame submission                                                     #
    # ------------------------------------------------------------------ #

    def submit_frame(self, client_id: str, frame_bgr: np.ndarray):
        """
        Non-blocking. Stores the latest frame and starts processing
        if not already running for this client.
        """
        if client_id not in self._clients:
            return

        async def _schedule():
            data = self._clients.get(client_id)
            if not data:
                return
            async with data["lock"]:
                data["latest_frame"] = frame_bgr
                should_start = client_id not in self._inflight
            if should_start:
                self._inflight.add(client_id)
                asyncio.create_task(self._process_loop(client_id))

        try:
            asyncio.create_task(_schedule())
        except RuntimeError:
            pass

    def get_latest_result(
        self, client_id: str
    ) -> Optional[Tuple[np.ndarray, Dict[str, Any]]]:
        """Non-blocking read. Returns and clears the latest result."""
        data = self._clients.get(client_id)
        if not data:
            return None
        result = data.get("latest_result")
        if result is None:
            return None
        data["latest_result"] = None
        return result

    # ------------------------------------------------------------------ #
    # Processing loop                                                      #
    # ------------------------------------------------------------------ #

    async def _process_loop(self, client_id: str):
        try:
            while client_id in self._clients:
                data = self._clients[client_id]
                async with data["lock"]:
                    frame = data["latest_frame"]
                    data["latest_frame"] = None
                if frame is None:
                    break

                start = time.time()
                try:
                    loop = asyncio.get_running_loop()
                    annotated, meta = await loop.run_in_executor(
                        self.executor, self._analyze_frame_blocking, frame
                    )
                except Exception as e:
                    logger.exception(f"{self.__class__.__name__} error for {client_id[:8]}: {e}")
                    await asyncio.sleep(0.01)
                    continue

                elapsed_ms = round((time.time() - start) * 1000.0, 1)
                meta = meta or {}
                meta["analysis_time_ms"] = elapsed_ms
                meta["timestamp"] = time.time()

                if client_id in self._clients:
                    async with self._clients[client_id]["lock"]:
                        self._clients[client_id]["latest_result"] = (annotated, meta)

                if self._results_callback:
                    try:
                        maybe = self._results_callback(meta)
                        if asyncio.iscoroutine(maybe):
                            asyncio.create_task(maybe)
                    except Exception:
                        pass

                await asyncio.sleep(0)
        finally:
            self._inflight.discard(client_id)

    # ------------------------------------------------------------------ #
    # Abstract                                                             #
    # ------------------------------------------------------------------ #

    @abstractmethod
    def _analyze_frame_blocking(
        self, frame_bgr: np.ndarray
    ) -> Tuple[np.ndarray, Dict[str, Any]]:
        """Run inference. Return (annotated_frame, metadata_dict)."""
        raise NotImplementedError

    async def stop(self):
        try:
            self.executor.shutdown(wait=False, cancel_futures=True)
        except Exception:
            pass