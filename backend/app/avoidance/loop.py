"""The avoidance loop - one background task that runs the decision core against
live telemetry for every drone with avoidance enabled.

Each tick, per enabled drone: resolve its live link + pose (fleet first, then
browser sessions), find the mission goal it is flying toward (the last
waypoint of its latest uploaded/flying mission), run decide(), and - ONLY if
the controller is armed and the drone is airborne - apply the decision. A
state change is logged as an avoidance_event for the Mission-tab timeline.

Advisory is the default: enabled + unarmed detects, surfaces state, and logs,
but commands nothing. That is the first real-flight rung.
"""
from __future__ import annotations

import asyncio
import logging

from app.avoidance import executor
from app.avoidance import service as avoidance
from app.avoidance.geometry import Pose

logger = logging.getLogger("verocore.avoidance.loop")

INTERVAL_S = 0.4  # ~2.5 Hz - nominal ticks are cheap (no reroute unless seen)

_task: asyncio.Task | None = None
_session_manager = None


def _resolve_link(drone_id: str):
    """(manager, pose, in_air) for a drone - fleet first, then live sessions -
    or (None, None, False) if it has no live link right now.

    Fleet managers push telemetry to a callback (fleet_service._state), NOT to
    manager.snapshot(), so a fleet drone's pose is read from fleet status, not
    the manager. Session managers keep their own snapshot(). in_air is trusted
    from the flag OR inferred from altitude (a drone at height IS flying even
    when the landed-state flag lags)."""
    try:
        from app.fleet import service as fleet_service
        i = fleet_service.instance_for(drone_id)
        if i is not None:
            mgr = fleet_service._managers.get(i)
            if mgr is not None and mgr.is_connected:
                entry = next((d for d in fleet_service.status()
                              if d.get("db_id") == drone_id), None)
                lv = (entry or {}).get("live")
                if lv and (lv["lat"] or lv["lng"]):
                    pose = Pose(lat=lv["lat"], lng=lv["lng"],
                                heading_deg=lv.get("heading", 0.0),
                                alt_m=lv.get("alt", 0.0))
                    in_air = bool(lv.get("in_air")) or lv.get("alt", 0.0) > 1.5
                    return mgr, pose, in_air
    except Exception:
        pass
    sm = _session_manager
    if sm is not None:
        for s in sm.all_sessions():
            if (s.drone or {}).get("id") != drone_id:
                continue
            mgr = sm.get_telemetry(s.session_id)
            if mgr is not None and mgr.is_connected:
                snap = mgr.snapshot()
                lat, lng = snap.position.latitude_deg, snap.position.longitude_deg
                if not (lat or lng):
                    return None, None, False
                pose = Pose(lat=lat, lng=lng, heading_deg=snap.heading_deg,
                            alt_m=snap.position.relative_altitude_m)
                in_air = (bool(snap.flight_mode.is_in_air)
                          or snap.position.relative_altitude_m > 1.5)
                return mgr, pose, in_air
    return None, None, False


async def _goal_for(drone_id: str) -> tuple[float, float] | None:
    """The destination the drone is flying toward. For a fleet drone this is
    the fleet's own tracked land target (authoritative, no DB/hash lookup -
    the fleet sets it the moment a mission is flown). Otherwise the last
    waypoint of the drone's latest mission. None for manual flight, in which
    case an obstacle makes the drone brake/hold instead of rerouting."""
    try:
        from app.fleet import service as fleet_service
        i = fleet_service.instance_for(drone_id)
        if i is not None:
            tgt = fleet_service._land_target.get(i)
            if tgt:
                return (float(tgt[0]), float(tgt[1]))
    except Exception:
        pass
    from app.db import db_available, get_session
    from app.db.models import Mission
    from sqlalchemy import select
    if not db_available():
        return None
    try:
        async with get_session() as db:
            m = (
                await db.execute(
                    select(Mission)
                    .where(Mission.drone_id == drone_id,
                           Mission.status.in_(("uploaded", "flying")))
                    .order_by(Mission.created_at.desc()).limit(1)
                )
            ).scalars().first()
        if m and m.waypoints:
            last = m.waypoints[-1]
            return (float(last["lat"]), float(last["lng"]))
    except Exception as e:
        logger.debug(f"goal lookup for {drone_id[:8]} failed: {e}")
    return None


async def _tick() -> None:
    for c in list(avoidance._controllers.values()):
        if not c.enabled:
            continue
        manager, pose, in_air = _resolve_link(c.drone_id)
        goal = await _goal_for(c.drone_id) if in_air else None

        prev_state = c.state
        decision = await c.decide(pose, goal)

        # Command the aircraft only when armed AND airborne. Advisory (unarmed)
        # detects and logs but never touches control.
        if c.armed and in_air and manager is not None:
            did, note = await executor.apply(
                manager, decision.action, decision.waypoints, c.intervened)
            if decision.action in ("hold", "reroute", "return") and did:
                c.intervened = True
            elif decision.action == "clear" and c.intervened and did:
                c.intervened = False

        if decision.state != prev_state and decision.action != "clear":
            await _record_event(c, decision)


async def _record_event(controller, decision) -> None:
    try:
        from app.avoidance import events
        await events.record(
            drone_id=controller.drone_id, action=decision.action,
            state=decision.state.value, reason=decision.reason,
            obstacle=decision.obstacle, armed=controller.armed,
            fused_distance_m=decision.fused_distance_m)
    except Exception as e:
        logger.debug(f"avoidance event record failed: {e}")


async def _run() -> None:
    while True:
        try:
            await _tick()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning(f"Avoidance loop tick failed: {e}")
        await asyncio.sleep(INTERVAL_S)


def observe_from_session(session_id: str, obs: dict) -> None:
    """Bridge a vision-derived obstacle observation (from the depth analyzer)
    to the avoidance bus, resolving which drone this browser session is flying.
    Only feeds a drone that already has avoidance enabled - the vision module
    gates on any_enabled() before calling, so this is cheap and safe."""
    sm = _session_manager
    if sm is None:
        return
    try:
        sess = sm.get(session_id)
        drone = getattr(sess, "drone", None) if sess else None
        did = (drone or {}).get("id") if isinstance(drone, dict) else getattr(drone, "id", None)
        if not did or not avoidance.has_controller(did):
            return
        c = avoidance.controller(did)
        if not c.enabled:
            return
        from app.avoidance.observations import ObstacleObservation
        c.observe(ObstacleObservation(
            bearing_deg=float(obs["bearing_deg"]),
            distance_m=float(obs["distance_m"]),
            half_width_deg=float(obs.get("half_width_deg", 8.0)),
            confidence=float(obs.get("confidence", 0.4)),
            source=str(obs.get("source", "monocular"))))
    except Exception as e:
        logger.debug(f"observe_from_session failed: {e}")


def start(session_manager) -> None:
    global _task, _session_manager
    _session_manager = session_manager
    if _task is None or _task.done():
        _task = asyncio.create_task(_run(), name="avoidance_loop")
        logger.info("Avoidance loop started (advisory unless a drone is armed)")


def stop() -> None:
    global _task
    if _task is not None:
        _task.cancel()
    _task = None
