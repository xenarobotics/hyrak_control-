"""
In-memory zone engine — the single source of truth for "where can a drone
fly". Zones load from Postgres into shapely geometries with a spatial
index; checks are pure functions over lat/lng(/alt), deliberately free of
any session or drone state so the same engine serves one drone, a swarm,
mission validation, and (later) the enforcement monitor.

At the current scale an STRtree over every active zone answers point and
path queries in microseconds — no PostGIS needed until zone counts reach
the tens of thousands.
"""
import logging
import threading

from shapely.geometry import LineString, Point, shape
from shapely.strtree import STRtree

logger = logging.getLogger("verocore.zones")

_SEVERITY = {"green": 0, "orange": 1, "red": 2}

_lock = threading.Lock()
_zones: list[dict] = []          # {id, name, zone_class, floor_m, ceiling_m, geom}
_tree: STRtree | None = None
_tree_geoms: list = []


async def reload() -> int:
    """(Re)load active zones from the DB. Safe to call any time."""
    global _zones, _tree, _tree_geoms
    from sqlalchemy import select
    from app.db import db_available, get_session
    from app.db.models import Zone

    if not db_available():
        return 0
    try:
        async with get_session() as db:
            rows = (
                await db.execute(select(Zone).where(Zone.active == True))  # noqa: E712
            ).scalars().all()
    except Exception as e:
        logger.warning(f"Zone reload failed: {e}")
        return len(_zones)

    zones, geoms = [], []
    for z in rows:
        try:
            geom = shape(z.geometry)
            zones.append({
                "id": z.id, "name": z.name, "zone_class": z.zone_class,
                "floor_m": z.floor_m, "ceiling_m": z.ceiling_m, "geom": geom,
            })
            geoms.append(geom)
        except Exception as e:
            logger.warning(f"Zone {z.id} has bad geometry — skipped: {e}")

    with _lock:
        _zones = zones
        _tree_geoms = geoms
        _tree = STRtree(geoms) if geoms else None
    logger.info(f"Zone engine loaded {len(zones)} active zones")
    return len(zones)


def _alt_applies(z: dict, alt_m: float | None) -> bool:
    if alt_m is None:
        return True
    if alt_m < z["floor_m"]:
        return False
    if z["ceiling_m"] is not None and alt_m > z["ceiling_m"]:
        return False
    return True


def check_point(lat: float, lng: float, alt_m: float | None = None) -> dict:
    """
    Worst zone class at a position. GeoJSON is (lng, lat) order.
    Returns {"zone_class": "green"|"orange"|"red", "zones": [...]} —
    outside every zone counts as green (unrestricted airspace).
    """
    with _lock:
        tree, zones = _tree, _zones
    if tree is None:
        return {"zone_class": "green", "zones": []}

    p = Point(lng, lat)
    hits = []
    for idx in tree.query(p):
        z = zones[idx]
        if z["geom"].covers(p) and _alt_applies(z, alt_m):
            hits.append(z)

    worst = max((h["zone_class"] for h in hits), key=lambda c: _SEVERITY[c], default="green")
    return {
        "zone_class": worst,
        "zones": [
            {"id": h["id"], "name": h["name"], "zone_class": h["zone_class"]}
            for h in sorted(hits, key=lambda h: -_SEVERITY[h["zone_class"]])
        ],
    }


def check_path(points: list[tuple[float, float]], corridor_m: float = 20.0) -> dict:
    """
    Zones crossed by a path of (lat, lng) waypoints, buffered into a
    corridor. Used for pre-arm mission validation.
    Returns {"zone_class": worst, "zones": [...]}.
    """
    with _lock:
        tree, zones = _tree, _zones
    if tree is None or len(points) == 0:
        return {"zone_class": "green", "zones": []}

    lnglat = [(lng, lat) for lat, lng in points]
    path = LineString(lnglat) if len(lnglat) > 1 else Point(lnglat[0])
    # ~degrees per metre at the path's latitude (fine for corridor-sized buffers)
    lat0 = points[0][0]
    import math
    deg = corridor_m / (111_320 * max(0.2, math.cos(math.radians(lat0))))
    corridor = path.buffer(deg)

    hits = []
    for idx in tree.query(corridor):
        z = zones[idx]
        if z["geom"].intersects(corridor):
            hits.append(z)

    worst = max((h["zone_class"] for h in hits), key=lambda c: _SEVERITY[c], default="green")
    return {
        "zone_class": worst,
        "zones": [
            {"id": h["id"], "name": h["name"], "zone_class": h["zone_class"]}
            for h in sorted(hits, key=lambda h: -_SEVERITY[h["zone_class"]])
        ],
    }
