"""Planning: local planner (current), geometry, legacy reroute."""
import math
import pytest
from app.avoidance.core import controller as avoidance
from app.avoidance.planning.geometry import Pose, observation_to_keepout
from app.avoidance.sensing.observations import ObstacleObservation, ObservationBus
from app.avoidance.planning.local_planner import PlannerParams, plan, direct_path_clear

from avoid_harness import _polar_with


def test_planner_steers_around_an_obstacle_on_the_line():
    p = PlannerParams()
    polar = _polar_with([(10.0, 0.0, 1.0)])
    sp = plan((0.0, 0.0), 10.0, 0.0, (0.0, 0.0), (40.0, 0.0), 10.0, polar, p)
    assert not sp.blocked and 10.0 <= abs((sp.chosen_deg + 180) % 360 - 180) <= 60.0
    assert not direct_path_clear(polar, p, (0.0, 0.0), (40.0, 0.0))

def test_planner_turns_to_look_before_moving_sideways():
    p = PlannerParams()
    polar = _polar_with([(6.0, 0.0, 2.5), (6.0, -4.0, 2.5), (6.0, 4.0, 2.5)])
    sp = plan((0.0, 0.0), 10.0, 0.0, (0.0, 0.0), (40.0, 0.0), 10.0, polar, p)
    if not sp.blocked and abs((sp.chosen_deg + 180) % 360 - 180) >= p.sensor_half_fov_deg:
        assert sp.speed == 0.0 and sp.yaw_deg == sp.chosen_deg

def test_planner_brakes_when_closing_fast():
    p = PlannerParams()
    polar = _polar_with([(4.5, 0.0, 1.0)])
    sp = plan((0.0, 0.0), 10.0, 0.0, (3.0, 0.0), (40.0, 0.0), 10.0, polar, p)
    assert sp.speed == 0.0 and sp.ttc_s is not None and sp.ttc_s < 2.0

def test_boxed_in_is_blocked():
    p = PlannerParams()
    ring = [(3.0 * math.cos(math.radians(a)), 3.0 * math.sin(math.radians(a)), 1.0)
            for a in range(0, 360, 20)]
    sp = plan((0.0, 0.0), 10.0, 0.0, (0.0, 0.0), (40.0, 0.0), 10.0, _polar_with(ring), p)
    assert sp.blocked and sp.speed == 0.0

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

@pytest.mark.asyncio
async def test_reroute_appends_goal_when_windowed():
    # Goal well beyond the local window -> the returned mission must END at the
    # real goal, not the rejoin point (a complete mission, no dead end).
    from app.avoidance.planning import reroute as rr
    start, goal = (17.600, 78.120), (17.650, 78.120)   # ~5.5 km, >> window
    wps, err = await rr.reroute_around(start, goal, obstacles=[], cruise_alt_m=10)
    assert wps
    last = wps[-1]
    assert abs(last["lat"] - goal[0]) < 1e-6 and abs(last["lng"] - goal[1]) < 1e-6
