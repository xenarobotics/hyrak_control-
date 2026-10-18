"""
Mission persistence - the who/when/which-drone/what-path record.

Planning still works with the DB offline (the plan is returned, just not
recorded); the same rule as everywhere else: a drone must never be
unflyable because a database is unreachable.

Every mission belongs to a workspace (docs/ACCESS_MODEL.md 8b). Who may
read or write which workspace's missions is app/planner/scope.py; this
module only stores and filters.
"""
import logging
import math
from datetime import datetime, timezone

from sqlalchemy import select

from app.db import db_available, get_session
from app.db.models import PLATFORM_WORKSPACE_ID, Mission

logger = logging.getLogger("verocore.planner.service")

# The lifecycle. planned is the only entry state; the terminal three have
# no exits.
STATUSES = ("planned", "uploaded", "flying", "completed", "aborted", "failed")
_ALLOWED_NEXT = {
    "planned":   {"uploaded", "aborted", "failed"},
    "uploaded":  {"flying", "aborted", "failed"},
    "flying":    {"completed", "aborted", "failed"},
    "completed": set(),
    "aborted":   set(),
    "failed":    set(),
}


async def create(plan_result: dict, *, start, goal, cruise_alt_m, speed_m_s,
                 drone_id=None, requested_by="", profile_id=None,
                 profile_name="", scheduled_at: datetime | None = None,
                 workspace_id: str = PLATFORM_WORKSPACE_ID, name: str = "") -> dict | None:
    """Persist a successful plan. Returns the mission dict, or None when the
    DB is offline (the caller still has the plan itself)."""
    if not db_available():
        return None
    from app.permits.service import mission_hash
    mission = Mission(
        workspace_id=workspace_id or PLATFORM_WORKSPACE_ID,
        name=(name or "")[:120],
        drone_id=drone_id,
        requested_by=(requested_by or "")[:120],
        profile_id=profile_id,
        profile_name=(profile_name or "")[:120],
        start_lat=float(start[0]), start_lng=float(start[1]),
        goal_lat=float(goal[0]), goal_lng=float(goal[1]),
        cruise_alt_m=float(cruise_alt_m), speed_m_s=float(speed_m_s),
        waypoints=plan_result["waypoints"],
        mission_hash=mission_hash(plan_result["waypoints"]),
        distance_m=plan_result["distance_m"],
        est_duration_s=plan_result["est_duration_s"],
        zones=plan_result["zones"],
        coverage=plan_result["coverage"],
        report=plan_result["report"],
        scheduled_at=scheduled_at,
    )
    try:
        async with get_session() as db:
            db.add(mission)
            await db.commit()
            d = mission.to_dict()
        logger.info(
            f"Mission planned: {d['id'][:8]} "
            f"({d['distance_m']:.0f} m, profile '{d['profile_name'] or 'Direct'}')"
        )
        return d
    except Exception as e:
        logger.warning(f"Mission persist failed: {e}")
        return None


async def list_missions(status: str | None = None, drone_id: str | None = None,
                        limit: int = 100, workspace_id: str | None = None) -> list[dict]:
    """Newest first. workspace_id None = every workspace (staff only; the
    route decides)."""
    if not db_available():
        return []
    stmt = select(Mission).order_by(Mission.created_at.desc()).limit(limit)
    if workspace_id:
        stmt = stmt.where(Mission.workspace_id == workspace_id)
    if status:
        stmt = stmt.where(Mission.status == status)
    if drone_id:
        stmt = stmt.where(Mission.drone_id == drone_id)
    async with get_session() as db:
        rows = (await db.execute(stmt)).scalars().all()
    return [m.to_dict(include_waypoints=False) for m in rows]


async def get(mission_id: str) -> dict | None:
    if not db_available():
        return None
    async with get_session() as db:
        m = (
            await db.execute(select(Mission).where(Mission.id == mission_id))
        ).scalar_one_or_none()
    return m.to_dict() if m else None


async def set_status(mission_id: str, status: str,
                     drone_id: str | None = None) -> dict | None:
    """Advance the lifecycle. Returns the updated mission, or None if the
    mission is missing / the transition is illegal / the DB is offline."""
    if status not in STATUSES or not db_available():
        return None
    async with get_session() as db:
        m = (
            await db.execute(select(Mission).where(Mission.id == mission_id))
        ).scalar_one_or_none()
        if m is None or status not in _ALLOWED_NEXT.get(m.status, set()):
            return None
        m.status = status
        if drone_id:
            m.drone_id = drone_id
        m.updated_at = datetime.now(timezone.utc)
        await db.commit()
        d = m.to_dict(include_waypoints=False)
    logger.info(f"Mission {mission_id[:8]} -> {status}")
    return d


# ── Saved plans (the Mission tab's library) ─────────────────────────────

MAX_WAYPOINTS = 500
_WP_TYPES = ("waypoint", "takeoff", "land", "rtl", "loiter")


def clean_waypoints(raw) -> list[dict]:
    """Validate a hand-drawn waypoint list from the Mission tab. Raises
    ValueError with the reason. Keeps the fields the upload path reads."""
    if not isinstance(raw, list) or not raw:
        raise ValueError("waypoints must be a non-empty list")
    if len(raw) > MAX_WAYPOINTS:
        raise ValueError(f"at most {MAX_WAYPOINTS} waypoints")
    out = []
    for i, w in enumerate(raw):
        if not isinstance(w, dict):
            raise ValueError(f"waypoint {i + 1} is not an object")
        try:
            lat, lng = float(w["lat"]), float(w["lng"])
            alt = float(w.get("altitude", 0.0) or 0.0)
            speed = float(w.get("speed", 5.0) or 5.0)
            hold = float(w.get("hold_time", w.get("holdTime", 0.0)) or 0.0)
        except (KeyError, TypeError, ValueError):
            raise ValueError(f"waypoint {i + 1} needs numeric lat, lng, altitude")
        if not all(math.isfinite(v) for v in (lat, lng, alt, speed, hold)):
            raise ValueError(f"waypoint {i + 1} has a non-finite number")
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lng <= 180.0):
            raise ValueError(f"waypoint {i + 1} is outside lat/lng range")
        if not (-100.0 <= alt <= 1000.0) or not (0.0 <= speed <= 50.0) or not (0.0 <= hold <= 3600.0):
            raise ValueError(f"waypoint {i + 1}: altitude, speed or hold time out of range")
        typ = w.get("type") if w.get("type") in _WP_TYPES else "waypoint"
        yaw = w.get("yaw")
        try:
            yaw = float(yaw) if yaw is not None and math.isfinite(float(yaw)) else None
        except (TypeError, ValueError):
            yaw = None
        out.append({"lat": lat, "lng": lng, "altitude": alt, "speed": speed,
                    "hold_time": hold, "type": typ, "yaw": yaw})
    return out


def _haversine_m(a: dict, b: dict) -> float:
    r = 6_371_000.0
    p1, p2 = math.radians(a["lat"]), math.radians(b["lat"])
    dp, dl = p2 - p1, math.radians(b["lng"] - a["lng"])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(min(1.0, h)))


def _path_stats(wps: list[dict]) -> dict:
    from app.zones import engine as zone_engine
    dist = sum(_haversine_m(wps[i - 1], wps[i]) for i in range(1, len(wps)))
    dur = 0.0
    for i in range(1, len(wps)):
        dur += _haversine_m(wps[i - 1], wps[i]) / max(0.5, wps[i]["speed"] or 5.0)
    dur += sum(w["hold_time"] for w in wps)
    check = zone_engine.check_path([(w["lat"], w["lng"]) for w in wps])
    return {"distance_m": round(dist, 1), "est_duration_s": round(dur, 1),
            "zones": check["zones"], "cruise_alt_m": max(w["altitude"] for w in wps),
            "speed_m_s": max(0.5, max(w["speed"] for w in wps))}


async def create_manual(*, workspace_id: str, name: str, waypoints: list[dict],
                        drone_id: str | None = None, requested_by: str = "") -> dict | None:
    """Save a hand-drawn plan (already cleaned). None when the DB is offline."""
    if not db_available():
        return None
    from app.permits.service import mission_hash
    st = _path_stats(waypoints)
    first, last = waypoints[0], waypoints[-1]
    mission = Mission(
        workspace_id=workspace_id, name=(name or "")[:120], drone_id=drone_id,
        requested_by=(requested_by or "")[:120], profile_name="Manual",
        start_lat=first["lat"], start_lng=first["lng"],
        goal_lat=last["lat"], goal_lng=last["lng"],
        cruise_alt_m=st["cruise_alt_m"], speed_m_s=st["speed_m_s"],
        waypoints=waypoints, mission_hash=mission_hash(waypoints),
        distance_m=st["distance_m"], est_duration_s=st["est_duration_s"],
        zones=st["zones"], coverage={}, report={"source": "manual"},
    )
    async with get_session() as db:
        db.add(mission)
        await db.commit()
        d = mission.to_dict()
    logger.info(f"Mission saved: {d['id'][:8]} '{d['name']}' ({len(waypoints)} wps, "
                f"workspace {workspace_id[:8]})")
    return d


async def update(mission_id: str, *, name: str | None = None,
                 waypoints: list[dict] | None = None,
                 drone_id: str | None = None, clear_drone: bool = False) -> tuple[dict | None, str]:
    """Edit a saved plan. Waypoints change only while the mission is still
    'planned' (an uploaded or flown path is a record, not a draft). Returns
    (mission, error)."""
    if not db_available():
        return None, "Database offline"
    from app.permits.service import mission_hash
    async with get_session() as db:
        m = (await db.execute(select(Mission).where(Mission.id == mission_id))).scalar_one_or_none()
        if m is None:
            return None, "Mission not found"
        if name is not None:
            m.name = name[:120]
        if waypoints is not None:
            if m.status != "planned":
                return None, f"A {m.status} mission's path cannot change; save it as a new plan"
            st = _path_stats(waypoints)
            m.waypoints = waypoints
            m.mission_hash = mission_hash(waypoints)
            m.start_lat, m.start_lng = waypoints[0]["lat"], waypoints[0]["lng"]
            m.goal_lat, m.goal_lng = waypoints[-1]["lat"], waypoints[-1]["lng"]
            m.cruise_alt_m, m.speed_m_s = st["cruise_alt_m"], st["speed_m_s"]
            m.distance_m, m.est_duration_s, m.zones = st["distance_m"], st["est_duration_s"], st["zones"]
        if clear_drone:
            m.drone_id = None
        elif drone_id:
            m.drone_id = drone_id
        m.updated_at = datetime.now(timezone.utc)
        await db.commit()
        return m.to_dict(), ""


async def delete(mission_id: str) -> tuple[bool, str]:
    """Delete a plan. Refused while it is flying or while a delivery order
    still points at it. Permits that named it keep their frozen waypoints
    (their mission_id is cleared by the foreign key)."""
    if not db_available():
        return False, "Database offline"
    from app.db.models import Task
    async with get_session() as db:
        m = (await db.execute(select(Mission).where(Mission.id == mission_id))).scalar_one_or_none()
        if m is None:
            return False, "Mission not found"
        if m.status == "flying":
            return False, "This mission is flying; it can be deleted once it has finished"
        used = (await db.execute(
            select(Task.id).where((Task.mission_id == mission_id)
                                  | (Task.mission_to_pickup_id == mission_id)).limit(1)
        )).scalar_one_or_none()
        if used:
            return False, "A delivery order uses this mission"
        await db.delete(m)
        await db.commit()
    logger.info(f"Mission {mission_id[:8]} deleted")
    return True, ""


async def mark_uploaded_by_hash(waypoints: list[dict],
                                drone_id: str | None = None,
                                workspace_id: str | None = None) -> None:
    """Called after a successful mission upload: any planned mission whose
    hash matches these waypoints advances to 'uploaded'. Best-effort - an
    upload of a hand-drawn mission simply matches nothing. workspace_id
    (the drone's) keeps one workspace's upload from touching another's
    identical plan."""
    if not db_available():
        return
    try:
        from app.permits.service import mission_hash
        h = mission_hash(waypoints)
        async with get_session() as db:
            stmt = select(Mission).where(Mission.mission_hash == h,
                                         Mission.status == "planned")
            if workspace_id:
                stmt = stmt.where(Mission.workspace_id == workspace_id)
            rows = (await db.execute(stmt)).scalars().all()
            for m in rows:
                m.status = "uploaded"
                if drone_id:
                    m.drone_id = drone_id
                m.updated_at = datetime.now(timezone.utc)
            if rows:
                await db.commit()
                logger.info(f"Mission(s) {[m.id[:8] for m in rows]} marked uploaded")
    except Exception as e:
        logger.warning(f"mark_uploaded_by_hash failed: {e}")


async def set_held_by_hash(waypoints: list[dict], drone_id: str | None,
                           held: bool) -> None:
    """Flag (or clear) the durable 'takeoff held' marker on the uploaded
    mission matching these waypoints. The flag lets a takeoff deferred for
    overhead traffic survive a server restart: recovery re-arms only a
    mission carrying it, so a completed-and-landed flight (also 'uploaded',
    because nothing auto-advances a mission to 'flying') is never re-flown.
    Best-effort - matches nothing for a hand-drawn upload."""
    if not db_available():
        return
    try:
        from app.permits.service import mission_hash
        h = mission_hash(waypoints)
        async with get_session() as db:
            stmt = select(Mission).where(Mission.mission_hash == h,
                                         Mission.status == "uploaded")
            if drone_id:
                stmt = stmt.where(Mission.drone_id == drone_id)
            rows = (await db.execute(stmt)).scalars().all()
            for m in rows:
                m.held_takeoff = held
                m.updated_at = datetime.now(timezone.utc)
            if rows:
                await db.commit()
    except Exception as e:
        logger.warning(f"set_held_by_hash failed: {e}")


async def clear_held_for_drone(drone_id: str) -> None:
    """Drop the takeoff-held flag on this drone's uploaded mission - called
    once the hold is released (armed), abandoned, or overtaken by a reserve
    return, so recovery never re-holds a mission that is no longer waiting."""
    if not db_available() or not drone_id:
        return
    try:
        async with get_session() as db:
            rows = (
                await db.execute(
                    select(Mission).where(Mission.drone_id == drone_id,
                                          Mission.held_takeoff == True)  # noqa: E712
                )
            ).scalars().all()
            for m in rows:
                m.held_takeoff = False
                m.updated_at = datetime.now(timezone.utc)
            if rows:
                await db.commit()
    except Exception as e:
        logger.warning(f"clear_held_for_drone failed: {e}")


async def held_takeoff_for_drone(drone_id: str) -> dict | None:
    """The drone's held-and-not-yet-started mission, if any - an 'uploaded'
    mission still carrying the takeoff-held flag. Used by fleet recovery to
    restore a hold that a server restart wiped from memory. Returns the
    mission dict (with waypoints) or None."""
    if not db_available() or not drone_id:
        return None
    try:
        async with get_session() as db:
            m = (
                await db.execute(
                    select(Mission)
                    .where(Mission.drone_id == drone_id,
                           Mission.status == "uploaded",
                           Mission.held_takeoff == True)  # noqa: E712
                    .order_by(Mission.created_at.desc()).limit(1)
                )
            ).scalars().first()
        return m.to_dict() if m else None
    except Exception as e:
        logger.warning(f"held_takeoff_for_drone failed: {e}")
        return None
