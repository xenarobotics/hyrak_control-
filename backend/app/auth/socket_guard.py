"""
The one role check every command-type socket event starts with.

    if not await require_operator(sid, "drone_action", data): return

A socket is authenticated once, in server.py's connect handler, and the
user is stamped on its DroneSession (user_id / username / role). Here we
only read that stamp: viewers get an `error` event and False; operators and
admins get an audit line and True. Configured once from server.py so the
event modules keep their single guard line and nothing else.
"""
from __future__ import annotations

import logging

from app.auth import audit
from app.auth.service import role_at_least

logger = logging.getLogger("verocore.auth.socket")

_sio = None
_session_manager = None


def configure(sio, session_manager) -> None:
    global _sio, _session_manager
    _sio = sio
    _session_manager = session_manager


def session_for(sid: str):
    if _session_manager is None:
        return None
    return _session_manager.get_by_socket(sid)


async def require_role(sid: str, min_role: str, event: str, data=None, *, quiet: bool = False) -> bool:
    session = session_for(sid)
    role = getattr(session, "role", None) if session else None
    if session is None or not role or not role_at_least(role, min_role):
        who = getattr(session, "username", None) or sid[:8]
        logger.warning(f"{event}: refused for {who} (role={role or 'none'}, needs {min_role})")
        if _sio is not None:
            try:
                await _sio.emit("error", {
                    "msg": f"{event} requires the {min_role} role",
                    "event": event, "code": "forbidden",
                }, to=sid)
            except Exception:
                pass
        return False
    if not quiet:
        drone = None
        if isinstance(data, dict):
            drone = data.get("drone_id")
        audit.log(session, event, session_id=session.session_id, drone=drone)
    return True


async def require_operator(sid: str, event: str, data=None, *, quiet: bool = False) -> bool:
    """quiet=True for streams (joystick, relay bytes): still gated, not
    audited per packet."""
    return await require_role(sid, "operator", event, data, quiet=quiet)


async def require_admin(sid: str, event: str, data=None) -> bool:
    return await require_role(sid, "admin", event, data)
