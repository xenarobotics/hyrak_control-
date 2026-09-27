# Monocular depth: models, lenses, calibration

How HYRAK gets distance from one ordinary camera, what was measured, and how
to set it up. Code: `backend/app/vision/depth_models.py`,
`backend/app/avoidance/sensing/{camera,mono_calibration,person_ruler}.py`.

## What runs

| | |
|---|---|
| Default model | **Depth Anything 3 metric** (`depth-anything/DA3METRIC-LARGE`, ByteDance 2025) |
| Fallback | Depth Anything V2 metric outdoor small (loaded automatically if DA3 is missing) |
| Setting | `DEPTH_MODEL` in `backend/.env` (any id `depth_models.load` understands) |

DA3's output is canonical: `metres = focal_px * output / 300`, focal from the
camera's horizontal FOV (Settings -> camera calibration). V2 metric has no
lens input: it assumes the camera it was trained on.

## Where the metres come from

The model's own scale is **not** trusted on its own - the benchmark below
shows every model's scale wanders from scene to scene. A ruler sets it:

1. **In flight: the ground.** The aircraft's altitude (from the flight
   controller) is a free ruler: the ground plane in each frame is fitted to
   it (`mono_calibration`). A frame with no usable ground fit yields no
   obstacles - this is what stopped the SITL phantoms, and nothing below
   overrides it.
2. **On a bench / any fixed camera: a person.** Command -> video menu ->
   *Camera distance calibration*: type the person's height, stand 3-8 m away
   with the whole body in view, tap CALIBRATE. ~2 s of frames (YOLO person
   box vs the depth model) give one scale per frame; the run is accepted only
   if they agree within 12 % and is stored per camera profile (frame size +
   FOV + model) in `backend/.data/depth_scale.json`. Bench mode multiplies
   the model's metres by it; in flight it only seeds the ground fit.

Accuracy of the person ruler is the height: 1.70 m for an unknown adult is
about +-6 %; the real height removes most of that.

## Benchmark (2026-09-27)

`simulation/depth_bench.sh` captures RGB + TRUE depth from the Gazebo OAK-D
Lite on a private gz server (160 frames, 3-15 m from the 28 obstacles, 2/5/10
m up). `backend/tools/depth_bench_eval.py` scores each model on the full
lens (69 deg) and two centre crops that emulate narrower lenses (52, 37 deg).

Laptop RTX 4070, 640x360 input, truth 0.5-18.5 m:

| model | shape AbsRel (69 / 52 / 37 deg) | raw scale (69 deg) | lens drift 52 / 37 deg | ms |
|---|---|---|---|---|
| V2 metric outdoor small (previous default) | 0.161 / 0.140 / 0.107 | 0.73 | 0.94 / 0.85 | 19 |
| V2 outdoor + FOV correction | 0.161 / 0.140 / 0.107 | 0.90 | 1.34 / 1.70 | 19 |
| V2 metric indoor small | 0.099 / 0.090 / 0.085 | 0.23 | 0.85 / 0.68 | 18 |
| **DA3 metric large** | **0.105 / 0.092 / 0.075** | 0.19 | 1.16 / 1.52 | 54 |

- *shape AbsRel*: error after a per-frame scale fix - how right the scene
  geometry is; this is what the ground/person ruler turns into metres.
- *raw scale*: median model/true without any ruler (1.00 = right).
- *lens drift*: how a scale calibrated at 69 deg holds on a narrower lens.

Reading it honestly:
- DA3 has about 35 % less shape error than the old default; V2 indoor is as
  good on this set but was trained on indoor scenes only, so DA3 is the
  default for real outdoor footage.
- Raw metric scale is poor for every model **here**: the Gazebo world is
  flat-shaded and untextured, and models read it as a small scene. Real
  footage is expected to do better, but nothing here proves it - hence the
  rulers.
- A single stored scale does not hold across these frames for any model
  (per-scene scale wander), which is why flight re-measures every frame and
  the person ruler is one tap to redo.
- DA3's focal formula over-corrects on narrow crops of this set (the network
  partly adapts to the lens by itself). Re-calibrate after a lens change.

Re-run after changing models: capture once, then
`cd backend && .venv/bin/python tools/depth_bench_eval.py --models a,b,...`
(append `+fov` to a V2 id to test the first-order lens correction).

## Installing Depth Anything 3

DA3's package pulls in heavy extras (xformers would re-pin torch, open3d,
pycolmap, ...). The backend imports only its model code instead:

```bash
mkdir -p ~/ext && cd ~/ext
git clone --depth 1 https://github.com/ByteDance-Seed/depth-anything-3
uv pip install --python ~/hyrak_control/backend/.venv/bin/python \
    --target ~/ext/da3-deps --no-deps einops omegaconf antlr4-python3-runtime==4.9.3 addict
```

Paths can be moved with `DA3_SRC` / `DA3_DEPS`. Weights (~1.3 GB) download
from Hugging Face on first use. DA3's export and multi-view pose-alignment
modules are stubbed in `depth_models._import_da3` (single-frame depth never
uses them). If the import fails the backend logs it and runs V2.
