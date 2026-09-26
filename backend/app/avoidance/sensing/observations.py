"""The obstacle observation bus - the sensor-fusion foundation.

Every sensor, whatever it is, produces the SAME thing: an ObstacleObservation
in the drone's body frame (bearing relative to nose, distance, angular
half-width, a confidence, and which source it came from). The bus holds the
recent ones, expires stale ones, and fuses them into a per-sector nearest
distance - so adding a ToF ring or a LiDAR summary later is registering a new
source, never rewriting the decision layer.

The sector grid deliberately matches MAVLink OBSTACLE_DISTANCE (72 sectors of
5 degrees, 0 = straight ahead, clockwise): the same fused array we plan
against is the array we hand PX4's on-vehicle collision prevention once a real
range sensor exists.
"""
from __future__ import annotations

import time
from dataclasses import dataclass

SECTOR_DEG = 5.0
N_SECTORS = 72  # 360 / 5 - matches MAVLink OBSTACLE_DISTANCE
_MAX_CM = 65535  # OBSTACLE_DISTANCE "no reading" sentinel range


@dataclass
class ObstacleObservation:
    """One obstacle reading in the DRONE BODY frame.

    bearing_deg: 0 = straight ahead (the nose), positive = clockwise to the
        right, range (-180, 180]. NOT a compass heading - the geometry layer
        rotates it into the world by the drone's heading.
    """
    bearing_deg: float
    distance_m: float
    half_width_deg: float = 5.0
    confidence: float = 0.5
    source: str = "unknown"
    #: Estimated top height of the obstacle in metres, when the sensor can
    #: judge it (a depth/3D sensor, a lidar). 0 = unknown - a bearing-only
    #: sensor cannot see height, so the obstacle is treated as blocking at
    #: every altitude and climb-over is never risked over it.
    top_m: float = 0.0
    t: float = 0.0

    def __post_init__(self):
        if not self.t:
            self.t = time.monotonic()
        # Normalise bearing to (-180, 180].
        b = (self.bearing_deg + 180.0) % 360.0 - 180.0
        self.bearing_deg = 180.0 if b == -180.0 else b


def _sector_of(bearing_deg: float) -> int:
    """Sector index 0..71 for a body-frame bearing (0 ahead, clockwise)."""
    return int((bearing_deg % 360.0) // SECTOR_DEG)


class ObservationBus:
    """Per-drone rolling window of observations, fused on demand.

    ttl_s: an observation older than this is ignored - a stale "clear" or a
    stale "obstacle" is equally dangerous, so the window is short.
    """

    _CAP = 512  # hard length cap so a silent (never-read) bus cannot grow

    def __init__(self, ttl_s: float = 2.0):
        self.ttl_s = ttl_s
        self._obs: list[ObstacleObservation] = []

    def add(self, obs: ObstacleObservation) -> None:
        # Expiry happens on READ (against the query's clock), never here - a
        # newly added reading must never be dropped by comparing its timestamp
        # to the wall clock. add() only bounds the list length.
        self._obs.append(obs)
        if len(self._obs) > self._CAP:
            self._obs = self._obs[-self._CAP:]

    def clear(self) -> None:
        self._obs.clear()

    def _prune(self, now: float | None = None) -> None:
        now = now if now is not None else time.monotonic()
        self._obs = [o for o in self._obs if now - o.t <= self.ttl_s]

    def fused_sectors(self, now: float | None = None,
                      min_confidence: float = 0.0) -> list[float | None]:
        """Nearest distance per 5-degree sector (metres), or None if nothing
        credible is seen there. An observation paints every sector its angular
        half-width touches, so a wide obstacle blocks several sectors."""
        now = now if now is not None else time.monotonic()
        self._prune(now)
        sectors: list[float | None] = [None] * N_SECTORS
        for o in self._obs:
            if o.confidence < min_confidence or o.distance_m <= 0:
                continue
            span = max(SECTOR_DEG, o.half_width_deg)
            start = _sector_of(o.bearing_deg - span)
            n = int((2 * span) // SECTOR_DEG) + 1
            for k in range(n):
                s = (start + k) % N_SECTORS
                if sectors[s] is None or o.distance_m < sectors[s]:
                    sectors[s] = o.distance_m
        return sectors

    def recent(self, min_confidence: float = 0.0,
               now: float | None = None) -> list[ObstacleObservation]:
        """All fresh, credible observations - for the world map, which fuses
        every bearing (not just the forward cone) into persistent obstacles."""
        now = now if now is not None else time.monotonic()
        self._prune(now)
        return [o for o in self._obs
                if o.confidence >= min_confidence and o.distance_m > 0]

    def nearest_ahead(self, cone_deg: float = 60.0,
                      min_confidence: float = 0.0,
                      now: float | None = None) -> ObstacleObservation | None:
        """The closest credible obstacle within +/- cone_deg of the nose - the
        only thing the avoidance loop reacts to (a wall behind you is not a
        threat). Returns a synthesised observation at the fused sector, or
        None when the forward cone is clear."""
        now = now if now is not None else time.monotonic()
        self._prune(now)
        best: ObstacleObservation | None = None
        for o in self._obs:
            if o.confidence < min_confidence or o.distance_m <= 0:
                continue
            # Fold bearing into +/-180 and test the forward cone.
            if abs(o.bearing_deg) > cone_deg:
                continue
            if best is None or o.distance_m < best.distance_m:
                best = o
        return best

    def obstacle_distance_cm(self, now: float | None = None,
                             min_confidence: float = 0.0) -> list[int]:
        """The fused sectors as a MAVLink OBSTACLE_DISTANCE centimetre array
        (65535 = no reading). This is the exact message PX4's collision
        prevention wants - the hook for the on-vehicle reflex layer once a
        real range sensor is streaming. Built now so nothing downstream
        changes when it lands."""
        cm: list[int] = []
        for d in self.fused_sectors(now, min_confidence):
            if d is None:
                cm.append(_MAX_CM)
            else:
                cm.append(min(_MAX_CM - 1, max(1, int(round(d * 100)))))
        return cm
