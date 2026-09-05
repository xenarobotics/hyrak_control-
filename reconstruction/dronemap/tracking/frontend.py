"""Visual odometry front-end: KLT tracking, PnP, and motion-only bundle adjustment.

Runs at full frame rate on the downsampled stream. The design is deliberately
frame-to-frame *sparse optical flow* rather than detect-and-match every frame:
KLT costs roughly a tenth of ORB extraction plus matching, and for 30 FPS video
the inter-frame motion is small enough that flow is also more reliable.

ORB descriptors are computed only at keyframes, where they are needed for loop
closure and relocalization.

Pose is recovered by PnP against landmarks whose 3D positions come from
depth-backprojection at keyframes, so the map is metric from the first frame and
there is no separate essential-matrix bootstrap with its scale ambiguity.
"""

from __future__ import annotations

import enum
import logging
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

import cv2
import numpy as np

import threading

from ..config import Config
from ..types import CameraIntrinsics, Frame, se3_exp, se3_inv, skew
from .mapdb import SceneMap

log = logging.getLogger(__name__)


class TrackState(enum.Enum):
    INITIALIZING = "initializing"
    TRACKING = "tracking"
    #: PnP failed recently; the pose is dead-reckoned from the motion model.
    #: Downstream must treat these poses as untrusted - promoting keyframes
    #: or fusing geometry from them is how maps split in two.
    DEGRADED = "degraded"
    LOST = "lost"


@dataclass
class TrackingResult:
    frame_index: int
    timestamp: float
    state: TrackState
    T_wc: np.ndarray
    n_tracked: int = 0
    n_inliers: int = 0
    track_ratio: float = 1.0
    mean_reproj_px: float = 0.0
    #: Median depth of landmarks currently in view -- the scene-scale unit the
    #: keyframe gate uses to stay resolution- and altitude-independent.
    median_depth: float = 0.0
    parallax_px: float = 0.0
    frame: Optional[Frame] = None
    keypoints: Optional[np.ndarray] = None
    point_ids: Optional[np.ndarray] = None
    extras: dict = field(default_factory=dict)


class FeatureTracker:
    """Grid-bucketed Shi-Tomasi detection + pyramidal KLT with an FB check."""

    def __init__(self, cfg: Config) -> None:
        t = cfg.tracking
        self.cfg = t
        self._klt_params = dict(
            winSize=(t.klt_window, t.klt_window),
            maxLevel=t.klt_levels,
            criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01),
        )

    def detect(self, gray: np.ndarray, existing: Optional[np.ndarray] = None) -> np.ndarray:
        """Detect corners, spread across a grid and away from existing tracks.

        Bucketing matters more than it looks: ungated Shi-Tomasi piles every
        corner onto the highest-contrast structure in frame, which makes the PnP
        geometry degenerate even with hundreds of "features".
        """
        h, w = gray.shape[:2]
        c = self.cfg
        rows, cols = c.grid_rows, c.grid_cols
        per_cell = max(1, c.max_features // (rows * cols))

        mask_full = np.full((h, w), 255, np.uint8)
        if existing is not None and len(existing):
            for x, y in existing.astype(np.int32):
                cv2.circle(mask_full, (int(x), int(y)), int(c.min_distance), 0, -1)

        out: list[np.ndarray] = []
        ch, cw = h // rows, w // cols
        for r in range(rows):
            for col in range(cols):
                y0, y1 = r * ch, (h if r == rows - 1 else (r + 1) * ch)
                x0, x1 = col * cw, (w if col == cols - 1 else (col + 1) * cw)
                sub = gray[y0:y1, x0:x1]
                submask = mask_full[y0:y1, x0:x1]
                if not submask.any():
                    continue
                pts = cv2.goodFeaturesToTrack(
                    sub, maxCorners=per_cell, qualityLevel=c.quality_level,
                    minDistance=c.min_distance, mask=submask, blockSize=7,
                )
                if pts is not None and len(pts):
                    p = pts.reshape(-1, 2).astype(np.float32)
                    p[:, 0] += x0
                    p[:, 1] += y0
                    out.append(p)
        if not out:
            return np.empty((0, 2), np.float32)
        new_pts = np.concatenate(out, axis=0)
        # Sub-pixel refinement; KLT is only as good as where it starts.
        if len(new_pts):
            cv2.cornerSubPix(
                gray, new_pts.reshape(-1, 1, 2), (5, 5), (-1, -1),
                (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, 0.03),
            )
        return new_pts

    def track(
        self, prev_gray: np.ndarray, cur_gray: np.ndarray, prev_pts: np.ndarray
    ) -> tuple[np.ndarray, np.ndarray]:
        """Track points forward; returns (tracked_points, keep_mask).

        The forward-backward check is the workhorse for rejecting bad tracks: a
        correspondence that does not return to its origin when tracked backwards
        is wrong, and status flags alone miss most of those.
        """
        if len(prev_pts) == 0:
            return np.empty((0, 2), np.float32), np.zeros(0, bool)

        p0 = prev_pts.reshape(-1, 1, 2).astype(np.float32)
        p1, st1, _ = cv2.calcOpticalFlowPyrLK(prev_gray, cur_gray, p0, None, **self._klt_params)
        if p1 is None:
            return np.empty((0, 2), np.float32), np.zeros(len(prev_pts), bool)
        p0r, st2, _ = cv2.calcOpticalFlowPyrLK(cur_gray, prev_gray, p1, None, **self._klt_params)

        st = (st1.reshape(-1) == 1)
        if p0r is not None:
            fb_err = np.linalg.norm(p0.reshape(-1, 2) - p0r.reshape(-1, 2), axis=1)
            st &= (st2.reshape(-1) == 1) & (fb_err < self.cfg.klt_fb_threshold)

        pts = p1.reshape(-1, 2)
        h, w = cur_gray.shape[:2]
        inside = (
            (pts[:, 0] >= 1) & (pts[:, 0] < w - 1) & (pts[:, 1] >= 1) & (pts[:, 1] < h - 1)
        )
        keep = st & inside & np.isfinite(pts).all(axis=1)
        return pts, keep


def project(K: np.ndarray, pts_cam: np.ndarray) -> np.ndarray:
    """Pinhole projection of Nx3 camera-frame points to Nx2 pixels."""
    z = np.maximum(pts_cam[:, 2], 1e-9)
    return np.stack(
        [K[0, 0] * pts_cam[:, 0] / z + K[0, 2], K[1, 1] * pts_cam[:, 1] / z + K[1, 2]],
        axis=1,
    )


def motion_only_ba(
    T_cw: np.ndarray,
    pts_world: np.ndarray,
    obs_px: np.ndarray,
    K: np.ndarray,
    iterations: int = 6,
    huber_px: float = 3.0,
) -> tuple[np.ndarray, np.ndarray, float]:
    """Refine a single camera pose against fixed 3D landmarks.

    Gauss-Newton on SE(3) with a left perturbation ``T <- exp(d) * T`` and
    analytic Jacobians, robustified with a Huber weight. Returns the refined
    ``T_cw``, a boolean inlier mask, and the mean inlier reprojection error.

    Analytic (rather than numeric) Jacobians are the difference between ~0.3 ms
    and ~15 ms here, which is the entire per-frame budget at 30 FPS.
    """
    fx, fy = K[0, 0], K[1, 1]
    T = T_cw.copy()
    n = len(pts_world)
    inliers = np.ones(n, bool)
    mean_err = 0.0
    if n < 4:
        return T, inliers, 0.0

    for _ in range(iterations):
        R, t = T[:3, :3], T[:3, 3]
        pc = pts_world @ R.T + t
        z = pc[:, 2]
        valid = z > 1e-6
        if valid.sum() < 4:
            break

        pred = project(K, pc)
        res = pred - obs_px  # Nx2
        err = np.linalg.norm(res, axis=1)
        mean_err = float(err[valid].mean())

        # Huber: quadratic within the threshold, linear beyond, so a handful of
        # gross outliers cannot dominate the normal equations.
        w = np.ones(n)
        big = err > huber_px
        w[big] = huber_px / np.maximum(err[big], 1e-9)
        w[~valid] = 0.0

        zi = 1.0 / np.where(valid, z, 1.0)
        x, y = pc[:, 0], pc[:, 1]
        # d(pixel)/d(camera point), stacked as (N,2,3)
        dpix = np.zeros((n, 2, 3))
        dpix[:, 0, 0] = fx * zi
        dpix[:, 0, 2] = -fx * x * zi * zi
        dpix[:, 1, 1] = fy * zi
        dpix[:, 1, 2] = -fy * y * zi * zi

        # d(camera point)/d(twist) = [I | -skew(pc)] for a left perturbation.
        dp = np.zeros((n, 3, 6))
        dp[:, 0, 0] = dp[:, 1, 1] = dp[:, 2, 2] = 1.0
        dp[:, :, 3:] = -np.stack([skew(p) for p in pc]) if n < 64 else _batch_neg_skew(pc)

        J = dpix @ dp  # (N,2,6)
        Jw = J * w[:, None, None]
        H = np.einsum("nij,nik->jk", Jw, J)
        b = np.einsum("nij,ni->j", Jw, res)

        # Levenberg-style damping keeps the step sane when the geometry is weak
        # (near-planar scenes, or too few well-spread points).
        H[np.diag_indices(6)] *= 1.0 + 1e-6
        H[np.diag_indices(6)] += 1e-9
        try:
            delta = -np.linalg.solve(H, b)
        except np.linalg.LinAlgError:
            break
        if not np.all(np.isfinite(delta)):
            break
        T = se3_exp(delta) @ T
        if np.linalg.norm(delta) < 1e-8:
            break

    # Final inlier classification at the converged pose.
    pc = pts_world @ T[:3, :3].T + T[:3, 3]
    err = np.linalg.norm(project(K, pc) - obs_px, axis=1)
    inliers = (err < max(huber_px * 2.0, 5.0)) & (pc[:, 2] > 1e-6)
    if inliers.any():
        mean_err = float(err[inliers].mean())
    return T, inliers, mean_err


def _batch_neg_skew(v: np.ndarray) -> np.ndarray:
    """Vectorised ``-skew(v)`` for an (N,3) array -> (N,3,3)."""
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


class VisualOdometry:
    """Frame-to-frame tracker producing metric camera poses."""

    def __init__(
        self,
        cfg: Config,
        intrinsics: CameraIntrinsics,
        scene_map: SceneMap,
        depth_fn: Optional[Callable[..., np.ndarray]] = None,
    ) -> None:
        self.cfg = cfg
        self.K_obj = intrinsics
        self.K = intrinsics.K
        self.dist = intrinsics.dist_coeffs if intrinsics.has_distortion else None
        self.map = scene_map
        self.depth_fn = depth_fn
        self.tracker = FeatureTracker(cfg)

        self.state = TrackState.INITIALIZING
        self.T_wc = np.eye(4)
        self._prev_gray: Optional[np.ndarray] = None
        self._pts = np.empty((0, 2), np.float32)
        self._pids = np.empty(0, np.int64)
        self._pts_at_last_kf = np.empty((0, 2), np.float32)
        self._n_at_redetect = 0
        self._velocity = np.eye(4)  # constant-velocity motion model
        self._lost_count = 0
        self._median_depth = 1.0
        self._T_at_loss: Optional[np.ndarray] = None
        #: Set by relocalize(): the next TRACKING frame must become a keyframe
        #: so its redetected features get landmarks and fusion resumes at once.
        self.force_keyframe_next = False
        self.orb = cv2.ORB_create(nfeatures=cfg.tracking.orb_features)
        #: Guards `T_wc` only. Track arrays are touched exclusively by the
        #: tracker thread; the mapper thread reaches in only to apply a pose
        #: correction from bundle adjustment or loop closure.
        self._pose_lock = threading.Lock()

    # -- public -------------------------------------------------------------

    def process(self, frame: Frame) -> TrackingResult:
        gray = frame.ensure_gray()
        if self.state is TrackState.INITIALIZING:
            return self._initialize(frame, gray)
        result = self._track(frame, gray)
        self._prev_gray = gray
        if self.force_keyframe_next and result.state is TrackState.TRACKING:
            result.extras["force_keyframe"] = True
            self.force_keyframe_next = False
        return result

    # -- initialization -----------------------------------------------------

    def _initialize(self, frame: Frame, gray: np.ndarray) -> TrackingResult:
        """Seed the map from the first frame's depth.

        Doing this from a depth prediction rather than two-view triangulation
        means the map has metric scale immediately and there is no degenerate
        pure-rotation start-up case.
        """
        pts = self.tracker.detect(gray)
        if len(pts) < self.cfg.tracking.pnp_min_inliers:
            log.warning("initialization: only %d features, waiting for a better frame", len(pts))
            return TrackingResult(frame.index, frame.timestamp, TrackState.INITIALIZING,
                                  self.T_wc.copy(), frame=frame)
        if self.depth_fn is None:
            raise RuntimeError("VisualOdometry needs a depth function to initialize")

        depth = self.depth_fn(frame.image, self.K_obj, frame.index)
        # Depth-plausibility gate: on very dark / low-contrast input the depth
        # network returns a near-constant map (measured: a whole room crushed
        # into 0.22-0.49 m on every frame of dim footage). Initialization is
        # the one moment raw network depth is trusted with no landmarks to
        # align it against, so seeding from a degenerate frame builds a doomed
        # map that dies LOST on first motion. Wait for a frame with real
        # structure instead -- same spirit as the relocalization gates.
        dv = depth[depth > self.cfg.depth.min_depth_m]
        if len(dv) >= 32:
            lo, hi = np.percentile(dv, (5.0, 95.0))
            if hi < max(lo, 1e-6) * 1.5:
                log.warning(
                    "initialization: depth map is near-constant "
                    "(p5 %.2fm, p95 %.2fm) -- dark or textureless view? "
                    "waiting for a frame with depth structure", lo, hi)
                return TrackingResult(frame.index, frame.timestamp,
                                      TrackState.INITIALIZING,
                                      self.T_wc.copy(), frame=frame)
        pids, good = self._seed_landmarks(pts, depth, frame.image, self.T_wc, kf_id=0)
        kept = pts[good]
        if len(pids) < self.cfg.tracking.pnp_min_inliers:
            log.warning("initialization: only %d valid depths, retrying", len(pids))
            return TrackingResult(frame.index, frame.timestamp, TrackState.INITIALIZING,
                                  self.T_wc.copy(), frame=frame)

        self._pts = kept
        self._pids = pids
        self._pts_at_last_kf = kept.copy()
        self._n_at_redetect = len(kept)
        self._prev_gray = gray
        self.state = TrackState.TRACKING
        valid_d = depth[depth > 0]
        self._median_depth = float(np.median(valid_d)) if valid_d.size else 1.0
        log.info("initialized with %d landmarks, median depth %.2f m",
                 len(pids), self._median_depth)

        return TrackingResult(
            frame.index, frame.timestamp, TrackState.TRACKING, self.T_wc.copy(),
            n_tracked=len(kept), n_inliers=len(kept), track_ratio=1.0,
            median_depth=self._median_depth, frame=frame,
            keypoints=kept, point_ids=pids,
            extras={"force_keyframe": True, "depth": depth},
        )

    def _seed_landmarks(
        self, pts: np.ndarray, depth: np.ndarray, image: np.ndarray,
        T_wc: np.ndarray, kf_id: int,
    ) -> tuple[np.ndarray, np.ndarray]:
        """Back-project pixels with valid depth into new world landmarks.

        Returns ``(ids, good_mask)`` where ``good_mask`` selects the rows of
        ``pts`` that received a landmark, so the caller can scatter the ids back
        without re-matching coordinates.
        """
        h, w = depth.shape[:2]
        xi = np.clip(np.round(pts[:, 0]).astype(int), 0, w - 1)
        yi = np.clip(np.round(pts[:, 1]).astype(int), 0, h - 1)
        d = depth[yi, xi]
        good = (
            (d > self.cfg.depth.min_depth_m)
            & (d < self.cfg.depth.max_depth_m)
            & np.isfinite(d)
        )
        if not good.any():
            return np.empty(0, np.int64), good

        cam = self._backproject(pts[good], d[good].astype(np.float64))
        world = cam @ T_wc[:3, :3].T + T_wc[:3, 3]
        colors = image[yi[good], xi[good]]
        ids = self.map.add_points(world, colors, kf_id=kf_id)
        return ids, good

    def _backproject(self, px: np.ndarray, depth: np.ndarray) -> np.ndarray:
        """Pixels + metric depth -> camera-frame 3D points."""
        if self.dist is not None:
            und = cv2.undistortPoints(
                px.reshape(-1, 1, 2).astype(np.float64), self.K, self.dist
            ).reshape(-1, 2)
            x, y = und[:, 0], und[:, 1]
        else:
            x = (px[:, 0] - self.K[0, 2]) / self.K[0, 0]
            y = (px[:, 1] - self.K[1, 2]) / self.K[1, 1]
        return np.stack([x * depth, y * depth, depth], axis=1)

    # -- per-frame tracking -------------------------------------------------

    def _track(self, frame: Frame, gray: np.ndarray) -> TrackingResult:
        assert self._prev_gray is not None
        n_before = max(len(self._pts), 1)

        pts, keep = self.tracker.track(self._prev_gray, gray, self._pts)
        cur_pts = pts[keep]
        cur_pids = self._pids[keep]
        prev_kept = self._pts[keep]

        # Landmarks culled by the mapper (BA outliers) must stop influencing PnP.
        has_lm = cur_pids >= 0
        if has_lm.any():
            alive = np.zeros(len(cur_pids), bool)
            alive[has_lm] = self.map.alive_mask(cur_pids[has_lm])
            cur_pids = np.where(alive | ~has_lm, cur_pids, -1)

        track_ratio = len(cur_pts) / n_before
        parallax = (
            float(np.median(np.linalg.norm(cur_pts - prev_kept, axis=1)))
            if len(cur_pts) else 0.0
        )

        with_lm = cur_pids >= 0
        n_lm = int(with_lm.sum())
        T_cw = se3_inv(self.T_wc)
        inlier_mask = np.zeros(len(cur_pts), bool)
        mean_err = 0.0

        if n_lm >= self.cfg.tracking.pnp_min_inliers:
            world = self.map.positions(cur_pids[with_lm])
            obs = cur_pts[with_lm].astype(np.float64)
            T_cw_new, ok, lm_inliers, mean_err = self._solve_pnp(world, obs)
            if ok:
                T_cw = T_cw_new
                # Recovery is a real transition, not just a local variable:
                # self.state used to stay LOST forever after one bad stretch
                # (the sticky-LOST bug) because only _handle_lost ever wrote it.
                if self.state is not TrackState.TRACKING:
                    if self.state is TrackState.LOST:
                        log.info("tracking RECOVERED after %d dead-reckoned frames",
                                 self._lost_count)
                    self.state = TrackState.TRACKING
                self._lost_count = 0
                idx = np.flatnonzero(with_lm)
                inlier_mask[idx[lm_inliers]] = True
                self.map.mark_visible(cur_pids[with_lm])
                self.map.mark_found(cur_pids[with_lm][lm_inliers])
                # Persistent outliers are dropped from this frame's tracks; the
                # mapper decides whether to retire the landmark itself.
                cur_pids[idx[~lm_inliers]] = -1
                state = TrackState.TRACKING
            else:
                state = self._handle_lost("PnP failed")
                T_cw = se3_inv(self._predict_pose())
        else:
            state = self._handle_lost(f"only {n_lm} landmarks in view")
            T_cw = se3_inv(self._predict_pose())

        T_wc_new = se3_inv(T_cw)
        with self._pose_lock:
            # Constant-velocity model: the PnP seed, and the bridge while lost.
            self._velocity = se3_inv(self.T_wc) @ T_wc_new
            self.T_wc = T_wc_new

        self._pts, self._pids = cur_pts, cur_pids
        self._maybe_redetect(gray)
        self._update_median_depth(cur_pids[cur_pids >= 0], T_cw)

        return TrackingResult(
            frame.index, frame.timestamp, state, self.T_wc.copy(),
            n_tracked=len(cur_pts), n_inliers=int(inlier_mask.sum()),
            track_ratio=track_ratio, mean_reproj_px=mean_err,
            median_depth=self._median_depth, parallax_px=parallax,
            frame=frame, keypoints=self._pts, point_ids=self._pids,
        )

    def _solve_pnp(
        self, world: np.ndarray, obs: np.ndarray
    ) -> tuple[np.ndarray, bool, np.ndarray, float]:
        """RANSAC PnP seeded by the motion model, then motion-only BA."""
        c = self.cfg.tracking
        T_pred_cw = se3_inv(self._predict_pose())
        rvec0, _ = cv2.Rodrigues(T_pred_cw[:3, :3])
        tvec0 = T_pred_cw[:3, 3].reshape(3, 1)
        try:
            ok, rvec, tvec, inl = cv2.solvePnPRansac(
                world.astype(np.float64), obs, self.K,
                self.dist if self.dist is not None else None,
                rvec=rvec0.copy(), tvec=tvec0.copy(), useExtrinsicGuess=True,
                iterationsCount=c.pnp_iterations,
                reprojectionError=c.pnp_reproj_threshold,
                confidence=0.995, flags=cv2.SOLVEPNP_ITERATIVE,
            )
        except cv2.error as exc:
            log.debug("solvePnPRansac raised: %s", exc)
            return T_pred_cw, False, np.zeros(len(world), bool), 0.0

        if not ok or inl is None or len(inl) < c.pnp_min_inliers:
            return T_pred_cw, False, np.zeros(len(world), bool), 0.0

        T_cw = np.eye(4)
        T_cw[:3, :3], _ = cv2.Rodrigues(rvec)
        T_cw[:3, 3] = tvec.reshape(3)

        ransac_inliers = np.zeros(len(world), bool)
        ransac_inliers[inl.reshape(-1)] = True

        # Polish with all RANSAC inliers at once; RANSAC's minimal-sample
        # solution is consistent but not statistically efficient.
        T_cw, ba_inliers, mean_err = motion_only_ba(
            T_cw, world[ransac_inliers], obs[ransac_inliers],
            self.K, c.motion_ba_iterations, c.huber_delta_px,
        )
        final = np.zeros(len(world), bool)
        final[np.flatnonzero(ransac_inliers)[ba_inliers]] = True
        if final.sum() < c.pnp_min_inliers:
            return T_cw, False, final, mean_err
        return T_cw, True, final, mean_err

    def _predict_pose(self) -> np.ndarray:
        return self.T_wc @ self._velocity

    def _handle_lost(self, reason: str) -> TrackState:
        self._lost_count += 1
        if self._lost_count == 1:
            log.warning("tracking degraded: %s", reason)
            # The last PnP-locked pose. The relocalizer gates candidate poses
            # against THIS, not against the dead-reckoned prediction: physics
            # bounds how far the camera travels from where tracking was lost,
            # while the frozen-velocity extrapolation can wander arbitrarily.
            self._T_at_loss = self.T_wc.copy()
        if self._lost_count >= self.cfg.tracking.max_lost_frames:
            if self.state is not TrackState.LOST:
                log.error("tracking LOST after %d frames (%s)", self._lost_count, reason)
            self.state = TrackState.LOST
            return TrackState.LOST
        # Coast on the motion model for a few frames; brief dropouts from
        # motion blur or a featureless wall recover on their own. But the pose
        # is a PREDICTION now, and it must say so: reporting TRACKING here let
        # dead-reckoned keyframes reach depth inference and TSDF fusion - the
        # root cause of every fragmented-map failure observed in the field.
        # (A "grace window" that kept reporting TRACKING for short coasts was
        # measured and rejected: it re-added trajectory error for no
        # completeness gain.)
        self.state = TrackState.DEGRADED
        return TrackState.DEGRADED

    def _maybe_redetect(self, gray: np.ndarray) -> None:
        c = self.cfg.tracking
        if len(self._pts) >= c.redetect_ratio * max(self._n_at_redetect, 1):
            return
        new_pts = self.tracker.detect(gray, existing=self._pts)
        if len(new_pts):
            self._pts = np.vstack([self._pts, new_pts]).astype(np.float32)
            # -1 marks "tracked but not yet a landmark"; the next keyframe gives
            # these a 3D position from its depth map.
            self._pids = np.concatenate([self._pids, np.full(len(new_pts), -1, np.int64)])
        self._n_at_redetect = len(self._pts)

    def _update_median_depth(self, pids: np.ndarray, T_cw: np.ndarray) -> None:
        if len(pids) < 8:
            return
        world = self.map.positions(pids)
        z = (world @ T_cw[:3, :3].T + T_cw[:3, 3])[:, 2]
        z = z[(z > 0) & np.isfinite(z)]
        if z.size >= 8:
            # Light smoothing: this feeds the keyframe threshold, and a jumpy
            # scene-scale estimate makes keyframe spacing jitter.
            self._median_depth = 0.7 * self._median_depth + 0.3 * float(np.median(z))

    # -- keyframe integration ----------------------------------------------

    def register_keyframe_points(
        self, kf_id: int, depth: np.ndarray, image: np.ndarray, T_wc: np.ndarray
    ) -> tuple[np.ndarray, np.ndarray]:
        """Give every unassociated track a landmark from this keyframe's depth.

        Returns (keypoints, point_ids) as they stand after seeding.
        """
        unassoc = self._pids < 0
        if unassoc.any():
            new_ids, good = self._seed_landmarks(
                self._pts[unassoc], depth, image, T_wc, kf_id
            )
            if len(new_ids):
                # `good` indexes into the unassociated subset, so compose the
                # two index sets to scatter ids back into the full track array.
                self._pids[np.flatnonzero(unassoc)[good]] = new_ids
        self._pts_at_last_kf = self._pts.copy()
        self._n_at_redetect = len(self._pts)
        return self._pts.copy(), self._pids.copy()

    @property
    def lost_frames(self) -> int:
        """Consecutive frames without a PnP-locked pose."""
        return self._lost_count

    @property
    def pose_at_loss(self) -> Optional[np.ndarray]:
        """The last PnP-locked pose before the current loss, or None."""
        return self._T_at_loss

    @property
    def median_scene_depth_m(self) -> float:
        """Smoothed median landmark depth -- the scene-scale unit."""
        return float(self._median_depth)

    @property
    def per_frame_speed_m(self) -> float:
        """Translation magnitude of the constant-velocity model, metres/frame.

        While LOST the velocity is frozen at its pre-loss value, so this is the
        last measured speed -- the right scale for bounding how far the camera
        can plausibly have travelled during a blackout.
        """
        return float(np.linalg.norm(self._velocity[:3, 3]))

    def compute_orb(self, gray: np.ndarray) -> tuple[np.ndarray, Optional[np.ndarray]]:
        """ORB keypoints/descriptors for loop closure and relocalization."""
        kps, desc = self.orb.detectAndCompute(gray, None)
        if not kps:
            return np.empty((0, 2), np.float32), None
        return np.array([k.pt for k in kps], np.float32), desc

    def relocalize(self, T_wc: np.ndarray, pts: np.ndarray, pids: np.ndarray,
                   gray: Optional[np.ndarray] = None) -> None:
        """Adopt a pose recovered by the relocalizer and resume tracking.

        Called by the app on the tracker thread right after ``process()``
        returned LOST for this frame, so ``_prev_gray`` is already this frame
        and the next call tracks the adopted features from it. ``gray`` (this
        frame) lets the detector top the sparse relocalization matches back up
        to a normal feature count; the extras get landmarks at the next
        keyframe, which is forced.
        """
        with self._pose_lock:
            self.T_wc = np.asarray(T_wc, float)
        self._pts = np.asarray(pts, np.float32).reshape(-1, 2)
        self._pids = np.asarray(pids, np.int64)
        if gray is not None:
            self._maybe_redetect(gray)
        self._pts_at_last_kf = self._pts.copy()
        self._n_at_redetect = len(self._pts)
        self._velocity = np.eye(4)
        self._lost_count = 0
        self.state = TrackState.TRACKING
        self.force_keyframe_next = True
        log.info("relocalized with %d landmark correspondences (%d features live)",
                 int((self._pids >= 0).sum()), len(self._pts))

    def apply_correction(self, T_correction: np.ndarray) -> None:
        """Apply a loop-closure or BA correction to the live pose.

        Called from the mapper thread. Without it the tracker keeps extending
        the pre-correction trajectory and immediately reintroduces the drift
        that was just removed.
        """
        with self._pose_lock:
            self.T_wc = T_correction @ self.T_wc

