"""
BaseAnalyzer - cleaned up from original project.
Every vision module inherits from this.
Key design: submit_frame() is non-blocking.
The latest frame is always processed, older ones are dropped.
"""
import asyncio
import logging
import math
import time
from abc import ABC, abstractmethod
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Tuple
import numpy as np

logger = logging.getLogger("verocore.vision.base")


@dataclass
class FrameContext:
    """
    What was true when a frame was CAPTURED, as opposed to when it finished
    being analysed. Needed by anything that measures the world in metres -
    see vision/geometry.py.

    Two reasons this travels bundled with its frame rather than being read
    separately by the module:

    1. FRAMES ARE DROPPED. submit_frame keeps only the newest frame, so a
       module that read "the current telemetry" would sooner or later pair
       frame N's pixels with frame N+3's altitude. The mismatch is invisible
       and, during a chase, largest exactly when it matters most.

    2. dt IS NOT 1/fps. Because of that same dropping, the gap between two
       frames a module actually sees varies. Differentiating position with an
       assumed nominal interval is simply wrong, and wrong in proportion to
       how loaded the machine is.

    captured_at is time.monotonic(), never time.time(): a wall-clock step
    from NTP would otherwise manufacture an enormous instantaneous velocity.
    """
    captured_at: float
    telemetry: Optional[Dict[str, Any]] = None
    frame_index: int = 0
    width: int = 0
    height: int = 0

    def dt_since(self, previous: Optional["FrameContext"]) -> Optional[float]:
        """Seconds since `previous`, or None if not usable as a time base."""
        if previous is None:
            return None
        dt = self.captured_at - previous.captured_at
        return dt if dt > 1e-6 else None


class BaseAnalyzer(ABC):
    #: Mode name from AnalysisMode, set by each subclass. Used to look up
    #: per-mode tuning (currently inference width) - a module that leaves it
    #: blank silently gets the global default, which is why it is declared
    #: here rather than left implicit.
    MODE: str = ""

    def __init__(
        self,
        executor_workers: int = 2,
        results_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    ):
        self.executor = ThreadPoolExecutor(max_workers=executor_workers)
        self._clients: Dict[str, Dict[str, Any]] = {}
        self._inflight: set[str] = set()
        self._results_callback = results_callback
        # Context of the frame each client is CURRENTLY being analysed with.
        # Keyed by client rather than held as a single "current" attribute
        # because _process_loop runs one task per client concurrently over a
        # shared executor - a scalar would race between sessions.
        self._contexts: Dict[str, FrameContext] = {}
        self._frame_counters: Dict[str, int] = {}
        self._rate_n = 0
        self._rate_t0 = 0.0

    # ------------------------------------------------------------------ #
    # Client registration                                                  #
    # ------------------------------------------------------------------ #

    def register_client(self, client_id: str):
        if client_id in self._clients:
            return
        self._clients[client_id] = {
            "latest_frame": None,
            "latest_context": None,
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
            data["latest_context"] = None
        self._clients.pop(client_id, None)
        self._inflight.discard(client_id)
        self._contexts.pop(client_id, None)
        logger.info(f"{self.__class__.__name__}: unregistered {client_id[:8]}")

    # ------------------------------------------------------------------ #
    # Frame submission                                                     #
    # ------------------------------------------------------------------ #

    def submit_frame(
        self,
        client_id: str,
        frame_bgr: np.ndarray,
        telemetry: Optional[Dict[str, Any]] = None,
    ):
        """
        Non-blocking. Stores the latest frame and starts processing
        if not already running for this client.

        `telemetry` is a TelemetrySnapshot.to_dict() taken at capture time.
        Pass it whenever it is available - it is what lets modules report
        metres instead of pixels. Omitting it is safe: metric outputs are
        then omitted too, rather than computed from a default altitude.
        """
        if client_id not in self._clients:
            return

        idx = self._frame_counters.get(client_id, 0) + 1
        self._frame_counters[client_id] = idx
        h, w = frame_bgr.shape[:2]
        context = FrameContext(
            captured_at=time.monotonic(),
            telemetry=telemetry,
            frame_index=idx,
            width=w,
            height=h,
        )

        # THE ANALYZER GETS ITS OWN COPY OF THE PIXELS.
        #
        # Not defensive style - the caller keeps using this array. In
        # stream_track.recv() the very same `img_bgr` handed in here is later
        # passed to draw_overlay(), and every cv2 drawing call mutates its
        # target in place. Stored by reference, the analyzer's frame therefore
        # grew brackets and labels underneath it, in a race with its own worker
        # thread, which showed up two ways:
        #
        #   * saved evidence crops had the overlay baked into them - a plate
        #     crop wearing a green bracket, a vehicle shot wearing its own
        #     "VH-000001 blue car" label
        #   * detection, colour classification and OCR ran on a frame carrying
        #     the PREVIOUS inference's graphics, so the module was partly
        #     reading its own output
        #
        # 0.17ms for a 1080p frame, measured - far too cheap to trade for
        # pixels the analysis cannot trust. Copying here rather than inside
        # _compose puts the guarantee at the ownership boundary: once a frame is
        # submitted, nothing outside can change it under the worker thread.
        frame_bgr = frame_bgr.copy()

        async def _schedule():
            data = self._clients.get(client_id)
            if not data:
                return
            async with data["lock"]:
                # Frame and context are replaced together and read together
                # so a dropped frame can never leave a module pairing these
                # pixels with a later frame's altitude.
                data["latest_frame"] = frame_bgr
                data["latest_context"] = context
                should_start = client_id not in self._inflight
            if should_start:
                self._inflight.add(client_id)
                asyncio.create_task(self._process_loop(client_id))

        try:
            asyncio.create_task(_schedule())
        except RuntimeError:
            pass

    # ------------------------------------------------------------------ #
    # Inference resolution                                                 #
    # ------------------------------------------------------------------ #

    @property
    def inference_width(self) -> int:
        """Per-mode inference width. Read live so a settings change applies
        without reconstructing the analyzer and reloading its model."""
        from app.config import get_settings
        return get_settings().inference_width_for(self.MODE)

    def resize_for_inference(
        self, frame_bgr: np.ndarray
    ) -> Tuple[np.ndarray, float, float]:
        """
        Downscale for inference and return (frame, scale_x, scale_y).

        MULTIPLY detection coordinates by the returned scales to get back to
        full-frame pixels. Four modules had their own copy of this with 640
        hardcoded, which meant the inference_resize_width setting silently did
        nothing for three of them and capped crowd counting at ~30m altitude.

        Frames narrower than the target are passed through untouched - never
        upscaled, which would cost time and invent no detail.
        """
        h, w = frame_bgr.shape[:2]
        target = self.inference_width
        if target <= 0 or w <= target:
            return frame_bgr, 1.0, 1.0
        import cv2
        new_h = max(1, int(round(h * target / w)))
        small = cv2.resize(frame_bgr, (target, new_h))
        return small, w / float(target), h / float(new_h)

    def imgsz_for(self, frame_bgr: np.ndarray) -> int:
        """
        A VALID ultralytics `imgsz` for this frame. Always use this rather than
        passing `inference_width` straight through.

        `inference_width` is a width BUDGET in which 0 means "native, do not
        downscale" - which resize_for_inference above honours correctly. But
        ultralytics needs a concrete letterbox size, and imgsz=0 does not mean
        native to it, it raises:

            RuntimeError: Calculated padded input size per channel: (2 x 2).
            Kernel size: (3 x 3). Kernel size can't be greater than actual
            input size

        That exception comes from inside the worker thread, so from the outside
        the module simply produces no detections, no metadata and no database
        rows while the video keeps streaming - indistinguishable from a model
        that finds nothing. Native therefore has to resolve to the frame's own
        long side, rounded up to the multiple of 32 the network stride needs.
        """
        target = self.inference_width
        if target > 0:
            return target
        return int(math.ceil(max(frame_bgr.shape[:2]) / 32.0) * 32)

    def frame_context(self, client_id: str) -> Optional[FrameContext]:
        """
        Context of the frame being analysed right now for this client.

        Modules read it from inside _analyze_frame_blocking, which receives
        only the frame - they already iterate self._client_state.items(), so
        the client_id is in hand there.
        """
        return self._contexts.get(client_id)

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

    def draw_overlay(
        self, frame_bgr: np.ndarray, meta: Dict[str, Any]
    ) -> Optional[np.ndarray]:
        """
        Optional: draw the latest results onto the CURRENT camera frame
        (in place) and return it. Modules that support this get fly-tab
        smoothness - every camera frame is displayed, with annotations
        that lag by at most one inference. Modules whose OUTPUT is a
        transformed frame (depth colormap, enhancer) return None and the
        cached-frame path is used instead.
        """
        return None

    # ------------------------------------------------------------------ #
    # Processing loop                                                      #
    # ------------------------------------------------------------------ #

    async def _process_loop(self, client_id: str):
        try:
            while client_id in self._clients:
                data = self._clients[client_id]
                async with data["lock"]:
                    frame = data["latest_frame"]
                    context = data["latest_context"]
                    data["latest_frame"] = None
                    data["latest_context"] = None
                if frame is None:
                    break

                # Published before the blocking call so frame_context() is
                # already correct by the time _analyze_frame_blocking runs.
                if context is not None:
                    self._contexts[client_id] = context

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

                # ── Throughput diagnostic ─────────────────────────────────
                # Logged because "the AI is slow" and "the video is arriving
                # slowly" look identical from the UI and have opposite fixes.
                # analysis_ms is what this module costs; delivered fps is what
                # the SOURCE actually supplied. When the second is far below
                # 1000/the first, the bottleneck is upstream of here.
                self._rate_n += 1
                now_m = time.monotonic()
                if self._rate_t0 == 0.0:
                    self._rate_t0 = now_m
                elif now_m - self._rate_t0 >= 10.0:
                    span = now_m - self._rate_t0
                    fps = self._rate_n / span
                    logger.info(
                        f"{self.__class__.__name__} {client_id[:8]}: "
                        f"{fps:.1f} fps analysed over {span:.0f}s "
                        f"(analysis {elapsed_ms:.1f}ms = {1000.0 / max(elapsed_ms, 0.1):.0f} fps "
                        f"capable) - "
                        + ("source-limited" if fps < (1000.0 / max(elapsed_ms, 0.1)) * 0.6
                           else "keeping up")
                    )
                    self._rate_n = 0
                    self._rate_t0 = now_m

                meta = meta or {}
                meta["analysis_time_ms"] = elapsed_ms
                meta["timestamp"] = time.time()
                if context is not None:
                    meta["frame_index"] = context.frame_index
                    # How stale the annotation is by the time anyone sees it.
                    # Distinct from analysis_time_ms, which excludes the wait
                    # in the queue behind a slower frame.
                    meta["capture_age_ms"] = round(
                        (time.monotonic() - context.captured_at) * 1000.0, 1
                    )

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