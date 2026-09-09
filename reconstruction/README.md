# DroneMap

Real-time 3D reconstruction from a single moving camera — plus an offline
photogrammetry pipeline over the same footage — built and measured for an
**RTX 4070 Laptop GPU (8 GB VRAM, 55–105 W)** on Ubuntu 24.04.

Point a camera at the world, move, and get back a **dense, metric, colored
mesh** (PLY / OBJ / GLB / **STL**), a point cloud, and the camera trajectory —
live while you capture, or at maximum quality afterwards.

```bash
./dronemap.sh        # starts the server + opens the control panel as an app window
```

---

## The two workflows

|              | LIVE (SLAM)                                   | OFFLINE (photogrammetry)                  |
|--------------|-----------------------------------------------|-------------------------------------------|
| What         | Track + fuse **while the camera moves**       | Record / pick a session, reconstruct after |
| Latency      | Real time, 25–30 FPS, watch the map grow      | ~1–3 min per scan                          |
| Accuracy     | Good; depends on smooth motion                | Best obtainable from the same footage      |
| Method       | KLT/PnP visual odometry + DA3 depth + CUDA TSDF | COLMAP SfM poses + DA3 depth + same TSDF |
| Output       | `data/sessions/<time>_<name>/`                | `data/photogrammetry/<name>/`              |

They share one engine — the same depth network, the same CUDA fusion, the same
exporters. Every live session stores its keyframes, so **any session can be
re-processed offline later** (one click in the panel: *Photogrammetry → From a
stored session → Process*).

## The control panel (http://localhost:8088)

The only always-on UI. One page:

- **Live card** — camera dropdown, Start / Stop-&-export, tracking state,
  keyframes, FPS, GPU memory, and the **capture-quality bar**: green = good
  translation, amber = rotation only, red = tracking lost (slow down / add
  light). While running, three live feeds appear: **raw camera**, **depth map**
  (colorized, near = bright), and the **3D map** with the camera trajectory and
  current-pose frustum (drag to orbit, scroll to zoom — dependency-free WebGL).
- **Open 3D viewer** — attaches the full Rerun window to the live stream:
  dense cloud, all keyframe frusta, image-in-3D, scrubbable timeline.
- **Photogrammetry card** — process a stored session (no camera needed) or
  record a fresh clip; phases and elapsed time shown live
  (*selecting frames → matching → mapping → densifying k/n → GOOD / PARTIAL /
  FRAGMENTED*).
- **Results** — every session and scan, newest first, each file a download
  button. No folder navigation, ever.

## Architecture (live pipeline)

Five stages, decoupled by bounded queues. Drop-oldest everywhere except the
fusion link (lossless): a network stream cannot be back-pressured, but a lost
keyframe would be a permanent hole in the map.

```
 camera/net ─▶ INGEST ──q──▶ TRACKER ──q──▶ LOCAL MAPPER ──q──▶ FUSION ─▶ live map
              ffmpeg        KLT flow        DA3 depth           CUDA TSDF
              NVDEC/v4l2    PnP RANSAC      depth↔map align     hashed blocks
                            motion-BA       sliding-window BA   marching cubes
                            keyframe gate   loop closure (BoW)      │
                                            pose graph SE(3)        ▼
                            CONTROL (FastAPI: panel · REST · MJPEG feeds)
                                            EXPORT (PLY/OBJ/GLB/STL/splat + keyframes)
```

- **Ingest** — one `FrameSource` interface over RTSP, UDP/MPEG-TS, MJPEG-HTTP,
  ZeroMQ, WebRTC, V4L2 (incl. v4l2loopback/DroidCam), file and folder replay.
  NVDEC (`h264_cuvid`/`hevc_cuvid`/`av1_cuvid`) keeps decode off the CPU.
  Network sources ride link dropouts: a dead stream triggers bounded
  reconnect-with-backoff (`source.reconnect_window_s`, default 60 s) instead of
  ending the session — the tracker coasts to LOST through the gap and
  relocalization re-anchors when frames return. Built for RF video links,
  which drop routinely.
- **Tracker (per frame, ~4–8 ms)** — Shi–Tomasi corners + pyramidal KLT with
  forward-backward check, PnP RANSAC against mapped landmarks, motion-only
  bundle adjustment with analytic SE(3) Jacobians. Keyframe gate on
  translation / rotation / track-ratio / timeout; keyframes are promoted (and
  fused) **only while the pose is PnP-locked** — dead-reckoned stretches leave
  honest holes instead of phantom geometry. On tracking loss, **relocalization**
  matches the lost frame against the keyframe database (BoW, or brute-force on
  small maps), re-seeds landmarks from the anchor keyframe's depth, and adopts
  the recovered pose — but only if it passes two plausibility gates against
  the motion prior (translation from the loss point, rotation from the
  prediction), which is what stops appearance + PnP from confidently
  relocalizing onto the wrong wall of a self-similar scene.
- **Local mapper (per keyframe)** — depth inference, robust scale alignment of
  predicted depth to triangulated landmarks (Tukey IRLS + RANSAC seeding),
  sliding-window bundle adjustment with Schur-complement marginalization,
  bag-of-binary-words loop closure, persistent SE(3) pose-graph optimization,
  deferred TSDF re-integration after loop corrections. Non-finite solves are
  rejected (NaN guards at every solver boundary).
- **Fusion** — spatially-hashed TSDF (8³ voxel blocks, fp16 TSDF+weight,
  uint8 RGB, open-addressing hash) in hand-written CUDA kernels compiled at
  runtime by CuPy/NVRTC — **no CUDA toolkit needed**, only the driver. Hard
  VRAM budget with LRU block eviction. Integration: **1.2–1.8 ms** per keyframe.
- **Export** — tiled marching cubes with frontier erosion (no phantom shells),
  vertex weld, small-component pruning, optional xatlas UV + per-texel texture
  baking, watertightness warning on STL.

## Models and third-party pillars

| Component | Choice | Why |
|---|---|---|
| Dense depth | **Depth Anything 3** `DA3METRIC-LARGE` (334 M, Nov 2025, Apache-2.0) | Current SOTA monocular metric depth; measured **78 ms / 1.3 GB** per keyframe on this GPU. Output is focal-normalized — the adapter un-normalizes with the calibrated focal. |
| Depth fallback | Depth Anything V2 Metric Small (25 M) | 8 ms/keyframe when latency matters more than quality (`depth.backend=depth_anything`). |
| Offline SfM | **COLMAP** (via `pycolmap`) | The gold standard for camera-pose accuracy; frames auto-thinned to 200 (SfM cost is quadratic). |
| Densification | COLMAP poses + DA3 depth + the same CUDA TSDF | Poses from multi-view consistency, density from the network, metric scale recovered by aligning DA3 depth to COLMAP's sparse points. |
| Tracking | Classical (KLT + PnP + BA) — deliberately **not** learned | Learned pointmap SLAMs (MASt3R-SLAM, VGGT) need 16–24 GB VRAM; the classical front-end costs 4 ms and leaves the VRAM to depth + fusion. |
| Viz | Rerun (out-of-process) + self-contained WebGL panel | Viewer crash/absence can never take the pipeline down. |

**Rejected on measured grounds:** live 3D Gaussian Splatting SLAM (sub-real-time
and OOM at 8 GB), ORB-SLAM3 as a dependency (C++ build fight for no accuracy
win here), Open3D `VoxelBlockGrid` on the hot path (CUDA wheel not dependable).

**Optional / future:** MAVLink scale-and-orientation anchor for the drone
(implemented, off by default — no IMU is used today, and none is needed for
handheld capture); offline 3DGS (gsplat) pass over saved keyframes for
photoreal renders.

## Verified performance

Synthetic ground-truth harness (`dronemap selftest --gt-depth`, deterministic).
The sequence deliberately loses tracking twice; the numbers below include one
in-blackout relocalization and one genuine long-blackout recovery 5.4 m from
the loss point:

- Trajectory: **ATE 0.07 m RMSE over 18.4 m (1.1 % drift)**, RPE 0.007 m / 0.05°/kf
- Reconstruction: accuracy median 3.6 cm, completeness < 20 cm: 86 %
  (94 % on the shorter 90-frame variant)
- Live (Brio 100 @ 1080p30): tracker 4–8 ms p50, mapper ≈ 220 ms/kf (BA-bound),
  TSDF integrate 1.2–1.8 ms, GPU 73 W / 84 % util with Dynamic Boost, 0 dropped
  keyframes with the 16-deep RAM queue.
- 62 unit tests + synthetic end-to-end integration test.

These are synthetic-scene numbers; they validate the pipeline's internal
consistency, not competitiveness against published systems. A TUM/EuRoC
benchmark harness is the next evaluation step.

## Repository map

```
dronemap/
  app.py                orchestrator: threads, queues, lifecycle, live feeds
  config.py             pydantic schema · YAML presets · --set overrides
  types.py              SE(3) math, Frame/Keyframe/CameraIntrinsics
  ingest/               ffmpeg (NVDEC/v4l2/http) · zmq · webrtc · folder · ring buffer
  tracking/             frontend (KLT/PnP) · keyframe gate · local BA (Schur)
                        · local mapping · loop closure (BoW) · pose graph
  depth/                DA3 adapter · DA2 adapter · TensorRT hook · scale anchors
  fusion/               kernels.cu · CUDA hashed TSDF · Open3D fallback · reintegration
  viz/                  rerun viewer · viser alternative
  control/              FastAPI server · web panel · session supervisor · scan jobs
  export/               mesh (MC/weld/simplify) · texture baking · pointcloud · splat
  offline.py            photogrammetry pipeline: record → SfM → densify
  synthetic.py          ray-traced GT scene · selftest.py: ATE/RPE + surface metrics
configs/                brio_live.yaml (the preset) · default · indoor · drone_1080p30
scripts/                photoscan.py · densify.py · bench.py · install.sh
docs/                   OPERATIONS.md (one-page how-to) · TUNING.md (every knob)
dronemap.sh             the launcher
```

## Capture rules (both modes live or die by these)

1. **Light** the scene as brightly as deployment allows — dim light means slow
   shutter means motion blur, the #1 cause of tracking loss.
2. Move at **coffee-carrying speed**; translate, don't pan.
3. **Turn in small steps** with pauses.
4. Point at **texture** (furniture, shelves), not blank walls.
5. **Finish where you started** — that closes the loop.

The panel's quality bar tells you in real time whether you're following them.

## Known limits (honest)

- Monocular metric scale is only as good as its anchor; expect ~10–25 % absolute
  scale error without MAVLink/known-size references. Shape is much better than
  scale.
- STL from a partial scan is not watertight (unseen surfaces are honest holes);
  orbit a whole object, or run Poisson, for printable solids.
- After a long tracking blackout in a highly self-similar scene (identical
  corridors, symmetric rooms), relocalization deliberately stays lost rather
  than guess between look-alike places — the plausibility gates reject what
  they cannot verify. Revisiting distinctly-mapped territory recovers it;
  a MAVLink prior will lift this limit for the drone.
- 8 GB VRAM rules out live splatting and multi-view transformer SLAM — by
  measurement, not opinion. The hybrid here is the strongest live configuration
  this hardware supports.
