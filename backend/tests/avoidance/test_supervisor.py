"""Supervisor (current path, decide_local) and goal selection - each SITL failure pinned as a test."""
from app.avoidance.core import controller as avoidance
from app.avoidance.core.controller import AvoidanceController, AvoidanceState
from app.avoidance.mapping import pose_history

from avoid_harness import LAT0, LNG0, _one_hit, _controller, _moving


def test_supervisor_takes_control_then_hands_back_to_the_mission():
    c, h = _controller(t=10.0)
    c.grid.pin_disc(10.0, 0.0, 1.0, now=10.0)
    d = c.decide_local((40.0, 0.0), 10.0, now=10.0)
    assert d.action == "avoid" and c.state == AvoidanceState.AVOIDING and d.setpoint
    c.grid.clear()                                   # obstacle behind / gone
    for k in range(1, 30):
        d = c.decide_local((40.0, 0.0), 10.0, now=10.0 + k * 0.1)
        if d.action == "resume":
            break
    assert d.action == "resume" and c.state == AvoidanceState.NOMINAL
    assert (10.0 + k * 0.1) - 10.1 >= c.params.handback_clear_s - 1e-6

def test_no_route_or_reroute_off_means_hold_then_return():
    c, _ = _controller(t=20.0)
    c.grid.pin_disc(8.0, 0.0, 1.0, now=20.0)
    assert c.decide_local(None, None, now=20.0).action == "hold"      # manual flight
    c2, _ = _controller(t=20.0); c2.params.allow_reroute = 0.0
    c2.grid.pin_disc(8.0, 0.0, 1.0, now=20.0)
    assert c2.decide_local((40.0, 0.0), 10.0, now=20.0).action == "hold"
    c2.params.hold_to_return_s = 5.0
    assert c2.decide_local((40.0, 0.0), 10.0, now=26.0).action == "return"

def test_mono_scan_is_dropped_while_a_range_sensor_streams():
    c, _ = _controller(alt=12.0)
    import time as _t
    now = _t.monotonic()
    pose_history.history("sup").add(LAT0, LNG0, 12.0, 0.0, t=now)
    assert c.integrate_scan(_one_hit(), now, "depth")
    assert not c.integrate_scan(_one_hit(), now, "monocular")
    assert c.sensor_mode() == "range"

def test_mono_below_its_minimum_altitude_is_ignored():
    c, _ = _controller(alt=5.0)
    import time as _t
    now = _t.monotonic()
    pose_history.history("sup").add(LAT0, LNG0, 5.0, 0.0, t=now)
    assert not c.integrate_scan(_one_hit(), now, "monocular")      # below 8 m
    assert c.integrate_scan(_one_hit(), now, "depth")              # a range sensor may

def test_no_immediate_retake_after_a_resume():
    c, h = _controller(t=50.0)
    c.grid.pin_disc(12.0, 1.5, 1.0, now=50.0)        # beside the leg, not in the way of a stop
    c._resumed_at = 50.0
    c.state = AvoidanceState.NOMINAL
    d = c.decide_local((40.0, 0.0), 10.0, now=51.0)
    assert d.action == "clear", d.reason              # cooling down, no real danger
    d = c.decide_local((40.0, 0.0), 10.0, now=54.0)
    assert d.action == "avoid"                         # cooldown over, obstacle still on the line

def test_threat_is_judged_along_the_motion_not_toward_a_wrong_goal():
    """PX4 flies south; the derived goal (off by one on a lawnmower) is north,
    with the pillar between. Nothing is ahead of the aircraft: no take-over."""
    c, h = _moving(-3.0, 0.0)
    c.grid.pin_disc(10.0, 0.0, 1.0, now=100.7)            # pillar to the NORTH
    d = c.decide_local((60.0, 0.0), 10.0, now=100.7)       # goal to the north
    assert d.action == "clear", d.reason

def test_pillar_on_the_actual_path_still_triggers():
    c, h = _moving(-3.0, 0.0)
    c.grid.pin_disc(-12.0, 0.0, 1.0, now=100.7)           # pillar to the SOUTH, where it is going
    d = c.decide_local((-60.0, 0.0), 10.0, now=100.7)
    assert d.action == "avoid"

def test_goal_picked_to_match_what_px4_is_flying():
    from app.avoidance.core.loop import pick_goal_by_motion
    h = pose_history.PoseHistory(); h.origin = (LAT0, LNG0)
    north, south = h.to_latlng(60.0, 0.0), h.to_latlng(-60.0, 0.0)
    cands = [(5, north), (6, south)]
    assert pick_goal_by_motion(cands, 5, (0.0, 0.0), (-3.0, 0.0), h.to_ne) == south   # reported 5, flying south
    assert pick_goal_by_motion(cands, 5, (0.0, 0.0), (3.0, 0.0), h.to_ne) == north    # reported 5 and consistent
    assert pick_goal_by_motion(cands, 5, (0.0, 0.0), (0.2, 0.0), h.to_ne) == north    # hovering: trust the report

def test_unknown_mission_index_picks_the_nearest_waypoint_ahead():
    """Lawnmower, current item unknown (-1): flying south down leg 2 - the goal
    is that leg's south end, not waypoint 0 and not a later leg's far end."""
    from app.avoidance.core.loop import pick_goal_by_motion
    h = pose_history.PoseHistory(); h.origin = (LAT0, LNG0)
    legs = [(60.0, 0.0), (-60.0, 0.0), (-60.0, 10.0), (60.0, 10.0), (60.0, 20.0), (-60.0, 20.0)]
    cands = [(k, h.to_latlng(*ne)) for k, ne in enumerate(legs)]
    got = pick_goal_by_motion(cands, -1, (0.0, 10.0), (-3.0, 0.0), h.to_ne)   # on leg 2->... heading south at east=10
    assert got == h.to_latlng(-60.0, 10.0)

def test_steering_holds_the_altitude_it_took_over_at():
    c, h = _moving(3.0, 0.0, alt=9.6)
    c.grid.pin_disc(10.0, 0.0, 1.0, now=100.7)
    d = c.decide_local((60.0, 0.0), 4.0, now=100.7)        # mission altitude says 4 m
    assert d.action == "avoid" and abs(d.setpoint.vd) < 0.05   # no dive (SITL 21:33 sank 9.6 -> 4 m)

def test_handing_back_at_a_reached_waypoint_moves_on_to_the_next():
    c, h = _controller(t=300.0)
    c.grid.pin_disc(41.5, 1.5, 1.0, now=300.0)                 # pillar beside the waypoint
    c.state = AvoidanceState.AVOIDING; c.intervened = True
    lat, lng = h.to_latlng(37.0, -1.0); h.add(lat, lng, 10.0, 0.0, t=300.1)   # 3.2 m from it
    d = c.decide_local((40.0, 0.0), 10.0, now=300.1)
    assert d.action == "resume" and getattr(d, "advance", False), (d.action, d.reason)

def test_clearance_grown_distance_is_not_danger_during_the_settle():
    """PX4 slowing into a waypoint 3.5 m short of a pillar right after a
    hand-back: close by the clearance margin, not a collision course."""
    c, h = _moving(1.2, 0.0, t0=400.0)
    c.grid.pin_disc(0.84 + 3.5 + 1.0, 0.0, 1.0, now=400.7)    # surface ~3.5 m ahead of the aircraft
    c._resumed_at, c._resume_cooldown_s = 400.5, 8.0
    d = c.decide_local((4.0, 0.0), 10.0, now=400.7)
    assert d.action == "clear", d.reason

def test_a_pillar_beyond_the_waypoint_is_not_in_the_way():
    c, h = _moving(3.0, 0.0, t0=500.0)                          # heading north at 3 m/s
    c.grid.pin_disc(0.84 + 9.0, 0.0, 1.0, now=500.7)           # pillar ~9 m ahead, beyond the waypoint
    d = c.decide_local((0.84 + 5.0, 0.0), 10.0, now=500.7)     # waypoint 5 m ahead
    assert d.action == "clear", d.reason


def test_acting_floor_follows_the_sensor():
    """SITL 2026-09-26 22:54: depth camera sensing from 2 m, a fixed 3 m acting
    floor, a mission leg at 2.8 m - the pillar was mapped and avoidance was
    not allowed to act."""
    import time as _t
    c, _ = _controller(alt=2.8)
    now = _t.monotonic()
    assert c.acting_floor_m(now) == 3.0                       # no sensor yet
    pose_history.history("sup").add(LAT0, LNG0, 2.8, 0.0, t=now)
    c.integrate_scan(_one_hit(), now, "depth")
    assert c.acting_floor_m(now) == c.params.range_min_alt_m == 2.0
    m = AvoidanceController("mono"); m.set_enabled(True); m._mono_data_t = now
    assert m.acting_floor_m(now) == m.params.mono_min_alt_m


def test_mission_min_alt_skips_takeoff_and_land():
    from app.telemetry.failsafe_check import mission_min_alt
    wps = [{"type": "takeoff", "altitude": 1.0}, {"altitude": 3.1}, {"alt": 10}, {"type": "land", "altitude": 0}]
    assert mission_min_alt(wps) == 3.1


def test_no_hand_back_while_flying_away_from_the_waypoint():
    """SITL 18:22:00: handed back at 4 m/s AWAY from the waypoint; PX4 braked
    and turned, the camera swept the pillar again and avoidance re-took."""
    c, h = _moving(4.0, 0.0, t0=100.0)              # heading north
    c.state = AvoidanceState.AVOIDING
    for k in range(30):
        d = c.decide_local((-40.0, 0.0), 10.0, now=100.8 + k * 0.1)   # waypoint south
        assert d.action != "resume", d.reason


def test_operator_can_make_avoidance_ignore_the_range_sensor():
    """Webcam trial in SITL: the sim depth camera keeps posting, and range
    always won, so the chosen camera was never used."""
    c, _ = _controller(alt=12.0)
    import time as _t
    now = _t.monotonic()
    pose_history.history("sup").add(LAT0, LNG0, 12.0, 0.0, t=now)
    c.params.use_range_sensor = 0.0
    assert not c.integrate_scan(_one_hit(), now, "depth")
    assert c.sensor_mode() != "range"
    assert c.integrate_scan(_one_hit(), now, "monocular")
    assert c.sensor_mode() == "mono"
