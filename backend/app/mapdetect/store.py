"""
Recorded sightings in Postgres (the map_sightings table).

Every function degrades to a no-op / empty answer with the database offline:
recording to the map must never touch the flight path or the video.
`workspace_ids` follows app/auth/data_scope.DataScope.ids(): None reads
everything (founders), [] reads nothing.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Iterable, Optional

from app.db import db_available, get_session

logger = logging.getLogger("verocore.mapdetect.store")


def _dt(t: Optional[float]) -> datetime:
    return datetime.fromtimestamp(float(t or 0.0), tz=timezone.utc)


async def upsert(rows: Iterable[dict]) -> int:
    """Insert or update sightings by id. Each row is a Sighting.to_dict()
    plus session_id, flight_id, workspace_id, drone_id. Returns rows written."""
    rows = list(rows)
    if not rows or not db_available():
        return 0
    from app.db.models import MapSighting
    try:
        async with get_session() as db:
            for r in rows:
                rec = MapSighting(
                    id=r["id"], session_id=r["session_id"], flight_id=r.get("flight_id"),
                    drone_id=r.get("drone_id"), source=str(r.get("source") or "")[:80],
                    model_name=str(r.get("model_name") or "")[:120],
                    label=str(r.get("label") or "")[:80],
                    task=r.get("task") if r.get("task") in ("detect", "classify") else "detect",
                    lat=float(r["lat"]), lng=float(r["lon"]),
                    accuracy_m=float(r["accuracy_m"]), count=int(r.get("count") or 1),
                    first_seen=_dt(r.get("first_seen")), last_seen=_dt(r.get("last_seen")),
                    best_score=r.get("best_score"), agl_m=r.get("agl_m"),
                    angle_source=str(r.get("angle_source") or "")[:16],
                    thumb=r.get("thumb"),
                )
                if r.get("workspace_id"):
                    rec.workspace_id = r["workspace_id"]
                await db.merge(rec)
            await db.commit()
        return len(rows)
    except Exception as e:
        logger.warning(f"map sightings write failed ({len(rows)} rows): {e}")
        return 0


async def list_rows(*, session_id: Optional[str] = None, flight_id: Optional[str] = None,
                    workspace_ids=None, limit: int = 10000) -> list[dict]:
    if workspace_ids == [] or not db_available() or not (session_id or flight_id):
        return []
    from sqlalchemy import select
    from app.db.models import MapSighting
    q = select(MapSighting).order_by(MapSighting.first_seen).limit(limit)
    if session_id:
        q = q.where(MapSighting.session_id == session_id)
    if flight_id:
        q = q.where(MapSighting.flight_id == flight_id)
    if workspace_ids is not None:
        q = q.where(MapSighting.workspace_id.in_(list(workspace_ids)))
    try:
        async with get_session() as db:
            return [r.to_dict() for r in (await db.execute(q)).scalars().all()]
    except Exception as e:
        logger.warning(f"map sightings read failed: {e}")
        return []


async def delete_rows(*, session_id: Optional[str] = None, flight_id: Optional[str] = None,
                      workspace_ids=None) -> int:
    if workspace_ids == [] or not db_available() or not (session_id or flight_id):
        return 0
    from sqlalchemy import delete
    from app.db.models import MapSighting
    q = delete(MapSighting)
    if session_id:
        q = q.where(MapSighting.session_id == session_id)
    if flight_id:
        q = q.where(MapSighting.flight_id == flight_id)
    if workspace_ids is not None:
        q = q.where(MapSighting.workspace_id.in_(list(workspace_ids)))
    async with get_session() as db:
        res = await db.execute(q)
        await db.commit()
        return int(res.rowcount or 0)


async def workspace_of_session(session_id: str) -> Optional[str]:
    """The workspace a session's recorded rows belong to (durable: survives
    the session and a server restart). None when it recorded nothing."""
    if not db_available():
        return None
    from sqlalchemy import select
    from app.db.models import MapSighting
    try:
        async with get_session() as db:
            return (await db.execute(
                select(MapSighting.workspace_id).where(MapSighting.session_id == session_id)
                .limit(1))).scalar_one_or_none()
    except Exception:
        return None


async def counts_for_flights(flight_ids: list[str]) -> dict[str, int]:
    """Sightings per flight, for the Flights list."""
    if not flight_ids or not db_available():
        return {}
    from sqlalchemy import func, select
    from app.db.models import MapSighting
    try:
        async with get_session() as db:
            rows = (await db.execute(
                select(MapSighting.flight_id, func.count()).where(
                    MapSighting.flight_id.in_(flight_ids)).group_by(MapSighting.flight_id))).all()
        return {fid: int(n) for fid, n in rows}
    except Exception:
        return {}
