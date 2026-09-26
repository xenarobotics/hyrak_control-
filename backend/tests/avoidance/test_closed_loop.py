"""Closed-loop kinematic runs through the real sensing -> grid -> supervisor -> planner code (no Gazebo)."""
import pytest
from app.avoidance.core import controller as avoidance

from avoid_harness import _fly, _fly_route


@pytest.mark.parametrize("name,cyl", [
    ("head-on", [(30.0, 0.0, 1.0)]),
    ("offset left", [(30.0, -1.2, 1.0)]),
    ("offset right", [(30.0, 1.5, 1.5)]),
    ("two in line", [(25.0, 0.0, 1.0), (45.0, 2.0, 1.0)]),
    ("gate", [(30.0, -5.0, 1.5), (30.0, 5.0, 1.5)]),
])
def test_closed_loop_mission_leg_through_cylinders(name, cyl):
    r = _fly(cyl)
    assert r["reached"], (name, r)
    assert r["min_clear"] > 1.5, (name, r)          # never closer than 1.5 m to a surface

def test_waypoint_next_to_an_obstacle_is_reached_not_orbited():
    """SITL 2026-09-26 17:33: the waypoint sat inside an obstacle's clearance,
    the planner could never call the way to it clear, and orbited it in
    Offboard. It must hand back to the mission once it is close enough."""
    r = _fly([(60.0, 2.5, 1.0)], goal=(60.0, 0.0), max_t=60.0)
    assert r["reached"], r
    assert r["events"].count("avoid") <= 2, r        # no take-over / hand-back ping-pong

def test_route_with_waypoints_beside_pillars_does_not_ping_pong():
    """SITL 2026-09-26 21:57-21:59: waypoints 16, 18 and 21 sat within the
    clearance of a pillar; the aircraft handed back to the SAME waypoint,
    PX4 chased it toward the pillar, avoidance re-took it within 1-2 s - 3 to
    6 cycles at each. Each waypoint may cost at most two take-overs."""
    route = [(40.0, 0.0), (40.0, 30.0), (0.0, 30.0), (0.0, 60.0)]
    pillars = [(41.5, 1.5, 1.0),       # beside waypoint 0
               (38.0, 31.8, 1.0),      # beside waypoint 1
               (20.0, 30.5, 1.0),      # on the leg 1 -> 2
               (-1.2, 61.5, 1.0)]      # beside the LAST waypoint
    r = _fly_route(route, pillars)
    assert r["done"], r
    assert max(r["takeovers"]) <= 2, r
    assert r["min_clear"] > 0.8, r
