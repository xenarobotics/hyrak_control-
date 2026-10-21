"""
Socket events for HYRAK Copilot (classified in app/auth/socket_classes.py as
SESSION_COMMAND and DRONE_EVENTS; the work is in app/copilot/service.py):

  copilot_set {enabled}                 on / off for this session
  copilot_audio {audio: bytes, mime}    one push-to-talk recording, <= 1.5 MB
  copilot_text {text}                   a typed command, <= 500 chars
  copilot_confirm {token, accept}       yes / no to a plan card
  copilot_choose {token, index}         which candidate target (1-based)
  copilot_cancel {}                     the open card declined, the task stopped with HOLD
  copilot_pilot_position {lat, lon, accuracy_m}   only used while follow-me runs

Pushes (socket_classes.PUSHED_EVENTS, to the session's own socket):
copilot_state, copilot_message, copilot_card_update.
"""
from __future__ import annotations

import logging

from app.auth.socket_guard import require_session_fly
from app.copilot import service

logger = logging.getLogger("verocore.copilot.events")


def register_copilot_events(sio, session_manager, vision_pool=None) -> None:
    service.configure(sio, session_manager, vision_pool)

    def _data(data) -> dict:
        return data if isinstance(data, dict) else {}

    @sio.on("copilot_set")
    async def on_copilot_set(sid, data):
        if not await require_session_fly(sid, "copilot_set", data): return
        session = session_manager.get_by_socket(sid)
        if session is None:
            return
        await service.set_enabled(session, bool(_data(data).get("enabled")))

    @sio.on("copilot_audio")
    async def on_copilot_audio(sid, data):
        if not await require_session_fly(sid, "copilot_audio", None): return
        session = session_manager.get_by_socket(sid)
        if session is None:
            return
        d = _data(data)
        await service.handle_audio(session, d.get("audio"), str(d.get("mime") or "")[:80])

    @sio.on("copilot_text")
    async def on_copilot_text(sid, data):
        if not await require_session_fly(sid, "copilot_text", data): return
        session = session_manager.get_by_socket(sid)
        if session is None:
            return
        text = _data(data).get("text")
        if not isinstance(text, str):
            return
        await service.handle_text(session, text[:service.MAX_TEXT])

    @sio.on("copilot_confirm")
    async def on_copilot_confirm(sid, data):
        if not await require_session_fly(sid, "copilot_confirm", data): return
        session = session_manager.get_by_socket(sid)
        if session is None:
            return
        d = _data(data)
        await service.confirm(session, d.get("token"), bool(d.get("accept")))

    @sio.on("copilot_choose")
    async def on_copilot_choose(sid, data):
        if not await require_session_fly(sid, "copilot_choose", data): return
        session = session_manager.get_by_socket(sid)
        if session is None:
            return
        d = _data(data)
        await service.choose(session, d.get("token"), d.get("index"))

    @sio.on("copilot_cancel")
    async def on_copilot_cancel(sid, data=None):
        if not await require_session_fly(sid, "copilot_cancel", data): return
        session = session_manager.get_by_socket(sid)
        if session is None:
            return
        await service.cancel(session)

    @sio.on("copilot_pilot_position")
    async def on_copilot_pilot_position(sid, data):
        if not await require_session_fly(sid, "copilot_pilot_position", data, quiet=True): return
        session = session_manager.get_by_socket(sid)
        if session is None:
            return
        await service.pilot_position(session, _data(data))
