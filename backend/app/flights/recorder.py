"""
Automatic flight recording. A flight = armed → disarmed; while armed the
telemetry stream is sampled at 1 Hz into flight_samples, and the summary
row (duration, max altitude, distance) is finalised on disarm — or on
disconnect, so a dropped link never leaves a flight dangling open.

Everything degrades to a no-op when the DB is offline; recording must
never touch the flight path itself.
"""
import logging
import math
import time
from datetime import datetime, timezone

from app.db import db_available, get_session
from app.db.models import Flight, FlightSample

logger = logging.getLogger("verocore.flights")

_SAMPLE_INTERVAL = 1.0

# session_id → live recording state
_active: dict[str, dict] = {}


def _haversine_m(lat1, lng1, lat2, lng2) -> float:
    r = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


async def on_snapshot(session_id: str, drone_id: str | None, snap: dict) -> None:
    """Feed every telemetry update here; cheap no-op unless armed."""
    if not db_available() or not drone_id:
        return
    armed = snap.get("flight_mode", {}).get("is_armed", False)
    state = _active.get(session_id)

    try:
        if armed and state is None:
            flight = Flight(drone_id=drone_id, session_id=session_id)
            async with get_session() as db:
                db.add(flight)
                await db.commit()
                fid = flight.id
            _active[session_id] = {
                "flight_id": fid,
                "started": time.time(),
                "last_sample": 0.0,
                "max_alt": 0.0,
                "dist": 0.0,
                "last_pos": None,
                "samples": 0,
            }
            logger.info(f"Flight started: {fid[:8]} (drone {drone_id[:8]})")
            state = _active[session_id]

        if state is None:
            return

        if not armed:
            await end_flight(session_id)
            return

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
                state["dist"] += _haversine_m(*state["last_pos"], lat, lng)
            state["last_pos"] = (lat, lng)
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
    if state is None or not db_available():
        return
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
            await db.commit()
        logger.info(
            f"Flight ended: {state['flight_id'][:8]} — "
            f"{flight.duration_s:.0f}s, {flight.max_alt_m:.0f}m max, "
            f"{flight.distance_m:.0f}m flown"
        )
    except Exception as e:
        logger.warning(f"Flight finalise error: {e}")
