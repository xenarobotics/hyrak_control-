"""Socket.IO events for the console's observer view (/admin).

A console socket announces itself with admin_hello (so it does not show up
as a client in the session list), then joins / leaves watch-<session_id>
rooms to receive that session's admin_telemetry and admin_frame mirrors.

Phase 2b (docs/ACCESS_MODEL.md 8b): open to all staff, scoped. A founder
watches every session; other staff watch the sessions of workspaces where
they hold `view` (a manager: the customer workspaces they manage). Watching
is view only: telemetry, video and overlays, never control.

Control is the separate takeover (8b "Takeover"): with `sessions.takeover`
on the watched session's workspace, takeover_session puts that session in
TAKEOVER mode (its own commands are refused with `taken_over`, staff
commands naming `target_session` reach its drone) and release_session hands
it back. Quick hold / return / land need no takeover; they are drone_action
with `target_session` (app/auth/socket_guard.py).
"""
import logging

from app.auth import data_scope
from app.auth.socket_guard import require_staff, session_for, takeover_allowed
from app.sessions import observer, takeover
from app.sessions.manager import SessionManager

logger = logging.getLogger("verocore.events.admin")

# Cached at startup (set_sio, called once from server.py) so callers that
# don't otherwise have a handle on the socket.io server - e.g. vision
# analyzer modules, which only see session_id/meta - can still raise an
# admin alert without threading `sio` through every layer down to them.
_sio = None
_session_manager = None


def set_sio(sio) -> None:
    global _sio
    _sio = sio


async def emit_admin_alert(session_manager: SessionManager, payload: dict) -> None:
    """Send one alert to every console observer that may see the session it
    is about (founders: all; other staff: workspaces they can view)."""
    if _sio is None:
        return
    observers = [s for s in session_manager.all_sessions() if s.is_admin]
    if not observers:
        return
    subject = session_manager.get(payload.get("session_id") or "")
    ws = subject.workspace_id if subject is not None else None
    try:
        tree = await data_scope._tree()
    except Exception:
        tree = None
    for s in observers:
        if not data_scope.session_scope(s, tree).can(ws):
            continue
        try:
            await _sio.emit("admin_alert", payload, to=s.socket_id)
        except Exception:
            pass


async def notify_takeover(session, held) -> None:
    """Tell the customer's socket whether HYRAK holds their drone."""
    if _sio is None or session is None or not session.socket_id:
        return
    try:
        await _sio.emit("takeover_status", {
            "active": held is not None,
            **(held.public() if held is not None else {}),
        }, to=session.socket_id)
    except Exception:
        pass


async def end_takeover(t, reason: str) -> None:
    """After a release (manual, staff socket gone, session ended): audit row
    and the customer's banner comes down. The drone keeps its mode."""
    from types import SimpleNamespace
    from app.auth import audit
    from app.auth import service as auth
    target = _session_manager.get(t.target_session_id) if _session_manager is not None else None
    drone = (target.drone or {}) if target is not None else {}
    if target is not None:
        takeover.lock_link(_session_manager.get_telemetry(target.session_id), False)
    actor = SimpleNamespace(id=t.user_id, username=t.username)
    await audit.record(auth.write_store(), actor, "session.release",
                       workspace_id=t.workspace_id, target_type="session",
                       target_id=t.target_session_id,
                       detail={"reason": reason, "drone_id": drone.get("id"),
                               "drone_name": drone.get("name"),
                               "staff_session_id": t.staff_session_id,
                               "held_s": round(__import__("time").time() - t.since, 1)})
    logger.info(f"Takeover of {t.target_session_id[:8]} by {t.username} released ({reason})")
    await notify_takeover(target, None)
    if _sio is not None:
        staff = _session_manager.get(t.staff_session_id) if _session_manager is not None else None
        if staff is not None and staff.socket_id:
            try:
                await _sio.emit("takeover_result", {"session_id": t.target_session_id,
                                                    "active": False, "reason": reason},
                                to=staff.socket_id)
            except Exception:
                pass


async def on_staff_socket_gone(staff_session) -> None:
    """The console socket dropped: release its takeovers after the grace,
    unless that staff session resumes first."""
    async def _released(t):
        await end_takeover(t, "staff_disconnected")
    for t in takeover.schedule_release(staff_session.session_id, _released):
        logger.warning(f"Takeover of {t.target_session_id[:8]}: staff socket gone - releasing in "
                       f"{takeover.RELEASE_GRACE_S:.0f}s unless {t.username} returns")


async def on_session_ended(session_id: str) -> None:
    """A session is torn down: a takeover OF it ends, and one held BY it
    (a console session) is released now."""
    t = takeover.release(session_id)
    if t is not None:
        await end_takeover(t, "session_ended")
    for t in takeover.held_by(session_id):
        takeover.release(t.target_session_id)
        await end_takeover(t, "staff_session_ended")


def register_admin_events(sio, session_manager: SessionManager):
    global _session_manager
    _session_manager = session_manager

    async def _visible(sid, session_id):
        """The watched session if the console socket may see it, else None."""
        me = session_for(sid)
        target = session_manager.get(session_id) if session_id else None
        if me is None or target is None or session_manager.is_observer_only(target):
            return None
        scope = await data_scope.session_scope_now(me)
        return target if scope.can(target.workspace_id) else None

    @sio.on("admin_hello")
    async def on_admin_hello(sid, data=None):
        if not await require_staff(sid, "admin_hello", data, quiet=False): return
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        if session_manager.get_telemetry(session.session_id) is not None or session.is_streaming:
            # A session flying a drone or sending video cannot turn itself
            # into an unlisted observer (it would hide from monitoring and
            # from takeover). Open the console in its own tab.
            await sio.emit("error", {"msg": "This session holds a drone link or video, so it "
                                            "cannot be a console observer. Open the console "
                                            "in its own tab.",
                                     "event": "admin_hello", "code": "forbidden"}, to=sid)
            return
        session.is_admin = True
        logger.info(f"Console observer joined: {sid[:8]} ({session.username})")

    @sio.on("watch_session")
    async def on_watch_session(sid, data):
        if not await require_staff(sid, "watch_session", data, quiet=False): return
        session_id = (data or {}).get("session_id") if isinstance(data, dict) else None
        if await _visible(sid, session_id) is None:
            # Same answer for "gone" and "not yours": no probing session ids.
            await sio.emit("error", {"msg": "Session not found", "event": "watch_session",
                                     "code": "forbidden"}, to=sid)
            return
        await sio.enter_room(sid, observer.watch_room(session_id))
        observer.watch(session_id, sid)
        logger.info(f"Console {sid[:8]} watching session {session_id[:8]}")

    @sio.on("unwatch_session")
    async def on_unwatch_session(sid, data):
        if not await require_staff(sid, "unwatch_session"): return
        session_id = (data or {}).get("session_id") if isinstance(data, dict) else None
        if not session_id:
            return
        await sio.leave_room(sid, observer.watch_room(session_id))
        observer.unwatch(session_id, sid)
        logger.info(f"Console {sid[:8]} stopped watching {session_id[:8]}")

    async def _takeover_refused(sid, event, msg, code="forbidden"):
        await sio.emit("error", {"msg": msg, "event": event, "code": code}, to=sid)
        await sio.emit("takeover_result", {"ok": False, "error": msg, "code": code}, to=sid)

    @sio.on("takeover_session")
    async def on_takeover_session(sid, data):
        if not await require_staff(sid, "takeover_session", data, quiet=False): return
        me = session_for(sid)
        session_id = (data or {}).get("session_id") if isinstance(data, dict) else None
        target = session_manager.get(session_id) if session_id else None
        if (target is None or target is me or session_manager.is_observer_only(target)
                or not await takeover_allowed(me, target)):
            await _takeover_refused(sid, "takeover_session",
                                    "That session is not one you can take control of")
            return
        held = takeover.holder(target.session_id)
        if held is not None and held.staff_session_id != me.session_id:
            await _takeover_refused(sid, "takeover_session",
                                    f"{held.username} already holds control of this session",
                                    "taken_over")
            return
        fresh = held is None
        t = takeover.start(target.session_id, me.session_id, user_id=me.user_id,
                           username=me.username, workspace_id=target.workspace_id)
        if fresh:
            from types import SimpleNamespace
            from app.auth import audit
            from app.auth import service as auth
            drone = target.drone or {}
            await audit.record(auth.write_store(), SimpleNamespace(id=me.user_id, username=me.username),
                               "session.takeover", workspace_id=target.workspace_id,
                               target_type="session", target_id=target.session_id,
                               detail={"customer": target.username, "drone_id": drone.get("id"),
                                       "drone_name": drone.get("name"),
                                       "staff_session_id": me.session_id},
                               ip=me.client_ip or "")
            logger.warning(f"TAKEOVER: {me.username} took control of session "
                           f"{target.session_id[:8]} ({target.username}, drone {drone.get('name')})")
            # Every automated source on the link stops: AI follow,
            # avoidance, the Offboard re-send loop. The staff holder decides.
            takeover.lock_link(session_manager.get_telemetry(target.session_id), True)
            await _stop_ai_steering(session_manager, target)
        await notify_takeover(target, t)
        await sio.emit("takeover_result", {"ok": True, "session_id": target.session_id,
                                           "active": True, **t.public()}, to=sid)

    @sio.on("release_session")
    async def on_release_session(sid, data):
        if not await require_staff(sid, "release_session", data, quiet=False): return
        me = session_for(sid)
        session_id = (data or {}).get("session_id") if isinstance(data, dict) else None
        held = takeover.holder(session_id)
        if held is None or me is None:
            await _takeover_refused(sid, "release_session", "That session is not taken over")
            return
        # The holder releases; so may anyone else allowed to take it over
        # (a founder ending a manager's takeover).
        if held.staff_session_id != me.session_id:
            target = session_manager.get(session_id)
            if not await takeover_allowed(me, target):
                await _takeover_refused(sid, "release_session", "That session is not taken over")
                return
        t = takeover.release(session_id)
        if t is not None:
            await end_takeover(t, "released" if t.staff_session_id == me.session_id
                               else f"released by {me.username}")
        await sio.emit("takeover_result", {"ok": True, "session_id": session_id,
                                           "active": False}, to=sid)


async def _stop_ai_steering(session_manager, target) -> None:
    """Taking over while the session's AI follow flies the drone in Offboard:
    its setpoints stop (stream_track drops them during a takeover), so put
    the drone in HOLD rather than leave PX4 waiting for the offboard-loss
    failsafe. Anything else keeps flying as it is."""
    tel = session_manager.get_telemetry(target.session_id)
    if tel is None or getattr(tel, "_offboard_active", False) is not True:
        return
    try:
        ok = await tel.set_flight_mode("HOLD")
        logger.warning(f"Takeover of {target.session_id[:8]}: AI follow was steering in "
                       f"Offboard - HOLD {'set' if ok else 'refused'}")
    except Exception as e:
        logger.warning(f"Takeover of {target.session_id[:8]}: HOLD after Offboard failed: {e}")
