"""Persist and read avoidance events - the Mission-tab timeline + review."""
from __future__ import annotations

import logging

from sqlalchemy import select

from app.db import db_available, get_session
from app.db.models import AvoidanceEvent

logger = logging.getLogger("verocore.avoidance.events")


async def record(*, drone_id: str, action: str, state: str, reason: str,
                 obstacle: dict | None, armed: bool,
                 fused_distance_m: float | None) -> None:
    if not db_available():
        return
    ob = obstacle or {}
    async with get_session() as db:
        db.add(AvoidanceEvent(
            drone_id=drone_id or "", action=action, state=state,
            reason=reason[:500], armed=armed,
            obstacle_lat=ob.get("lat"), obstacle_lng=ob.get("lng"),
            obstacle_radius_m=ob.get("radius_m"),
            fused_distance_m=fused_distance_m))
        await db.commit()


async def list_for(drone_id: str | None = None, limit: int = 100) -> list[dict]:
    if not db_available():
        return []
    stmt = select(AvoidanceEvent).order_by(AvoidanceEvent.t.desc()).limit(limit)
    if drone_id:
        stmt = stmt.where(AvoidanceEvent.drone_id == drone_id)
    async with get_session() as db:
        rows = (await db.execute(stmt)).scalars().all()
    return [e.to_dict() for e in rows]
