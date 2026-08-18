"""
Geodesy helpers shared across the platform.

Exists because `_haversine_m` had already been written twice — in
flights/recorder.py and events/swarm_events.py — and group follow needed a
third. Three private copies of the same six lines is how two of them end up
disagreeing about the earth's radius, and the one that matters is always the
one nobody re-read.
"""
import math

#: Mean earth radius. Haversine assumes a sphere, which costs ~0.3% against
#: WGS84 — a decimetre over the tens of metres this is used for, and far below
#: the metre-scale noise of the GPS fixes being differenced.
EARTH_RADIUS_M = 6_371_000.0


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance between two WGS84 points, in metres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))
