"""
Socket events for the permit workflow, staff side (swarm / fleet drones).
Permits are tied to the connected drone's identity, so a drone must be
identified before requesting one. Customers (and the Mission tab for a
single drone) use REST /api/permits instead (app/permits/routes.py), which
also carries the time window; a socket request gets PERMIT_WINDOW_H from
now. Review happens over REST from the console (docs/ACCESS_MODEL.md 8b).
"""
import logging
from datetime import timedelta
from types import SimpleNamespace

from app.auth.socket_guard import require_operator, require_staff

logger = logging.getLogger("verocore.events.permits")

PERMIT_WINDOW_H = 24


def register_permit_events(sio, session_manager):
    def _resolve_drone_rec_id(session, data) -> str | None:
        """Permit owner: the session's identified drone, or - in swarm mode -
        the fleet drone the client names via fleet_drone_id."""
        fleet_id = data.get("fleet_drone_id") if isinstance(data, dict) else None
        if fleet_id is not None:
            from app.events.swarm_events import _fleet_db_ids
            # Keyed by (session_id, drone_id), see swarm_events._fleet_db_ids.
            return _fleet_db_ids.get((session.session_id, int(fleet_id)))
        return session.drone["id"] if session.drone else None

    @sio.on("request_permit")
    async def on_request_permit(sid, data):
        if not await require_operator(sid, "request_permit", data): return
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        drone_rec_id = _resolve_drone_rec_id(session, data)
        if not drone_rec_id:
            await sio.emit("permit_result", {
                "ok": False,
                "msg": "Connect a drone first - permits are tied to the drone's identity",
            }, to=sid)
            return
        waypoints = data.get("waypoints") or []
        description = (data.get("description") or "").strip()
        if not waypoints or not description:
            await sio.emit("permit_result", {
                "ok": False, "msg": "A mission and a written justification are required",
            }, to=sid)
            return

        from app.zones import engine as zone_engine
        from app.permits import service
        try:
            check = zone_engine.check_path(
                [(float(w["lat"]), float(w["lng"])) for w in waypoints]
            )
        except (KeyError, TypeError, ValueError):
            await sio.emit("permit_result", {"ok": False, "msg": "Bad waypoints"}, to=sid)
            return
        red, orange, prohibited = service.split_zones(check["zones"])
        if prohibited:
            await sio.emit("permit_result", {
                "ok": False, "msg": "This mission crosses a prohibited zone - no permit can be issued",
            }, to=sid)
            return
        if not red:
            await sio.emit("permit_result", {
                "ok": False, "msg": "This mission doesn't cross any red zone - no permit needed",
            }, to=sid)
            return

        from app.auth import audit
        from app.auth import service as auth
        from app.auth.store import PLATFORM_WORKSPACE_ID
        try:
            drone = await auth.read_store().get_drone(drone_rec_id)
        except Exception:
            drone = None
        ws_id = (drone or {}).get("workspace_id") or PLATFORM_WORKSPACE_ID
        now = service.now_utc()
        permit = await service.create(
            workspace_id=ws_id, description=description, waypoints=waypoints,
            zones=red + orange, drone_id=drone_rec_id,
            valid_from=now, valid_until=now + timedelta(hours=PERMIT_WINDOW_H),
            requested_by=session.user_id, requested_by_name=session.username or "",
        )
        if permit is None:
            await sio.emit("permit_result", {
                "ok": False, "msg": "Database offline - try again later",
            }, to=sid)
            return
        actor = SimpleNamespace(id=session.user_id, username=session.username)
        await audit.record(auth.write_store(), actor, "permit.request", workspace_id=ws_id,
                           target_type="permit", target_id=permit["id"],
                           detail={"kind": "mission", "drone_id": drone_rec_id,
                                   "zones": [z["name"] for z in red + orange],
                                   "valid_from": permit["valid_from"],
                                   "valid_until": permit["valid_until"], "via": "socket"},
                           ip=session.client_ip or "")
        await sio.emit("permit_result", {
            "ok": True, "permit": permit,
            "msg": f"Permit requested for the next {PERMIT_WINDOW_H} h - awaiting approval. "
                   "Upload the SAME mission again once approved.",
        }, to=sid)

    @sio.on("list_my_permits")
    async def on_list_my_permits(sid, data=None):
        if not await require_staff(sid, "list_my_permits"): return
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        drone_rec_id = _resolve_drone_rec_id(session, data or {})
        if not drone_rec_id:
            await sio.emit("my_permits", {"permits": []}, to=sid)
            return
        from app.permits import service
        permits = await service.list_permits(
            drone_id=drone_rec_id, include_waypoints=True
        )
        for p in permits:
            p["status_effective"] = service.effective_status(p)
            p["in_window"] = service.in_window(p)
        await sio.emit("my_permits", {"permits": permits}, to=sid)
