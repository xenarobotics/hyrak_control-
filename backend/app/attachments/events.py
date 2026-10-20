"""
Socket events for attachments (classified in app/auth/socket_classes.py;
the work is in app/attachments/control.py):

  attachment_action {attachment_id, action_id, value?, confirm?}
      SESSION_COMMAND, drone event, routable (a staff session holding the
      takeover sends it with target_session, like drone_action). value is
      the sprayer level, 0..100. An action that can hurt someone needs
      confirm: true. Answered with `attachment_result` {attachment_id,
      action_id, ok, reason_code?, message, ts} and, when a command was
      sent, `attachment_state` {attachments: [{id, last_action_id,
      last_at, ok}]}.
"""
from __future__ import annotations

from app.attachments import control
from app.auth.socket_guard import command_session, require_session_fly


def register_attachment_events(sio, session_manager) -> None:
    control.configure(sio, session_manager)

    @sio.on("attachment_action")
    async def on_attachment_action(sid, data):
        if not await require_session_fly(sid, "attachment_action", data): return
        session = command_session(sid, data)
        if session is None:
            return
        data = data if isinstance(data, dict) else {}
        await control.use(session, data.get("attachment_id"), data.get("action_id"),
                          value=data.get("value"), confirm=data.get("confirm") is True,
                          source="manual", actor_session=session_manager.get_by_socket(sid))
