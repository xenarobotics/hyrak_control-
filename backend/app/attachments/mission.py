"""
"At this waypoint" attachment actions in a mission, done when reached.

Each waypoint may carry `actions: [{attachment_id, action_id, value?}]`
(at most MAX_PER_WAYPOINT). They are NOT written into the flight
controller's mission (no MAV_CMD_DO_SET_ACTUATOR / gripper / winch items):
the backend watches the flight and runs them through the same guards as a
button press (app/attachments/control.py) at the moment the drone gets
there. Why this and not MissionRaw items:

  * the guards run when it happens, not when it was planned: in the air,
    height limits, the zone and its permits right now, people below,
    takeover. A DO item in the FC mission fires whatever the link or the
    camera say;
  * the upload path stays one MAVSDK mission (MissionItem, or MissionRaw
    only for terrain follow) and mission_current_index stays one index per
    waypoint, which the map, avoidance and the planner rely on.
The cost: it needs the link at that moment. With no link nothing is done
(no_link), which is the safe side for something that drops or sprays.

Upload (telemetry_events.on_upload_mission): prepare() checks every action
against the drone's attachments; one that can hurt someone needs the
pilot's "Allow attachment actions in this mission" tick
(`allow_attachment_actions: true` in the upload payload). arm() keeps the
plan for the session once the upload succeeded; a new upload replaces it,
a link release or session end clears it.

Reached (on_telemetry, every telemetry update, a dict lookup when there is
no plan): in MISSION mode, the drone flying toward waypoint i
(mission_current_index == i) and within REACH_M of it horizontally (and
REACH_ALT_M vertically, unless terrain follow). Each waypoint runs once per
pass; a mission restarted from an earlier waypoint runs them again. A
waypoint passed without being seen in reach (a telemetry gap) still runs
its harmless actions; hazard ones are refused (passed_waypoint), since the
drone is no longer where they were planned.
"""
from __future__ import annotations

import asyncio
import logging
import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from app.attachments import control, kinds

logger = logging.getLogger("verocore.attachments.mission")

MAX_PER_WAYPOINT = 3
REACH_M = 3.0
REACH_ALT_M = 3.0


@dataclass
class Plan:
    by_wp: Dict[int, List[dict]]
    points: Dict[int, Tuple[float, float, float]]
    terrain: bool = False
    done: set = field(default_factory=set)
    last_index: int = -1


_plans: Dict[str, Plan] = {}


class MissionActionError(ValueError):
    """str(e) is the plain reason; .code the reason code."""

    def __init__(self, msg: str, code: str = "bad_request"):
        super().__init__(msg)
        self.code = code


def has_actions(waypoints) -> bool:
    return any(isinstance(w, dict) and w.get("actions") for w in waypoints or [])


async def prepare(session, waypoints: list, *, allow: bool, terrain: bool = False) -> Optional[Plan]:
    """The plan for these waypoints, None when none has actions. Raises
    MissionActionError with a plain reason."""
    if not has_actions(waypoints):
        return None
    if not control.drone_id_of(session):
        raise MissionActionError("This drone is not identified yet, so attachment actions "
                                 "cannot be planned. Wait a few seconds after connecting.",
                                 "no_attachment")
    atts = {a["id"]: a for a in await control.load(control.drone_id_of(session))}
    by_wp: Dict[int, List[dict]] = {}
    points: Dict[int, Tuple[float, float, float]] = {}
    for i, wp in enumerate(waypoints):
        acts = wp.get("actions") if isinstance(wp, dict) else None
        if not acts:
            continue
        n = i + 1
        if not isinstance(acts, list) or len(acts) > MAX_PER_WAYPOINT:
            raise MissionActionError(f"Waypoint {n}: at most {MAX_PER_WAYPOINT} attachment actions")
        clean = []
        for a in acts:
            if not isinstance(a, dict):
                raise MissionActionError(f"Waypoint {n}: each attachment action is an object")
            att = atts.get(a.get("attachment_id"))
            action = kinds.find_action(att, a.get("action_id")) if att else None
            if att is None or action is None:
                raise MissionActionError(f"Waypoint {n}: that attachment is not fitted to this "
                                         "drone any more", "no_attachment")
            if not att.get("enabled", True):
                raise MissionActionError(f"Waypoint {n}: {att['name']} is switched off in Config",
                                         "disabled")
            row = {"attachment_id": att["id"], "action_id": action["id"]}
            if att["kind"] == "sprayer" and action["id"] == "level":
                try:
                    row["value"] = kinds.level_pct(a.get("value"))
                except kinds.AttachmentError as e:
                    raise MissionActionError(f"Waypoint {n}: {e}")
            if action.get("hazard") and not allow:
                raise MissionActionError(
                    f"Waypoint {n}: {att['name']} {action['label']} can hurt someone. Tick "
                    "\"Allow attachment actions in this mission\" to include it.", "needs_confirm")
            clean.append(row)
        try:
            points[i] = (float(wp["lat"]), float(wp["lng"]), float(wp.get("altitude", 0.0)))
        except (KeyError, TypeError, ValueError):
            raise MissionActionError(f"Waypoint {n}: needs numeric lat and lng")
        by_wp[i] = clean
    return Plan(by_wp=by_wp, points=points, terrain=terrain)


def arm(session_id: str, plan: Optional[Plan]) -> None:
    if plan is None:
        _plans.pop(session_id, None)
    else:
        _plans[session_id] = plan
        logger.info(f"Session {session_id[:8]}: attachment actions at waypoints "
                    f"{sorted(i + 1 for i in plan.by_wp)}")


def clear(session_id: str) -> None:
    _plans.pop(session_id, None)


def plan_of(session_id: str) -> Optional[Plan]:
    return _plans.get(session_id)


def reset_for_tests() -> None:
    _plans.clear()


def _dist_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    dn = (lat2 - lat1) * 111_320.0
    de = (lng2 - lng1) * 111_320.0 * math.cos(math.radians((lat1 + lat2) / 2.0))
    return math.hypot(dn, de)


def _reached(plan: Plan, i: int, snap) -> bool:
    lat, lng, alt = plan.points[i]
    try:
        pos = snap.position
        here_lat, here_lng = float(pos.latitude_deg), float(pos.longitude_deg)
        here_alt = float(pos.relative_altitude_m or 0.0)
    except Exception:
        return False
    if not here_lat and not here_lng:
        return False
    if _dist_m(lat, lng, here_lat, here_lng) > REACH_M:
        return False
    return plan.terrain or abs(here_alt - alt) <= REACH_ALT_M


def due(plan: Plan, snap) -> List[Tuple[int, bool]]:
    """Waypoints whose actions run now: (index, passed). Marks them done."""
    try:
        cur = int(snap.mission_current_index)
        mode = snap.flight_mode.mode
    except Exception:
        return []
    if cur < plan.last_index:
        # Restarted from an earlier waypoint: those ahead run again.
        plan.done = {i for i in plan.done if i < cur}
    plan.last_index = cur
    if mode != "MISSION" or cur < 0:
        return []
    out = []
    for i in sorted(plan.by_wp):
        if i in plan.done:
            continue
        if i == cur and _reached(plan, i, snap):
            out.append((i, False))
        elif i < cur:
            out.append((i, True))
        else:
            continue
        plan.done.add(i)
    return out


def on_telemetry(session, tel) -> None:
    """Every telemetry update of a linked session."""
    plan = _plans.get(session.session_id)
    if plan is None or tel is None:
        return
    try:
        ready = due(plan, tel.snapshot)
    except Exception as e:
        logger.warning(f"Mission attachment check failed for {session.session_id[:8]}: {e}")
        return
    for i, passed in ready:
        try:
            asyncio.get_running_loop().create_task(_run(session, i, plan.by_wp[i], passed))
        except RuntimeError:
            pass


async def _run(session, i: int, acts: List[dict], passed: bool) -> None:
    for a in acts:
        extra = {"waypoint": i + 1}
        att = await control.find(session, a["attachment_id"])
        action = kinds.find_action(att, a["action_id"]) if att else None
        if passed and action is not None and action.get("hazard"):
            what = control.label_of(att, action, a.get("value"))
            out = control.result(a["attachment_id"], a["action_id"], False,
                                 f"{what} not done: {control.reason('passed_waypoint')}",
                                 "passed_waypoint", source="mission", name=att.get("name"),
                                 **extra)
            await control._emit(session.socket_id, "attachment_result", out)
            await control.audit_use(control._actor(session), session, att, a["action_id"], out,
                                    source="mission")
            continue
        # The pilot's tick at upload is the confirm for hazard actions.
        await control.use(session, a["attachment_id"], a["action_id"], value=a.get("value"),
                          confirm=True, source="mission", att=att, extra=extra)
