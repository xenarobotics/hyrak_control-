"""
In-memory land-use overlay - the planner-side twin of app.zones.engine.

Map features (roads, forests, hostels...) load from Postgres into shapely
geometries once and are queried lock-free-per-call after that. Like the
zone engine, this degrades to empty when the DB is offline: the planner
then simply has no preferences to act on and flies the shortest legal path.
"""
import logging
import threading

from shapely.geometry import Point, shape
from shapely.strtree import STRtree

logger = logging.getLogger("verocore.planner.features")

_lock = threading.Lock()
_features: list[dict] = []       # {id, name, category, geom}
_tree: STRtree | None = None


async def reload() -> int:
    """(Re)load active map features from the DB. Safe to call any time."""
    global _features, _tree
    from sqlalchemy import select
    from app.db import db_available, get_session
    from app.db.models import MapFeature

    if not db_available():
        return 0
    try:
        async with get_session() as db:
            rows = (
                await db.execute(
                    select(MapFeature).where(MapFeature.active == True)  # noqa: E712
                )
            ).scalars().all()
    except Exception as e:
        logger.warning(f"Map feature reload failed: {e}")
        return len(_features)

    feats, geoms = [], []
    for f in rows:
        try:
            geom = shape(f.geometry)
            feats.append({"id": f.id, "name": f.name, "category": f.category, "geom": geom})
            geoms.append(geom)
        except Exception as e:
            logger.warning(f"Map feature {f.id} has bad geometry - skipped: {e}")

    with _lock:
        _features = feats
        _tree = STRtree(geoms) if geoms else None
    logger.info(f"Feature overlay loaded {len(feats)} active map features")
    return len(feats)


def set_features(feats: list[dict]) -> None:
    """Inject features directly ({category, geom} shapely dicts) - used by
    tests and by any future non-DB overlay source."""
    global _features, _tree
    with _lock:
        _features = list(feats)
        _tree = STRtree([f["geom"] for f in feats]) if feats else None


def snapshot() -> list[dict]:
    """Current feature list - read-only view for the cost rasteriser."""
    with _lock:
        return list(_features)


def categories_at(lat: float, lng: float) -> set[str]:
    """Every feature category covering a point (GeoJSON is lng,lat order)."""
    with _lock:
        tree, feats = _tree, _features
    if tree is None:
        return set()
    p = Point(lng, lat)
    return {
        feats[idx]["category"]
        for idx in tree.query(p)
        if feats[idx]["geom"].covers(p)
    }
