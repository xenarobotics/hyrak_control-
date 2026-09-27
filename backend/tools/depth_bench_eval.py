"""Score monocular metric-depth models against Gazebo's TRUE depth.

    cd backend && .venv/bin/python tools/depth_bench_eval.py [frames_dir] [--models a,b,...]

Frames come from simulation/depth_bench.sh (RGB 1080p @ 69 deg + true depth
640x480 @ 73 deg, same mount). Each frame is scored three times: the full
image and two centre crops that emulate NARROWER LENSES at the same output
resolution - the case where a model that only knows its training camera
gets every distance wrong by the focal ratio. The true depth is projected
into each image through both cameras' intrinsics (same optical centre).

Per model and lens, scored where the truth is 0.5-18.5 m:
  raw AbsRel / scale   straight model output (scale = median pred/true;
                       1.00 is right, 0.2 means 5x too near)
  shape AbsRel         after a per-frame scale fix: how right the SHAPE is
  calib AbsRel / drift ONE scale fitted on the full-lens frames (what a
                       single calibration gives), applied to every lens:
                       drift 1.00 means that calibration still holds after a
                       lens change; 0.7 means distances now 30 % short
  ms                   per frame on this machine
AbsRel = mean |pred - true| / true (lower is better).

The Gazebo scene is flat-shaded and untextured: absolute accuracy here
understates what real footage gives the best models. Lens behaviour and
relative ranking are what this measures.
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import sys
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.vision import depth_models  # noqa: E402

RGB_HFOV = math.degrees(1.204)
DEPTH_HFOV = math.degrees(1.274)
OUT_W, OUT_H = 640, 360
CROPS = {"full 69 deg": 1.0, "crop 52 deg": 0.7, "crop 37 deg": 0.5}
DEFAULT_MODELS = [
    "depth-anything/Depth-Anything-V2-Metric-Outdoor-Small-hf",
    "depth-anything/Depth-Anything-V2-Metric-Outdoor-Small-hf+fov",
    "depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf",
    "depth-anything/DA3METRIC-LARGE",
]


def crop_hfov(frac: float) -> float:
    return math.degrees(2 * math.atan(frac * math.tan(math.radians(RGB_HFOV) / 2)))


def gt_for(depth: np.ndarray, hfov: float) -> np.ndarray:
    """True depth sampled on the OUT_W x OUT_H grid of an image with this hfov."""
    f_img = depth_models.focal_px(OUT_W, hfov)
    dh, dw = depth.shape
    f_d = depth_models.focal_px(dw, DEPTH_HFOV)
    u = (np.arange(OUT_W) + 0.5 - OUT_W / 2) / f_img
    v = (np.arange(OUT_H) + 0.5 - OUT_H / 2) / f_img
    U, V = np.meshgrid(u, v)
    ud = np.round(dw / 2 + U * f_d - 0.5).astype(int)
    vd = np.round(dh / 2 + V * f_d - 0.5).astype(int)
    ok = (ud >= 0) & (ud < dw) & (vd >= 0) & (vd < dh)
    g = np.full((OUT_H, OUT_W), np.nan, np.float32)
    g[ok] = depth[vd[ok], ud[ok]]
    g[~np.isfinite(g) | (g < 0.5) | (g > 18.5)] = np.nan
    return g


def crop(rgb: np.ndarray, frac: float) -> np.ndarray:
    h, w = rgb.shape[:2]
    ch, cw = int(round(h * frac)), int(round(w * frac))
    y0, x0 = (h - ch) // 2, (w - cw) // 2
    return cv2.resize(rgb[y0:y0 + ch, x0:x0 + cw], (OUT_W, OUT_H), interpolation=cv2.INTER_AREA)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("frames", nargs="?", default=str(Path(__file__).resolve().parents[1] / ".data/depth_bench/frames"))
    ap.add_argument("--models", default=",".join(DEFAULT_MODELS))
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--json", default="")
    a = ap.parse_args()
    files = sorted(glob.glob(str(Path(a.frames) / "*.npz")))
    if a.limit:
        files = files[:a.limit]
    if not files:
        print(f"no frames in {a.frames} - run simulation/depth_bench.sh first")
        return 1
    import torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
    frames = [np.load(f) for f in files]
    results = {}
    for spec in a.models.split(","):
        name, fov = (spec[:-4], True) if spec.endswith("+fov") else (spec, False)
        try:
            model = depth_models.load(name, device, fov_correct=fov)
        except Exception as e:
            print(f"{spec}: could not load ({e})")
            continue
        per = {}
        for label, frac in CROPS.items():
            hfov = crop_hfov(frac)
            rel, d1, ratio, ms, shape, raw = [], [], [], [], [], []
            for fr in frames:
                bgr = cv2.cvtColor(crop(fr["rgb"], frac), cv2.COLOR_RGB2BGR)
                g = gt_for(fr["depth"], hfov)
                t0 = time.perf_counter()
                p = model.predict(bgr, hfov)
                if device == "cuda":
                    torch.cuda.synchronize()
                ms.append((time.perf_counter() - t0) * 1000)
                p = cv2.resize(p, (OUT_W, OUT_H), interpolation=cv2.INTER_LINEAR)
                m = np.isfinite(g) & np.isfinite(p) & (p > 0)
                if m.sum() < 200:
                    continue
                r = p[m] / g[m]
                rel.append(float(np.mean(np.abs(p[m] - g[m]) / g[m])))
                d1.append(float(np.mean(np.maximum(r, 1 / r) < 1.25)))
                ratio.append(float(np.median(r)))
                shape.append(float(np.mean(np.abs(p[m] / np.median(r) - g[m]) / g[m])))
                raw.append((p[m], g[m]))
            per[label] = {"absrel": float(np.mean(rel)), "d1": float(np.mean(d1)),
                          "scale": float(np.median(ratio)), "shape": float(np.mean(shape)),
                          "ms": float(np.median(ms[3:] or ms)), "frames": len(rel), "_raw": raw}
        # One calibration, fitted on the full-lens frames, used for every lens.
        s0 = per["full 69 deg"]["scale"]
        for label, r in per.items():
            pairs = r.pop("_raw")
            r["calib_absrel"] = float(np.mean([np.mean(np.abs(p / s0 - g) / g) for p, g in pairs]))
            r["drift"] = r["scale"] / s0
        results[spec] = per
        del model
        if device == "cuda":
            torch.cuda.empty_cache()

    print(f"\n{len(frames)} frames, truth 0.5-18.5 m\n")
    print(f"{'model':48s} {'lens':12s} {'raw':>6s} {'scale':>6s} {'shape':>6s} {'calib':>6s} {'drift':>6s} {'ms':>5s}")
    for spec, per in results.items():
        for label, r in per.items():
            print(f"{spec.split('/')[-1][:48]:48s} {label:12s} {r['absrel']:6.3f} {r['scale']:6.2f} "
                  f"{r['shape']:6.3f} {r['calib_absrel']:6.3f} {r['drift']:6.2f} {r['ms']:5.0f}")
    if a.json:
        Path(a.json).write_text(json.dumps(results, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
