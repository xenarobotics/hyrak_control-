"""TSDF fusion correctness and export round-trips.

The CUDA tests skip cleanly when CuPy or a GPU is unavailable, so the suite
still runs on a CPU-only machine.
"""

import numpy as np
import pytest

from dronemap.config import Config
from dronemap.export.mesh import (compute_vertex_normals, remove_small_components,
                                  weld_vertices)
from dronemap.export.pointcloud import voxel_downsample, write_ply
from dronemap.export.splat import build_gaussians, normals_to_quaternions, write_splat
from dronemap.fusion.base import compute_weight_map
from dronemap.types import CameraIntrinsics

cupy = pytest.importorskip("cupy", reason="CUDA TSDF requires cupy")


def _cuda_available() -> bool:
    try:
        cupy.cuda.runtime.getDeviceCount()
        return True
    except Exception:  # noqa: BLE001
        return False


requires_cuda = pytest.mark.skipif(not _cuda_available(), reason="no CUDA device")


def _plane_depth(K: CameraIntrinsics, distance: float) -> np.ndarray:
    """Depth image of a fronto-parallel plane at a known distance."""
    return np.full((K.height, K.width), distance, np.float32)


@pytest.fixture(scope="module")
def volume():
    from dronemap.fusion.tsdf_cuda import CudaTSDFVolume

    cfg = Config()
    cfg.fusion.voxel_size_m = 0.05
    cfg.fusion.max_vram_gb = 0.25
    cfg.fusion.max_integration_depth_m = 15.0
    return CudaTSDFVolume(cfg)


@requires_cuda
def test_plane_reconstructs_at_the_right_distance(volume):
    """The single most important invariant: the zero crossing lands on the surface."""
    volume.reset()
    K = CameraIntrinsics.from_fov(160, 120, 60.0)
    distance = 3.0
    depth = _plane_depth(K, distance)
    volume.integrate(depth, np.full((K.height, K.width, 3), 200, np.uint8),
                     np.eye(4), K, volume.weight_map_for(depth, K))
    xyz, _ = volume.extract_point_cloud(min_weight=0.01)
    assert len(xyz) > 100
    # The plane is at z = distance in camera == world coordinates here.
    assert np.median(xyz[:, 2]) == pytest.approx(distance, abs=volume.voxel_size)
    assert xyz[:, 2].std() < volume.voxel_size * 1.5


@requires_cuda
def test_eviction_reclaims_budget_and_reallocates():
    """evict_stale must compact: block_count drops, the survivors stay
    extractable at the right place, and an evicted region can be mapped again
    (no poisoned hash slots)."""
    from dronemap.fusion.tsdf_cuda import CudaTSDFVolume

    cfg = Config()
    cfg.fusion.voxel_size_m = 0.05
    cfg.fusion.max_vram_gb = 0.25
    cfg.fusion.max_integration_depth_m = 15.0
    cfg.fusion.host_cache_gb = 0  # this test asserts the DISCARD path
    vol = CudaTSDFVolume(cfg)
    K = CameraIntrinsics.from_fov(160, 120, 60.0)
    depth = _plane_depth(K, 3.0)
    wm = vol.weight_map_for(depth, K)

    poses = []
    for i in range(4):
        T = np.eye(4)
        T[0, 3] = 6.0 * i  # disjoint regions along +x
        poses.append(T)
        vol.integrate(depth, None, T, K, wm)

    n_before = vol.n_blocks
    evicted = vol.evict_stale(keep_recent=1)  # keep only the last two frames
    assert evicted > 0
    assert vol.n_blocks == n_before - evicted

    xyz, _ = vol.extract_point_cloud(min_weight=0.01)
    near = lambda x0: (np.abs(xyz[:, 0] - x0) < 2.5) & (np.abs(xyz[:, 2] - 3.0) < 0.2)
    assert near(18.0).sum() > 100, "newest surface lost by compaction"
    assert near(0.0).sum() == 0, "evicted surface still present"

    # Reintegrate the evicted region: allocation must succeed again.
    vol.integrate(depth, None, poses[0], K, wm)
    xyz2, _ = vol.extract_point_cloud(min_weight=0.01)
    back = (np.abs(xyz2[:, 0]) < 2.5) & (np.abs(xyz2[:, 2] - 3.0) < 0.2)
    assert back.sum() > 100, "evicted region could not be re-mapped"
    vol.close()


@requires_cuda
def test_surface_moves_with_the_camera_pose(volume):
    """Fusing the same depth from a translated pose must move the surface."""
    volume.reset()
    K = CameraIntrinsics.from_fov(160, 120, 60.0)
    depth = _plane_depth(K, 3.0)
    T = np.eye(4)
    T[0, 3] = 5.0                      # camera translated +5 m along x
    volume.integrate(depth, None, T, K, volume.weight_map_for(depth, K))
    xyz, _ = volume.extract_point_cloud(min_weight=0.01)
    assert len(xyz) > 100
    assert np.median(xyz[:, 0]) == pytest.approx(5.0, abs=0.2)
    assert np.median(xyz[:, 2]) == pytest.approx(3.0, abs=0.2)


@requires_cuda
def test_weight_accumulates_and_saturates(volume):
    volume.reset()
    K = CameraIntrinsics.from_fov(160, 120, 60.0)
    depth = _plane_depth(K, 3.0)
    wm = volume.weight_map_for(depth, K)
    for _ in range(5):
        volume.integrate(depth, None, np.eye(4), K, wm)
    lo, hi = volume.bounds_voxels()
    t, w, _ = volume.gather_dense(lo, np.minimum(hi - lo, np.array([48, 48, 48])))
    assert w.max() <= volume.max_weight + 1e-3
    assert w.max() > 1.0


@requires_cuda
def test_reset_clears_all_geometry(volume):
    K = CameraIntrinsics.from_fov(160, 120, 60.0)
    depth = _plane_depth(K, 3.0)
    volume.integrate(depth, None, np.eye(4), K, volume.weight_map_for(depth, K))
    assert volume.n_blocks > 0
    volume.reset()
    assert volume.n_blocks == 0
    xyz, _ = volume.extract_point_cloud(min_weight=0.01)
    assert len(xyz) == 0


@requires_cuda
def test_mesh_does_not_extend_behind_the_surface(volume):
    """Regression: unobserved space must not become a phantom duplicate surface."""
    volume.reset()
    K = CameraIntrinsics.from_fov(200, 150, 70.0)
    depth = _plane_depth(K, 3.0)
    wm = volume.weight_map_for(depth, K)
    for dx in (-0.3, 0.0, 0.3):
        T = np.eye(4)
        T[0, 3] = dx
        volume.integrate(depth, None, T, K, wm)
    verts, faces, _ = volume.extract_mesh(min_weight=0.01)
    assert len(verts) > 0
    # Everything must sit near the plane, not one truncation distance behind it.
    trunc = volume.trunc
    assert verts[:, 2].max() < 3.0 + trunc, "phantom surface behind the plane"


@requires_cuda
def test_block_budget_is_respected(volume):
    """The allocator must refuse to exceed its declared VRAM ceiling."""
    assert volume.n_blocks <= volume.max_blocks
    assert volume.reserved_mb <= volume.cfg.fusion.max_vram_gb * 1024 * 1.15


# ----------------------------------------------------------------- weight map

def test_weight_map_zeroes_invalid_and_far_depth():
    K = CameraIntrinsics.from_fov(64, 48, 60.0)
    depth = np.full((48, 64), 5.0, np.float32)
    depth[0, 0] = 0.0            # invalid
    depth[0, 1] = 100.0          # beyond range
    w = compute_weight_map(depth, K, max_depth=30.0)
    assert w[0, 0] == 0.0
    assert w[0, 1] == 0.0
    assert w[24, 32] > 0.0


def test_weight_map_falls_off_with_range_but_keeps_a_floor():
    """Unfloored 1/d^2 makes distant surface unrecoverable at extraction time."""
    K = CameraIntrinsics.from_fov(64, 48, 60.0)
    near = compute_weight_map(np.full((48, 64), 3.0, np.float32), K,
                              angle_weighting=False)
    far = compute_weight_map(np.full((48, 64), 25.0, np.float32), K,
                             angle_weighting=False, max_depth=30.0)
    assert near.mean() > far.mean()
    assert far.mean() > 0.05, "far surfaces must retain usable weight"


# --------------------------------------------------------------------- export

def test_weld_removes_duplicate_vertices_and_degenerate_faces():
    verts = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0],
                      [0, 0, 0], [1, 0, 0], [0, 1, 0]], np.float32)
    faces = np.array([[0, 1, 2], [3, 4, 5]], np.int32)
    v, f, _ = weld_vertices(verts, faces, None)
    assert len(v) == 3
    assert len(f) == 1, "the duplicate triangle collapses onto the first"


def test_remove_small_components_keeps_the_large_one():
    # One 4-triangle patch plus an isolated single triangle.
    big_v = np.random.default_rng(0).random((30, 3)).astype(np.float32)
    big_f = np.array([[i, i + 1, i + 2] for i in range(0, 24, 1)], np.int32)
    small_v = np.array([[10, 10, 10], [11, 10, 10], [10, 11, 10]], np.float32)
    verts = np.vstack([big_v, small_v])
    faces = np.vstack([big_f, np.array([[30, 31, 32]], np.int32)])
    v, f, _ = remove_small_components(verts, faces, None, min_faces=5)
    assert len(f) == len(big_f)
    assert not np.any(np.linalg.norm(v - np.array([10, 10, 10]), axis=1) < 1e-6)


def test_vertex_normals_point_consistently():
    verts = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], np.float64)
    faces = np.array([[0, 1, 2]], np.int32)
    n = compute_vertex_normals(verts, faces)
    assert np.allclose(np.linalg.norm(n, axis=1), 1.0)
    assert np.allclose(np.abs(n[:, 2]), 1.0)   # a z=0 triangle has a z normal


def test_ply_roundtrip(tmp_path):
    xyz = np.random.default_rng(0).random((500, 3)).astype(np.float32)
    rgb = np.random.default_rng(1).integers(0, 255, (500, 3)).astype(np.uint8)
    path = write_ply(tmp_path / "cloud.ply", xyz, rgb)
    import trimesh

    loaded = trimesh.load(path)
    assert len(loaded.vertices) == 500
    assert np.allclose(np.sort(loaded.vertices[:, 0]), np.sort(xyz[:, 0]), atol=1e-5)


def test_voxel_downsample_reduces_and_preserves_extent():
    rng = np.random.default_rng(0)
    xyz = rng.random((5000, 3)).astype(np.float32) * 2
    rgb = rng.integers(0, 255, (5000, 3)).astype(np.uint8)
    out_xyz, out_rgb = voxel_downsample(xyz, rgb, 0.1)
    assert len(out_xyz) < len(xyz)
    assert out_xyz.min() >= xyz.min() - 0.1
    assert out_xyz.max() <= xyz.max() + 0.1
    assert len(out_rgb) == len(out_xyz)


def test_splat_quaternions_rotate_z_onto_the_normal():
    rng = np.random.default_rng(0)
    normals = rng.normal(size=(200, 3))
    normals /= np.linalg.norm(normals, axis=1, keepdims=True)
    q = normals_to_quaternions(normals)
    assert np.allclose(np.linalg.norm(q, axis=1), 1.0, atol=1e-5)
    # Rotate +z by each quaternion and confirm it lands on the normal.
    w, x, y, z = q.T
    R_z = np.stack([2 * (x * z + w * y), 2 * (y * z - w * x),
                    1 - 2 * (x * x + y * y)], axis=1)
    assert np.allclose(R_z, normals, atol=1e-4)


def test_splat_binary_is_32_bytes_per_gaussian(tmp_path):
    xyz = np.random.default_rng(0).random((100, 3)).astype(np.float32)
    rgb = np.full((100, 3), 128, np.uint8)
    g = build_gaussians(xyz, rgb, voxel_size=0.04)
    path = write_splat(tmp_path / "m.splat", g)
    assert path.stat().st_size == 100 * 32


@requires_cuda
def test_extract_is_safe_after_close():
    """A session stop can race an export (end-of-stream and an explicit stop
    both fire _on_stop): close() frees the CUDA buffers, then a queued export
    reads them. This used to raise AttributeError on alloc_coords and take
    the whole engine down. Extraction must return empty, not crash - and a
    late frame after close must be dropped, not fault."""
    from dronemap.fusion.tsdf_cuda import CudaTSDFVolume

    cfg = Config()
    cfg.fusion.voxel_size_m = 0.05
    cfg.fusion.max_vram_gb = 0.25
    vol = CudaTSDFVolume(cfg)
    K = CameraIntrinsics.from_fov(160, 120, 60.0)
    depth = _plane_depth(K, 3.0)
    vol.integrate(depth, np.full((K.height, K.width, 3), 200, np.uint8),
                  np.eye(4), K, vol.weight_map_for(depth, K))
    assert len(vol.extract_point_cloud(min_weight=0.01)[0]) > 0

    vol.close()

    # Every path that reads the freed buffers must degrade, not raise.
    xyz, rgb = vol.extract_point_cloud(min_weight=0.01)
    assert len(xyz) == 0 and len(rgb) == 0
    assert vol.bounds_voxels() is None
    v, f, c = vol.extract_mesh()
    assert len(v) == 0 and len(f) == 0
    # A late frame after close is dropped silently.
    vol.integrate(depth, np.full((K.height, K.width, 3), 200, np.uint8),
                  np.eye(4), K, vol.weight_map_for(depth, K))


@requires_cuda
def test_out_of_core_spill_and_page_in():
    """Evicted blocks spill to host RAM, still appear in extraction, and page
    back in when the region is revisited -- the VRAM budget bounds the
    working set, not the map."""
    from dronemap.fusion.tsdf_cuda import CudaTSDFVolume

    cfg = Config()
    cfg.fusion.voxel_size_m = 0.05
    cfg.fusion.max_vram_gb = 0.25
    cfg.fusion.max_integration_depth_m = 15.0
    cfg.fusion.host_cache_gb = 1.0
    vol = CudaTSDFVolume(cfg)
    K = CameraIntrinsics.from_fov(160, 120, 60.0)
    depth = _plane_depth(K, 3.0)
    wm = vol.weight_map_for(depth, K)

    T_far = np.eye(4)
    T_far[0, 3] = 12.0
    vol.integrate(depth, np.full((K.height, K.width, 3), 90, np.uint8),
                  np.eye(4), K, wm)          # region A (frame 1)
    vol.integrate(depth, np.full((K.height, K.width, 3), 200, np.uint8),
                  T_far, K, wm)              # region B (frame 2)

    n_before = vol.n_blocks
    evicted = vol.evict_stale(keep_recent=0)  # A is now stale, B fresh
    assert evicted > 0
    assert len(vol._host) > 0, "eviction should have spilled, not discarded"
    assert vol.n_blocks < n_before

    near = lambda xyz, x0: ((np.abs(xyz[:, 0] - x0) < 2.5)
                            & (np.abs(xyz[:, 2] - 3.0) < 0.2))
    # Point cloud must still contain the SPILLED region A.
    xyz, rgb = vol.extract_point_cloud(min_weight=0.01)
    assert near(xyz, 12.0).sum() > 100, "resident surface missing"
    assert near(xyz, 0.0).sum() > 100, "spilled surface lost from extraction"

    # Mesh path (gather_dense overlay) must span both regions too.
    verts, faces, _cols = vol.extract_mesh(min_weight=0.01)
    assert len(verts) and len(faces)
    assert verts[:, 0].max() > 10.0 and verts[:, 0].min() < 2.0, \
        "mesh does not span the spilled region"

    # Revisit region A: the cached blocks must page back in and accumulate.
    cached_before = len(vol._host)
    vol.integrate(depth, np.full((K.height, K.width, 3), 90, np.uint8),
                  np.eye(4), K, wm)
    assert len(vol._host) < cached_before, "revisit did not page blocks in"
    xyz2, _ = vol.extract_point_cloud(min_weight=0.01)
    a = xyz2[near(xyz2, 0.0)]
    assert len(a) > 100
    # Paged-in geometry must land where it was, not doubled/shifted.
    assert np.median(a[:, 2]) == pytest.approx(3.0, abs=2 * vol.voxel_size)
    assert a[:, 2].std() < vol.voxel_size * 1.5
    vol.close()
