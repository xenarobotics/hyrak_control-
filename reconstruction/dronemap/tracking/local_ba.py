"""Sliding-window bundle adjustment.

Levenberg-Marquardt on the joint problem (keyframe poses + landmark positions)
with the standard **Schur complement** reduction: landmarks are marginalised out
analytically so the linear solve is only ``6 * n_keyframes`` square, instead of
``6*P + 3*M`` which would be thousands of unknowns.

Everything is vectorised with einsum over the observation list. The dense
``(M, P, 6, 3)`` cross-block tensor is a deliberate trade: for a window of ~8
keyframes and ~600 points it is under a megabyte, and it turns what would be a
per-point Python loop into a single einsum. That is the difference between BA
fitting in the keyframe budget and not.

The oldest keyframes in the window are held fixed. Without that gauge fix the
problem has seven free directions (similarity) and the solution wanders.

Landmarks observed by fewer than two keyframes are held **fixed** rather than
optimized. A point seen once is free to slide anywhere along its viewing ray --
its 2x3 information block is rank-deficient, and marginalising it sends the
update to infinity. Holding it fixed keeps its observation constraining the
camera (exactly as in motion-only BA) without letting it move.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

import numpy as np

from ..types import se3_exp

log = logging.getLogger(__name__)


@dataclass
class BAResult:
    poses: np.ndarray  # (P,4,4) refined T_cw
    points: np.ndarray  # (M,3) refined world positions
    inlier_mask: np.ndarray  # (K,) per-observation
    initial_cost: float
    final_cost: float
    iterations: int
    converged: bool

    @property
    def improved(self) -> bool:
        return self.final_cost < self.initial_cost


def _projection_jacobians(pc: np.ndarray, K: np.ndarray):
    """d(pixel)/d(camera point) for a batch of camera-frame points -> (N,2,3)."""
    fx, fy = K[0, 0], K[1, 1]
    z = np.maximum(pc[:, 2], 1e-9)
    zi = 1.0 / z
    n = len(pc)
    d = np.zeros((n, 2, 3))
    d[:, 0, 0] = fx * zi
    d[:, 0, 2] = -fx * pc[:, 0] * zi * zi
    d[:, 1, 1] = fy * zi
    d[:, 1, 2] = -fy * pc[:, 1] * zi * zi
    return d


def _neg_skew(v: np.ndarray) -> np.ndarray:
    n = len(v)
    out = np.zeros((n, 3, 3))
    x, y, z = v[:, 0], v[:, 1], v[:, 2]
    out[:, 0, 1] = z
    out[:, 0, 2] = -y
    out[:, 1, 0] = -z
    out[:, 1, 2] = x
    out[:, 2, 0] = y
    out[:, 2, 1] = -x
    return out


def bundle_adjust(
    poses_cw: np.ndarray,
    points: np.ndarray,
    kf_idx: np.ndarray,
    pt_idx: np.ndarray,
    obs_uv: np.ndarray,
    K: np.ndarray,
    fixed_poses: Optional[np.ndarray] = None,
    iterations: int = 12,
    huber_px: float = 3.0,
    initial_lambda: float = 1e-4,
    min_observations: int = 2,
    max_point_step: float = 1.0,
    verbose: bool = False,
) -> BAResult:
    """Optimize poses and points against observations.

    Parameters
    ----------
    poses_cw : (P,4,4) world-to-camera transforms.
    points   : (M,3) world-frame landmarks.
    kf_idx, pt_idx, obs_uv : (K,), (K,), (K,2) observation triplets.
    fixed_poses : (P,) bool, poses held constant (gauge fix).
    min_observations : landmarks seen fewer times than this are held fixed.
    max_point_step : per-iteration cap on landmark motion, in metres.
    """
    poses = np.array(poses_cw, dtype=np.float64, copy=True)
    pts = np.array(points, dtype=np.float64, copy=True)
    P, M, n_obs = len(poses), len(pts), len(kf_idx)

    if fixed_poses is None:
        fixed_poses = np.zeros(P, bool)
        fixed_poses[0] = True
    free = ~fixed_poses

    if n_obs < 10 or M == 0:
        return BAResult(poses, pts, np.ones(n_obs, bool), 0.0, 0.0, 0, False)

    kf_idx = np.asarray(kf_idx, np.int64)
    pt_idx = np.asarray(pt_idx, np.int64)
    obs_uv = np.asarray(obs_uv, np.float64)

    # Partition landmarks: only those with enough views are optimized. The rest
    # stay fixed and still constrain the poses through their observations.
    obs_count = np.bincount(pt_idx, minlength=M)
    free_pt = obs_count >= min_observations
    n_free_pt = int(free_pt.sum())
    # Map global point index -> compacted free index, or -1 for fixed points.
    free_slot = np.full(M, -1, np.int64)
    free_slot[free_pt] = np.arange(n_free_pt)
    obs_slot = free_slot[pt_idx]
    obs_is_free = obs_slot >= 0
    fi = obs_slot[obs_is_free]          # compacted point index per free observation
    fk = kf_idx[obs_is_free]            # keyframe index per free observation
    if verbose:
        log.info("local BA: %d/%d landmarks free (>=%d views), %d observations",
                 n_free_pt, M, min_observations, n_obs)

    lam = initial_lambda
    prev_cost = None
    initial_cost = 0.0
    converged = False
    it = 0

    for it in range(iterations):
        R = poses[kf_idx, :3, :3]
        t = poses[kf_idx, :3, 3]
        pc = np.einsum("nij,nj->ni", R, pts[pt_idx]) + t
        z = pc[:, 2]
        valid = z > 1e-6

        pred = np.stack(
            [K[0, 0] * pc[:, 0] / np.where(valid, z, 1.0) + K[0, 2],
             K[1, 1] * pc[:, 1] / np.where(valid, z, 1.0) + K[1, 2]], axis=1)
        res = pred - obs_uv
        res[~valid] = 0.0
        err = np.linalg.norm(res, axis=1)

        # Huber weighting, same robustifier as the motion-only stage.
        w = np.ones(n_obs)
        big = err > huber_px
        w[big] = huber_px / np.maximum(err[big], 1e-12)
        w[~valid] = 0.0
        cost = float(0.5 * np.sum(w * err**2))
        if it == 0:
            initial_cost = cost
        if prev_cost is not None:
            if cost > prev_cost:
                lam = min(lam * 10.0, 1e6)  # step rejected: damp harder
            else:
                lam = max(lam * 0.5, 1e-10)
                if abs(prev_cost - cost) < 1e-9 * max(prev_cost, 1.0):
                    converged = True
                    prev_cost = cost
                    break
        prev_cost = cost

        dpix = _projection_jacobians(pc, K)          # (N,2,3)
        dp_dxi = np.zeros((n_obs, 3, 6))             # d(pc)/d(twist), left perturb
        dp_dxi[:, 0, 0] = dp_dxi[:, 1, 1] = dp_dxi[:, 2, 2] = 1.0
        dp_dxi[:, :, 3:] = _neg_skew(pc)
        Ja = dpix @ dp_dxi                            # (N,2,6) pose block
        Jb = dpix @ R                                 # (N,2,3) point block

        wJa = Ja * w[:, None, None]
        wJb = Jb * w[:, None, None]

        U = np.zeros((P, 6, 6))
        bp = np.zeros((P, 6))
        # Every observation constrains the poses, fixed landmarks included.
        np.add.at(U, kf_idx, np.einsum("nij,nik->njk", wJa, Ja))
        np.add.at(bp, kf_idx, np.einsum("nij,ni->nj", wJa, res))

        V = np.zeros((n_free_pt, 3, 3))
        bl = np.zeros((n_free_pt, 3))
        Wfull = np.zeros((n_free_pt, P, 6, 3))
        if n_free_pt:
            np.add.at(V, fi, np.einsum("nij,nik->njk", wJb[obs_is_free], Jb[obs_is_free]))
            np.add.at(bl, fi, np.einsum("nij,ni->nj", wJb[obs_is_free], res[obs_is_free]))
            np.add.at(Wfull, (fi, fk),
                      np.einsum("nij,nik->njk", wJa[obs_is_free], Jb[obs_is_free]))

        # LM damping. The absolute floor matters as much as the relative term:
        # a landmark whose views are nearly collinear still has a weak direction,
        # and a purely multiplicative damping cannot regularise a zero eigenvalue.
        U[:, np.arange(6), np.arange(6)] *= 1.0 + lam
        U[:, np.arange(6), np.arange(6)] += 1e-9
        if n_free_pt:
            V[:, np.arange(3), np.arange(3)] *= 1.0 + lam
            V[:, np.arange(3), np.arange(3)] += 1e-6

        if n_free_pt:
            try:
                Vinv = np.linalg.inv(V)
            except np.linalg.LinAlgError:
                Vinv = np.stack([np.linalg.pinv(v) for v in V])
        else:
            Vinv = np.zeros((0, 3, 3))

        # Schur complement: S = U - W V^-1 W^T,  rhs = bp - W V^-1 bl
        S = _block_diag_from_stack(U)
        rhs = bp.copy()
        if n_free_pt:
            WVinv = np.einsum("mpab,mbc->mpac", Wfull, Vinv)       # (M,P,6,3)
            S -= np.einsum("mpac,mqbc->paqb", WVinv, Wfull).reshape(P * 6, P * 6)
            rhs -= np.einsum("mpac,mc->pa", WVinv, bl)
        rhs = rhs.reshape(P * 6)

        # Gauge fix: pin the fixed poses by zeroing their equations.
        fixed_dofs = np.repeat(fixed_poses, 6)
        if fixed_dofs.any():
            S[fixed_dofs, :] = 0.0
            S[:, fixed_dofs] = 0.0
            S[fixed_dofs, fixed_dofs] = 1.0
            rhs[fixed_dofs] = 0.0

        try:
            dx_pose = -np.linalg.solve(S, rhs)
        except np.linalg.LinAlgError:
            dx_pose = -np.linalg.lstsq(S, rhs, rcond=None)[0]
        if not np.all(np.isfinite(dx_pose)):
            log.debug("local BA: non-finite step at iter %d", it)
            break
        dx_pose = dx_pose.reshape(P, 6)
        dx_pose[fixed_poses] = 0.0

        # Back-substitute the landmark updates:
        #   dx_pt_j = -Vinv_j (bl_j + sum_i W_ij^T dx_pose_i)
        # so the pose axis (a=6) is what contracts, not the point axis (b=3).
        dx_pt_full = np.zeros((M, 3))
        if n_free_pt:
            corr = np.einsum("mpab,pa->mb", Wfull, dx_pose)
            dx_free = -np.einsum("mab,mb->ma", Vinv, bl + corr)
            # Trust region on landmarks: a weakly-constrained point can still
            # produce an enormous step that wrecks an otherwise good iteration.
            norms = np.linalg.norm(dx_free, axis=1)
            scale = np.minimum(1.0, max_point_step / np.maximum(norms, 1e-12))
            dx_free *= scale[:, None]
            dx_pt_full[free_pt] = dx_free
        dx_pt = dx_pt_full

        for i in np.flatnonzero(free):
            poses[i] = se3_exp(dx_pose[i]) @ poses[i]
        pts += dx_pt

        if verbose:
            log.info("BA iter %2d cost=%.4f lam=%.2e |dx_pose|=%.4f",
                     it, cost, lam, float(np.linalg.norm(dx_pose)))
        if np.linalg.norm(dx_pose) < 1e-10 and np.linalg.norm(dx_pt) < 1e-10:
            converged = True
            break

    # Final residuals for outlier classification.
    R = poses[kf_idx, :3, :3]
    pc = np.einsum("nij,nj->ni", R, pts[pt_idx]) + poses[kf_idx, :3, 3]
    z = np.maximum(pc[:, 2], 1e-9)
    pred = np.stack([K[0, 0] * pc[:, 0] / z + K[0, 2],
                     K[1, 1] * pc[:, 1] / z + K[1, 2]], axis=1)
    err = np.linalg.norm(pred - obs_uv, axis=1)
    inliers = (err < max(huber_px * 2.0, 5.0)) & (pc[:, 2] > 1e-6)
    final_cost = float(0.5 * np.sum(np.minimum(err, huber_px * 2) ** 2))

    return BAResult(poses, pts, inliers, initial_cost,
                    prev_cost if prev_cost is not None else final_cost,
                    it + 1, converged)


def _block_diag_from_stack(blocks: np.ndarray) -> np.ndarray:
    """(P,6,6) -> (6P,6P) block-diagonal, without scipy."""
    P, b, _ = blocks.shape
    out = np.zeros((P * b, P * b))
    for i in range(P):
        out[i * b:(i + 1) * b, i * b:(i + 1) * b] = blocks[i]
    return out
