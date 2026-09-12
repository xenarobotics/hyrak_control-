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
from app.avoidance.geometry import Pose, observation_to_keepout
from app.avoidance.observations import ObservationBus, ObstacleObservation


class AvoidanceState(str, Enum):
    NOMINAL = "nominal"
    HOLDING = "holding"
    REROUTED = "rerouted"
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


@dataclass
class Decision:
    action: str                 # clear | hold | reroute | return
    state: AvoidanceState
    reason: str = ""
    obstacle: dict | None = None      # world keep-out {lat,lng,radius_m}
    waypoints: list | None = None     # reroute path (action == reroute)
    fused_distance_m: float | None = None


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

        obs = self.bus.nearest_ahead(
            cone_deg=self.params.forward_cone_deg,
            min_confidence=self.params.min_confidence, now=now)
        if obs is None or obs.distance_m > self.params.reaction_distance_m:
            self._hold_since = None
            return self._settle(Decision(
                "clear", AvoidanceState.NOMINAL, "forward cone clear",
                fused_distance_m=(obs.distance_m if obs else None)))

        keepout = observation_to_keepout(pose, obs, self.params.clearance_m)

        # Mission leg present -> try to reroute around it, airspace-legal.
        if goal is not None:
            wps, err = await reroute_mod.reroute_around(
                (pose.lat, pose.lng), goal, [keepout],
                profile_rules=profile_rules,
                cruise_alt_m=cruise_alt_m,
                speed_m_s=min(speed_m_s, self.params.speed_cap_m_s))
            if wps:
                self._hold_since = None
                return self._settle(Decision(
                    "reroute", AvoidanceState.REROUTED,
                    f"obstacle {obs.distance_m:.1f} m ahead - rerouted",
                    obstacle=keepout, waypoints=wps,
                    fused_distance_m=obs.distance_m))
            # No legal way around: hold, and escalate to return if it persists.
            return self._settle(self._hold_or_return(now, obs, keepout, err))

        # Manual / hover, no goal to reroute toward -> brake and hold.
        return self._settle(self._hold_or_return(
            now, obs, keepout, "holding - manual flight, no route to replan"))

    def _hold_or_return(self, now: float, obs: ObstacleObservation,
                        keepout: dict, reason: str) -> Decision:
        if self._hold_since is None:
            self._hold_since = now
        held = now - self._hold_since
        if held >= self.params.hold_to_return_s:
            return Decision("return", AvoidanceState.RETURNING,
                            f"no safe path for {held:.0f}s - returning",
                            obstacle=keepout, fused_distance_m=obs.distance_m)
        return Decision("hold", AvoidanceState.HOLDING,
                        reason, obstacle=keepout,
                        fused_distance_m=obs.distance_m)

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
