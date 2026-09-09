"""SE(3) math, projection and bundle adjustment."""

import numpy as np
import pytest

from dronemap.tracking.local_ba import bundle_adjust
from dronemap.tracking.pose_graph import PoseGraph, adjoint
from dronemap.types import (CameraIntrinsics, se3_exp, se3_inv, se3_log,
                            so3_exp, so3_log, skew)


def test_skew_matches_cross_product():
    rng = np.random.default_rng(0)
    for _ in range(50):
        a, b = rng.normal(size=3), rng.normal(size=3)
        assert np.allclose(skew(a) @ b, np.cross(a, b))


@pytest.mark.parametrize("magnitude", [1e-9, 1e-5, 0.1, 1.0, 3.0])
def test_se3_exp_log_roundtrip(magnitude):
    rng = np.random.default_rng(1)
    for _ in range(200):
        xi = rng.normal(size=6) * magnitude
        T = se3_exp(xi)
        assert np.allclose(se3_exp(se3_log(T)), T, atol=1e-8)
        assert np.allclose(se3_inv(T) @ T, np.eye(4), atol=1e-9)


def test_so3_log_near_pi():
    """The antisymmetric part of R vanishes at pi; the fallback branch must work."""
    for axis in np.eye(3):
        for theta in (np.pi - 1e-7, np.pi - 1e-4, np.pi - 1e-2):
            R = so3_exp(axis * theta)
            assert abs(np.linalg.norm(so3_log(R)) - theta) < 1e-4


def test_adjoint_identity():
    """Adj(T) xi == log(T exp(xi) T^-1) for small xi."""
    rng = np.random.default_rng(2)
    for _ in range(30):
        T = se3_exp(rng.normal(size=6) * 0.5)
        xi = rng.normal(size=6) * 1e-5
        assert np.allclose(adjoint(T) @ xi, se3_log(T @ se3_exp(xi) @ se3_inv(T)),
                           atol=1e-9)


def test_intrinsics_scaling():
    K = CameraIntrinsics.from_fov(1920, 1080, 82.0)
    half = K.scaled(960, 540)
    assert half.fx == pytest.approx(K.fx / 2)
    assert half.cx == pytest.approx(K.cx / 2)
    # A point on the optical axis stays on the optical axis under rescaling.
    assert half.cx == pytest.approx(480, abs=1e-6)


def _make_ba_problem(n_poses=8, n_points=400, noise=0.4, outlier_frac=0.0, seed=0):
    rng = np.random.default_rng(seed)
    K = np.array([[500.0, 0, 320], [0, 500.0, 180], [0, 0, 1]])
    pts = rng.uniform([-3, -2, 4], [3, 2, 10], size=(n_points, 3))
    poses = []
    for i in range(n_poses):
        T = np.eye(4)
        T[:3, :3] = so3_exp(np.array([0.0, i * 0.12, 0.0]))
        T[:3, 3] = [-i * 0.25, 0, 0]
        poses.append(se3_inv(T))
    poses = np.array(poses)
    kf_idx, pt_idx, uv = [], [], []
    for i in range(n_poses):
        pc = pts @ poses[i][:3, :3].T + poses[i][:3, 3]
        px = np.stack([K[0, 0] * pc[:, 0] / pc[:, 2] + K[0, 2],
                       K[1, 1] * pc[:, 1] / pc[:, 2] + K[1, 2]], axis=1)
        vis = (pc[:, 2] > 0.5) & (px[:, 0] > 0) & (px[:, 0] < 640) \
            & (px[:, 1] > 0) & (px[:, 1] < 360)
        j = np.flatnonzero(vis)
        kf_idx += [i] * len(j)
        pt_idx += list(j)
        uv.append(px[j])
    uv = np.concatenate(uv) + rng.normal(scale=noise, size=(len(pt_idx), 2))
    if outlier_frac:
        n_out = int(outlier_frac * len(uv))
        idx = rng.choice(len(uv), n_out, replace=False)
        uv[idx] += rng.normal(scale=60, size=(n_out, 2))
    return K, pts, poses, np.array(kf_idx), np.array(pt_idx), uv


def test_bundle_adjustment_converges():
    K, gt_pts, gt_poses, kf_idx, pt_idx, uv = _make_ba_problem()
    rng = np.random.default_rng(9)
    poses0 = np.array([
        se3_exp(np.concatenate([rng.normal(scale=0.05, size=3),
                                rng.normal(scale=0.02, size=3)])) @ T
        for T in gt_poses
    ])
    poses0[0], poses0[1] = gt_poses[0], gt_poses[1]
    pts0 = gt_pts + rng.normal(scale=0.12, size=gt_pts.shape)
    fixed = np.zeros(len(gt_poses), bool)
    fixed[0] = fixed[1] = True

    res = bundle_adjust(poses0, pts0, kf_idx, pt_idx, uv, K,
                        fixed_poses=fixed, iterations=20)

    def perr(ps):
        return np.mean([np.linalg.norm(se3_inv(ps[i])[:3, 3] - se3_inv(gt_poses[i])[:3, 3])
                        for i in range(len(ps))])

    assert res.final_cost < res.initial_cost
    assert perr(res.poses) < perr(poses0) * 0.4
    # Landmarks must converge too, not just poses. A regression here means the
    # Schur back-substitution is wrong or under-damped.
    assert np.median(np.linalg.norm(res.points - gt_pts, axis=1)) < \
        np.median(np.linalg.norm(pts0 - gt_pts, axis=1)) * 0.6


def test_bundle_adjustment_holds_fixed_poses():
    K, gt_pts, gt_poses, kf_idx, pt_idx, uv = _make_ba_problem(seed=3)
    fixed = np.zeros(len(gt_poses), bool)
    fixed[0] = fixed[3] = True
    res = bundle_adjust(gt_poses.copy(), gt_pts.copy(), kf_idx, pt_idx, uv, K,
                        fixed_poses=fixed, iterations=5)
    assert np.allclose(res.poses[0], gt_poses[0])
    assert np.allclose(res.poses[3], gt_poses[3])


def test_bundle_adjustment_rejects_outliers():
    K, gt_pts, gt_poses, kf_idx, pt_idx, uv = _make_ba_problem(outlier_frac=0.05, seed=5)
    res = bundle_adjust(gt_poses.copy(), gt_pts.copy(), kf_idx, pt_idx, uv, K,
                        iterations=15)
    # Gross outliers should be flagged; a Huber loss that silently accepts them
    # would let a single bad match dominate the solve.
    assert (~res.inlier_mask).sum() > 0


def test_bundle_adjustment_single_view_points_do_not_explode():
    """A landmark seen once is unconstrained along its ray and must be held fixed."""
    K = np.array([[500.0, 0, 320], [0, 500.0, 180], [0, 0, 1]])
    poses = np.array([np.eye(4), se3_exp(np.array([0.2, 0, 0, 0, 0.05, 0]))])
    pts = np.array([[0.0, 0.0, 5.0], [1.0, 0.5, 6.0]])
    # Point 1 is observed twice, point 0 only once.
    kf_idx = np.array([0, 0, 1])
    pt_idx = np.array([0, 1, 1])
    uv = np.array([[320.0, 180.0], [403.0, 221.0], [390.0, 220.0]])
    res = bundle_adjust(poses, pts, kf_idx, pt_idx, uv, K, iterations=10)
    assert np.all(np.isfinite(res.points))
    assert np.allclose(res.points[0], pts[0]), "single-view landmark must not move"


def test_pose_graph_absorbs_loop_drift():
    n = 40
    gt = []
    for i in range(n):
        a = 2 * np.pi * i / n
        T = np.eye(4)
        T[:3, :3] = so3_exp(np.array([0.0, a, 0.0]))
        T[:3, 3] = [3 * np.cos(a), 0, 3 * np.sin(a)]
        gt.append(T)

    rng = np.random.default_rng(0)
    est = [gt[0].copy()]
    for i in range(1, n):
        rel = se3_inv(gt[i - 1]) @ gt[i]
        est.append(est[-1] @ rel @ se3_exp(np.array([0, 0, 0, 0, 0.005, 0])))

    before = np.mean([np.linalg.norm(est[i][:3, 3] - gt[i][:3, 3]) for i in range(n)])
    pg = PoseGraph()
    for i, T in enumerate(est):
        pg.add_node(i, T)
    for i in range(n - 1):
        pg.add_edge(i, i + 1, se3_inv(est[i]) @ est[i + 1], np.eye(6) * 100)
    pg.add_edge(n - 1, 0, se3_inv(gt[n - 1]) @ gt[0], np.eye(6) * 100, is_loop=True)

    res = pg.optimize(iterations=30)
    after = np.mean([np.linalg.norm(res.poses[i][:3, 3] - gt[i][:3, 3]) for i in range(n)])
    assert res.final_error < res.initial_error * 0.05
    assert after < before * 0.5


def test_pose_graph_is_idempotent():
    """Re-optimizing a converged graph must not move it further.

    This is what makes a persistent graph safe: loop closures accumulate as
    edges, and re-solving does not compound previous corrections.
    """
    pg = PoseGraph()
    rng = np.random.default_rng(4)
    poses = [se3_exp(rng.normal(size=6) * 0.1) for _ in range(10)]
    for i, T in enumerate(poses):
        pg.add_node(i, T)
    for i in range(9):
        pg.add_edge(i, i + 1, se3_inv(poses[i]) @ poses[i + 1], np.eye(6))
    first = pg.optimize(iterations=20)
    snapshot = {k: v.copy() for k, v in first.poses.items()}
    second = pg.optimize(iterations=20)
    for k in snapshot:
        assert np.allclose(second.poses[k], snapshot[k], atol=1e-6)
