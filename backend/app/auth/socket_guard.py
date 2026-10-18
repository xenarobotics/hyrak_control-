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

A re-check that the store does not answer within REVALIDATE_TIMEOUT_S
leaves the session UNVERIFIED: session-view events go on with the last
known perms, every command and staff event is refused with
`access_unverified`, except hold / return / land on a held link.

Refusals get an `error` event (with a `code`) and False; accepted commands
get an audit line and True. Configured once from server.py so the event
modules keep their single guard line and nothing else.
"""
from __future__ import annotations

import asyncio
import logging
import time

from app.auth import audit, live_scope, perms
from app.auth import socket_classes as classes
from app.auth.service import SOCKET_REVALIDATE_S, role_at_least, verify_token_hash

logger = logging.getLogger("verocore.auth.socket")

_sio = None
_session_manager = None
# session_id -> the re-check in flight for it (see check_session).
_inflight: dict = {}
# How long a re-check may wait on the store before the session counts as
# UNVERIFIED.
REVALIDATE_TIMEOUT_S = 5.0

FORBIDDEN = "forbidden"
DRONE_NOT_IN_WORKSPACE = "drone_not_in_workspace"
DRONE_UNIDENTIFIED = "drone_unidentified"
ACCESS_UNVERIFIED = "access_unverified"


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


# What a re-check concluded. OK: the stamp is fresh. DENIED: token gone or
# view lost, the socket has been disconnected. UNVERIFIED: the store did not
# answer in time (or errored) - the stamp is stale and cannot be confirmed.
OK, DENIED, UNVERIFIED = "ok", "denied", "unverified"


async def check_session(session) -> str:
    """Bring the session's stamp up to date when it is older than
    SOCKET_REVALIDATE_S, and say how that went (OK / DENIED / UNVERIFIED).

    One re-check per session at a time: socket.io runs every event in its
    own task, so a stream (relay bytes, joystick) arriving while the store
    is slow would otherwise start one lookup per packet. Every caller that
    arrives while a check is in flight awaits THAT check and gets its
    answer - none of them proceeds on the stale stamp in the meantime."""
    token_hash = getattr(session, "token_hash", None)
    if not token_hash:
        return OK            # legacy shared token: nothing to re-check
    now = time.monotonic()
    if now - (getattr(session, "auth_checked_at", 0.0) or 0.0) < SOCKET_REVALIDATE_S:
        return OK
    key = session.session_id
    task = _inflight.get(key)
    if task is None:
        task = asyncio.ensure_future(_revalidate(session, token_hash, now))
        _inflight[key] = task

        def _forget(t, key=key):
            if _inflight.get(key) is t:
                _inflight.pop(key, None)
        task.add_done_callback(_forget)
    # Shielded: a caller that is cancelled must not cancel the check the
    # other callers are waiting on.
    return await asyncio.shield(task)


async def revalidate(session) -> bool:
    """check_session as a yes / no for callers that only need to know whether
    the session still stands: False only when it was DENIED (and
    disconnected). UNVERIFIED counts as standing - see the guards for what
    each one allows on a stamp that could not be re-checked."""
    return await check_session(session) != DENIED


async def _bounded(coro):
    return await asyncio.wait_for(coro, timeout=REVALIDATE_TIMEOUT_S)


async def _revalidate(session, token_hash: str, now: float) -> str:
    try:
        user = await _bounded(verify_token_hash(token_hash))
    except Exception as e:          # TimeoutError included
        logger.warning(f"Session {session.session_id[:8]}: token re-check did not complete "
                       f"({type(e).__name__}: {e}) - commands held back until it does")
        return UNVERIFIED
    if user is None or user.id != session.user_id:
        await _drop(session, "token no longer valid")
        return DENIED
    if session.workspace_id is None:
        # A session stamped before workspaces (tests, or an old build that
        # never set one): the phase 1 rule, staff only.
        if not role_at_least(user.role, "viewer"):
            await _drop(session, "no live access")
            return DENIED
    else:
        try:
            scope = await _bounded(live_scope.rescope(user, session.workspace_id))
        except Exception as e:
            # Not confirmed either way. The guards decide what a stale stamp
            # still allows; the next event tries again.
            logger.warning(f"Session {session.session_id[:8]}: workspace re-check did not complete "
                           f"({type(e).__name__}: {e}) - commands held back until it does")
            return UNVERIFIED
        if scope is None:
            await _drop(session, f"lost view on workspace {session.workspace_id}")
            return DENIED
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
    try:
        # Best effort: on a slow store the previous drone answer stands.
        await _bounded(live_scope.refresh_drone_access(session))
    except Exception as e:
        logger.warning(f"Session {session.session_id[:8]}: drone access re-check did not "
                       f"complete ({type(e).__name__}) - keeping the previous answer")
    return OK


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


_UNVERIFIED_MSG = ("Your access could not be re-checked just now (the server's account store "
                   "is slow to answer), so commands are held back. Hold, return and land still "
                   "work. Try again in a few seconds.")


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
    if session is not None:
        state = await check_session(session)
        if state == DENIED:
            return False
        if state == UNVERIFIED:
            # Staff events change state or reach shared resources: not on a
            # stamp that could not be re-checked.
            return await _refuse(sid, session, event, _UNVERIFIED_MSG, ACCESS_UNVERIFIED)
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
    # UNVERIFIED passes on the last known perms on purpose: these events
    # only show the session its own video, link and params, and cutting the
    # video or the link's downlink because the store was slow for a moment
    # would hurt the pilot more than it protects anyone. A DENIED session
    # is already disconnected.
    if await check_session(session) == DENIED:
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
    state = await check_session(session)
    safety = (event == "drone_action" and classes.is_safety_action(data) and _holds_link(session))
    if state == DENIED:
        # Disconnected: there is no socket left to answer, safety or not.
        # The parked link runs out its grace and PX4's link-loss failsafe
        # takes over.
        return False
    if state == UNVERIFIED and not safety:
        return await _refuse(sid, session, event, _UNVERIFIED_MSG, ACCESS_UNVERIFIED, data)
    staff = _is_staff_session(session)
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
        bypassed = safety and (state != OK or not may_fly or session.drone_fly is not True)
        _audit(session, event, data, " (safety)" if bypassed else "")
    return True
