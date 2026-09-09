"""Open3D TSDF fallback, used when CuPy/NVRTC is unavailable.

Slower than the CUDA path -- and possibly CPU-only, since the official Open3D
Linux wheel is not reliably built with CUDA -- but it keeps the pipeline
functional on a machine where runtime kernel compilation does not work, instead
of failing outright.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Optional

import numpy as np

from ..types import CameraIntrinsics, se3_inv
from .base import FusionStats, Mapper

log = logging.getLogger(__name__)


class Open3DTSDFVolume(Mapper):
    def __init__(self, cfg) -> None:
        import open3d as o3d

        self.o3d = o3d
        self.cfg = cfg
        f = cfg.fusion
        self.voxel_size = float(f.voxel_size_m)
        self.block_size = int(f.block_size)
        self._lock = threading.RLock()

        self.device = o3d.core.Device("CPU:0")
        if o3d.core.cuda.is_available():
            self.device = o3d.core.Device("CUDA:0")
            log.info("Open3D CUDA backend available")
        else:
            log.warning(
                "Open3D wheel has no CUDA support; TSDF will run on CPU. "
                "Expect keyframe-rate rather than frame-rate fusion."
            )

        est_blocks = max(10000, int(f.max_vram_gb * (1 << 30) / (self.block_size ** 3 * 8)))
        self.vbg = o3d.t.geometry.VoxelBlockGrid(
            attr_names=("tsdf", "weight", "color"),
            attr_dtypes=(o3d.core.float32, o3d.core.float32, o3d.core.float32),
            attr_channels=((1,), (1,), (3,)),
            voxel_size=self.voxel_size,
            block_resolution=self.block_size,
            block_count=est_blocks,
            device=self.device,
        )
        self.trunc = float(f.trunc_voxels) * self.voxel_size
        self._stats = FusionStats(blocks_capacity=est_blocks)
        log.info("Open3D TSDF ready on %s (voxel %.3f m)", self.device, self.voxel_size)

    def _intrinsic_tensor(self, K: CameraIntrinsics):
        return self.o3d.core.Tensor(K.K, self.o3d.core.float64)

    def integrate(self, depth, color, T_wc, intrinsics, weight_map=None) -> None:
        o3d = self.o3d
        with self._lock:
            t0 = time.perf_counter()
            d = depth.astype(np.float32)
            if weight_map is not None:
                # Open3D has no per-pixel weight input, so approximate by
                # discarding pixels the policy would have weighted near zero.
                d = np.where(weight_map > 1e-3, d, 0.0).astype(np.float32)

            depth_t = o3d.t.geometry.Image(
                o3d.core.Tensor(d, o3d.core.float32, self.device))
            color_t = o3d.t.geometry.Image(
                o3d.core.Tensor(np.ascontiguousarray(color, np.uint8),
                                o3d.core.uint8, self.device)) if color is not None else None

            K_t = self._intrinsic_tensor(intrinsics)
            extrinsic = o3d.core.Tensor(se3_inv(np.asarray(T_wc, np.float64)),
                                        o3d.core.float64)
            frustum = self.vbg.compute_unique_block_coordinates(
                depth_t, K_t, extrinsic, 1.0, self.cfg.fusion.max_integration_depth_m)
            if color_t is not None:
                self.vbg.integrate(frustum, depth_t, color_t, K_t, K_t, extrinsic,
                                   1.0, self.cfg.fusion.max_integration_depth_m)
            else:
                self.vbg.integrate(frustum, depth_t, K_t, extrinsic, 1.0,
                                   self.cfg.fusion.max_integration_depth_m)

            self._stats.integrations += 1
            self._stats.last_integrate_ms = (time.perf_counter() - t0) * 1000

    def extract_point_cloud(self, min_weight: float = 1.0):
        with self._lock:
            pcd = self.vbg.extract_point_cloud(weight_threshold=min_weight).to_legacy()
            xyz = np.asarray(pcd.points, np.float32)
            rgb = ((np.asarray(pcd.colors) * 255).astype(np.uint8)
                   if pcd.has_colors() else np.full((len(xyz), 3), 200, np.uint8))
            return xyz, rgb

    def extract_mesh(self, min_weight: float = 1.0, **kwargs):
        with self._lock:
            mesh = self.vbg.extract_triangle_mesh(weight_threshold=min_weight).to_legacy()
            verts = np.asarray(mesh.vertices, np.float32)
            faces = np.asarray(mesh.triangles, np.int32)
            colors = ((np.asarray(mesh.vertex_colors) * 255).astype(np.uint8)
                      if mesh.has_vertex_colors() else np.full((len(verts), 3), 200, np.uint8))
            return verts, faces, colors

    def reset(self) -> None:
        import open3d as o3d

        with self._lock:
            f = self.cfg.fusion
            est_blocks = self._stats.blocks_capacity
            self.vbg = o3d.t.geometry.VoxelBlockGrid(
                attr_names=("tsdf", "weight", "color"),
                attr_dtypes=(o3d.core.float32, o3d.core.float32, o3d.core.float32),
                attr_channels=((1,), (1,), (3,)),
                voxel_size=self.voxel_size,
                block_resolution=self.block_size,
                block_count=est_blocks,
                device=self.device,
            )
            self._stats.reintegrations += 1

    def weight_map_for(self, depth, intrinsics, confidence=None):
        from .base import compute_weight_map

        f = self.cfg.fusion
        return compute_weight_map(depth, intrinsics, confidence, f.angle_weighting,
                                  f.range_weighting, f.max_integration_depth_m,
                                  f.range_ref_m, f.range_weight_floor)

    @property
    def stats(self) -> FusionStats:
        return self._stats
