"""
Drone registry - maps a flight controller's hardware UID to a persistent
drone record. Every function degrades to None/[] when the DB is offline,
so callers never need their own fallback logic.
"""
import logging
from datetime import datetime, timezone

from sqlalchemy import select

from app.db import Drone, db_available, get_session
from app.db.models import PLATFORM_WORKSPACE_ID

logger = logging.getLogger("verocore.registry")


async def upsert_seen(hardware_uid: str, is_simulated: bool = False,
                      claim_workspace_id: str | None = None) -> dict | None:
    """
    Called on every telemetry connect. Known UID → bump last_seen and return
    the existing record; unknown UID → create one with a default name.

    claim_workspace_id: the connecting session's workspace. A drone seen for
    the first time joins it ("claimed", docs/ACCESS_MODEL.md 8a) and the
    record comes back with `claimed: True` when that is not the platform
    workspace, so the caller can audit it. A known drone is never moved:
    every drone seen before phase 2a was seen by staff and is HYRAK's, and
    moving one later is an explicit drones.manage action.
    """
    hardware_uid = "".join(c for c in hardware_uid if c.isprintable()).strip()
    if not db_available() or not hardware_uid:
        return None
    try:
        async with get_session() as db:
            drone = (
                await db.execute(select(Drone).where(Drone.hardware_uid == hardware_uid))
            ).scalar_one_or_none()
            claimed = False
            if drone is None:
                drone = Drone(
                    hardware_uid=hardware_uid,
                    name=f"Drone-{hardware_uid[-6:].upper()}",
                    is_simulated=is_simulated,
                )
                if claim_workspace_id and not is_simulated:
                    drone.workspace_id = claim_workspace_id
                    claimed = claim_workspace_id != PLATFORM_WORKSPACE_ID
                db.add(drone)
                logger.info(f"New drone registered: {drone.name} (uid …{hardware_uid[-8:]})")
            else:
                drone.last_seen = datetime.now(timezone.utc)
            await db.commit()
            out = drone.to_dict()
            if claimed:
                out["claimed"] = True
            return out
    except Exception as e:
        logger.warning(f"Drone registry upsert failed: {e}")
        return None


async def list_drones() -> list[dict]:
    if not db_available():
        return []
    try:
        async with get_session() as db:
            rows = (
                await db.execute(select(Drone).order_by(Drone.last_seen.desc()))
            ).scalars().all()
            return [d.to_dict() for d in rows]
    except Exception as e:
        logger.warning(f"Drone registry list failed: {e}")
        return []


async def rename_drone(drone_id: str, name: str) -> dict | None:
    if not db_available():
        return None
    try:
        async with get_session() as db:
            drone = (
                await db.execute(select(Drone).where(Drone.id == drone_id))
            ).scalar_one_or_none()
            if drone is None:
                return None
            drone.name = name.strip()[:120]
            await db.commit()
            return drone.to_dict()
    except Exception as e:
        logger.warning(f"Drone rename failed: {e}")
        return None
