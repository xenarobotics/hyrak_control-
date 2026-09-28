"""Per-drone avoidance state machine + the decision core.

decide() is deliberately close to pure: given the live pose, the mission goal
(if any), and whatever the observation bus currently holds, it returns a
Decision - it never touches a drone. A thin executor (wired to the fleet /
Offboard layer) applies the Decision. That split is what lets the dangerous
logic - reroute, airspace, hold, return - be unit-tested to death against
injected obstacles before it ever commands an aircraft.

Behaviour, matching the agreed design:
  - obstacle inside the reaction distance, ahead  -> HOLD first (never keep
    flying at it while thinking), then
  - on a mission: try an airspace-legal reroute -> REROUTED, or if none
    exists, stay HOLDING and escalate to RETURN after hold_to_return_s
  - manual / hover (no goal): HOLD (brake), escalate to RETURN the same way
  - forward cone clear -> NOMINAL
The pilot can always disable or override; this layer only ever proposes.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from enum import Enum

from app.avoidance.planning import reroute as reroute_mod
from app.avoidance.sensing import registry as sensor_registry
from app.avoidance.planning.geometry import Pose, distance_m, observation_to_keepout
from app.avoidance.mapping.keepouts import ObstacleMap
from app.avoidance.sensing.observations import ObservationBus, ObstacleObservation


class AvoidanceState(str, Enum):
    NOMINAL = "nominal"
    HOLDING = "holding"
    REROUTED = "rerouted"
    CLIMBING = "climbing"
    AVOIDING = "avoiding"     # local planner has the aircraft (Offboard)
    RETURNING = "returning"
    DISABLED = "disabled"


@dataclass
class AvoidanceParams:
    """Tunables, persisted per drone in .avoidance_state.json and editable
    from the Avoidance card. Grouped by which planner reads them."""

    # --- both planners -----------------------------------------------------
    local_planner: float = 1.0          # 1 = grid + Offboard local planner (current), 0 = legacy
    reaction_distance_m: float = 12.0   # something closer than this on the way -> act
    speed_cap_m_s: float = 4.0          # cruise speed while avoidance is on
    hold_to_return_s: float = 20.0      # holding with no way through this long -> RTL
    # Response ladder is always reroute/steer -> hold -> return; 1/0 flags say
    # how far down it the loop may go on its own (floats so the params
    # endpoint's setter applies).
    allow_reroute: float = 1.0          # 0: never steer / re-plan, hold instead
    allow_return: float = 1.0           # 0: never escalate a hold to RTL
    # Write confirmed static obstacles to the shared known_obstacles table.
    # OFF by default: a mono phantom would become a permanent hazard.
    learn_hazards: float = 0.0
    min_confidence: float = 0.35        # single readings below this are ignored

    # --- current path: occupancy grid + local planner ----------------------
    local_clearance_m: float = 3.0      # body + margin kept from every occupied cell
    lookahead_m: float = 18.0           # planning radius
    ttc_engage_s: float = 4.0           # take control when closing faster than this
    handback_clear_s: float = 1.5       # direct path free this long -> back to the mission
    plan_min_free_m: float = 4.0        # least room a direction must have to be chosen
    block_hold_s: float = 3.0           # boxed in this long -> HOLD
    # Monocular gates: camera-only flight senses from higher up and flies
    # slower until its calibrated error is measured good enough.
    mono_min_alt_m: float = 8.0
    mono_speed_cap_m_s: float = 1.5
    range_min_alt_m: float = 2.0        # a real range sensor may sense lower
    camera_pitch_deg: float = 0.0       # mono camera mount tilt, + = down
    # Which sensor avoidance senses with. 1 = a range sensor wins whenever it
    # streams (the default); 0 = ignore range scans and use the video stream
    # (camera) - e.g. to try a webcam while the sim's depth camera keeps
    # posting. Set from the Command window's camera menu.
    use_range_sensor: float = 1.0
    # BENCH TEST of the camera path (a fixed webcam beside a SITL/real drone,
    # like tuning the trackers): 1 = trust the depth model's own metres, no
    # ground fit, camera taken as level at bench_cam_height_m, and the camera
    # height floors dropped. Never for flight - a flying camera needs the
    # ground fit or it maps phantoms.
    mono_bench: float = 0.0
    # Keep-clear reflex while hovering with no route (operator HOLD, manual
    # hover): something inside keep_clear_m in view -> back straight away from
    # it, still facing it (the camera sees forward only), until it is
    # keep_clear_release_m away, then HOLD again. 0 = off.
    keep_clear_m: float = 3.0
    # Vertical escape, LAST RESORT: only when the local planner finds no
    # horizontal direction for climb_after_blocked_s, and only over obstacles
    # whose TOP the sensor has actually seen (a top cut off by the frame is
    # unknown, and unknown is never climbed). Climbs straight up to the
    # tallest blocker + climb_margin_m, then steers on at that height; hands
    # back to the mission only once the way is clear at the ORIGINAL height,
    # so PX4 does not descend onto what was just cleared. Nothing above the
    # aircraft is sensed (forward camera) - keep climb_max_gain_m modest.
    climb_over: float = 1.0
    # FOLLOW GUARD (tracking / follow modes). The tracker keeps the aircraft
    # and the yaw; its velocity command passes through guard_body() on the
    # way out, which bends it to the nearest open direction, slows it by the
    # room left, or holds it in place - never a mode change, never a mission
    # goal. 0 = pass the tracker's command through untouched.
    guard_follow: float = 1.0
    # Navigation environment (Command -> SETUP -> Indoor navigation):
    # 0 = auto (GPS + what the camera sees), 1 = outdoor, 2 = indoor.
    # Indoor swaps in the INDOOR_PROFILE below and navigates on PX4's local
    # position instead of GPS.
    env_mode: float = 0.0
    # Moving where the forward camera is not looking: at most this fast.
    guard_unseen_speed_m_s: float = 2.0
    climb_after_blocked_s: float = 3.0   # brake and look sideways first; same moment HOLD would come
    ceiling_margin_m: float = 1.0        # stay this far under a restricted layer overhead
    climb_margin_m: float = 2.0
    climb_max_gain_m: float = 12.0
    climb_rate_m_s: float = 1.0
    keep_clear_release_m: float = 5.0
    keep_clear_speed_m_s: float = 1.0
    bench_cam_height_m: float = 1.0

    # --- legacy path only: keep-out map + mission-upload reroute ------------
    clearance_m: float = 4.0            # keep-out radius padding
    forward_cone_deg: float = 60.0      # obstacles this far off the travel line count
    vertical_enabled: bool = True       # climb over known-height obstacles
    max_climb_alt_m: float = 40.0
    climb_step_m: float = 4.0
    min_speed_m_s: float = 1.0          # speed governor floor at the clearance ring
    prediction_horizon_s: float = 1.5   # dynamic obstacles predicted this far ahead


# Parameters that change between outdoors (the dataclass defaults, or what
# the operator tuned) and indoors. Indoors: corridors ~1.6-2 m and doorways
# ~1 m, so the clearance and look-ahead are room-sized, speeds walking pace,
# no climbing (a ceiling), and the camera floors low (flying at 1-1.5 m).
# Clearance = the airframe's radius + margin: 0.45 m suits an x500 (~0.7 m
# across with props). A gap is passable when it is wider than
# 2 x (clearance + ~0.14 m map cell): 1.2 m for the x500 - a standard ~1 m
# doorway needs a smaller airframe and a smaller clearance.
INDOOR_GRID_CELL_M = 0.2       # outdoors 0.5 (OccupancyGrid default)
INDOOR_PROFILE: dict[str, float] = {
    "local_clearance_m": 0.45,
    "lookahead_m": 6.0,
    "reaction_distance_m": 3.0,
    "speed_cap_m_s": 1.0,
    "mono_speed_cap_m_s": 0.8,
    "ttc_engage_s": 3.0,
    "handback_clear_s": 1.0,
    "plan_min_free_m": 1.5,
    "keep_clear_m": 1.0,
    "keep_clear_release_m": 1.8,
    "keep_clear_speed_m_s": 0.4,
    "guard_unseen_speed_m_s": 0.8,
    "climb_over": 0.0,
    "range_min_alt_m": 0.4,
    "mono_min_alt_m": 0.8,
}
ENV_SETTLE_S = 5.0          # a new environment must hold this long before it applies


@dataclass
class Decision:
    action: str          # clear | track | hold | reroute | climb | return
    state: AvoidanceState
    reason: str = ""
    obstacle: dict | None = None      # nearest world keep-out {lat,lng,radius_m}
    waypoints: list | None = None     # reroute/climb path
    fused_distance_m: float | None = None
    target_alt_m: float | None = None  # for a climb-over
    obstacle_count: int = 0            # obstacles the map is tracking
    recommended_speed_m_s: float = 0.0  # speed-governor output
    setpoint: object | None = None      # local planner Setpoint (action "avoid")
    advance: bool = False               # "resume" at the NEXT mission item (this one is reached)
    ttc_s: float | None = None


class AvoidanceController:
    """One per drone. Holds the sensor-fusion bus, the enable flag, the
    tunables, and the current state (incl. the hold-to-return timer)."""

    def __init__(self, drone_id: str, params: AvoidanceParams | None = None):
        self.drone_id = drone_id
        self.params = params or AvoidanceParams()
        self.enabled = False
        # armed = allowed to COMMAND the aircraft. Detection (enabled) and
        # control (armed) are separate so the trust ladder can run detection
        # advisory-only for as long as needed before it ever flies the drone.
        self.armed = False
        self.intervened = False   # did WE take control (so clear hands it back)
        self.bus = ObservationBus()
        self.omap = ObstacleMap()   # persistent world obstacle memory
        self.state = AvoidanceState.DISABLED
        self._hold_since: float | None = None
        self._last_reason = ""
        # Receding horizon: the path we have COMMITTED to and are flying. We
        # track it rather than greedily re-deriving a new one from the drifted
        # current position each tick (which is what corners the drone in a
        # multi-obstacle field). Re-planned only when it is actually invalid.
        self._committed_path: list | None = None
        self._committed_goal: tuple[float, float] | None = None
        self._recommended_speed = 0.0
        self._path_invalid = 0   # consecutive ticks the committed path looked blocked
        self._last_goal: tuple[float, float] | None = None  # for the map overlay
        # Redesign state: occupancy grid (layer 2), local-planner bookkeeping
        # (layer 3/4) and the mono scale tracker (step D).
        from app.avoidance.mapping.occupancy import OccupancyGrid
        from app.avoidance.sensing.mono_calibration import ScaleTracker
        self.grid = OccupancyGrid()
        self.mono_scale = ScaleTracker()
        self._range_data_t = 0.0          # last scan from a real range sensor
        self._mono_data_t = 0.0
        self._last_frame_t: float | None = None   # capture time of the newest scan
        self._clear_since: float | None = None
        self._blocked_since: float | None = None
        self._prev_dir: float | None = None
        self.last_setpoint = None
        self._resumed_at = -1e9
        self._resume_cooldown_s = 3.0
        self._engage_alt: float | None = None
        self.env = "outdoor"              # environment in force
        self.env_reason = "default"
        self._env_candidate: tuple[str, float, str] | None = None
        self._outdoor_saved: dict[str, float] | None = None
        self._gps_ok: bool | None = None
        self._vision_env: tuple[float, str] | None = None     # (t, 'indoor'|'outdoor'|'unsure')
        self._grid_epoch = 0
        self._follow_cmd_t = 0.0          # last tracker command through the guard
        self._guard_active = False        # the guard is bending/holding the command
        self._guard_t = 0.0
        self._latched_goal = None
        self._scans = {"integrated": 0, "dropped_no_pose": 0, "dropped_low": 0,
                       "dropped_mono_overridden": 0, "dropped_range_off": 0}

    # -- ingest -----------------------------------------------------------
    def observe(self, obs: ObstacleObservation) -> None:
        """A single body-frame reading (the /observe route, legacy detectors).
        Goes on the bus (legacy planner, OBSTACLE_DISTANCE status) AND into
        the occupancy grid as a one-bin scan placed with the pose at the
        reading's time."""
        self.bus.add(obs)
        sensor_registry.mark_data(self.drone_id, obs.source)
        from app.avoidance.sensing.depth_scan import ScanBin
        self.integrate_scan([ScanBin(bearing_deg=obs.bearing_deg,
                                     half_width_deg=max(1.0, obs.half_width_deg),
                                     hit_m=obs.distance_m, free_m=obs.distance_m,
                                     top_m=obs.top_m, points=1)],
                            captured_at=obs.t, source=obs.source,
                            confidence_scale=max(0.3, min(1.0, obs.confidence / 0.5)),
                            to_bus=False)

    def acting_floor_m(self, now: float | None = None) -> float:
        """Lowest altitude at which avoidance may COMMAND the aircraft: the same
        height its current sensor is trusted to see from. The old fixed 3 m
        floor (written for mono, which sees the pad and ground low down) left a
        depth-camera aircraft flying a 2.8 m mission leg with the pillar mapped
        and avoidance forbidden to act (SITL 2026-09-26 22:54)."""
        mode = self.sensor_mode(now)
        if mode == "range":
            return float(self.params.range_min_alt_m)
        if mode == "mono":
            if self.params.mono_bench:
                return float(self.params.range_min_alt_m)
            return float(self.params.mono_min_alt_m)
        return 3.0

    def sensor_mode(self, now: float | None = None) -> str:
        """'range' while a real range sensor is streaming, else 'mono' while the
        camera is, else 'none'. A range sensor always wins: mono is dropped
        from the map while one is fresh (it would only add its errors)."""
        now = now if now is not None else time.monotonic()
        if now - self._range_data_t <= 1.5:
            return "range"
        if now - self._mono_data_t <= 3.0:
            return "mono"
        return "none"

    def integrate_scan(self, scan: list, captured_at: float, source: str,
                       confidence_scale: float = 1.0, to_bus: bool = True) -> bool:
        """Place one scan in the occupancy grid ONCE, with the pose at the
        frame's capture time (step B). Returns False if it was dropped."""
        from app.avoidance.mapping import pose_history
        now = time.monotonic()
        is_range = source in ("depth", "lidar", "tof", "rangefinder", "injected")
        if is_range and source != "injected" and not self.params.use_range_sensor:
            self._scans["dropped_range_off"] = self._scans.get("dropped_range_off", 0) + 1
            return False                    # operator chose the camera
        if is_range:
            self._range_data_t = now
        elif source == "monocular":
            self._mono_data_t = now
            if now - self._range_data_t <= 1.5:
                self._scans["dropped_mono_overridden"] += 1
                return False
        sensor_registry.mark_data(self.drone_id, source)
        pose = pose_history.history(self.drone_id).at(captured_at)
        if pose is None:
            self._scans["dropped_no_pose"] += 1
            return False
        min_alt = self.params.range_min_alt_m if is_range else \
            (0.0 if self.params.mono_bench else self.params.mono_min_alt_m)
        if pose.alt_m < min_alt:
            self._scans["dropped_low"] += 1
            return False
        self.grid.integrate(pose.north_m, pose.east_m, pose.yaw_deg, scan, source,
                            now=captured_at, confidence_scale=confidence_scale)
        self._last_frame_t = captured_at
        self._scans["integrated"] += 1
        if to_bus:
            for b in scan:
                if b.hit_m is not None:
                    self.bus.add(ObstacleObservation(
                        bearing_deg=b.bearing_deg, distance_m=b.hit_m,
                        half_width_deg=b.half_width_deg,
                        confidence=0.9 if is_range else 0.45, source=source,
                        top_m=b.top_m, t=captured_at))
        return True

    def set_enabled(self, on: bool) -> None:
        self.enabled = on
        if not on:
            self.armed = False
            self.state = AvoidanceState.DISABLED
            self._hold_since = None
            self.intervened = False
            self.bus.clear()
            self.omap.clear()
            self.grid.clear()
            self._reset_local()
            self._committed_path = None
            self._committed_goal = None
            self._path_invalid = 0
        elif self.state == AvoidanceState.DISABLED:
            self.state = AvoidanceState.NOMINAL

    def reset_flight_state(self) -> None:
        """Forget everything about the last flight: the obstacle map, the hold
        timer, the committed detour. Called when the aircraft is on the ground.
        Without this the hold timer from a previous flight made the FIRST
        threat tick of the next one escalate straight to RETURN - the
        aircraft took off and landed again 5 s later."""
        self.bus.clear()
        self.omap.clear()
        self.grid.clear()
        self._reset_local()
        self._hold_since = None
        self.intervened = False
        self._committed_path = None
        self._committed_goal = None
        self._path_invalid = 0
        self._recommended_speed = 0.0
        if self.enabled:
            self.state = AvoidanceState.NOMINAL
            self._last_reason = "on the ground"

    def set_armed(self, on: bool) -> None:
        """Allow (or forbid) commanding the aircraft. Arming requires
        detection already enabled; disarming never disables detection."""
        self.armed = bool(on) and self.enabled

    # -- decide -----------------------------------------------------------
    async def decide(self, pose: Pose | None, goal: tuple[float, float] | None,
                     profile_rules: dict | None = None,
                     cruise_alt_m: float = 10.0, speed_m_s: float = 4.0,
                     now: float | None = None) -> Decision:
        now = now if now is not None else time.monotonic()
        if goal is not None:
            self._last_goal = goal
        if not self.enabled:
            return self._settle(Decision("clear", AvoidanceState.DISABLED,
                                          "avoidance off"))
        if pose is None:
            return self._settle(Decision("clear", AvoidanceState.NOMINAL,
                                          "no pose yet"))

        # 1. Fuse every fresh reading (ALL bearings, not just the forward cone)
        #    into the persistent world map. A second obstacle off to the side
        #    is remembered, not forgotten the moment it leaves the sensor cone.
        for o in self.bus.recent(self.params.min_confidence, now):
            ko = observation_to_keepout(pose, o, self.params.clearance_m)
            self.omap.add(ko, top_m=o.top_m, confidence=o.confidence, now=now)
        mapped = self.omap.active(now)

        # 2. Threat = nearest mapped obstacle within reaction range, in the
        #    direction of TRAVEL (the path), not merely the camera cone.
        threat = self._nearest_threat(pose, goal, mapped)
        if threat is None:
            self._hold_since = None
            self._committed_path = None   # back to the operator's own route
            return self._settle(Decision(
                "clear", AvoidanceState.NOMINAL, "path ahead clear",
                obstacle_count=len(mapped)))

        near_ko = threat.as_keepout()
        near_d = distance_m(pose.lat, pose.lng, threat.lat, threat.lng)
        rules = profile_rules if profile_rules is not None else {"categories": {}}
        # Speed governor: slow down as the nearest obstacle closes in.
        rec_speed = self._safe_speed(near_d)
        self._recommended_speed = rec_speed
        plan_speed = min(speed_m_s, rec_speed)

        if goal is not None and self.params.allow_reroute:
            # Plan against PREDICTED positions so a moving obstacle is dodged
            # where it is going, and around obstacles tall enough to matter.
            h = self.params.prediction_horizon_s
            keepouts = [o.predicted_keepout(h) for o in mapped
                        if o.top_m == 0 or o.top_m >= cruise_alt_m]

            # 3a. RECEDING HORIZON: keep flying the path we already committed to
            #     rather than re-deriving from the drifted position each tick
            #     (the greedy loop that corners a drone in clutter). With
            #     HYSTERESIS: a single "blocked" tick is a sensor blip - tolerate
            #     it and keep tracking; only re-plan after it stays blocked, or
            #     the drone grossly strays from its corridor.
            if (self._committed_path and self._committed_goal == goal
                    and self._on_path(pose, self._committed_path)):
                if self._path_clear(self._committed_path, keepouts):
                    self._path_invalid = 0
                    self._hold_since = None
                    return self._settle(Decision(
                        "track", AvoidanceState.REROUTED, "tracking committed detour",
                        obstacle=near_ko, fused_distance_m=near_d,
                        obstacle_count=len(mapped), recommended_speed_m_s=rec_speed))
                self._path_invalid += 1
                if self._path_invalid < 2:      # transient blip - hold the path
                    return self._settle(Decision(
                        "track", AvoidanceState.REROUTED, "confirming obstacle",
                        obstacle=near_ko, fused_distance_m=near_d,
                        obstacle_count=len(mapped), recommended_speed_m_s=rec_speed))
            self._path_invalid = 0

            # 3b. LATERAL: commit a fresh path around ALL obstacles at once.
            wps, _ = await reroute_mod.reroute_around(
                (pose.lat, pose.lng), goal, keepouts,
                profile_rules=rules, cruise_alt_m=cruise_alt_m, speed_m_s=plan_speed)
            if wps:
                self._committed_path = wps
                self._committed_goal = goal
                self._hold_since = None
                return self._settle(Decision(
                    "reroute", AvoidanceState.REROUTED,
                    f"rerouting around {len(keepouts)} obstacle(s)",
                    obstacle=near_ko, waypoints=wps, fused_distance_m=near_d,
                    obstacle_count=len(mapped), recommended_speed_m_s=rec_speed))

            # 4. VERTICAL: no lateral path -> climb over (known heights only).
            if self.params.vertical_enabled:
                climb = await self._try_climb_over(
                    pose, goal, mapped, rules, plan_speed)
                if climb is not None:
                    self._committed_path = climb.waypoints
                    self._committed_goal = goal
                    self._hold_since = None
                    climb.recommended_speed_m_s = rec_speed
                    return self._settle(climb)

        # 5. No lateral or vertical path (or no goal) -> hold, then return.
        # The obstacle that stops us must not evaporate while we sit still:
        # it expired after 8 s of not being re-seen, the loop said "clear",
        # resumed the mission and drove straight into it. Keep it 30 s.
        threat.last_seen = max(threat.last_seen, now + 30.0 - self.omap.ttl_s)
        self._committed_path = None
        return self._settle(self._hold_or_return(
            now, near_d, near_ko,
            "holding - rerouting disabled by operator" if (goal and not self.params.allow_reroute)
            else "holding - no lateral or vertical path" if goal
            else "holding - manual flight, no route to replan"))

    # -- redesign: supervisor over the local planner (layer 4) -------------
    def _reset_local(self) -> None:
        self._repelling = False
        self._climb_target = None
        self._climb_refusal = None
        self._climb_started = None
        self._pre_climb_alt = None
        self._clear_since = None
        self._blocked_since = None
        self._prev_dir = None
        self.last_setpoint = None

    # -- environment: indoor / outdoor ---------------------------------------
    def note_gps(self, ok: bool) -> None:
        self._gps_ok = ok

    def note_vision_env(self, sky_frac: float | None, median_m: float, ceiling: bool,
                        now: float | None = None) -> None:
        """One camera frame's verdict. Enclosed: no sky, a ceiling in the top
        of the frame, and nearly everything within ~8 m. Open: sky, or a far
        scene. Anything else says nothing."""
        now = now if now is not None else time.monotonic()
        if (sky_frac is None or sky_frac < 0.01) and ceiling and median_m < 8.0:
            v = "indoor"
        elif (sky_frac is not None and sky_frac > 0.05) or median_m > 15.0:
            v = "outdoor"
        else:
            v = "unsure"
        self._vision_env = (now, v)

    def update_env(self, now: float | None = None) -> str | None:
        """Apply the environment the operator chose, or in auto the one the
        evidence points to once it has held ENV_SETTLE_S. Never switches in
        the middle of a manoeuvre. Returns the new environment on a switch."""
        now = now if now is not None else time.monotonic()
        mode = int(round(self.params.env_mode))
        if mode == 1:
            want, why = "outdoor", "set by operator"
        elif mode == 2:
            want, why = "indoor", "set by operator"
        else:
            vis = self._vision_env if self._vision_env and now - self._vision_env[0] < 5.0 else None
            if self._gps_ok is False:
                want, why = "indoor", "auto: no usable GPS"
            elif vis and vis[1] == "indoor":
                want, why = "indoor", "auto: camera sees an enclosed space (no sky, ceiling, near walls)"
            else:
                want, why = "outdoor", ("auto: sky / open scene" if vis and vis[1] == "outdoor"
                                        else "auto: GPS good")
        if want == self.env:
            self._env_candidate = None
            self.env_reason = why
            return None
        if mode == 0:                       # auto: let it settle first
            if self._env_candidate is None or self._env_candidate[0] != want:
                self._env_candidate = (want, now, why)
                return None
            if now - self._env_candidate[1] < ENV_SETTLE_S:
                return None
        if self.state in (AvoidanceState.AVOIDING, AvoidanceState.CLIMBING):
            return None                     # finish the manoeuvre first
        self._apply_env(want)
        self.env_reason = why
        self._env_candidate = None
        return want

    def _apply_env(self, env: str) -> None:
        from app.avoidance.mapping.occupancy import OccupancyGrid
        p = self.params
        # Room-scale gaps need a finer map (0.5 m cells alone ate ~0.35 m of
        # every corridor); the map is rebuilt in the new resolution.
        self.grid.clear()
        self.grid.cell_m = INDOOR_GRID_CELL_M if env == "indoor" else OccupancyGrid.cell_m
        if env == "indoor":
            if self._outdoor_saved is None:
                self._outdoor_saved = {k: getattr(p, k) for k in INDOOR_PROFILE}
            for k, v in INDOOR_PROFILE.items():
                setattr(p, k, v)
        elif self._outdoor_saved is not None:
            for k, v in self._outdoor_saved.items():
                setattr(p, k, v)
            self._outdoor_saved = None
        self.env = env
        self._reset_local()

    FOLLOW_WINDOW_S = 1.0

    def following(self, now: float | None = None) -> bool:
        """A tracker has been commanding the aircraft through the guard
        within the last second - the follow owns Offboard, not the mission."""
        now = now if now is not None else time.monotonic()
        return now - self._follow_cmd_t < self.FOLLOW_WINDOW_S

    def guard_body(self, fwd: float, right: float, now: float | None = None
                   ) -> tuple[float, float, str | None]:
        """Filter one tracker velocity command (body frame, m/s). Returns
        (forward, right, event) where event is "start" / "end" when a guard
        episode begins or ends, else None. Pure with respect to the aircraft:
        it only reads the map and pose history. Passes the command through
        unchanged whenever it cannot judge (off, Steer off, no pose, below the
        acting floor) - exactly the behaviour before the guard existed."""
        from app.avoidance.mapping import pose_history
        from app.avoidance.planning import local_planner as lp
        now = now if now is not None else time.monotonic()
        self._follow_cmd_t = now

        def passed(reason_clear: str = "follow guard - path clear"):
            ev = None
            if self._guard_active:
                self._guard_active = False
                self._last_reason = reason_clear
                ev = "end"
            return fwd, right, ev

        if not (self.enabled and self.armed and self.params.guard_follow):
            return passed()
        pose = pose_history.history(self.drone_id).latest()
        if pose is None or pose.alt_m < self.acting_floor_m(now):
            return passed()
        yaw = math.radians(pose.yaw_deg)
        cy, sy = math.cos(yaw), math.sin(yaw)
        vn, ve = fwd * cy - right * sy, fwd * sy + right * cy
        speed = math.hypot(vn, ve)
        if speed < 0.15:
            return passed()

        pp = self.planner_params(now)
        sd = pp.sector_deg
        polar = self.grid.polar(pose.north_m, pose.east_m, pp.lookahead_m, sd, now,
                                min_top_m=pose.alt_m - 1.5)
        free = lp.enlarged_free(polar, sd, pp.clearance_m)
        n = len(free)
        want = math.degrees(math.atan2(ve, vn)) % 360.0
        k_want = int(want // sd) % n
        need = speed * speed / (2.0 * pp.decel_m_s2) + 1.0
        raw_ahead = min((polar[k % n] for k in range(k_want - 3, k_want + 4)), default=math.inf)

        def unseen(brg: float) -> bool:
            return abs(((brg - pose.yaw_deg) + 180.0) % 360.0 - 180.0) > pp.sensor_half_fov_deg

        if free[k_want] >= need and raw_ahead >= 2.0:
            if unseen(want) and speed > self.params.guard_unseen_speed_m_s:
                f = self.params.guard_unseen_speed_m_s / speed
                return fwd * f, right * f, None
            return passed()

        # Bend: the direction nearest to the tracker's (within 90 deg) that
        # has room to stop at the commanded speed; only if none does, the
        # nearest with any room, slowed to it. Choosing merely "some room"
        # first crept straight at the obstacle and stopped against it.
        def pick(min_free: float):
            best, best_cost = None, math.inf
            for k in range(n):
                centre = (k + 0.5) * sd
                diff = abs((centre - want + 180.0) % 360.0 - 180.0)
                if diff > 90.0 or free[k] < min_free:
                    continue
                cost = diff + (15.0 if unseen(centre) else 0.0)
                if cost < best_cost:
                    best, best_cost = k, cost
            return best
        best = pick(need)
        if best is None:
            best = pick(1.5)
        if best is None:
            out_n = out_e = 0.0
            reason = "follow guard - obstacle in the way, holding position"
        else:
            centre = (best + 0.5) * sd
            diff = abs((centre - want + 180.0) % 360.0 - 180.0)
            room = math.sqrt(2.0 * pp.decel_m_s2 * max(0.0, free[best] - 1.0))
            v = min(speed * math.cos(math.radians(diff)), room)
            if unseen(centre):
                v = min(v, self.params.guard_unseen_speed_m_s)
            v = max(0.0, v)
            out_n, out_e = v * math.cos(math.radians(centre)), v * math.sin(math.radians(centre))
            reason = ("follow guard - slowing, obstacle ahead" if diff < sd
                      else f"follow guard - sliding {diff:.0f} deg around obstacle")
        near = min(polar) if polar else math.inf
        if math.isfinite(near):
            reason += f" ({near:.1f} m)"
        ev = None if self._guard_active else "start"
        self._guard_active = True
        self._guard_t = now
        self._last_reason = reason
        f_out = out_n * cy + out_e * sy
        r_out = -out_n * sy + out_e * cy
        return f_out, r_out, ev

    def _climb_plan(self, pos, pose, goal_ne, pp, now) -> float | None:
        """Height to climb to so the blockers toward the goal pass underneath,
        or None when climbing is not a safe option: a blocker's top unknown,
        or the target beyond climb_max_gain_m / max_climb_alt_m."""
        p = self.params
        goal_brg = math.degrees(math.atan2(goal_ne[1] - pos[1], goal_ne[0] - pos[0])) % 360.0
        reach = min(pp.lookahead_m, max(6.0, p.reaction_distance_m))
        tops = []
        for n, e, top in self.grid.occupied(now, pos, reach):
            brg = math.degrees(math.atan2(e - pos[1], n - pos[0])) % 360.0
            if abs((brg - goal_brg + 180.0) % 360.0 - 180.0) > 75.0:
                continue                        # not between us and the goal
            if 0.0 < top < pose.alt_m - 1.5:
                continue                        # already below us
            tops.append(top)
        if not tops or any(t <= 0.0 for t in tops):
            return None                         # nothing to climb over, or a top never seen
        target = max(max(tops) + p.climb_margin_m, pose.alt_m + 1.0)
        if target > p.max_climb_alt_m or target - pose.alt_m > p.climb_max_gain_m:
            self._climb_refusal = f"climb to {target:.0f} m exceeds the climb limit"
            return None
        # Airspace ceilings: never climb into a restricted layer, here or
        # along the way on toward the goal (steering continues up there).
        ceiling = self._airspace_ceiling(pos, goal_ne, pose.alt_m, reach)
        if ceiling is not None and target > ceiling - p.ceiling_margin_m:
            self._climb_refusal = f"airspace ceiling {ceiling:.0f} m - no room to climb over"
            return None
        self._climb_refusal = None
        return target

    def _airspace_ceiling(self, pos, goal_ne, alt_m: float, reach: float) -> float | None:
        """Lowest restricted-airspace floor above alt_m over the aircraft and
        along the line toward the goal (to reach + 10 m)."""
        from app.avoidance.mapping import pose_history
        from app.zones import engine as zones
        h = pose_history.history(self.drone_id)
        if h.origin is None:
            return None
        dn, de = goal_ne[0] - pos[0], goal_ne[1] - pos[1]
        dist = math.hypot(dn, de)
        span = min(dist, reach + 10.0)
        lows = []
        steps = max(1, int(span // 3.0))
        for i in range(steps + 1):
            f = (i * span / steps) / dist if dist > 1e-6 else 0.0
            lat, lng = h.to_latlng(pos[0] + dn * f, pos[1] + de * f)
            c = zones.ceiling_at(lat, lng, alt_m)
            if c is not None:
                lows.append(c)
        return min(lows) if lows else None

    def _keep_clear(self, polar, pp, pose, now, _d):
        """The hover reflex. Returns a Decision while backing away (or the
        HOLD that ends it), None when nothing is close."""
        from app.avoidance.planning.local_planner import Setpoint, enlarged_free
        p = self.params
        finite = [(d, k) for k, d in enumerate(polar) if math.isfinite(d)]
        near_d, near_k = min(finite) if finite else (math.inf, None)
        repelling = getattr(self, "_repelling", False)
        if not repelling and near_d >= p.keep_clear_m:
            return None
        if repelling and near_d >= p.keep_clear_release_m:
            self._reset_local()
            self._hold_since = now
            return _d("hold", AvoidanceState.HOLDING,
                      f"kept clear - obstacle now {near_d:.1f} m, holding" if math.isfinite(near_d)
                      else "kept clear - holding")
        if near_k is None:
            return None
        sd = pp.sector_deg
        obst_brg = (near_k + 0.5) * sd
        # Straight away from it if that way is open, else the most open
        # direction at least 100 deg off the obstacle.
        free = enlarged_free(polar, sd, 1.0)
        away = (obst_brg + 180.0) % 360.0
        best = int(away // sd) % len(free)
        if free[best] < 2.0:
            cands = [k for k in range(len(free))
                     if abs(((k + 0.5) * sd - obst_brg + 180.0) % 360.0 - 180.0) >= 100.0]
            best = max(cands, key=lambda k: free[k]) if cands else best
        if free[best] < 1.0:
            self._repelling = True
            sp = Setpoint(0.0, 0.0, 0.0, pose.yaw_deg, 0.0, None, free[best], None, True,
                          f"obstacle {near_d:.1f} m and no room to back away - holding position")
            self.last_setpoint = sp
            return _d("avoid", AvoidanceState.AVOIDING, sp.reason, sp)
        brg = (best + 0.5) * sd
        spd = p.keep_clear_speed_m_s
        if self._engage_alt is None or not repelling:
            self._engage_alt = pose.alt_m
        vd = max(-pp.max_vz_m_s, min(pp.max_vz_m_s, pp.alt_kp * (pose.alt_m - self._engage_alt)))
        rad = math.radians(brg)
        # Keep facing the obstacle: the camera looks forward only.
        sp = Setpoint(spd * math.cos(rad), spd * math.sin(rad), vd, obst_brg, spd, brg, free[best], None, False,
                      f"keeping clear - obstacle {near_d:.1f} m, backing away")
        self._repelling = True
        self.last_setpoint = sp
        return _d("avoid", AvoidanceState.AVOIDING, sp.reason, sp)

    def planner_params(self, now: float | None = None):
        from app.avoidance.planning.local_planner import PlannerParams
        p = self.params
        cruise = p.speed_cap_m_s
        if self.sensor_mode(now) == "mono":
            cruise = min(cruise, p.mono_speed_cap_m_s)
        return PlannerParams(cruise_m_s=cruise, clearance_m=p.local_clearance_m,
                             lookahead_m=p.lookahead_m, ttc_slow_s=max(2.5, p.ttc_engage_s),
                             min_free_m=p.plan_min_free_m)

    def decide_local(self, goal_ne: tuple[float, float] | None, goal_alt_m: float | None,
                     now: float | None = None) -> Decision:
        """One supervisor tick against the occupancy grid. Returns a Decision
        whose action is one of:
          clear  - nothing to do (PX4 flies its mission / the pilot flies)
          avoid  - the local planner steers; decision.setpoint is the command
          hold   - brake and hold (no free direction, no route, or reroute off)
          resume - hand the aircraft back to its mission at the current item
          return - held too long with no way through
        """
        from app.avoidance.mapping import pose_history
        from app.avoidance.planning import local_planner as lp
        now = now if now is not None else time.monotonic()
        if not self.enabled:
            return self._settle(Decision("clear", AvoidanceState.DISABLED, "avoidance off"))
        hist = pose_history.history(self.drone_id)
        if hist.epoch != self._grid_epoch:
            # Pose source changed (GPS <-> PX4 local): the map was built in
            # the other frame. Start clean rather than dodge ghosts.
            self._grid_epoch = hist.epoch
            self.grid.clear()
            self._reset_local()
            if self.state in (AvoidanceState.AVOIDING, AvoidanceState.CLIMBING):
                self.state = AvoidanceState.NOMINAL
        pose = hist.latest()
        if pose is None:
            return self._settle(Decision("clear", AvoidanceState.NOMINAL, "no pose yet"))
        if goal_ne is not None and hist.origin is not None:
            self._last_goal = hist.to_latlng(*goal_ne)
        pp = self.planner_params(now)
        pos = (pose.north_m, pose.east_m)
        vel = hist.velocity_ne()
        alt_goal = goal_alt_m if goal_alt_m is not None else pose.alt_m
        # Obstacles whose known top is well below us are flown over, not around.
        polar = self.grid.polar(pos[0], pos[1], pp.lookahead_m, pp.sector_deg, now,
                                min_top_m=pose.alt_m - 1.5)
        free = lp.enlarged_free(polar, pp.sector_deg, pp.clearance_m)
        ttc = lp.ttc_along(polar, pp.sector_deg, vel[0], vel[1], pp.clearance_m * 0.5)
        n_obs = len(self.grid.clusters(now)) if self.state != AvoidanceState.NOMINAL or \
            any(math.isfinite(d) for d in polar) else 0

        # Direction of travel. While PX4 flies (NOMINAL) that is where the
        # aircraft is actually GOING - its velocity - not the bearing to a goal
        # we derived: judging the way ahead toward a point PX4 was flying away
        # from is what looped the aircraft past a pillar (SITL 21:33). Slow or
        # hovering: the goal, else the nose.
        dist_goal = math.hypot(goal_ne[0] - pos[0], goal_ne[1] - pos[1]) if goal_ne is not None else None
        goal_brg = math.degrees(math.atan2(goal_ne[1] - pos[1], goal_ne[0] - pos[0])) % 360.0 \
            if goal_ne is not None else None
        moving = math.hypot(*vel) > 1.0
        if self.state in (AvoidanceState.NOMINAL, AvoidanceState.DISABLED) and moving:
            travel = math.degrees(math.atan2(vel[1], vel[0])) % 360.0
        elif goal_brg is not None:
            travel = goal_brg
        elif moving:
            travel = math.degrees(math.atan2(vel[1], vel[0])) % 360.0
        else:
            travel = pose.yaw_deg
        s_idx = int(travel // pp.sector_deg) % len(free)
        ahead_free = free[s_idx]
        toward_goal = goal_brg is not None and abs((travel - goal_brg + 180.0) % 360.0 - 180.0) < 30.0
        reach = min(self.params.reaction_distance_m, dist_goal) if (toward_goal and dist_goal is not None) \
            else self.params.reaction_distance_m
        threat = ahead_free < reach or (ttc is not None and ttc < self.params.ttc_engage_s)
        # Obstacles BEYOND the waypoint on the line of travel are not in the
        # way: PX4 stops or turns there. Counting them made a waypoint in
        # front of a pillar look like a collision course.
        speed_now = math.hypot(*vel)
        if ttc is not None and toward_goal and dist_goal is not None and ttc * speed_now > dist_goal + 1.0:
            ttc = None
            threat = ahead_free < reach
        # Real danger, as opposed to "the line to the waypoint passes near
        # something": closing fast, or an obstacle genuinely close ahead - by
        # RAW distance. The clearance-grown distance (ahead_free) made every
        # waypoint beside a pillar "danger", so the cooldown never held and
        # the aircraft ping-ponged 3-6 times at each (SITL 21:57-21:59).
        raw_ahead = min((d for k, d in enumerate(polar)
                         if abs(((k + 0.5) * pp.sector_deg - travel + 180.0) % 360.0 - 180.0) <= 15.0),
                        default=math.inf)
        danger = (ttc is not None and ttc < pp.ttc_brake_s) or raw_ahead < 2.0
        near = min(polar) if polar else math.inf
        # A waypoint counts as reached once the aircraft is within this of it.
        # Wider when the waypoint itself sits inside an obstacle's clearance:
        # the planner can never get "clear" to it, and without this it orbited
        # the waypoint in Offboard indefinitely (SITL 2026-09-26 17:33).
        accept_m = max(2.5, pp.clearance_m)
        if goal_ne is not None:
            gp = self.grid.polar(goal_ne[0], goal_ne[1], pp.clearance_m + 1.0, pp.sector_deg, now,
                                 min_top_m=pose.alt_m - 1.5)
            g_near = min(gp) if gp else math.inf
            if g_near < pp.clearance_m:
                accept_m = max(accept_m, pp.clearance_m + 1.5)
        at_goal = dist_goal is not None and dist_goal <= accept_m
        # Just handed back: give PX4 the leg before taking it again, unless
        # something is actually about to be hit (the resume/re-engage ping-pong).
        cooling = (now - self._resumed_at) < self._resume_cooldown_s
        near_m = near if math.isfinite(near) else None
        can_steer = goal_ne is not None and bool(self.params.allow_reroute)

        def _d(action, state, reason, sp=None):
            d = Decision(action, state, reason, fused_distance_m=near_m,
                         obstacle_count=n_obs)
            d.setpoint = sp
            d.ttc_s = ttc
            return self._settle(d)

        st = self.state
        # No route (operator HOLD, manual hover): nothing to steer toward, so
        # the only job is keeping clear of what comes close in view.
        if goal_ne is None and getattr(self, "_operator_hold", False):
            if self.params.keep_clear_m > 0:
                rep = self._keep_clear(polar, pp, pose, now, _d)
                if rep is not None:
                    return rep
            # Otherwise the operator's HOLD stands: never escalate it (no
            # hold timer, no RTL) and never resume a route from it.
            self._hold_since = None
            return _d("clear", AvoidanceState.NOMINAL,
                      f"operator hold - nearest obstacle {near:.1f} m" if math.isfinite(near)
                      else "operator hold - nothing in view")

        if st in (AvoidanceState.NOMINAL, AvoidanceState.DISABLED):
            if not threat or at_goal or (cooling and not danger):
                self._hold_since = None
                return _d("clear", AvoidanceState.NOMINAL,
                          "path ahead clear" if n_obs == 0 else f"{n_obs} obstacle(s) mapped, none in the way")
            if not can_steer:
                self._hold_since = now
                return _d("hold", AvoidanceState.HOLDING,
                          "holding - rerouting disabled by operator" if goal_ne is not None
                          else "holding - manual flight, obstacle ahead")
            self._reset_local()
            self._engage_alt = pose.alt_m      # steer level at the altitude we took over at
            st = AvoidanceState.AVOIDING      # fall through: plan this tick

        if st == AvoidanceState.CLIMBING:
            target = getattr(self, "_climb_target", None)
            if target is None or goal_ne is None:
                self._hold_since = now
                return _d("hold", AvoidanceState.HOLDING, "holding - climb lost its route")
            if pose.alt_m >= target - 0.3:
                self._engage_alt = target          # steer on at the new height
                self._blocked_since = None
                self._prev_dir = None
                st = AvoidanceState.AVOIDING       # fall through: plan this tick
            else:
                start_alt = self._pre_climb_alt if self._pre_climb_alt is not None else pose.alt_m
                budget = (target - start_alt) / max(0.2, self.params.climb_rate_m_s) + 8.0
                if now - (self._climb_started or now) > budget:
                    self._hold_since = now
                    return _d("hold", AvoidanceState.HOLDING, "holding - climb not making progress")
                climb_sp = lp.Setpoint(0.0, 0.0, -self.params.climb_rate_m_s, pose.yaw_deg,
                                       0.0, None, 0.0, ttc, False,
                                       f"no way around - climbing over to {target:.1f} m")
                self.last_setpoint = climb_sp
                return _d("avoid", AvoidanceState.CLIMBING, climb_sp.reason, climb_sp)

        if st == AvoidanceState.AVOIDING and goal_ne is None:
            self._hold_since = now
            return _d("hold", AvoidanceState.HOLDING, "holding - lost the route while avoiding")
        if st == AvoidanceState.AVOIDING:
            sp = lp.plan(pos, pose.alt_m, pose.yaw_deg, vel, goal_ne, self._engage_alt if self._engage_alt is not None else alt_goal, polar, pp, self._prev_dir)
            self.last_setpoint = sp
            if sp.chosen_deg is not None:
                self._prev_dir = sp.chosen_deg
            if sp.blocked:
                self._blocked_since = self._blocked_since or now
                if self.params.climb_over and now - self._blocked_since >= self.params.climb_after_blocked_s \
                        and getattr(self, "_climb_target", None) is None:
                    target = self._climb_plan(pos, pose, goal_ne, pp, now)
                    if target is not None:
                        self._pre_climb_alt = self._engage_alt if self._engage_alt is not None else pose.alt_m
                        self._climb_target = target
                        self._climb_started = now
                        climb_sp = lp.Setpoint(0.0, 0.0, -self.params.climb_rate_m_s, pose.yaw_deg,
                                               0.0, None, 0.0, ttc, False,
                                               f"no way around - climbing over to {target:.1f} m")
                        self.last_setpoint = climb_sp
                        return _d("avoid", AvoidanceState.CLIMBING, climb_sp.reason, climb_sp)
                if now - self._blocked_since >= self.params.block_hold_s:
                    self._hold_since = now
                    why = getattr(self, "_climb_refusal", None)
                    return _d("hold", AvoidanceState.HOLDING,
                              f"holding - no free direction ({why})" if why else "holding - no free direction")
            else:
                self._blocked_since = None
            if at_goal and not danger:
                self._reset_local()
                self._resumed_at = now
                # The waypoint is as reached as it can be (PX4 wants ~2 m, the
                # clearance keeps us further): hand back at the NEXT one, or PX4
                # heads straight back at the pillar to touch it, and give it a
                # longer settle before any non-danger take-over.
                self._resume_cooldown_s = 8.0
                d = _d("resume", AvoidanceState.NOMINAL,
                       f"waypoint reached ({dist_goal:.1f} m) - on to the next one")
                d.advance = True
                return d
            # Only hand back while heading toward the waypoint (or slow):
            # handing PX4 an aircraft moving away from its target made it
            # brake and turn, sweeping the camera across the obstacle it had
            # just cleared, and avoidance took over again (SITL 18:22:00).
            closing = (vel[0] * (goal_ne[0] - pos[0]) + vel[1] * (goal_ne[1] - pos[1])) / max(dist_goal or 0.0, 1e-6)
            heading_home = math.hypot(*vel) < 1.0 or closing > 0.5
            # After a climb, judge the way at the ORIGINAL height: PX4 flies
            # the mission back down, and must not descend onto the obstacle.
            polar_leg = polar
            if getattr(self, "_pre_climb_alt", None) is not None:
                polar_leg = self.grid.polar(pos[0], pos[1], pp.lookahead_m, pp.sector_deg, now,
                                            min_top_m=self._pre_climb_alt - 1.5)
            if lp.direct_path_clear(polar_leg, pp, pos, goal_ne) and not threat and heading_home:
                self._clear_since = self._clear_since or now
                if now - self._clear_since >= self.params.handback_clear_s:
                    self._reset_local()
                    self._resumed_at = now
                    self._resume_cooldown_s = 3.0
                    return _d("resume", AvoidanceState.NOMINAL, "way to the waypoint is clear - resuming mission")
            else:
                self._clear_since = None
            return _d("avoid", AvoidanceState.AVOIDING, sp.reason, sp)

        if st == AvoidanceState.HOLDING:
            if self._hold_since is None:
                self._hold_since = now
            if not threat:
                if goal_ne is not None and self.intervened:
                    self._hold_since = None
                    self._resumed_at = now
                    return _d("resume", AvoidanceState.NOMINAL, "obstacle gone - resuming mission")
                self._hold_since = None
                return _d("clear", AvoidanceState.NOMINAL, "obstacle gone")
            if can_steer:
                sp = lp.plan(pos, pose.alt_m, pose.yaw_deg, vel, goal_ne, self._engage_alt if self._engage_alt is not None else alt_goal, polar, pp, self._prev_dir)
                if not sp.blocked and sp.speed > 0.2:
                    self._blocked_since = None
                    self._hold_since = None
                    return _d("avoid", AvoidanceState.AVOIDING, "a way around opened - steering", sp)
            held = now - self._hold_since
            if self.params.allow_return and held >= self.params.hold_to_return_s:
                return _d("return", AvoidanceState.RETURNING, f"no way through for {held:.0f}s - returning")
            return _d("hold", AvoidanceState.HOLDING, self._last_reason or "holding")

        if st == AvoidanceState.RETURNING:
            return _d("clear", AvoidanceState.RETURNING, "returning home")
        return _d("clear", st, self._last_reason)

    def local_obstacles(self, now: float | None = None) -> list[dict]:
        """Occupied clusters as lat/lng keep-outs - the map overlay."""
        from app.avoidance.mapping import pose_history
        h = pose_history.history(self.drone_id)
        if h.origin is None:
            return []
        out = []
        for c in self.grid.clusters(now):
            lat, lng = h.to_latlng(c["north_m"], c["east_m"])
            out.append({"lat": lat, "lng": lng, "radius_m": round(c["radius_m"], 1),
                        "top_m": round(c["top_m"], 1), "speed_mps": 0.0,
                        "is_static": c["cells"] >= 3, "hits": c["cells"]})
        return out

    def _safe_speed(self, clearance_m: float) -> float:
        """Speed-governor: scale commanded speed from min_speed (obstacle at the
        clearance ring) up to speed_cap (clear out to the reaction distance).
        Slowing in clutter is what makes dense-environment flight reliable."""
        p = self.params
        lo, hi = p.clearance_m * 1.5, p.reaction_distance_m
        if clearance_m <= lo:
            return p.min_speed_m_s
        if clearance_m >= hi:
            return p.speed_cap_m_s
        f = (clearance_m - lo) / max(1e-6, hi - lo)
        return p.min_speed_m_s + f * (p.speed_cap_m_s - p.min_speed_m_s)

    @staticmethod
    def _path_clear(path: list, keepouts: list[dict]) -> bool:
        """No point on the committed path (waypoints + segment midpoints) sits
        inside any current keep-out."""
        pts = [(float(w["lat"]), float(w["lng"])) for w in path]
        mids = [((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
                for a, b in zip(pts, pts[1:])]
        for plat, plng in pts + mids:
            for k in keepouts:
                if distance_m(plat, plng, k["lat"], k["lng"]) < k["radius_m"]:
                    return False
        return True

    @staticmethod
    def _on_path(pose: Pose, path: list, corridor_m: float = 30.0) -> bool:
        """Is the drone still within a corridor of the committed path? A gross
        deviation (GPS jump, gust) forces a re-plan."""
        best = 1e12
        for w in path:
            best = min(best, distance_m(pose.lat, pose.lng,
                                        float(w["lat"]), float(w["lng"])))
        return best < corridor_m

    def _nearest_threat(self, pose: Pose, goal, mapped):
        """The nearest mapped obstacle within reaction range whose bearing is
        within the cone of the DIRECTION OF TRAVEL (goal bearing on a mission,
        else the nose). Reacting to the path - not just the camera - is what
        makes a second, off-axis obstacle count."""
        import math
        m_lng = 111_320.0 * max(0.2, math.cos(math.radians(pose.lat)))
        if goal is not None:
            travel = math.degrees(math.atan2(
                (goal[1] - pose.lng) * m_lng,
                (goal[0] - pose.lat) * 111_320.0)) % 360.0
        else:
            travel = pose.heading_deg % 360.0
        best, best_d = None, 1e12
        for o in mapped:
            d = distance_m(pose.lat, pose.lng, o.lat, o.lng)
            if d > self.params.reaction_distance_m or d >= best_d:
                continue
            brg = math.degrees(math.atan2(
                (o.lng - pose.lng) * m_lng,
                (o.lat - pose.lat) * 111_320.0)) % 360.0
            if abs((brg - travel + 180) % 360 - 180) <= self.params.forward_cone_deg:
                best, best_d = o, d
        return best

    async def _try_climb_over(self, pose: Pose, goal, mapped, rules, speed):
        """Climb to just above the tallest KNOWN-height blocker and re-plan
        with the now-overflown obstacles removed. Returns a climb Decision, or
        None when nothing can be safely climbed (unknown heights, or a legal
        path still does not exist even up high)."""
        known_tops = [o.top_m for o in mapped if o.top_m > 0]
        if not known_tops:
            return None   # heights unknown -> never climb blind
        target = min(self.params.max_climb_alt_m,
                     max(known_tops) + self.params.climb_step_m)
        if target <= pose.alt_m + 0.5:
            return None
        keepouts = [o.as_keepout() for o in mapped
                    if o.top_m == 0 or o.top_m >= target]
        wps, _ = await reroute_mod.reroute_around(
            (pose.lat, pose.lng), goal, keepouts,
            profile_rules=rules, cruise_alt_m=target, speed_m_s=speed)
        if not wps:
            return None
        for w in wps:   # fly the whole detour at the climb altitude
            if w.get("type") in ("waypoint", "takeoff", None):
                w["altitude"] = max(float(w.get("altitude", target) or target), target)
        return Decision(
            "climb", AvoidanceState.CLIMBING,
            f"no lateral path - climbing to {target:.0f} m over the obstacle",
            obstacle=[o.as_keepout() for o in mapped][0] if mapped else None,
            waypoints=wps, target_alt_m=target, obstacle_count=len(mapped))

    def _hold_or_return(self, now: float, dist: float,
                        keepout: dict, reason: str) -> Decision:
        if self._hold_since is None:
            self._hold_since = now
        held = now - self._hold_since
        if self.params.allow_return and held >= self.params.hold_to_return_s:
            return Decision("return", AvoidanceState.RETURNING,
                            f"no safe path for {held:.0f}s - returning",
                            obstacle=keepout, fused_distance_m=dist)
        return Decision("hold", AvoidanceState.HOLDING,
                        reason, obstacle=keepout, fused_distance_m=dist)

    def _settle(self, d: Decision) -> Decision:
        self.state = d.state
        self._last_reason = d.reason
        return d

    def obstacles(self, now: float | None = None) -> list[dict]:
        """The live map obstacles - for the Mission-tab overlay."""
        now = now if now is not None else time.monotonic()
        if self.params.local_planner:
            return self.local_obstacles(now)
        return [{"lat": o.lat, "lng": o.lng, "radius_m": round(o.radius_m, 1),
                 "top_m": round(o.top_m, 1), "speed_mps": round(o.speed_mps(), 1),
                 "is_static": o.is_static(), "hits": o.hits}
                for o in self.omap.active(now)]

    # -- status -----------------------------------------------------------
    def status(self, now: float | None = None) -> dict:
        now = now if now is not None else time.monotonic()
        return {
            "drone_id": self.drone_id,
            "enabled": self.enabled,
            "armed": self.armed,
            "state": self.state.value,
            "reason": self._last_reason,
            "params": self.params.__dict__,
            "sensors": sensor_registry.inventory(self.drone_id, now),
            "obstacle_count": len(self.grid.clusters(now)) if self.params.local_planner
                              else len(self.omap.active(now)),
            "recommended_speed_m_s": round(self._recommended_speed, 2),
            "committed_path": self._committed_path is not None,
            # Where the loop believes the aircraft is going (None = it will
            # only hold, never reroute) - shown in the Fly-tab panel.
            "goal": list(self._last_goal) if self._last_goal else None,
            "obstacle_distance_cm": self.bus.obstacle_distance_cm(
                now, self.params.min_confidence),
            "sensor_mode": self.sensor_mode(now),
            "following": self.following(now),
            "env": self.env,
            "env_mode": int(round(self.params.env_mode)),
            "env_reason": self.env_reason,
            "pose_source": _pose_source(self.drone_id),
            "guarding": bool(self._guard_active and self.following(now)),
            "scans": dict(self._scans),
            "mono_calibration": self.mono_scale.status(),
            "pose_rate_hz": round(_pose_rate(self.drone_id), 1),
            "planner": None if self.last_setpoint is None else {
                "reason": self.last_setpoint.reason,
                "speed_m_s": round(self.last_setpoint.speed, 2),
                "free_m": round(self.last_setpoint.free_m, 1) if math.isfinite(self.last_setpoint.free_m) else None,
                "ttc_s": round(self.last_setpoint.ttc_s, 1) if self.last_setpoint.ttc_s else None,
                "heading_deg": round(self.last_setpoint.chosen_deg, 0) if self.last_setpoint.chosen_deg is not None else None,
            },
        }


def _pose_source(drone_id: str) -> str | None:
    from app.avoidance.mapping import pose_history
    return pose_history.history(drone_id).source


def _pose_rate(drone_id: str) -> float:
    from app.avoidance.mapping import pose_history
    return pose_history.history(drone_id).rate_hz()


# -- registry -------------------------------------------------------------
_controllers: dict[str, AvoidanceController] = {}


def controller(drone_id: str) -> AvoidanceController:
    c = _controllers.get(drone_id)
    if c is None:
        c = _controllers[drone_id] = AvoidanceController(drone_id)
    return c


def all_status(now: float | None = None) -> list[dict]:
    return [c.status(now) for c in _controllers.values()]


def any_enabled() -> bool:
    """True if any drone has avoidance detection on - lets the vision modules
    skip the obstacle extraction entirely (zero added cost) when nobody is
    using avoidance."""
    return any(c.enabled for c in _controllers.values())


def has_controller(drone_id: str) -> bool:
    return drone_id in _controllers


def reset(drone_id: str | None = None) -> None:
    if drone_id is None:
        _controllers.clear()
    else:
        _controllers.pop(drone_id, None)


# -- persistence ----------------------------------------------------------
# enabled/armed lived only in memory, so every backend restart or code reload
# silently turned avoidance OFF - the drone then flew its mission blind while
# the operator believed it was covered. The file sits OUTSIDE app/ because a
# write inside it would itself trigger uvicorn's reload.
import json as _json
from app.config import ROOT_DIR as _ROOT_DIR

_STATE_FILE = _ROOT_DIR / ".avoidance_state.json"


def persist_state() -> None:
    try:
        _STATE_FILE.write_text(_json.dumps(
            # While the indoor profile is applied, save the OUTDOOR values it
            # replaced: a restart must not turn the indoor numbers into the
            # outdoor defaults. The environment itself is re-decided live.
            {i: {"enabled": c.enabled, "armed": c.armed,
                 "params": {**c.params.__dict__, **(c._outdoor_saved or {})}}
             for i, c in _controllers.items()}, indent=1))
    except Exception:
        pass


def restore_state() -> int:
    """Re-create every controller that was enabled when the state was last
    saved. Returns how many were restored."""
    try:
        data = _json.loads(_STATE_FILE.read_text())
    except Exception:
        return 0
    n = 0
    for i, st in data.items():
        if st.get("enabled"):
            c = controller(i)
            for k, v in (st.get("params") or {}).items():
                if hasattr(c.params, k):
                    try:
                        setattr(c.params, k, float(v))
                    except (TypeError, ValueError):
                        pass
            c.set_enabled(True)
            c.set_armed(bool(st.get("armed")))
            n += 1
    return n
