"""
Mission persistence - the who/when/which-drone/what-path record.

Planning still works with the DB offline (the plan is returned, just not
recorded); the same rule as everywhere else: a drone must never be
unflyable because a database is unreachable.
"""
import logging
from datetime import datetime, timezone

from sqlalchemy import select

from app.db import db_available, get_session
from app.db.models import Mission

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
                 profile_name="", scheduled_at: datetime | None = None) -> dict | None:
    """Persist a successful plan. Returns the mission dict, or None when the
    DB is offline (the caller still has the plan itself)."""
    if not db_available():
        return None
    from app.permits.service import mission_hash
    mission = Mission(
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
                        limit: int = 100) -> list[dict]:
    if not db_available():
        return []
    stmt = select(Mission).order_by(Mission.created_at.desc()).limit(limit)
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


async def mark_uploaded_by_hash(waypoints: list[dict],
                                drone_id: str | None = None) -> None:
    """Called after a successful mission upload: any planned mission whose
    hash matches these waypoints advances to 'uploaded'. Best-effort - an
    upload of a hand-drawn mission simply matches nothing."""
    if not db_available():
        return
    try:
        from app.permits.service import mission_hash
        h = mission_hash(waypoints)
        async with get_session() as db:
            rows = (
                await db.execute(
                    select(Mission).where(Mission.mission_hash == h,
                                          Mission.status == "planned")
                )
            ).scalars().all()
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
