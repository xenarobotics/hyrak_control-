"""Local mapping: keyframe creation, depth, windowed BA, loop closure.

This is the pipeline's slow-but-smart stage. It runs at keyframe rate (a few Hz)
rather than frame rate, which is what makes it affordable to run a depth network,
a bundle adjustment and a place-recognition query for every keyframe.

Work is split across two threads, and **where** each step runs is part of the
design, not an implementation detail:

``build_keyframe`` runs on the **tracker thread**:

1. **depth** -- predict, then align to the existing landmarks.
2. **seed landmarks** -- give the tracker's unassociated features 3D positions,
   so subsequent frames have something to do PnP against.

These two must run on the tracker thread because seeding writes directly into
the tracker's live feature arrays. Doing it from the mapper thread races with
KLT tracking and feature redetection, which reorder and resize those arrays
every frame: landmark ids get scattered onto the wrong features, PnP starves,
and tracking is lost within a couple of seconds. The cost is one depth inference
(~10 ms) on the tracking thread per keyframe -- affordable at a few Hz.

``process`` runs on the **mapper thread**, where nothing touches tracker state:

3. **ORB descriptors** for place recognition.
4. **bundle adjustment** over the sliding window.
5. **loop closure** -- after BA, so matching is judged against the best geometry.
6. **hand to fusion** -- last, so what gets integrated is post-optimization.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

import cv2
import numpy as np

from ..config import Config
from ..depth.base import DepthEstimator, edge_confidence, robust_align_depth
from ..types import AtomicCounter, Keyframe, se3_inv, pose_distance
from .frontend import TrackState, VisualOdometry
from .local_ba import bundle_adjust
from .loop_closure import LoopCloser
from .mapdb import SceneMap
from .pose_graph import PoseGraph

log = logging.getLogger(__name__)


@dataclass
class MappingStats:
    keyframes: int = 0
    ba_runs: int = 0
    ba_cost_reduction: float = 0.0
    loops_found: int = 0
    depth_ms: float = 0.0
    ba_ms: float = 0.0
    align_scale: float = 1.0
    align_points: int = 0
    culled_landmarks: int = 0
    last_correction_m: float = 0.0


class LocalMapper:
    """Owns everything that happens when a frame is promoted to a keyframe."""

    def __init__(
        self,
        cfg: Config,
        scene_map: SceneMap,
        depth: DepthEstimator,
        vo: VisualOdometry,
        on_keyframe: Optional[Callable[[Keyframe], None]] = None,
        on_loop_closure: Optional[Callable[[dict[int, np.ndarray], float], None]] = None,
    ) -> None:
        self.cfg = cfg
        self.map = scene_map
        self.depth = depth
        self.vo = vo
        self.on_keyframe = on_keyframe
        self.on_loop_closure = on_loop_closure
        self.loop_closer = LoopCloser(cfg)
        self._kf_ids = AtomicCounter(0)
        self._lock = threading.RLock()
        # Own detector instance: cv2 feature detectors are not documented as
        # reentrant, and the tracker holds its own on another thread.
        self._orb = cv2.ORB_create(nfeatures=cfg.tracking.orb_features)
        self.stats = MappingStats()
        #: Accumulated pose correction since fusion last rebuilt the volume.
        self.pending_correction_m = 0.0
        self.pending_correction_deg = 0.0
        #: Running depth alignment, carried across keyframes rather than refit
        #: from scratch each time.
        self._align_scale = 1.0
        self._align_shift = 0.0
        self._align_frozen = False
        #: Persistent pose graph. Odometry edges are recorded once, as the
        #: relative pose actually measured between consecutive keyframes, and
        #: never re-derived. Rebuilding the graph from corrected poses each time
        #: would re-base the odometry constraints on the previous correction, so
        #: every new loop edge pulls again on an already-corrected trajectory --
        #: successive closures then compound into metre-scale over-correction
        #: and a steadily shrinking map.
        self._pose_graph = PoseGraph()
        self._last_kf_id: Optional[int] = None
        self._loop_edges: set[tuple[int, int]] = set()

    # -- tracker thread -----------------------------------------------------

    def build_keyframe(self, result) -> Optional[Keyframe]:
        """Depth + landmark seeding. **Must run on the tracker thread.**"""
        frame = result.frame
        if frame is None:
            return None

        kf_id = self._kf_ids.next()
        t0 = time.perf_counter()

        # 1. Depth, aligned to the landmarks the tracker already trusts.
        depth_raw = result.extras.get("depth")
        if depth_raw is None:
            depth_raw = self.depth.predict(frame.image, frame.intrinsics, frame.index)
        self.stats.depth_ms = (time.perf_counter() - t0) * 1000
        depth, conf = self._align_depth(depth_raw, result)

        # 2. Seed landmarks for tracks that do not have one yet, and read back
        #    the tracker's associations as they stand at this exact frame.
        keypoints, point_ids = self.vo.register_keyframe_points(
            kf_id, depth, frame.image, result.T_wc
        )

        return Keyframe(
            kf_id=kf_id,
            frame_index=frame.index,
            timestamp=frame.timestamp,
            image=frame.image.copy(),
            # Source-resolution frame, when the ingest retained it. Live
            # tracking never reads it; it exists so offline REFINE and
            # texture baking get every pixel the camera sent instead of the
            # downscaled track image.
            image_full=frame.full,
            intrinsics=frame.intrinsics,
            T_wc=np.array(result.T_wc, dtype=np.float64, copy=True),
            depth=depth,
            depth_conf=conf,
            pose_conf=float(result.extras.get("pose_conf", 1.0)),
            keypoints_tracked=keypoints,
            point_ids=point_ids,
        )

    # -- mapper thread ------------------------------------------------------

    def process(self, kf: Keyframe) -> Optional[Keyframe]:
        """Descriptors, map insertion, bundle adjustment, loop closure."""
        with self._lock:
            gray = cv2.cvtColor(kf.image, cv2.COLOR_RGB2GRAY)
            kf.keypoints, kf.descriptors = self._compute_orb(gray)

            self.map.add_keyframe(kf)
            self._record_observations(kf, kf.keypoints_tracked, kf.point_ids)
            self.stats.keyframes += 1

            if self.cfg.tracking.local_ba_enabled and self.map.n_keyframes >= 3:
                self._run_local_ba()

            # Record the odometry constraint *after* BA, so the edge carries the
            # best available relative estimate -- then freeze it forever.
            self._extend_pose_graph(kf)

            self.loop_closer.add_keyframe(kf)
            if self.cfg.loop.enabled:
                self._try_loop_closure(kf)

            if kf.kf_id % 10 == 0:
                self.stats.culled_landmarks += self.map.cull_unreliable(kf.kf_id)

            if self.on_keyframe is not None:
                self.on_keyframe(kf)
            return kf

    def _compute_orb(self, gray: np.ndarray):
        """ORB for place recognition, on this thread's own detector instance."""
        kps, desc = self._orb.detectAndCompute(gray, None)
        if not kps:
            return np.empty((0, 2), np.float32), None
        return np.array([k.pt for k in kps], np.float32), desc

    # -- depth --------------------------------------------------------------

    def _align_depth(self, depth_raw: np.ndarray, result):
        """Scale/shift the prediction onto the tracked landmarks."""
        d = np.array(depth_raw, dtype=np.float32, copy=True)
        dcfg = self.cfg.depth

        if dcfg.align_to_map and result.point_ids is not None:
            px, cam_z = self._alignment_anchors(result)
            frozen = (dcfg.align_freeze_after_kf > 0
                      and getattr(self.depth, "metric", False)
                      and self.stats.keyframes >= dcfg.align_freeze_after_kf)
            if frozen:
                if not self._align_frozen:
                    self._align_frozen = True
                    log.info("depth alignment frozen at scale %.4f, shift %.4f "
                             "after %d keyframes", self._align_scale,
                             self._align_shift, self.stats.keyframes)
            elif len(px) >= dcfg.align_min_points:
                fit_shift = dcfg.align_shift or not getattr(self.depth, "metric", False)
                scale, shift, n_inl, resid = robust_align_depth(
                    d, px, cam_z,
                    fit_shift=fit_shift,
                    max_scale=dcfg.align_max_scale,
                    min_points=dcfg.align_min_points,
                )
                if n_inl >= dcfg.align_min_points:
                    self._update_alignment(scale, shift)
                    self.stats.align_points = n_inl
                else:
                    # Rejected. Falling back to the running alignment degrades
                    # this keyframe slightly; applying a bad scale would corrupt
                    # the whole map, so this is the safer failure.
                    log.debug("depth alignment rejected at kf (residual %.3f)", resid)
            d = d * self._align_scale + self._align_shift
            self.stats.align_scale = self._align_scale

        np.clip(d, 0.0, dcfg.max_depth_m, out=d)
        d[d < dcfg.min_depth_m] = 0.0
        conf = edge_confidence(d, dcfg.edge_threshold) if dcfg.edge_suppression else None
        return d, conf

    def _alignment_anchors(self, result):
        """Pixels and metric depths of landmarks trustworthy enough to align to.

        Restricted to multi-view landmarks. A landmark observed once is nothing
        but this pipeline's own back-projected depth wearing a different hat;
        fitting depth to it measures nothing and lets any scale error feed back
        into itself, compounding a few percent per keyframe into a large
        systematic error over a flight.
        """
        dcfg = self.cfg.depth
        empty = (np.zeros((0, 2), np.float64), np.zeros(0, np.float64))
        if result.keypoints is None or result.point_ids is None:
            return empty

        valid = result.point_ids >= 0
        if valid.sum() < dcfg.align_min_points:
            return empty
        pids = result.point_ids[valid]
        px = result.keypoints[valid]

        if dcfg.align_min_observations > 1:
            n_obs = np.array([self.map.observation_count(int(p)) for p in pids])
            multi = n_obs >= dcfg.align_min_observations
            if multi.sum() >= dcfg.align_min_points:
                pids, px = pids[multi], px[multi]
            else:
                # Early in a session nothing is multi-view yet. Skipping the
                # alignment entirely is correct here: the map is still defined
                # by the first keyframe's depth, so there is nothing to correct
                # against.
                return empty

        world = self.map.positions(pids)
        T_cw = se3_inv(result.T_wc)
        cam_z = (world @ T_cw[:3, :3].T + T_cw[:3, 3])[:, 2]
        ok = (cam_z > dcfg.min_depth_m) & (cam_z < dcfg.max_depth_m)
        if ok.sum() < dcfg.align_min_points:
            return empty
        return px[ok].astype(np.float64), cam_z[ok].astype(np.float64)

    def _update_alignment(self, scale: float, shift: float) -> None:
        """Blend a new fit into the running alignment, rate-limited."""
        dcfg = self.cfg.depth
        a = 1.0 - float(np.clip(dcfg.align_smoothing, 0.0, 0.99))
        target_s = (1.0 - a) * self._align_scale + a * scale
        target_t = (1.0 - a) * self._align_shift + a * shift
        # Hard cap on per-keyframe change so one bad fit cannot move the map.
        lo = self._align_scale * (1.0 - dcfg.align_max_step)
        hi = self._align_scale * (1.0 + dcfg.align_max_step)
        self._align_scale = float(np.clip(target_s, lo, hi))
        self._align_shift = float(target_t)

    def _record_observations(self, kf: Keyframe, keypoints, point_ids) -> None:
        if point_ids is None:
            return
        for i, pid in enumerate(point_ids):
            if pid >= 0:
                self.map.add_observation(int(pid), kf.kf_id, i)
        kf.point_ids = point_ids
        kf.keypoints_tracked = keypoints

    # -- bundle adjustment --------------------------------------------------

    def _run_local_ba(self) -> None:
        cfg = self.cfg.tracking
        window = self.map.recent_keyframes(cfg.local_ba_window)
        if len(window) < 3:
            return

        kf_ids = [kf.kf_id for kf in window]
        kf_slot = {kid: i for i, kid in enumerate(kf_ids)}
        poses_cw = np.array([se3_inv(kf.T_wc) for kf in window])

        # Collect observations of landmarks visible in this window.
        #
        # Culled landmarks must be excluded here, not merely skipped on
        # writeback. A retired landmark keeps whatever stale position it had
        # when it was retired, and feeding it back as a fixed constraint drags
        # the whole window onto bad geometry -- the symptom is bundle adjustment
        # behaving for dozens of keyframes and then abruptly relocating the
        # camera by metres, immediately after a culling pass.
        candidates = set()
        for kf in window:
            if kf.point_ids is not None:
                candidates.update(int(p) for p in kf.point_ids if p >= 0)
        if not candidates:
            return
        cand_arr = np.fromiter(sorted(candidates), np.int64, len(candidates))
        live_lookup = set(cand_arr[self.map.alive_mask(cand_arr)].tolist())

        # Rank landmarks by how many keyframes in this window observe them, and
        # keep the best. Truncating in insertion order instead (whatever the
        # first keyframe happened to list) makes the result depend on an
        # arbitrary subset: raising the cap can then *lower* accuracy, because a
        # different, worse set of landmarks gets optimized. Multi-view points
        # are also the ones that actually constrain the geometry -- a landmark
        # seen once contributes nothing but its own reprojection.
        obs_count: dict[int, int] = {}
        for kf in window:
            if kf.point_ids is None or kf.keypoints_tracked is None:
                continue
            for pid in kf.point_ids:
                pid = int(pid)
                if pid >= 0 and pid in live_lookup:
                    obs_count[pid] = obs_count.get(pid, 0) + 1
        if not obs_count:
            return
        ranked = sorted(obs_count, key=lambda p: (-obs_count[p], p))
        selected = set(ranked[: cfg.local_ba_max_points])

        pid_list: list[int] = []
        pid_slot: dict[int, int] = {}
        obs_kf, obs_pt, obs_uv = [], [], []

        for kf in window:
            pts = kf.keypoints_tracked
            if pts is None or kf.point_ids is None:
                continue
            for i, pid in enumerate(kf.point_ids):
                pid = int(pid)
                if pid < 0 or i >= len(pts) or pid not in selected:
                    continue
                if pid not in pid_slot:
                    pid_slot[pid] = len(pid_list)
                    pid_list.append(pid)
                obs_kf.append(kf_slot[kf.kf_id])
                obs_pt.append(pid_slot[pid])
                obs_uv.append(pts[i])

        if len(obs_kf) < 30 or not pid_list:
            return

        pid_array = np.array(pid_list, np.int64)
        points = self.map.positions(pid_array)

        fixed = np.zeros(len(window), bool)
        # Pin the two oldest keyframes: one fixes the gauge, the second stops the
        # window from rotating about it.
        fixed[0] = True
        if len(window) > 3:
            fixed[1] = True

        # Also pin any keyframe that barely observes anything in this window.
        # Six pose degrees of freedom cannot be recovered from a handful of
        # points, and an underconstrained camera is exactly what lets an
        # otherwise well-behaved solve suddenly relocate a keyframe by metres.
        obs_per_kf = np.bincount(np.asarray(obs_kf, np.int64), minlength=len(window))
        starved = obs_per_kf < cfg.local_ba_min_obs_per_kf
        if starved.any():
            log.debug("pinning %d underconstrained keyframes in BA window",
                      int(starved.sum()))
            fixed |= starved
        if fixed.all():
            return

        t0 = time.perf_counter()
        res = bundle_adjust(
            poses_cw, points,
            np.array(obs_kf, np.int64), np.array(obs_pt, np.int64),
            np.array(obs_uv, np.float64), window[0].intrinsics.K,
            fixed_poses=fixed,
            iterations=cfg.local_ba_iterations,
            huber_px=cfg.huber_delta_px,
        )
        self.stats.ba_ms = (time.perf_counter() - t0) * 1000
        self.stats.ba_runs += 1

        if not res.improved:
            log.debug("local BA did not improve cost; discarding step")
            return

        newest = window[-1]
        old_newest = newest.T_wc.copy()
        new_poses = {kid: se3_inv(res.poses[kf_slot[kid]]) for kid in kf_ids}

        # Trust region on the whole solve. Local BA refines a window; it should
        # never relocate a camera by a large fraction of the scene depth, and if
        # it tries, the window was ill-conditioned and the step is not trustworthy.
        scene = max(window[-1].median_depth(), 1.0)
        limit = cfg.local_ba_max_shift_ratio * scene
        worst = max(float(np.linalg.norm(new_poses[k][:3, 3] - self.map.get_keyframe(k).T_wc[:3, 3]))
                    for k in kf_ids)
        # NaN compares False against everything, so an explicit finiteness test
        # is required or a diverged solve slips through the trust region.
        if not np.isfinite(worst) or not all(np.all(np.isfinite(T)) for T in new_poses.values())                 or not np.all(np.isfinite(res.points)):
            log.warning("rejecting local BA step: solve diverged (non-finite result)")
            return
        if worst > limit:
            log.warning("rejecting local BA step: moved a keyframe %.2f m "
                        "(limit %.2f m for a %.1f m scene)", worst, limit, scene)
            return

        self.stats.ba_cost_reduction = 1.0 - res.final_cost / max(res.initial_cost, 1e-9)
        self.map.set_keyframe_poses(new_poses)
        self.map.set_positions(pid_array, res.points)

        # The tracker needs no explicit correction here. Its pose comes from
        # PnP against the landmarks that were just moved, so it follows the
        # optimization automatically on the next frame. Also nudging its pose by
        # the same delta would apply the correction twice -- which shows up as
        # over-correction and, because the mapper runs asynchronously, as large
        # run-to-run variance in the final trajectory.
        del old_newest
        self._track_correction(newest)

    def _track_correction(self, newest: Keyframe) -> None:
        """Record how far optimization has moved things since the last fusion."""
        if newest.fused_T_wc is not None:
            t, r = pose_distance(newest.fused_T_wc, newest.T_wc)
            self.pending_correction_m = max(self.pending_correction_m, t)
            self.pending_correction_deg = max(self.pending_correction_deg, r)

    # -- loop closure -------------------------------------------------------

    def _extend_pose_graph(self, kf: Keyframe) -> None:
        """Append this keyframe and its odometry edge to the persistent graph."""
        self._pose_graph.add_node(kf.kf_id, kf.T_wc)
        if self._last_kf_id is not None:
            prev = self.map.get_keyframe(self._last_kf_id)
            if prev is not None:
                # Odometry edges carry high information; loop edges are given
                # less, so a marginal closure bends the trajectory rather than
                # snapping it onto a possibly-wrong match.
                self._pose_graph.add_edge(
                    prev.kf_id, kf.kf_id, se3_inv(prev.T_wc) @ kf.T_wc,
                    information=np.eye(6) * 100.0,
                )
        self._last_kf_id = kf.kf_id

    def _try_loop_closure(self, kf: Keyframe) -> None:
        cand = self.loop_closer.detect(kf, self.map.keyframes)
        if cand is None or not cand.verified:
            return

        pair = (min(cand.match_kf, cand.query_kf), max(cand.match_kf, cand.query_kf))
        if pair in self._loop_edges:
            return
        self.stats.loops_found += 1

        kf_ids = self.map.keyframe_ids()
        poses = {kid: self.map.get_keyframe(kid).T_wc for kid in kf_ids
                 if self.map.get_keyframe(kid) is not None}
        if len(poses) < 3:
            return

        pg = self._pose_graph
        # Refresh node estimates from the map: local BA has been refining recent
        # poses, and the graph should start its solve from the current best guess.
        for kid, T in poses.items():
            pg.add_node(kid, T)
        pg.add_edge(cand.match_kf, cand.query_kf, cand.T_ij,
                    information=np.eye(6) * 30.0, is_loop=True)
        self._loop_edges.add(pair)

        before = {k: v.copy() for k, v in poses.items()}
        res = pg.optimize(iterations=self.cfg.loop.pose_graph_iterations,
                          fixed={kf_ids[0]}, huber_delta=1.0)
        if not all(np.all(np.isfinite(T)) for T in res.poses.values()):
            log.warning("rejecting pose-graph solution: non-finite poses")
            return
        if res.final_error > res.initial_error:
            log.warning("pose graph diverged; keeping pre-closure trajectory")
            return

        self.map.set_keyframe_poses(res.poses)
        self._rigid_update_landmarks(before, res.poses)

        shift = max(float(np.linalg.norm(res.poses[k][:3, 3] - before[k][:3, 3]))
                    for k in before)
        self.pending_correction_m = max(self.pending_correction_m, shift)
        self.stats.last_correction_m = shift
        log.info("loop closure applied: chi2 %.4f -> %.4f, max pose shift %.3f m",
                 res.initial_error, res.final_error, shift)

        # As with local BA, the landmarks have moved, so the tracker converges
        # onto the corrected trajectory by itself. The one case that cannot
        # self-correct is a tracker running on its motion model with no
        # landmarks in view, so the correction is applied only then.
        if self.vo.state is not TrackState.TRACKING:
            newest = self.map.last_keyframe()
            if newest is not None and newest.kf_id in before:
                self.vo.apply_correction(
                    res.poses[newest.kf_id] @ se3_inv(before[newest.kf_id]))

        if self.on_loop_closure is not None:
            self.on_loop_closure(res.poses, shift)

    def _rigid_update_landmarks(self, before: dict, after: dict) -> None:
        """Move each landmark with the keyframe that first observed it.

        The pose graph optimizes cameras only. Landmarks must follow, or the
        structure stays where the drifted trajectory put it and every subsequent
        PnP is fighting the correction. Applying the *anchor keyframe's* relative
        motion keeps each landmark rigidly attached to the view it came from.
        """
        moved = 0
        for kf_id in sorted(after):
            kf = self.map.get_keyframe(kf_id)
            if kf is None or kf.point_ids is None or kf_id not in before:
                continue
            delta = after[kf_id] @ se3_inv(before[kf_id])
            if np.allclose(delta, np.eye(4), atol=1e-9):
                continue
            pids = np.unique(kf.point_ids[kf.point_ids >= 0])
            if pids.size == 0:
                continue
            # Only points anchored to this keyframe, so nothing moves twice.
            anchored = np.array(
                [p for p in pids if min(self.map.observations(int(p)), default=kf_id) == kf_id],
                dtype=np.int64,
            )
            if anchored.size == 0:
                continue
            xyz = self.map.positions(anchored)
            self.map.set_positions(anchored, xyz @ delta[:3, :3].T + delta[:3, 3])
            moved += anchored.size
        log.debug("loop closure moved %d landmarks", moved)

    def clear_pending_correction(self) -> None:
        self.pending_correction_m = 0.0
        self.pending_correction_deg = 0.0
