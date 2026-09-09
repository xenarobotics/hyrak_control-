"""End-to-end self-test against a synthetic scene with exact ground truth.

Runs the real pipeline -- real ingest, real tracker, real fusion, real export --
over a rendered sequence whose poses and geometry are known exactly, then grades
the result:

* **ATE** -- absolute trajectory error after rigid alignment (the map's world
  frame is anchored to the first camera, which is an arbitrary choice, so the
  trajectories must be aligned before comparison).
* **RPE** -- relative pose error between consecutive keyframes: measures local
  drift rate independent of any global alignment.
* **accuracy / completeness** -- reconstruction against the surface the camera
  actually observed. Grading against the full scene would score unseen geometry
  as missing, which says nothing about pipeline quality.

Because it needs no dataset and no network, this is the regression test that can
run anywhere.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Optional

import numpy as np

from .config import Config
from .types import CameraIntrinsics, se3_inv, so3_log

log = logging.getLogger(__name__)


class GroundTruthDepth:
    """Depth estimator that returns the renderer's exact depth.

    Substituting this isolates tracking and fusion from monocular depth error,
    which is what you want when deciding whether a regression is in the geometry
    pipeline or in the network.
    """

    metric = True

    def __init__(self, depths: dict[int, np.ndarray]) -> None:
        self._depths = depths
        self._order = sorted(depths)
        self.misses = 0

    def predict(self, image: np.ndarray, intrinsics=None,
                frame_index: Optional[int] = None) -> np.ndarray:
        # Addressed by frame index, never by call order. Keyframes are selected
        # dynamically, so the n-th call is not the n-th frame -- returning
        # depth by call count silently pairs each image with another frame's
        # geometry, which looks exactly like severe tracking drift.
        if frame_index is not None and frame_index in self._depths:
            return self._depths[frame_index]
        self.misses += 1
        return self._depths[self._order[0]]

    def warmup(self) -> None:
        pass

    def close(self) -> None:
        pass

    @property
    def vram_mb(self) -> float:
        return 0.0


def align_trajectories(est: np.ndarray, gt: np.ndarray) -> tuple[np.ndarray, dict]:
    """Umeyama rigid alignment (no scaling) of estimated onto ground-truth positions.

    Scale is deliberately *not* fitted: the whole point of metric anchoring is
    that the map should already be at true scale, so absorbing a scale error into
    the alignment would hide exactly the failure this test exists to catch. The
    scale that *would* have been needed is reported separately.
    """
    mu_e, mu_g = est.mean(axis=0), gt.mean(axis=0)
    e, g = est - mu_e, gt - mu_g
    H = e.T @ g / len(est)
    U, S, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    R = Vt.T @ np.diag([1.0, 1.0, d]) @ U.T
    t = mu_g - R @ mu_e
    aligned = est @ R.T + t
    var_e = float((e**2).sum() / len(est))
    implied_scale = float((S * np.array([1, 1, d])).sum() / var_e) if var_e > 1e-12 else 1.0
    return aligned, {"implied_scale": implied_scale}


def trajectory_metrics(est_poses: list[np.ndarray], gt_poses: list[np.ndarray]) -> dict:
    n = min(len(est_poses), len(gt_poses))
    if n < 3:
        return {"error": "too few poses to evaluate"}
    est_t = np.array([T[:3, 3] for T in est_poses[:n]])
    gt_t = np.array([T[:3, 3] for T in gt_poses[:n]])

    aligned, info = align_trajectories(est_t, gt_t)
    err = np.linalg.norm(aligned - gt_t, axis=1)
    path_len = float(np.linalg.norm(np.diff(gt_t, axis=0), axis=1).sum())

    # RPE over consecutive pairs.
    rpe_t, rpe_r = [], []
    for i in range(n - 1):
        rel_e = se3_inv(est_poses[i]) @ est_poses[i + 1]
        rel_g = se3_inv(gt_poses[i]) @ gt_poses[i + 1]
        delta = se3_inv(rel_g) @ rel_e
        rpe_t.append(float(np.linalg.norm(delta[:3, 3])))
        rpe_r.append(float(np.degrees(np.linalg.norm(so3_log(delta[:3, :3])))))

    return {
        "n_poses": n,
        "path_length_m": round(path_len, 3),
        "ate_rmse_m": round(float(np.sqrt((err**2).mean())), 4),
        "ate_mean_m": round(float(err.mean()), 4),
        "ate_max_m": round(float(err.max()), 4),
        "drift_pct_of_path": round(100 * float(err.max()) / max(path_len, 1e-9), 3),
        "rpe_trans_median_m": round(float(np.median(rpe_t)), 5),
        "rpe_rot_median_deg": round(float(np.median(rpe_r)), 4),
        "implied_scale": round(info["implied_scale"], 4),
    }


def reconstruction_metrics(recon: np.ndarray, observed: np.ndarray) -> dict:
    from scipy.spatial import cKDTree

    if len(recon) == 0 or len(observed) == 0:
        return {"error": "empty reconstruction or reference"}
    acc, _ = cKDTree(observed).query(recon)
    comp, _ = cKDTree(recon).query(observed)
    return {
        "n_points": int(len(recon)),
        "accuracy_median_cm": round(float(np.median(acc)) * 100, 3),
        "accuracy_p95_cm": round(float(np.percentile(acc, 95)) * 100, 3),
        "completeness_median_cm": round(float(np.median(comp)) * 100, 3),
        "completeness_pct_within_10cm": round(float((comp < 0.10).mean()) * 100, 2),
        "completeness_pct_within_20cm": round(float((comp < 0.20).mean()) * 100, 2),
    }


def render_to_folder(seq, out_dir: Path) -> tuple[Path, dict[int, np.ndarray]]:
    """Render the sequence to PNGs so the real folder ingest path is exercised."""
    import cv2

    img_dir = out_dir / "frames"
    img_dir.mkdir(parents=True, exist_ok=True)
    depths: dict[int, np.ndarray] = {}
    t0 = time.perf_counter()
    for i, rgb, depth, _T in seq.iter_frames():
        cv2.imwrite(str(img_dir / f"frame_{i:05d}.png"),
                    cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
        depths[i] = depth
    log.info("rendered %d frames in %.1fs -> %s", len(depths),
             time.perf_counter() - t0, img_dir)
    return img_dir, depths


def observed_surface(seq, stride: int = 4, sample: float = 0.15) -> np.ndarray:
    """Back-project ground-truth depth from every pose: the observable surface."""
    K = seq.intrinsics
    u, v = np.meshgrid(np.arange(K.width), np.arange(K.height))
    pts = []
    rng = np.random.default_rng(0)
    for i, (_i, _rgb, depth, T) in enumerate(seq.iter_frames()):
        if i % stride or depth is None:
            continue
        m = (depth > 0.3) & (depth < 30.0) & (rng.random(depth.shape) < sample)
        if not m.any():
            continue
        z = depth[m]
        cam = np.stack([(u[m] - K.cx) / K.fx * z, (v[m] - K.cy) / K.fy * z, z], axis=1)
        pts.append(cam @ T[:3, :3].T + T[:3, 3])
    return np.concatenate(pts) if pts else np.zeros((0, 3))


def run_selftest(cfg: Config, args) -> int:
    from .app import DroneMapApp
    from .synthetic import build_sequence

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    log.info("building synthetic sequence (%s, %d frames, %dx%d)",
             args.trajectory, args.frames, args.width, args.height)
    seq = build_sequence(args.trajectory, n_frames=args.frames,
                         width=args.width, height=args.height, seed=cfg.seed)
    img_dir, depths = render_to_folder(seq, out)

    # Point the pipeline at the rendered frames through the real ingest path.
    cfg.source.kind = "folder"
    cfg.source.uri = str(img_dir)
    cfg.source.track_width = args.width
    cfg.source.track_height = args.height
    cfg.source.realtime_replay = False
    cfg.source.retain_full_res = False
    cfg.camera.width = args.width
    cfg.camera.height = args.height
    K = seq.intrinsics
    cfg.camera.fx, cfg.camera.fy = K.fx, K.fy
    cfg.camera.cx, cfg.camera.cy = K.cx, K.cy
    cfg.control.enabled = False
    # Deterministic: the grade must reflect the algorithms, not this machine's
    # thread scheduling.
    cfg.pipeline.mode = "sequential"
    cfg.session_name = "selftest"
    cfg.export.output_dir = str(out / "sessions")
    cfg.export.save_trajectory = True
    if getattr(args, "no_viz", False):
        cfg.viz.backend = "none"

    app = DroneMapApp(cfg)
    if args.gt_depth:
        log.info("using ground-truth depth (isolates tracking + fusion)")
        original_start = app._on_start

        def patched_start() -> None:
            original_start()
            app.depth = GroundTruthDepth(depths)
            app.local_mapper.depth = app.depth
            app.vo.depth_fn = app.depth.predict

        app.lifecycle._start_hooks = [patched_start]

    t0 = time.perf_counter()
    manifest = app.run()
    wall = time.perf_counter() - t0

    # -- grade -------------------------------------------------------------
    keyframes = app.map.all_keyframes()
    est_poses = [kf.T_wc for kf in keyframes]
    gt_poses = [seq.poses[kf.frame_index] for kf in keyframes
                if kf.frame_index < len(seq.poses)]
    traj = trajectory_metrics(est_poses, gt_poses)

    # Captured before teardown; the mapper's GPU buffers are gone by now.
    recon = app.final_cloud[0]

    ref = observed_surface(seq)
    # Reconstruction lives in the map frame (anchored to camera 0); move it into
    # the ground-truth frame before comparing.
    if len(recon):
        T0 = seq.poses[keyframes[0].frame_index] if keyframes else np.eye(4)
        recon_world = recon @ T0[:3, :3].T + T0[:3, 3]
    else:
        recon_world = recon
    rec = reconstruction_metrics(recon_world, ref)

    report = {
        "config": {"frames": args.frames, "trajectory": args.trajectory,
                   "resolution": [args.width, args.height],
                   "gt_depth": bool(args.gt_depth),
                   "voxel_size_m": cfg.fusion.voxel_size_m},
        "wall_seconds": round(wall, 2),
        "throughput_fps": round(args.frames / max(wall, 1e-9), 2),
        "trajectory": traj,
        "reconstruction": rec,
        "metrics": app.metrics(),
        "export": manifest,
    }
    (out / "selftest_report.json").write_text(json.dumps(report, indent=2, default=str))

    _print_report(report)
    ok = _grade(traj, rec, bool(args.gt_depth), cfg.fusion.voxel_size_m)
    print(f"\nfull report: {out / 'selftest_report.json'}")
    return 0 if ok else 1


def _print_report(r: dict) -> None:
    t, rec = r["trajectory"], r["reconstruction"]
    print("\n" + "=" * 68)
    print("  SELFTEST REPORT")
    print("=" * 68)
    print(f"  frames {r['config']['frames']}  in {r['wall_seconds']}s "
          f"({r['throughput_fps']} fps)   gt_depth={r['config']['gt_depth']}")
    m = r["metrics"]
    print(f"  keyframes {m['session']['keyframes']}  landmarks {m['session']['landmarks']}"
          f"  loops {m.get('mapping', {}).get('loops', 0)}"
          f"  dropped {m['queues']['track']['dropped']}")
    print("\n  TRAJECTORY")
    if "error" in t:
        print(f"    {t['error']}")
    else:
        print(f"    path length            {t['path_length_m']} m")
        print(f"    ATE rmse / max         {t['ate_rmse_m']} / {t['ate_max_m']} m")
        print(f"    drift                  {t['drift_pct_of_path']} % of path")
        print(f"    RPE trans / rot        {t['rpe_trans_median_m']} m / "
              f"{t['rpe_rot_median_deg']} deg per keyframe")
        print(f"    implied scale error    {abs(1 - t['implied_scale']) * 100:.2f} %")
    print("\n  RECONSTRUCTION")
    if "error" in rec:
        print(f"    {rec['error']}")
    else:
        print(f"    surface points         {rec['n_points']}")
        print(f"    accuracy med / p95     {rec['accuracy_median_cm']} / "
              f"{rec['accuracy_p95_cm']} cm")
        print(f"    completeness <10/20cm  {rec['completeness_pct_within_10cm']} / "
              f"{rec['completeness_pct_within_20cm']} %")
    g = m.get("gpu", {})
    if g.get("available"):
        print(f"\n  GPU peak {g['peak_used_mb']:.0f} MB of {g['total_mb']:.0f} MB")
    if "fusion" in m:
        f = m["fusion"]
        print(f"  TSDF {f['blocks']} blocks ({f['occupancy'] * 100:.1f}% of budget), "
              f"{f['last_ms']} ms/integration")
    print("=" * 68)


def _grade(traj: dict, rec: dict, gt_depth: bool, voxel_size_m: float = 0.04) -> bool:
    """Pass/fail thresholds.

    The accuracy limit is expressed in **voxels**, not centimetres: a TSDF cannot
    resolve detail finer than its discretisation, so a fixed centimetre budget
    would silently become a test of the voxel size rather than of the pipeline.

    Two different things are being graded depending on the mode:

    * ``--gt-depth`` grades the **pipeline** -- tracking, bundle adjustment, loop
      closure, fusion and export -- with depth error removed. These are strict
      thresholds and a regression here is a real regression.

    * without it, the result is dominated by the monocular depth network, and on
      this synthetic scene that network is far out of its training distribution:
      Depth Anything V2 was trained on photographs, and a procedurally-textured
      box room is not one. Measured scale error on this scene is 27% with the
      outdoor checkpoint and 53% with the indoor one, which says almost nothing
      about the pipeline and everything about the domain gap. So this mode is
      graded only for **liveness** -- did tracking survive, did a map get built --
      and the accuracy numbers are reported as information. Judge monocular
      accuracy on real footage from your own camera, not here.
    """
    if "error" in traj or "error" in rec:
        print("\nFAIL: metrics unavailable")
        return False

    voxel_cm = max(voxel_size_m, 1e-6) * 100
    print()
    if gt_depth:
        checks = [
            ("trajectory drift", traj["drift_pct_of_path"], 3.0, "<="),
            (f"accuracy median ({voxel_cm:.0f}cm voxels)",
             rec["accuracy_median_cm"], 2.0 * voxel_cm, "<="),
            # Back to 75 (measured 86.3): relocalization recovers this
            # sequence's tracking losses -- including one genuine long-blackout
            # recovery 5.4 m from the loss point once the orbit revisits mapped
            # territory -- so the confidence gate's honest holes get refilled
            # with correctly re-anchored keyframes. The reloc plausibility
            # gates matter as much as reloc itself: without the rotation gate
            # this scored 77% complete at 16.9% drift (wrong-wall match,
            # confidently wrong). Softer fusion remains measured-and-rejected.
            ("completeness <20cm", rec["completeness_pct_within_20cm"], 75.0, ">="),
        ]
    else:
        checks = [
            ("tracking survived (drift)", traj["drift_pct_of_path"], 40.0, "<="),
            ("map was built (points)", rec["n_points"], 10000, ">="),
            ("some surface recovered", rec["completeness_pct_within_20cm"], 15.0, ">="),
        ]

    ok = True
    for name, value, limit, op in checks:
        good = value <= limit if op == "<=" else value >= limit
        ok &= good
        print(f"  [{'PASS' if good else 'FAIL'}] {name:<30} {value:>10.2f} {op} {limit}")

    if not gt_depth:
        print("\n  NOTE: monocular mode is graded for liveness only. The depth")
        print("        network is out of domain on synthetic imagery, so the")
        print("        accuracy figures above reflect that, not the pipeline.")
        print("        Run with --gt-depth to grade the pipeline itself.")

    print(f"\n{'SELFTEST PASSED' if ok else 'SELFTEST FAILED'}")
    return ok
