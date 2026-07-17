"""
Socket events for the red-zone permit workflow (pilot side).
Permits are tied to the connected drone's identity, so a drone must be
identified before requesting one. Admin review happens over REST
(/api/permits) from the admin console.
"""
import logging

logger = logging.getLogger("verocore.events.permits")


def register_permit_events(sio, session_manager):
    @sio.on("request_permit")
    async def on_request_permit(sid, data):
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        if not session.drone:
            await sio.emit("permit_result", {
                "ok": False,
                "msg": "Connect a drone first — permits are tied to the drone's identity",
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
        check = zone_engine.check_path(
            [(float(w["lat"]), float(w["lng"])) for w in waypoints]
        )
        red_zones = [z for z in check["zones"] if z["zone_class"] == "red"]
        if not red_zones:
            await sio.emit("permit_result", {
                "ok": False, "msg": "This mission doesn't cross any red zone — no permit needed",
            }, to=sid)
            return

        from app.permits import service
        permit = await service.create(
            session.drone["id"], description, waypoints, red_zones
        )
        if permit is None:
            await sio.emit("permit_result", {
                "ok": False, "msg": "Database offline — try again later",
            }, to=sid)
            return
        await sio.emit("permit_result", {
            "ok": True, "permit": permit,
            "msg": "Permit requested — awaiting admin approval. "
                   "Upload the SAME mission again once approved.",
        }, to=sid)

    @sio.on("list_my_permits")
    async def on_list_my_permits(sid, data=None):
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        if not session.drone:
            await sio.emit("my_permits", {"permits": []}, to=sid)
            return
        from app.permits import service
        permits = await service.list_permits(
            drone_id=session.drone["id"], include_waypoints=True
        )
        await sio.emit("my_permits", {"permits": permits}, to=sid)
