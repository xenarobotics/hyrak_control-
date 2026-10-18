"""
Zone enforcement monitor - the server-side supervisory layer.

Fed every telemetry update. Per session it tracks which zone class the
drone is in and reacts on transitions:

  orange - warning to the pilot (`zone_status`) + alert to every admin.
  red    - DANGER to both, and if airborne the pushback engages: the
           session's manual-control lock drops all pilot stick input while
           the drone is commanded (Hold + goto) to the nearest point
           outside the zone, releasing only after it has been clear for a
           few consecutive samples.

Entry into red is also *predicted* ~3 s ahead along the current velocity
vector, so the pushback starts before the boundary is crossed, not after.

Permits (docs/ACCESS_MODEL.md 8b): a zone named by an approved, in-window
permit for this drone (and its current workspace) does not count while the
aircraft is on that permit's path or inside its area - no warning, no
pushback. Everything else about the zone still applies, and the moment the
window ends, the permit is revoked, or the aircraft leaves the permitted
footprint, the zone counts again. The permits are cached per session and
refetched every PERMIT_REFRESH_S or at once after any permit write.

This layer rides the cloud link - the PX4 geofence uploaded at connect
(app/zones/fence.py) remains the hard backstop if the link drops.
"""
import asyncio
import logging
import math
import time

from app.events.admin_events import emit_admin_alert
from app.permits import service as permit_service
from app.zones import engine

logger = logging.getLogger("verocore.zones.monitor")

_PREDICT_S = 3.0
_WARN_REPEAT_S = 5.0     # re-send zone_status while inside a non-green zone
_RELEASE_SAMPLES = 3     # consecutive green samples to release the lock
_PUSH_EXTRA_M = 20.0     # how far beyond the red boundary to push out

_SEVERITY = {"green": 0, "orange": 1, "red": 2}
PERMIT_REFRESH_S = 15.0
_PERMIT_FETCH_TIMEOUT_S = 1.0

# session_id → monitor state
_states: dict[str, dict] = {}
# session_id → {drone_id, workspace_id, gen, at, permits}
_permit_cache: dict[str, dict] = {}


def drop(session_id: str) -> None:
    _states.pop(session_id, None)
    _permit_cache.pop(session_id, None)


async def _permits_for(session) -> list[dict]:
    """The approved permits for the session's drone (current workspace),
    cached. A slow or failed fetch keeps the last answer for the same drone
    and workspace; the window is checked at use, so an expiry still bites
    on time."""
    drone = getattr(session, "drone", None) or None
    if not drone or not drone.get("id"):
        return []
    key = (drone["id"], drone.get("workspace_id"))
    c = _permit_cache.get(session.session_id)
    same = c is not None and (c["drone_id"], c["workspace_id"]) == key
    now = time.monotonic()
    if same and c["gen"] == permit_service.generation() and now - c["at"] < PERMIT_REFRESH_S:
        return c["permits"]
    gen = permit_service.generation()
    try:
        permits = await asyncio.wait_for(permit_service.usable_for_drone(drone),
                                         timeout=_PERMIT_FETCH_TIMEOUT_S)
    except Exception as e:
        logger.debug(f"permit fetch for {session.session_id[:8]} failed: {e}")
        permits = c["permits"] if same else []
    permits = [p for p in permits if permit_service.applies_to_drone(p, drone)]
    _permit_cache[session.session_id] = {"drone_id": key[0], "workspace_id": key[1],
                                         "gen": gen, "at": now, "permits": permits}
    return permits


async def permitted_zone_ids(session, lat: float, lng: float) -> set:
    """Zones the session's drone may be in at (lat, lng) right now."""
    permits = await _permits_for(session)
    if not permits:
        return set()
    return permit_service.permitted_zone_ids_at(permits, lat, lng)


def _worst(zones: list[dict]) -> str:
    return max((z["zone_class"] for z in zones), key=lambda c: _SEVERITY.get(c, 0), default="green")


def current_class(session_id: str) -> str:
    """Last-known zone class for a session - for the sessions API."""
    st = _states.get(session_id)
    return st["cls"] if st else "green"


def _predict(lat: float, lng: float, vel: dict) -> tuple[float, float]:
    vn = vel.get("north_m_s", 0.0) or 0.0
    ve = vel.get("east_m_s", 0.0) or 0.0
    dlat = vn * _PREDICT_S / 111_320
    dlng = ve * _PREDICT_S / (111_320 * max(0.2, math.cos(math.radians(lat))))
    return lat + dlat, lng + dlng


async def _pushback(tel, exit_lat: float, exit_lng: float, abs_alt: float) -> None:
    """Hold, then reposition to the exit point. Best-effort - the FC fence
    is the guarantee; this is the fast path."""
    drone = getattr(tel, "_drone", None)
    if drone is None:
        return
    try:
        await drone.action.hold()
    except Exception:
        pass
    try:
        await drone.action.goto_location(exit_lat, exit_lng, abs_alt, float("nan"))
        logger.info(f"Pushback: goto ({exit_lat:.6f}, {exit_lng:.6f})")
    except Exception as e:
        logger.warning(f"Pushback goto failed: {e}")


async def on_snapshot(sio, session_manager, session, tel, snap: dict) -> None:
    """Called on every telemetry update. Cheap no-op with no zones loaded."""
    pos = snap.get("position", {})
    lat, lng = pos.get("latitude_deg", 0.0), pos.get("longitude_deg", 0.0)
    if not lat and not lng:
        return
    alt = pos.get("relative_altitude_m", 0.0)
    fm = snap.get("flight_mode", {})
    armed, in_air = fm.get("is_armed", False), fm.get("is_in_air", False)

    st = _states.setdefault(session.session_id, {
        "cls": "green", "pushing": False, "clear": 0, "last_status": 0.0,
    })

    res = engine.check_point(lat, lng, alt)
    permits = await _permits_for(session)
    permitted = (permit_service.permitted_zone_ids_at(permits, lat, lng)
                 if permits else set())
    if permitted:
        # Zones this drone is permitted in right here do not count.
        under_permit = [z for z in res["zones"] if z["id"] in permitted]
        res = {"zone_class": _worst([z for z in res["zones"] if z["id"] not in permitted]),
               "zones": [z for z in res["zones"] if z["id"] not in permitted]}
    else:
        under_permit = []
    cls = res["zone_class"]

    red_pred = False
    if cls != "red" and armed and in_air and not st["pushing"]:
        plat, plng = _predict(lat, lng, snap.get("velocity", {}))
        # predict_red uses zones eroded by ~5 m - skimming along a red
        # boundary (edge-to-edge with orange) must not trip the pushback
        pred_ids = engine.predict_red_ids(plat, plng, alt)
        if pred_ids and permits:
            pred_ids -= permit_service.permitted_zone_ids_at(permits, plat, plng)
        red_pred = bool(pred_ids)

    now = time.time()
    permit_names = ", ".join(z["name"] for z in under_permit) or None
    permit_changed = permit_names != st.get("permit_names")
    st["permit_names"] = permit_names
    changed = cls != st["cls"]
    zone_names = ", ".join(z["name"] for z in res["zones"]) or None
    drone_name = (session.drone or {}).get("name") or f"session {session.session_id[:8]}"

    # ── Pilot status (on change, and repeated while non-green) ──────────
    if changed or permit_changed or (cls != "green" and now - st["last_status"] > _WARN_REPEAT_S) or red_pred:
        st["last_status"] = now
        msg = None
        if cls == "orange":
            msg = f"WARNING - inside restricted (orange) zone{f': {zone_names}' if zone_names else ''}"
        elif cls == "red":
            msg = f"DANGER - inside NO-FLY (red) zone{f': {zone_names}' if zone_names else ''}"
        elif red_pred:
            msg = "DANGER - approaching NO-FLY (red) zone"
        elif permit_names:
            msg = f"Inside restricted airspace under permit: {permit_names}"
        elif changed or permit_changed:
            msg = "Clear of restricted zones"
        if msg:
            await sio.emit("zone_status", {
                "zone_class": "red" if red_pred and cls != "red" else cls,
                "zones": res["zones"],
                "permitted_zones": under_permit,
                "locked": st["pushing"],
                "message": msg,
            }, to=session.socket_id)

    # ── Admin alerts (transitions only) ─────────────────────────────────
    if changed:
        if cls == "orange":
            await emit_admin_alert(session_manager, {
                "level": "warning", "session_id": session.session_id,
                "drone": drone_name, "ts": now,
                "message": f"{drone_name} entered ORANGE zone{f' {zone_names}' if zone_names else ''}",
            })
        elif cls == "red":
            await emit_admin_alert(session_manager, {
                "level": "danger", "session_id": session.session_id,
                "drone": drone_name, "ts": now,
                "message": f"{drone_name} entered RED zone{f' {zone_names}' if zone_names else ''}",
            })
        elif st["cls"] in ("orange", "red"):
            await emit_admin_alert(session_manager, {
                "level": "info", "session_id": session.session_id,
                "drone": drone_name, "ts": now,
                "message": f"{drone_name} clear of restricted zones",
            })
    st["cls"] = cls

    # ── Red enforcement ─────────────────────────────────────────────────
    if (cls == "red" or red_pred) and armed and in_air and not st["pushing"]:
        st["pushing"] = True
        st["clear"] = 0
        session.zone_lock = True
        exit_pt = engine.nearest_exit(lat, lng, _PUSH_EXTRA_M, exclude=permitted)
        if exit_pt is None and red_pred:
            # not inside yet - hold short of the boundary instead
            exit_pt = (lat, lng)
        await sio.emit("zone_status", {
            "zone_class": "red", "zones": res["zones"], "locked": True,
            "message": "CONTROLS LOCKED - pushing back out of NO-FLY zone",
        }, to=session.socket_id)
        await emit_admin_alert(session_manager, {
            "level": "danger", "session_id": session.session_id,
            "drone": drone_name, "ts": now,
            "message": f"{drone_name}: RED-zone pushback engaged - pilot controls locked",
        })
        if exit_pt:
            abs_alt = pos.get("absolute_altitude_m", 0.0)
            asyncio.create_task(_pushback(tel, exit_pt[0], exit_pt[1], abs_alt))

    elif st["pushing"]:
        if cls == "green" and not red_pred:
            st["clear"] += 1
        else:
            st["clear"] = 0
            if cls == "red":
                # still inside (drift/wind) - refresh the goto occasionally
                if now - st.get("last_push", 0) > 5.0:
                    st["last_push"] = now
                    exit_pt = engine.nearest_exit(lat, lng, _PUSH_EXTRA_M, exclude=permitted)
                    if exit_pt:
                        asyncio.create_task(_pushback(
                            tel, exit_pt[0], exit_pt[1], pos.get("absolute_altitude_m", 0.0)
                        ))
        if st["clear"] >= _RELEASE_SAMPLES or not armed:
            st["pushing"] = False
            session.zone_lock = False
            await sio.emit("zone_status", {
                "zone_class": cls, "zones": res["zones"], "locked": False,
                "message": "Clear of NO-FLY zone - controls returned",
            }, to=session.socket_id)
            await emit_admin_alert(session_manager, {
                "level": "info", "session_id": session.session_id,
                "drone": drone_name, "ts": now,
                "message": f"{drone_name}: pushback complete - controls returned to pilot",
            })
