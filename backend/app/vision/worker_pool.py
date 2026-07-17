"""
GPU-agnostic vision worker pool — lazy loading.
Only one model loaded in VRAM at a time per session.
Models load on first use and unload when switching.
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

    def load(self):
        """
        Called at startup — nothing to load eagerly.
        Just validates that imports work.
        """
        try:
            from app.vision.modules.__registry__ import ANALYZER_REGISTRY
            logger.info(f"Vision pool ready — {len(ANALYZER_REGISTRY)} modules available (lazy)")
        except Exception as e:
            logger.error(f"Vision registry error: {e}")

    def get(self, mode: AnalysisMode) -> Optional[BaseAnalyzer]:
        """
        Returns currently loaded analyzer for the given mode.
        Returns None if no session has this mode loaded — 
        use get_for_session for per-session lookup.
        """
        for session_id, analyzer in self._session_analyzer.items():
            if self._session_mode.get(session_id) == mode:
                return analyzer
        return None

    def get_for_session(self, session_id: str) -> Optional[BaseAnalyzer]:
        return self._session_analyzer.get(session_id)

    def register_session(self, session_id: str, mode: AnalysisMode):
        """Called when WebRTC offer arrives — schedule lazy load."""
        if mode == AnalysisMode.MANUAL_CONTROL:
            return
        # Don't reload if the same mode is already loaded — preserves any stored
        # reference embeddings (e.g. person-tracking photo uploaded before streaming)
        if (
            self._session_mode.get(session_id) == mode
            and session_id in self._session_analyzer
        ):
            return
        asyncio.create_task(self._load_model_for_session(session_id, mode))

    async def switch_mode(
        self, session_id: str, old_mode: AnalysisMode, new_mode: AnalysisMode
    ):
        """Unload old model, load new one. Called on set_analysis_mode."""
        if old_mode == new_mode:
            return

        # Unload current
        await self._unload_session(session_id)

        if new_mode == AnalysisMode.MANUAL_CONTROL:
            logger.info(f"Session {session_id[:8]}: switched to manual — no model")
            return

        # Load new
        await self._load_model_for_session(session_id, new_mode)

    async def _load_model_for_session(self, session_id: str, mode: AnalysisMode):
        if self._loading.get(session_id):
            return

        self._loading[session_id] = True
        logger.info(f"Session {session_id[:8]}: loading {mode.value}...")

        try:
            from app.vision.modules.__registry__ import ANALYZER_REGISTRY
            cls = ANALYZER_REGISTRY.get(mode)
            if not cls:
                logger.warning(f"No class for mode {mode.value}")
                return

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

            logger.info(f"✅ Session {session_id[:8]}: {mode.value} ready")

        except Exception as e:
            logger.error(f"❌ Failed to load {mode.value} for {session_id[:8]}: {e}")
        finally:
            self._loading[session_id] = False

    async def _unload_session(self, session_id: str):
        analyzer = self._session_analyzer.pop(session_id, None)
        self._session_mode.pop(session_id, None)

        if analyzer:
            try:
                await analyzer.unregister_client(session_id)
                await analyzer.stop()
            except Exception:
                pass

        # Free VRAM
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            logger.info(f"Session {session_id[:8]}: VRAM cleared — "
                       f"{torch.cuda.memory_allocated(0)/1e9:.2f}GB allocated")

    async def unregister_session(self, session_id: str):
        await self._unload_session(session_id)

    def is_loading(self, session_id: str) -> bool:
        return self._loading.get(session_id, False)

    async def stop_all(self):
        for session_id in list(self._session_analyzer.keys()):
            await self._unload_session(session_id)