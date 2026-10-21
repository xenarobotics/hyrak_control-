"""
Copilot's skill catalogue: what each skill takes, whether it moves the
drone and needs the pilot's confirm, the argument checks every plan goes
through (local parser and Claude alike), the tool schemas Claude chooses
from, and the motion guards.

Guards (guard()): the session may fly (socket_guard.session_may_fly, and
the drone is not read-only for it), no staff takeover (takeover.blocking),
the pilot has not taken the aircraft (tel.pilot_has_control), the link is
up, the drone is in the air (on the ground for takeoff), no red-zone lock,
and for a destination or a path its zones: red refused and orange refused
unless an approved permit covers it, with the permits read fresh and a
failed read counting as no permit. Every motion skill calls guard() when
the plan is made AND again when the pilot confirms, at the moment it runs.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("verocore.copilot.skills")


@dataclass(frozen=True)
class Skill:
    name: str
    moves: bool          # commands the drone (stops included)
    confirm: bool        # a plan card the pilot accepts first
    in_air: Optional[bool]  # True: must be flying, False: must be on the ground, None: either
    description: str


SKILLS: Dict[str, Skill] = {s.name: s for s in [
    Skill("hold", True, False, None,
          "Stop and hover in place now. Also ends any follow, orbit, track or survey."),
    Skill("land", True, True, True, "Land where the drone is."),
    Skill("return_home", True, True, True, "Return to the home point and land (RTL)."),
    Skill("takeoff", True, True, False,
          "Arm if needed and take off to altitude_m metres above home (2 to 120)."),
    Skill("change_altitude", True, True, True,
          "Climb or descend: delta_m metres relative (positive is up), or to altitude_m "
          "metres above home. Give exactly one of the two."),
    Skill("move", True, True, True,
          "Fly relative to the drone's heading: forward_m (negative is back) and right_m "
          "(negative is left), each -200 to 200 metres. Altitude is kept."),
    Skill("follow", True, True, True,
          "Follow a target seen on the camera, described in words (\"man in a red shirt\", "
          "\"white car\"), or the pilot themself with target \"me\"."),
    Skill("track", False, False, None,
          "Keep a described target highlighted on the video and pinned on the map, without "
          "moving the drone."),
    Skill("stop_task", True, False, None,
          "Stop the current follow, orbit, track or survey (the drone holds)."),
    Skill("count", False, False, None,
          "Count things on the camera now: what is a class or description (people, cars)."),
    Skill("describe", False, False, None,
          "Look at the camera and answer a question about the scene, or describe it."),
    Skill("survey", True, True, True,
          "Fly a lawnmower survey of a circle: radius_m 10 to 500, at altitude_m metres, "
          "centred on the drone (center \"drone\") or on center_lat / center_lon."),
    Skill("orbit", True, True, True,
          "Circle a point: radius_m 5 to 200, speed_m_s up to 5, around the drone's "
          "position (center \"drone\") or the tracked target (center \"target\")."),
    Skill("status", False, False, None,
          "Battery, altitude, flight mode, GPS, link and the current task."),
]}

CONFIRM = frozenset(s.name for s in SKILLS.values() if s.confirm)
MOVING = frozenset(s.name for s in SKILLS.values() if s.moves)

TAKEOFF_MIN, TAKEOFF_MAX = 2.0, 120.0
DEFAULT_TAKEOFF_M = 10.0
MOVE_MAX = 200.0
SURVEY_R_MIN, SURVEY_R_MAX = 10.0, 500.0
SURVEY_ALT_MIN, SURVEY_ALT_MAX = 5.0, 120.0
DEFAULT_SURVEY_ALT_M = 30.0
ORBIT_R_MIN, ORBIT_R_MAX = 5.0, 200.0
ORBIT_SPEED_MAX = 5.0
DEFAULT_ORBIT_SPEED = 2.0
TEXT_MAX = 120


class ArgError(ValueError):
    pass


def _num(v, name: str) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, bool):
        raise ArgError(f"{name} must be a number")
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise ArgError(f"{name} must be a number")
    if f != f or f in (float("inf"), float("-inf")):
        raise ArgError(f"{name} must be a number")
    return f


def _text(v, name: str, *, required: bool = True) -> str:
    s = " ".join(str(v or "").split())[:TEXT_MAX]
    if required and not s:
        raise ArgError(f"say what to {name}")
    return s


def _between(v: float, lo: float, hi: float, what: str) -> float:
    if not (lo <= v <= hi):
        raise ArgError(f"{what} must be between {lo:g} and {hi:g}")
    return v


def validate(skill: str, args: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The plan's arguments, checked and normalised. Raises ArgError with a
    sentence the pilot hears. Out-of-range values are refused, not
    clamped: a misheard "150" must not quietly become 120."""
    if skill not in SKILLS:
        raise ArgError(f"I have no skill called {skill}")
    a = dict(args or {})
    if skill in ("hold", "land", "return_home", "stop_task", "status"):
        return {}
    if skill == "takeoff":
        alt = _num(a.get("altitude_m"), "altitude")
        return {"altitude_m": _between(DEFAULT_TAKEOFF_M if alt is None else alt,
                                       TAKEOFF_MIN, TAKEOFF_MAX, "Takeoff altitude (metres)")}
    if skill == "change_altitude":
        d, alt = _num(a.get("delta_m"), "delta"), _num(a.get("altitude_m"), "altitude")
        if (d is None) == (alt is None):
            raise ArgError("say either how far to climb or descend, or the altitude to go to")
        if d is not None:
            if d == 0:
                raise ArgError("a climb of 0 metres does nothing")
            return {"delta_m": _between(d, -TAKEOFF_MAX, TAKEOFF_MAX, "The climb (metres)")}
        return {"altitude_m": _between(alt, TAKEOFF_MIN, TAKEOFF_MAX, "The altitude (metres)")}
    if skill == "move":
        f = _num(a.get("forward_m"), "forward") or 0.0
        r = _num(a.get("right_m"), "right") or 0.0
        _between(f, -MOVE_MAX, MOVE_MAX, "A move forward or back (metres)")
        _between(r, -MOVE_MAX, MOVE_MAX, "A move left or right (metres)")
        if f == 0 and r == 0:
            raise ArgError("say how far to move, and which way")
        return {"forward_m": f, "right_m": r}
    if skill in ("follow", "track"):
        t = _text(a.get("target"), skill)
        if skill == "track" and t.lower() == "me":
            raise ArgError("I can only track what the camera sees; say follow me to have me follow you")
        return {"target": "me" if t.lower() in ("me", "myself", "the pilot") else t}
    if skill == "count":
        return {"what": _text(a.get("what"), "count", required=False) or "people"}
    if skill == "describe":
        return {"question": _text(a.get("question"), "ask", required=False)}
    if skill == "survey":
        r = _num(a.get("radius_m"), "radius")
        if r is None:
            raise ArgError("say the survey radius")
        alt = _num(a.get("altitude_m"), "altitude")
        out = {"radius_m": _between(r, SURVEY_R_MIN, SURVEY_R_MAX, "The survey radius (metres)"),
               "altitude_m": _between(DEFAULT_SURVEY_ALT_M if alt is None else alt,
                                      SURVEY_ALT_MIN, SURVEY_ALT_MAX, "The survey altitude (metres)"),
               "center": "drone"}
        lat, lon = _num(a.get("center_lat"), "latitude"), _num(a.get("center_lon"), "longitude")
        if (lat is None) != (lon is None):
            raise ArgError("a survey centre needs both latitude and longitude")
        if lat is not None:
            _between(lat, -90, 90, "The latitude")
            _between(lon, -180, 180, "The longitude")
            out.update(center="point", center_lat=lat, center_lon=lon)
        return out
    if skill == "orbit":
        r = _num(a.get("radius_m"), "radius")
        if r is None:
            raise ArgError("say the orbit radius")
        sp = _num(a.get("speed_m_s"), "speed")
        center = str(a.get("center") or "drone").lower()
        if center not in ("drone", "target"):
            raise ArgError("an orbit goes round the drone's position or the tracked target")
        return {"radius_m": _between(r, ORBIT_R_MIN, ORBIT_R_MAX, "The orbit radius (metres)"),
                "speed_m_s": _between(DEFAULT_ORBIT_SPEED if sp is None else sp, 0.5,
                                      ORBIT_SPEED_MAX, "The orbit speed (metres a second)"),
                "center": center}
    return a


# ── Claude's tools ────────────────────────────────────────────────────────

def _obj(props: Dict[str, Any]) -> Dict[str, Any]:
    return {"type": "object", "properties": props, "required": list(props),
            "additionalProperties": False}


_NUM = {"type": "number"}
_NUM_OR_NULL = {"anyOf": [{"type": "number"}, {"type": "null"}]}
_STR = {"type": "string"}

_INPUTS: Dict[str, Dict[str, Any]] = {
    "hold": _obj({}),
    "land": _obj({}),
    "return_home": _obj({}),
    "takeoff": _obj({"altitude_m": _NUM}),
    "change_altitude": _obj({"delta_m": _NUM_OR_NULL, "altitude_m": _NUM_OR_NULL}),
    "move": _obj({"forward_m": _NUM, "right_m": _NUM}),
    "follow": _obj({"target": _STR}),
    "track": _obj({"target": _STR}),
    "stop_task": _obj({}),
    "count": _obj({"what": _STR}),
    "describe": _obj({"question": _STR}),
    "survey": _obj({"radius_m": _NUM, "altitude_m": _NUM,
                    "center_lat": _NUM_OR_NULL, "center_lon": _NUM_OR_NULL}),
    "orbit": _obj({"radius_m": _NUM, "speed_m_s": _NUM,
                   "center": {"type": "string", "enum": ["drone", "target"]}}),
    "status": _obj({}),
}


def tool_schemas() -> List[Dict[str, Any]]:
    """One strict tool per skill, in catalogue order (stable, so the prompt
    cache holds)."""
    return [{"name": name, "description": SKILLS[name].description, "strict": True,
             "input_schema": _INPUTS[name]} for name in SKILLS]


# ── guards ────────────────────────────────────────────────────────────────

REASONS = {
    "no_fly_permission": "you do not have fly access on this drone",
    "taken_over": "HYRAK staff have taken over this flight",
    "pilot_control": "the pilot has the drone on the sticks",
    "no_link": "there is no drone link",
    "not_flying": "the drone is not flying",
    "already_flying": "the drone is already flying",
    "red_zone": "the drone is held by a no-fly (red) zone",
    "dest_red": "that takes the drone into a no-fly (red) zone",
    "dest_orange": "that takes the drone into a restricted (orange) zone without a permit",
    "ceiling": "that climbs into restricted airspace",
    "no_position": "the drone has no position fix",
    "not_supported": "this drone does not support it",
    "failed": "the drone did not accept the command",
    "copilot_off": "Copilot was switched off",
    "link_lost": "the drone link was lost",
    "mode_changed": "the AI mode was changed",
    "target_lost": "the target is out of sight",
    "position_lost": "your position stopped arriving",
    "task_ended": "it finished or the flight mode changed",
    "stopped": "you asked me to stop",
    "replaced": "a new task replaced it",
}


def reason(code: Optional[str], tel=None) -> str:
    text = REASONS.get(code or "", code or "")
    if code == "failed" and tel is not None and getattr(tel, "last_action_error", None):
        text = f"{text}: {tel.last_action_error}"
    return text


def linked(tel) -> bool:
    if tel is None or not getattr(tel, "is_connected", False):
        return False
    snap = getattr(tel, "snapshot", None)
    return bool(getattr(snap, "link_ok", True)) if snap is not None else True


def in_air(tel) -> bool:
    try:
        return bool(tel.snapshot.flight_mode.is_in_air)
    except Exception:
        return False


def position(tel) -> Optional[Tuple[float, float, float]]:
    """(lat, lng, relative altitude m) or None without a fix."""
    try:
        p = tel.snapshot.position
        lat, lng = float(p.latitude_deg or 0.0), float(p.longitude_deg or 0.0)
        alt = float(p.relative_altitude_m or 0.0)
    except Exception:
        return None
    if not lat and not lng:
        return None
    return lat, lng, alt


def control_reason(session, tel) -> Optional[str]:
    """The guards that hold for everything that commands the drone, stops
    included: fly access, takeover, the pilot, the link, a red-zone lock."""
    from app.auth.socket_guard import session_may_fly
    from app.sessions import takeover
    sid = session.session_id
    if not session_may_fly(session) or getattr(session, "drone_fly", None) is False:
        return "no_fly_permission"
    if takeover.blocking(sid, actor_session_id=sid) is not None:
        return "taken_over"
    if tel is not None and getattr(tel, "pilot_has_control", False):
        return "pilot_control"
    if not linked(tel):
        return "no_link"
    if getattr(session, "zone_lock", False):
        return "red_zone"
    return None


async def _zones_reason(session, zones: List[dict], lat: float, lng: float) -> Optional[str]:
    """dest_red / dest_orange for the zones a destination or path touches,
    unless an approved permit (read fresh; a failed read is none) covers
    every one of them."""
    red = {z["id"] for z in zones if z.get("zone_class") == "red"}
    orange = {z["id"] for z in zones
              if z.get("zone_class") == "orange" and z.get("permission_required", True)}
    if not red and not orange:
        return None
    permitted: set = set()
    if (getattr(session, "drone", None) or {}).get("id"):
        from app.zones import monitor
        try:
            permitted = await monitor.permitted_zone_ids(session, lat, lng, fresh=True)
        except Exception:
            permitted = set()                     # fail closed
    if red - permitted:
        return "dest_red"
    if orange - permitted:
        return "dest_orange"
    return None


async def dest_reason(session, lat: float, lng: float, alt_m: Optional[float] = None,
                      *, from_point: Optional[Tuple[float, float]] = None) -> Optional[str]:
    """Zones at a destination (and on the straight path to it from
    from_point), and restricted airspace above the climb."""
    from app.zones import engine
    zones = list(engine.check_point(lat, lng, alt_m)["zones"])
    if from_point is not None:
        seen = {z["id"] for z in zones}
        path = engine.check_path([from_point, (lat, lng)], corridor_m=5.0)
        zones += [z for z in path["zones"] if z["id"] not in seen and
                  (z.get("zone_class") == "red" or z.get("zone_class") == "orange")]
    code = await _zones_reason(session, zones, lat, lng)
    if code:
        return code
    if alt_m is not None:
        try:
            ceiling = engine.ceiling_at(lat, lng, 0.0)
        except Exception:
            ceiling = None
        if ceiling is not None and alt_m >= ceiling:
            return "ceiling"
    return None


async def guard(session, tel, skill: str) -> Optional[str]:
    """The first guard `skill` fails right now, or None. Destination and
    area checks are the skill's own (dest_reason / the upload gate)."""
    s = SKILLS[skill]
    if not s.moves:
        return None
    code = control_reason(session, tel)
    if code:
        return code
    if s.in_air is True and not in_air(tel):
        return "not_flying"
    if s.in_air is False and in_air(tel):
        return "already_flying"
    return None
