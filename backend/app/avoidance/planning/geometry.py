"""Body-frame observation -> world keep-out.

An obstacle the sensor reports as "8 m ahead, a bit to the left" only becomes
useful once it is pinned to a lat/lng, which needs the drone's live pose
(position + heading). The keep-out radius folds the obstacle's own lateral
extent (distance * tan(half_width)) together with the safety clearance, so the
planner is told to stay a real, generous margin away, not just off the exact
point.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from app.avoidance.sensing.observations import ObstacleObservation

M_PER_DEG_LAT = 111_320.0


@dataclass
class Pose:
    lat: float
    lng: float
    heading_deg: float  # compass heading of the nose, 0 = north, clockwise
    alt_m: float = 0.0


def observation_to_keepout(pose: Pose, obs: ObstacleObservation,
                           clearance_m: float = 4.0) -> dict:
    """Project a body-frame observation to a world keep-out {lat, lng,
    radius_m}. World bearing = heading + body bearing (both clockwise from
    north)."""
    world_bearing = math.radians((pose.heading_deg + obs.bearing_deg) % 360.0)
    m_lng = M_PER_DEG_LAT * max(0.2, math.cos(math.radians(pose.lat)))
    north_m = obs.distance_m * math.cos(world_bearing)
    east_m = obs.distance_m * math.sin(world_bearing)
    lat = pose.lat + north_m / M_PER_DEG_LAT
    lng = pose.lng + east_m / m_lng
    # Obstacle half-width in metres at that range, plus the safety clearance.
    lateral_m = obs.distance_m * math.tan(math.radians(
        max(1.0, min(80.0, obs.half_width_deg))))
    radius_m = max(1.0, lateral_m + clearance_m)
    return {"lat": lat, "lng": lng, "radius_m": radius_m}


def distance_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    m_lng = M_PER_DEG_LAT * max(0.2, math.cos(math.radians(lat1)))
    return math.hypot((lat1 - lat2) * M_PER_DEG_LAT, (lng1 - lng2) * m_lng)
