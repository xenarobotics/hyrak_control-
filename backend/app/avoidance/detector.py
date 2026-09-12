"""Monocular obstacle sensing - depth map -> obstacle observation.

Phase 2 foundation, kept a PURE function so it is testable without the vision
pipeline: hand it a metric depth map (from the depth/3D-recon mode, scale-
aligned to metres) and it returns the nearest obstacle in the forward cone as
an ObstacleObservation, or None when the way ahead is clear.

Deliberately conservative - monocular depth is assist-grade (scale-ambiguous,
blind to thin obstacles), so the confidence is capped low and a reading needs
a cluster of agreeing pixels, not one hot pixel. The live wiring (calling this
from the depth analyzer and pushing to controller(drone_id).observe()) is the
last integration step, done against the real depth-output shape in the field.
"""
from __future__ import annotations

import numpy as np

from app.avoidance.observations import ObstacleObservation

# Monocular is assist-grade on purpose - never let it outvote a range sensor.
MONO_MAX_CONFIDENCE = 0.55
MONO_BASE_CONFIDENCE = 0.4


def observation_from_depth(depth_m: np.ndarray, hfov_deg: float = 70.0,
                           cone_deg: float = 50.0, min_distance_m: float = 0.4,
                           max_distance_m: float = 30.0,
                           min_cluster_frac: float = 0.02
                           ) -> ObstacleObservation | None:
    """Nearest obstacle ahead from a metric depth map (H x W, metres; <=0 or
    NaN = invalid). Returns an ObstacleObservation (body frame) or None.

    Only the central horizontal band is used, to skip ground and sky. The
    column of the nearest valid cluster gives the bearing (linearised across
    the horizontal FOV); the spread of near-range columns gives the width."""
    if depth_m is None or depth_m.ndim != 2:
        return None
    h, w = depth_m.shape
    if h < 4 or w < 4:
        return None

    band = depth_m[int(h * 0.3):int(h * 0.7), :]
    valid = np.isfinite(band) & (band > min_distance_m) & (band < max_distance_m)
    if not valid.any():
        return None

    # Nearest valid depth per column within the band.
    col_depth = np.full(w, np.inf)
    for c in range(w):
        col = band[:, c][valid[:, c]]
        if col.size:
            col_depth[c] = col.min()

    # Restrict to the forward cone.
    cx = (w - 1) / 2.0
    half = w / 2.0
    col_bearing = (np.arange(w) - cx) / half * (hfov_deg / 2.0)
    in_cone = np.abs(col_bearing) <= cone_deg
    col_depth = np.where(in_cone, col_depth, np.inf)
    if not np.isfinite(col_depth).any():
        return None

    nearest = float(col_depth.min())
    # Columns whose nearest range is within 1.25x of the closest = the obstacle.
    near_cols = np.where(col_depth <= nearest * 1.25)[0]
    if near_cols.size == 0:
        return None
    frac = near_cols.size / float(w)
    if frac < min_cluster_frac:
        return None  # a stray pixel, not an obstacle

    center_col = float(near_cols.mean())
    bearing = (center_col - cx) / half * (hfov_deg / 2.0)
    span_cols = float(near_cols.max() - near_cols.min() + 1)
    half_width = max(2.0, (span_cols / half) * (hfov_deg / 2.0) / 2.0)

    # Confidence grows with how much of the view the cluster occupies, capped.
    confidence = min(MONO_MAX_CONFIDENCE,
                     MONO_BASE_CONFIDENCE + min(0.15, frac))

    return ObstacleObservation(
        bearing_deg=bearing, distance_m=nearest,
        half_width_deg=half_width, confidence=confidence, source="monocular")
