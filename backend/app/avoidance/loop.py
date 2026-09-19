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
                    return mgr, pose, in_air, str(lv.get("mode") or "")
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
                    return None, None, False, ""
                pose = Pose(lat=lat, lng=lng, heading_deg=snap.heading_deg,
                            alt_m=snap.position.relative_altitude_m)
                in_air = (bool(snap.flight_mode.is_in_air)
                          or snap.position.relative_altitude_m > 1.5)
                return mgr, pose, in_air, str(snap.flight_mode.mode or "")
    return None, None, False, ""


# Modes in which the aircraft is DONE with its route (returning home or
# landing). Handing decide() a goal here is the bug that ping-ponged the
# drone: after the mission finished and PX4 began RTL, the loop still held
# the mission's last waypoint as the goal, judged the returning drone
# "off-path", and rerouted it straight back to that waypoint - upload +
# start, over and over, so it never landed. No goal => no reroute.
_NO_GOAL_MODES = {"RETURN_TO_LAUNCH", "RTL", "LAND", "LANDING"}


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
    # A mission a browser session uploaded to this aircraft. Hand-drawn
    # missions match no planner record, so the DB lookup below finds nothing
    # and the loop believed the aircraft was in manual flight - it HELD in
    # front of the first obstacle for 20 s and went home instead of routing
    # around it. The upload handler records the destination here.
    g = _session_goals.get(drone_id)
    if g:
        return g
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


_last_seed: dict[str, float] = {}
_last_persist: dict[str, float] = {}


async def _sync_hazards(c, pose, now: float) -> None:
    """Link the live map to the persistent hazard DB: seed known static
    hazards near the drone (re-loaded as it flies, so they stay fresh in the
    short-ttl map), and write confirmed-static obstacles back to the shared
    map for the next flight / other drones."""
    from app.avoidance import hazard_db
    if now - _last_seed.get(c.drone_id, 0.0) > 3.0:
        _last_seed[c.drone_id] = now
        for h in await hazard_db.load_near(pose.lat, pose.lng, 250.0):
            c.omap.add({"lat": h["lat"], "lng": h["lng"],
                        "radius_m": h["radius_m"]},
                       top_m=h.get("top_m", 0.0),
                       confidence=h.get("confidence", 0.5), now=now)
    if now - _last_persist.get(c.drone_id, 0.0) > 10.0:
        _last_persist[c.drone_id] = now
        for o in c.omap.active(now):
            if o.is_static():
                await hazard_db.save(o.lat, o.lng, o.radius_m,
                                     top_m=o.top_m, confidence=o.confidence,
                                     source="avoidance")


async def _tick() -> None:
    import time as _t
    now = _t.monotonic()
    for c in list(avoidance._controllers.values()):
        if not c.enabled:
            continue
        manager, pose, in_air, mode = _resolve_link(c.drone_id)
        if pose is not None:
            try:
                await _sync_hazards(c, pose, now)
            except Exception as e:
                logger.debug(f"hazard sync failed: {e}")
        # Only pursue a goal while the aircraft is actually flying its route.
        # Returning home / landing means the route is finished - see
        # _NO_GOAL_MODES for the ping-pong this prevents.
        pursuing = in_air and mode.upper() not in _NO_GOAL_MODES
        goal = await _goal_for(c.drone_id) if pursuing else None

        prev_state = c.state
        # Reroute at the drone's CURRENT altitude so a lateral dodge stays level
        # (a constant-altitude mission must not climb just to go around).
        cruise = pose.alt_m if (pose is not None and pose.alt_m > 1.0) else 10.0
        decision = await c.decide(pose, goal, cruise_alt_m=cruise)

        # Command the aircraft only when armed AND airborne. Advisory (unarmed)
        # detects and logs but never touches control.
        if c.armed and in_air and manager is not None:
            did, note = await executor.apply(
                manager, decision.action, decision.waypoints, c.intervened)
            if decision.action in ("hold", "reroute", "climb", "return") and did:
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


_eyes_logged: set[str] = set()
_session_goals: dict[str, tuple[float, float]] = {}


def _controller_for_session(session_id: str):
    """The controller a browser session's data belongs to: its bound drone,
    else the sole enabled controller (see observe_from_session)."""
    sm = _session_manager
    if sm is None:
        return None
    sess = sm.get(session_id)
    drone = getattr(sess, "drone", None) if sess else None
    did = (drone or {}).get("id") if isinstance(drone, dict) else getattr(drone, "id", None)
    c = avoidance.controller(did) if (did and avoidance.has_controller(did)) else None
    if c is not None and c.enabled:
        return c
    return _sole_enabled_controller()


def note_mission_goal(session_id: str, waypoints: list) -> None:
    """Called by the session upload handler: the last waypoint is where the
    aircraft is going, whatever the planner knows about the mission."""
    try:
        c = _controller_for_session(session_id)
        if c is None or not waypoints:
            return
        last = waypoints[-1]
        _session_goals[c.drone_id] = (float(last["lat"]), float(last["lng"]))
        logger.info(f"Avoidance goal for {c.drone_id[:8]} set from session upload: "
                    f"{last['lat']:.6f},{last['lng']:.6f} ({len(waypoints)} wps)")
    except Exception as e:
        logger.debug(f"note_mission_goal failed: {e}")


def _sole_enabled_controller():
    """The one controller with detection enabled, or None if zero or several
    (ambiguous - never guess which drone a camera belongs to)."""
    live = [c for c in avoidance._controllers.values() if c.enabled]
    return live[0] if len(live) == 1 else None


def observe_from_session(session_id: str, obs: dict | list) -> None:
    """Bridge vision-derived obstacle observation(s) (from the depth analyzer)
    to the avoidance bus, resolving which drone this browser session is flying.
    Accepts one observation or a dense list. Only feeds a drone that already
    has avoidance enabled - the vision module gates on any_enabled() first, so
    this is cheap and safe."""
    sm = _session_manager
    if sm is None:
        return
    try:
        sess = sm.get(session_id)
        drone = getattr(sess, "drone", None) if sess else None
        did = (drone or {}).get("id") if isinstance(drone, dict) else getattr(drone, "id", None)
        c = avoidance.controller(did) if (did and avoidance.has_controller(did)) else None
        if c is None or not c.enabled:
            # A Swarm-mode session never binds a drone: the fleet owns the
            # link, and a session's registry record is only ever resolved
            # from ITS OWN telemetry. Without this the camera's detections
            # were dropped right here while the fleet drone flew blind. If
            # exactly one drone has avoidance enabled, this camera is its eyes.
            c = _sole_enabled_controller()
            if c is None:
                return
            if session_id not in _eyes_logged:
                _eyes_logged.add(session_id)
                logger.info(f"Session {session_id[:8]} camera feeds avoidance "
                            f"for drone {c.drone_id[:8]} (session has no bound drone)")
        # On the ground the camera stares at the pad and the ground plane -
        # feeding that in would seed phantom obstacles for the first seconds
        # of the flight. Obstacles only exist to a drone that is flying.
        try:
            link, _, in_air, _ = _resolve_link(c.drone_id)
        except Exception:
            link, in_air = None, True
        if link is not None and not in_air:
            return
        from app.avoidance.observations import ObstacleObservation
        for one in (obs if isinstance(obs, list) else [obs]):
            c.observe(ObstacleObservation(
                bearing_deg=float(one["bearing_deg"]),
                distance_m=float(one["distance_m"]),
                half_width_deg=float(one.get("half_width_deg", 8.0)),
                confidence=float(one.get("confidence", 0.4)),
                top_m=float(one.get("top_m", 0.0)),
                source=str(one.get("source", "monocular"))))
    except Exception as e:
        logger.debug(f"observe_from_session failed: {e}")


def start(session_manager) -> None:
    global _task, _session_manager
    _session_manager = session_manager
    n = avoidance.restore_state()
    if n:
        logger.info(f"Restored avoidance enabled/armed state for {n} drone(s)")
    if _task is None or _task.done():
        _task = asyncio.create_task(_run(), name="avoidance_loop")
        logger.info("Avoidance loop started (advisory unless a drone is armed)")


def stop() -> None:
    global _task
    if _task is not None:
        _task.cancel()
    _task = None
