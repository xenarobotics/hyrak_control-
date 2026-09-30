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

## 7. Safety invariants (audit 2026-09-30)

Pinned by `backend/tests/avoidance/test_audit_robustness.py`. Anything that
breaks one of these is a bug, whatever else it improves.

Ownership
- Avoidance takes Offboard only from a MISSION (or its own excursion out
  of one). A stick mode (POSCTL, ALTCTL, STABILIZED, ...) is a pilot:
  detect only, never HOLD or RTL them.
- An Offboard session it did not open (`manager._offboard_owner` is not
  "avoidance") is left alone, however long the tracker's frames stall.
- RTL / LAND entered while it steers stands; it stands down.
- A goal-less hold never escalates to RTL.

Hand-back
- A "resume" is an obligation: retried until MISSION is confirmed; after
  three failures the aircraft is parked in PX4 HOLD for 30 s and status says
  so. Setpoints keep streaming until MISSION is confirmed; Offboard state
  is released only then.
- Our own Offboard with nothing steering it (NOMINAL, not intervened) is
  handed back within 1 s.
- The executor releases Offboard state BEFORE its own HOLD/RTL mode change.
- Every setpoint is clamped independently of the planner: finite, speed
  cap, |vd| <= 1.5 m/s.

Freshness
- Pose older than 2 s on a streaming feed: brake/hold, never steer from it.
- No scan for 2 s while steering: brake; HOLD after 3 s; the map's clock
  is frozen; no hand-back and no re-engage while blind; the speed governor
  crawls while blind in a mission.
- A map wipe (pose-frame switch) holds until scans newer than the wipe
  have arrived. An empty map is never "obstacle gone".

Indoor / environment
- The pose source switches with hysteresis (2 s to local, 5 s back) and
  never mid-manoeuvre. GPS fix 0 after GPS data means NO GPS.
- Auto indoor needs no GPS, or the camera's enclosed verdict with a real
  sky mask while slow; never switches while HOLDING / AVOIDING /
  intervened. The indoor profile never returns home.
- A link with no global position still resolves, so the local-position
  feed can start (the indoor bootstrap). Link loss keeps the flight state.
- Takeoff is capped at 2 m indoors (backend), the UI defaults to 1.5 m.

Sensing / map
- Mono evidence counts once per cell per bin per frame (three agreeing
  frames really means three). An older scan never rewinds a cell's clock.
- A mono frame with no ground fit yields no obstacles unless a fit is at
  most 2 s old. Mono tops are unknown (never climbed).
- `/depth_scan` bounds its inputs and drops scans older than 1.5 s;
  `GET /status` never creates a controller.

Loop
- One drone's exception never starves the others; an intervened drone
  whose tick failed is parked in HOLD.
- A session bound to a drone without avoidance is never guarded by
  another drone's map.

## 8. Legacy path (`local_planner = 0`)

The first design: mono detections -> keep-out circles -> A* detour uploaded as
a new mission. It crashed in 8 of 9 SITL flights (ARCHITECTURE_REVIEW.md
section 7) and is kept only as a selectable fallback; its code is the
`legacy` parts of core/controller.py (`decide`), core/loop.py
(`_legacy_step`), mapping/keepouts.py, planning/reroute.py and
sensing/flat_segment.py, with tests in `test_legacy_controller.py`.
