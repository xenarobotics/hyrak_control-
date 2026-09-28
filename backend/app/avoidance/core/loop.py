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

from app.avoidance.core import executor
from app.avoidance.core import controller as avoidance
from app.avoidance.sensing import registry as sensor_registry
from app.avoidance.planning.geometry import Pose

logger = logging.getLogger("verocore.avoidance.loop")

INTERVAL_S = 0.4  # ~2.5 Hz - nominal ticks are cheap (no reroute unless seen)

_task: asyncio.Task | None = None
_event_fail_t = -1e9
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
                snap = mgr.snapshot          # a property, not a method
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


_fc_mission: dict[str, tuple[list[dict], float]] = {}   # drone -> (items, when)
_fc_inflight: set[str] = set()
_session_missions: dict[str, list[dict]] = {}          # drone -> waypoints a session uploaded
MIN_SENSE_ALT_M = 3.0   # below this the camera sees the pad and the ground plane


async def _fetch_fc_mission(drone_id: str, manager) -> None:
    """Read the mission stored ON THE AIRCRAFT. Source of truth when nothing
    else knows it: a mission restarted without a fresh upload, or uploaded
    before the backend last restarted. Background task - the 10 s download
    timeout must never stall the loop."""
    import time as _t
    try:
        items = list(await manager.download_mission() or [])
        if items:
            logger.info(f"Avoidance: read {len(items)} mission items from aircraft {drone_id[:8]}")
        _fc_mission[drone_id] = (items, _t.monotonic())
    except Exception as e:
        logger.debug(f"FC mission for {drone_id[:8]} unavailable: {e}")
        _fc_mission[drone_id] = ([], _t.monotonic())
    finally:
        _fc_inflight.discard(drone_id)


def _mission_items(drone_id: str, manager) -> list[dict] | None:
    """The waypoint list the aircraft is flying, from the session's upload or
    the aircraft itself (cached 60 s, retried after 20 s when empty)."""
    import time as _t
    if drone_id in _session_missions:
        return _session_missions[drone_id]
    cached = _fc_mission.get(drone_id)
    if cached is not None:
        items, when = cached
        age = _t.monotonic() - when
        if items and age < 60.0:
            return items
        if not items and age < 20.0:
            return None
    if manager is not None and drone_id not in _fc_inflight:
        _fc_inflight.add(drone_id)
        asyncio.create_task(_fetch_fc_mission(drone_id, manager))
    return cached[0] if cached and cached[0] else None


def _current_index(drone_id: str) -> int:
    """Index of the mission item the aircraft is flying toward (MAVSDK
    mission_progress.current), -1 when unknown."""
    try:
        from app.fleet import service as fleet_service
        i = fleet_service.instance_for(drone_id)
        if i is not None:
            return int((fleet_service._state.get(i) or {}).get("mission_current_index", -1))
    except Exception:
        pass
    sm = _session_manager
    if sm is not None:
        for sess in sm.all_sessions():
            if (sess.drone or {}).get("id") == drone_id:
                mgr = sm.get_telemetry(sess.session_id)
                if mgr is not None and mgr.is_connected:
                    return int(getattr(mgr.snapshot, "mission_current_index", -1))
    return -1


def _goal_and_remaining(drone_id: str, manager) -> tuple[tuple[float, float] | None, list[dict]]:
    """THE fix for multi-leg missions: the goal is the waypoint the aircraft is
    flying toward RIGHT NOW, not the mission's last one. With the last one the
    threat cone pointed at the far end of a lawnmower while the aircraft flew
    the opposite leg into a cylinder. Returns (goal, waypoints after it) so a
    detour can rejoin the mission instead of ending at the goal."""
    items = _mission_items(drone_id, manager)
    if not items:
        return None, []
    idx = _current_index(drone_id)
    n = len(items)
    start = idx if 0 <= idx < n else 0
    for k in range(start, n):
        w = items[k]
        if w.get("type") == "takeoff" or w.get("lat") is None or w.get("lng") is None:
            continue
        return (float(w["lat"]), float(w["lng"])), [dict(x) for x in items[k + 1:]]
    w = items[-1]
    if w.get("lat") is not None and w.get("lng") is not None:
        return (float(w["lat"]), float(w["lng"])), []
    return None, []


async def _goal_for(drone_id: str, manager=None) -> tuple[tuple[float, float] | None, list[dict]]:
    """(goal, remaining waypoints). Fleet-flown missions carry their own land
    target (the fleet sets it the moment it flies); everything else comes
    from the mission the aircraft is flying (session upload or the aircraft
    itself), indexed by the item it is currently heading for."""
    try:
        from app.fleet import service as fleet_service
        i = fleet_service.instance_for(drone_id)
        if i is not None:
            tgt = fleet_service._land_target.get(i)
            if tgt:
                return (float(tgt[0]), float(tgt[1])), []
    except Exception:
        pass
    return _goal_and_remaining(drone_id, manager)


_last_seed: dict[str, float] = {}
_last_speed: dict[str, float] = {}
_airborne: dict[str, bool] = {}
_last_speed_t: dict[str, float] = {}
_last_persist: dict[str, float] = {}


async def _sync_hazards(c, pose, now: float) -> None:
    """Link the live map to the persistent hazard DB: seed known static
    hazards near the drone (re-loaded as it flies, so they stay fresh in the
    short-ttl map), and write confirmed-static obstacles back to the shared
    map for the next flight / other drones."""
    from app.avoidance.mapping import hazards as hazard_db
    if now - _last_seed.get(c.drone_id, 0.0) > 3.0:
        _last_seed[c.drone_id] = now
        for h in await hazard_db.load_near(pose.lat, pose.lng, 250.0):
            c.omap.add({"lat": h["lat"], "lng": h["lng"],
                        "radius_m": h["radius_m"]},
                       top_m=h.get("top_m", 0.0),
                       confidence=h.get("confidence", 0.5), now=now)
    if c.params.learn_hazards and now - _last_persist.get(c.drone_id, 0.0) > 10.0:
        _last_persist[c.drone_id] = now
        for o in c.omap.active(now):
            if o.is_static():
                await hazard_db.save(o.lat, o.lng, o.radius_m,
                                     top_m=o.top_m, confidence=o.confidence,
                                     source="avoidance")


async def _legacy_step(c, manager, pose, in_air, mode, now) -> None:
    """The pre-redesign path (params.local_planner = 0): keep-out map +
    mission-upload reroute. Unchanged, kept as a selectable fallback."""
    import time as _t
    if pose is not None:
        try:
            await _sync_hazards(c, pose, now)
        except Exception as e:
            logger.debug(f"hazard sync failed: {e}")
    # Only pursue a goal while the aircraft is actually flying its route.
    # Returning home / landing means the route is finished - see
    # _NO_GOAL_MODES for the ping-pong this prevents.
    pursuing = in_air and mode.upper() not in _NO_GOAL_MODES
    goal, remaining = (await _goal_for(c.drone_id, manager)) if pursuing else (None, [])

    prev_state = c.state
    # Reroute at the drone's CURRENT altitude so a lateral dodge stays level
    # (a constant-altitude mission must not climb just to go around).
    cruise = pose.alt_m if (pose is not None and pose.alt_m > 1.0) else 10.0
    decision = await c.decide(pose, goal, cruise_alt_m=cruise)
    decided_t = _t.monotonic()

    # Command the aircraft only when armed AND airborne. Advisory (unarmed)
    # detects and logs but never touches control.
    # Command only once clear of the pad: PX4 flags in-air at 0.2 m, and a
    # hold/return in the first metres of a climb is a landing.
    can_act = (c.armed and in_air and manager is not None
               and pose is not None and pose.alt_m >= MIN_SENSE_ALT_M)
    if can_act:
        wps = decision.waypoints
        if decision.action == "reroute" and wps and remaining:
            # Rejoin the mission: detour ends at the current waypoint;
            # the legs after it follow, so the aircraft finishes the
            # survey instead of stopping at the first dodge.
            wps = list(wps) + remaining
            _session_missions[c.drone_id] = wps      # indices now refer to THIS mission
            _fc_mission.pop(c.drone_id, None)
        from app import latency_probe
        probe = latency_probe.AvoidanceProbe(
            manager, decision.action, _last_frame_t.get(c.drone_id), decided_t)
        did, note = await executor.apply(
            manager, decision.action, wps, c.intervened)
        probe.done(did, note)
        if decision.action in ("hold", "reroute", "climb", "return") and did:
            c.intervened = True
        elif decision.action == "clear" and c.intervened and did:
            c.intervened = False

    # Speed governor: the decision core recommends a speed (cap when clear,
    # down to min_speed at the clearance ring). Nobody applied it before,
    # so the mission flew at PX4's cruise speed regardless - at 4.9 m/s a
    # camera that judges ~25 m leaves ~2 s to react. Applied only while
    # armed, airborne and on a route; re-sent when it changes by > 0.3 m/s.
    if c.armed and in_air and pursuing and manager is not None:
        # Cap at cruise too (clear -> the cap): the governor used to speak
        # only once a threat existed, so the aircraft met every obstacle at
        # PX4's full cruise speed.
        spd = float(decision.recommended_speed_m_s or 0.0) or float(c.params.speed_cap_m_s)
        last = _last_speed.get(c.drone_id)
        if spd > 0.0 and (last is None or abs(spd - last) > 0.3) and \
                now - _last_speed_t.get(c.drone_id, 0.0) > 1.0:
            if await manager.set_speed(spd):
                _last_speed[c.drone_id] = spd
                _last_speed_t[c.drone_id] = now
                logger.info(f"Avoidance speed for {c.drone_id[:8]}: {spd:.1f} m/s")
    elif not in_air:
        _last_speed.pop(c.drone_id, None)

    if decision.state != prev_state and decision.action != "clear":
        await _record_event(c, decision)


INTERVAL_S_LOCAL = 0.1       # 10 Hz: the local planner's setpoint rate
_last_legacy_t: dict[str, float] = {}
_listeners: dict[str, tuple] = {}     # drone_id -> (manager, fn)
_prev_action: dict[str, str] = {}
_crashed_until: dict[str, float] = {}


def _ensure_pose_feed(c, manager) -> None:
    """Register this controller's pose history on its telemetry link (every
    attitude/position update, stamped on arrival) and raise the link's pose
    rates. Re-registers when the link object changes (reconnect)."""
    from app.avoidance.mapping import pose_history
    cur = _listeners.get(c.drone_id)
    if cur is not None and cur[0] is manager:
        return
    if cur is not None:
        try:
            cur[0].remove_pose_listener(cur[1])
        except Exception:
            pass
    h = pose_history.history(c.drone_id)

    def _on_pose(snap, _h=h):
        pos, att = snap.position, snap.attitude
        if pos.latitude_deg or pos.longitude_deg:
            _h.add(pos.latitude_deg, pos.longitude_deg, pos.relative_altitude_m,
                   snap.heading_deg, att.roll_deg, att.pitch_deg)

    if hasattr(manager, "add_pose_listener"):
        manager.add_pose_listener(_on_pose)
        _listeners[c.drone_id] = (manager, _on_pose)
        _on_pose(manager._snapshot)
        if hasattr(manager, "boost_pose_rates"):
            asyncio.create_task(manager.boost_pose_rates(True))


def _release_pose_feed(drone_id: str) -> None:
    cur = _listeners.pop(drone_id, None)
    if cur is not None:
        try:
            cur[0].remove_pose_listener(cur[1])
            asyncio.create_task(cur[0].boost_pose_rates(False))
        except Exception:
            pass


def _goal_alt(drone_id: str, manager) -> float | None:
    items = _mission_items(drone_id, manager) or []
    idx = _current_index(drone_id)
    for k in range(max(0, idx), len(items)):
        w = items[k]
        if w.get("lat") is None or w.get("type") == "takeoff":
            continue
        for key in ("altitude", "alt", "relative_altitude_m"):
            if w.get(key) is not None:
                try:
                    return float(w[key])
                except (TypeError, ValueError):
                    pass
        return None
    return None


async def _tick() -> None:
    import time as _t
    now = _t.monotonic()
    for did in [d for d in _listeners if not (avoidance.has_controller(d) and avoidance.controller(d).enabled)]:
        _release_pose_feed(did)
    for c in list(avoidance._controllers.values()):
        if not c.enabled:
            continue
        manager, pose, in_air, mode = _resolve_link(c.drone_id)
        if manager is not None:
            _ensure_pose_feed(c, manager)
        # On the ground: wipe the previous flight's map, hold timer and detour
        # (once per landing), and never command anything.
        if not in_air:
            if _airborne.pop(c.drone_id, False):
                c.reset_flight_state()
                _last_speed.pop(c.drone_id, None)
                _session_missions.pop(c.drone_id, None)   # next flight re-reads its mission
                _fc_mission.pop(c.drone_id, None)
                _prev_action.pop(c.drone_id, None)
                logger.info(f"Avoidance {c.drone_id[:8]}: landed - flight state reset")
            # Nothing to decide on the ground: a decision here would only
            # carry a stale state into the next takeoff.
            if c.state != avoidance.AvoidanceState.NOMINAL and c.enabled:
                c.reset_flight_state()
            continue
        _airborne[c.drone_id] = True
        if not c.params.local_planner:
            if now - _last_legacy_t.get(c.drone_id, 0.0) >= INTERVAL_S:
                _last_legacy_t[c.drone_id] = now
                await _legacy_step(c, manager, pose, in_air, mode, now)
            continue
        await _local_step(c, manager, pose, in_air, mode, now)


async def _local_step(c, manager, pose, in_air, mode, now) -> None:
    """Redesigned path: occupancy grid -> supervisor -> Offboard local planner."""
    from app.avoidance.mapping import pose_history
    if pose is not None and now - _last_seed.get(c.drone_id, 0.0) > 3.0:
        try:
            await _seed_hazards_grid(c, pose, now)
        except Exception as e:
            logger.debug(f"hazard seed failed: {e}")
    # A follow / tracking mode owns Offboard: the guard (guard_follow, on the
    # tracker's command path) is avoidance's only say. The mission supervisor
    # stands down entirely - it used to HOLD the aircraft (ending the follow)
    # or steer toward a MISSION waypoint and then resume the mission.
    if c.following(now):
        if c.intervened or c.state != avoidance.AvoidanceState.NOMINAL:
            c._reset_local()
            c.intervened = False
            c.state = avoidance.AvoidanceState.NOMINAL
        if not c._guard_active:
            c._last_reason = "follow guard - path clear" if c.armed else "follow - detecting only (Steer off)"
        _prev_action[c.drone_id] = "clear"
        return

    pursuing = in_air and mode.upper() not in _NO_GOAL_MODES
    # A HOLD the operator commanded is a hold: no route to steer toward, and
    # never a hand-back that restarts the mission (only the keep-clear reflex
    # may move the aircraft). HOLDs avoidance itself entered keep the route so
    # it can resume. The flag survives our own OFFBOARD excursion and clears
    # once the operator picks any other mode.
    m = mode.upper()
    if m in ("HOLD", "LOITER") and not c.intervened:
        c._operator_hold = True
    elif m not in ("HOLD", "LOITER", "OFFBOARD", ""):
        c._operator_hold = False
    if getattr(c, "_operator_hold", False):
        pursuing = False
        if c.state == avoidance.AvoidanceState.NOMINAL:
            c.intervened = False
    hist = pose_history.history(c.drone_id)
    goal = _goal_from_motion(c, manager, hist) if pursuing else None
    goal_ne = hist.to_ne(*goal) if (goal is not None and hist.origin is not None) else None
    goal_alt = None       # steering holds the altitude it took over at (level dodge)

    prev_state = c.state
    decision = c.decide_local(goal_ne, goal_alt, now)

    pilot = getattr(manager, "_pilot_override_mode", None) if manager is not None else None
    # Never command a crashed aircraft: after an impact PX4 may stay armed and
    # the in-air guess (altitude > 1.5 m) can hold, and avoidance then drove a
    # tumbled drone in Offboard (22:54:23). Past 60 deg of roll or pitch it is
    # not flying; stand down for 30 s.
    if manager is not None:
        att = getattr(getattr(manager, "_snapshot", None), "attitude", None)
        if att is not None and (abs(att.roll_deg) > 60.0 or abs(att.pitch_deg) > 60.0):
            if now >= _crashed_until.get(c.drone_id, 0.0):
                logger.warning(f"Avoidance {c.drone_id[:8]}: attitude roll {att.roll_deg:.0f} "
                               f"pitch {att.pitch_deg:.0f} - aircraft not flying, standing down")
            _crashed_until[c.drone_id] = now + 30.0
    crashed = now < _crashed_until.get(c.drone_id, 0.0)
    if crashed and c.state != avoidance.AvoidanceState.NOMINAL:
        c._reset_local(); c.intervened = False
        c.state = avoidance.AvoidanceState.NOMINAL
        c._last_reason = "aircraft not flying (attitude) - standing down"
    can_act = (c.armed and in_air and manager is not None and pose is not None
               and pose.alt_m >= c.acting_floor_m(now) and pilot is None and not crashed)
    if pilot is not None and c.state in (avoidance.AvoidanceState.AVOIDING,
                                         avoidance.AvoidanceState.HOLDING,
                                         avoidance.AvoidanceState.CLIMBING):
        # The pilot took the aircraft: avoidance stands down, it never fights a human.
        c.intervened = False
        c._reset_local()
        c.state = avoidance.AvoidanceState.NOMINAL
        c._last_reason = f"pilot has the aircraft ({pilot})"
    elif can_act:
        from app import latency_probe
        first = decision.action != _prev_action.get(c.drone_id)
        probe = latency_probe.AvoidanceProbe(
            manager, decision.action, getattr(c, "_last_frame_t", None), now) if first else None
        resume_idx = _current_index(c.drone_id)
        if decision.action == "resume" and getattr(decision, "advance", False):
            n_items = len(_mission_items(c.drone_id, manager) or [])
            if 0 <= resume_idx < n_items - 1:
                resume_idx += 1          # this waypoint is reached; PX4 would chase it into the pillar
        did, note = await executor.apply_local(manager, c, decision, resume_idx)
        if probe is not None:
            probe.done(did, note)
        _prev_action[c.drone_id] = decision.action

    # Speed governor while PX4 flies the mission (not while we steer).
    if c.armed and in_air and pursuing and manager is not None and \
            c.state == avoidance.AvoidanceState.NOMINAL:
        spd = float(c.params.speed_cap_m_s)
        if c.sensor_mode(now) == "mono":
            spd = min(spd, float(c.params.mono_speed_cap_m_s))
        last = _last_speed.get(c.drone_id)
        if (last is None or abs(spd - last) > 0.3) and now - _last_speed_t.get(c.drone_id, 0.0) > 1.0:
            if await manager.set_speed(spd):
                _last_speed[c.drone_id] = spd
                _last_speed_t[c.drone_id] = now
                logger.info(f"Avoidance speed for {c.drone_id[:8]}: {spd:.1f} m/s ({c.sensor_mode(now)})")

    if decision.state != prev_state:
        await _record_event(c, decision)


def pick_goal_by_motion(candidates: list[tuple[int, tuple[float, float]]], preferred: int,
                        pos_ne: tuple[float, float], vel_ne: tuple[float, float], to_ne) -> tuple[float, float] | None:
    """The waypoint PX4 is really flying to. `candidates` are (index, (lat, lng))
    around the reported current item; the reported one wins unless the
    aircraft is clearly moving AWAY from it and a neighbour lies along its
    motion. Pure, so it is unit-tested.

    Why: the reported mission index and the waypoint list can disagree by one
    (a takeoff item counted on one side and not the other). On a lawnmower
    that puts the goal at the far end of the OTHER leg: avoidance judged the
    pillar "ahead" toward a point PX4 was flying away from, took over, flew
    toward it, handed back, and PX4 turned round - a 10 s loop (SITL
    2026-09-26 21:33)."""
    import math
    if not candidates:
        return None
    speed = math.hypot(*vel_ne)
    by_idx = dict(candidates)
    if speed < 1.0:
        return by_idx.get(preferred) or candidates[0][1]
    vb = math.degrees(math.atan2(vel_ne[1], vel_ne[0])) % 360.0

    def off(ll):
        n, e = to_ne(*ll)
        dn, de = n - pos_ne[0], e - pos_ne[1]
        if math.hypot(dn, de) < 2.0:
            return 180.0
        return abs((math.degrees(math.atan2(de, dn)) - vb + 180.0) % 360.0 - 180.0)
    if preferred in by_idx and off(by_idx[preferred]) <= 60.0:
        return by_idx[preferred]

    def dist(ll):
        n, e = to_ne(*ll)
        return math.hypot(n - pos_ne[0], e - pos_ne[1])
    # The NEAREST waypoint lying along the motion: on a lawnmower the far ends
    # of later legs are also roughly ahead, but further away.
    ahead = [c for c in candidates if off(c[1]) <= 30.0]
    if ahead:
        return min(ahead, key=lambda c: dist(c[1]))[1]
    best = min(candidates, key=lambda c: off(c[1]))
    return best[1] if off(best[1]) <= 60.0 else by_idx.get(preferred) or best[1]


def _goal_from_motion(c, manager, hist) -> tuple[float, float] | None:
    """Goal for the local planner: chosen while PX4 flies (NOMINAL) from the
    mission items around the reported index and the aircraft's motion, then
    LATCHED while avoidance steers (the motion is then ours, not PX4's)."""
    if c.state in (avoidance.AvoidanceState.AVOIDING, avoidance.AvoidanceState.HOLDING,
                   avoidance.AvoidanceState.CLIMBING) \
            and getattr(c, "_latched_goal", None) is not None:
        return c._latched_goal
    items = _mission_items(c.drone_id, manager) or []
    idx = _current_index(c.drone_id)
    cands = []
    # Reported item and its neighbours; EVERY waypoint when the link does not
    # know the current item (-1: the fleet link never learns it for a mission
    # another link uploaded - SITL 21:36-21:39 resumed "at item -1" each cycle).
    rng = range(len(items)) if idx < 0 else range(max(0, idx - 1), min(len(items), idx + 2))
    for k in rng:
        w = items[k]
        if w.get("type") == "takeoff" or w.get("lat") is None or w.get("lng") is None:
            continue
        cands.append((k, (float(w["lat"]), float(w["lng"]))))
    if not cands:
        # Nothing indexable: fall back to the old rule (session/aircraft/fleet goal).
        g, _ = _goal_and_remaining(c.drone_id, manager)
        c._latched_goal = g
        return g
    p = hist.latest()
    if p is None or hist.origin is None:
        g = dict(cands).get(idx) or cands[0][1]
    else:
        g = pick_goal_by_motion(cands, idx, (p.north_m, p.east_m), hist.velocity_ne(), hist.to_ne)
    c._latched_goal = g
    return g


async def _seed_hazards_grid(c, pose, now: float) -> None:
    """Known hazards (operator-marked, or learned when learn_hazards is on)
    are pinned into the occupancy grid; learned write-back uses the grid's
    confirmed clusters."""
    from app.avoidance.mapping import hazards as hazard_db
    from app.avoidance.mapping import pose_history
    _last_seed[c.drone_id] = now
    h = pose_history.history(c.drone_id)
    if h.origin is None:
        return
    for hz in await hazard_db.load_near(pose.lat, pose.lng, 250.0):
        n, e = h.to_ne(hz["lat"], hz["lng"])
        c.grid.pin_disc(n, e, float(hz["radius_m"]), float(hz.get("top_m", 0.0) or 0.0), now)
    if c.params.learn_hazards and now - _last_persist.get(c.drone_id, 0.0) > 10.0:
        _last_persist[c.drone_id] = now
        for o in c.local_obstacles(now):
            if o["is_static"]:
                await hazard_db.save(o["lat"], o["lng"], o["radius_m"], top_m=o["top_m"],
                                     confidence=0.9, source="avoidance")


async def _record_event(controller, decision) -> None:
    try:
        from app.avoidance import events
        await events.record(
            drone_id=controller.drone_id, action=decision.action,
            state=decision.state.value, reason=decision.reason,
            obstacle=decision.obstacle, armed=controller.armed,
            fused_distance_m=decision.fused_distance_m)
    except Exception as e:
        # Was debug: a schema mismatch silently dropped every event the local
        # planner produced. Loud, but once a minute.
        import time as _t
        global _event_fail_t
        if _t.monotonic() - _event_fail_t > 60.0:
            _event_fail_t = _t.monotonic()
            logger.warning(f"avoidance event NOT recorded ({decision.action}/{decision.state.value}): {e}")


async def _run() -> None:
    while True:
        try:
            await _tick()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning(f"Avoidance loop tick failed: {e}")
        await asyncio.sleep(INTERVAL_S_LOCAL)


_eyes_logged: set[str] = set()
_session_goals: dict[str, tuple[float, float]] = {}


def guard_follow(session_id: str, forward_m_s: float, right_m_s: float) -> tuple[float, float]:
    """The tracker's velocity command, made safe (see
    AvoidanceController.guard_body). Never raises: on any error the command
    passes through unchanged, which is the pre-guard behaviour."""
    global _guard_fail_t
    try:
        c = _controller_for_session(session_id)
        if c is None:
            return forward_m_s, right_m_s
        f, r, ev = c.guard_body(float(forward_m_s), float(right_m_s))
        if ev is not None:
            try:
                d = avoidance.Decision(
                    "avoid" if ev == "start" else "clear",
                    avoidance.AvoidanceState.AVOIDING if ev == "start" else avoidance.AvoidanceState.NOMINAL,
                    c._last_reason)
                asyncio.get_running_loop().create_task(_record_event(c, d))
            except RuntimeError:
                pass                      # no running loop (tests): nothing to log to
        return f, r
    except Exception as e:
        import time as _t
        if _t.monotonic() - _guard_fail_t > 60.0:
            _guard_fail_t = _t.monotonic()
            logger.warning(f"follow guard failed, command passed through: {e}")
        return forward_m_s, right_m_s


_guard_fail_t = -1e9


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
        _session_missions[c.drone_id] = [dict(w) for w in waypoints]
        _fc_mission.pop(c.drone_id, None)
        logger.info(f"Avoidance goal for {c.drone_id[:8]} set from session upload: "
                    f"{last['lat']:.6f},{last['lng']:.6f} ({len(waypoints)} wps)")
    except Exception as e:
        logger.debug(f"note_mission_goal failed: {e}")


def _sole_enabled_controller():
    """The one controller with detection enabled, or None if zero or several
    (ambiguous - never guess which drone a camera belongs to)."""
    live = [c for c in avoidance._controllers.values() if c.enabled]
    return live[0] if len(live) == 1 else None


#: drone_id -> monotonic time of the newest camera frame that produced an
#: observation (the latency probe's "frame" stage for avoidance commands).
_last_frame_t: dict[str, float] = {}


def observe_from_session(session_id: str, obs: dict | list,
                         captured_at: float | None = None) -> None:
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
        # The camera is feeding (this is called with real observations) even
        # when the gates below decide not to use them yet.
        sensor_registry.mark_data(c.drone_id, "monocular")
        # On the ground the camera stares at the pad and the ground plane -
        # feeding that in would seed phantom obstacles for the first seconds
        # of the flight. Obstacles only exist to a drone that is flying.
        try:
            link, pose, in_air, _ = _resolve_link(c.drone_id)
        except Exception:
            link, pose, in_air = None, None, True
        if link is not None and not in_air:
            return
        # PX4 flags in-air at 0.2 m; the camera still sees the pad and the
        # ground plane for the first metres of the climb, and one of those
        # phantoms held the aircraft in front of a real cylinder.
        if pose is not None and pose.alt_m < MIN_SENSE_ALT_M:
            return
        from app.avoidance.sensing.observations import ObstacleObservation
        if captured_at is not None:
            _last_frame_t[c.drone_id] = captured_at
        for one in (obs if isinstance(obs, list) else [obs]):
            c.observe(ObstacleObservation(
                bearing_deg=float(one["bearing_deg"]),
                distance_m=float(one["distance_m"]),
                half_width_deg=float(one.get("half_width_deg", 8.0)),
                confidence=float(one.get("confidence", 0.4)),
                top_m=float(one.get("top_m", 0.0)),
                source=str(one.get("source", "monocular")),
                t=captured_at or 0.0))
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
