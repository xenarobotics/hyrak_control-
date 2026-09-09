"""
The dispatch queue: matches waiting orders to idle drones.

Runs as one background loop. Every cycle it looks at orders sitting in
'planned' with no drone and at every drone the platform can currently see
(live client sessions + the server-side SITL fleet), picks the nearest
idle drone for the oldest order, books it (status -> assigned), and plans
the positioning leg from the drone's actual location to the pickup pad.

Deliberately DOES NOT fly anything. Assignment is a booking; uploading,
arming and starting stay behind the operator's explicit click. When no
drone is free the order simply waits its turn - that queue-by-age is the
whole fairness model for now.
"""
import asyncio
import logging
import math

from sqlalchemy import select

from app.db import db_available, get_session
from app.db.models import Task
from app.tasks import service as task_service

logger = logging.getLogger("verocore.tasks.dispatcher")

CYCLE_S = 10.0
# A drone must always be able to abort, loiter, and reach a station with
# MIN_RESERVE_PCT still in the pack. Dispatch therefore requires more than
# reserve + a working margin before a drone can take a new order.
MIN_RESERVE_PCT = 20.0
MIN_DISPATCH_BATTERY_PCT = 35.0
# Statuses that make a drone "busy" - holding an order anywhere between
# booking and the end of its dropoff flight.
_ACTIVE = ("assigned", "to_pickup", "loading", "to_dropoff")

_task: asyncio.Task | None = None
_session_manager = None
enabled = True


def _dist_m(lat1, lng1, lat2, lng2) -> float:
    m_lng = math.cos(math.radians(lat1))
    return 111_320 * math.hypot(lat1 - lat2, (lng1 - lng2) * m_lng)


async def _online_drones() -> list[dict]:
    """Every drone with a live position right now: [{id, name, lat, lng}]."""
    sm = _session_manager
    if sm is None:
        return []
    out = []
    for s in sm.all_sessions():
        if getattr(s, "is_admin", False) or not s.drone:
            continue
        tel = sm.get_telemetry(s.session_id)
        if not (tel and tel.is_connected):
            continue
        snap = tel.snapshot
        lat = snap.position.latitude_deg
        lng = snap.position.longitude_deg
        if not (lat or lng):
            continue
        # Same battery floor as fleet drones - a session drone is no more
        # able to fly a delivery on 12% than a station drone is.
        batt = getattr(snap.battery, "remaining_percent", 100.0) or 0.0
        if batt and batt < MIN_DISPATCH_BATTERY_PCT:
            continue
        out.append({"id": s.drone["id"], "name": s.drone.get("name") or "",
                    "lat": lat, "lng": lng})
    # The server-owned delivery fleet (station drones).
    try:
        from app.fleet import service as fleet_service
        for d in fleet_service.status():
            lv = d.get("live")
            if d["connected"] and d.get("db_id") and lv:
                # Battery reserve: never dispatch a drone that could not
                # abort, loiter, and still fly home - it must land with
                # at least MIN_RESERVE_PCT left, so it needs comfortably
                # more than that to accept new work.
                if lv["battery"] < MIN_DISPATCH_BATTERY_PCT:
                    continue
                out.append({"id": d["db_id"], "name": d["name"],
                            "lat": lv["lat"], "lng": lv["lng"]})
    except Exception:
        pass
    # One entry per drone id: a SITL drone can be visible as BOTH a fleet
    # drone and a browser session, and a duplicate entry let one aircraft
    # be booked onto two orders in a single cycle.
    seen: set[str] = set()
    unique = []
    for d in out:
        if d["id"] not in seen:
            seen.add(d["id"])
            unique.append(d)
    return unique


# Wider than plan_pickup_leg's 30 m leg-skip so a skipped hop still counts
# as "arrived" and the order auto-advances.
ARRIVE_RADIUS_M = 35.0

# An 'assigned' order whose drone has been invisible (offline, stale link,
# session closed) for this long goes back in the queue for another drone.
# Orders already in flight are never silently rebooked.
OFFLINE_REQUEUE_S = 120.0
_offline_since: dict[str, float] = {}   # task_id -> first-seen-missing (monotonic)


def _drone_state(drone_id: str) -> tuple[float, float, bool] | None:
    """(lat, lng, in_air) for a drone - fleet first, then live sessions."""
    try:
        from app.fleet import service as fleet_service
        for d in fleet_service.status():
            lv = d.get("live")
            if d.get("db_id") == drone_id and lv:
                return (lv["lat"], lv["lng"], bool(lv["in_air"]))
    except Exception:
        pass
    sm = _session_manager
    if sm is None:
        return None
    for sess in sm.all_sessions():
        if (sess.drone or {}).get("id") != drone_id:
            continue
        tel = sm.get_telemetry(sess.session_id)
        if tel and tel.is_connected:
            snap = tel.snapshot
            return (snap.position.latitude_deg, snap.position.longitude_deg,
                    bool(snap.flight_mode.is_in_air))
    return None


async def _auto_advance() -> None:
    """Advance orders from what the aircraft actually did: landed at the
    pickup pad -> loading (awaiting payload); landed at the dropoff pad ->
    delivered. The gates that need a human stay human - loading only ends
    when someone confirms the payload with START DELIVERY FLIGHT."""
    async with get_session() as db:
        flying = (
            await db.execute(
                select(Task).where(Task.status.in_(("to_pickup", "to_dropoff")),
                                   Task.drone_id.isnot(None))
            )
        ).scalars().all()
    for t in flying:
        state = _drone_state(t.drone_id)
        if state is None:
            continue
        lat, lng, in_air = state
        if in_air:
            continue
        if t.status == "to_pickup":
            target, nxt, note = ((t.pickup_lat, t.pickup_lng), "loading",
                                 "Landed at pickup - awaiting payload (telemetry)")
        else:
            target, nxt, note = ((t.dropoff_lat, t.dropoff_lng), "delivered",
                                 "Landed at dropoff (telemetry)")
        if _dist_m(lat, lng, target[0], target[1]) <= ARRIVE_RADIUS_M:
            updated, err = await task_service.set_status(
                t.id, nxt, actor="system", note=note)
            if err:
                logger.warning(f"Auto-advance {t.order_no}: {err}")
            else:
                logger.info(f"Auto-advance: {t.order_no} -> {nxt}")


async def _requeue_stuck() -> None:
    """Free orders whose booked drone vanished. A drone that goes offline
    after 'assigned' used to hold both the order and its busy slot forever
    - nothing ever timed out. Now: invisible for OFFLINE_REQUEUE_S ->
    unassign, back to 'planned', next cycle books another drone."""
    import time
    async with get_session() as db:
        booked = (
            await db.execute(
                select(Task).where(Task.status == "assigned",
                                   Task.drone_id.isnot(None))
            )
        ).scalars().all()
    live_ids = {t.id for t in booked}
    for tid in list(_offline_since):
        if tid not in live_ids:
            _offline_since.pop(tid, None)
    for t in booked:
        if _drone_state(t.drone_id) is not None:
            _offline_since.pop(t.id, None)
            continue
        first = _offline_since.setdefault(t.id, time.monotonic())
        gone_s = time.monotonic() - first
        if gone_s < OFFLINE_REQUEUE_S:
            continue
        _offline_since.pop(t.id, None)
        updated, err = await task_service.unassign(
            t.id, note=f"Drone offline for {gone_s:.0f} s - order requeued")
        if err:
            logger.warning(f"Requeue of {t.order_no} failed: {err}")
        else:
            logger.warning(f"Requeued {t.order_no}: assigned drone went offline")


async def _cycle() -> None:
    if not (enabled and db_available()):
        return
    await _auto_advance()
    await _requeue_stuck()
    async with get_session() as db:
        waiting = (
            await db.execute(
                select(Task)
                .where(Task.status == "planned", Task.drone_id.is_(None))
                .order_by(Task.created_at)
            )
        ).scalars().all()
        busy_ids = {
            t.drone_id for t in (
                await db.execute(
                    select(Task).where(Task.status.in_(_ACTIVE),
                                       Task.drone_id.isnot(None))
                )
            ).scalars().all()
        }
    if not waiting:
        return

    drones = [d for d in await _online_drones() if d["id"] not in busy_ids]

    for task in waiting:
        if not drones:
            return  # everyone is busy - the rest of the queue waits
        best = min(drones, key=lambda d: _dist_m(
            task.pickup_lat, task.pickup_lng, d["lat"], d["lng"]))
        drones.remove(best)
        km = _dist_m(task.pickup_lat, task.pickup_lng, best["lat"], best["lng"]) / 1000
        updated, err = await task_service.set_status(
            task.id, "assigned", drone_id=best["id"], actor="dispatcher",
            note=f"Auto-assigned {best['name'] or best['id'][:8]} "
                 f"({km:.2f} km from pickup)",
        )
        if err:
            logger.warning(f"Dispatcher assign failed for {task.order_no}: {err}")
            continue
        logger.info(f"Dispatcher: {task.order_no} -> {best['name'] or best['id'][:8]}")
        _, leg_err = await task_service.plan_pickup_leg(
            task.id, best["lat"], best["lng"], actor="dispatcher")
        if leg_err and leg_err != "already at pickup":
            logger.warning(f"Pickup leg for {task.order_no}: {leg_err}")


async def _loop() -> None:
    while True:
        try:
            await _cycle()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error(f"Dispatcher cycle failed: {e}")
        await asyncio.sleep(CYCLE_S)


def start(session_manager) -> None:
    global _task, _session_manager
    _session_manager = session_manager
    if _task is None or _task.done():
        _task = asyncio.create_task(_loop(), name="task_dispatcher")
        logger.info("Dispatcher started (auto-assign, no auto-launch)")


def stop() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        _task = None
