# Avoidance in Gazebo SITL - runbook

The drone is not told where obstacles are. It finds them with its own sensor
during the mission and steers around them. The hazard table starts empty
(`POST /api/avoidance/hazards/clear` for an honest repeat).

For what the code does and how to tune or debug it, see `README.md` here.

## 1. Start the sim

```
cd simulation
MODEL=gz_x500_depth ./hyrak_sim.sh start   # recommended: true depth camera
./hyrak_sim.sh start                       # camera-only (mono) variant
./hyrak_sim.sh status
./hyrak_sim.sh stop                        # only what it started; never pkill gz
```

`start` first clears anything a previous run left behind (old camera or depth
bridges keep sending otherwise). What runs:

| process | what it does |
|---|---|
| gz server + GUI | world `hyrak_obstacles`, partition `hyrak_demo`, `GZ_IP=127.0.0.1` |
| PX4 instance 1 | `x500_depth` (4002) or `x500_mono_cam` (4010); `NAV_DLL_ACT=2`, `RTL_RETURN_ALT=10` |
| `gz_cam_bridge.py` | RGB camera -> H.265 RTP -> udp:5600 (the real air unit's wire format) |
| `gz_depth_sensor.py` | depth model only: depth camera -> `/api/avoidance/auto/depth_scan` at up to 10 Hz |

Backend and frontend run as usual. The fleet watchdog adopts the sim on
udp:14541 within about 25 s.

## 2. In the HYRAK app

1. **Telemetry:** DEVICES -> TELEMETRY -> **Gazebo sim on server (udp:14600)**
   -> Connect. The backend talks to PX4 directly; nothing on the desktop is in
   the command path. Plain **SITL** (desktop binds udp:14540) also works.
   Do not use "Air unit (UDP, direct)" for the sim.
2. **Video:** CAMERA -> **Air unit (UDP)**, then tap **Sim / 5600** in the MESH
   UNITS row (or set the port to 5600 in Settings). Do not start Settings ->
   Native air-unit video bridge: it grabs 5600/5601 (the app now stops it
   before a stream, and the error names it if it is running).
3. **Avoidance card:** **Detection** on, then **Steer** on. SENSOR must read
   `depth camera (measured range)` (depth model) or `camera (estimated ...)`
   (mono). Starting a mission with avoidance off or detection-only posts a
   warning in the message log.
4. **Mission:** draw and upload the route at 10 m, then fly it.

Expected behaviour: NOMINAL while PX4 flies. An obstacle on the path turns the
card AVOIDING (PX4 shows OFFBOARD): the aircraft turns to face its chosen gap,
passes with about 3 m to spare, and hands back to the mission (at the next
waypoint if it reached the one beside the obstacle). At most one take-over per
obstacle.

## 3. Checking a flight afterwards

```
grep -E "Offboard mode started|mission resumed|LINK LOST|LINK RESTORED" .logs/backend.log
curl -s localhost:8001/api/avoidance/<drone_id>/events      # timeline (avoid / resume / hold / return)
curl -s localhost:8001/api/avoidance/status                  # state, sensor mode, scans, planner
curl -s localhost:8001/api/latency-probe/stats               # if LATENCY_PROBE=true
```

PX4's own log for the flight: `~/PX4-Autopilot/build/px4_sitl_default/rootfs/1/log/<date>/*.ulg`
(`python3 -c "from pyulog import ULog; ..."`; `failsafe_flags` explains any
failsafe).

## 4. Rules that keep a test valid

- **Never change backend code while the drone is airborne.** The backend
  reloads on every `backend/app` change; the Offboard stream and every MAVLink
  link stop for a few seconds and PX4 fails safe (this ended the 17:34 flight
  on 2026-09-26).
- **One sender per video port.** Two senders on 5600 (a leftover bridge) used
  to blank the picture; the reader now keeps one and logs `TWO senders`.
- **Restart the sim with the script**, not by hand: it sets
  `NAV_DLL_ACT=2`, without which the pre-flight failsafe check refuses to arm.

## 5. Traps already fixed (kept so they are recognised if they return)

- **gz server leaks ~9 MB/s and is OOM-killed after ~40 min** - PX4's
  `libGstCameraSystem.so` in its gz `server.config`; `hyrak_server.config` is
  that file without it (PX4-Autopilot#27296).
- **Wi-Fi IP change froze the sim** - `GZ_IP=127.0.0.1`.
- **RTL climbed to 30 m** - `PX4_PARAM_RTL_RETURN_ALT=10`.
- **Backend hang when the drone vanished** - `app/loop_stall.py` dumps the
  event-loop stack on a stall over 3 s.
- **Session uploads/identity timed out with the fleet connected** - both
  MAVSDK links were sysid 245; fleet links are 200+instance.
- **Session port inside the fleet scan range** - 14560 was adopted as a
  phantom drone; the session link is 14600.
- **Swarm-mode sessions never bind a drone** - camera data goes to the sole
  enabled controller.
- **Loops around a pillar** (2026-09-26) - wrong goal from the mission index,
  waypoints inside an obstacle's clearance, danger judged by padded distance.
  Each is a test in `backend/tests/avoidance/test_supervisor.py`.

## 6. Indoor (GPS-denied)

```
cd simulation
MODEL=gz_x500_indoor ./hyrak_sim.sh start   # world hyrak_indoor by default
```

What is different from the outdoor sim:

| | |
|---|---|
| world | `simulation/worlds/hyrak_indoor.sdf`: a 30 x 20 m building, ceiling at 3 m, room A (take-off area clear around (0, 0)), a 1.8 m corridor with a plant narrowing it, rooms B and C behind 1 m doors, shelves, boxes, pillars, cabinets. Tiled floor and ceiling, a colour per wall. Generated by `worlds/gen_hyrak_indoor.py` - edit that and re-run it, do not hand-edit the .sdf |
| vehicle | `simulation/models/x500_indoor`: x500 + visual odometry + downward LW20 rangefinder + the same OAK-D Lite as `x500_depth` (so video on udp:5600, the depth sensor and avoidance work exactly as outdoors) |
| airframe | 4005 (`gz_x500_vision`) with GPS off: `SYS_HAS_GPS=0`, `EKF2_GPS_CTRL=0`, EKF2 on external vision (`EKF2_EV_CTRL=15`, `EKF2_HGT_REF=3`), rangefinder aiding, magnetometer off (vision gives yaw), `NAV_DLL_ACT=3` (Land: Return needs GPS) |

How it navigates: like a real indoor PX4 drone with a VIO / tracking camera.
Gazebo's OdometryPublisher publishes the body pose and velocity, PX4's
gz_bridge feeds it to EKF2 as external vision. There is no GPS, so PX4 has a
LOCAL position (north/east/down from where it started) and no global one.

- Missions are lat/lon, so they need a global origin: set the EKF origin
  (QGC "Set EKF origin", MAVLink SET_GPS_GLOBAL_ORIGIN) before uploading one,
  or fly Position / Offboard.
- In the HYRAK app turn on Indoor navigation (Command, Indoor or Auto) so
  avoidance uses the indoor profile and PX4's local position.
- The OAK-D Lite RGB camera is 69 deg (`CAMERA_HFOV_DEG=69`), not the 99.7 of
  the old mono-cam model.

Why not optical flow (PX4's `x500_flow`, the usual GPS-denied sim): its
`libOpticalFlowSystem.so` segfaults the gz server on this machine. It links
two Gazebo generations at once (gz-sim9 / sdformat14 and sdformat15 /
gz-transport14), and the server dies in `sdf::Element::GetAttribute` as soon
as a flow sensor spawns - stock `x500_flow` with PX4's own server.config
included. Rebuilding PX4's gz plugins against one Gazebo version would fix
it; until then vision odometry is the GPS-denied path.
