"""Depth estimation interface and depth/map scale alignment.

A monocular depth network is the geometric backbone of this pipeline, and it has
one dangerous property: its output is *plausible* rather than *correct*. Even a
"metric" model drifts in scale across a long flight and gets the absolute range
wrong by 10-20% outdoors.

So predicted depth is never fused raw. It is first aligned to the sparse
landmarks the tracker has already triangulated and bundle-adjusted, using a
robust scale(+shift) fit. Those landmarks are geometrically derived from real
parallax, so the alignment ties the dense prediction back to actual measurement.
"""

from __future__ import annotations

import abc
import logging
from dataclasses import dataclass
from typing import Optional

import numpy as np

from ..types import CameraIntrinsics

log = logging.getLogger(__name__)


@dataclass
class DepthResult:
    depth: np.ndarray  # float32 HxW, metres, 0 = invalid
    confidence: Optional[np.ndarray] = None  # float32 HxW in [0,1]
    scale: float = 1.0  # alignment scale that was applied
    shift: float = 0.0
    n_align_points: int = 0
    align_residual: float = 0.0
    raw_range: tuple[float, float] = (0.0, 0.0)


class DepthEstimator(abc.ABC):
    """Predicts dense depth for one image."""

    #: True when the backend already returns metres. Relative-depth backends
    #: cannot be fused at all without an alignment, so this gates a hard error.
    metric: bool = False

    @abc.abstractmethod
    def predict(self, image: np.ndarray, intrinsics: CameraIntrinsics,
                frame_index: Optional[int] = None) -> np.ndarray:
        """Return float32 HxW depth matching the image resolution.

        ``frame_index`` is advisory: real networks ignore it, but replay and
        ground-truth backends need it to return the depth belonging to *this*
        frame rather than to the call count.
        """

    def warmup(self) -> None:
        """Optional: run a dummy inference so the first real frame is not slow."""

    def close(self) -> None:
        pass

    @property
    def vram_mb(self) -> float:
        return 0.0


def robust_align_depth(
    pred: np.ndarray,
    ref_px: np.ndarray,
    ref_depth: np.ndarray,
    fit_shift: bool = True,
    iterations: int = 8,
    max_scale: float = 5.0,
    min_points: int = 12,
    seed_trials: int = 48,
) -> tuple[float, float, int, float]:
    """Fit ``depth_metric ~= scale * pred + shift`` against sparse landmarks.

    Iteratively reweighted least squares with a Tukey biweight. Tukey rather
    than Huber here because depth outliers are not merely heavy-tailed: a
    landmark that lands on an occlusion boundary can be wrong by the full scene
    depth, and those need to be rejected outright rather than downweighted.

    Returns ``(scale, shift, n_inliers, median_relative_residual)``. A return of
    ``(1.0, 0.0, 0, inf)`` means the fit was **rejected** -- too few points, or an
    implausible result -- and the caller must not apply it. Failing closed is
    deliberate: an unaligned depth map degrades the map locally, whereas a wrong
    global scale corrupts the entire reconstruction.
    """
    if len(ref_px) < min_points:
        return 1.0, 0.0, 0, float("inf")

    h, w = pred.shape[:2]
    xs = np.clip(np.round(ref_px[:, 0]).astype(int), 0, w - 1)
    ys = np.clip(np.round(ref_px[:, 1]).astype(int), 0, h - 1)
    p = pred[ys, xs].astype(np.float64)
    r = np.asarray(ref_depth, dtype=np.float64)

    good = np.isfinite(p) & np.isfinite(r) & (p > 1e-6) & (r > 1e-6)
    p, r = p[good], r[good]
    if len(p) < min_points:
        return 1.0, 0.0, 0, float("inf")

    # Seeding. IRLS only converges to the right basin if it starts near it, and
    # the plain median ratio breaks down around 45% outliers -- which real
    # occlusion boundaries do reach. So try several minimal-sample seeds
    # (RANSAC-style) and keep whichever explains the most points. This is cheap:
    # a few hundred candidate evaluations on a few hundred points.
    scale, shift = _best_seed(p, r, fit_shift, seed_trials, max_scale)
    weights = np.ones(len(p))

    for _ in range(iterations):
        # Weights are recomputed from the CURRENT estimate before each fit. The
        # order matters: fitting first would make the opening iteration a plain
        # unweighted least squares over the outliers too, and IRLS started from
        # that contaminated solution never recovers -- the inflated residual
        # scale makes the Tukey cutoff wide enough to keep every outlier.
        # Scale-relative residuals: a 10 cm error at 1 m and at 50 m are not
        # comparable, and an absolute threshold would reject every far point.
        resid = (scale * p + shift) - r
        rel = np.abs(resid) / np.maximum(r, 1e-6)
        sigma = 1.4826 * float(np.median(rel)) + 1e-9
        c = 4.685 * sigma
        u = np.clip(rel / max(c, 1e-9), 0.0, 1.0)
        weights = (1.0 - u**2) ** 2  # Tukey biweight: zero beyond the cutoff
        if float(weights.sum()) < min_points * 0.5:
            break

        if fit_shift:
            A = np.stack([p, np.ones_like(p)], axis=1)
            W = weights[:, None]
            try:
                sol, *_ = np.linalg.lstsq(A * W, r * weights, rcond=None)
            except np.linalg.LinAlgError:
                break
            scale, shift = float(sol[0]), float(sol[1])
        else:
            denom = float(np.sum(weights * p * p))
            if denom < 1e-12:
                break
            scale = float(np.sum(weights * p * r) / denom)
            shift = 0.0

    if not np.isfinite(scale) or scale <= 0 or scale > max_scale or scale < 1.0 / max_scale:
        log.debug("depth alignment rejected: implausible scale %.4f", scale)
        return 1.0, 0.0, 0, float("inf")

    resid = (scale * p + shift) - r
    rel = np.abs(resid) / np.maximum(r, 1e-6)
    n_inliers = int((weights > 0.1).sum())
    return scale, shift, n_inliers, float(np.median(rel))


def _inlier_count(p, r, scale, shift, rel_tol=0.12) -> int:
    """Points explained by a candidate (scale, shift), within a relative tolerance."""
    rel = np.abs((scale * p + shift) - r) / np.maximum(r, 1e-6)
    return int((rel < rel_tol).sum())


def _best_seed(p, r, fit_shift: bool, trials: int, max_scale: float
               ) -> tuple[float, float]:
    """Pick the (scale, shift) seed that explains the most correspondences."""
    ratio = r / np.maximum(p, 1e-9)
    best = (float(np.median(ratio)), 0.0)
    best_n = _inlier_count(p, r, best[0], best[1])

    n = len(p)
    if trials > 0 and n >= 4:
        rng = np.random.default_rng(0)  # fixed: alignment must be reproducible
        # Single-point seeds cover the pure-scale hypothesis.
        for s_cand in ratio[rng.choice(n, min(trials, n), replace=False)]:
            if not (1.0 / max_scale < s_cand < max_scale):
                continue
            cnt = _inlier_count(p, r, float(s_cand), 0.0)
            if cnt > best_n:
                best_n, best = cnt, (float(s_cand), 0.0)
        if fit_shift:
            # Two-point seeds additionally hypothesise an offset.
            ia = rng.choice(n, trials)
            ib = rng.choice(n, trials)
            for a, b in zip(ia, ib):
                dp = p[a] - p[b]
                if abs(dp) < 1e-6:
                    continue
                s_cand = (r[a] - r[b]) / dp
                if not (1.0 / max_scale < s_cand < max_scale):
                    continue
                t_cand = r[a] - s_cand * p[a]
                cnt = _inlier_count(p, r, float(s_cand), float(t_cand))
                if cnt > best_n:
                    best_n, best = cnt, (float(s_cand), float(t_cand))
    return best


def edge_confidence(depth: np.ndarray, threshold: float = 0.06) -> np.ndarray:
    """Down-weight depth discontinuities.

    A monocular network's worst errors are at occlusion boundaries, where it
    smears foreground into background. Fusing those at full weight drags surface
    sheets out into empty space -- the classic monocular-TSDF failure. Confidence
    falls off with the *relative* depth gradient, so the criterion is
    range-independent.
    """
    d = depth.astype(np.float32)
    valid = d > 0
    gy, gx = np.gradient(d)
    grad = np.sqrt(gx * gx + gy * gy)
    rel_grad = grad / np.maximum(d, 1e-3)
    conf = np.exp(-(rel_grad / max(threshold, 1e-6)) ** 2).astype(np.float32)
    conf[~valid] = 0.0
    return conf


def build_depth_estimator(cfg, device: str = "cuda") -> DepthEstimator:
    """Factory for the configured depth backend."""
    backend = cfg.depth.backend
    if backend == "depth_anything":
        from .depth_anything import DepthAnythingEstimator

        return DepthAnythingEstimator(cfg, device=device)
    if backend == "da3":
        from .da3 import DepthAnything3Estimator

        return DepthAnything3Estimator(cfg, device=device)
    if backend == "trt":
        from .trt_engine import TensorRTDepthEstimator

        return TensorRTDepthEstimator(cfg)
    if backend == "none":
        raise ValueError(
            "depth.backend is 'none'; the fusion pipeline needs depth. "
            "Set depth.backend=depth_anything or supply a custom estimator."
        )
    raise ValueError(f"unknown depth backend: {backend}")
