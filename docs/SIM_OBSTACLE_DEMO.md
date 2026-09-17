# Gazebo obstacle-avoidance demo (perception-only)

The drone is NOT told where the obstacles are. It discovers them with its own
forward camera during the mission and reroutes around them at mission
altitude. Nothing is pre-seeded: the hazard database is empty at the start of
a run (`POST /api/avoidance/hazards/clear`).

## Start / stop

```
cd simulation
./hyrak_sim.sh start      # gz server + GUI + PX4 instance 1 + camera bridge
./hyrak_sim.sh status
./hyrak_sim.sh stop       # stops only what it started (PID files, never pkill gz)
```

Backend and frontend run as usual (`backend: uv run python -m app.main`,
`frontend: npm run dev`). The fleet watchdog adopts the sim within ~25 s.

## In the HYRAK app (desktop)

The sim presents itself exactly like the real air unit: MAVLink on udp:14550
(uplink accepted on 14551, where the desktop pins it) and H.265 RTP video on
udp:5600. So the normal single-drone flow works:

1. DEVICES -> TELEMETRY -> **Air unit (UDP, direct)**. While disconnected,
   set **TX HOST** to `auto` (reply to whoever sends, exactly what QGC does;
   the default 192.168.50.12 is the wfb-ng decoder - with it telemetry flows
   but every command silently goes nowhere) and **QGC PORT** to `0` (14551
   there mirrors PX4's own telemetry back into PX4). Then Connect. Swarm Mode is no longer required; the fleet still adopts the sim
   on 14541 in the background, and both register the aircraft under its real
   FC UID, so it is ONE drone record whichever link you use.
2. DEVICES -> CAMERA -> **Air unit (UDP) - set in Settings** (Settings ->
   Air unit video port = 5600, the default). The backend reads the sim camera
   as H.265 RTP on 127.0.0.1:5600, exactly the wire format the real air unit
   sends, and serves it to the browser; no virtual webcam is involved.
3. AI tab -> **Depth mapping**. This is the mode whose module runs the metric
   depth model; its per-frame obstacle observations feed the avoidance loop.
   You see the depth colormap (clip 60 m) in this mode.
4. Mission tab: draw an A->B mission at 10 m and upload/fly. The map's Avoidance overlay shows what the drone currently sees
   (grey/amber) and the amber dashed reroute it commits to.

Avoidance enable/arm for the drone survives backend restarts
(`.avoidance_state.json` at the repo root).

## How the perception chain works

```
gz camera (640x480 @10, HFOV 99.7 deg)
  -> simulation/gz_cam_bridge.py  (frame-dropping, never blocks lockstep)
  -> ffmpeg libx265 -> RTP/H.265 127.0.0.1:5600
  -> backend udp_video_source (aiortc MediaPlayer, same reader as the air unit)
  -> vision pool, DEPTH_MAPPING mode: Depth-Anything-V2 Metric Outdoor (33 ms)
  -> avoidance.detector.observations_from_depth: nearest FLAT VERTICAL
     segment per 8-degree bin (ground is rejected: its depth grows row by
     row; a post/tree/wall keeps the same depth over many rows)
  -> loop.observe_from_session -> the drone's ObservationBus
  -> controller.decide(): keep-out circles at current altitude,
     reroute_around() -> upload detour mission -> start
```

Settings (backend/app/config.py, override in `.env`):

| setting | default | why |
|---|---|---|
| `DEPTH_MODEL` | Depth-Anything-V2-Metric-Outdoor-Small-hf | ZoeDepth (NYU) read a 30 m post as 1.7 m |
| `CAMERA_HFOV_DEG` | 70 (`.env`: 99.7 for the gz mono_cam) | bearings derive from it |
| `DEPTH_OBSTACLE_MAX_M` | 20 | mono depth saturates: 31 m reads 22.6, 58 m reads 26, 100 m reads 23 - past 20 everything looks the same |
| `DEPTH_VIZ_MAX_M` | 60 | colormap clip |

Measured on the sim (drone on the pad, camera facing +X): true 30.9 m ->
22.6 m, 58 m -> 26 m, 83 m -> 28.6 m. Detection range is therefore ~25 m
true, about 6 s at 4 m/s; the controller's `reaction_distance_m` (12) and
`clearance_m` (6 for the demo) are set against that.

## Things that bit us (all pinned in hyrak_sim.sh)

- **gz server memory leak, ~9 MB/s, OOM-killed at 22 GB after ~40 min.**
  Not the GPU driver (identical on NVIDIA, Mesa/AMD and llvmpipe). Caused by
  PX4's `libGstCameraSystem.so` in PX4's gz `server.config`, which subscribes
  to the camera inside the server. `simulation/hyrak_server.config` is PX4's
  config without it (`GZ_SIM_SERVER_CONFIG_PATH`). Upstream:
  PX4-Autopilot#27296.
- **WiFi IP change froze the sim**: gz-transport multicast broke. `GZ_IP=127.0.0.1`.
- **RTL climbed to 30 m** every relaunch (SITL params reset):
  `PX4_PARAM_RTL_RETURN_ALT=10` (PX4's env override hook in rcS).
- **Backend hang when the drone vanished**: `app/loop_stall.py` now dumps the
  event-loop thread's stack to the log whenever the loop stalls > 3 s.
- **Avoidance silently OFF after a backend reload**: state is persisted now.
- **Session identity read, geofence and mission uploads timed out** while the
  fleet was also connected: both MAVSDK links identified as sysid 245, and PX4
  routes a reply to the link where it last saw that sysid - the fleet's.
  Fleet links now use sysid 200+instance; sessions keep 245.
- **Swarm-mode sessions never bind a drone**, so camera observations were
  dropped: `observe_from_session` falls back to the sole enabled controller.
- **v4l2loopback wedged** (`VIDIOC_G_FMT: Invalid argument`): not needed any
  more; the RTP path replaced the virtual webcam.
- PX4 adopts an already-running world on its partition, so the server can be
  started with our own env/config and PX4 still spawns the model into it.
