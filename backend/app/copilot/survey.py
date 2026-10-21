"""
Circle survey for Copilot ("survey a 50 metre radius at 30 metres"): a
lawnmower over the disc, as upload-ready waypoints.

Line spacing comes from the camera's ground footprint at the survey
altitude: a nadir camera with horizontal field of view HFOV sees a strip
2 * alt * tan(HFOV / 2) wide, and neighbouring strips overlap by OVERLAP.
With the defaults (70 deg, 30 %) that is about 0.98 x altitude: 29 m apart
at 30 m.

Lines run east-west, centred on the circle so the coverage is symmetric,
alternating direction (boustrophedon). Each line's two ends lie on the
circle. Positions are metres east / north of the centre converted with an
equirectangular projection, which is exact enough at survey scale.
"""
from __future__ import annotations

import math
from typing import Dict, List, Optional

HFOV_DEG = 70.0
OVERLAP = 0.30
SPEED_M_S = 5.0
MAX_WAYPOINTS = 200
M_PER_DEG_LAT = 111_320.0


def footprint_width_m(altitude_m: float, hfov_deg: float = HFOV_DEG) -> float:
    return 2.0 * float(altitude_m) * math.tan(math.radians(hfov_deg) / 2.0)


def line_spacing_m(altitude_m: float, hfov_deg: float = HFOV_DEG, overlap: float = OVERLAP) -> float:
    return footprint_width_m(altitude_m, hfov_deg) * (1.0 - overlap)


def offset(lat: float, lng: float, east_m: float, north_m: float) -> tuple[float, float]:
    """(lat, lng) of a point east_m / north_m from (lat, lng)."""
    dlat = north_m / M_PER_DEG_LAT
    dlng = east_m / (M_PER_DEG_LAT * max(0.01, math.cos(math.radians(lat))))
    return lat + dlat, lng + dlng


def distance_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Equirectangular distance, fine below a few km."""
    x = math.radians(lng2 - lng1) * math.cos(math.radians((lat1 + lat2) / 2.0))
    y = math.radians(lat2 - lat1)
    return math.hypot(x, y) * 6_371_000.0


def plan(center_lat: float, center_lng: float, radius_m: float, altitude_m: float, *,
         hfov_deg: float = HFOV_DEG, overlap: float = OVERLAP, speed_m_s: float = SPEED_M_S,
         spacing_m: Optional[float] = None) -> Dict:
    """{waypoints, spacing_m, lines, length_m, preview}. waypoints are in
    upload_mission's shape; preview is the plan card's map preview."""
    radius_m = float(radius_m)
    altitude_m = float(altitude_m)
    s = float(spacing_m) if spacing_m else line_spacing_m(altitude_m, hfov_deg, overlap)
    s = max(1.0, s)
    n = max(1, math.ceil(2.0 * radius_m / s))
    if 2 * n > MAX_WAYPOINTS:
        raise ValueError(f"{n} survey lines is too many; raise the altitude or shrink the radius")
    pts: List[tuple[float, float]] = []
    for i in range(n):
        y = (i - (n - 1) / 2.0) * s
        half = math.sqrt(max(0.0, radius_m * radius_m - y * y))
        if half < 0.5:
            pts.append((0.0, y))
            continue
        ends = [(-half, y), (half, y)]
        if i % 2:
            ends.reverse()
        pts.extend(ends)
    waypoints = []
    length = 0.0
    prev = None
    for east, north in pts:
        lat, lng = offset(center_lat, center_lng, east, north)
        waypoints.append({"lat": round(lat, 7), "lng": round(lng, 7), "altitude": altitude_m,
                          "speed": speed_m_s, "hold_time": 0, "type": "waypoint", "yaw": None})
        if prev is not None:
            length += math.hypot(east - prev[0], north - prev[1])
        prev = (east, north)
    return {
        "waypoints": waypoints,
        "spacing_m": round(s, 1),
        "lines": n,
        "length_m": round(length, 1),
        "preview": {
            "waypoints": [{"lat": w["lat"], "lng": w["lng"], "alt": altitude_m} for w in waypoints],
            "area": {"center": {"lat": center_lat, "lng": center_lng}, "radius_m": radius_m},
        },
    }
