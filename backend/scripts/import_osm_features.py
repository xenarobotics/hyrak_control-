"""
Import land-use map features for the mission planner from OpenStreetMap.

Fetches roads, forests, water, farmland, open fields, hostels, residential
and campus areas for a bounding box via the Overpass API, buffers road
centrelines into corridors, unions everything per category, and stores ONE
MultiPolygon row per category in map_features. The planner's cost
rasteriser reads these to make route profiles ("Over roads", "Unmanned
areas"...) mean something on real ground.

Re-runnable: rows named "<AREA> <category> (OSM)" are replaced on each run,
hand-drawn features are never touched. Default area is the IIT Hyderabad
campus and surroundings at Kandi.

Run from backend/:  .venv/bin/python scripts/import_osm_features.py
Then restart the backend (or POST any map-feature via the API) so the
feature overlay reloads.
"""
import asyncio
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from shapely.geometry import LineString, Polygon, mapping, shape  # noqa: E402
from shapely.ops import unary_union  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app.db import get_session, init_db  # noqa: E402
from app.db.models import MapFeature  # noqa: E402

AREA_NAME = "IITH"
# South, west, north, east - IIT Hyderabad (Kandi) campus and its delivery
# surroundings. Wide enough that a route to the campus edge still has data.
BBOX = (17.570, 78.095, 17.625, 78.155)

OVERPASS = "https://overpass-api.de/api/interpreter"

# What OSM tags mean in the planner's category vocabulary. Roads are
# LINES in OSM and become corridors here; everything else is areas.
ROAD_WIDTHS_M = {
    "motorway": 16, "trunk": 14, "primary": 12, "secondary": 10,
    "tertiary": 8, "unclassified": 7, "residential": 7, "service": 5,
    "living_street": 6, "track": 4,
}

AREA_RULES: list[tuple[str, dict[str, set[str] | None]]] = [
    # (category, {tag: accepted values or None for any})
    ("forest",      {"landuse": {"forest"}, "natural": {"wood", "scrub"}}),
    ("water",       {"natural": {"water"}, "landuse": {"reservoir", "basin"}, "water": None}),
    ("farmland",    {"landuse": {"farmland", "orchard", "vineyard", "greenhouse_horticulture"}}),
    ("open_field",  {"landuse": {"grass", "meadow", "recreation_ground"},
                     "leisure": {"pitch", "park", "playground", "sports_centre", "stadium"},
                     "natural": {"grassland", "heath"}}),
    ("residential", {"landuse": {"residential"}}),
    ("industrial",  {"landuse": {"industrial", "construction"}}),
    ("school",      {"amenity": {"school", "kindergarten"}}),
    ("campus",      {"amenity": {"university", "college"}}),
]


def overpass_query() -> str:
    s, w, n, e = BBOX
    bbox = f"{s},{w},{n},{e}"
    return f"""
[out:json][timeout:90];
(
  way["highway"]({bbox});
  way["landuse"]({bbox});
  way["natural"]({bbox});
  way["leisure"]({bbox});
  way["amenity"~"school|university|college|kindergarten"]({bbox});
  way["water"]({bbox});
  way["building"]({bbox});
  relation["landuse"]({bbox});
  relation["amenity"~"university|college"]({bbox});
);
out body geom;
"""


def fetch_osm() -> list[dict]:
    data = urllib.parse.urlencode({"data": overpass_query()}).encode()
    req = urllib.request.Request(OVERPASS, data=data,
                                 headers={"User-Agent": "hyrak-planner-import/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)["elements"]


def element_polygon(el: dict) -> Polygon | None:
    """Closed way / relation outer ring -> shapely Polygon (lng, lat)."""
    if el["type"] == "way":
        geom = el.get("geometry") or []
        if len(geom) < 4:
            return None
        ring = [(g["lon"], g["lat"]) for g in geom]
        if ring[0] != ring[-1]:
            return None
        try:
            p = Polygon(ring)
            return p if p.is_valid and p.area > 0 else p.buffer(0)
        except Exception:
            return None
    if el["type"] == "relation":
        outers = []
        for m in el.get("members", []):
            if m.get("role") == "outer" and m.get("geometry"):
                ring = [(g["lon"], g["lat"]) for g in m["geometry"]]
                if len(ring) >= 4:
                    try:
                        outers.append(Polygon(ring).buffer(0))
                    except Exception:
                        pass
        if outers:
            return unary_union(outers)
    return None


def categorize(tags: dict) -> list[str]:
    cats = []
    name = (tags.get("name") or "").lower()
    building = tags.get("building") or ""
    # Hostels: IITH's hostel blocks are buildings; catch both the tag and
    # the naming convention so "Block A Hostel" counts even if tagged plain.
    if building in ("dormitory", "hostel") or tags.get("tourism") == "hostel" \
            or ("hostel" in name and (building or tags.get("amenity"))):
        cats.append("hostel")
    if building in ("residential", "apartments", "house", "detached", "terrace"):
        cats.append("residential")
    for category, rules in AREA_RULES:
        for tag, accepted in rules.items():
            v = tags.get(tag)
            if v is None:
                continue
            if accepted is None or v in accepted:
                cats.append(category)
                break
    return cats


def m_buffer(deg_per_m_lat: float, deg_per_m_lng: float, width_m: float) -> float:
    # Buffer in degrees; use the mean so corridors are near-round.
    return width_m / 2 * (deg_per_m_lat + deg_per_m_lng) / 2


async def main() -> None:
    print(f"Fetching OSM data for {AREA_NAME} bbox {BBOX} ...")
    elements = fetch_osm()
    print(f"  {len(elements)} elements")

    import math
    mid_lat = (BBOX[0] + BBOX[2]) / 2
    deg_lat = 1 / 111_320
    deg_lng = 1 / (111_320 * math.cos(math.radians(mid_lat)))

    per_cat: dict[str, list] = {}

    for el in elements:
        tags = el.get("tags") or {}
        highway = tags.get("highway")
        if highway:
            width = ROAD_WIDTHS_M.get(highway)
            if width is None:
                continue  # footways/paths aren't flight corridors
            geom = el.get("geometry") or []
            if len(geom) < 2:
                continue
            line = LineString([(g["lon"], g["lat"]) for g in geom])
            per_cat.setdefault("road", []).append(
                line.buffer(m_buffer(deg_lat, deg_lng, width), cap_style="flat"))
            continue
        cats = categorize(tags)
        if not cats:
            continue
        poly = element_polygon(el)
        if poly is None or poly.is_empty:
            continue
        for c in cats:
            per_cat.setdefault(c, []).append(poly)

    await init_db()
    async with get_session() as db:
        for category, geoms in sorted(per_cat.items()):
            merged = unary_union(geoms).simplify(2 * deg_lat)  # ~2 m tolerance
            gj = mapping(merged)
            # Sanity: shapely must be able to read its own output
            shape(gj)
            name = f"{AREA_NAME} {category} (OSM)"
            existing = (
                await db.execute(select(MapFeature).where(MapFeature.name == name))
            ).scalars().first()
            n_polys = len(getattr(merged, "geoms", [merged]))
            if existing:
                existing.geometry = gj
                existing.category = category
                existing.active = True
                print(f"  updated {name}: {len(geoms)} shapes -> {n_polys} polygons")
            else:
                db.add(MapFeature(name=name, category=category, geometry=gj, active=True))
                print(f"  created {name}: {len(geoms)} shapes -> {n_polys} polygons")
        await db.commit()
    print("Done. Restart the backend (or POST a map-feature) to reload the overlay.")


if __name__ == "__main__":
    asyncio.run(main())
