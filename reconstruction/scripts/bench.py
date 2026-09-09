#!/usr/bin/env python3
"""Per-stage benchmark on this machine. Reports latency percentiles and VRAM.

    python scripts/bench.py                 # all stages
    python scripts/bench.py --stage fusion
"""
import argparse
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dronemap.config import Config                          # noqa: E402
from dronemap.profiling.gpu_monitor import GpuMonitor       # noqa: E402
from dronemap.synthetic import build_sequence               # noqa: E402
from dronemap.types import CameraIntrinsics, Frame          # noqa: E402


def _report(name: str, times: list[float], extra: str = "") -> None:
    a = np.array(times) * 1000
    print(f"  {name:<22} n={len(a):4d}  mean {a.mean():7.2f}  p50 {np.percentile(a, 50):7.2f}"
          f"  p95 {np.percentile(a, 95):7.2f} ms   {extra}")


def bench_tracking(cfg, seq, n):
    from dronemap.tracking.frontend import VisualOdometry
    from dronemap.tracking.mapdb import SceneMap

    depths = {}
    smap = SceneMap()
    vo = VisualOdometry(cfg, seq.intrinsics, smap,
                        lambda img, k, i=None: depths[i if i is not None else 0])
    times = []
    for i, (idx, rgb, depth, T) in enumerate(seq.iter_frames()):
        if i >= n:
            break
        depths[i] = depth
        f = Frame(index=i, timestamp=i / 30.0, image=rgb, intrinsics=seq.intrinsics)
        t0 = time.perf_counter()
        r = vo.process(f)
        times.append(time.perf_counter() - t0)
        if i % 5 == 0 and i:
            vo.register_keyframe_points(i // 5, depth, rgb, r.T_wc)
    _report("tracking (VO)", times, f"{seq.intrinsics.width}x{seq.intrinsics.height}")


def bench_depth(cfg, seq, n):
    from dronemap.depth.base import build_depth_estimator

    try:
        est = build_depth_estimator(cfg)
    except Exception as exc:  # noqa: BLE001
        print(f"  depth: unavailable ({exc})")
        return
    est.warmup()
    times = []
    for i, (idx, rgb, depth, T) in enumerate(seq.iter_frames()):
        if i >= n:
            break
        t0 = time.perf_counter()
        est.predict(rgb, seq.intrinsics, i)
        times.append(time.perf_counter() - t0)
    _report("depth network", times, f"input {cfg.depth.input_size}, fp16={cfg.depth.fp16}")
    est.close()


def bench_fusion(cfg, seq, n):
    from dronemap.fusion.base import build_mapper

    mapper = build_mapper(cfg)
    times = []
    for i, (idx, rgb, depth, T) in enumerate(seq.iter_frames()):
        if i >= n:
            break
        wm = mapper.weight_map_for(depth, seq.intrinsics)
        t0 = time.perf_counter()
        mapper.integrate(depth, rgb, T, seq.intrinsics, wm)
        times.append(time.perf_counter() - t0)
    _report("TSDF integrate", times,
            f"voxel {cfg.fusion.voxel_size_m} m, {mapper.stats.blocks_allocated} blocks")

    t0 = time.perf_counter()
    xyz, _ = mapper.extract_point_cloud(min_weight=cfg.fusion.min_extract_weight)
    t_pts = time.perf_counter() - t0
    t0 = time.perf_counter()
    v, f, _ = mapper.extract_mesh(min_weight=cfg.fusion.min_extract_weight)
    t_mesh = time.perf_counter() - t0
    print(f"  extract points         {t_pts * 1000:7.1f} ms   {len(xyz)} points")
    print(f"  extract mesh           {t_mesh * 1000:7.1f} ms   {len(v)} verts / {len(f)} faces")
    mapper.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=int, default=60)
    ap.add_argument("--width", type=int, default=960)
    ap.add_argument("--height", type=int, default=540)
    ap.add_argument("--stage", choices=["all", "tracking", "depth", "fusion"], default="all")
    ap.add_argument("--voxel", type=float, default=0.04)
    args = ap.parse_args()

    cfg = Config()
    cfg.fusion.voxel_size_m = args.voxel
    cfg.fusion.max_vram_gb = 1.5
    cfg.camera.width, cfg.camera.height = args.width, args.height

    gpu = GpuMonitor()
    before = gpu.sample()
    print(f"\nbenchmark: {args.frames} frames at {args.width}x{args.height}")
    if before:
        print(f"GPU: {before.used_mb:.0f}/{before.total_mb:.0f} MB used before start\n")

    seq = build_sequence("orbit", n_frames=args.frames, width=args.width,
                         height=args.height, seed=0)
    print("rendering...", flush=True)
    seq.render_all()
    print()

    if args.stage in ("all", "tracking"):
        bench_tracking(cfg, seq, args.frames)
    if args.stage in ("all", "depth"):
        bench_depth(cfg, seq, min(args.frames, 30))
    if args.stage in ("all", "fusion"):
        bench_fusion(cfg, seq, args.frames)

    after = gpu.sample()
    if after and before:
        print(f"\nGPU: {after.used_mb:.0f}/{after.total_mb:.0f} MB used "
              f"(+{after.used_mb - before.used_mb:.0f} MB), "
              f"peak {gpu.peak_used_mb:.0f} MB, {after.power_w:.0f}/{after.power_limit_w:.0f} W")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
