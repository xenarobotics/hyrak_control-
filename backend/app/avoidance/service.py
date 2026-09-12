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
    # 3D avoidance: when no lateral path exists, climb over (if the obstacle's
    # height is known to be below the ceiling) before holding/returning.
    vertical_enabled: bool = True
    max_climb_alt_m: float = 40.0       # never auto-climb above this
    climb_step_m: float = 4.0           # clearance to add above an obstacle top


@dataclass
class Decision:
    action: str                 # clear | hold | reroute | climb | return
    state: AvoidanceState
    reason: str = ""
    obstacle: dict | None = None      # nearest world keep-out {lat,lng,radius_m}
    waypoints: list | None = None     # reroute/climb path
    fused_distance_m: float | None = None
    target_alt_m: float | None = None  # for a climb-over
    obstacle_count: int = 0            # obstacles the map is tracking


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
            return self._settle(Decision(
                "clear", AvoidanceState.NOMINAL, "path ahead clear",
                obstacle_count=len(mapped)))

        near_ko = threat.as_keepout()
        near_d = distance_m(pose.lat, pose.lng, threat.lat, threat.lng)
        rules = profile_rules if profile_rules is not None else {"categories": {}}
        speed = min(speed_m_s, self.params.speed_cap_m_s)

        if goal is not None:
            # 3. LATERAL: reroute around ALL known obstacles at once (avoids the
            #    cornering that one-at-a-time avoidance falls into), respecting
            #    legal red zones but not soft route preferences. Obstacles the
            #    drone would already overfly at this altitude are excluded.
            keepouts = [o.as_keepout() for o in mapped
                        if o.top_m == 0 or o.top_m >= cruise_alt_m]
            wps, _ = await reroute_mod.reroute_around(
                (pose.lat, pose.lng), goal, keepouts,
                profile_rules=rules, cruise_alt_m=cruise_alt_m, speed_m_s=speed)
            if wps:
                self._hold_since = None
                return self._settle(Decision(
                    "reroute", AvoidanceState.REROUTED,
                    f"rerouting around {len(keepouts)} obstacle(s)",
                    obstacle=near_ko, waypoints=wps,
                    fused_distance_m=near_d, obstacle_count=len(mapped)))

            # 4. VERTICAL: no lateral path -> climb OVER, but only when the
            #    blocker's height is actually known (never climb blind).
            if self.params.vertical_enabled:
                climb = await self._try_climb_over(
                    pose, goal, mapped, rules, speed)
                if climb is not None:
                    self._hold_since = None
                    return self._settle(climb)

        # 5. No lateral or vertical path (or no goal) -> hold, then return.
        return self._settle(self._hold_or_return(
            now, near_d, near_ko,
            "holding - no lateral or vertical path" if goal
            else "holding - manual flight, no route to replan"))

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
        if held >= self.params.hold_to_return_s:
            return Decision("return", AvoidanceState.RETURNING,
                            f"no safe path for {held:.0f}s - returning",
                            obstacle=keepout, fused_distance_m=dist)
        return Decision("hold", AvoidanceState.HOLDING,
                        reason, obstacle=keepout, fused_distance_m=dist)

    def _settle(self, d: Decision) -> Decision:
        self.state = d.state
        self._last_reason = d.reason
        return d

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
