"""Record a short clip and photogrammetry it: COLMAP sparse SfM + point export.

Usage:
    python scripts/photoscan.py --device /dev/video5 --seconds 60
    python scripts/photoscan.py --video some_clip.mp4

Records (or takes) footage, extracts frames, drops the blurred and dark ones,
runs COLMAP (feature extraction, sequential matching, incremental mapping),
and reports how much of the footage actually connected into a model — which is
the honest measure of whether the capture was good enough to reconstruct.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np


def record(device: str, seconds: int, out: Path) -> Path:
    clip = out / "footage.mp4"
    print(f"recording {seconds}s from {device} — MOVE THE CAMERA: slow arcs, "
          "keep pointing at textured surfaces", flush=True)
    cmd = ["ffmpeg", "-f", "v4l2", "-input_format", "mjpeg",
           "-video_size", "1920x1080", "-i", device,
           "-t", str(seconds), "-c:v", "copy", "-y", str(clip),
           "-loglevel", "error"]
    subprocess.run(cmd, check=True)
    print(f"recorded {clip} ({clip.stat().st_size/1e6:.0f} MB)")
    return clip


def extract_frames(video: Path, out: Path, fps: float = 4.0,
                   min_brightness: float = 25.0, min_sharpness: float = 40.0) -> int:
    imgdir = out / "images"
    if imgdir.exists():
        shutil.rmtree(imgdir)
    imgdir.mkdir(parents=True)
    cap = cv2.VideoCapture(str(video))
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, round(src_fps / fps))
    i = kept = dark = blurred = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if i % step == 0:
            g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            if g.mean() < min_brightness:
                dark += 1
            elif cv2.Laplacian(g, cv2.CV_64F).var() < min_sharpness:
                blurred += 1
            else:
                cv2.imwrite(str(imgdir / f"f{kept:05d}.jpg"), frame,
                            [cv2.IMWRITE_JPEG_QUALITY, 95])
                kept += 1
        i += 1
    cap.release()
    print(f"frames: {kept} kept, {blurred} rejected for blur, {dark} for darkness")
    if blurred > kept:
        print("  !! most frames were motion-blurred — move slower or add light")
    return kept


def run_sfm(out: Path) -> None:
    import pycolmap

    db, imgs, sparse = out / "database.db", out / "images", out / "sparse"
    db.unlink(missing_ok=True)
    if sparse.exists():
        shutil.rmtree(sparse)
    sparse.mkdir()
    t0 = time.time()
    ropt = pycolmap.ImageReaderOptions(camera_model="SIMPLE_RADIAL")
    pycolmap.extract_features(db, imgs, camera_mode=pycolmap.CameraMode.SINGLE,
                              reader_options=ropt)
    pycolmap.match_sequential(db)
    print(f"features + matching: {time.time()-t0:.0f}s", flush=True)
    recs = pycolmap.incremental_mapping(db, imgs, sparse)
    n_images = len(list(imgs.iterdir()))
    print(f"mapping: {time.time()-t0:.0f}s total")
    if not recs:
        print("RESULT: nothing reconstructed — the views did not connect at all")
        return
    best = max(recs.values(), key=lambda r: r.num_reg_images())
    for i, rec in sorted(recs.items()):
        marker = " <- largest" if rec is best else ""
        print(f"  model {i}: {rec.num_reg_images()}/{n_images} images, "
              f"{rec.num_points3D()} points{marker}")
    frac = best.num_reg_images() / max(n_images, 1)
    ply = out / "sparse_points.ply"
    best.export_PLY(ply)
    print(f"sparse cloud: {ply}")
    if len(recs) == 1 and frac > 0.8:
        print(f"RESULT: GOOD — one connected model covering {frac:.0%} of frames")
    elif frac > 0.5:
        print(f"RESULT: PARTIAL — largest model covers {frac:.0%}; "
              "gaps mean the camera moved too fast somewhere")
    else:
        print(f"RESULT: FRAGMENTED — best model only {frac:.0%}; "
              "the footage lacks overlap, texture, or sharpness")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="/dev/video5")
    ap.add_argument("--seconds", type=int, default=60)
    ap.add_argument("--video", help="use an existing clip instead of recording")
    ap.add_argument("--out", default="data/photogrammetry/scan")
    ap.add_argument("--fps", type=float, default=4.0, help="frames per second to keep")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    video = Path(args.video) if args.video else record(args.device, args.seconds, out)
    if extract_frames(video, out, fps=args.fps) < 10:
        print("too few usable frames; nothing to reconstruct", file=sys.stderr)
        return 1
    run_sfm(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
