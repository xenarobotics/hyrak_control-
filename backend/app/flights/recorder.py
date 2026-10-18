"""
Automatic flight recording. A flight = armed → disarmed; while armed the
telemetry stream is sampled at 1 Hz into flight_samples, and the summary
row (duration, max altitude, distance) is finalised on disarm - or on
disconnect, so a dropped link never leaves a flight dangling open.

Everything degrades to a no-op when the DB is offline; recording must
never touch the flight path itself.
"""
import logging
import time
from datetime import datetime, timezone

from app.db import db_available, get_session
from app.db.models import Flight, FlightSample
from app.utils.geo import haversine_m

logger = logging.getLogger("verocore.flights")

_SAMPLE_INTERVAL = 1.0

# session_id → live recording state
_active: dict[str, dict] = {}


async def _drone_workspace(drone_id: str) -> str | None:
    """The registry's workspace for a drone, for callers that do not know it
    (the swarm fleet). None when the registry cannot say."""
    try:
        from app.auth import service as auth
        drone = await auth.read_store().get_drone(drone_id)
    except Exception:
        return None
    return (drone or {}).get("workspace_id")


async def on_snapshot(session_id: str, drone_id: str | None, snap: dict,
                      workspace_id: str | None = None) -> None:
    """Feed every telemetry update here; cheap no-op unless armed.

    `workspace_id` is the workspace the flight belongs to
    (docs/ACCESS_MODEL.md 8b): the drone's, else the session's. It is read
    once, on the arm edge, so moving a drone mid-flight does not split
    the flight. None files it under HYRAK (the column default)."""
    if not db_available() or not drone_id:
        return
    armed = snap.get("flight_mode", {}).get("is_armed", False)
    state = _active.get(session_id)

    try:
        if armed and state is None:
            # CLAIM THE SLOT BEFORE THE FIRST AWAIT. Snapshots arrive as
            # independent tasks, and on the arm edge two of them used to
            # both see state None, both insert a Flight, and the loser's
            # row stayed in_progress forever. The placeholder is synchronous;
            # every snapshot that lands during the insert sees it and waits.
            state = _active[session_id] = {
                "flight_id": None,
                "started": time.time(),
                "last_sample": 0.0,
                "max_alt": 0.0,
                "dist": 0.0,
                "last_pos": None,
                "samples": 0,
                "crossed_orange": False,
                "crossed_red": False,
            }
            if not workspace_id:
                workspace_id = await _drone_workspace(drone_id)
            flight = Flight(drone_id=drone_id, session_id=session_id)
            if workspace_id:
                flight.workspace_id = workspace_id
            try:
                async with get_session() as db:
                    db.add(flight)
                    await db.commit()
                    fid = flight.id
            except Exception:
                # The insert failed: release the slot so the next snapshot
                # tries again instead of recording into a flight with no row.
                if _active.get(session_id) is state:
                    _active.pop(session_id, None)
                raise
            if _active.get(session_id) is not state:
                return   # ended (disarmed / disconnected) during the insert
            state["flight_id"] = fid
            logger.info(f"Flight started: {fid[:8]} (drone {drone_id[:8]})")

        if state is None:
            return

        if not armed:
            await end_flight(session_id)
            return

        if state["flight_id"] is None:
            return   # another task is still inserting the Flight row

        now = time.time()
        if (now - state["last_sample"]) < _SAMPLE_INTERVAL:
            return
        state["last_sample"] = now

        pos = snap.get("position", {})
        lat, lng = pos.get("latitude_deg", 0.0), pos.get("longitude_deg", 0.0)
        alt = pos.get("relative_altitude_m", 0.0)
        state["max_alt"] = max(state["max_alt"], alt)
        if lat or lng:
            if state["last_pos"]:
                state["dist"] += haversine_m(*state["last_pos"], lat, lng)
            state["last_pos"] = (lat, lng)
            if not (state["crossed_orange"] and state["crossed_red"]):
                from app.zones import engine as zone_engine
                zc = zone_engine.check_point(lat, lng, alt)["zone_class"]
                if zc == "orange":
                    state["crossed_orange"] = True
                elif zc == "red":
                    state["crossed_red"] = True
        state["samples"] += 1

        async with get_session() as db:
            db.add(FlightSample(
                flight_id=state["flight_id"],
                lat=lat, lng=lng, alt_m=alt,
                heading_deg=snap.get("heading_deg", 0.0),
                groundspeed_m_s=snap.get("groundspeed_m_s", 0.0),
                battery_pct=snap.get("battery", {}).get("remaining_percent", 0.0),
                mode=str(snap.get("flight_mode", {}).get("mode", ""))[:24],
            ))
            await db.commit()
    except Exception as e:
        logger.warning(f"Flight recording error: {e}")


async def end_flight(session_id: str) -> None:
    """Finalise the session's open flight, if any. Idempotent."""
    state = _active.pop(session_id, None)
    if state is None or not db_available() or state.get("flight_id") is None:
        return   # nothing recorded (or the row was still being inserted)
    try:
        from sqlalchemy import select
        async with get_session() as db:
            flight = (
                await db.execute(select(Flight).where(Flight.id == state["flight_id"]))
            ).scalar_one_or_none()
            if flight is None:
                return
            flight.ended_at = datetime.now(timezone.utc)
            flight.duration_s = round(time.time() - state["started"], 1)
            flight.max_alt_m = round(state["max_alt"], 1)
            flight.distance_m = round(state["dist"], 1)
            flight.samples_count = state["samples"]
            flight.crossed_orange = state.get("crossed_orange", False)
            flight.crossed_red = state.get("crossed_red", False)
            await db.commit()
        logger.info(
            f"Flight ended: {state['flight_id'][:8]} - "
            f"{flight.duration_s:.0f}s, {flight.max_alt_m:.0f}m max, "
            f"{flight.distance_m:.0f}m flown"
        )
    except Exception as e:
        logger.warning(f"Flight finalise error: {e}")
