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


# -- v3: receding horizon, speed governor, dynamic prediction ------------
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


def test_dynamic_obstacle_velocity_is_estimated_and_predicted():
    from app.avoidance.obstacle_map import ObstacleMap
    m = ObstacleMap()
    m.add({"lat": 17.600, "lng": 78.120, "radius_m": 3}, now=100.0)
    # ~2.1 m east in 0.4 s (within the 5 m merge radius) = a ~5 m/s mover
    m.add({"lat": 17.600, "lng": 78.12002, "radius_m": 3}, now=100.4)
    o = m.active(now=100.4)[0]
    assert o.hits == 2 and o.ve_mps > 1.5   # merged, moving east
    pk = o.predicted_keepout(1.5)
    assert pk["lng"] > o.lng              # keep-out leads where it is going
    assert pk["radius_m"] > o.radius_m    # grown to cover the swept path


# -- persistent hazard map -----------------------------------------------
def test_static_obstacle_is_confirmed_but_mover_is_not():
    from app.avoidance.obstacle_map import ObstacleMap
    m = ObstacleMap()
    for k in range(4):                       # stationary, seen 4x
        m.add({"lat": 17.60, "lng": 78.12, "radius_m": 3}, now=100.0 + k * 0.3)
    assert m.active(now=101.2)[0].is_static()   # -> written to the hazard map

    m2 = ObstacleMap()
    m2.add({"lat": 17.60, "lng": 78.12, "radius_m": 3}, now=200.0)
    m2.add({"lat": 17.60, "lng": 78.12003, "radius_m": 3}, now=200.4)  # ~8 m/s
    m2.add({"lat": 17.60, "lng": 78.12006, "radius_m": 3}, now=200.8)
    assert not m2.active(now=200.8)[0].is_static()   # a mover is never a hazard


@pytest.mark.asyncio
async def test_controller_exposes_live_obstacles():
    c = AvoidanceController("d1"); c.set_enabled(True)
    c.observe(ObstacleObservation(bearing_deg=0, distance_m=8, confidence=0.9))
    await c.decide(Pose(17.6, 78.12, 0), None)   # ingests into the map
    obs = c.obstacles()
    assert obs and {"lat", "lng", "radius_m", "is_static"} <= set(obs[0])


# -- v2: obstacle map, multi-obstacle, climb-over ------------------------
def test_obstacle_map_merges_nearby_keeps_distinct_and_expires():
    from app.avoidance.obstacle_map import ObstacleMap
    m = ObstacleMap(ttl_s=5.0, merge_dist_m=5.0)
    m.add({"lat": 17.60, "lng": 78.12, "radius_m": 4}, top_m=6, confidence=0.5, now=100)
    m.add({"lat": 17.600005, "lng": 78.12, "radius_m": 7}, confidence=0.9, now=101)  # ~0.5m -> merge
    m.add({"lat": 17.602, "lng": 78.12, "radius_m": 3}, now=101)                     # ~220m -> distinct
    act = m.active(now=101)
    assert len(act) == 2
    merged = min(act, key=lambda o: abs(o.lat - 17.60))
    assert merged.radius_m == 7 and merged.top_m == 6 and merged.hits == 2
    assert m.active(now=200) == []   # both expired past ttl


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


def test_arm_requires_enabled():
    c = AvoidanceController("d1")
    c.set_armed(True)
    assert c.armed is False           # cannot arm while detection is off
    c.set_enabled(True); c.set_armed(True)
    assert c.armed is True
    c.set_enabled(False)
    assert c.armed is False           # disabling detection disarms control


# -- executor -------------------------------------------------------------
class _FakeManager:
    def __init__(self, connected=True, upload_ok=True):
        self.is_connected = connected
        self._upload_ok = upload_ok
        self.calls = []

    async def set_flight_mode(self, mode):
        self.calls.append(("mode", mode)); return True

    async def upload_mission(self, waypoints, terrain_follow=False):
        self.calls.append(("upload", len(waypoints)))
        return self._upload_ok, "" if self._upload_ok else "boom"

    async def start_mission(self):
        self.calls.append(("start", None)); return True


@pytest.mark.asyncio
async def test_executor_hold_and_return_use_flight_modes():
    from app.avoidance import executor
    m = _FakeManager()
    did, _ = await executor.apply(m, "hold", None, intervened=False)
    assert did and ("mode", "HOLD") in m.calls
    await executor.apply(m, "return", None, intervened=True)
    assert ("mode", "RETURN") in m.calls


@pytest.mark.asyncio
async def test_executor_reroute_uploads_then_starts():
    from app.avoidance import executor
    m = _FakeManager()
    did, _ = await executor.apply(m, "reroute", [{"lat": 1, "lng": 2}], False)
    assert did
    assert ("upload", 1) in m.calls and ("start", None) in m.calls


@pytest.mark.asyncio
async def test_executor_clear_resumes_only_if_intervened():
    from app.avoidance import executor
    m = _FakeManager()
    did, _ = await executor.apply(m, "clear", None, intervened=False)
    assert did is False and m.calls == []          # never touched an untouched drone
    did, _ = await executor.apply(m, "clear", None, intervened=True)
    assert did and ("start", None) in m.calls      # hands control back


@pytest.mark.asyncio
async def test_executor_no_link_commands_nothing():
    from app.avoidance import executor
    did, note = await executor.apply(_FakeManager(connected=False), "hold",
                                     None, False)
    assert did is False and note == "no link"


# -- monocular detector ---------------------------------------------------
def test_detector_clear_view_returns_none():
    import numpy as np
    from app.avoidance.detector import observation_from_depth
    depth = np.full((100, 200), 50.0)              # everything beyond range
    assert observation_from_depth(depth, max_distance_m=30) is None


def test_detector_finds_near_blob_and_its_bearing():
    import numpy as np
    from app.avoidance.detector import observation_from_depth
    depth = np.full((100, 200), 25.0)
    depth[30:70, 20:45] = 3.0                       # near blob, left of centre
    obs = observation_from_depth(depth, hfov_deg=70)
    assert obs is not None
    assert obs.source == "monocular"
    assert 2.5 < obs.distance_m < 3.5
    assert obs.bearing_deg < 0                       # left = negative bearing
    assert obs.confidence <= 0.55                    # capped assist-grade


def test_dense_depth_extraction_preserves_gaps():
    import numpy as np
    from app.avoidance.detector import observations_from_depth
    depth = np.full((100, 200), 25.0)
    depth[30:70, 20:45] = 3.0     # near obstacle on the LEFT
    depth[30:70, 150:175] = 3.0   # near obstacle on the RIGHT
    # the middle columns stay far = a GAP the drone can fly through
    obs = observations_from_depth(depth, hfov_deg=70, bin_deg=8)
    assert len(obs) >= 2
    near = [o for o in obs if o.distance_m < 10]
    bearings = sorted(o.bearing_deg for o in near)
    assert bearings[0] < -5 and bearings[-1] > 5    # one left, one right
    # the gap straight ahead is NOT reported as a near obstacle
    assert not any(abs(o.bearing_deg) < 4 and o.distance_m < 10 for o in obs)


def test_detector_center_blob_is_straight_ahead():
    import numpy as np
    from app.avoidance.detector import observation_from_depth
    depth = np.full((100, 200), 25.0)
    depth[30:70, 90:110] = 4.0
    obs = observation_from_depth(depth)
    assert obs is not None and abs(obs.bearing_deg) < 6


# -- vision -> avoidance bridge -------------------------------------------
def test_observe_from_session_feeds_enabled_drone():
    import types
    from app.avoidance import loop, service
    c = service.controller("droneX"); c.set_enabled(True)
    sess = types.SimpleNamespace(drone={"id": "droneX"})
    loop._session_manager = types.SimpleNamespace(get=lambda sid: sess)
    try:
        loop.observe_from_session("sess1", {"bearing_deg": 0, "distance_m": 6,
                                            "confidence": 0.5, "source": "monocular"})
        near = c.bus.nearest_ahead(cone_deg=60, min_confidence=0.3)
        assert near is not None and abs(near.distance_m - 6) < 0.01
    finally:
        loop._session_manager = None


def test_observe_from_session_ignores_disabled_drone():
    import types
    from app.avoidance import loop, service
    c = service.controller("droneY")   # NOT enabled
    sess = types.SimpleNamespace(drone={"id": "droneY"})
    loop._session_manager = types.SimpleNamespace(get=lambda sid: sess)
    try:
        loop.observe_from_session("s", {"bearing_deg": 0, "distance_m": 5})
        assert c.bus.nearest_ahead() is None   # nothing fed to a disabled drone
    finally:
        loop._session_manager = None


def test_any_enabled():
    from app.avoidance import service
    assert service.any_enabled() is False
    service.controller("d").set_enabled(True)
    assert service.any_enabled() is True


@pytest.mark.asyncio
async def test_reroute_appends_goal_when_windowed():
    # Goal well beyond the local window -> the returned mission must END at the
    # real goal, not the rejoin point (a complete mission, no dead end).
    from app.avoidance import reroute as rr
    start, goal = (17.600, 78.120), (17.650, 78.120)   # ~5.5 km, >> window
    wps, err = await rr.reroute_around(start, goal, obstacles=[], cruise_alt_m=10)
    assert wps
    last = wps[-1]
    assert abs(last["lat"] - goal[0]) < 1e-6 and abs(last["lng"] - goal[1]) < 1e-6
