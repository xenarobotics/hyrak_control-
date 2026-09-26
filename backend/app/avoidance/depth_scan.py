"""Depth image -> level, ground-rejected range scan.

Every depth source ends here: the simulator's true depth camera (step A of
docs/AVOIDANCE_ARCHITECTURE_REVIEW.md) and the scale-calibrated monocular
model (step D). Each pixel's depth is turned into a 3D point with the
camera's mounting pitch AND the aircraft's roll/pitch at capture time, so

  - the ground is rejected by HEIGHT (a point within ground_clear_m of the
    ground is ground), not by guessing from row patterns - the old flat-
    segment rule still let ground phantoms through at low altitude;
  - a nose-down pitch while accelerating no longer turns the ground ahead
    into a wall, and a banked turn no longer tilts every bearing;
  - only structure within +/- band_m of the flight altitude counts as an
    obstacle for level flight; its top height is reported for climb-over.

The output is one ScanBin per angular bin in the LEVEL body frame (bearing 0
= the nose's heading, clockwise positive): nearest obstacle range (or None),
how far the bin was SEEN to be free at flight level (what clears phantoms in
the occupancy grid), and the obstacle's top height above ground.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np


@dataclass
class ScanBin:
    bearing_deg: float          # level body frame, 0 = nose, clockwise +
    half_width_deg: float
    hit_m: float | None         # horizontal range to the nearest obstacle
    free_m: float               # horizontal range seen free at flight level
    top_m: float = 0.0          # obstacle top above ground (0 = unknown)
    points: int = 0             # obstacle points supporting hit_m


def vfov_for(hfov_deg: float, width_px: int, height_px: int) -> float:
    return math.degrees(2.0 * math.atan(math.tan(math.radians(hfov_deg) / 2.0)
                                        * height_px / max(1, width_px)))


def pool_min(depth: np.ndarray, rows: int, cols: int, percentile: float | None = None) -> np.ndarray:
    """Downsample a depth image to rows x cols cells. Min pooling (the
    default) keeps the nearest return in each cell - right for a true range
    sensor. A percentile (e.g. 20) is used for monocular depth, whose single
    nearest pixel is often noise. Invalid pixels (<=0, NaN) are ignored; +inf
    (no return within range) survives only if the whole cell is +inf."""
    h, w = depth.shape
    rows, cols = max(1, min(rows, h)), max(1, min(cols, w))
    rh, cw = h // rows, w // cols
    d = depth[:rh * rows, :cw * cols].astype(np.float32, copy=False)
    d = np.where(np.isnan(d) | (d <= 0), np.nan, d)
    blocks = d.reshape(rows, rh, cols, cw).transpose(0, 2, 1, 3).reshape(rows, cols, rh * cw)
    with np.errstate(all="ignore"):
        if percentile is None:
            out = np.nanmin(blocks, axis=2)
        else:
            finite = np.where(np.isinf(blocks), np.nan, blocks)
            out = np.nanpercentile(finite, percentile, axis=2)
            all_inf = np.all(np.isinf(blocks) | np.isnan(blocks), axis=2) & np.any(np.isinf(blocks), axis=2)
            out = np.where(all_inf, np.inf, out)
    return out


def scan_from_depth(z: np.ndarray, hfov_deg: float, vfov_deg: float, *,
                    alt_m: float, roll_deg: float = 0.0, pitch_deg: float = 0.0,
                    cam_pitch_deg: float = 0.0, max_range_m: float = 20.0,
                    min_range_m: float = 0.3, ground_clear_m: float = 0.8,
                    band_m: float = 2.5, bin_deg: float = 2.0,
                    invalid_is_free: bool = True) -> list[ScanBin]:
    """z: (rows, cols) depth along the camera's optical axis in metres.
    NaN/<=0 = no data; +inf or >= max_range_m = nothing within range.
    alt_m: camera height above ground at capture. roll/pitch: aircraft
    attitude at capture (degrees, PX4 convention: pitch + = nose up).
    cam_pitch_deg: mount tilt, + = tilted down."""
    rows, cols = z.shape
    th = math.tan(math.radians(hfov_deg) / 2.0)
    tv = math.tan(math.radians(vfov_deg) / 2.0)
    u = ((np.arange(cols) + 0.5) / cols * 2.0 - 1.0) * th        # right
    v = ((np.arange(rows) + 0.5) / rows * 2.0 - 1.0) * tv        # down
    U, V = np.meshgrid(u, v)
    # Ray directions (unit forward component) in the camera frame.
    xc, yc, zc = np.ones_like(U), U, V

    # camera -> body (mount pitched down by cam_pitch)
    c = math.radians(cam_pitch_deg)
    xb = xc * math.cos(c) - zc * math.sin(c)
    zb = xc * math.sin(c) + zc * math.cos(c)
    yb = yc
    # body -> level (roll, then pitch; yaw left out: bearings stay nose-relative)
    r, p = math.radians(roll_deg), math.radians(pitch_deg)
    y1 = yb * math.cos(r) - zb * math.sin(r)
    z1 = yb * math.sin(r) + zb * math.cos(r)
    xl = xb * math.cos(p) + z1 * math.sin(p)
    zl = -xb * math.sin(p) + z1 * math.cos(p)
    yl = y1

    zz = np.array(z, dtype=np.float64)
    nodata = np.isnan(zz) | (zz <= 0)
    beyond = np.isinf(zz) | (zz >= max_range_m)
    valid = ~nodata & ~beyond & (zz >= min_range_m)
    zv = np.where(valid, zz, 0.0)
    # Points (scale the unit-forward ray by the optical-axis depth).
    X, Y, Z = xl * zv, yl * zv, zl * zv                           # Z: down, 0 = camera
    rng_h = np.hypot(X, Y)
    height = alt_m - Z                                            # above ground

    bearing = np.degrees(np.arctan2(yl, xl))                      # per ray, level frame
    horiz = np.hypot(xl, yl)
    elev = np.degrees(np.arctan2(-zl, horiz))                     # + = above the horizon

    is_ground = valid & (height < ground_clear_m)
    in_band = valid & ~is_ground & (np.abs(Z) <= band_m)
    obstacle = valid & ~is_ground                                  # any height, for top_m

    # Distance each ray travels INSIDE the flight band before it ends.
    tan_el = np.abs(np.tan(np.radians(elev)))
    band_len = np.where(tan_el > 1e-3, band_m / np.maximum(tan_el, 1e-3), np.inf)
    ray_end = np.where(valid, rng_h, np.where(beyond & invalid_is_free, max_range_m, 0.0))
    free_len = np.minimum(np.minimum(ray_end, band_len), max_range_m)
    free_len = np.where(in_band, 0.0, free_len)                   # a hit ray: free up to the hit (map does it)

    half = hfov_deg / 2.0
    edges = np.arange(-half, half + 1e-6, bin_deg)
    if edges[-1] < half:
        edges = np.append(edges, half)
    out: list[ScanBin] = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (bearing >= lo) & (bearing < hi)
        if not m.any():
            continue
        centre = float((lo + hi) / 2.0)
        hits = m & in_band
        hit = float(rng_h[hits].min()) if hits.any() else None
        free = float(free_len[m].max()) if m.any() else 0.0
        if hit is not None:
            free = min(free, hit) if free > 0 else hit
        top = 0.0
        if hit is not None:
            near = m & obstacle & (rng_h <= hit + 1.5)
            if near.any():
                top = float(height[near].max())
        out.append(ScanBin(bearing_deg=centre, half_width_deg=(hi - lo) / 2.0,
                           hit_m=hit, free_m=max(0.0, free), top_m=top,
                           points=int(hits.sum())))
    return out
