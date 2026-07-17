"""Socket.IO events for the /admin observer page.

Quick verification tool: an admin socket announces itself with admin_hello
(so it doesn't show up as a client in the session list), then joins/leaves
watch-<session_id> rooms to receive that session's admin_telemetry and
admin_frame mirrors. No credentials beyond the normal socket token for now.
"""
import logging

from app.sessions import observer
from app.sessions.manager import SessionManager

logger = logging.getLogger("verocore.events.admin")


def register_admin_events(sio, session_manager: SessionManager):

    @sio.on("admin_hello")
    async def on_admin_hello(sid, data=None):
        session = session_manager.get_by_socket(sid)
        if session:
            session.is_admin = True
            logger.info(f"Admin observer joined: {sid[:8]}")

    @sio.on("watch_session")
    async def on_watch_session(sid, data):
        session_id = (data or {}).get("session_id")
        if not session_id or not session_manager.get(session_id):
            await sio.emit("error", {"msg": "Session not found"}, to=sid)
            return
        await sio.enter_room(sid, observer.watch_room(session_id))
        observer.watch(session_id, sid)
        logger.info(f"Admin {sid[:8]} watching session {session_id[:8]}")

    @sio.on("unwatch_session")
    async def on_unwatch_session(sid, data):
        session_id = (data or {}).get("session_id")
        if not session_id:
            return
        await sio.leave_room(sid, observer.watch_room(session_id))
        observer.unwatch(session_id, sid)
        logger.info(f"Admin {sid[:8]} stopped watching {session_id[:8]}")
