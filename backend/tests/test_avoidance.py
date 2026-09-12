"""Obstacle-avoidance decision core.

The dangerous logic - fusion, world projection, reroute, hold/return - is
tested here against injected obstacles, exactly as it will be flown first in
SITL, so it is trustworthy before it ever commands an aircraft.
"""
import math

import pytest

from app.avoidance import service as avoidance
from app.avoidance import reroute as reroute_mod
from app.avoidance.geometry import Pose, observation_to_keepout
from app.avoidance.observations import ObstacleObservation, ObservationBus
from app.avoidance.service import AvoidanceController, AvoidanceState


@pytest.fixture(autouse=True)
def _clean():
    avoidance.reset()
    yield
    avoidance.reset()


# -- fusion bus -----------------------------------------------------------
def test_nearest_ahead_only_in_forward_cone():
    bus = ObservationBus()
    bus.add(ObstacleObservation(bearing_deg=0, distance_m=5, confidence=0.8, t=100))
    bus.add(ObstacleObservation(bearing_deg=140, distance_m=2, confidence=0.9, t=100))
    near = bus.nearest_ahead(cone_deg=60, min_confidence=0.35, now=100)
    assert near is not None and near.distance_m == 5  # the one behind is ignored


def test_low_confidence_and_stale_are_ignored():
    bus = ObservationBus(ttl_s=2.0)
    bus.add(ObstacleObservation(bearing_deg=0, distance_m=4, confidence=0.1, t=100))
    assert bus.nearest_ahead(min_confidence=0.35, now=100) is None  # low conf
    bus.add(ObstacleObservation(bearing_deg=0, distance_m=4, confidence=0.9, t=100))
    assert bus.nearest_ahead(min_confidence=0.35, now=105) is None  # stale (>ttl)


def test_obstacle_distance_cm_matches_mavlink_shape():
    bus = ObservationBus()
    bus.add(ObstacleObservation(bearing_deg=0, distance_m=3, confidence=0.9, t=100))
    cm = bus.obstacle_distance_cm(now=100)
    assert len(cm) == 72
    assert cm[0] == 300           # 3 m -> 300 cm in the straight-ahead sector
    assert cm[36] == 65535        # nothing behind -> "no reading" sentinel


# -- geometry -------------------------------------------------------------
def test_projection_ahead_is_north_when_heading_north():
    pose = Pose(lat=17.60, lng=78.12, heading_deg=0)
    obs = ObstacleObservation(bearing_deg=0, distance_m=10)
    ko = observation_to_keepout(pose, obs, clearance_m=4)
    assert ko["lat"] > pose.lat                      # pushed north
    assert abs(ko["lng"] - pose.lng) < 1e-6          # not east/west
    assert ko["radius_m"] >= 4                        # clearance included


def test_projection_ahead_is_east_when_heading_east():
    pose = Pose(lat=17.60, lng=78.12, heading_deg=90)
    obs = ObstacleObservation(bearing_deg=0, distance_m=10)
    ko = observation_to_keepout(pose, obs)
    assert ko["lng"] > pose.lng
    assert abs(ko["lat"] - pose.lat) < 1e-6


# -- planner obstacle hook ------------------------------------------------
def test_planner_routes_around_injected_obstacle():
    from app.planner import engine as planner_engine
    start, goal = (17.600, 78.120), (17.610, 78.120)  # due north ~1.1 km
    mid = (17.605, 78.120)                            # dead centre of the line
    clear = planner_engine.plan(start, goal, cruise_alt_m=10)
    assert clear["ok"]
    blocked = planner_engine.plan(start, goal, cruise_alt_m=10,
                                  obstacles=[{"lat": mid[0], "lng": mid[1],
                                              "radius_m": 40}])
    assert blocked["ok"]
    # No waypoint may sit inside the keep-out.
    for wp in blocked["waypoints"]:
        d = math.hypot((wp["lat"] - mid[0]) * 111320,
                       (wp["lng"] - mid[1]) * 111320 * math.cos(math.radians(mid[0])))
        assert d > 30


# -- state machine --------------------------------------------------------
@pytest.mark.asyncio
async def test_disabled_is_always_clear():
    c = AvoidanceController("d1")
    d = await c.decide(Pose(17.6, 78.12, 0), None)
    assert d.action == "clear" and d.state == AvoidanceState.DISABLED


@pytest.mark.asyncio
async def test_far_obstacle_stays_nominal():
    c = AvoidanceController("d1"); c.set_enabled(True)
    c.observe(ObstacleObservation(bearing_deg=0, distance_m=30, confidence=0.9))
    d = await c.decide(Pose(17.6, 78.12, 0), None)
    assert d.action == "clear" and d.state == AvoidanceState.NOMINAL


@pytest.mark.asyncio
async def test_obstacle_on_mission_leg_reroutes():
    c = AvoidanceController("d1"); c.set_enabled(True)
    c.params.reaction_distance_m = 60.0    # room to plan a forward detour
    pose = Pose(17.600, 78.120, heading_deg=0)   # facing north
    goal = (17.610, 78.120)                       # north, ~1.1 km
    # An obstacle 40 m ahead - inside the reaction range, but far enough that
    # a lateral detour around it exists.
    c.observe(ObstacleObservation(bearing_deg=0, distance_m=40, confidence=0.9))
    d = await c.decide(pose, goal, cruise_alt_m=10, speed_m_s=4)
    assert d.action == "reroute"
    assert d.state == AvoidanceState.REROUTED
    assert d.waypoints and len(d.waypoints) >= 2
    assert d.obstacle is not None


@pytest.mark.asyncio
async def test_no_path_holds_then_returns(monkeypatch):
    async def _no_path(*a, **k):
        return None, "boxed in by no-fly zones"
    monkeypatch.setattr(reroute_mod, "reroute_around", _no_path)

    c = AvoidanceController("d1"); c.set_enabled(True)
    c.params.hold_to_return_s = 20.0
    pose = Pose(17.600, 78.120, 0)
    goal = (17.610, 78.120)

    c.observe(ObstacleObservation(bearing_deg=0, distance_m=6, confidence=0.9, t=1000))
    d1 = await c.decide(pose, goal, now=1000)
    assert d1.action == "hold" and d1.state == AvoidanceState.HOLDING

    # Still no path 21 s later -> escalate to return. Re-observe so the
    # obstacle is still fresh (the bus expires stale readings).
    c.observe(ObstacleObservation(bearing_deg=0, distance_m=6, confidence=0.9, t=1021))
    d2 = await c.decide(pose, goal, now=1021)
    assert d2.action == "return" and d2.state == AvoidanceState.RETURNING


@pytest.mark.asyncio
async def test_manual_hover_brakes_with_no_goal():
    c = AvoidanceController("d1"); c.set_enabled(True)
    c.observe(ObstacleObservation(bearing_deg=0, distance_m=5, confidence=0.9))
    d = await c.decide(Pose(17.6, 78.12, 0), None)   # no mission goal
    assert d.action == "hold" and d.state == AvoidanceState.HOLDING
