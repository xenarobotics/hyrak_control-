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

import time
from dataclasses import dataclass, field
from enum import Enum

from app.avoidance import reroute as reroute_mod
from app.avoidance import sensors as sensor_registry
from app.avoidance.geometry import Pose, distance_m, observation_to_keepout
from app.avoidance.obstacle_map import ObstacleMap
from app.avoidance.observations import ObservationBus, ObstacleObservation


class AvoidanceState(str, Enum):
    NOMINAL = "nominal"
    HOLDING = "holding"
    REROUTED = "rerouted"
    CLIMBING = "climbing"
    RETURNING = "returning"
    DISABLED = "disabled"


@dataclass
class AvoidanceParams:
    reaction_distance_m: float = 12.0   # react to obstacles within this range
    clearance_m: float = 4.0            # keep-out radius padding around one
    forward_cone_deg: float = 60.0      # only obstacles this far off the nose
    min_confidence: float = 0.35        # ignore observations below this
    speed_cap_m_s: float = 4.0          # cap commanded speed while enabled
    hold_to_return_s: float = 20.0      # holding with no path this long -> RTL
    # Response preference (1/0 flags so the params endpoint's float setter
    # applies): the order is always reroute -> hold -> return; these say how
    # far down that ladder the loop may go on its own.
    allow_reroute: float = 1.0          # 0: never re-plan, hold instead
    allow_return: float = 1.0           # 0: never escalate a hold to RTL
    # 3D avoidance: when no lateral path exists, climb over (if the obstacle's
    # height is known to be below the ceiling) before holding/returning.
    vertical_enabled: bool = True
    max_climb_alt_m: float = 40.0       # never auto-climb above this
    climb_step_m: float = 4.0           # clearance to add above an obstacle top
    # Speed governor: slow down in clutter. Commanded speed scales from
    # min_speed_m_s (obstacle at the clearance ring) up to speed_cap_m_s (clear
    # to the reaction distance). Predict dynamic obstacles this far ahead.
    min_speed_m_s: float = 1.0
    prediction_horizon_s: float = 1.5


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

    # -- ingest -----------------------------------------------------------
    def observe(self, obs: ObstacleObservation) -> None:
        self.bus.add(obs)
        sensor_registry.mark_data(self.drone_id, obs.source)

    def set_enabled(self, on: bool) -> None:
        self.enabled = on
        if not on:
            self.armed = False
            self.state = AvoidanceState.DISABLED
            self._hold_since = None
            self.intervened = False
            self.bus.clear()
            self.omap.clear()
            self._committed_path = None
            self._committed_goal = None
            self._path_invalid = 0
        elif self.state == AvoidanceState.DISABLED:
            self.state = AvoidanceState.NOMINAL

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
        self._committed_path = None
        return self._settle(self._hold_or_return(
            now, near_d, near_ko,
            "holding - rerouting disabled by operator" if (goal and not self.params.allow_reroute)
            else "holding - no lateral or vertical path" if goal
            else "holding - manual flight, no route to replan"))

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
            "obstacle_count": len(self.omap.active(now)),
            "recommended_speed_m_s": round(self._recommended_speed, 2),
            "committed_path": self._committed_path is not None,
            # Where the loop believes the aircraft is going (None = it will
            # only hold, never reroute) - shown in the Fly-tab panel.
            "goal": list(self._last_goal) if self._last_goal else None,
            "obstacle_distance_cm": self.bus.obstacle_distance_cm(
                now, self.params.min_confidence),
        }


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
            {i: {"enabled": c.enabled, "armed": c.armed}
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
            c.set_enabled(True)
            c.set_armed(bool(st.get("armed")))
            n += 1
    return n
