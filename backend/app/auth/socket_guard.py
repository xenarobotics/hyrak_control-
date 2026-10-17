"""
The one role check every command-type socket event starts with.

    if not await require_operator(sid, "drone_action", data): return

A socket is authenticated in server.py's connect handler and the user is
stamped on its DroneSession (user_id / username / role / token_hash). The
stamp is not trusted forever: every SOCKET_REVALIDATE_S the token hash is
re-checked against the store (it rides the service's 60 s cache, so this
is free in the common case), the role is refreshed, and a socket whose
token has been revoked or whose user was disabled is disconnected.
Viewers get an `error` event and False; operators and admins get an audit
line and True. Configured once from server.py so the event modules keep
their single guard line and nothing else.
"""
from __future__ import annotations

import logging
import time

from app.auth import audit
from app.auth.service import SOCKET_REVALIDATE_S, role_at_least, verify_token_hash

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


async def revalidate(session) -> bool:
    """Re-check the session's token when its last check is stale. Returns
    False (and disconnects the socket) when the token no longer verifies."""
    token_hash = getattr(session, "token_hash", None)
    if not token_hash:
        return True          # legacy shared token: nothing to re-check
    now = time.monotonic()
    if now - (getattr(session, "auth_checked_at", 0.0) or 0.0) < SOCKET_REVALIDATE_S:
        return True
    user = await verify_token_hash(token_hash)
    if user is None or user.id != session.user_id:
        logger.warning(f"Session {session.session_id[:8]} ({session.username}): token no longer "
                       f"valid - disconnecting {str(session.socket_id)[:8]}")
        session.role = None
        if _sio is not None and session.socket_id:
            try:
                await _sio.disconnect(session.socket_id)
            except Exception:
                pass
        return False
    if user.role != session.role:
        logger.info(f"Session {session.session_id[:8]}: role {session.role} -> {user.role}")
    session.role = user.role
    session.username = user.username
    session.auth_checked_at = now
    return True


async def require_role(sid: str, min_role: str, event: str, data=None, *, quiet: bool = False) -> bool:
    session = session_for(sid)
    if session is not None and not await revalidate(session):
        return False
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
