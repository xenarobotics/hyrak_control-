> **History.** This review explains why the first design failed and proposes the
> redesign that is now built (section 9). For how avoidance works today, see
> `README.md` in this folder.

# Obstacle avoidance - architecture review (2026-09-19)

Written after six sim flights in one afternoon, five of which ended against a
cylinder. Each had a different immediate cause and each was fixed, but the
last one (16:08, mission at 3 m, first action at 4.9 m from the cylinder at
3 m/s) is not a bug. It is the ceiling of the design. This is a review of the
whole chain - sensing model, geometry, loops, actuation - with numbers from
the flight recorder, and a proposal.

## 1. What exists today

```
gz mono camera 640x480 @10 (HFOV 99.7)
  -> gz_cam_bridge -> H.265 RTP -> backend video track                 (~150 ms)
  -> avoidance/sensing.py: Depth-Anything-V2 Metric Outdoor Small     5 fps, 33 ms
  -> detector.py: nearest FLAT vertical run per 8-degree bin          per frame
  -> loop.observe_from_session: body-frame (bearing, distance)        -> ObservationBus
  -> service.decide() @ 2.5 Hz (loop.py INTERVAL_S 0.4):
       geo-place observations with the FLEET pose                      position 1 Hz, attitude 2 Hz
       ObstacleMap (keep-out circles, TTL 8 s, no motion model)
       threat = nearest keep-out within reaction range in the travel cone
       reroute = planner/engine.py cost-field A* -> NEW MISSION
  -> executor.py: upload_mission + start_mission / HOLD / RTL           1-2 s over MAVLink
  -> PX4 flies the new mission
```

2 215 lines in `backend/app/avoidance/`. The decision core is unit-tested
(36 tests) and behaves as designed. The problem is the design's inputs and
outputs.

## 2. Measured, not guessed

| quantity | measured | consequence |
|---|---|---|
| Mono depth scale (on the pad, static frame) | 31 m reads 22.6, 58 reads 26, 83 reads 28.6, 98 reads 23 | anything past ~25 m true is "20-ish"; keep-outs land 20-40 % short |
| Mapped obstacle vs true cylinder (16:09:06) | 5.7 m off | keep-out circle misses the real cylinder edge |
| Mapped obstacle vs true (15:41 flight) | 22 m off (ground phantom) | held for nothing, resumed into the real one |
| Pose used to place an observation | fleet link: position 1 Hz, attitude 2 Hz | at 3 m/s up to 3 m stale; turning 30 deg/s up to 15 deg stale = 5 m lateral error at 20 m |
| Sight-to-steer latency | frame 0-200 ms + loop 0-400 ms + upload/start 1-2 s + PX4 transition | 2-3 s, 6-9 m at 3 m/s |
| First action in the 16:08 flight | cylinder at 4.9 m | 1.6 s to impact - nothing downstream can act in that |
| Ground on a level camera at 3 m AGL | fills the lower half of the frame at 5-9 m | phantoms in every bin (events: "rerouting around 9 obstacles") |

## 3. The five structural gaps

1. **The sensor is not a range sensor.** A per-frame mono metric model
   compresses range, has no temporal consistency, and cannot tell ground from
   wall at low altitude. Every keep-out inherits a 20-40 % range error and
   metres of lateral error. No planner survives that at 3 m/s.
2. **Observations are placed with a stale pose.** Body-frame bearings are
   converted to world coordinates at decision time using a 1 Hz / 2 Hz fleet
   snapshot, not the pose at the moment the frame was captured. This alone
   explains multi-metre mapping errors during any turn.
3. **The actuator is the wrong one.** "Upload a new mission and start it"
   is a planning-time operation being used as a control-time one. It costs
   1-2 s, restarts legs, and the aircraft keeps flying its old leg meanwhile.
   Hold/resume around an expiring obstacle produced the ping-pong crash.
4. **The loop runs in the cloud at 2.5 Hz** against a vehicle that closes 1 m
   every 0.33 s. Fine for a 30 m warning, useless under 10 m. There is no
   fast inner reflex at all.
5. **No time-to-collision logic.** Reaction is a fixed radius (12-18 m)
   regardless of closing speed; the speed governor only reduces speed once a
   threat exists. Braking distance at 3 m/s with PX4's default acceleration is
   ~2 m; the system needs to decide at ~4 s TTC, not 1.6 s.

## 4. What PX4 already offers (checked on this build)

- `CP_DIST` collision prevention (currently -1 = off) consumes MAVLink
  `OBSTACLE_DISTANCE` (72 sectors, 1 Hz+) and brakes/deflects onboard at
  50 Hz - **but only in manual Position mode, not in Mission mode.**
- The old external-planner interface (`COM_OBS_AVOID`) is gone from this
  PX4 version.
- **Offboard mode** accepts velocity/position setpoints at >= 2 Hz and holds
  the last one. `TelemetryManager.start_offboard()` already exists (used by
  the trackers). This is the right actuator for a local dodge: the aircraft
  flies OUR setpoints continuously, no upload, no leg restart.
- The sim has **true depth**: `x500_depth` (OakD-Lite `depth_camera`),
  `x500_lidar_2d`, `x500_lidar_front`. A ground-truth range sensor lets the
  loop, geometry and actuation be validated without the mono model's errors.

## 5. Proposed architecture

Four layers, each with its own rate, each testable alone:

```
[1] Perception  -> body-frame range sectors (bearing, range, confidence), timestamped
                   sim: gz depth camera / lidar (truth)   |   mono: DA-V2 + scale calibration
[2] Local map   -> body-centred occupancy grid (0.5 m cells, 30 m), motion-compensated with
                   the pose AT CAPTURE TIME (10 Hz pose), log-odds so a phantom needs 3+ hits
[3] Local planner (10 Hz, Offboard) -> velocity setpoint toward the CURRENT waypoint,
                   VFH / potential field around occupied cells, speed = f(TTC), brake at TTC < 2 s
[4] Mission supervisor (1 Hz) -> which waypoint, when to hand back to PX4 mission mode,
                   hold -> RTL policy (the Response dropdown), operator toggles, events
```

Phased so each step is verifiable in the sim:

- **A. Truth first (1 day).** `simulation/gz_depth_sensor.py`: gz depth camera
  -> sectors -> `POST /api/avoidance/{id}/observe`. Same loop, real ranges.
  If the aircraft still hits cylinders, the fault is in [2]-[4] and we see it
  cleanly. Launcher gains `MODEL=gz_x500_depth`.
- **B. Timing (0.5 day).** Avoidance-enabled drones get 10 Hz position +
  attitude; each observation is stamped with the pose at its frame time and
  placed once, not re-placed every tick.
- **C. Actuation (1-2 days).** Threat confirmed -> Offboard local planner
  toward the current waypoint at 10 Hz, TTC-based speed, brake, then hand
  back to PX4 mission at the next item. Mission upload is never used in
  flight again. This is the change that turns "1.6 s to impact" into a
  continuous dodge.
- **D. Mono, honestly (after A-C prove the loop).** Per-frame scale
  calibration from the ground plane (camera height + pitch are known, so
  ground pixels have true range - fit the model's scale to them), multi-frame
  confirmation in the log-odds grid, minimum sensing altitude 8 m, and a
  capped speed (<= 1.5 m/s) while mono is the only sensor. Mono stays
  advisory-grade until its calibrated error is measured below 15 %.

## 6. What the current stack can and cannot do

- At 10 m mission altitude, 3 m/s, with the fixes of today, it will
  sometimes dodge a lone cylinder seen head-on 20+ m out. It will not
  reliably handle a turn onto a leg with a cylinder 15 m ahead, or anything
  at 3 m altitude. That is a property of gaps 1-4, not of tuning.
- With A+B+C the sim demo becomes a fair test of the planner; with D the
  same code runs on the real air unit's camera with known limits.

## 7. SITL statistics, 2026-09-19 (flight recorder + avoidance events)

| metric | value |
|---|---|
| airborne flights | 9 |
| flights ending against a cylinder (closest approach < 3 m) | 8 (89 %) |
| avoidance events | 95: 82 hold, 9 return, 4 reroute |
| mapped obstacle vs nearest real cylinder | median 15.0 m, mean 14.3 m, min 0.3, max 30 |
| events that were a real cylinder (< 3 m) | 6 / 95 (6 %) |
| events that were phantoms (> 8 m from any cylinder) | 77 / 95 (81 %) |
| distance to the (believed) obstacle when acting | median 7.4 m, min 1.2, max 15.1 |
| first action in the 16:08 flight | cylinder 4.9 m away at 3 m/s (1.6 s) |

Reading: 94 % of what the loop reacted to did not exist where it thought,
and when it did react to something real it was already inside braking
distance. The decision core executed its rules; its inputs were wrong.

## 8. What the field does (2026-09-19 survey)

- **PX4-Avoidance** (3DVFH+ local planner, octomap global planner): ROS 1
  Noetic, RealSense depth, MAVROS, `COM_OBS_AVOID`; **archived and
  unmaintained since 2024-08**. Its Gazebo setup used a depth camera, never a
  mono camera.
- **PX4 Collision Prevention** (onboard, `CP_DIST`): consumes
  `OBSTACLE_DISTANCE` at ~10 Hz from a lidar or companion; tested at 4 m/s;
  **Position mode only, not Mission**; the companion path is "untested".
- **ArduPilot**: object database in earth frame fed by proximity sensors
  (360 lidar, rangefinders, RealSense via companion); BendyRuler (probe
  headings, pick open + goal-ward) and Dijkstra (fence polygons) run in
  Auto/Guided/RTL on a background thread on the FC. Hobbyists fly it in the
  field with RPLidar/TF-Luna; it is the reference for "avoidance inside a
  mission".
- **Research planners** (FAST-Planner, EGO-Planner, Bubble, Histo-Planner):
  depth camera -> occupancy/ESDF grid -> gradient/corridor trajectory
  optimisation at 10-20 Hz on a companion computer, PX4 as the low-level
  controller via offboard setpoints. Gazebo with a depth camera is the
  standard test rig.
- **ROS 2 (2025)**: Aerostack2 (behaviour trees, modular), Nav2 used at fixed
  altitude with a Collision Monitor braking on raw lidar; D* Lite + MPPI
  map-free stacks on PX4 SITL + Gazebo Harmonic. Same pattern: range sensor,
  local grid, high-rate local planner, offboard setpoints.
- **Monocular depth for avoidance (2025)**: relative depth rescaled to metric
  with VIO sparse features reaches AbsRel ~0.10 (92 % of pixels within 25 %)
  and ~0.19 with real VINS features; runs 15 Hz on a Jetson Orin, planner at
  12 Hz; real test = 7 m in a pillar room, and the authors flag frame-to-frame
  "chattering" and sky-dominated scenes as failure modes. Aerial-view metric
  depth benchmarks report large domain gaps for street/indoor-trained models
  at altitude. Nobody publishes mono-only avoidance at 3-5 m/s over a
  cloud link.

Conclusion: the direction of the phased plan in section 5 is the field's
direction. What the field does NOT do is what the current stack does: a
per-frame mono metric model, placed with a 1-2 Hz pose, driving mission
uploads from a 2.5 Hz cloud loop.

## 9. Implemented, 2026-09-26 (A, B, C and D)

All four steps of section 5 are built. The old keep-out map with
mission-upload reroute is kept as a selectable fallback
(`params.local_planner = 0`); the new path is the default.

| layer | module | what it does now |
|---|---|---|
| A. truth sensor | `simulation/gz_depth_sensor.py`, `MODEL=gz_x500_depth ./hyrak_sim.sh start` | PX4's x500 with an OAK-D Lite depth camera (73 deg, 0.2-19.1 m). Frames pooled to 48x64, stamped on arrival, POSTed to `/api/avoidance/auto/depth_scan` at up to 10 Hz. While it streams, mono is ignored for the map. |
| B. timing | `avoidance/pose_history.py`, `TelemetryManager.add_pose_listener`, `boost_pose_rates` | Every attitude/position update is recorded when it arrives; pose rates raised to 10/20 Hz (5/10 on a radio) while avoidance is on. Each scan is placed ONCE with the pose interpolated at its capture time. |
| 1. geometry | `avoidance/depth_scan.py` | Depth pixel -> 3D point using camera tilt and aircraft roll/pitch at capture. Ground rejected by HEIGHT, only structure within +/- 2.5 m of flight altitude is an obstacle, its top height kept for fly-over. |
| 2. map | `avoidance/local_map.py` | Log-odds occupancy grid, 0.5 m cells, local N/E metres. Hits raise a cell, rays through it lower it, evidence decays (20 s). Depth: one hit occupies. Mono: three agreeing frames. Operator/DB hazards pinned. |
| C. local planner | `avoidance/local_planner.py`, `executor.apply_local`, `TelemetryManager.send_velocity_ned` | 10 Hz Offboard. VFH on the grid's polar histogram with obstacles grown by the clearance; prefers directions free to the horizon (steers early); speed from free distance and time-to-collision (brake under 2 s); turns to look before moving sideways; holds goal altitude. |
| 4. supervisor | `AvoidanceController.decide_local`, `loop._local_step` | NOMINAL (PX4 flies the mission) -> AVOIDING on a threat in the direction of travel or TTC < 4 s -> back to the mission at the current waypoint (`resume_mission_from_offboard`) once the straight line to it has been clear for 1.5 s. Boxed in 3 s -> HOLD; HOLD past `hold_to_return_s` -> RTL. No mission, or reroute disabled -> HOLD. Pilot mode change -> stands down at once. Mission upload is never used in flight. |
| D. mono | `avoidance/mono_calibration.py`, `avoidance/sensing.py` | Model depth scale fitted per frame to the ground plane (true ground depth from altitude and tilt), robust median with inliers, smoothed. Uncalibrated frames produce no obstacles. Mono senses only above 8 m and caps speed at 1.5 m/s. Fit error is reported (`mono_calibration.error_pct_p50/p90` in status). |

Also fixed on the way: `set_flight_mode` had lost its `@_claims_mode_change`
decorator (moved onto `set_speed` by f586259), so any mode the app set
mid-follow could read as a pilot takeover (273ea64).

### Offline results (closed-loop kinematic harness, not Gazebo)

`backend/tests/test_avoidance_local.py` flies a point mass (0.4 s velocity
lag, 90 deg/s yaw limit) along an 80 m mission leg with a synthetic 73 deg /
19.1 m depth camera, through the real sensing -> grid -> supervisor ->
planner code:

| scenario | reached | min clearance to a surface | time |
|---|---|---|---|
| head-on, 3 m/s | yes | 3.51 m | 27.0 s |
| offset left / right, 3 m/s | yes | 3.76 / 3.65 m | 26.9 s |
| two in line, 3 m/s | yes | 3.51 m | 27.3 s |
| gate 10 m wide, 3 m/s | yes | 2.98 m | 30.1 s |
| row of 3 with 4 m gaps (too narrow, goes round) | yes | 3.40 m | 29.9 s |
| 5 cylinders, 3 m/s | yes | 3.65 m | 27.4 s |
| head-on / two in line, 5 m/s | yes | 3.73 / 3.66 m | 16.8 / 17.1 s |
| mono-like (range +/- 20 %, 2 % phantom bins), 1.5 m/s, 3 scenarios | yes | 3.13-3.23 m | 54-59 s |

Every run: `avoid` then `resume`, no hold, no return. This proves the logic
and the geometry, not the flight: Gazebo physics, PX4's Offboard response,
MAVLink latency and the real depth camera are the next test, and only
Japesh's SITL runs (then field runs) count as results. The latency probe
(`LATENCY_PROBE=true`) records the real capture-to-motion times.
