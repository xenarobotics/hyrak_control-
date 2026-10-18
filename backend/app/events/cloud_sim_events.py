"""
Cloud simulator socket events (docs/ACCESS_MODEL.md 8c).

    start_cloud_sim   {airframe?, home?: {lat, lon}}   session command (fly)
    stop_cloud_sim                                      session view
    cloud_sim_status                                    session view

All three answer with the status (as the ack and as a `cloud_sim_status`
event), and the server pushes `cloud_sim_status` on every state change:
starting -> ready -> stopping -> none, or error with a code and message.

The cloud simulator is a premium extra: a customer workspace needs the
`cloud_sim` feature (a founder switches it on in the console); staff
sessions can always use it. The customer's default simulator is still
their own PX4 / Gazebo through the desktop app's "SITL" link.

The customer never supplies an address. When the sim is ready the server
links the session's telemetry to the loopback port it chose for it, with
origin start_cloud_sim (a simulator-type link, live_scope.CLOUD_SIM_LINK)
and the sim's synthetic registry identity, so the record is simulated,
never claimed, and never blocks by ownership.

stop_cloud_sim is session VIEW, not command: like disconnect_telemetry,
releasing your own resource never needs more than holding it (a pilot
demoted to viewer mid-session can still stop the sim they started).
"""
from __future__ import annotations

import logging

from app.auth.socket_guard import require_session_fly, require_session_view
from app.sim import manager as sim_manager

logger = logging.getLogger("verocore.events.cloud_sim")


def register_cloud_sim_events(sio, session_manager, links) -> None:
    """`links` is what register_telemetry_events returns: the connect and
    release flows for the session's telemetry link."""
    sims = sim_manager.get_manager()

    async def entitled(session) -> bool:
        if session.is_staff:
            return True
        try:
            from app.auth import live_scope
            tree = await live_scope._tree()
            ws = tree.get(session.workspace_id)
        except Exception as e:
            logger.warning(f"cloud sim entitlement: workspace tree unavailable: {e}")
            return False
        return bool(ws is not None and not ws.disabled and ws.has_feature("cloud_sim"))

    def linked(inst) -> bool:
        tel = session_manager.get_telemetry(inst.session_id)
        return bool(tel is not None and tel.is_connected and tel.address == inst.address)

    async def status_for(session) -> dict:
        inst = sims.for_session(session.session_id)
        return sims.status(session, entitled=await entitled(session),
                           linked=bool(inst and linked(inst)))

    async def push(session_id: str) -> None:
        session = session_manager.get(session_id)
        if session is None or not session.socket_id or session.detached_at is not None:
            return
        await sio.emit("cloud_sim_status", await status_for(session), to=session.socket_id)

    async def link(inst) -> None:
        session = session_manager.get(inst.session_id)
        if session is None or not session.socket_id or session.detached_at is not None:
            return       # linked on the next start_cloud_sim after a resume
        await links.connect(session.socket_id, {"address": inst.address, "link_kind": "local"},
                            origin="start_cloud_sim", identity=inst.hardware_uid)
        await push(inst.session_id)

    async def unlink(inst) -> None:
        session = session_manager.get(inst.session_id)
        if session is None or not linked(inst):
            return
        await links.release(session, session.socket_id)

    def is_active(inst) -> bool:
        """On the ground does not count: the session holds the link to this
        sim and the vehicle is armed."""
        if not linked(inst):
            return False
        tel = session_manager.get_telemetry(inst.session_id)
        try:
            return bool(tel.snapshot.flight_mode.is_armed)
        except Exception:
            return False

    sims.notify = push
    sims.link = link
    sims.unlink = unlink
    sims.is_active = is_active

    async def _reply(sid, session, extra: dict | None = None) -> dict:
        out = await status_for(session)
        if extra:
            out.update(extra)
        await sio.emit("cloud_sim_status", out, to=sid)
        return out

    @sio.on("start_cloud_sim")
    async def on_start_cloud_sim(sid, data=None):
        if not await require_session_fly(sid, "start_cloud_sim", data): return
        session = session_manager.get_by_socket(sid)
        if not session:
            return {"state": "error", "code": "no_session", "error": "No session"}
        data = data if isinstance(data, dict) else {}
        try:
            inst = await sims.start(session, entitled=await entitled(session),
                                    airframe=data.get("airframe") or None,
                                    home=data.get("home") or None)
        except sim_manager.SimRefused as e:
            logger.info(f"start_cloud_sim refused for {session.username}: {e.code}")
            return await _reply(sid, session, {"state": "error", "code": e.code, "error": e.msg})
        # Already running and ready but not linked (after a resume or a
        # disconnect_telemetry): link again.
        if inst.state == sim_manager.READY and not linked(inst):
            await link(inst)
        return await _reply(sid, session)

    @sio.on("stop_cloud_sim")
    async def on_stop_cloud_sim(sid, data=None):
        if not await require_session_view(sid, "stop_cloud_sim"): return
        session = session_manager.get_by_socket(sid)
        if not session:
            return {"state": "none"}
        await sims.stop_for_session(session.session_id, "stopped")
        return await _reply(sid, session)

    @sio.on("cloud_sim_status")
    async def on_cloud_sim_status(sid, data=None):
        if not await require_session_view(sid, "cloud_sim_status"): return
        session = session_manager.get_by_socket(sid)
        if not session:
            return {"state": "none"}
        return await _reply(sid, session)
