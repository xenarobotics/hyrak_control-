# Obstacle avoidance

The cloud companion's collision layer: it watches the aircraft's sensor,
keeps a map of what is around it, and while PX4 flies a mission it takes the
aircraft in Offboard to steer around anything in the way, then hands it back.

| document | what it is |
|---|---|
| this README | how it works now, where everything lives, how to tune and debug it |
| `SIM_RUNBOOK.md` | running and checking it in Gazebo SITL |
| `ARCHITECTURE_REVIEW.md` | history: why the first design failed (2026-09-19) and the redesign plan it led to |
| `../LINK_RESILIENCE.md` | what happens when the cloud or telemetry link drops |

## 1. How it works (current path, `local_planner = 1`)

```
sensor frame ── stamped at capture
   │  depth camera (sim: gz_depth_sensor.py -> POST /depth_scan)
   │  or mono camera (sensing/camera.py: depth model + ground-plane scale fit)
   ▼
sensing/depth_scan.py     pixels -> 3D with camera tilt + aircraft roll/pitch AT CAPTURE,
                          ground rejected by height -> ScanBins (bearing, hit, free, top)
   ▼
mapping/pose_history.py   pose at the frame's capture time (every telemetry update stamped)
mapping/occupancy.py      log-odds grid: hits raise a cell, rays through it lower it,
                          evidence decays; depth confirms in 1 frame, mono in 3
   ▼
core/controller.py        decide_local() at 10 Hz (core/loop.py):
   NOMINAL   PX4 flies the mission; threats judged along the aircraft's real motion
   AVOIDING  obstacle on the path or TTC < 4 s -> planning/local_planner.py
             (VFH on the grid, brake under TTC 2 s, turn to look before moving,
             hold the altitude it took over at)
   resume    straight line to the waypoint clear for 1.5 s, or the waypoint reached
             (then the NEXT waypoint), -> back to PX4's mission
   HOLDING   boxed in 3 s, or no route / steering off -> HOLD; RTL after hold_to_return_s
   ▼
core/executor.py          Offboard NED velocity + heading, HOLD, RTL, mission resume
```

The goal is the mission item PX4 is flying. When the reported item disagrees
with the motion (or is unknown), the nearest waypoint along the motion wins
(`pick_goal_by_motion` in `core/loop.py`).

A real range sensor always wins over mono: while one is streaming, mono scans
are dropped. Mono-only flight senses only above `mono_min_alt_m` (8 m) and
caps speed at `mono_speed_cap_m_s` (1.5 m/s).

## 2. Where things live

```
backend/app/avoidance/
  core/       controller.py (per-drone controller, params, state, registry, persistence)
              loop.py (10 Hz task, pose feeds, goal selection) · executor.py
  sensing/    camera.py (mono) · depth_scan.py · mono_calibration.py · observations.py
              registry.py (declared sensors, live/no-data) · flat_segment.py (legacy mono)
              pointcloud.py
  mapping/    pose_history.py · occupancy.py (current) · keepouts.py (legacy) · hazards.py
  planning/   local_planner.py (current) · reroute.py (legacy) · geometry.py
  events.py   avoidance_events table · routes.py  /api/avoidance
backend/tests/avoidance/   one test file per layer + avoid_harness.py (synthetic
                           depth camera, kinematic PX4 stand-ins) + conftest.py
simulation/                hyrak_sim.sh · gz_cam_bridge.py · gz_depth_sensor.py
frontend/src/components/avoidance/AvoidancePanel.tsx · frontend/src/lib/avoidance.ts
```

## 3. Data

| store | what | notes |
|---|---|---|
| `avoidance_events` (Postgres) | every state change: avoid, resume, hold, return, clear (+ legacy reroute, climb, track) | Mission-tab timeline; `GET /{drone}/events`. Constraint extended for the local planner's actions in migration `b7e2c4a9d1f6` (before it, those inserts were rejected) |
| `known_obstacles` (Postgres) | persistent hazards: operator-marked, or learned when `learn_hazards = 1` | pinned into the grid near the aircraft every 3 s; `POST /hazards/clear` empties it |
| `.avoidance_state.json` (repo root) | per drone: detection on/off, steering on/off, all params | outside `backend/app` on purpose: writing it must not reload the backend |
| in memory only | pose history, occupancy grid, planner state | reset on landing and on backend restart |

## 4. API (`/api/avoidance`)

| endpoint | use |
|---|---|
| `GET /status`, `GET /{drone}/status` | state, reason, sensor mode, scans, planner, calibration |
| `POST /{drone}/enable {enabled}` | detection on/off (token) |
| `POST /{drone}/arm {armed}` | steering on/off - requires detection (token) |
| `GET /{drone}/events` | event timeline |
| `GET /{drone}/obstacles` | map overlay: obstacle clusters, goal |
| `POST /{drone}/depth_scan` | pooled depth image from a range sensor; `auto` = the one enabled drone |
| `POST /{drone}/observe` | one body-frame reading (injection, other sensors) |
| `GET/POST /{drone}/sensors` | declared sensor inventory |
| `GET/POST /hazards`, `POST /hazards/clear` | known_obstacles |
| `POST /{drone}/decide` | legacy planner, one tick against a given pose (testing) |

## 5. Tuning (Avoidance card, persisted)

Both planners: `reaction_distance_m`, `speed_cap_m_s`, `hold_to_return_s`,
`allow_reroute` / `allow_return` (the Response dropdown), `learn_hazards`.

Current path: `local_clearance_m` (3, "STEER GAP"), `ttc_engage_s` (4,
"TAKE OVER AT"), `lookahead_m` (18), `handback_clear_s` (1.5),
`block_hold_s` (3), `mono_min_alt_m`, `mono_speed_cap_m_s`,
`range_min_alt_m`, `camera_pitch_deg`.

Legacy path only: `clearance_m`, `forward_cone_deg`, `vertical_enabled`,
`max_climb_alt_m`, `climb_step_m`, `min_speed_m_s`, `prediction_horizon_s`.

## 6. Debugging

| symptom | look at |
|---|---|
| never takes over | card state DISABLED / Steer off (a mission start warns); SENSOR `none`; `scans.dropped_low` rising (below the sensing altitude) |
| takes over and hands back repeatedly | `grep "Offboard mode started\|mission resumed" .logs/backend.log` - `resumed at item -1` = mission item unknown; same item repeating = waypoint beside an obstacle |
| wrong direction | `status.goal` vs where PX4 is flying |
| phantoms | SENSOR `camera`: calibration `error_pct_p50`; mono needs 3 agreeing frames |
| timeline empty | `grep "avoidance event NOT recorded" .logs/backend.log` (schema / DB) |
| latency | `LATENCY_PROBE=true`, `GET /api/latency-probe/stats` |

## 7. Legacy path (`local_planner = 0`)

The first design: mono detections -> keep-out circles -> A* detour uploaded as
a new mission. It crashed in 8 of 9 SITL flights (ARCHITECTURE_REVIEW.md
section 7) and is kept only as a selectable fallback; its code is the
`legacy` parts of core/controller.py (`decide`), core/loop.py
(`_legacy_step`), mapping/keepouts.py, planning/reroute.py and
sensing/flat_segment.py, with tests in `test_legacy_controller.py`.
