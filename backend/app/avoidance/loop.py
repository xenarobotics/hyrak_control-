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
    """(manager, in_air) for a drone - fleet first, then live sessions - or
    (None, False) if it has no live link right now."""
    try:
        from app.fleet import service as fleet_service
        i = fleet_service.instance_for(drone_id)
        if i is not None:
            mgr = fleet_service._managers.get(i)
            if mgr is not None and mgr.is_connected:
                snap = mgr.snapshot()
                return mgr, bool(snap.flight_mode.is_in_air)
    except Exception:
        pass
    sm = _session_manager
    if sm is not None:
        for s in sm.all_sessions():
            if (s.drone or {}).get("id") != drone_id:
                continue
            mgr = sm.get_telemetry(s.session_id)
            if mgr is not None and mgr.is_connected:
                return mgr, bool(mgr.snapshot().flight_mode.is_in_air)
    return None, False


def _pose_of(manager) -> Pose | None:
    snap = manager.snapshot()
    lat = snap.position.latitude_deg
    lng = snap.position.longitude_deg
    if not (lat or lng):
        return None
    return Pose(lat=lat, lng=lng, heading_deg=snap.heading_deg,
                alt_m=snap.position.relative_altitude_m)


async def _goal_for(drone_id: str) -> tuple[float, float] | None:
    """The destination the drone is flying toward: the last waypoint of its
    latest uploaded/flying mission. None for manual flight (no mission) ->
    the drone brakes/holds on an obstacle instead of rerouting."""
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
        manager, in_air = _resolve_link(c.drone_id)
        pose = _pose_of(manager) if manager is not None else None
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
