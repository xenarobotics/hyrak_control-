"""
The one access check every socket event starts with.

    if not await require_session_fly(sid, "drone_action", data): return

A socket is authenticated in server.py's connect handler and the user is
stamped on its DroneSession: user_id / username / role / token_hash, plus
the session's workspace, the user's perms on it and is_staff
(docs/ACCESS_MODEL.md 8a, app/auth/live_scope.py). The stamp is not
trusted forever: every SOCKET_REVALIDATE_S the token hash is re-checked
against the store (it rides the service's 60 s cache, so this is free in
the common case), the role and perms are refreshed, and a socket whose
token was revoked, whose user was disabled, or (customers) who lost `view`
on the session's workspace is disconnected.

Which guard an event uses is decided in one table, app/auth/socket_classes.py:

  * require_session_view - the session's own video, link, params read.
    Staff: signed in. Customers: `view` on the session workspace.
  * require_session_fly - commands. Staff: the compatibility operator rank.
    Customers: `fly` on the session workspace. Events that act on the
    vehicle (socket_classes.DRONE_EVENTS) also need `fly` on the DRONE's
    workspace; hold / return / land on a link the session holds are never
    refused (socket_classes.SAFETY_ACTIONS).
  * require_operator / require_admin / require_staff - the compatibility
    rank, which only staff hold (a customer-only account ranks "member").
    Everything not explicitly moved to the session guards stays here.

Refusals get an `error` event (with a `code`) and False; accepted commands
get an audit line and True. Configured once from server.py so the event
modules keep their single guard line and nothing else.
"""
from __future__ import annotations

import logging
import time

from app.auth import audit, live_scope, perms
from app.auth import socket_classes as classes
from app.auth.service import SOCKET_REVALIDATE_S, role_at_least, verify_token_hash

logger = logging.getLogger("verocore.auth.socket")

_sio = None
_session_manager = None

FORBIDDEN = "forbidden"
DRONE_NOT_IN_WORKSPACE = "drone_not_in_workspace"
DRONE_UNIDENTIFIED = "drone_unidentified"


def configure(sio, session_manager) -> None:
    global _sio, _session_manager
    _sio = sio
    _session_manager = session_manager


def session_for(sid: str):
    if _session_manager is None:
        return None
    return _session_manager.get_by_socket(sid)


async def _drop(session, why: str) -> None:
    logger.warning(f"Session {session.session_id[:8]} ({session.username}): {why} - "
                   f"disconnecting {str(session.socket_id)[:8]}")
    session.role = None
    session.perms = frozenset()
    if _sio is not None and session.socket_id:
        try:
            await _sio.disconnect(session.socket_id)
        except Exception:
            pass


async def revalidate(session) -> bool:
    """Re-check the session's token, role and workspace perms when its last
    check is stale. Returns False (and disconnects the socket) when the
    token no longer verifies or a customer lost `view` on the workspace."""
    token_hash = getattr(session, "token_hash", None)
    if not token_hash:
        return True          # legacy shared token: nothing to re-check
    now = time.monotonic()
    if now - (getattr(session, "auth_checked_at", 0.0) or 0.0) < SOCKET_REVALIDATE_S:
        return True
    user = await verify_token_hash(token_hash)
    if user is None or user.id != session.user_id:
        await _drop(session, "token no longer valid")
        return False
    if session.workspace_id is None:
        # A session stamped before workspaces (tests, or an old build that
        # never set one): the phase 1 rule, staff only.
        if not role_at_least(user.role, "viewer"):
            await _drop(session, "no live access")
            return False
    else:
        try:
            scope = await live_scope.rescope(user, session.workspace_id)
        except Exception as e:
            # Keep the previous scope through a database blip rather than
            # drop a pilot mid-flight; the next check tries again.
            logger.warning(f"Session {session.session_id[:8]}: workspace re-check failed ({e}) - "
                           f"keeping the previous perms")
        else:
            if scope is None:
                await _drop(session, f"lost view on workspace {session.workspace_id}")
                return False
            if scope.perms != session.perms:
                logger.info(f"Session {session.session_id[:8]}: perms on {scope.workspace_id[:8]} "
                            f"-> {sorted(scope.perms)}")
            live_scope.stamp(session, user, scope)
    if user.role != session.role:
        logger.info(f"Session {session.session_id[:8]}: role {session.role} -> {user.role}")
    session.role = user.role
    session.username = user.username
    session.memberships = tuple(user.memberships)
    session.auth_checked_at = now
    await live_scope.refresh_drone_access(session)
    return True


async def _refuse(sid: str, session, event: str, msg: str, code: str = FORBIDDEN,
                  data=None) -> bool:
    who = getattr(session, "username", None) or sid[:8]
    logger.warning(f"{event}: refused for {who} ({code}: {msg})")
    if _sio is not None:
        try:
            await _sio.emit("error", {"msg": msg, "event": event, "code": code}, to=sid)
            if event == "drone_action" and isinstance(data, dict):
                # The button waits for an action_result; give it one.
                await _sio.emit("action_result", {"action": data.get("action"), "ok": False,
                                                  "error": msg, "code": code}, to=sid)
        except Exception:
            pass
    return False


def _audit(session, event: str, data, note: str = "") -> None:
    drone = None
    if isinstance(data, dict):
        drone = data.get("drone_id")
    audit.log(session, event + note, session_id=session.session_id, drone=drone)


def _is_staff_session(session) -> bool:
    if session.workspace_id is None:
        # Unscoped (see revalidate): the compatibility rank decides.
        return role_at_least(session.role or "member", "viewer")
    return bool(session.is_staff)


async def require_role(sid: str, min_role: str, event: str, data=None, *, quiet: bool = False) -> bool:
    session = session_for(sid)
    if session is not None and not await revalidate(session):
        return False
    role = getattr(session, "role", None) if session else None
    # The compatibility rank is held only by staff (perms.compat_role), so
    # this alone keeps these events staff-only; a scoped customer session
    # is refused outright as a second line.
    staff_ok = session is not None and (session.workspace_id is None or session.is_staff)
    if session is None or not role or not role_at_least(role, min_role) or not staff_ok:
        return await _refuse(sid, session, event, f"{event} requires the {min_role} role")
    if not quiet:
        _audit(session, event, data)
    return True


async def require_operator(sid: str, event: str, data=None, *, quiet: bool = False) -> bool:
    """quiet=True for streams (joystick, relay bytes): still gated, not
    audited per packet."""
    return await require_role(sid, "operator", event, data, quiet=quiet)


async def require_admin(sid: str, event: str, data=None) -> bool:
    return await require_role(sid, "admin", event, data)


async def require_staff(sid: str, event: str, data=None, *, quiet: bool = True) -> bool:
    """Staff at any rank: for the events that used to be open to any signed-in
    socket but reach a shared server resource (relay ports, the wall, the
    RC monitor). Quiet by default: they are housekeeping, not commands."""
    return await require_role(sid, "viewer", event, data, quiet=quiet)


async def require_session_view(sid: str, event: str, data=None) -> bool:
    """The session's own video, link and params read. Never audited: these
    are streams and reads."""
    session = session_for(sid)
    if session is None:
        return await _refuse(sid, None, event, "No session")
    if not await revalidate(session):
        return False
    if _is_staff_session(session) or perms.VIEW in (session.perms or frozenset()):
        return True
    return await _refuse(sid, session, event, f"{event} needs view access on this workspace")


def _holds_link(session) -> bool:
    return _session_manager is not None and _session_manager.get_telemetry(session.session_id) is not None


async def require_session_fly(sid: str, event: str, data=None, *, quiet: bool = False) -> bool:
    """Commands. The session's right to fly (staff: operator rank;
    customers: `fly` on the session workspace), then, for events that act
    on the vehicle, drone access. Hold / return / land on a held link pass
    both checks: see socket_classes.SAFETY_ACTIONS."""
    session = session_for(sid)
    if session is None:
        return await _refuse(sid, None, event, "No session", data=data)
    if not await revalidate(session):
        return False
    staff = _is_staff_session(session)
    safety = (event == "drone_action" and classes.is_safety_action(data) and _holds_link(session))
    if staff:
        may_fly = role_at_least(session.role or "member", "operator")
    else:
        may_fly = perms.FLY in (session.perms or frozenset())
    if not may_fly and not safety:
        need = "the operator role" if staff else "fly access on this workspace"
        return await _refuse(sid, session, event, f"{event} needs {need}", data=data)

    if event in classes.DRONE_EVENTS and _holds_link(session) and not safety:
        access = session.drone_fly
        if access is False:
            return await _refuse(
                sid, session, event,
                "This drone belongs to a workspace where you cannot fly, so it is read-only "
                "in this session. Ask its owner to move it to your workspace.",
                DRONE_NOT_IN_WORKSPACE, data)
        if access is None and not staff:
            # Customers command only a drone known to be theirs. Staff keep
            # today's behaviour while the identity is still being read.
            return await _refuse(
                sid, session, event,
                "This drone has not been identified yet, so commands are held back. Wait a "
                "few seconds after connecting; if it persists, the flight controller did not "
                "report a hardware ID or the drone registry is offline.",
                DRONE_UNIDENTIFIED, data)

    if not quiet:
        bypassed = safety and (not may_fly or session.drone_fly is not True)
        _audit(session, event, data, " (safety)" if bypassed else "")
    return True
