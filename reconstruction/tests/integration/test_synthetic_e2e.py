"""End-to-end pipeline test over a synthetic scene with exact ground truth.

Runs the real ingest, tracker, mapper, fusion and export paths -- not mocks --
and grades the result against known poses and geometry. Sequential mode is used
so the outcome reflects the algorithms rather than thread scheduling.

Marked slow; it renders and processes a sequence, so it takes tens of seconds.
"""

import numpy as np
import pytest

from dronemap.config import Config
from dronemap.selftest import (GroundTruthDepth, observed_surface,
                               reconstruction_metrics, render_to_folder,
                               trajectory_metrics)
from dronemap.synthetic import build_sequence

pytest.importorskip("cupy", reason="end-to-end test needs the CUDA TSDF")


def _cuda() -> bool:
    import cupy

    try:
        cupy.cuda.runtime.getDeviceCount()
        return True
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not _cuda(), reason="no CUDA device")


def _configure(tmp_path, img_dir, seq, frames):
    cfg = Config()
    cfg.source.kind = "folder"
    cfg.source.uri = str(img_dir)
    cfg.source.track_width, cfg.source.track_height = 640, 360
    cfg.source.realtime_replay = False
    cfg.source.retain_full_res = False
    cfg.camera.width, cfg.camera.height = 640, 360
    K = seq.intrinsics
    cfg.camera.fx, cfg.camera.fy = K.fx, K.fy
    cfg.camera.cx, cfg.camera.cy = K.cx, K.cy
    cfg.pipeline.mode = "sequential"
    cfg.control.enabled = False
    cfg.viz.backend = "none"
    cfg.profiling.enabled = False
    cfg.fusion.max_vram_gb = 1.0
    cfg.export.output_dir = str(tmp_path / "sessions")
    cfg.export.formats = ["ply", "glb"]
    cfg.session_name = "pytest"
    return cfg


@pytest.fixture(scope="module")
def e2e(tmp_path_factory):
    """Run the pipeline once; several tests assert on the same result."""
    from dronemap.app import DroneMapApp

    tmp_path = tmp_path_factory.mktemp("e2e")
    frames = 90
    seq = build_sequence("orbit", n_frames=frames, width=640, height=360, seed=0)
    img_dir, depths = render_to_folder(seq, tmp_path)

    cfg = _configure(tmp_path, img_dir, seq, frames)
    app = DroneMapApp(cfg)

    original = app._on_start

    def patched():
        original()
        app.depth = GroundTruthDepth(depths)
        app.local_mapper.depth = app.depth
        app.vo.depth_fn = app.depth.predict

    app.lifecycle._start_hooks = [patched]
    manifest = app.run()
    return app, seq, manifest, tmp_path


def test_pipeline_produces_keyframes_and_landmarks(e2e):
    app, _seq, _m, _p = e2e
    assert app.map.n_keyframes >= 10
    assert app.map.n_points > 500


def test_trajectory_is_accurate(e2e):
    app, seq, _m, _p = e2e
    kfs = app.map.all_keyframes()
    est = [kf.T_wc for kf in kfs]
    gt = [seq.poses[kf.frame_index] for kf in kfs if kf.frame_index < len(seq.poses)]
    m = trajectory_metrics(est, gt)
    assert m["drift_pct_of_path"] < 6.0, m
    # Ground-truth depth means the map should already be metric; a scale error
    # here indicates the depth/landmark alignment feedback loop has regressed.
    assert abs(1.0 - m["implied_scale"]) < 0.10, m


def test_reconstruction_matches_observed_surface(e2e):
    app, seq, _m, _p = e2e
    recon = app.final_cloud[0]
    assert len(recon) > 5000
    kfs = app.map.all_keyframes()
    T0 = seq.poses[kfs[0].frame_index]
    world = recon @ T0[:3, :3].T + T0[:3, 3]
    metrics = reconstruction_metrics(world, observed_surface(seq))
    assert metrics["accuracy_median_cm"] < 12.0, metrics
    # Back to 70 (measured 94.45): relocalization now recovers the tracking
    # losses in this sequence, so the confidence gate's honest holes get
    # filled by correctly re-anchored keyframes instead of staying empty
    # (50%) or being filled by dead-reckoned garbage (the rejected
    # alternative). The reloc plausibility gates (translation from the loss
    # point + rotation against the motion prediction) are what make this
    # safe in a self-similar scene -- without them this same number was 84%
    # complete but 16.5% drift, i.e. confidently wrong.
    assert metrics["completeness_pct_within_20cm"] > 70.0, metrics


def test_no_phantom_geometry_outside_the_room(e2e):
    """Nothing should be fused beyond the walls of the closed synthetic room.

    This guards a specific regression: treating unobserved voxels as free space
    makes marching cubes generate a complete phantom shell one truncation
    distance behind every real surface. When that bug was live it accounted for
    ~37% of all vertices.

    The margin has to allow for trajectory error as well, because a slightly
    drifted pose puts genuine surface slightly outside the true walls -- that is
    a tracking measurement, not a fusion artifact, and it is asserted separately
    in `test_trajectory_is_accurate`.
    """
    app, seq, _m, _p = e2e
    recon = app.final_cloud[0]
    kfs = app.map.all_keyframes()
    T0 = seq.poses[kfs[0].frame_index]
    world = recon @ T0[:3, :3].T + T0[:3, 3]

    est = [kf.T_wc for kf in kfs]
    gt = [seq.poses[kf.frame_index] for kf in kfs if kf.frame_index < len(seq.poses)]
    ate = trajectory_metrics(est, gt)["ate_rmse_m"]

    lo, hi = seq.scene.room
    margin = 0.30 + 2.0 * ate
    outside = ((world < lo - margin) | (world > hi + margin)).any(axis=1)
    assert outside.mean() < 0.02, (
        f"{outside.mean():.1%} of points lie more than {margin:.2f} m outside the "
        f"room (ATE {ate:.3f} m) -- suggests phantom geometry, not drift"
    )


def test_export_writes_all_requested_formats(e2e):
    app, _seq, manifest, _p = e2e
    from pathlib import Path

    assert manifest, "export manifest is empty"
    files = manifest["files"]
    for key in ("ply", "glb", "pointcloud", "trajectory", "config"):
        assert key in files, f"missing {key} in {list(files)}"
        assert Path(files[key]).exists()
        assert Path(files[key]).stat().st_size > 0


def test_exported_mesh_loads_and_is_sane(e2e):
    import trimesh

    _app, _seq, manifest, _p = e2e
    mesh = trimesh.load(manifest["files"]["ply"])
    assert len(mesh.vertices) > 1000
    assert len(mesh.faces) > 1000
    # Welding must leave no duplicate vertices behind.
    unique = np.unique(np.round(np.asarray(mesh.vertices), 5), axis=0)
    assert len(unique) == len(mesh.vertices)


def test_trajectory_file_is_valid_tum(e2e):
    _app, _seq, manifest, _p = e2e
    from pathlib import Path

    lines = [l for l in Path(manifest["files"]["trajectory"]).read_text().splitlines()
             if not l.startswith("#")]
    assert len(lines) >= 10
    for line in lines:
        parts = line.split()
        assert len(parts) == 8, "TUM format is: timestamp tx ty tz qx qy qz qw"
        vals = [float(p) for p in parts]
        q = np.array(vals[4:])
        assert abs(np.linalg.norm(q) - 1.0) < 1e-4, "quaternion must be unit"


def test_session_finished_cleanly(e2e):
    app, _seq, _m, _p = e2e
    assert app.lifecycle.info.state.value in ("finished", "exporting")
    assert not app.lifecycle.info.error
