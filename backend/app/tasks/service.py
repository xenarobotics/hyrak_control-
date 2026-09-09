"""
The delivery task lifecycle.

A task is an ORDER ("box from Mess-A to Hostel-C by 17:00"); the mission it
spawns is a FLIGHT PLAN. The client application only ever sees the order:
pads by name, an order number, a status timeline. Everything flight-shaped
(waypoints, profiles, zones, permits) stays on HYRAK's side of the line.
"""
import logging
from datetime import datetime, timezone

from sqlalchemy import func, select

from app.db import db_available, get_session
from app.db.models import Mission, Pad, Task, TaskEvent

logger = logging.getLogger("verocore.tasks.service")

STATUSES = ("received", "planned", "assigned", "to_pickup", "loading",
            "to_dropoff", "delivered", "returned", "failed", "cancelled")

# cancelled exists only while the order is still on the ground; once the
# aircraft is airborne the honest exits are returned (it flew back) or
# failed (it did not complete) - there is no "cancel" of a drone mid-air.
ALLOWED_NEXT = {
    "received":   {"planned", "failed", "cancelled"},
    "planned":    {"assigned", "cancelled", "failed"},
    "assigned":   {"to_pickup", "cancelled", "failed"},
    "to_pickup":  {"loading", "returned", "failed"},
    "loading":    {"to_dropoff", "returned", "failed"},
    "to_dropoff": {"delivered", "returned", "failed"},
    "delivered":  set(),
    "returned":   set(),
    "failed":     set(),
    "cancelled":  set(),
}

# Which profile plans a delivery when the client names none. Falls back to
# Direct rules if the builtin is missing from the DB.
DEFAULT_DELIVERY_PROFILE = "Hybrid"


async def _next_order_no(db) -> str:
    """HYK-00042 style, from a Postgres sequence - concurrency-safe where a
    SELECT COUNT would race."""
    try:
        n = (await db.execute(select(func.nextval("task_order_seq")))).scalar_one()
        return f"HYK-{int(n):05d}"
    except Exception:
        # Non-Postgres or missing sequence: time-based, still unique enough.
        import time
        return f"HYK-T{int(time.time() * 1000) % 10**9:09d}"


async def resolve_pad(ref: str, kind: str = "pad") -> dict | None:
    """Active pad by id or case-insensitive name. Client orders resolve
    against kind='pad' only - a drone STATION is not a delivery address."""
    if not ref or not db_available():
        return None
    from sqlalchemy import or_
    async with get_session() as db:
        stmt = select(Pad).where(
            Pad.active == True,  # noqa: E712
            or_(Pad.id == ref, func.lower(Pad.name) == ref.lower()),
        )
        if kind:
            stmt = stmt.where(Pad.kind == kind)
        row = (await db.execute(stmt)).scalars().first()
    return row.to_dict() if row else None


async def nearest_station(lat: float, lng: float) -> dict | None:
    """Closest active station to a point - where a drone goes home to."""
    if not db_available():
        return None
    async with get_session() as db:
        rows = (
            await db.execute(
                select(Pad).where(Pad.active == True, Pad.kind == "station")  # noqa: E712
            )
        ).scalars().all()
    if not rows:
        return None
    import math
    m_lng = math.cos(math.radians(lat))
    best = min(rows, key=lambda p: (p.lat - lat) ** 2 + ((p.lng - lng) * m_lng) ** 2)
    return best.to_dict()


async def _add_event(db, task_id: str, status: str, note: str, actor: str):
    db.add(TaskEvent(task_id=task_id, status=status, note=note[:500], actor=actor))


async def plan_leg(start: tuple[float, float], goal: tuple[float, float],
                   profile_ref: str | None, requested_by: str) -> tuple[dict | None, str]:
    """Plan and record one flight leg. Returns (mission dict, error)."""
    import asyncio
    from app.planner import engine as planner_engine
    from app.planner import profiles as profile_mod
    from app.planner import service as mission_service

    profile = await profile_mod.get_profile(profile_ref or DEFAULT_DELIVERY_PROFILE)
    rules = profile_mod.resolved_rules((profile or {}).get("rules") or {})
    # Last-ditch default when a profile carries no cruise altitude: the
    # platform's intended cruise is 10 m, not 60 - a silent 60 m fallback was
    # six times the planned height and a real airspace hazard.
    alt = (profile or {}).get("default_alt_m") or 10.0
    speed = (profile or {}).get("default_speed_m_s") or 8.0

    result = await asyncio.to_thread(
        planner_engine.plan, start, goal,
        rules=rules, cruise_alt_m=alt, speed_m_s=speed, land=True,
    )
    if not result["ok"]:
        return None, result["reason"]

    mission = await mission_service.create(
        result, start=start, goal=goal, cruise_alt_m=alt, speed_m_s=speed,
        requested_by=requested_by,
        profile_id=(profile or {}).get("id"),
        profile_name=(profile or {}).get("name") or "Direct",
    )
    if mission is None:
        return None, "Mission could not be recorded (database offline)"
    return mission, ""


async def _plan_mission_for(task: Task, profile_ref: str | None) -> tuple[dict | None, str]:
    """Plan the DELIVERY leg (pickup -> dropoff)."""
    return await plan_leg(
        (task.pickup_lat, task.pickup_lng),
        (task.dropoff_lat, task.dropoff_lng),
        profile_ref, requested_by=f"task:{task.order_no}",
    )


async def plan_pickup_leg(task_id: str, start_lat: float, start_lng: float,
                          actor: str = "system") -> tuple[dict | None, str]:
    """Plan the POSITIONING leg (assigned drone's location -> pickup pad).
    Called at assign time, when we finally know where the drone is. If the
    drone is already at the pickup (station co-located, or repeat runs), a
    sub-40 m hop is pointless - record no leg and let the operator move
    straight to loading."""
    if not db_available():
        return None, "Service database is offline"
    async with get_session() as db:
        task = (
            await db.execute(select(Task).where(Task.id == task_id))
        ).scalar_one_or_none()
        if task is None:
            return None, "Task not found"

    import math
    m_lng = math.cos(math.radians(task.pickup_lat))
    dist_m = 111_320 * math.hypot(
        task.pickup_lat - start_lat, (task.pickup_lng - start_lng) * m_lng)
    # MUST be smaller than the dispatcher's ARRIVE_RADIUS_M: a skipped leg
    # means "the drone already counts as arrived". The first station sat
    # 40 m from its pickup pad - inside the old 40 m skip, outside the
    # 20 m arrival - so the drone got no flight button AND no auto-advance.
    if dist_m < 30.0:
        return None, "already at pickup"

    mission, err = await plan_leg(
        (start_lat, start_lng), (task.pickup_lat, task.pickup_lng),
        task.profile_name or None,
        requested_by=f"task:{task.order_no}:to_pickup",
    )
    if mission is None:
        return None, err
    async with get_session() as db:
        row = (
            await db.execute(select(Task).where(Task.id == task_id))
        ).scalar_one()
        row.mission_to_pickup_id = mission["id"]
        await _add_event(db, task_id, row.status,
                         f"Pickup leg planned: {mission['distance_m']:.0f} m "
                         f"from drone position", actor)
        await db.commit()
    return mission, ""


async def create_task(*, pickup_ref: str, dropoff_ref: str,
                      payload_desc: str = "", payload_kg: float = 0.0,
                      window_start: datetime | None = None,
                      window_end: datetime | None = None,
                      profile: str | None = None,
                      api_key: dict | None = None,
                      actor: str = "client") -> tuple[dict | None, str]:
    """
    Create an order and immediately try to plan its flight. Returns
    (task, error). A planning failure does NOT fail the order - it stays
    'received' with fail_reason set, for an operator to fix and replan;
    the client sees an accepted order either way.
    """
    if not db_available():
        return None, "Service database is offline"

    # Reject nonsense before it reaches the database or the planner: a NaN
    # weight poisons every arithmetic downstream, a negative weight is
    # meaningless, and a window that ends before it starts can never be met.
    import math
    try:
        payload_kg = float(payload_kg or 0.0)
    except (TypeError, ValueError):
        return None, "payload_kg must be a number"
    if not math.isfinite(payload_kg) or payload_kg < 0:
        return None, "payload_kg must be zero or a positive number"
    if (window_start is not None and window_end is not None
            and window_end <= window_start):
        return None, "Delivery window end must be after its start"

    pickup = await resolve_pad(pickup_ref)
    if pickup is None:
        return None, f"Unknown pickup pad '{pickup_ref}'"
    dropoff = await resolve_pad(dropoff_ref)
    if dropoff is None:
        return None, f"Unknown dropoff pad '{dropoff_ref}'"
    if pickup["id"] == dropoff["id"]:
        return None, "Pickup and dropoff cannot be the same pad"

    async with get_session() as db:
        order_no = await _next_order_no(db)
        task = Task(
            order_no=order_no,
            api_key_id=(api_key or {}).get("id"),
            client_name=(api_key or {}).get("name") or "operator",
            pickup_pad_id=pickup["id"], pickup_name=pickup["name"],
            pickup_lat=pickup["lat"], pickup_lng=pickup["lng"],
            dropoff_pad_id=dropoff["id"], dropoff_name=dropoff["name"],
            dropoff_lat=dropoff["lat"], dropoff_lng=dropoff["lng"],
            payload_desc=payload_desc.strip()[:300],
            payload_kg=float(payload_kg or 0.0),
            window_start=window_start, window_end=window_end,
            profile_name=profile or "",
        )
        db.add(task)
        await db.flush()   # populates task.id (uuid default fires at flush)
        await _add_event(db, task.id, "received",
                         f"Order accepted from {task.client_name}", actor)
        await db.commit()
        task_id = task.id

    mission, err = await _plan_mission_for(task, profile)

    async with get_session() as db:
        row = (
            await db.execute(select(Task).where(Task.id == task_id))
        ).scalar_one()
        if mission:
            row.status = "planned"
            row.mission_id = mission["id"]
            row.profile_name = mission["profile_name"]
            row.fail_reason = ""
            await _add_event(
                db, task_id, "planned",
                f"Route planned: {mission['distance_m']:.0f} m, "
                f"~{mission['est_duration_s']:.0f} s, "
                f"profile {mission['profile_name']}", "system")
        else:
            row.fail_reason = err
            await _add_event(db, task_id, "received",
                             f"Planning failed: {err}", "system")
        await db.commit()
        d = row.to_dict()

    logger.info(f"Task {d['order_no']} created ({d['status']})")
    return d, ""


async def replan(task_id: str) -> tuple[dict | None, str]:
    """Re-run planning for a task still in 'received' or 'planned' - after
    a zone/pad/profile fix, or to pick up new preferences."""
    if not db_available():
        return None, "Service database is offline"
    async with get_session() as db:
        task = (
            await db.execute(select(Task).where(Task.id == task_id))
        ).scalar_one_or_none()
        if task is None:
            return None, "Task not found"
        if task.status not in ("received", "planned"):
            return None, f"Cannot replan a task in status '{task.status}'"

    mission, err = await _plan_mission_for(task, task.profile_name or None)
    async with get_session() as db:
        row = (
            await db.execute(select(Task).where(Task.id == task_id))
        ).scalar_one()
        if mission:
            row.status = "planned"
            row.mission_id = mission["id"]
            row.profile_name = mission["profile_name"]
            row.fail_reason = ""
            await _add_event(db, task_id, "planned",
                             f"Replanned: {mission['distance_m']:.0f} m", "operator")
        else:
            row.fail_reason = err
            await _add_event(db, task_id, row.status,
                             f"Replanning failed: {err}", "system")
        await db.commit()
        d = row.to_dict()
    return d, "" if mission else err


async def set_status(task_id: str, status: str, *, note: str = "",
                     actor: str = "operator",
                     drone_id: str | None = None) -> tuple[dict | None, str]:
    """Advance the lifecycle. Refuses illegal transitions and an 'assigned'
    without a drone."""
    if status not in STATUSES:
        return None, f"Unknown status '{status}'"
    if not db_available():
        return None, "Service database is offline"
    async with get_session() as db:
        # Lock the row for the read-check-write: a manual PATCH racing the
        # 10 s auto-advance would otherwise both read the same 'old' status
        # and both fire a transition, double-advancing the order. FOR UPDATE
        # serialises them - the second waits, re-reads, and its transition is
        # re-checked against the status the first one committed.
        task = (
            await db.execute(
                select(Task).where(Task.id == task_id).with_for_update())
        ).scalar_one_or_none()
        if task is None:
            return None, "Task not found"
        if status not in ALLOWED_NEXT.get(task.status, set()):
            return None, f"Cannot go {task.status} -> {status}"
        if status == "assigned" and not (drone_id or task.drone_id):
            return None, "Assigning requires a drone_id"
        task.status = status
        if drone_id:
            task.drone_id = drone_id
        task.updated_at = datetime.now(timezone.utc)
        await _add_event(db, task_id, status, note, actor)
        # The mission record follows the drone assignment so fleet views
        # agree with the task board.
        if drone_id and task.mission_id:
            m = (
                await db.execute(select(Mission).where(Mission.id == task.mission_id))
            ).scalar_one_or_none()
            if m is not None and m.drone_id is None:
                m.drone_id = drone_id
        await db.commit()
        d = task.to_dict()
    logger.info(f"Task {d['order_no']} -> {status}")
    return d, ""


async def unassign(task_id: str, *, note: str,
                   actor: str = "dispatcher") -> tuple[dict | None, str]:
    """Put an 'assigned' order back in the queue: clear the drone and the
    positioning leg, return the status to 'planned' so the dispatcher can
    book another aircraft. This is the recovery path for a drone that went
    offline after booking - without it the order held its dead drone
    forever. Only 'assigned' qualifies: an order already in flight cannot
    be silently rebooked (the payload may be aboard)."""
    if not db_available():
        return None, "Service database is offline"
    async with get_session() as db:
        task = (
            await db.execute(select(Task).where(Task.id == task_id))
        ).scalar_one_or_none()
        if task is None:
            return None, "Task not found"
        if task.status != "assigned":
            return None, f"Only an assigned order can be unassigned (is {task.status})"
        task.status = "planned"
        task.drone_id = None
        task.mission_to_pickup_id = None
        task.updated_at = datetime.now(timezone.utc)
        await _add_event(db, task_id, "planned", note, actor)
        await db.commit()
        d = task.to_dict()
    logger.info(f"Task {d['order_no']} unassigned -> planned ({note})")
    return d, ""


async def mark_returned_for_drone(drone_id: str, *, note: str) -> None:
    """Close whatever order this drone was flying as 'returned' - used by
    the battery-reserve guard when it commands an automatic return."""
    if not db_available():
        return
    async with get_session() as db:
        rows = (
            await db.execute(
                select(Task).where(
                    Task.drone_id == drone_id,
                    Task.status.in_(("assigned", "to_pickup", "loading",
                                     "to_dropoff")))
            )
        ).scalars().all()
    for t in rows:
        # 'assigned' cannot legally go to 'returned'; it goes to 'failed'.
        nxt = "returned" if t.status in ("to_pickup", "loading", "to_dropoff") \
            else "failed"
        await set_status(t.id, nxt, actor="system", note=note)


async def list_tasks(status: str | None = None, api_key_id: str | None = None,
                     limit: int = 200, offset: int = 0,
                     include_archived: bool = False) -> list[dict]:
    if not db_available():
        return []
    stmt = select(Task).order_by(Task.created_at.desc())
    if not include_archived:
        stmt = stmt.where(Task.archived == False)  # noqa: E712
    if status:
        stmt = stmt.where(Task.status == status)
    if api_key_id:
        stmt = stmt.where(Task.api_key_id == api_key_id)
    # offset before limit: a client paging its whole history must not have the
    # window silently truncated (the public /v1 list was unbounded before).
    stmt = stmt.offset(max(0, offset)).limit(limit)
    async with get_session() as db:
        rows = (await db.execute(stmt)).scalars().all()
    return [t.to_dict() for t in rows]


async def set_archived(task_id: str, archived: bool) -> tuple[dict | None, str]:
    """Shelve or unshelve an order. Only a closed order can be archived -
    hiding a live flight from the board would be lying to the operator."""
    if not db_available():
        return None, "Service database is offline"
    async with get_session() as db:
        task = (
            await db.execute(select(Task).where(Task.id == task_id))
        ).scalar_one_or_none()
        if task is None:
            return None, "Task not found"
        if archived and task.status not in ("delivered", "returned", "failed", "cancelled"):
            return None, "Only a closed order can be archived"
        task.archived = archived
        await db.commit()
        return task.to_dict(), ""


async def delete_task(task_id: str) -> tuple[bool, str]:
    """Permanently remove a CLOSED order and its event trail. The missions
    it flew stay - flight history outlives the commerce that caused it."""
    if not db_available():
        return False, "Service database is offline"
    async with get_session() as db:
        task = (
            await db.execute(select(Task).where(Task.id == task_id))
        ).scalar_one_or_none()
        if task is None:
            return False, "Task not found"
        if task.status not in ("delivered", "returned", "failed", "cancelled"):
            return False, "Only a closed order can be deleted"
        order_no = task.order_no
        await db.delete(task)   # task_events cascade with the row
        await db.commit()
    logger.info(f"Task {order_no} deleted")
    return True, ""


async def get_task(ref: str, api_key_id: str | None = None) -> dict | None:
    """Task by id or order number, with its event timeline and mission
    summary. When api_key_id is given the task must belong to that client -
    one tenant can never read another's orders."""
    if not db_available():
        return None
    from sqlalchemy import or_
    stmt = select(Task).where(or_(Task.id == ref, Task.order_no == ref.upper()))
    if api_key_id:
        stmt = stmt.where(Task.api_key_id == api_key_id)
    async with get_session() as db:
        task = (await db.execute(stmt)).scalar_one_or_none()
        if task is None:
            return None
        events = (
            await db.execute(
                select(TaskEvent).where(TaskEvent.task_id == task.id)
                .order_by(TaskEvent.t)
            )
        ).scalars().all()
        d = task.to_dict()
        d["events"] = [e.to_dict() for e in events]

        def _mission_view(m: Mission) -> dict:
            return {
                "id": m.id, "status": m.status,
                "distance_m": m.distance_m,
                "est_duration_s": m.est_duration_s,
                "waypoint_count": len(m.waypoints or []),
                "coverage": m.coverage or {},
                "waypoints": m.waypoints,
            }

        if task.mission_id:
            m = (
                await db.execute(select(Mission).where(Mission.id == task.mission_id))
            ).scalar_one_or_none()
            if m is not None:
                d["mission"] = _mission_view(m)
        if task.mission_to_pickup_id:
            m = (
                await db.execute(
                    select(Mission).where(Mission.id == task.mission_to_pickup_id))
            ).scalar_one_or_none()
            if m is not None:
                d["mission_to_pickup"] = _mission_view(m)
    return d
