"""The avoidance redesign (docs/AVOIDANCE_ARCHITECTURE_REVIEW.md section 5):
pose history (B), depth scan + occupancy grid (A/2), local planner (C),
mono ground-plane calibration (D) - and a closed-loop kinematic run that
flies a mission leg through cylinders with a synthetic depth camera, so the
whole chain is exercised without Gazebo."""
import math

import numpy as np
import pytest

from app.avoidance import pose_history
from app.avoidance.depth_scan import ScanBin, scan_from_depth, vfov_for
from app.avoidance.local_map import OccupancyGrid
from app.avoidance.local_planner import PlannerParams, plan, direct_path_clear
from app.avoidance.mono_calibration import fit_scale
from app.avoidance.service import AvoidanceController, AvoidanceState

LAT0, LNG0 = 17.596569, 78.125203


@pytest.fixture(autouse=True)
def _fresh():
    pose_history.reset()
    yield
    pose_history.reset()


# ---------------------------------------------------------------- pose history
def test_pose_at_capture_interpolates_position_and_wraps_heading():
    h = pose_history.PoseHistory()
    h.add(LAT0, LNG0, 10.0, 350.0, t=100.0)
    lat1 = LAT0 + 10.0 / 111_320.0
    h.add(lat1, LNG0, 12.0, 10.0, t=101.0)
    p = h.at(100.5)
    assert p.north_m == pytest.approx(5.0, abs=0.01)
    assert p.alt_m == pytest.approx(11.0)
    assert p.yaw_deg == pytest.approx(0.0, abs=0.01)     # 350 -> 10 the short way
    assert h.at(99.0).t == 100.0 and h.at(105.0).t == 101.0   # clamped, never extrapolated


def test_velocity_from_position_history():
    h = pose_history.PoseHistory()
    for k in range(11):
        h.add(LAT0 + (k * 0.3) / 111_320.0, LNG0, 10.0, 0.0, t=200.0 + k * 0.1)
    vn, ve = h.velocity_ne()
    assert vn == pytest.approx(3.0, rel=0.05) and abs(ve) < 0.05


# ---------------------------------------------------------------- grid
def _one_hit(bearing=0.0, rng=10.0):
    return [ScanBin(bearing_deg=bearing, half_width_deg=1.0, hit_m=rng, free_m=rng)]


def test_range_sensor_hit_is_occupied_at_once_mono_needs_agreement():
    g = OccupancyGrid()
    g.integrate(0, 0, 0, _one_hit(), "depth", now=1.0)
    assert g.occupied(now=1.0)
    m = OccupancyGrid()
    m.integrate(0, 0, 0, _one_hit(), "monocular", now=1.0)
    m.integrate(0, 0, 0, _one_hit(), "monocular", now=1.1)
    assert not m.occupied(now=1.1)                 # two mono frames: not yet
    m.integrate(0, 0, 0, _one_hit(), "monocular", now=1.2)
    assert m.occupied(now=1.2)                     # three agreeing frames


def test_seeing_through_a_phantom_erases_it():
    g = OccupancyGrid()
    for k in range(3):
        g.integrate(0, 0, 0, _one_hit(rng=8.0), "monocular", now=1.0 + k * 0.1)
    assert g.occupied(now=1.3)
    free = [ScanBin(bearing_deg=0.0, half_width_deg=1.0, hit_m=None, free_m=18.0)]
    for k in range(6):
        g.integrate(0, 0, 0, free, "monocular", now=1.4 + k * 0.1)
    assert not g.occupied(now=2.0)


def test_polar_histogram_points_at_the_obstacle():
    g = OccupancyGrid()
    g.integrate(0, 0, 90.0, _one_hit(0.0, 12.0), "depth", now=1.0)   # nose east
    polar = g.polar(0, 0, 20.0, 5.0, now=1.0)
    s = min(range(len(polar)), key=lambda i: polar[i])
    assert 85.0 <= (s + 0.5) * 5.0 <= 95.0 and 10.5 < polar[s] < 12.5


# ---------------------------------------------------------------- depth scan
def _ground_and_wall(rows, cols, hfov, vfov, alt, wall_x=None, pitch_deg=0.0):
    """Z-depth image for a camera on an aircraft pitched by pitch_deg over flat
    ground, optionally with a 2 m wide wall of unlimited height at wall_x."""
    th, tv = math.tan(math.radians(hfov / 2)), math.tan(math.radians(vfov / 2))
    z = np.full((rows, cols), np.inf)
    p = math.radians(pitch_deg)
    for r in range(rows):
        for c in range(cols):
            u = ((c + .5) / cols * 2 - 1) * th
            v = ((r + .5) / rows * 2 - 1) * tv
            xl = math.cos(p) + v * math.sin(p)
            zl = -math.sin(p) + v * math.cos(p)
            best = alt / zl if zl > 1e-4 else np.inf
            if wall_x is not None and xl > 0:
                t = wall_x / xl
                if abs(u * t) < 1.0 and t < best:
                    best = t
            z[r, c] = best
    return z


def test_ground_is_never_an_obstacle_even_low_and_pitched():
    hfov = 73.0; vfov = vfov_for(hfov, 640, 480)
    for alt, pitch in ((3.0, 0.0), (5.0, -8.0), (10.0, 5.0)):
        z = _ground_and_wall(48, 64, hfov, vfov, alt, None, pitch)
        scan = scan_from_depth(z, hfov, vfov, alt_m=alt, pitch_deg=pitch, max_range_m=19.1)
        assert not any(b.hit_m for b in scan), (alt, pitch)


def test_wall_ahead_found_at_its_range_through_a_nose_down_pitch():
    hfov = 73.0; vfov = vfov_for(hfov, 640, 480)
    z = _ground_and_wall(48, 64, hfov, vfov, 10.0, wall_x=14.0, pitch_deg=-6.0)
    scan = scan_from_depth(z, hfov, vfov, alt_m=10.0, pitch_deg=-6.0, max_range_m=19.1)
    hits = [b for b in scan if b.hit_m is not None]
    assert hits and all(abs(b.bearing_deg) < 7 for b in hits)
    assert min(b.hit_m for b in hits) == pytest.approx(14.0, abs=0.6)


# ---------------------------------------------------------------- calibration
def test_ground_plane_fit_recovers_mono_scale():
    hfov = 99.7; vfov = vfov_for(hfov, 640, 480)
    z = _ground_and_wall(60, 80, hfov, vfov, 12.0, wall_x=15.0)
    z = np.where(np.isinf(z), np.nan, z)
    rng = np.random.default_rng(3)
    pred = z * 0.72 * (1 + rng.normal(0, 0.06, z.shape))
    f = fit_scale(pred, hfov, vfov, alt_m=12.0)
    assert f is not None and f.scale == pytest.approx(1 / 0.72, rel=0.03)
    assert f.error_pct < 10


# ---------------------------------------------------------------- planner
def _polar_with(obstacles, pos=(0.0, 0.0), radius=18.0):
    g = OccupancyGrid()
    for n, e, r in obstacles:
        g.pin_disc(n, e, r)
    return g.polar(pos[0], pos[1], radius, 5.0)


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


# ---------------------------------------------------------------- supervisor
def _controller(pos_ne=(0.0, 0.0), yaw=0.0, alt=10.0, t=None):
    c = AvoidanceController("sup"); c.set_enabled(True)
    h = pose_history.history("sup")
    h.origin = (LAT0, LNG0)
    lat, lng = h.to_latlng(*pos_ne)
    h.add(lat, lng, alt, yaw, t=t)
    return c, h


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


# ---------------------------------------------------------------- closed loop
HFOV, RANGE = 73.0, 19.1


def _synthetic_scan(pos, yaw_deg, cylinders):
    """Ray-cast a 73 deg / 19.1 m depth camera against vertical cylinders."""
    out = []
    for b in np.arange(-HFOV / 2 + 1.0, HFOV / 2, 2.0):
        a = math.radians(yaw_deg + b)
        dn, de = math.cos(a), math.sin(a)
        best = None
        for cn, ce, r in cylinders:
            fn, fe = pos[0] - cn, pos[1] - ce
            B = fn * dn + fe * de
            C = fn * fn + fe * fe - r * r
            disc = B * B - C
            if disc >= 0:
                t = -B - math.sqrt(disc)
                if 0.2 < t < RANGE and (best is None or t < best):
                    best = t
        out.append(ScanBin(bearing_deg=float(b), half_width_deg=1.0, hit_m=best,
                           free_m=best if best is not None else RANGE, top_m=20.0 if best else 0.0))
    return out


def _fly(cylinders, goal=(80.0, 0.0), cruise=3.0, max_t=90.0, dt=0.1):
    """PX4 stand-in: MISSION flies straight at the goal at cruise; OFFBOARD
    tracks the setpoint with a 0.4 s lag and a 90 deg/s yaw limit."""
    c = AvoidanceController("loop"); c.set_enabled(True); c.set_armed(True)
    c.params.speed_cap_m_s = cruise
    h = pose_history.history("loop"); h.origin = (LAT0, LNG0)
    pos, vel, yaw, t = [0.0, 0.0], [0.0, 0.0], 0.0, 1000.0
    mode, min_clear, events = "MISSION", math.inf, []
    while t < 1000.0 + max_t:
        lat, lng = h.to_latlng(*pos)
        h.add(lat, lng, 10.0, yaw, t=t)
        c.integrate_scan(_synthetic_scan(pos, yaw, cylinders), t, "depth")
        d = c.decide_local(goal, 10.0, now=t)
        if d.action == "avoid":
            mode, want = "OFFBOARD", (d.setpoint.vn, d.setpoint.ve)
            dy = (d.setpoint.yaw_deg - yaw + 180) % 360 - 180
            yaw = (yaw + max(-9.0, min(9.0, dy))) % 360
        elif d.action == "hold":
            mode, want = "HOLD", (0.0, 0.0)
        elif d.action == "resume":
            mode = "MISSION"
        if d.action in ("avoid", "hold", "resume", "return") and (not events or events[-1] != d.action):
            events.append(d.action)
        if mode == "MISSION":
            dn, de = goal[0] - pos[0], goal[1] - pos[1]
            dist = math.hypot(dn, de)
            if dist < 1.0:
                return {"reached": True, "min_clear": min_clear, "t": t - 1000.0, "events": events}
            want = (cruise * dn / dist, cruise * de / dist)
            dy = (math.degrees(math.atan2(de, dn)) - yaw + 180) % 360 - 180
            yaw = (yaw + max(-9.0, min(9.0, dy))) % 360
        a = dt / 0.4
        vel = [vel[0] + (want[0] - vel[0]) * a, vel[1] + (want[1] - vel[1]) * a]
        pos = [pos[0] + vel[0] * dt, pos[1] + vel[1] * dt]
        for cn, ce, r in cylinders:
            min_clear = min(min_clear, math.hypot(pos[0] - cn, pos[1] - ce) - r)
        t += dt
    return {"reached": False, "min_clear": min_clear, "t": max_t, "events": events}


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


# ---------------------------------------------------------------- executor
@pytest.mark.asyncio
async def test_local_executor_enters_offboard_once_streams_then_holds_and_resumes():
    from types import SimpleNamespace as NS
    from app.avoidance import executor
    from app.avoidance.service import Decision

    class Link:
        def __init__(self):
            self.calls, self.is_connected, self._offboard_active = [], True, False
            self._snapshot = NS(flight_mode=NS(mode="MISSION"))
        async def start_offboard(self):
            self.calls.append("offboard"); self._offboard_active = True; return True
        async def send_velocity_ned(self, *a):
            self.calls.append("ned")
        async def set_flight_mode(self, m):
            self.calls.append(m); self._snapshot.flight_mode.mode = m; return True
        def release_offboard_state(self):
            self._offboard_active = False
        async def resume_mission_from_offboard(self, i):
            self.calls.append(f"resume@{i}"); return True

    link, c = Link(), AvoidanceController("ex"); c.set_enabled(True)
    for _ in range(3):
        d = Decision("avoid", AvoidanceState.AVOIDING, "")
        d.setpoint = NS(vn=2.0, ve=0.5, vd=0.0, yaw_deg=14.0)
        assert (await executor.apply_local(link, c, d, 4))[0]
    assert (await executor.apply_local(link, c, Decision("hold", AvoidanceState.HOLDING, ""), 4))[0]
    assert not (await executor.apply_local(link, c, Decision("hold", AvoidanceState.HOLDING, ""), 4))[0]
    assert (await executor.apply_local(link, c, Decision("resume", AvoidanceState.NOMINAL, ""), 4))[0]
    assert link.calls == ["offboard", "ned", "ned", "ned", "HOLD", "resume@4"]
    assert not c.intervened


def test_waypoint_next_to_an_obstacle_is_reached_not_orbited():
    """SITL 2026-09-26 17:33: the waypoint sat inside an obstacle's clearance,
    the planner could never call the way to it clear, and orbited it in
    Offboard. It must hand back to the mission once it is close enough."""
    r = _fly([(60.0, 2.5, 1.0)], goal=(60.0, 0.0), max_t=60.0)
    assert r["reached"], r
    assert r["events"].count("avoid") <= 2, r        # no take-over / hand-back ping-pong


def test_no_immediate_retake_after_a_resume():
    c, h = _controller(t=50.0)
    c.grid.pin_disc(12.0, 1.5, 1.0, now=50.0)        # beside the leg, not in the way of a stop
    c._resumed_at = 50.0
    c.state = AvoidanceState.NOMINAL
    d = c.decide_local((40.0, 0.0), 10.0, now=51.0)
    assert d.action == "clear", d.reason              # cooling down, no real danger
    d = c.decide_local((40.0, 0.0), 10.0, now=54.0)
    assert d.action == "avoid"                         # cooldown over, obstacle still on the line


# ---------------------------------------------------------------- SITL 21:33 loop
def _moving(vn, ve, t0=100.0, n=8, alt=10.0):
    c = AvoidanceController("mv"); c.set_enabled(True)
    h = pose_history.history("mv"); h.origin = (LAT0, LNG0)
    for k in range(n):
        lat, lng = h.to_latlng(vn * k * 0.1, ve * k * 0.1)
        h.add(lat, lng, alt, 180.0 if vn < 0 else 0.0, t=t0 + k * 0.1)
    return c, h


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
    from app.avoidance.loop import pick_goal_by_motion
    h = pose_history.PoseHistory(); h.origin = (LAT0, LNG0)
    north, south = h.to_latlng(60.0, 0.0), h.to_latlng(-60.0, 0.0)
    cands = [(5, north), (6, south)]
    assert pick_goal_by_motion(cands, 5, (0.0, 0.0), (-3.0, 0.0), h.to_ne) == south   # reported 5, flying south
    assert pick_goal_by_motion(cands, 5, (0.0, 0.0), (3.0, 0.0), h.to_ne) == north    # reported 5 and consistent
    assert pick_goal_by_motion(cands, 5, (0.0, 0.0), (0.2, 0.0), h.to_ne) == north    # hovering: trust the report


def test_steering_holds_the_altitude_it_took_over_at():
    c, h = _moving(3.0, 0.0, alt=9.6)
    c.grid.pin_disc(10.0, 0.0, 1.0, now=100.7)
    d = c.decide_local((60.0, 0.0), 4.0, now=100.7)        # mission altitude says 4 m
    assert d.action == "avoid" and abs(d.setpoint.vd) < 0.05   # no dive (SITL 21:33 sank 9.6 -> 4 m)


def test_unknown_mission_index_picks_the_nearest_waypoint_ahead():
    """Lawnmower, current item unknown (-1): flying south down leg 2 - the goal
    is that leg's south end, not waypoint 0 and not a later leg's far end."""
    from app.avoidance.loop import pick_goal_by_motion
    h = pose_history.PoseHistory(); h.origin = (LAT0, LNG0)
    legs = [(60.0, 0.0), (-60.0, 0.0), (-60.0, 10.0), (60.0, 10.0), (60.0, 20.0), (-60.0, 20.0)]
    cands = [(k, h.to_latlng(*ne)) for k, ne in enumerate(legs)]
    got = pick_goal_by_motion(cands, -1, (0.0, 10.0), (-3.0, 0.0), h.to_ne)   # on leg 2->... heading south at east=10
    assert got == h.to_latlng(-60.0, 10.0)
