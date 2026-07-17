"""
Zone enforcement monitor — the server-side supervisory layer.

Fed every telemetry update. Per session it tracks which zone class the
drone is in and reacts on transitions:

  orange — warning to the pilot (`zone_status`) + alert to every admin.
  red    — DANGER to both, and if airborne the pushback engages: the
           session's manual-control lock drops all pilot stick input while
           the drone is commanded (Hold + goto) to the nearest point
           outside the zone, releasing only after it has been clear for a
           few consecutive samples.

Entry into red is also *predicted* ~3 s ahead along the current velocity
vector, so the pushback starts before the boundary is crossed, not after.

This layer rides the cloud link — the PX4 geofence uploaded at connect
(app/zones/fence.py) remains the hard backstop if the link drops.
"""
import asyncio
import logging
import math
import time

from app.zones import engine

logger = logging.getLogger("verocore.zones.monitor")

_PREDICT_S = 3.0
_WARN_REPEAT_S = 5.0     # re-send zone_status while inside a non-green zone
_RELEASE_SAMPLES = 3     # consecutive green samples to release the lock
_PUSH_EXTRA_M = 20.0     # how far beyond the red boundary to push out

# session_id → monitor state
_states: dict[str, dict] = {}


def drop(session_id: str) -> None:
    _states.pop(session_id, None)


def current_class(session_id: str) -> str:
    """Last-known zone class for a session — for the sessions API."""
    st = _states.get(session_id)
    return st["cls"] if st else "green"


def _predict(lat: float, lng: float, vel: dict) -> tuple[float, float]:
    vn = vel.get("north_m_s", 0.0) or 0.0
    ve = vel.get("east_m_s", 0.0) or 0.0
    dlat = vn * _PREDICT_S / 111_320
    dlng = ve * _PREDICT_S / (111_320 * max(0.2, math.cos(math.radians(lat))))
    return lat + dlat, lng + dlng


async def _emit_admin_alert(sio, session_manager, payload: dict) -> None:
    for s in session_manager.all_sessions():
        if s.is_admin:
            try:
                await sio.emit("admin_alert", payload, to=s.socket_id)
            except Exception:
                pass


async def _pushback(tel, exit_lat: float, exit_lng: float, abs_alt: float) -> None:
    """Hold, then reposition to the exit point. Best-effort — the FC fence
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
    cls = res["zone_class"]

    red_pred = False
    if cls != "red" and armed and in_air and not st["pushing"]:
        plat, plng = _predict(lat, lng, snap.get("velocity", {}))
        # predict_red uses zones eroded by ~5 m — skimming along a red
        # boundary (edge-to-edge with orange) must not trip the pushback
        red_pred = engine.predict_red(plat, plng, alt)

    now = time.time()
    changed = cls != st["cls"]
    zone_names = ", ".join(z["name"] for z in res["zones"]) or None
    drone_name = (session.drone or {}).get("name") or f"session {session.session_id[:8]}"

    # ── Pilot status (on change, and repeated while non-green) ──────────
    if changed or (cls != "green" and now - st["last_status"] > _WARN_REPEAT_S) or red_pred:
        st["last_status"] = now
        msg = None
        if cls == "orange":
            msg = f"WARNING — inside restricted (orange) zone{f': {zone_names}' if zone_names else ''}"
        elif cls == "red":
            msg = f"DANGER — inside NO-FLY (red) zone{f': {zone_names}' if zone_names else ''}"
        elif red_pred:
            msg = "DANGER — approaching NO-FLY (red) zone"
        elif changed:
            msg = "Clear of restricted zones"
        if msg:
            await sio.emit("zone_status", {
                "zone_class": "red" if red_pred and cls != "red" else cls,
                "zones": res["zones"],
                "locked": st["pushing"],
                "message": msg,
            }, to=session.socket_id)

    # ── Admin alerts (transitions only) ─────────────────────────────────
    if changed:
        if cls == "orange":
            await _emit_admin_alert(sio, session_manager, {
                "level": "warning", "session_id": session.session_id,
                "drone": drone_name, "ts": now,
                "message": f"{drone_name} entered ORANGE zone{f' {zone_names}' if zone_names else ''}",
            })
        elif cls == "red":
            await _emit_admin_alert(sio, session_manager, {
                "level": "danger", "session_id": session.session_id,
                "drone": drone_name, "ts": now,
                "message": f"{drone_name} entered RED zone{f' {zone_names}' if zone_names else ''}",
            })
        elif st["cls"] in ("orange", "red"):
            await _emit_admin_alert(sio, session_manager, {
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
        exit_pt = engine.nearest_exit(lat, lng, _PUSH_EXTRA_M)
        if exit_pt is None and red_pred:
            # not inside yet — hold short of the boundary instead
            exit_pt = (lat, lng)
        await sio.emit("zone_status", {
            "zone_class": "red", "zones": res["zones"], "locked": True,
            "message": "CONTROLS LOCKED — pushing back out of NO-FLY zone",
        }, to=session.socket_id)
        await _emit_admin_alert(sio, session_manager, {
            "level": "danger", "session_id": session.session_id,
            "drone": drone_name, "ts": now,
            "message": f"{drone_name}: RED-zone pushback engaged — pilot controls locked",
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
                # still inside (drift/wind) — refresh the goto occasionally
                if now - st.get("last_push", 0) > 5.0:
                    st["last_push"] = now
                    exit_pt = engine.nearest_exit(lat, lng, _PUSH_EXTRA_M)
                    if exit_pt:
                        asyncio.create_task(_pushback(
                            tel, exit_pt[0], exit_pt[1], pos.get("absolute_altitude_m", 0.0)
                        ))
        if st["clear"] >= _RELEASE_SAMPLES or not armed:
            st["pushing"] = False
            session.zone_lock = False
            await sio.emit("zone_status", {
                "zone_class": cls, "zones": res["zones"], "locked": False,
                "message": "Clear of NO-FLY zone — controls returned",
            }, to=session.socket_id)
            await _emit_admin_alert(sio, session_manager, {
                "level": "info", "session_id": session.session_id,
                "drone": drone_name, "ts": now,
                "message": f"{drone_name}: pushback complete — controls returned to pilot",
            })
