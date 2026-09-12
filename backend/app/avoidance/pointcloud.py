"""Dense obstacle extraction from a 3D point cloud.

The LiDAR / recon-cloud counterpart of detector.observations_from_depth: given
points in the drone's body frame it bins them by horizontal bearing and emits
the nearest obstacle in each bin - so clutter becomes 'obstacle, GAP, obstacle'
the planner can thread, exactly like the depth path. Unlike monocular depth, a
point cloud carries HEIGHT, so top_m is real (absolute AGL) and climb-over is
available over these obstacles.

This is the interface the recon-engine bridge will feed: pull the engine's
point cloud, rotate it into the drone body frame, call this. Ground points are
dropped, so the floor is never mistaken for a wall.
"""
from __future__ import annotations

import math
from collections import defaultdict
from typing import Iterable, Sequence

from app.avoidance.observations import ObstacleObservation


def observations_from_pointcloud(
        points: Iterable[Sequence[float]], *, sensor_alt_m: float = 0.0,
        hfov_deg: float = 360.0, bin_deg: float = 8.0,
        min_range_m: float = 0.5, max_range_m: float = 40.0,
        ground_agl_m: float = 0.5, min_points: int = 3
) -> list[ObstacleObservation]:
    """`points` are (forward, right, up) metres in the DRONE BODY frame.
    `sensor_alt_m` is the drone's height AGL, so a point's absolute height is
    sensor_alt_m + up - used to drop ground and to set an absolute top_m."""
    bins: dict[int, list[tuple[float, float, float]]] = defaultdict(list)
    for p in points:
        fwd, right, up = float(p[0]), float(p[1]), float(p[2])
        z_abs = sensor_alt_m + up
        if z_abs < ground_agl_m:            # the floor is not an obstacle
            continue
        d = math.hypot(fwd, right)
        if not (min_range_m < d < max_range_m):
            continue
        brg = math.degrees(math.atan2(right, fwd))   # 0 ahead, + to the right
        if abs(brg) > hfov_deg / 2.0:
            continue
        bins[round(brg / bin_deg)].append((d, brg, z_abs))

    out: list[ObstacleObservation] = []
    for pts in bins.values():
        if len(pts) < min_points:
            continue
        d = min(p[0] for p in pts)
        near = [p for p in pts if p[0] <= d * 1.3]
        bearing = sum(p[1] for p in near) / len(near)
        spread = max(p[1] for p in near) - min(p[1] for p in near)
        top = max(p[2] for p in pts)        # absolute AGL of the tallest point
        out.append(ObstacleObservation(
            bearing_deg=bearing, distance_m=d,
            half_width_deg=max(2.0, spread / 2.0 + bin_deg / 2.0),
            confidence=0.85, top_m=max(0.0, top), source="pointcloud"))
    return out
