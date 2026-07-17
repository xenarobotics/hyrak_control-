"""
Red-zone flight permits.

A pilot whose mission is blocked by a red zone can submit that exact
mission with a written justification. The waypoint list is frozen into the
permit. Once an admin approves it, uploading a mission for that drone that
matches the frozen waypoints (within GPS-noise tolerance — any deliberate
edit invalidates it) passes red-zone validation.
"""
import hashlib
import json
import logging
from datetime import datetime, timezone

from sqlalchemy import select

from app.db import db_available, get_session
from app.db.models import Permit

logger = logging.getLogger("verocore.permits")

# Numeric tolerance when matching an upload to an approved permit:
# ~1e-5 deg ≈ 1.1 m — absorbs float noise, rejects real edits.
_TOL_DEG = 1.1e-5
_TOL_ALT = 0.5


def mission_hash(waypoints: list[dict]) -> str:
    canon = [
        (round(float(w["lat"]), 6), round(float(w["lng"]), 6),
         round(float(w.get("altitude", 0.0)), 1))
        for w in waypoints
    ]
    return hashlib.sha256(json.dumps(canon).encode()).hexdigest()


def _matches(permit_wps: list[dict], wps: list[dict]) -> bool:
    if len(permit_wps) != len(wps):
        return False
    for a, b in zip(permit_wps, wps):
        if abs(float(a["lat"]) - float(b["lat"])) > _TOL_DEG:
            return False
        if abs(float(a["lng"]) - float(b["lng"])) > _TOL_DEG:
            return False
        if abs(float(a.get("altitude", 0)) - float(b.get("altitude", 0))) > _TOL_ALT:
            return False
    return True


async def create(drone_id: str, description: str, waypoints: list[dict],
                 zones: list[dict]) -> dict | None:
    if not db_available():
        return None
    permit = Permit(
        drone_id=drone_id,
        description=description.strip()[:500],
        waypoints=waypoints,
        mission_hash=mission_hash(waypoints),
        zones=zones,
    )
    async with get_session() as db:
        db.add(permit)
        await db.commit()
        d = permit.to_dict()
    logger.info(f"Permit requested: {d['id'][:8]} (drone {drone_id[:8]})")
    return d


async def find_approved(drone_id: str, waypoints: list[dict]) -> dict | None:
    """Approved permit for this drone matching these exact waypoints."""
    if not db_available():
        return None
    h = mission_hash(waypoints)
    async with get_session() as db:
        rows = (
            await db.execute(
                select(Permit).where(Permit.drone_id == drone_id,
                                     Permit.status == "approved")
            )
        ).scalars().all()
    for p in rows:
        if p.mission_hash == h or _matches(p.waypoints, waypoints):
            return p.to_dict()
    return None


async def list_permits(status: str | None = None,
                       drone_id: str | None = None,
                       include_waypoints: bool = False) -> list[dict]:
    if not db_available():
        return []
    stmt = select(Permit).order_by(Permit.requested_at.desc()).limit(100)
    if status:
        stmt = stmt.where(Permit.status == status)
    if drone_id:
        stmt = stmt.where(Permit.drone_id == drone_id)
    async with get_session() as db:
        rows = (await db.execute(stmt)).scalars().all()
    return [p.to_dict(include_waypoints=include_waypoints) for p in rows]


async def decide(permit_id: str, approve: bool) -> dict | None:
    if not db_available():
        return None
    async with get_session() as db:
        permit = (
            await db.execute(select(Permit).where(Permit.id == permit_id))
        ).scalar_one_or_none()
        if permit is None:
            return None
        permit.status = "approved" if approve else "denied"
        permit.decided_at = datetime.now(timezone.utc)
        await db.commit()
        d = permit.to_dict()
    logger.info(f"Permit {permit_id[:8]} {d['status']}")
    return d
