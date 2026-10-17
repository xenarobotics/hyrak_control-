"""
GPU-agnostic vision worker pool - lazy loading.
One analyzer per session; the analyzer's WEIGHTS come from the process-wide
model cache (app/vision/model_cache), so two sessions in the same mode, or
a depth session next to avoidance sensing, hold one copy. Analyzers load on
first use and are stopped when switching; the weights outlive them for the
cache's idle grace so a switch back does not re-read the checkpoint.
"""
import asyncio
import logging
import torch
from typing import Dict, Optional, Callable
from app.sessions.models import AnalysisMode
from app.vision.base import BaseAnalyzer

logger = logging.getLogger("verocore.vision.pool")

class VisionWorkerPool:
    """
    Lazy model manager.
    - Models are NOT loaded at startup
    - First request for a mode triggers load
    - Switching modes unloads current model, loads new one
    - torch.cuda.empty_cache() called between loads
    - Manual control mode = no model loaded
    """

    def __init__(self, results_callback: Optional[Callable] = None):
        self._results_callback = results_callback
        # Currently loaded analyzer per session
        self._session_analyzer: Dict[str, BaseAnalyzer]     = {}
        self._session_mode:     Dict[str, AnalysisMode]     = {}
        self._loading:          Dict[str, bool]             = {}
        # The in-flight load per session, so a mode switch that lands while
        # a model is still loading waits for it instead of being skipped
        # (which installed the FIRST mode under the SECOND mode's name).
        self._load_task:        Dict[str, asyncio.Task]     = {}
        # Why the last load failed, for the UI's model_status error.
        self._last_error:       Dict[str, str]              = {}

    def load(self):
        """
        Called at startup - nothing to load eagerly.
        Just validates that imports work.
        """
        try:
            from app.vision.modules.__registry__ import ANALYZER_REGISTRY
            logger.info(f"Vision pool ready - {len(ANALYZER_REGISTRY)} modules available (lazy)")
        except Exception as e:
            logger.error(f"Vision registry error: {e}")

    def get(self, mode: AnalysisMode) -> Optional[BaseAnalyzer]:
        """
        Returns currently loaded analyzer for the given mode.
        Returns None if no session has this mode loaded - 
        use get_for_session for per-session lookup.
        """
        for session_id, analyzer in self._session_analyzer.items():
            if self._session_mode.get(session_id) == mode:
                return analyzer
        return None

    def get_for_session(self, session_id: str) -> Optional[BaseAnalyzer]:
        return self._session_analyzer.get(session_id)

    def register_session(self, session_id: str, mode: AnalysisMode):
        """Called when WebRTC offer arrives - schedule lazy load."""
        if mode == AnalysisMode.MANUAL_CONTROL:
            return
        # Don't reload if the same mode is already loaded - preserves any stored
        # reference embeddings (e.g. person-tracking photo uploaded before streaming)
        if (
            self._session_mode.get(session_id) == mode
            and session_id in self._session_analyzer
        ):
            return
        self._load_task[session_id] = asyncio.create_task(
            self._load_model_for_session(session_id, mode)
        )

    def last_error(self, session_id: str) -> Optional[str]:
        return self._last_error.get(session_id)

    async def _settle_load(self, session_id: str):
        """Wait for any in-flight load for this session to finish."""
        task = self._load_task.get(session_id)
        if task and not task.done():
            try:
                await task
            except Exception:
                pass

    async def switch_mode(
        self, session_id: str, old_mode: AnalysisMode, new_mode: AnalysisMode
    ) -> bool:
        """Unload old model, load new one. Called on set_analysis_mode.
        Returns True when the new mode's analyzer is installed (always True
        for manual control)."""
        if old_mode == new_mode:
            return self._session_mode.get(session_id) == new_mode or new_mode == AnalysisMode.MANUAL_CONTROL

        # A load started by the offer (or a previous switch) may still be
        # running; let it land so the unload below actually removes it.
        await self._settle_load(session_id)

        # Unload current
        await self._unload_session(session_id)

        if new_mode == AnalysisMode.MANUAL_CONTROL:
            logger.info(f"Session {session_id[:8]}: switched to manual - no model")
            return True

        # Load new
        task = asyncio.create_task(self._load_model_for_session(session_id, new_mode))
        self._load_task[session_id] = task
        return await task

    async def _load_model_for_session(self, session_id: str, mode: AnalysisMode) -> bool:
        if self._loading.get(session_id):
            # Another load is in flight for this session. Wait for it, then
            # report whether what it installed is what the caller wanted.
            await self._settle_load(session_id)
            return self._session_mode.get(session_id) == mode

        self._loading[session_id] = True
        self._last_error.pop(session_id, None)
        logger.info(f"Session {session_id[:8]}: loading {mode.value}...")

        try:
            from app.vision.modules.__registry__ import ANALYZER_REGISTRY
            cls = ANALYZER_REGISTRY.get(mode)
            if not cls:
                logger.warning(f"No class for mode {mode.value}")
                self._last_error[session_id] = f"no module for {mode.value}"
                return False

            # Run blocking model load in thread pool
            loop = asyncio.get_running_loop()
            analyzer = await loop.run_in_executor(
                None,
                lambda: cls(results_callback=self._results_callback)
            )

            # Register this session with the new analyzer
            analyzer.register_client(session_id)
            self._session_analyzer[session_id] = analyzer
            self._session_mode[session_id]     = mode

            # Load the enrolled face gallery once, here, rather than per
            # frame - see face_gallery.py: Postgres is the store, RAM is the
            # index. Awaited after register_client so a slow DB delays only
            # gallery matching, never the tracker coming up. A failure is
            # logged and left as an empty gallery: matching nobody is a
            # working tracker, an exception here is no tracker at all.
            if hasattr(analyzer, "set_gallery"):
                try:
                    from app.vision.persistence import load_face_gallery
                    analyzer.set_gallery(await load_face_gallery())
                except Exception as e:
                    logger.warning(
                        f"Session {session_id[:8]}: face gallery unavailable "
                        f"({e}) - gallery mode will match nobody"
                    )

            logger.info(f"✅ Session {session_id[:8]}: {mode.value} ready")
            return True

        except Exception as e:
            logger.error(f"❌ Failed to load {mode.value} for {session_id[:8]}: {e}")
            self._last_error[session_id] = str(e) or e.__class__.__name__
            return False
        finally:
            self._loading[session_id] = False

    async def _unload_session(self, session_id: str):
        await self._settle_load(session_id)
        self._load_task.pop(session_id, None)
        analyzer = self._session_analyzer.pop(session_id, None)
        self._session_mode.pop(session_id, None)

        if analyzer:
            try:
                await analyzer.unregister_client(session_id)
                # Waits (off the loop) for the in-flight inference, then
                # gives the shared weights back to the model cache.
                await analyzer.stop()
            except Exception as e:
                logger.warning(f"Session {session_id[:8]}: analyzer stop failed ({e!r})")

        # Return the activation memory to the driver. On a thread: it is a
        # device sync, and it used to run on the loop BEFORE the cancelled
        # inference had finished (audit V10). Weights stay in the model
        # cache for its idle grace, so a switch back does not reload.
        if torch.cuda.is_available():
            await asyncio.to_thread(torch.cuda.empty_cache)
            logger.info(f"Session {session_id[:8]}: VRAM cleared - "
                       f"{torch.cuda.memory_allocated(0)/1e9:.2f}GB allocated")

    async def unregister_session(self, session_id: str):
        await self._unload_session(session_id)

    def is_loading(self, session_id: str) -> bool:
        return self._loading.get(session_id, False)

    async def stop_all(self):
        for session_id in list(self._session_analyzer.keys()):
            await self._unload_session(session_id)