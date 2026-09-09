#!/usr/bin/env python3
"""Render a synthetic sequence with ground truth, for testing and benchmarking.

    python scripts/make_synthetic.py --frames 200 --out data/synthetic

Writes PNG frames, ground-truth poses in TUM format, and a ground-truth surface
point cloud, so any pipeline can be graded against it -- not just this one.
"""
import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dronemap.export.pointcloud import write_ply          # noqa: E402
from dronemap.export.session import _mat_to_quat           # noqa: E402
from dronemap.selftest import render_to_folder             # noqa: E402
from dronemap.synthetic import build_sequence              # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--frames", type=int, default=150)
    ap.add_argument("--trajectory", choices=["orbit", "forward"], default="orbit")
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--height", type=int, default=360)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default="data/synthetic")
    ap.add_argument("--save-depth", action="store_true",
                    help="also write ground-truth depth as 16-bit millimetres")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    print(f"rendering {args.frames} frames ({args.trajectory}, "
          f"{args.width}x{args.height}, seed {args.seed})")
    seq = build_sequence(args.trajectory, n_frames=args.frames, width=args.width,
                         height=args.height, seed=args.seed)
    img_dir, depths = render_to_folder(seq, out)

    lines = ["# timestamp tx ty tz qx qy qz qw"]
    for i, T in enumerate(seq.poses):
        t = T[:3, 3]
        q = _mat_to_quat(T[:3, :3])
        lines.append(f"{i / 30.0:.6f} {t[0]:.6f} {t[1]:.6f} {t[2]:.6f} "
                     f"{q[0]:.6f} {q[1]:.6f} {q[2]:.6f} {q[3]:.6f}")
    (out / "groundtruth_tum.txt").write_text("\n".join(lines) + "\n")

    surface = seq.scene.sample_surface(n_per_face=6000, seed=args.seed)
    write_ply(out / "groundtruth_surface.ply", surface.astype(np.float32))

    if args.save_depth:
        d = out / "depth"
        d.mkdir(exist_ok=True)
        for i, depth in depths.items():
            np.save(d / f"frame_{i:05d}.npy",
                    (np.clip(depth, 0, 65.5) * 1000).astype(np.uint16))

    K = seq.intrinsics
    (out / "intrinsics.txt").write_text(
        f"fx {K.fx}\nfy {K.fy}\ncx {K.cx}\ncy {K.cy}\n"
        f"width {K.width}\nheight {K.height}\n")

    print(f"\nwrote to {out}:")
    print(f"  frames/                  {args.frames} PNGs")
    print(f"  groundtruth_tum.txt      {len(seq.poses)} poses")
    print(f"  groundtruth_surface.ply  {len(surface)} points")
    print(f"  intrinsics.txt")
    print(f"\nrun it:  dronemap run -c configs/replay.yaml --uri {img_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
