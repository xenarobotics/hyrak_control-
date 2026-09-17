# Indoor Navigation & Follow-Me - Capability Spec

**Status:** proposal / handoff
**Audience:** the flight-controller firmware agent (PX4 airframes and hyrak-os FC), plus the HYRAK cloud/app side.
**Purpose:** define GPS-denied indoor autonomy (position hold + follow-a-person) for the small FPV drones, split cleanly between what the firmware owns and what the cloud owns, and how it surfaces in the application as a capability/toggle - mirroring the existing obstacle-avoidance capability.

This document is the contract. The firmware side and the cloud side each implement their half against the message interface in section 5.

---

## 1. The governing constraint: control latency

The cloud link is ~150 ms round trip. That is fatal for any loop that stabilizes the aircraft.

- **Fast loops (attitude, position hold, altitude hold, collision reflex)** MUST run onboard at 50-250 Hz with single-digit-ms latency. They must keep the drone flying with the cloud link fully down.
- **The cloud is advisory.** It sends *setpoints* (where to go) and *corrections* (drift-free pose, loop closures) at 5-30 Hz, exactly the way GPS corrections arrive - never inside the stabilization loop.

Every decision below follows from this. If a feature would put the cloud inside a stabilization loop, it is wrong.

| Loop | Owner | Rate | Max latency | Fails safe to |
|---|---|---|---|---|
| Attitude / rate | FC | 250-1000 Hz | <2 ms | - |
| Position / altitude hold | FC (EKF2 + flow/ToF/VIO) | 50-250 Hz | <20 ms | Altitude+attitude hold |
| Collision reflex | FC (collision prevention) | 10-50 Hz | <50 ms | Brake / hold |
| Follow / navigate setpoints | Cloud → FC (Offboard) | 10-30 Hz | ~150 ms OK | Hover on last setpoint, then hold |
| Pose correction / relocalization | Cloud → FC (external vision) | 1-10 Hz | ~150 ms OK | Onboard dead-reckoning |

---

## 2. What the CLOUD / APP side provides

Most of this already exists in the platform or reuses the avoidance stack:

- **Person detection + tracking + re-identification** - forward camera stream → detector (YOLO family) + tracker (ByteTrack/BoT-SORT) + ReID embeddings so the drone locks to one person and does not jump to a passer-by.
- **Metric depth** - Depth Anything V2 (already integrated) gives per-pixel metres → range to the target and to obstacles.
- **Obstacle observations** - the existing `app/avoidance` stack (dense per-bin depth → keep-outs) works indoors unchanged; the cloud can feed `OBSTACLE_DISTANCE` down.
- **(Upgrade) Cloud VIO / dense SLAM** - heavy visual-inertial odometry, loop closure, relocalization, and a persistent room map. Pushed down as low-rate pose corrections; the FC never depends on them for the fast loop.
- **(Upgrade) Semantics** - segmentation (doors, walls, floor, furniture), gesture/pose recognition, VLM/language ("follow the person in red", "wait here").

**Cloud outputs to the FC:** body/NED velocity or position setpoints (follow-me), external vision pose (VIO), obstacle distances. See section 5.

---

## 3. What the FIRMWARE side must provide  ← the ask to the FC agent

This is the core request. For PX4 airframes most of this is configuration + sensor drivers; for **hyrak-os** it means implementing equivalents of the same interface (section 5).

### (A) GPS-denied state estimation
The FC must hold position and altitude with no GPS, fusing:
- **Downward optical flow** (PMW3901 / PAA5100) - lateral drift vs. the floor.
- **Downward ToF rangefinder** (VL53L1X for small rooms, TFmini/Lidar-Lite for larger) - height AGL, needed to scale flow into metres.
- **IMU** (already on the FC).
- **External vision pose** (VIO from cloud/companion) when available - drift-free correction.

PX4 reference config:
- `EKF2_OF_CTRL` = enable optical flow fusion
- `EKF2_HGT_REF` = range (rangefinder as primary height)
- `EKF2_EV_CTRL` = enable external vision (position/yaw) fusion
- `EKF2_EV_DELAY` = tuned to the vision pipeline's end-to-end latency (critical)
- `EKF2_RNG_*`, flow scaler and min/max range set to the chosen sensors
- Sensor drivers enabled for the chosen flow + ToF parts

**hyrak-os:** provide an estimator that ingests flow + range + IMU + external vision and outputs a fused local pose at >=50 Hz. The PX4 message set is the reference contract.

### (B) Offboard setpoint acceptance
Accept and act on streamed setpoints for follow-me / navigation:
- `SET_POSITION_TARGET_LOCAL_NED` with velocity and/or position, in body (FRD) and local (NED) frames, at 10-30 Hz.
- Enter/hold an Offboard-equivalent mode; require a live setpoint stream to stay in it.

### (C) Onboard collision reflex
- Ingest `OBSTACLE_DISTANCE` (the 72-sector array the avoidance stack already produces) and enforce a minimum standoff (`CP_DIST` / collision prevention), independent of the cloud. This is the on-vehicle reflex under the cloud's deliberative planner - identical to the outdoor design.

### (D) Failsafe & mode logic (safety-critical - define explicitly)
- **Offboard setpoint stream lost** → hover on last valid setpoint for a short grace, then position-hold; do NOT free-fall or drift.
- **Optical-flow / vision quality drops** (dark, textureless, shiny floor) → degrade gracefully to attitude+altitude hold and signal the app; never assume good position.
- **Data-link loss** → onboard hold; optional timed land-in-place (no GPS RTL indoors).
- **Deadman / arming** → follow-me must require an explicit arm and a target lock; auto-hover on target loss.

### (E) Time sync
- MAVLink `TIMESYNC`; all vision/flow timestamps on a common clock. External-vision fusion is very sensitive to timestamp/latency error - this is the usual reason indoor VIO "works in bench test, drifts in flight."

### (F) Health telemetry back up to the app
Expose so the app can show the operator whether indoor nav is trustworthy:
- `LOCAL_POSITION_NED`, `ODOMETRY`, `ESTIMATOR_STATUS` (innovations, variances)
- optical-flow quality metric, rangefinder validity, EV fusion status, current mode/failsafe state

---

## 4. How it plugs into the APPLICATION (feature/toggle)

Mirror the obstacle-avoidance capability exactly - same shape, so it is familiar and testable.

**Backend** - new module `backend/app/indoor/` (or extend `app/avoidance`):
- **State machine:** `DISABLED → HOVER_HOLD → FOLLOW → SEARCHING → LOST → RETURNING`.
- **Perception service:** detection + ReID + depth → a target estimate `{bearing, range_m, confidence, track_id}`.
- **Controller (near-pure, unit-tested):** target estimate + standoff params → body-frame velocity setpoint. Same "decision core is testable, executor touches the drone" split as avoidance.
- **Executor:** streams `SET_POSITION_TARGET_LOCAL_NED` via the fleet/telemetry layer at 10-20 Hz.
- **Sensor registry:** register flow / ToF / VIO health like the avoidance sensor chips.
- **Routes:** `/status`, `/enable`, `/arm`, `/target`, `/params`, `/events` - parallel to the avoidance routes.

**Frontend** - a card in the Fly tab, like `AvoidancePanel`:
- **"Follow Me" toggle** + two-tap ARM (deliberate, like avoidance arming).
- **Target-lock indicator** (locked / searching / lost) with the tracked person highlighted on the video overlay.
- **Standoff distance** slider (e.g. 1.5-4 m) and **max speed** cap.
- **State pill** + reason line, and **sensor health chips** (flow, range, VIO) so the operator knows if hold is trustworthy.
- Settings category **"Indoor / Follow"** for sensor selection and params.

**Safety in the app:**
- Room-bounds / max-distance limit as the indoor equivalent of a geofence.
- Auto-hover on target loss; deadman; never enter FOLLOW without a lock.

---

## 5. The message interface (the actual contract)

MAVLink is the reference. hyrak-os provides equivalents for each.

| Message | Direction | Rate | Purpose |
|---|---|---|---|
| `OPTICAL_FLOW_RAD` (or driver) | sensor → FC | 10-50 Hz | Lateral drift for EKF2 |
| `DISTANCE_SENSOR` | sensor → FC | 10-50 Hz | Height AGL / obstacle range |
| `VISION_POSITION_ESTIMATE` / `ODOMETRY` | cloud/companion → FC | 1-30 Hz | External-vision pose (VIO), drift correction |
| `SET_POSITION_TARGET_LOCAL_NED` | app/companion → FC | 10-30 Hz | Follow-me / nav velocity or position setpoint |
| `OBSTACLE_DISTANCE` | avoidance → FC | 10-50 Hz | Collision-prevention reflex input |
| `LOCAL_POSITION_NED`, `ODOMETRY` | FC → app | 10-50 Hz | Live pose for UI + follow controller |
| `ESTIMATOR_STATUS` + flow/EV quality | FC → app | 1-10 Hz | Trust / health for the operator |
| `TIMESYNC` | both | periodic | Common clock for EV fusion |

**Frames:** NED world, FRD body. **Timestamps:** monotonic, shared clock, latency-compensated (`EKF2_EV_DELAY`).

---

## 6. Responsibility matrix

| Function | Firmware (FC) | Cloud / App |
|---|---|---|
| Attitude / rate control | ✅ | - |
| Position + altitude hold | ✅ (EKF2 + flow/ToF/VIO) | - |
| Collision reflex | ✅ (CP_DIST / OBSTACLE_DISTANCE) | feeds distances |
| Who to follow / target lock | - | ✅ (detect + ReID + depth) |
| Follow setpoint generation | executes | ✅ (controller → Offboard) |
| Drift-free pose / relocalization | fuses EV | ✅ (VIO / SLAM) |
| Semantics, gestures, language | - | ✅ |
| Failsafe on link/vision loss | ✅ | signals + limits |

---

## 7. Minimum hardware (BOM)

- FC with IMU (have it)
- Downward optical-flow sensor (PMW3901 / PAA5100)
- Downward ToF rangefinder (VL53L1X, or TFmini for larger rooms)
- Forward camera (have it for streaming)
- *Optional but recommended:* small stereo/ToF depth cam (OAK-D / RealSense) for a robust onboard reflex without relying on cloud depth.
- *Optional:* companion computer if the FC/hyrak-os cannot host the VIO front-end.

---

## 8. Phased rollout

1. **Indoor hover** - flow + ToF + EKF2. No cloud. Proves position hold. *Do this first; everything rides on it.*
2. **Follow-me v1** - forward cam → cloud detect/ReID/depth → Offboard velocity setpoints; altitude held onboard.
3. **VIO** - external-vision pose to EKF2; cloud does relocalization / loop closure.
4. **Semantic + gesture + room map** - the differentiators.

---

## 9. Open questions for the firmware agent

1. **hyrak-os interface:** does it expose a MAVLink-compatible external-vision + offboard interface, or a custom one? If custom, define the equivalents of the section-5 messages.
2. **Companion computer:** present on the FPV frame, or must everything route through the FC / cloud link?
3. **Sensor choices:** which flow and ToF parts fit the frame (mass, mounting, min/max range, floor-texture assumptions)?
4. **Clock source** for external-vision fusion, and the measured end-to-end vision latency to set `EKF2_EV_DELAY`.
5. **Failsafe policy** you want on flow/vision degradation and on data-link loss (hold vs. timed land).
