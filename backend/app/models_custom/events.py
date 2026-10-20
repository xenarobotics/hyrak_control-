"""
Socket events for custom-model rules (classified in
app/auth/socket_classes.py; the work is in app/models_custom/actions.py):

  set_model_control {enabled}       SESSION_COMMAND, drone event
      The pilot's "Allow model control" for this session. Answers with a
      `model_control` push {enabled, reason?, reason_code?, following?}.
  rule_confirm {token, accept}      SESSION_COMMAND, drone event
      The pilot's answer to an "Ask me first" chip. Accept runs the action
      through every guard again; an unknown or expired token answers with
      rule_event status "expired".
"""
from __future__ import annotations

from app.auth.socket_guard import require_session_fly
from app.models_custom import actions


def register_rule_events(sio, session_manager, vision_pool=None) -> None:
    actions.configure(sio, session_manager, vision_pool)

    @sio.on("set_model_control")
    async def on_set_model_control(sid, data):
        if not await require_session_fly(sid, "set_model_control", data): return
        session = session_manager.get_by_socket(sid)
        if session is None:
            return
        enabled = bool(data.get("enabled")) if isinstance(data, dict) else False
        await actions.set_enabled(session, enabled)

    @sio.on("rule_confirm")
    async def on_rule_confirm(sid, data):
        if not await require_session_fly(sid, "rule_confirm", data): return
        session = session_manager.get_by_socket(sid)
        if session is None:
            return
        data = data if isinstance(data, dict) else {}
        await actions.confirm(session, data.get("token"), bool(data.get("accept")))
