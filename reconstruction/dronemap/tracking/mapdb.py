"""SceneMap: the shared, thread-safe store of keyframes and 3D landmarks.

Three threads touch this concurrently -- the tracker reads landmarks at 30 Hz,
the local mapper mutates them during bundle adjustment, and the fusion thread
reads keyframe poses. A single reentrant lock guards all of it. That is coarse,
but the critical sections are microseconds of numpy work and the alternative
(per-point locking) would cost more in contention than it saves.

Landmark *positions* are stored in one contiguous array rather than per-object,
so the tracker's per-frame gather is a single fancy-index instead of a Python
loop over thousands of objects. That difference is what keeps PnP setup under a
millisecond.
"""

from __future__ import annotations

import logging
import threading
from typing import Iterable, Optional

import numpy as np

from ..types import Keyframe, MapPoint, se3_inv

log = logging.getLogger(__name__)


class SceneMap:
    def __init__(self, initial_capacity: int = 65536) -> None:
        self._lock = threading.RLock()

        # Structure-of-arrays landmark store, grown geometrically.
        self._xyz = np.zeros((initial_capacity, 3), dtype=np.float64)
        self._rgb = np.zeros((initial_capacity, 3), dtype=np.uint8)
        self._alive = np.zeros(initial_capacity, dtype=bool)
        self._n_visible = np.zeros(initial_capacity, dtype=np.int32)
        self._n_found = np.zeros(initial_capacity, dtype=np.int32)
        self._last_seen_kf = np.full(initial_capacity, -1, dtype=np.int32)
        self._first_kf = np.full(initial_capacity, -1, dtype=np.int32)
        self._count = 0

        #: point_id -> {kf_id: keypoint_index}
        self._obs: dict[int, dict[int, int]] = {}
        self._descriptors: dict[int, np.ndarray] = {}

        self.keyframes: dict[int, Keyframe] = {}
        self._kf_order: list[int] = []

        #: RAM cap on keyframe payloads: beyond this, the oldest keyframes'
        #: image/depth spill to disk (poses, keypoints, descriptors stay).
        #: Disabled until enable_spill() sets a directory.
        self._spill_dir = None
        self._max_in_memory = 0
        self._spill_cursor = 0  # index into _kf_order: everything before it is spilled
        self._owns_spill_dir = False

        #: Accumulated pose correction since the last TSDF integration, used to
        #: decide when the fused volume has drifted far enough to rebuild.
        self.pose_revision = 0

    # -- landmarks ----------------------------------------------------------

    def _grow(self, needed: int) -> None:
        cap = len(self._alive)
        if needed <= cap:
            return
        new_cap = max(needed, cap * 2)
        def ext(a, fill):
            out = np.full((new_cap,) + a.shape[1:], fill, dtype=a.dtype)
            out[: len(a)] = a
            return out
        self._xyz = ext(self._xyz, 0.0)
        self._rgb = ext(self._rgb, 0)
        self._alive = ext(self._alive, False)
        self._n_visible = ext(self._n_visible, 0)
        self._n_found = ext(self._n_found, 0)
        self._last_seen_kf = ext(self._last_seen_kf, -1)
        self._first_kf = ext(self._first_kf, -1)
        log.debug("SceneMap grew landmark capacity to %d", new_cap)

    def add_points(
        self,
        xyz: np.ndarray,
        rgb: Optional[np.ndarray] = None,
        kf_id: int = -1,
        descriptors: Optional[np.ndarray] = None,
    ) -> np.ndarray:
        """Insert N landmarks; returns their new integer ids."""
        xyz = np.atleast_2d(np.asarray(xyz, dtype=np.float64))
        n = len(xyz)
        if n == 0:
            return np.empty(0, dtype=np.int64)
        with self._lock:
            self._grow(self._count + n)
            ids = np.arange(self._count, self._count + n, dtype=np.int64)
            self._xyz[ids] = xyz
            if rgb is not None:
                self._rgb[ids] = np.asarray(rgb, dtype=np.uint8).reshape(n, 3)
            self._alive[ids] = True
            self._n_visible[ids] = 1
            self._n_found[ids] = 1
            self._last_seen_kf[ids] = kf_id
            self._first_kf[ids] = kf_id
            self._count += n
            if descriptors is not None:
                for i, pid in enumerate(ids):
                    self._descriptors[int(pid)] = descriptors[i]
            return ids

    def positions(self, ids: np.ndarray) -> np.ndarray:
        """Gather world positions for the given ids (no validity filtering)."""
        with self._lock:
            return self._xyz[np.asarray(ids, dtype=np.int64)].copy()

    def set_positions(self, ids: np.ndarray, xyz: np.ndarray) -> None:
        with self._lock:
            self._xyz[np.asarray(ids, dtype=np.int64)] = xyz

    def colors(self, ids: np.ndarray) -> np.ndarray:
        with self._lock:
            return self._rgb[np.asarray(ids, dtype=np.int64)].copy()

    def alive_mask(self, ids: np.ndarray) -> np.ndarray:
        with self._lock:
            return self._alive[np.asarray(ids, dtype=np.int64)]

    def mark_visible(self, ids: np.ndarray) -> None:
        with self._lock:
            self._n_visible[np.asarray(ids, dtype=np.int64)] += 1

    def mark_found(self, ids: np.ndarray, kf_id: int = -1) -> None:
        with self._lock:
            idx = np.asarray(ids, dtype=np.int64)
            self._n_found[idx] += 1
            if kf_id >= 0:
                self._last_seen_kf[idx] = kf_id

    def cull(self, ids: np.ndarray) -> None:
        """Retire landmarks (outliers, or points that never get re-observed)."""
        with self._lock:
            idx = np.asarray(ids, dtype=np.int64)
            if idx.size:
                self._alive[idx] = False

    def cull_unreliable(self, current_kf: int, min_ratio: float = 0.25,
                        grace_kfs: int = 3) -> int:
        """Drop landmarks that keep being predicted visible but rarely match.

        A point that projects into view repeatedly yet is almost never found is
        usually a bad triangulation or a moving object -- exactly the kind of
        thing that poisons PnP if left in the map.
        """
        with self._lock:
            n = self._count
            if n == 0:
                return 0
            live = self._alive[:n]
            mature = live & (self._n_visible[:n] >= 4)
            aged = mature & (self._first_kf[:n] >= 0) & (
                current_kf - self._first_kf[:n] > grace_kfs
            )
            ratio = self._n_found[:n] / np.maximum(self._n_visible[:n], 1)
            bad = aged & (ratio < min_ratio)
            self._alive[:n][bad] = False
            return int(bad.sum())

    def add_observation(self, point_id: int, kf_id: int, kp_index: int) -> None:
        with self._lock:
            self._obs.setdefault(int(point_id), {})[int(kf_id)] = int(kp_index)

    def observations(self, point_id: int) -> dict[int, int]:
        with self._lock:
            return dict(self._obs.get(int(point_id), {}))

    def observation_count(self, point_id: int) -> int:
        with self._lock:
            return len(self._obs.get(int(point_id), {}))

    def get_point(self, point_id: int) -> MapPoint:
        with self._lock:
            pid = int(point_id)
            return MapPoint(
                point_id=pid,
                position=self._xyz[pid].copy(),
                color=self._rgb[pid].copy(),
                observations=dict(self._obs.get(pid, {})),
                descriptor=self._descriptors.get(pid),
                n_visible=int(self._n_visible[pid]),
                n_found=int(self._n_found[pid]),
                is_bad=not bool(self._alive[pid]),
            )

    def all_points(self, with_color: bool = True):
        """Snapshot of every live landmark: (xyz Nx3, rgb Nx3 or None)."""
        with self._lock:
            n = self._count
            m = self._alive[:n]
            xyz = self._xyz[:n][m].copy()
            rgb = self._rgb[:n][m].copy() if with_color else None
            return xyz, rgb

    @property
    def n_points(self) -> int:
        with self._lock:
            return int(self._alive[: self._count].sum())

    # -- keyframes ----------------------------------------------------------

    def enable_spill(self, max_in_memory: int, directory=None) -> None:
        """Cap resident keyframe payloads; spill the oldest beyond it.

        Without a cap, a long-running session grows without bound: every
        keyframe keeps full RGB + depth in RAM (a few MB each), and the config
        knob ``keyframe.max_in_memory`` did nothing.
        """
        import tempfile
        from pathlib import Path

        with self._lock:
            self._max_in_memory = max(8, int(max_in_memory))
            if directory is not None:
                self._spill_dir = Path(directory)
                self._spill_dir.mkdir(parents=True, exist_ok=True)
                self._owns_spill_dir = False
            else:
                self._spill_dir = Path(
                    tempfile.mkdtemp(prefix="dronemap-kfspill-"))
                self._owns_spill_dir = True

    def release_spill(self) -> None:
        """Delete the spill directory (call after the final export)."""
        import shutil

        with self._lock:
            d, owned = self._spill_dir, self._owns_spill_dir
            self._spill_dir = None
        if d is not None and owned:
            shutil.rmtree(d, ignore_errors=True)

    def _maybe_spill_locked(self) -> None:
        if self._spill_dir is None:
            return
        while len(self._kf_order) - self._spill_cursor > self._max_in_memory:
            kf = self.keyframes.get(self._kf_order[self._spill_cursor])
            self._spill_cursor += 1
            if kf is None or kf.image is None:
                continue
            try:
                kf.spill(self._spill_dir)
            except OSError:
                log.exception("keyframe spill failed; disabling the RAM cap")
                self._spill_dir = None
                return

    def add_keyframe(self, kf: Keyframe) -> None:
        with self._lock:
            self.keyframes[kf.kf_id] = kf
            self._kf_order.append(kf.kf_id)
            self._maybe_spill_locked()

    def get_keyframe(self, kf_id: int) -> Optional[Keyframe]:
        with self._lock:
            return self.keyframes.get(int(kf_id))

    def recent_keyframes(self, n: int) -> list[Keyframe]:
        with self._lock:
            return [self.keyframes[k] for k in self._kf_order[-n:] if k in self.keyframes]

    def all_keyframes(self) -> list[Keyframe]:
        with self._lock:
            return [self.keyframes[k] for k in self._kf_order if k in self.keyframes]

    def keyframe_ids(self) -> list[int]:
        with self._lock:
            return list(self._kf_order)

    @property
    def n_keyframes(self) -> int:
        with self._lock:
            return len(self._kf_order)

    def last_keyframe(self) -> Optional[Keyframe]:
        with self._lock:
            if not self._kf_order:
                return None
            return self.keyframes.get(self._kf_order[-1])

    def set_keyframe_poses(self, poses: dict[int, np.ndarray]) -> None:
        """Apply optimized poses (from BA or pose-graph) atomically."""
        with self._lock:
            for kf_id, T in poses.items():
                kf = self.keyframes.get(int(kf_id))
                if kf is not None:
                    kf.T_wc = np.asarray(T, dtype=np.float64)
            self.pose_revision += 1

    def transform_all(self, T: np.ndarray) -> None:
        """Rigidly transform the entire map (used by scale/gravity alignment)."""
        with self._lock:
            n = self._count
            if n:
                self._xyz[:n] = self._xyz[:n] @ T[:3, :3].T + T[:3, 3]
            for kf in self.keyframes.values():
                kf.T_wc = T @ kf.T_wc
            self.pose_revision += 1

    def rescale(self, s: float) -> None:
        """Scale the whole map about the origin -- landmarks and translations."""
        with self._lock:
            n = self._count
            if n:
                self._xyz[:n] *= s
            for kf in self.keyframes.values():
                kf.T_wc = kf.T_wc.copy()
                kf.T_wc[:3, 3] *= s
                if kf.depth is not None:
                    kf.depth = kf.depth * s
                if kf.spill_path is not None:
                    # The on-disk copy still holds the old scale; remember the
                    # correction so reload re-enters at the current scale.
                    kf.spill_depth_scale *= s
            self.pose_revision += 1

    # -- covisibility -------------------------------------------------------

    def covisible_keyframes(self, kf_id: int, min_shared: int = 15) -> list[int]:
        """Keyframes sharing at least `min_shared` landmarks with `kf_id`.

        This is the graph local BA optimizes over and the graph loop closure
        propagates corrections through.
        """
        with self._lock:
            kf = self.keyframes.get(int(kf_id))
            if kf is None or kf.point_ids is None:
                return []
            mine = {int(p) for p in kf.point_ids if p >= 0}
            if not mine:
                return []
            shared: dict[int, int] = {}
            for pid in mine:
                for other in self._obs.get(pid, {}):
                    if other != kf_id:
                        shared[other] = shared.get(other, 0) + 1
            return sorted(
                (k for k, c in shared.items() if c >= min_shared),
                key=lambda k: -shared[k],
            )

    def trajectory(self) -> np.ndarray:
        """Keyframe camera centres in world coordinates, in time order (Nx3)."""
        with self._lock:
            if not self._kf_order:
                return np.zeros((0, 3))
            return np.array(
                [self.keyframes[k].T_wc[:3, 3] for k in self._kf_order if k in self.keyframes]
            )

    def stats(self) -> dict:
        with self._lock:
            n = self._count
            return {
                "landmarks_live": int(self._alive[:n].sum()),
                "landmarks_total": n,
                "keyframes": len(self._kf_order),
                "pose_revision": self.pose_revision,
            }
