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

from app.avoidance.sensing.observations import ObstacleObservation

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


def _nearest_flat_segment(col: np.ndarray, ok: np.ndarray, min_run: int,
                          tol: float) -> float:
    """Depth of the nearest vertical run of >= min_run consecutive valid rows
    whose depths all lie within `tol` of each other, or inf if the column has
    no such structure."""
    best = np.inf
    i, n = 0, col.shape[0]
    while i < n:
        if not ok[i]:
            i += 1
            continue
        lo = hi = float(col[i])
        j = i + 1
        while j < n and ok[j]:
            v = float(col[j])
            lo2, hi2 = min(lo, v), max(hi, v)
            if hi2 > lo2 * (1.0 + tol):
                break
            lo, hi, j = lo2, hi2, j + 1
        if j - i >= min_run and lo < best:
            best = lo
        i = j
    return best


def observations_from_depth(depth_m: np.ndarray, hfov_deg: float = 70.0,
                            bin_deg: float = 8.0, min_distance_m: float = 0.4,
                            max_distance_m: float = 30.0,
                            min_col_frac: float = 0.02,
                            min_run_frac: float = 0.08, flat_tol: float = 0.15,
                            col_stride: int = 4) -> list[ObstacleObservation]:
    """DENSE extraction: the nearest obstacle in EACH angular bin across the
    field of view, not just the single closest. This is what lets the planner
    thread gaps - an empty bin is free space between two obstacles, so a stand
    of trees becomes 'obstacle, GAP, obstacle' instead of one blob. The same
    per-sector representation a LiDAR or a recon point-cloud would give.

    GROUND REJECTION: a level camera on a flying drone has the ground across
    the lower half of the frame, and taking each column's nearest pixel turned
    that into a solid wall 20-30 m ahead in every bin. What separates an
    obstacle from the ground is vertical structure: a post, tree or wall keeps
    (nearly) the same depth over many consecutive rows, while ground depth
    grows steadily row by row. So per column the obstacle is the nearest FLAT
    vertical segment (>= min_run_frac of the band's rows within flat_tol of
    each other), never the nearest pixel. Columns are sampled every
    col_stride px - a bin is ~50 columns wide, so that loses nothing.

    Returns one ObstacleObservation per occupied bin (body frame). Heights are
    left unknown (top_m=0) - monocular cannot judge height reliably, so these
    obstacles are never climbed over blind.
    """
    if depth_m is None or depth_m.ndim != 2:
        return []
    h, w = depth_m.shape
    if h < 4 or w < 4:
        return []

    band = depth_m[int(h * 0.25):int(h * 0.75), :]
    valid = np.isfinite(band) & (band > min_distance_m) & (band < max_distance_m)
    cx, half = (w - 1) / 2.0, w / 2.0
    col_bearing = (np.arange(w) - cx) / half * (hfov_deg / 2.0)

    # Nearest flat vertical segment per (sampled) column.
    stride = max(1, int(col_stride))
    min_run = max(3, int(min_run_frac * band.shape[0]))
    col_depth = np.full(w, np.inf)
    col_valid = valid.any(axis=0)
    for c in range(0, w, stride):
        if col_valid[c]:
            col_depth[c] = _nearest_flat_segment(band[:, c], valid[:, c],
                                                 min_run, flat_tol)

    out: list[ObstacleObservation] = []
    n_bins = max(1, int(round(hfov_deg / bin_deg)))
    edges = np.linspace(-hfov_deg / 2.0, hfov_deg / 2.0, n_bins + 1)
    min_cols = max(1, int(min_col_frac * w / stride))
    for i in range(n_bins):
        lo, hi = edges[i], edges[i + 1]
        cols = np.where((col_bearing >= lo) & (col_bearing < hi)
                        & np.isfinite(col_depth))[0]
        if cols.size < min_cols:
            continue
        d = float(col_depth[cols].min())
        # The bin's obstacle is the columns at ~the near range (within 1.3x);
        # its angular centre and spread define the keep-out.
        near = cols[col_depth[cols] <= d * 1.3]
        if near.size < min_cols:
            near = cols
        bearing = float(col_bearing[near].mean())
        span = float(col_bearing[near.max()] - col_bearing[near.min()])
        out.append(ObstacleObservation(
            bearing_deg=bearing, distance_m=d,
            half_width_deg=max(2.0, span / 2.0 + bin_deg / 2.0),
            confidence=min(MONO_MAX_CONFIDENCE,
                           MONO_BASE_CONFIDENCE + min(0.15, near.size * stride / w)),
            source="monocular"))
    return out
