"""
Seed APPROXIMATE flight zones for Hyderabad, derived from the Drone Rules
2021 structure (red: within 5 km of an operational airport perimeter;
yellow/orange: 5-8 km band; 8-12 km restricted above ~60 m AGL) applied to
publicly known airfield coordinates.

NOT official data — the DGCA Digital Sky map is the legal authority and has
no public bulk-download API. Every zone is suffixed "(approx)" so it can be
swept and replaced when an official source (e.g. OpenAIP with an API key,
or Digital Sky itself) is integrated.

Idempotent: zones are matched by name and skipped if present.
Run from backend/:  .venv/bin/python scripts/seed_hyderabad_zones.py
Restart the backend (or touch any zone via the API) afterwards so the
engine reloads.
"""
import asyncio
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import select  # noqa: E402

from app.db import get_session, init_db  # noqa: E402
from app.db.models import Zone  # noqa: E402


def circle(lat: float, lng: float, radius_m: float, n: int = 48) -> list[list[float]]:
    """Closed GeoJSON ring (lng, lat) approximating a circle."""
    ring = []
    for i in range(n):
        a = 2 * math.pi * i / n
        dlat = (radius_m * math.cos(a)) / 111_320
        dlng = (radius_m * math.sin(a)) / (111_320 * math.cos(math.radians(lat)))
        ring.append([lng + dlng, lat + dlat])
    ring.append(ring[0])
    return ring


def disc(lat, lng, r) -> dict:
    return {"type": "Polygon", "coordinates": [circle(lat, lng, r)]}


def annulus(lat, lng, r_in, r_out) -> dict:
    # outer ring counter-clockwise + inner ring reversed = hole
    return {"type": "Polygon",
            "coordinates": [circle(lat, lng, r_out), list(reversed(circle(lat, lng, r_in)))]}


# (name, zone_class, geometry, floor_m, ceiling_m)
ZONES = [
    # Rajiv Gandhi International Airport (Shamshabad)
    ("RGIA Airport red (approx)", "red", disc(17.2403, 78.4294, 5000), 0, None),
    ("RGIA 5-8km band (approx)", "orange", annulus(17.2403, 78.4294, 5000, 8000), 0, None),
    ("RGIA 8-12km >60m band (approx)", "orange", annulus(17.2403, 78.4294, 8000, 12000), 60, None),
    # Begumpet Airport (city centre, operational)
    ("Begumpet Airport red (approx)", "red", disc(17.4531, 78.4676, 5000), 0, None),
    ("Begumpet 5-8km band (approx)", "orange", annulus(17.4531, 78.4676, 5000, 8000), 0, None),
    # Military airfields
    ("Hakimpet AFS red (approx)", "red", disc(17.5534, 78.5525, 5000), 0, None),
    ("Dundigal AF Academy red (approx)", "red", disc(17.6272, 78.4033, 4000), 0, None),
    # Secunderabad Cantonment — rough bounding polygon
    ("Secunderabad Cantonment (approx)", "orange", {
        "type": "Polygon",
        "coordinates": [[
            [78.480, 17.435], [78.530, 17.435], [78.530, 17.478],
            [78.480, 17.478], [78.480, 17.435],
        ]],
    }, 0, None),
]


async def main():
    if not await init_db():
        print("Database unavailable — aborting")
        return
    added = skipped = 0
    async with get_session() as db:
        for name, cls, geom, floor, ceiling in ZONES:
            exists = (
                await db.execute(select(Zone).where(Zone.name == name))
            ).scalar_one_or_none()
            if exists:
                skipped += 1
                continue
            db.add(Zone(name=name, zone_class=cls, geometry=geom,
                        floor_m=floor, ceiling_m=ceiling))
            added += 1
        await db.commit()
    print(f"Seeded {added} zone(s), {skipped} already present.")
    print("Restart the backend so the zone engine reloads.")


if __name__ == "__main__":
    asyncio.run(main())
