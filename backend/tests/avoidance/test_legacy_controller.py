"""Legacy decision core (params.local_planner = 0): keep-out map + mission-upload reroute."""
import pytest
from app.avoidance.planning import reroute as reroute_mod
from app.avoidance.planning.geometry import Pose, observation_to_keepout
from app.avoidance.sensing.observations import ObstacleObservation, ObservationBus
from app.avoidance.core.controller import AvoidanceController, AvoidanceState
from app.avoidance.planning.local_planner import PlannerParams, plan, direct_path_clear


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
async def test_receding_horizon_commits_then_tracks():
    c = AvoidanceController("d1"); c.set_enabled(True)
    c.params.reaction_distance_m = 60.0
    pose = Pose(17.600, 78.120, heading_deg=0)
    goal = (17.610, 78.120)
    c.observe(ObstacleObservation(bearing_deg=0, distance_m=40, confidence=0.9))
    d1 = await c.decide(pose, goal, cruise_alt_m=6, speed_m_s=5)
    assert d1.action == "reroute" and c._committed_path is not None
    # Same situation next tick: the committed path is still clear, so TRACK it
    # rather than derive a fresh path from the (drifted) position.
    c.observe(ObstacleObservation(bearing_deg=0, distance_m=40, confidence=0.9))
    d2 = await c.decide(pose, goal, cruise_alt_m=6, speed_m_s=5)
    assert d2.action == "track"

def test_speed_governor_slows_in_clutter():
    c = AvoidanceController("d1")
    c.params.min_speed_m_s = 1.0; c.params.speed_cap_m_s = 5.0
    c.params.clearance_m = 4.0; c.params.reaction_distance_m = 20.0
    assert c._safe_speed(5.0) == 1.0     # inside the clearance ring -> min
    assert c._safe_speed(20.0) == 5.0    # clear to reaction range -> cap
    assert 1.0 < c._safe_speed(13.0) < 5.0   # graded in between

@pytest.mark.asyncio
async def test_hysteresis_tolerates_a_transient_block(monkeypatch):
    c = AvoidanceController("d1"); c.set_enabled(True)
    c.params.reaction_distance_m = 60.0
    pose = Pose(17.600, 78.120, heading_deg=0)
    goal = (17.610, 78.120)
    c.observe(ObstacleObservation(bearing_deg=0, distance_m=40, confidence=0.9))
    d1 = await c.decide(pose, goal, cruise_alt_m=6, speed_m_s=5)
    assert d1.action == "reroute"                       # commits a path
    # A single blip that makes the path look blocked must NOT drop it.
    monkeypatch.setattr(AvoidanceController, "_path_clear",
                        staticmethod(lambda p, k: False))
    c.observe(ObstacleObservation(bearing_deg=0, distance_m=40, confidence=0.9))
    d2 = await c.decide(pose, goal, cruise_alt_m=6, speed_m_s=5)
    assert d2.action == "track"                         # tolerated, still tracking

@pytest.mark.asyncio
async def test_controller_exposes_live_obstacles():
    c = AvoidanceController("d1"); c.set_enabled(True)
    c.params.local_planner = 0.0                  # legacy keep-out map path
    c.observe(ObstacleObservation(bearing_deg=0, distance_m=8, confidence=0.9))
    await c.decide(Pose(17.6, 78.12, 0), None)   # ingests into the map
    obs = c.obstacles()
    assert obs and {"lat", "lng", "radius_m", "is_static"} <= set(obs[0])

@pytest.mark.asyncio
async def test_two_obstacles_are_rerouted_together():
    c = AvoidanceController("d1"); c.set_enabled(True)
    c.params.reaction_distance_m = 60.0
    pose = Pose(17.600, 78.120, heading_deg=0)
    goal = (17.610, 78.120)
    # two obstacles ahead at different bearings - both must be remembered
    c.observe(ObstacleObservation(bearing_deg=-6, distance_m=35, confidence=0.9))
    c.observe(ObstacleObservation(bearing_deg=8, distance_m=45, confidence=0.9))
    d = await c.decide(pose, goal, cruise_alt_m=6, speed_m_s=3)
    assert d.action == "reroute"
    assert d.obstacle_count == 2          # planned around BOTH, not one at a time

@pytest.mark.asyncio
async def test_climb_over_when_lateral_blocked_and_height_known(monkeypatch):
    # Lateral reroute (any keep-out) fails; the climb re-plan, with the short
    # obstacle overflown and excluded, gets a clear path -> CLIMB.
    async def fake(start, goal, obstacles, **k):
        if obstacles:
            return None, "boxed in"
        return [{"lat": goal[0], "lng": goal[1], "type": "waypoint",
                 "altitude": k.get("cruise_alt_m", 10)}], ""
    monkeypatch.setattr(reroute_mod, "reroute_around", fake)

    c = AvoidanceController("d1"); c.set_enabled(True)
    c.params.reaction_distance_m = 40.0
    pose = Pose(17.600, 78.120, heading_deg=0, alt_m=4.0)
    goal = (17.610, 78.120)
    c.observe(ObstacleObservation(bearing_deg=0, distance_m=20, confidence=0.9, top_m=6))
    d = await c.decide(pose, goal, cruise_alt_m=4, speed_m_s=2)
    assert d.action == "climb"
    assert d.state == AvoidanceState.CLIMBING
    assert d.target_alt_m and d.target_alt_m >= 6      # above the 6 m obstacle

@pytest.mark.asyncio
async def test_no_climb_when_height_unknown(monkeypatch):
    async def fake(start, goal, obstacles, **k):
        return (None, "boxed in") if obstacles else ([], "")
    monkeypatch.setattr(reroute_mod, "reroute_around", fake)
    c = AvoidanceController("d1"); c.set_enabled(True)
    c.params.reaction_distance_m = 40.0
    pose = Pose(17.600, 78.120, 0, alt_m=4.0)
    goal = (17.610, 78.120)
    c.observe(ObstacleObservation(bearing_deg=0, distance_m=20, confidence=0.9))  # top_m=0
    d = await c.decide(pose, goal, cruise_alt_m=4)
    assert d.action in ("hold", "return")   # never climb over an unknown height

@pytest.mark.asyncio
async def test_manual_hover_brakes_with_no_goal():
    c = AvoidanceController("d1"); c.set_enabled(True)
    c.observe(ObstacleObservation(bearing_deg=0, distance_m=5, confidence=0.9))
    d = await c.decide(Pose(17.6, 78.12, 0), None)   # no mission goal
    assert d.action == "hold" and d.state == AvoidanceState.HOLDING
