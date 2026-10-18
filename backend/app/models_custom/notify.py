"""
Socket pushes for the model library, and the hooks into live sessions.

  * `model_status {id, workspace_id, version, status, step, progress,
    error, hint, detail, current_version}` goes to every live socket of the
    model's workspace whenever a check moves on (step: received,
    downloading, inspecting, testing, done; `status` says whether done
    means ready or failed; `progress` 0 to 1).
    The event name is shared with the AI-mode loading status
    (`{status: loading|ready|error, mode}`); a library push always carries
    `id`, a mode push never does.
  * `model_alert` goes to the one session whose custom model saw what its
    alert rule asks for (see analyzer.py).
  * When a model is deleted or its runner must go, sessions running it are
    switched back to manual control.

Configured once from server.py; every function is a no-op until then
(unit tests, the CLI).
"""
from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger("verocore.models.notify")

_sio = None
_session_manager = None
_vision_pool = None


def configure(sio, session_manager, vision_pool=None) -> None:
    global _sio, _session_manager, _vision_pool
    _sio, _session_manager, _vision_pool = sio, session_manager, vision_pool


def _workspace_sockets(workspace_id: str) -> list[str]:
    if _session_manager is None:
        return []
    out = []
    for s in _session_manager.all_sessions():
        if s.workspace_id == workspace_id and s.socket_id and s.detached_at is None:
            out.append(s.socket_id)
    return out


# Rough share of a check done when each step starts, for a progress bar.
PROGRESS = {"received": 0.1, "downloading": 0.1, "inspecting": 0.4, "testing": 0.7, "done": 1.0}


async def model_status(rec, *, step: str, version: Optional[int] = None,
                       error: str = "", hint: str = "", detail: str = "") -> dict:
    payload = {"id": rec.id, "workspace_id": rec.workspace_id, "version": version,
               "status": rec.status, "step": step, "progress": PROGRESS.get(step),
               "error": error or None,
               "hint": hint or None, "detail": detail or None,
               "current_version": rec.current_version}
    if _sio is None:
        return payload
    for sid in _workspace_sockets(rec.workspace_id):
        try:
            await _sio.emit("model_status", payload, to=sid)
        except Exception as e:
            logger.debug(f"model_status to {sid[:8]} failed: {e}")
    return payload


async def model_alert(session_id: str, payload: dict) -> None:
    if _sio is None or _session_manager is None:
        return
    s = _session_manager.get(session_id)
    if s is None or not s.socket_id:
        return
    try:
        await _sio.emit("model_alert", payload, to=s.socket_id)
    except Exception as e:
        logger.debug(f"model_alert to {session_id[:8]} failed: {e}")


async def stop_sessions_running(model_id: Optional[str], reason: str, *,
                                via_catalogue: Optional[bool] = None,
                                workspace_id: Optional[str] = None,
                                skip_staff: bool = False) -> int:
    """Put sessions running a custom model back on manual control: those
    running `model_id` (None: any custom model), only on the catalogue path
    or only on their own copy when `via_catalogue` says so, only in
    `workspace_id` when given. Returns how many were switched."""
    if _session_manager is None:
        return 0
    from app.sessions.models import AnalysisMode
    n = 0
    for s in list(_session_manager.all_sessions()):
        mode = s.mode
        spec = getattr(mode, "spec", None)
        if spec is None or not hasattr(mode, "model_id"):
            continue
        if model_id is not None and mode.model_id != model_id:
            continue
        if via_catalogue is not None and bool(spec.via_catalogue) != via_catalogue:
            continue
        if workspace_id is not None and s.workspace_id != workspace_id:
            continue
        if skip_staff and s.is_staff:
            continue
        _session_manager.set_mode(s.session_id, AnalysisMode.MANUAL_CONTROL)
        if _vision_pool is not None:
            try:
                await _vision_pool.switch_mode(s.session_id, mode, AnalysisMode.MANUAL_CONTROL)
            except Exception as e:
                logger.warning(f"Session {s.session_id[:8]}: stopping model failed ({e!r})")
        n += 1
        if _sio is not None and s.socket_id:
            try:
                await _sio.emit("mode_changed", {"mode": AnalysisMode.MANUAL_CONTROL.value},
                                to=s.socket_id)
                await _sio.emit("error", {"msg": reason, "event": "set_analysis_mode",
                                          "code": "model_removed"}, to=s.socket_id)
            except Exception:
                pass
    return n
