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
MIN_INLIER_FRAC = 0.45
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
              cam_pitch_deg: float = 0.0) -> ScaleFit | None:
    if alt_m < 1.0:
        return None
    rows, cols = z_pred.shape
    zl, depression = ray_down_components(rows, cols, hfov_deg, vfov_deg,
                                         roll_deg, pitch_deg, cam_pitch_deg)
    ok = (np.isfinite(z_pred) & (z_pred > 0.2)
          & (depression >= MIN_DEPRESSION_DEG) & (depression <= MAX_DEPRESSION_DEG)
          & (zl > 1e-3))
    if int(ok.sum()) < MIN_GROUND_PX:
        return None
    z_true = alt_m / zl[ok]
    ratios = z_true / z_pred[ok]
    med = float(np.median(ratios))
    if not math.isfinite(med) or med <= 0:
        return None
    inl = np.abs(ratios / med - 1.0) <= INLIER_TOL
    frac = float(inl.mean())
    if frac < MIN_INLIER_FRAC or int(inl.sum()) < MIN_GROUND_PX // 2:
        return None
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

    def update(self, fit: ScaleFit | None) -> float | None:
        if fit is None:
            self.rejected += 1
            return self.scale
        self.fits += 1
        self.last = fit
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
            "error_pct_p50": round(errs[len(errs) // 2], 1) if errs else None,
            "error_pct_p90": round(errs[int(len(errs) * 0.9)], 1) if errs else None,
            "last_inlier_frac": round(self.last.inlier_frac, 2) if self.last else None,
        }
