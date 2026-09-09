# Running, profiling and tuning

Everything here was measured on the target machine: **RTX 4070 Laptop GPU, 8 GB
VRAM (~6.9 GB usable after the desktop compositor), 55 W cap, Ubuntu 24.04,
Python 3.12, driver 595 / CUDA 13.2.**

---

## 1. Running

```bash
source .venv/bin/activate
dronemap info                       # verify GPU, NVDEC, and backend availability
```

### Replay a recording

```bash
dronemap run -c configs/replay.yaml --uri flight.mp4
dronemap run --uri /path/to/frames/           # image folder
```

### Live drone stream

```bash
# RTSP (NVDEC hardware decode is automatic when the codec supports it)
dronemap run -c configs/drone_1080p30.yaml --uri rtsp://192.168.1.10:8554/live

# UDP / SRT MPEG-TS, typical of Herelink / SIYI ground units
dronemap run --source udp --uri udp://0.0.0.0:5600

# ZeroMQ, when a companion process already has decoded frames
dronemap run --source zmq --uri tcp://192.168.1.20:5555

# local camera, for a smoke test before the airframe is up
dronemap run --uri /dev/video0
```

### Control the session

```bash
curl localhost:8088/status
curl localhost:8088/metrics | jq .
curl -X POST localhost:8088/export     # export without ending the session
curl -X POST localhost:8088/stop       # graceful stop + automatic export
```

`SIGINT`/`SIGTERM` do the same thing; a second one aborts immediately instead of
waiting for the export.

### Self-test

```bash
dronemap selftest --frames 150 --gt-depth   # isolates tracking + fusion
dronemap selftest --frames 150              # includes monocular depth error
```

Renders a synthetic scene with exact ground truth, runs the real pipeline over
it, and reports ATE/RPE plus reconstruction accuracy and completeness. No
dataset or network access required.

---

## 2. Calibrate the camera first

This matters more than any other setting. Without `fx/fy/cx/cy` the intrinsics
are guessed from `camera.hfov_deg`, and every error there becomes a systematic
distortion of the reconstruction — usually a bowl-shaped floor or a scene that
"breathes" as the camera rotates.

```bash
# OpenCV checkerboard calibration, then point the config at the result
camera:
  calibration_file: calib/drone_1080p.yaml
```

---

## 3. Profiling GPU memory

### Live

```bash
watch -n0.5 nvidia-smi
curl -s localhost:8088/metrics | jq '.gpu, .fusion'
```

`/metrics` reports NVML device totals **and** PyTorch allocator figures:

| field | meaning |
|---|---|
| `gpu.used_mb` / `total_mb` | whole device, including the desktop compositor |
| `gpu.process_mb` | this process only |
| `gpu.peak_used_mb` | high-water mark for the session |
| `gpu.torch_allocated_mb` | tensors actually live |
| `gpu.torch_reserved_mb` | allocator's cached pool (returns as fragmentation, not a leak) |
| `fusion.vram_mb` | TSDF voxel store, fixed at startup |
| `fusion.occupancy` | fraction of the block budget in use |

### Where the memory goes

| component | typical | notes |
|---|---|---|
| Depth Anything V2 Small, FP16 @518² | ~0.7 GB | ~57 MB weights, rest is activations |
| TSDF voxel store | `fusion.max_vram_gb` (default 3.0) | reserved up front, never grows |
| CUDA context + tracker scratch | ~0.8–1.0 GB | |
| Desktop compositor (Xorg + friends) | ~1.2 GB | **not yours** — budget around it |
| **measured peak, default config** | **~5.5–6.1 GB of 8.2 GB** | |

Rerun's viewer is a separate process, so visualisation costs the pipeline
essentially no VRAM.

### If you run out

```bash
--vram 2.0                          # smaller TSDF budget
--set fusion.voxel_size_m=0.06      # coarser voxels: 8x fewer blocks per 2x size
--set depth.input_size=392          # smaller depth network input
--set source.track_width=640 --set source.track_height=360
--no-viz
```

TSDF memory is **3584 bytes per 8³ block**. The default 3 GB budget holds
~900 000 blocks — at 4 cm voxels that is 0.46 billion voxels, far more than a
single flight needs. The budget is a hard ceiling: the allocator refuses to
exceed it and logs an overflow rather than triggering a CUDA OOM mid-flight.

### Finding the real bottleneck

```bash
curl -s localhost:8088/metrics | jq '.thread_stages, .queues'
```

- `queues.track.dropped` climbing → tracking cannot keep up with ingest. Lower
  `source.track_width/height`, or accept the drops (the map is built from
  keyframes, so moderate dropping is harmless).
- `thread_stages.mapper.ms_p95` high → bundle adjustment. **Do not fix this by
  shrinking the BA budget** (see below).
- `keyframe_gate.skipped_backpressure` climbing → the gate wants keyframes faster
  than the mapper can absorb them. That is the mapper applying backpressure, and
  it is working as intended; the cure is fewer *spurious* keyframes, not a
  cheaper mapper. Check `keyframe_gate.reasons`: a run dominated by `track_loss`
  means the input feed is breaking optical flow, not that the camera is moving.
- `thread_stages.fusion.ms_p95` high → increase `fusion.depth_stride` to 2.

On this GPU the measured costs are: tracking ~14 ms/frame at 640×360, depth
~10 ms/keyframe, local BA ~20–45 ms/keyframe, TSDF integration **~1.2–1.5 ms**.
Fusion is nowhere near the bottleneck; bundle adjustment is.

---

## 4. Tuning the keyframe gate

A frame is promoted when **any** trigger fires. All are in `configs/*.yaml`
under `keyframe:`.

| setting | default | raise it to… | lower it to… |
|---|---|---|---|
| `trans_ratio` | 0.15 | fewer keyframes, faster, thinner coverage | denser coverage, more overlap, more compute |
| `rot_deg` | 8.0 | tolerate more rotation between keyframes | capture turns better (matters on a yawing drone) |
| `track_ratio` | 0.65 | promote only on severe feature loss | promote earlier when the view changes |
| `max_interval_s` | 1.0 | fewer keyframes while hovering | keep refreshing a static view |
| `min_interval_s` | 0.05 | hard cap on keyframe rate | allow bursts |

`trans_ratio` is a fraction of **median scene depth**, not an absolute distance.
That is what lets one number work at 2 m indoors and 60 m over a field. The
resulting threshold is clamped to `[min_trans_m, max_trans_m]`.

Diagnose with:

```bash
curl -s localhost:8088/metrics | jq '.keyframe_gate'
# {"accepted": 33, "rejected": 117, "accept_rate": 0.22,
#  "reasons": {"translation": 24, "rotation": 6, "timeout": 3}}
```

- `accept_rate` above ~0.4 → the gate is too loose; the mapper will fall behind.
- Nearly all `timeout` → the camera is barely moving; that is the gate working.
- Nearly all `track_loss` → tracking is struggling. Look at exposure, motion
  blur, or `tracking.max_features`, not at the keyframe settings.

---

## 5. Tuning depth and fusion

### `fusion.min_extract_weight` — the accuracy/completeness dial

The single most useful knob after voxel size. Measured on the validation scene
(150 frames, 4 cm voxels, ground-truth depth):

| `min_extract_weight` | completeness (<20 cm) | median accuracy |
|---|---|---|
| 0.10 | 96.3 % | 6.5 cm |
| 0.25 **(default)** | 93.9 % | 5.4 cm |
| 0.50 | 85.8 % | 4.8 cm |
| 0.75 | 75.2 % | 4.8 cm |

Raise it for a clean model of well-covered geometry; lower it to squeeze
coverage out of a single fast pass.

### Do not shrink the bundle-adjustment budget

The obvious response to a slow mapper is to cut `local_ba_max_points`. Measured
on the validation scene, that backfires, and not even monotonically:

| `local_ba_max_points` | drift | accuracy | completeness |
|---|---|---|---|
| **600 (default)** | **1.7 %** | **7.2 cm** | **95.2 %** |
| 400 | 6.0 % | 11.3 cm | 81.9 % |
| 300 | 3.4 % | 12.6 cm | 88.8 % |

The mechanism: landmarks are spread across the whole window, so a smaller budget
leaves individual keyframes with fewer than `local_ba_min_obs_per_kf`
observations. Those keyframes are then pinned as underconstrained and never get
corrected, so drift accumulates — a cheaper solve that optimizes less.

600 is close to the floor for an 8-keyframe window. If the mapper cannot keep up,
reduce the *keyframe rate* (raise `keyframe.trans_ratio`, fix a noisy feed) or
shorten `local_ba_window`, but leave the per-window point budget alone.

### `fusion.voxel_size_m`

Memory scales as the cube. 2 cm costs 8× the blocks of 4 cm for the same volume.

| scene | voxel | notes |
|---|---|---|
| indoor room, detail wanted | 0.02 | needs ~3.5 GB budget |
| general purpose | 0.04 | the default |
| outdoor survey | 0.06–0.10 | large volume, coarse detail |

`trunc_voxels` (default 4) sets the truncation band. Below 3 the surface becomes
noisy; above ~6 thin structures get fused into blobs.

### Depth

Two backends ship. `depth_anything` (default) runs Depth Anything V2 Metric via
`transformers` — Small is 25M params, ~8 ms per keyframe. `da3` runs **Depth
Anything 3** (Nov 2025) via the `depth-anything-3` package — better depth from
the same image at ~78 ms and ~1.3 GB VRAM on the RTX 4070 Laptop, still far
under keyframe cadence:

```bash
--set depth.backend=da3 --set depth.model=depth-anything/DA3METRIC-LARGE --set depth.input_size=504
```

DA3METRIC output is focal-normalised; the adapter un-normalises it with the
calibrated focal, so `camera.hfov_deg` (or a calibration file) matters more
than it did with V2. `depth.fp16` is ignored by this backend (upstream API
manages precision itself).

| setting | effect |
|---|---|
| `depth.input_size` | 518 is native. 392 is ~1.7× faster and visibly softer. |
| `depth.max_depth_m` | discard beyond this. Set it to the real working range. |
| `depth.align_to_map` | keep **on**. See below. |
| `depth.align_min_observations` | 2. Do not set to 1. |
| `depth.edge_threshold` | 0.06. Lower suppresses more around depth discontinuities. |

**Why `align_min_observations` must stay ≥ 2:** predicted depth is aligned to
tracked landmarks, but a landmark seen only once *is* back-projected depth. Fit
against those and depth is being aligned to itself, so any scale error feeds back
and compounds. Setting this to 1 measured a **12 % systematic scale error**
versus 0.9 % at 2.

### Fusion weighting

`range_ref_m` (3.0) and `range_weight_floor` (0.08) shape the 1/d² falloff. The
floor is not optional: unfloored, far-range weights fall so low that distant
surface never accumulates enough to survive extraction, and the reconstruction
appears to simply stop a few metres from the camera.

---

## 6. Metric scale

Monocular video cannot recover absolute scale on its own. Options, strongest first:

```bash
# 1. MAVLink altitude from the flight controller (pymavlink is already installed)
dronemap run --uri rtsp://... --mavlink udp:0.0.0.0:14550

# 2. A metric depth checkpoint plus landmark alignment (the default)
--set scale.mode=depth_net

# 3. A measured constant
dronemap run --uri clip.mp4 --scale 1.37
```

MAVLink prefers a downward rangefinder, then relative altitude, then AMSL. It
compares *changes* in altitude against the map's vertical displacement, so it
needs vertical motion — in perfectly level flight it correctly declines to
estimate rather than guessing.

---

## 7. Loop closure

| setting | default | note |
|---|---|---|
| `loop.min_kf_gap` | 30 | keyframes that must pass before a revisit counts |
| `loop.match_threshold` | 0.22 | absolute bag-of-words similarity floor |
| `loop.baseline_ratio` | 0.35 | relative to adjacent-keyframe similarity |
| `loop.min_inliers` | 40 | RANSAC PnP inliers required to accept |

`baseline_ratio` is the sensitive one. Consecutive keyframes score ~0.78
similarity; a genuine revisit from a slightly different pose scores ~0.4–0.55.
Set the ratio above ~0.5 and no real loop ever qualifies. If loops are being
missed, lower it to 0.30 and watch `loop_closure.candidates_rejected` — a high
rejection count means detection is firing but geometric verification is not
confirming, which usually means `min_inliers` is too strict for the texture.

After a closure the fused volume is stale, so it is rebuilt from corrected poses
when the accumulated correction exceeds `fusion.reintegrate_trans_m` (0.10 m).
Re-integrating 30 keyframes takes ~0.2 s.

---

## 7b. Loop closure: reading the logs

A healthy closure looks like this:

```
loop closure 37 -> 0 (score 0.407, 40 inliers)
loop closure applied: chi2 12.5713 -> 0.0292, max pose shift 0.555 m
```

The shift should be comparable to the drift you expect over the loop. Shifts of
several metres on a short trajectory mean the correction is being applied more
than once — the pose graph is persistent by design, holding odometry edges as
originally measured, precisely so that repeated closures accumulate as
constraints rather than compounding.

If `loops_accepted` stays at 0 on a trajectory that clearly revisits a place:

1. Check `vocab_ready` in `/metrics`. The bag-of-words vocabulary needs about
   ten keyframes of descriptors before it exists; keyframes seen before that are
   indexed retroactively once it is built, so the start of the trajectory is
   still matchable.
2. Lower `loop.baseline_ratio` toward 0.30.
3. If `candidates_rejected` is high, detection is firing but geometric
   verification is not confirming — lower `loop.min_inliers`.

---

## 8. Sequential vs threaded

```yaml
pipeline:
  mode: threaded     # live streams: never stalls ingest (default)
  mode: sequential   # replay: reproducible, and more accurate
```

Threaded decouples the stages so a slow mapper cannot stall the network socket —
essential live. The cost is that corrections reach the tracker a variable number
of frames late, so two runs over identical input differ.

Sequential runs every stage inline. Use it for replay, benchmarking and
regression testing. It cannot keep up with a live source.

---

## 9. Offline 3D Gaussian Splatting

Live 3DGS-SLAM does not fit in 8 GB at frame rate. The supported path is to
capture with TSDF and train afterwards:

```bash
dronemap run -c configs/replay.yaml --uri flight.mp4 --save-keyframes --splat
```

That writes `keyframes/` (RGB + depth + poses, the exact input a 3DGS trainer
wants) and `map.splat` / `map_splat.ply` — gaussians seeded on the fused surface
and oriented to it, which is a far better initialisation than the random or
SfM-sparse start most pipelines use.
