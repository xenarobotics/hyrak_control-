"""A short-term world map of obstacles - the memory the avoidance layer plans
against.

Reacting to one instantaneous sensor blip at a time is fragile: the drone
forgets an obstacle the moment it leaves the sensor cone, re-reacts to the
same one repeatedly, and can be cornered by a second obstacle it "isn't
looking at". A robust system fuses every reading - any bearing, any source -
into a persistent set of world keep-outs (lat/lng/radius/height) that decays
over time, and plans around ALL of them at once.

World-frame, per drone. Nearby detections merge into one obstacle (a moving
average of position, the max radius/height seen), so repeated hits sharpen a
single entry instead of spawning duplicates; entries no sensor has refreshed
within ttl_s expire.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

M_PER_DEG_LAT = 111_320.0


def _dist_m(lat1, lng1, lat2, lng2) -> float:
    import math
    m_lng = M_PER_DEG_LAT * max(0.2, math.cos(math.radians(lat1)))
    return (((lat1 - lat2) * M_PER_DEG_LAT) ** 2
            + ((lng1 - lng2) * m_lng) ** 2) ** 0.5


@dataclass
class MappedObstacle:
    lat: float
    lng: float
    radius_m: float
    top_m: float          # estimated top height (0 = unknown/ground-based)
    confidence: float
    last_seen: float
    hits: int = 1
    # Estimated ground velocity (metres/s, north & east), for dynamic
    # obstacles - a person or vehicle in a park. 0,0 = static / not yet known.
    vn_mps: float = 0.0
    ve_mps: float = 0.0

    def speed_mps(self) -> float:
        return (self.vn_mps ** 2 + self.ve_mps ** 2) ** 0.5

    def is_static(self) -> bool:
        """A confirmed, stationary obstacle worth remembering across flights -
        seen enough times and not moving. A fast-moving detection is a person
        or vehicle and must NEVER be written to the shared hazard map."""
        return self.hits >= 3 and self.speed_mps() < 0.5

    def as_keepout(self) -> dict:
        return {"lat": self.lat, "lng": self.lng, "radius_m": self.radius_m}

    def predicted_keepout(self, horizon_s: float) -> dict:
        """Where this obstacle will be `horizon_s` from now, with the keep-out
        grown to cover the swept path - so the drone plans around where a
        moving obstacle is GOING, not where it was."""
        import math
        speed = self.speed_mps()
        if speed < 0.3:                      # effectively static
            return self.as_keepout()
        m_lat = M_PER_DEG_LAT
        m_lng = M_PER_DEG_LAT * max(0.2, math.cos(math.radians(self.lat)))
        return {
            "lat": self.lat + self.vn_mps * horizon_s / m_lat,
            "lng": self.lng + self.ve_mps * horizon_s / m_lng,
            # grow by half the swept distance so the whole path is covered
            "radius_m": self.radius_m + speed * horizon_s * 0.5,
        }


@dataclass
class ObstacleMap:
    ttl_s: float = 8.0          # unrefreshed obstacles expire after this
    merge_dist_m: float = 5.0   # detections closer than this are the same one
    _obs: list[MappedObstacle] = field(default_factory=list)

    def add(self, keepout: dict, *, top_m: float = 0.0,
            confidence: float = 0.5, now: float | None = None) -> None:
        now = now if now is not None else time.monotonic()
        lat, lng = float(keepout["lat"]), float(keepout["lng"])
        radius = float(keepout.get("radius_m", 2.0))
        import math
        for o in self._obs:
            if _dist_m(o.lat, o.lng, lat, lng) <= self.merge_dist_m:
                # Estimate velocity from the position shift since last seen
                # (low-pass filtered) - a moving obstacle's detections merge
                # into one entry that carries its motion.
                dt = now - o.last_seen
                if 0.05 < dt < 2.0:
                    m_lng = M_PER_DEG_LAT * max(0.2, math.cos(math.radians(o.lat)))
                    vn = (lat - o.lat) * M_PER_DEG_LAT / dt
                    ve = (lng - o.lng) * m_lng / dt
                    a = 0.4   # smoothing
                    o.vn_mps = (1 - a) * o.vn_mps + a * max(-25.0, min(25.0, vn))
                    o.ve_mps = (1 - a) * o.ve_mps + a * max(-25.0, min(25.0, ve))
                # Confidence-weighted position update, keep the largest extent.
                w = confidence / (o.confidence + confidence + 1e-6)
                o.lat += (lat - o.lat) * w
                o.lng += (lng - o.lng) * w
                o.radius_m = max(o.radius_m, radius)
                o.top_m = max(o.top_m, top_m)
                o.confidence = max(o.confidence, confidence)
                o.last_seen = now
                o.hits += 1
                return
        self._obs.append(MappedObstacle(
            lat=lat, lng=lng, radius_m=radius, top_m=top_m,
            confidence=confidence, last_seen=now))

    def _prune(self, now: float) -> None:
        self._obs = [o for o in self._obs if now - o.last_seen <= self.ttl_s]

    def active(self, now: float | None = None) -> list[MappedObstacle]:
        now = now if now is not None else time.monotonic()
        self._prune(now)
        return list(self._obs)

    def keepouts(self, now: float | None = None) -> list[dict]:
        return [o.as_keepout() for o in self.active(now)]

    def clear(self) -> None:
        self._obs.clear()
