"""Monocular depth scale calibration from the ground plane (step D).

The metric monocular model compresses range (measured in SITL: 31 m reads
22.6, 58 reads 26) and its scale drifts with the scene. But the aircraft
knows something the model does not: how high the camera is and how it is
tilted. For every pixel that looks at flat ground, the true depth follows
from geometry alone:

    ray (level frame, unit forward depth) has down-component zl > 0
    the ray meets the ground where depth * zl = altitude  ->  z_true = alt / zl

So each frame the model's scale is fitted to the pixels that behave like
ground: ratios z_true / z_pred over the lower part of the image, a robust
median, then only the pixels within 25 % of it (the rest are obstacles,
shadows or model errors) refine it. The fit's inlier fraction is its
quality; a frame without enough agreeing ground pixels is not used, and the
scale is smoothed across frames so one bad fit cannot swing it.

The fitted per-frame error (spread of inlier ratios) is recorded, which is
the number the review asked for before mono is trusted for more than
advisory use (< 15 %).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

MIN_DEPRESSION_DEG = 4.0      # pixels this close to the horizon: ground too far to trust
MAX_DEPRESSION_DEG = 75.0
MIN_GROUND_PX = 150
# Ground used for the fit: true distance up to this - its OWN limit,
# independent of the obstacle max range. Unlimited, the far ground (out to
# the 4 deg horizon cut, 200+ m from 15 m up) joined the fit, and metric
# models saturate there: DA3 on the Gazebo world reads ground scale-stable
# out to ~60 m and at HALF that scale beyond (depth bench, 10 m up). A level
# camera at altitude, whose view is mostly far ground, then rejected frame
# after frame on inlier fraction - or, worse, locked onto the far ground's
# scale and put every obstacle at twice its distance. When even the nearest
# visible ground is beyond this, the frame is not fitted (tilt the camera
# down or fly lower).
FIT_MAX_GROUND_M = 50.0
MIN_INLIER_FRAC = 0.45
MIN_GROUND_SPAN = 1.5        # 90th / 10th percentile ground distance in the fit
MAX_RATIO_TREND = 0.2        # far-half vs near-half inlier ratio: a plane holds one scale
INLIER_TOL = 0.25


@dataclass
class ScaleFit:
    scale: float
    inlier_frac: float
    error_pct: float          # median absolute deviation of inlier ratios, % of scale
    ground_px: int


def ray_down_components(rows: int, cols: int, hfov_deg: float, vfov_deg: float,
                        roll_deg: float, pitch_deg: float, cam_pitch_deg: float) -> np.ndarray:
    """Level-frame down component of each cell's unit-forward-depth ray (the
    same geometry as depth_scan.scan_from_depth)."""
    th = math.tan(math.radians(hfov_deg) / 2.0)
    tv = math.tan(math.radians(vfov_deg) / 2.0)
    u = ((np.arange(cols) + 0.5) / cols * 2.0 - 1.0) * th
    v = ((np.arange(rows) + 0.5) / rows * 2.0 - 1.0) * tv
    U, V = np.meshgrid(u, v)
    c = math.radians(cam_pitch_deg)
    xb = np.cos(c) - V * np.sin(c)
    zb = np.sin(c) + V * np.cos(c)
    r, p = math.radians(roll_deg), math.radians(pitch_deg)
    z1 = U * math.sin(r) + zb * math.cos(r)
    zl = -xb * math.sin(p) + z1 * math.cos(p)
    xl = xb * math.cos(p) + z1 * math.sin(p)
    yl = U * math.cos(r) - zb * math.sin(r)
    return zl, np.degrees(np.arctan2(zl, np.hypot(xl, yl)))


def fit_scale(z_pred: np.ndarray, hfov_deg: float, vfov_deg: float, *, alt_m: float,
              roll_deg: float = 0.0, pitch_deg: float = 0.0,
              cam_pitch_deg: float = 0.0, why: dict | None = None) -> ScaleFit | None:
    """Fit the model's scale to the visible ground. On rejection, why
    (if given) gets 'reason': low_alt | no_ground | ground_out_of_range |
    few_ground_px |
    bad_median | low_inliers - surfaced in status as rejected_by."""
    def _no(reason):
        if why is not None:
            why["reason"] = reason
        return None
    if alt_m < 1.0:
        return _no("low_alt")
    rows, cols = z_pred.shape
    zl, depression = ray_down_components(rows, cols, hfov_deg, vfov_deg,
                                         roll_deg, pitch_deg, cam_pitch_deg)
    ok = (np.isfinite(z_pred) & (z_pred > 0.2)
          & (depression >= MIN_DEPRESSION_DEG) & (depression <= MAX_DEPRESSION_DEG)
          & (zl > 1e-3))
    if not ok.any():
        return _no("no_ground")
    ground_m = alt_m / np.maximum(zl, 1e-3)
    ok &= ground_m <= FIT_MAX_GROUND_M
    if not ok.any():
        return _no("ground_out_of_range")
    if int(ok.sum()) < MIN_GROUND_PX:
        return _no("few_ground_px")
    z_true = ground_m[ok]
    # The ground seen must span enough distance for "one scale from near to
    # far" to mean anything: a thin far band agrees with a wall or a flat
    # model output just as well.
    g10, g90 = np.percentile(z_true, (10, 90))
    if g90 < MIN_GROUND_SPAN * g10:
        return _no("ground_band_too_thin")
    ratios = z_true / z_pred[ok]
    med = float(np.median(ratios))
    if not math.isfinite(med) or med <= 0:
        return _no("bad_median")
    inl = np.abs(ratios / med - 1.0) <= INLIER_TOL
    frac = float(inl.mean())
    if frac < MIN_INLIER_FRAC or int(inl.sum()) < MIN_GROUND_PX // 2:
        return _no("low_inliers")
    # Ground, not a wall that happens to agree: on a plane the ratio holds
    # from the near ground to the far; on a fronto-parallel surface (or a
    # flat model output) it grows with distance. The narrower fit band made
    # that easier to pass on inlier fraction alone.
    g_in, r_in = z_true[inl], ratios[inl]
    split = float(np.median(g_in))
    near_r, far_r = r_in[g_in <= split], r_in[g_in > split]
    if near_r.size and far_r.size:
        trend = float(np.median(far_r) / np.median(near_r))
        if abs(trend - 1.0) > MAX_RATIO_TREND:
            return _no("not_planar")
    s = float(np.median(ratios[inl]))
    mad = float(np.median(np.abs(ratios[inl] - s)))
    return ScaleFit(scale=s, inlier_frac=frac, error_pct=100.0 * mad / s,
                    ground_px=int(inl.sum()))


@dataclass
class ScaleTracker:
    """Per-drone smoothing of the fitted scale, plus the running error stats."""
    alpha: float = 0.3
    scale: float | None = None
    fits: int = 0
    rejected: int = 0
    errors: list = field(default_factory=list)
    last: ScaleFit | None = None

    last_fit_t: float = 0.0        # monotonic time of the last accepted fit
    rejected_by: dict = field(default_factory=dict)

    def update(self, fit: ScaleFit | None, reason: str | None = None) -> float | None:
        if fit is None:
            self.rejected += 1
            key = reason or "unknown"
            self.rejected_by[key] = self.rejected_by.get(key, 0) + 1
            return self.scale
        self.fits += 1
        self.last = fit
        import time as _t
        self.last_fit_t = _t.monotonic()
        self.errors.append(fit.error_pct)
        if len(self.errors) > 300:
            self.errors = self.errors[-300:]
        if self.scale is None:
            self.scale = fit.scale
        else:
            # A fit far from the running scale is weighted down, not trusted.
            jump = abs(fit.scale / self.scale - 1.0)
            a = self.alpha * (0.3 if jump > 0.3 else 1.0)
            self.scale = (1 - a) * self.scale + a * fit.scale
        return self.scale

    def status(self) -> dict:
        errs = sorted(self.errors)
        return {
            "scale": round(self.scale, 3) if self.scale else None,
            "fits": self.fits, "rejected": self.rejected,
            "rejected_by": dict(self.rejected_by),
            "error_pct_p50": round(errs[len(errs) // 2], 1) if errs else None,
            "error_pct_p90": round(errs[int(len(errs) * 0.9)], 1) if errs else None,
            "last_inlier_frac": round(self.last.inlier_frac, 2) if self.last else None,
        }
