"""Read/write the persistent shared hazard map (known_obstacles).

save() upserts a confirmed static obstacle - merging into a nearby existing
row rather than spawning duplicates, so repeated flights past the same tree
sharpen one entry. load_near() pulls the hazards around a point with a cheap
bounding-box query, to seed a drone's live map before it re-encounters them.
"""
from __future__ import annotations

import logging
import math
from datetime import datetime, timezone

from sqlalchemy import select

from app.db import db_available, get_session
from app.db.models import KnownObstacle

logger = logging.getLogger("verocore.avoidance.hazard_db")

M_PER_DEG_LAT = 111_320.0
MERGE_DIST_M = 5.0


def _bbox(lat: float, lng: float, radius_m: float):
    dlat = radius_m / M_PER_DEG_LAT
    dlng = radius_m / (M_PER_DEG_LAT * max(0.2, math.cos(math.radians(lat))))
    return lat - dlat, lat + dlat, lng - dlng, lng + dlng


def _dist_m(lat1, lng1, lat2, lng2) -> float:
    m_lng = M_PER_DEG_LAT * max(0.2, math.cos(math.radians(lat1)))
    return math.hypot((lat1 - lat2) * M_PER_DEG_LAT, (lng1 - lng2) * m_lng)


async def save(lat: float, lng: float, radius_m: float, *, top_m: float = 0.0,
               confidence: float = 0.5, source: str = "") -> None:
    """Upsert a confirmed static obstacle - merge into a nearby row if one
    exists, else insert. Never call for a moving obstacle."""
    if not db_available():
        return
    lo_lat, hi_lat, lo_lng, hi_lng = _bbox(lat, lng, MERGE_DIST_M)
    now = datetime.now(timezone.utc)
    try:
        async with get_session() as db:
            rows = (await db.execute(
                select(KnownObstacle).where(
                    KnownObstacle.lat.between(lo_lat, hi_lat),
                    KnownObstacle.lng.between(lo_lng, hi_lng))
            )).scalars().all()
            existing = min(
                (r for r in rows if _dist_m(r.lat, r.lng, lat, lng) <= MERGE_DIST_M),
                key=lambda r: _dist_m(r.lat, r.lng, lat, lng), default=None)
            if existing is not None:
                existing.radius_m = max(existing.radius_m or 0.0, radius_m)
                existing.top_m = max(existing.top_m or 0.0, top_m)
                existing.confidence = max(existing.confidence or 0.0, confidence)
                existing.hits = (existing.hits or 0) + 1
                existing.last_seen = now
                if source:
                    existing.source = source
            else:
                db.add(KnownObstacle(
                    lat=lat, lng=lng, radius_m=radius_m, top_m=top_m,
                    confidence=confidence, source=source,
                    first_seen=now, last_seen=now))
            await db.commit()
    except Exception as e:
        logger.debug(f"hazard save failed: {e}")


async def load_near(lat: float, lng: float,
                    radius_m: float = 250.0) -> list[dict]:
    """Known hazards within radius_m of a point, as keep-outs with heights -
    to seed a drone's live map before a flight."""
    if not db_available():
        return []
    lo_lat, hi_lat, lo_lng, hi_lng = _bbox(lat, lng, radius_m)
    try:
        async with get_session() as db:
            rows = (await db.execute(
                select(KnownObstacle).where(
                    KnownObstacle.lat.between(lo_lat, hi_lat),
                    KnownObstacle.lng.between(lo_lng, hi_lng))
            )).scalars().all()
        return [{"lat": r.lat, "lng": r.lng, "radius_m": r.radius_m,
                 "top_m": r.top_m or 0.0, "confidence": r.confidence or 0.5}
                for r in rows
                if _dist_m(r.lat, r.lng, lat, lng) <= radius_m]
    except Exception as e:
        logger.debug(f"hazard load failed: {e}")
        return []


async def all_hazards(limit: int = 2000) -> list[dict]:
    if not db_available():
        return []
    async with get_session() as db:
        rows = (await db.execute(
            select(KnownObstacle).order_by(KnownObstacle.last_seen.desc())
            .limit(limit))).scalars().all()
    return [r.to_dict() for r in rows]


async def clear() -> int:
    """Wipe the hazard map (operator reset). Returns rows removed."""
    if not db_available():
        return 0
    from sqlalchemy import delete
    async with get_session() as db:
        res = await db.execute(delete(KnownObstacle))
        await db.commit()
        return res.rowcount or 0
