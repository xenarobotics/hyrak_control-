"""Spatially-hashed TSDF volume on CUDA, via CuPy + NVRTC.

Why hand-written rather than Open3D's ``VoxelBlockGrid``: this GPU has 8 GB
shared with the desktop compositor, so the voxel store needs a hard, declared
VRAM ceiling and a defined behaviour when it is reached. Owning the allocator
makes that explicit -- the budget is computed up front, the kernels refuse to
allocate past it, and overflow triggers eviction of blocks the camera has left
behind rather than a CUDA OOM in the middle of a flight.

NVRTC compiles the kernels at import time, so no CUDA toolkit is required on the
machine -- only the driver.
"""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict
import time
from pathlib import Path
from typing import Optional

import numpy as np

from ..types import CameraIntrinsics, se3_inv
from .base import FusionStats, Mapper

log = logging.getLogger(__name__)

_KERNEL_NAMES = (
    "touched_blocks",
    "hash_lookup_or_alloc",
    "hash_insert",
    "integrate",
    "gather_dense",
    "extract_surface_points",
)

# Must mirror kernels.cu pack_coord exactly.
_COORD_OFFSET = 1 << 20
_COORD_MASK = 0x1FFFFF


def _next_pow2(n: int) -> int:
    p = 1
    while p < n:
        p <<= 1
    return p


class CudaTSDFVolume(Mapper):
    def __init__(self, cfg) -> None:
        import cupy as cp

        self.cp = cp
        self.cfg = cfg
        f = cfg.fusion
        self.voxel_size = float(f.voxel_size_m)
        self.block_size = int(f.block_size)
        self.trunc = float(f.trunc_voxels) * self.voxel_size
        self.max_weight = float(f.max_weight)
        self._lock = threading.RLock()

        self.vpb = self.block_size ** 3
        # tsdf(fp16) + weight(fp16) + rgb(3 x uint8) per voxel
        self.bytes_per_block = self.vpb * (2 + 2 + 3)
        budget = int(f.max_vram_gb * (1 << 30))
        self.max_blocks = max(1024, budget // self.bytes_per_block)
        # Load factor of 0.5 keeps linear probing short; the table is a small
        # fraction of total memory so being generous here is cheap.
        self.table_size = _next_pow2(int(self.max_blocks * 2))

        src = (Path(__file__).parent / "kernels.cu").read_text()
        t0 = time.perf_counter()
        self._module = cp.RawModule(code=src, options=("-std=c++14",), backend="nvrtc")
        self._k = {n: self._module.get_function(n) for n in _KERNEL_NAMES}
        log.info("TSDF kernels compiled in %.2fs", time.perf_counter() - t0)

        self._allocate()
        # Host-RAM tier: evicted blocks spill here instead of being discarded,
        # and page back in when the camera revisits the region. Turns the VRAM
        # budget from "maximum map size" into "maximum working set" -- the
        # difference between a 75 s scan and a 10 minute walk through a
        # building on an 8 GB card that Blender is also using.
        hc_gb = float(getattr(f, "host_cache_gb", 8.0))
        self.host_max_blocks = (int(hc_gb * (1 << 30) / self.bytes_per_block)
                                if hc_gb > 0 else 0)
        self._host: OrderedDict[int, tuple] = OrderedDict()
        self._host_dropped = 0
        self._stats = FusionStats(blocks_capacity=self.max_blocks,
                                  vram_mb=self.reserved_mb)
        log.info(
            "CUDA TSDF ready: voxel=%.3fm trunc=%.3fm block=%d^3 capacity=%d blocks "
            "(%.2f GB reserved, hash table %d slots)",
            self.voxel_size, self.trunc, self.block_size, self.max_blocks,
            self.reserved_mb / 1024, self.table_size,
        )

    # -- allocation ---------------------------------------------------------

    def _allocate(self) -> None:
        cp = self.cp
        self.tsdf = cp.ones((self.max_blocks * self.vpb,), cp.float16)
        self.wsum = cp.zeros((self.max_blocks * self.vpb,), cp.float16)
        self.rgb = cp.zeros((self.max_blocks * self.vpb * 3,), cp.uint8)
        self.table_keys = cp.full((self.table_size,), 0xFFFFFFFFFFFFFFFF, cp.uint64)
        self.table_vals = cp.full((self.table_size,), -1, cp.int32)
        self.alloc_coords = cp.zeros((self.max_blocks * 3,), cp.int32)
        self.block_count = cp.zeros((1,), cp.int32)
        self.overflow = cp.zeros((1,), cp.int32)
        #: Frame index at which each block was last touched, for LRU eviction.
        self.block_last_seen = cp.zeros((self.max_blocks,), cp.int32)
        self._frame_counter = 0

    @property
    def reserved_mb(self) -> float:
        return (
            self.tsdf.nbytes + self.wsum.nbytes + self.rgb.nbytes
            + self.table_keys.nbytes + self.table_vals.nbytes
            + self.alloc_coords.nbytes + self.block_last_seen.nbytes
        ) / (1024**2)

    @property
    def n_blocks(self) -> int:
        return int(self.block_count.get()[0])

    # -- integration --------------------------------------------------------

    def integrate(
        self,
        depth: np.ndarray,
        color: Optional[np.ndarray],
        T_wc: np.ndarray,
        intrinsics: CameraIntrinsics,
        weight_map: Optional[np.ndarray] = None,
    ) -> None:
        cp = self.cp
        with self._lock:
            if self._released:
                return  # a late frame after close() - drop it, do not fault
            t0 = time.perf_counter()
            H, W = depth.shape[:2]
            d_dev = cp.asarray(np.ascontiguousarray(depth, np.float32))
            c_dev = (cp.asarray(np.ascontiguousarray(color, np.uint8))
                     if color is not None else None)
            w_dev = (cp.asarray(np.ascontiguousarray(weight_map, np.float32))
                     if weight_map is not None else None)

            T_wc = np.ascontiguousarray(T_wc, np.float32)
            T_cw = np.ascontiguousarray(se3_inv(T_wc.astype(np.float64)), np.float32)
            T_wc_dev = cp.asarray(T_wc.reshape(-1))
            T_cw_dev = cp.asarray(T_cw.reshape(-1))

            stride = max(1, int(self.cfg.fusion.depth_stride))
            # Enough samples that consecutive steps cannot skip over a block.
            n_samples = max(2, int(np.ceil(
                2.0 * self.trunc / (self.voxel_size * self.block_size))) + 1)

            pix_w = (W + stride - 1) // stride
            pix_h = (H + stride - 1) // stride
            n_tasks = pix_w * pix_h * n_samples
            keys = cp.empty((n_tasks,), cp.uint64)

            threads = 256
            self._k["touched_blocks"](
                ((n_tasks + threads - 1) // threads,), (threads,),
                (d_dev, np.int32(H), np.int32(W), np.int32(stride), T_wc_dev,
                 np.float32(intrinsics.fx), np.float32(intrinsics.fy),
                 np.float32(intrinsics.cx), np.float32(intrinsics.cy),
                 np.float32(self.voxel_size), np.int32(self.block_size),
                 np.float32(self.trunc),
                 np.float32(self.cfg.depth.min_depth_m),
                 np.float32(self.cfg.fusion.max_integration_depth_m),
                 np.int32(n_samples), keys, np.int32(n_tasks)),
            )

            # Deduplicate on the GPU. This is what lets the allocator skip
            # spin-waiting: every key reaching the hash kernel is unique.
            uniq = cp.unique(keys)
            uniq = uniq[uniq != cp.uint64(0xFFFFFFFFFFFFFFFF)]
            n_uniq = int(uniq.size)
            if n_uniq == 0:
                self._stats.last_integrate_ms = (time.perf_counter() - t0) * 1000
                return

            idx = cp.empty((n_uniq,), cp.int32)
            coords = cp.empty((n_uniq * 3,), cp.int32)

            def _alloc() -> bool:
                self.overflow.fill(0)
                self._k["hash_lookup_or_alloc"](
                    ((n_uniq + threads - 1) // threads,), (threads,),
                    (uniq, np.int32(n_uniq), self.table_keys, self.table_vals,
                     np.int32(self.table_size), self.block_count,
                     np.int32(self.max_blocks), idx, coords,
                     self.alloc_coords, self.overflow),
                )
                return bool(int(self.overflow.get()[0]))

            if _alloc():
                # Budget exhausted: evict least-recently-seen blocks and retry
                # once. Progressively tighter windows, so the minimum geometry
                # is lost; only if even the tightest frees nothing (the whole
                # budget was touched recently -- it is genuinely too small) is
                # this frame's new geometry refused.
                self._stats.overflow_events += 1
                for keep_recent in (200, 100, 50, 25):
                    if self.evict_stale(keep_recent):
                        break
                if _alloc():
                    log.warning(
                        "TSDF block budget exhausted (%d blocks, %.2f GB) and "
                        "nothing is stale enough to evict. Increase "
                        "fusion.max_vram_gb or coarsen fusion.voxel_size_m.",
                        self.max_blocks, self.reserved_mb / 1024,
                    )

            if self._host:
                paged = self._page_in(uniq, idx)
                if paged:
                    self._stats.extra["paged_in_total"] = (
                        self._stats.extra.get("paged_in_total", 0) + paged)

            self._frame_counter += 1
            live = idx >= 0
            if bool(live.any()):
                self.block_last_seen[idx[live]] = self._frame_counter

            self._k["integrate"](
                (n_uniq,), (min(self.vpb, 512),),
                (coords, idx, np.int32(n_uniq), np.int32(self.block_size),
                 d_dev, c_dev if c_dev is not None else cp.uint64(0),
                 w_dev if w_dev is not None else cp.uint64(0),
                 np.int32(H), np.int32(W), T_cw_dev,
                 np.float32(intrinsics.fx), np.float32(intrinsics.fy),
                 np.float32(intrinsics.cx), np.float32(intrinsics.cy),
                 np.float32(self.voxel_size), np.float32(self.trunc),
                 np.float32(self.cfg.depth.min_depth_m),
                 np.float32(self.cfg.fusion.max_integration_depth_m),
                 np.float32(self.max_weight),
                 self.tsdf, self.wsum, self.rgb),
            )
            cp.cuda.Stream.null.synchronize()

            self._stats.integrations += 1
            self._stats.blocks_allocated = self.n_blocks
            self._stats.last_integrate_ms = (time.perf_counter() - t0) * 1000
            self._stats.vram_mb = self.reserved_mb
            self._stats.extra["host_blocks"] = len(self._host)
            self._stats.extra["host_mb"] = round(
                len(self._host) * self.bytes_per_block / 2**20, 1)

            # Proactive eviction: with a host tier there is no reason to run
            # the working set against the hard budget and pay the
            # overflow/retry path -- spill early, keep headroom.
            if (self.host_max_blocks
                    and self.n_blocks > int(0.9 * self.max_blocks)):
                self.evict_stale(keep_recent=150)

    def weight_map_for(self, depth: np.ndarray, intrinsics: CameraIntrinsics,
                       confidence: Optional[np.ndarray] = None) -> np.ndarray:
        """Build the per-pixel fusion weight using this volume's configuration."""
        from .base import compute_weight_map

        f = self.cfg.fusion
        return compute_weight_map(
            depth, intrinsics, confidence,
            angle_weighting=f.angle_weighting,
            range_weighting=f.range_weighting,
            max_depth=f.max_integration_depth_m,
            range_ref_m=f.range_ref_m,
            range_weight_floor=f.range_weight_floor,
        )

    # -- extraction ---------------------------------------------------------

    @property
    def _released(self) -> bool:
        """True once close() has freed the CUDA buffers. An export racing a
        session stop (end-of-stream and an explicit /stop firing _on_stop
        twice) used to read alloc_coords after it was deleted and crash the
        whole engine with AttributeError."""
        return not hasattr(self, "alloc_coords")

    def _live_blocks(self):
        cp = self.cp
        if self._released:
            return None, None, 0
        n = self.n_blocks
        if n == 0:
            return None, None, 0
        coords = self.alloc_coords[: n * 3]
        index = cp.arange(n, dtype=cp.int32)
        return coords, index, n

    def extract_point_cloud(self, min_weight: float = 1.0):
        cp = self.cp
        with self._lock:
            if self._released:
                return np.zeros((0, 3), np.float32), np.zeros((0, 3), np.uint8)
            coords, index, n = self._live_blocks()
            if n == 0:
                return np.zeros((0, 3), np.float32), np.zeros((0, 3), np.uint8)
            # Upper bound: every voxel could sit on the surface. In practice the
            # surface is ~1% of the volume, so cap and report if it is hit.
            max_points = min(n * self.vpb, 40_000_000)
            xyz = cp.empty((max_points * 3,), cp.float32)
            rgb = cp.zeros((max_points * 3,), cp.uint8)
            count = cp.zeros((1,), cp.int32)
            self._k["extract_surface_points"](
                (n,), (min(self.vpb, 512),),
                (coords, index, np.int32(n), np.int32(self.block_size),
                 self.tsdf, self.wsum, self.rgb,
                 self.table_keys, self.table_vals, np.int32(self.table_size),
                 np.float32(self.voxel_size), np.float32(min_weight),
                 xyz, rgb, count, np.int32(max_points)),
            )
            cp.cuda.Stream.null.synchronize()
            k = min(int(count.get()[0]), max_points)
            if k >= max_points:
                log.warning("surface point buffer saturated at %d points", max_points)
            gx = cp.asnumpy(xyz[: k * 3]).reshape(-1, 3)
            gc = cp.asnumpy(rgb[: k * 3]).reshape(-1, 3)
            if not self._host:
                return gx, gc
            hx, hc = self._host_surface_points(min_weight)
            if not len(hx):
                return gx, gc
            return (np.concatenate([gx, hx]).astype(np.float32),
                    np.concatenate([gc, hc]))

    def _host_surface_points(self, min_weight: float):
        """Surface voxels from the spilled tier (in-block sign changes).

        Cross-block neighbours are not resolved here, so points on block
        faces are under-sampled compared to the exact GPU kernel -- fine for
        a cloud of the revisitable history; the mesh path is exact.
        """
        bs = self.block_size
        keys = np.fromiter(self._host.keys(), np.uint64, len(self._host))
        pts, cols = [], []
        chunk = 2048
        for s0 in range(0, len(keys), chunk):
            kk = keys[s0:s0 + chunk]
            t = np.stack([self._host[int(k)][0] for k in kk]).reshape(
                -1, bs, bs, bs).astype(np.float32)
            w = np.stack([self._host[int(k)][1] for k in kk]).reshape(
                -1, bs, bs, bs).astype(np.float32)
            c = np.stack([self._host[int(k)][2] for k in kk]).reshape(
                -1, bs, bs, bs, 3)
            valid = w >= min_weight
            neg = t < 0
            surf = np.zeros_like(valid)
            surf[:, :, :, :-1] |= (neg[:, :, :, :-1] != neg[:, :, :, 1:]) \
                & valid[:, :, :, :-1] & valid[:, :, :, 1:]
            surf[:, :, :-1, :] |= (neg[:, :, :-1, :] != neg[:, :, 1:, :]) \
                & valid[:, :, :-1, :] & valid[:, :, 1:, :]
            surf[:, :-1, :, :] |= (neg[:, :-1, :, :] != neg[:, 1:, :, :]) \
                & valid[:, :-1, :, :] & valid[:, 1:, :, :]
            bi, lz, ly, lx = np.nonzero(surf)
            if not len(bi):
                continue
            coords = self._unpack_keys(kk)
            base = coords[bi] * bs
            vox = base + np.stack([lx, ly, lz], axis=1)
            pts.append((vox + 0.5).astype(np.float32) * self.voxel_size)
            cols.append(c[bi, lz, ly, lx])
        if not pts:
            return np.zeros((0, 3), np.float32), np.zeros((0, 3), np.uint8)
        return np.concatenate(pts), np.concatenate(cols)

    def bounds_voxels(self) -> Optional[tuple[np.ndarray, np.ndarray]]:
        """Occupied extent in integer voxel coordinates."""
        with self._lock:
            if self._released:
                return None
            n = self.n_blocks
            if n == 0 and not self._host:
                return None
            parts = []
            if n:
                parts.append(self.cp.asnumpy(
                    self.alloc_coords[: n * 3]).reshape(-1, 3))
            if self._host:
                keys = np.fromiter(self._host.keys(), np.uint64,
                                   len(self._host))
                parts.append(self._unpack_keys(keys))
            coords = np.concatenate(parts)
            lo = coords.min(axis=0) * self.block_size
            hi = (coords.max(axis=0) + 1) * self.block_size
            return lo, hi

    def gather_dense(self, origin_vox: np.ndarray, extent: np.ndarray,
                     with_color: bool = True):
        """Pull a dense sub-volume back to the host, for marching cubes."""
        cp = self.cp
        nx, ny, nz = (int(e) for e in extent)
        total = nx * ny * nz
        with self._lock:
            out_t = cp.empty((total,), cp.float32)
            out_w = cp.empty((total,), cp.float32)
            out_c = cp.zeros((total * 3,), cp.uint8) if with_color else cp.zeros(1, cp.uint8)
            threads = 256
            self._k["gather_dense"](
                ((total + threads - 1) // threads,), (threads,),
                (self.table_keys, self.table_vals, np.int32(self.table_size),
                 self.tsdf, self.wsum, self.rgb, np.int32(self.block_size),
                 np.int32(origin_vox[0]), np.int32(origin_vox[1]), np.int32(origin_vox[2]),
                 np.int32(nx), np.int32(ny), np.int32(nz),
                 out_t, out_w, out_c),
            )
            cp.cuda.Stream.null.synchronize()
            t = cp.asnumpy(out_t).reshape(nz, ny, nx)
            w = cp.asnumpy(out_w).reshape(nz, ny, nx)
            c = cp.asnumpy(out_c).reshape(nz, ny, nx, 3) if with_color else None
            if self._host:
                # Overlay spilled blocks so meshing sees the WHOLE map, not
                # just the GPU working set. This is what makes export exact
                # (halos included) without paging anything back to the GPU.
                self._overlay_host(t, w, c, origin_vox, (nx, ny, nz))
            return t, w, c

    def _overlay_host(self, t, w, c, origin, extent) -> None:
        bs = self.block_size
        keys = np.fromiter(self._host.keys(), np.uint64, len(self._host))
        vox_lo = self._unpack_keys(keys) * bs
        nx, ny, nz = (int(e) for e in extent)
        ox, oy, oz = (int(origin[0]), int(origin[1]), int(origin[2]))
        m = ((vox_lo[:, 0] + bs > ox) & (vox_lo[:, 0] < ox + nx)
             & (vox_lo[:, 1] + bs > oy) & (vox_lo[:, 1] < oy + ny)
             & (vox_lo[:, 2] + bs > oz) & (vox_lo[:, 2] < oz + nz))
        for key, (bx, by, bz) in zip(keys[m], vox_lo[m]):
            tb, wb, cb = self._host[int(key)]
            x0, x1 = max(bx - ox, 0), min(bx + bs - ox, nx)
            y0, y1 = max(by - oy, 0), min(by + bs - oy, ny)
            z0, z1 = max(bz - oz, 0), min(bz + bs - oz, nz)
            sx0, sy0, sz0 = x0 - (bx - ox), y0 - (by - oy), z0 - (bz - oz)
            sx1, sy1, sz1 = sx0 + (x1 - x0), sy0 + (y1 - y0), sz0 + (z1 - z0)
            t3 = tb.reshape(bs, bs, bs)  # storage order [lz, ly, lx]
            w3 = wb.reshape(bs, bs, bs)
            t[z0:z1, y0:y1, x0:x1] = t3[sz0:sz1, sy0:sy1,
                                        sx0:sx1].astype(np.float32)
            w[z0:z1, y0:y1, x0:x1] = w3[sz0:sz1, sy0:sy1,
                                        sx0:sx1].astype(np.float32)
            if c is not None:
                c3 = cb.reshape(bs, bs, bs, 3)
                c[z0:z1, y0:y1, x0:x1] = c3[sz0:sz1, sy0:sy1, sx0:sx1]

    def extract_mesh(self, min_weight: float = 1.0, tile: int = 96,
                     erode_frontier: bool = True):
        """Marching cubes over the occupied volume, tiled with a halo.

        Tiling keeps host memory bounded for large scenes; the one-voxel halo on
        the high side is what makes neighbouring tiles agree on the surface
        rather than leaving a crack at every seam.

        The result is watertight only where the volume was actually observed.
        Unseen regions are left open rather than closed off with invented
        geometry; :func:`dronemap.export.mesh.close_holes` can fill them if a
        sealed model is required downstream.

        ``erode_frontier`` shrinks the observed mask by one voxel before
        meshing. Leave it on: the outer edge of the truncation band sits right at
        the weight threshold, so the mask boundary itself wanders through partly
        observed voxels and marching cubes turns that boundary into surface --
        a complete phantom shell one truncation distance behind every real wall.
        On the validation scene this artifact accounted for 37% of all vertices
        and pushed 95th-percentile error from 1.7 cm to 24.9 cm; eroding removes
        it entirely and costs about one percentage point of completeness.
        """
        from scipy import ndimage
        from skimage import measure

        bounds = self.bounds_voxels()
        if bounds is None:
            return (np.zeros((0, 3), np.float32), np.zeros((0, 3), np.int32),
                    np.zeros((0, 3), np.uint8))
        lo, hi = bounds
        verts_all, faces_all, cols_all = [], [], []
        v_offset = 0

        for z0 in range(lo[2], hi[2], tile):
            for y0 in range(lo[1], hi[1], tile):
                for x0 in range(lo[0], hi[0], tile):
                    origin = np.array([x0, y0, z0])
                    extent = np.minimum(np.array([tile, tile, tile]) + 1,
                                        hi - origin + 1)
                    if np.any(extent < 2):
                        continue
                    t, w, c = self.gather_dense(origin, extent)
                    observed = w >= min_weight
                    if not observed.any():
                        continue
                    mask = observed
                    if erode_frontier:
                        # 2x2x2 element: a cell survives only if it and every
                        # neighbour sharing a corner were observed.
                        mask = ndimage.binary_erosion(
                            observed, np.ones((2, 2, 2), bool), border_value=0
                        )
                        if not mask.any():
                            continue
                    field = np.where(observed, t, 1.0).astype(np.float32)
                    if field.min() > 0 or field.max() < 0:
                        continue
                    # Restrict marching cubes to fully-observed cells. Merely
                    # forcing unobserved voxels positive is not enough: behind
                    # every real wall sits a thin negative band and then unseen
                    # space, and the transition between them is a zero crossing
                    # that produces a phantom duplicate surface one truncation
                    # distance behind the true one. The mask suppresses any cell
                    # with an unobserved corner, so surface is only generated
                    # where there is actual evidence for it.
                    try:
                        v, f, _, _ = measure.marching_cubes(
                            field, level=0.0, mask=mask
                        )
                    except (ValueError, RuntimeError, TypeError):
                        continue
                    if len(v) == 0:
                        continue
                    # marching_cubes indexes (z, y, x); convert to world XYZ.
                    # The +0.5 is the voxel-centre offset: index i denotes the
                    # voxel whose centre is at (i + 0.5) * voxel_size, the same
                    # convention the integrate kernel uses. Omitting it biases
                    # the entire mesh by half a voxel against the point cloud.
                    vox = v[:, ::-1] + origin[None, :] + 0.5
                    verts_all.append((vox * self.voxel_size).astype(np.float32))
                    faces_all.append(f.astype(np.int64) + v_offset)
                    v_offset += len(v)
                    if c is not None:
                        zi = np.clip(np.round(v[:, 0]).astype(int), 0, extent[2] - 1)
                        yi = np.clip(np.round(v[:, 1]).astype(int), 0, extent[1] - 1)
                        xi = np.clip(np.round(v[:, 2]).astype(int), 0, extent[0] - 1)
                        cols_all.append(c[zi, yi, xi])

        if not verts_all:
            return (np.zeros((0, 3), np.float32), np.zeros((0, 3), np.int32),
                    np.zeros((0, 3), np.uint8))
        verts = np.concatenate(verts_all)
        faces = np.concatenate(faces_all).astype(np.int32)
        colors = (np.concatenate(cols_all).astype(np.uint8) if cols_all
                  else np.full((len(verts), 3), 200, np.uint8))
        return verts, faces, colors

    # -- maintenance --------------------------------------------------------

    @staticmethod
    def _unpack_keys(keys: np.ndarray) -> np.ndarray:
        """Packed uint64 keys -> (N,3) int block coords (mirrors kernels.cu)."""
        k = keys.astype(np.uint64)
        m = np.uint64(_COORD_MASK)
        x = ((k >> np.uint64(42)) & m).astype(np.int64) - _COORD_OFFSET
        y = ((k >> np.uint64(21)) & m).astype(np.int64) - _COORD_OFFSET
        z = (k & m).astype(np.int64) - _COORD_OFFSET
        return np.stack([x, y, z], axis=1)

    def _spill_blocks(self, idx, n: int) -> int:
        """Copy the payloads of the given block slots into the host cache.

        Called with the volume lock held, before eviction compaction resets
        those slots. Empty blocks (zero weight everywhere) are not worth
        caching and are skipped.
        """
        cp = self.cp
        vpb = self.vpb
        coords = self.alloc_coords[:n * 3].reshape(n, 3)[idx]
        keys = cp.asnumpy(self._pack_coords(coords))
        idx = cp.asarray(idx)
        spilled = 0
        chunk = 4096
        for s0 in range(0, len(keys), chunk):
            sel = idx[s0:s0 + chunk]
            offs = (sel[:, None] * vpb + cp.arange(vpb)[None, :]).reshape(-1)
            t = cp.asnumpy(self.tsdf[offs]).reshape(-1, vpb)
            w = cp.asnumpy(self.wsum[offs]).reshape(-1, vpb)
            offs3 = (sel[:, None] * (vpb * 3)
                     + cp.arange(vpb * 3)[None, :]).reshape(-1)
            c = cp.asnumpy(self.rgb[offs3]).reshape(-1, vpb * 3)
            nonempty = np.asarray(w.max(axis=1) > 0)
            for j in np.flatnonzero(nonempty):
                self._host[int(keys[s0 + j])] = (
                    t[j].copy(), w[j].copy(), c[j].copy())
                spilled += 1
        while len(self._host) > self.host_max_blocks:
            self._host.popitem(last=False)
            self._host_dropped += 1
        if self._host_dropped and self._host_dropped % 1000 == 1:
            log.warning(
                "host cache full (%d blocks); oldest spilled geometry is "
                "being dropped (%d so far). Raise fusion.host_cache_gb.",
                len(self._host), self._host_dropped)
        return spilled

    def _page_in(self, uniq, idx) -> int:
        """Restore cached payloads for blocks re-allocated this integrate.

        The cache and the GPU-resident set are disjoint by construction, so
        any allocated key found in the cache was just re-allocated with empty
        voxels -- overwrite them with the spilled geometry so integration
        accumulates onto what was already mapped there.
        """
        cp = self.cp
        keys_np = cp.asnumpy(uniq)
        idx_np = cp.asnumpy(idx)
        hits = [(i, int(k)) for i, k in enumerate(keys_np)
                if idx_np[i] >= 0 and int(k) in self._host]
        if not hits:
            return 0
        vpb = self.vpb
        slots = cp.asarray(np.array([idx_np[i] for i, _ in hits], np.int64))
        t = np.stack([self._host[k][0] for _, k in hits])
        w = np.stack([self._host[k][1] for _, k in hits])
        c = np.stack([self._host[k][2] for _, k in hits])
        for _, k in hits:
            del self._host[k]
        offs = (slots[:, None] * vpb + cp.arange(vpb)[None, :]).reshape(-1)
        self.tsdf[offs] = cp.asarray(t.reshape(-1))
        self.wsum[offs] = cp.asarray(w.reshape(-1))
        offs3 = (slots[:, None] * (vpb * 3)
                 + cp.arange(vpb * 3)[None, :]).reshape(-1)
        self.rgb[offs3] = cp.asarray(c.reshape(-1))
        return len(hits)

    def _pack_coords(self, coords):
        """Block coords (N,3) int32 -> packed uint64 keys, mirroring kernels.cu."""
        cp = self.cp
        c = coords.astype(cp.int64)
        ux = ((c[:, 0] + _COORD_OFFSET) & _COORD_MASK).astype(cp.uint64)
        uy = ((c[:, 1] + _COORD_OFFSET) & _COORD_MASK).astype(cp.uint64)
        uz = ((c[:, 2] + _COORD_OFFSET) & _COORD_MASK).astype(cp.uint64)
        return (ux << cp.uint64(42)) | (uy << cp.uint64(21)) | uz

    def evict_stale(self, keep_recent: int = 200) -> int:
        """Evict blocks the camera has not seen recently and RECLAIM their
        storage, so new geometry can allocate again.

        This compacts: surviving block payloads are gathered to the front of
        the storage arrays (chunked, so scratch stays bounded), the registry
        and LRU stamps move with them, and the hash table is rebuilt from the
        survivors. Without compaction the previous version only zeroed stale
        content -- ``block_count`` never went down, so the budget stayed
        exhausted and every new block was refused for the rest of the session.

        Evicted geometry is gone for good; acceptable, because the alternative
        is refusing to map anything new.
        """
        cp = self.cp
        with self._lock:
            n = self.n_blocks
            if n == 0:
                return 0
            age = self._frame_counter - self.block_last_seen[:n]
            keep = cp.flatnonzero(age <= keep_recent)
            n_keep = int(keep.size)
            n_evicted = n - n_keep
            if n_evicted == 0:
                return 0
            if self.host_max_blocks:
                evicted = cp.flatnonzero(age > keep_recent)
                n_spilled = self._spill_blocks(evicted, n)
                self._stats.extra["spilled_total"] = (
                    self._stats.extra.get("spilled_total", 0) + n_spilled)
            vpb = self.vpb

            # keep is ascending, so every destination offset is <= its source
            # offset and a forward chunked copy never overwrites unread data.
            chunk = 4096
            for s in range(0, n_keep, chunk):
                sel = keep[s:s + chunk]
                m = int(sel.size)
                src = (sel[:, None] * vpb + cp.arange(vpb)[None, :]).reshape(-1)
                dst = slice(s * vpb, (s + m) * vpb)
                self.tsdf[dst] = self.tsdf[src]
                self.wsum[dst] = self.wsum[src]
                src3 = (sel[:, None] * (vpb * 3)
                        + cp.arange(vpb * 3)[None, :]).reshape(-1)
                self.rgb[s * vpb * 3:(s + m) * vpb * 3] = self.rgb[src3]

            # Reset the tail so freed slots start clean when re-allocated.
            self.tsdf[n_keep * vpb:n * vpb] = cp.float16(1.0)
            self.wsum[n_keep * vpb:n * vpb] = cp.float16(0.0)

            coords = self.alloc_coords[:n * 3].reshape(n, 3)[keep]
            self.alloc_coords[:n_keep * 3] = coords.reshape(-1)
            self.block_last_seen[:n_keep] = self.block_last_seen[:n][keep]
            self.block_last_seen[n_keep:n] = 0

            self.table_keys.fill(0xFFFFFFFFFFFFFFFF)
            self.table_vals.fill(-1)
            self.block_count.fill(n_keep)
            if n_keep:
                keys = self._pack_coords(coords)
                threads = 256
                self._k["hash_insert"](
                    ((n_keep + threads - 1) // threads,), (threads,),
                    (keys, np.int32(n_keep), self.table_keys, self.table_vals,
                     np.int32(self.table_size)),
                )
            cp.cuda.Stream.null.synchronize()
            self._stats.blocks_allocated = n_keep
            log.info("evicted %d stale TSDF blocks (%d kept, budget %d)",
                     n_evicted, n_keep, self.max_blocks)
            return n_evicted

    def reset(self) -> None:
        """Clear all geometry. Used before re-integration after loop closure."""
        cp = self.cp
        with self._lock:
            self.tsdf.fill(cp.float16(1.0))
            self.wsum.fill(cp.float16(0.0))
            self.rgb.fill(0)
            self.table_keys.fill(0xFFFFFFFFFFFFFFFF)
            self.table_vals.fill(-1)
            self.block_count.fill(0)
            self.block_last_seen.fill(0)
            self._frame_counter = 0
            self._host.clear()
            self._stats.reintegrations += 1
            self._stats.blocks_allocated = 0
            log.info("TSDF volume reset")

    @property
    def stats(self) -> FusionStats:
        self._stats.blocks_allocated = self.n_blocks
        return self._stats

    def close(self) -> None:
        with self._lock:
            self._host.clear()
            for name in ("tsdf", "wsum", "rgb", "table_keys", "table_vals",
                         "alloc_coords", "block_last_seen"):
                if hasattr(self, name):
                    delattr(self, name)
            try:
                self.cp.get_default_memory_pool().free_all_blocks()
            except Exception:  # noqa: BLE001
                pass
