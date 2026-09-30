"""Regression tests for the 2026-09-30 robustness audit of avoidance and
indoor navigation. Each test pins one finding; the docstring names it."""
import asyncio
import math
import time

import numpy as np
import pytest

from app.avoidance.core import loop as av_loop
from app.avoidance.core import executor
from app.avoidance.core.controller import AvoidanceController, AvoidanceState, Decision
from app.avoidance.mapping import pose_history
from app.avoidance.mapping.occupancy import OccupancyGrid
from app.avoidance.sensing import camera, person_ruler
from app.avoidance.sensing.depth_scan import ScanBin
from app.telemetry.manager import TelemetryManager
from app.telemetry.schemas import LocalPositionData, TelemetrySnapshot

from avoid_harness import LAT0, LNG0, _controller, _synthetic_scan


# -- helpers --------------------------------------------------------------------

class _Mgr:
    """Telemetry stand-in: records every command, answers as told."""
    is_connected = True
    _pilot_override_mode = None

    def __init__(self, offboard=False, resume_ok=True, mode="MISSION"):
        self.calls = []
        self._offboard_active = offboard
        self._resume_ok = resume_ok
        self._snapshot = TelemetrySnapshot()
        self._snapshot.flight_mode.mode = mode
        self._snapshot.flight_mode.is_in_air = True

    def release_offboard_state(self):
        self.calls.append("release_offboard_state")
        self._offboard_active = False

    async def resume_mission_from_offboard(self, i):
        self.calls.append(f"resume@{i}")
        return self._resume_ok

    async def start_offboard(self):
        self.calls.append("start_offboard")
        self._offboard_active = True
        return True

    async def set_flight_mode(self, m):
        self.calls.append(f"mode:{m}")
        return True

    async def send_velocity_ned(self, *a):
        self.calls.append("vel")

    async def set_speed(self, s):
        return True

    def add_pose_listener(self, fn):
        pass

    def remove_pose_listener(self, fn):
        pass


def _armed(name, t=100.0, alt=10.0):
    c, h = _controller(alt=alt, t=t)
    c.drone_id = c.drone_id                 # (sup)
    c.armed = True
    return c, h


def _pose(h):
    s = h.latest()
    from app.avoidance.planning.geometry import Pose
    return Pose(lat=s.lat, lng=s.lng, heading_deg=s.yaw_deg, alt_m=s.alt_m)


def _step(c, m, h, mode, now, in_air=True):
    av_loop._session_missions[c.drone_id] = [{"lat": h.to_latlng(40.0, 0.0)[0], "lng": h.to_latlng(40.0, 0.0)[1],
                                              "altitude": 10.0, "type": "waypoint"}]
    return asyncio.run(av_loop._local_step(c, m, _pose(h), in_air, mode, now))


def _commands(m):
    return [x for x in m.calls if x.startswith(("mode:", "start_offboard", "vel", "resume"))]


# -- ownership: who may take the aircraft ---------------------------------------

def test_stick_mode_pilot_is_never_taken_over():
    """Core#1: POSITION with an old mission on the FC and a wall ahead used
    to enter Offboard toward that mission, or HOLD then RTL the pilot."""
    c, h = _armed("stick")
    c.grid.pin_disc(8.0, 0.0, 1.0, now=100.0)
    m = _Mgr()
    for k in range(5):
        _step(c, m, h, "POSCTL", 100.0 + k * 0.1)
    assert _commands(m) == []
    assert c.state == AvoidanceState.NOMINAL and "pilot" in c._last_reason


def test_goal_less_hold_never_escalates_to_rtl():
    """Core#1: no route -> no RTL, whatever the hold timer says."""
    c, _ = _controller(t=20.0)
    c.grid.pin_disc(8.0, 0.0, 1.0, now=20.0)
    c.params.hold_to_return_s = 5.0
    c.decide_local(None, None, now=20.0)
    for k in range(80):
        assert c.decide_local(None, None, now=20.1 + k * 0.5).action != "return"


def test_someone_elses_offboard_is_left_alone_after_a_video_stall():
    """FG#1: the tracker's frames stall 2 s (following() false), its Offboard
    session is still open - the mission supervisor must not steer it."""
    c, h = _armed("stall")
    c.grid.pin_disc(8.0, 0.0, 1.0, now=100.0)
    c._follow_cmd_t = 90.0                     # last tracker frame 10 s ago
    m = _Mgr(offboard=True)                    # ... but Offboard is theirs
    _step(c, m, h, "OFFBOARD", 100.0)
    assert _commands(m) == [] and c.state == AvoidanceState.NOMINAL


def test_rtl_during_our_avoid_is_not_cancelled_by_a_hold():
    """Core#2b: operator/failsafe RTL while we steer: stand down, no HOLD."""
    c, h = _armed("rtl")
    c.state, c.intervened = AvoidanceState.AVOIDING, True
    m = _Mgr(offboard=True)
    _step(c, m, h, "RETURN_TO_LAUNCH", 100.0)
    assert not any(x.startswith("mode:") for x in m.calls)
    assert c.state == AvoidanceState.NOMINAL and not c.intervened
    assert "release_offboard_state" in m.calls


# -- hand-back obligation ---------------------------------------------------------

def test_failed_hand_back_is_retried_then_parked_in_hold():
    """FG#2 / Core#2d: the supervisor settled NOMINAL before the aircraft
    agreed; a refused resume left it in Offboard on watchdog zeros forever."""
    c, h = _armed("hb")
    m = _Mgr(offboard=True, resume_ok=False)
    c.state, c.intervened = AvoidanceState.AVOIDING, True
    c._engage_alt = 10.0
    av_loop._resume_fails.pop(c.drone_id, None)
    for k in range(14):
        # a clear path toward the goal -> "resume" once the hand-back timer
        # has run (1.5 s clear), again after each failure
        _step(c, m, h, "OFFBOARD", 100.0 + k * 1.0)
    resumes = [x for x in m.calls if x.startswith("resume")]
    assert len(resumes) >= 3, m.calls
    assert "mode:HOLD" in m.calls and c.state == AvoidanceState.HOLDING


def test_orphaned_offboard_is_handed_back():
    """Core#2 invariant: NOMINAL, not intervened, our Offboard still open."""
    c, h = _armed("orphan")
    m = _Mgr(offboard=True)
    m._offboard_owner = "avoidance"
    av_loop._orphan_since.pop(c.drone_id, None)
    _step(c, m, h, "OFFBOARD", 100.0)
    assert c.drone_id in av_loop._orphan_since
    _step(c, m, h, "OFFBOARD", 101.5)
    assert any(x.startswith("resume") for x in m.calls)


def test_resume_index_uses_the_latched_item_when_the_link_reports_minus_one():
    """FG#4 / Core#8: index -1 skipped the advance and PX4 chased the reached
    waypoint back into the pillar."""
    c, _ = _controller(t=1.0)
    c._latched_idx = 16
    av_loop._session_missions[c.drone_id] = [{"lat": 1.0, "lng": 1.0}] * 30
    d = Decision("resume", AvoidanceState.NOMINAL, "x")
    d.advance = True
    import unittest.mock as um
    with um.patch.object(av_loop, "_current_index", return_value=-1):
        assert av_loop._resume_index(c, None, d) == 17


def test_manager_resume_streams_until_mission_is_confirmed_and_keeps_offboard_on_failure():
    """FG#3: releasing Offboard state before MISSION was confirmed left a
    refused MISSION_START with no setpoint stream at all."""
    log = []

    class _Mission:
        async def set_current_mission_item(self, i):
            log.append(("set_current", i))

        async def start_mission(self):
            log.append(("start",))

    class _Off:
        async def set_velocity_ned(self, v):
            log.append(("vel", v.north_m_s))

    m = TelemetryManager(on_update=lambda d: None)
    m._drone = type("D", (), {"mission": _Mission(), "offboard": _Off()})()
    m._connected = True
    m._offboard_active = True

    async def slow_no(timeout=2.0):
        await asyncio.sleep(0.35)
        return False
    m._wait_for_mission_mode = slow_no

    async def run():
        await m.send_velocity_ned(-2.0, 0.0, 0.0, 90.0)
        m._snapshot.mission_current_index = 3
        return await m.resume_mission_from_offboard(3)
    assert asyncio.run(run()) is False
    start = log.index(("start",))
    assert sum(1 for e in log[start:] if e[0] == "vel") >= 2     # still streaming after start
    assert m._offboard_active is True                             # watchdog keeps holding


def test_executor_hold_releases_offboard_before_the_mode_change():
    """FG#5: 2 s departure window vs 4 s mode confirm latched a phantom pilot."""
    c, _ = _controller(t=1.0)
    m = _Mgr(offboard=True)
    c.intervened = True
    asyncio.run(executor.apply_local(m, c, Decision("hold", AvoidanceState.HOLDING, "x"), -1))
    assert m.calls.index("release_offboard_state") < m.calls.index("mode:HOLD")


def test_setpoints_are_clamped_and_never_nan():
    """Redundancy: an independent clamp on every setpoint."""
    from app.avoidance.planning.local_planner import Setpoint
    c, _ = _controller(t=1.0)
    m = _Mgr(offboard=True)
    bad = Decision("avoid", AvoidanceState.AVOIDING, "x")
    bad.setpoint = Setpoint(float("nan"), 0, 0, 0, 0, None, 0, None, False, "x")
    ok, note = asyncio.run(executor.apply_local(m, c, bad, -1))
    assert not ok and "finite" in note and "vel" not in m.calls
    fast = Decision("avoid", AvoidanceState.AVOIDING, "x")
    fast.setpoint = Setpoint(30.0, 40.0, 5.0, 0, 50, None, 0, None, False, "x")
    asyncio.run(executor.apply_local(m, c, fast, -1))
    assert math.hypot(fast.setpoint.vn, fast.setpoint.ve) <= c.params.speed_cap_m_s + 1e-6
    assert abs(fast.setpoint.vd) <= 1.5


# -- freshness gates -------------------------------------------------------------

def test_stale_pose_brakes_instead_of_steering_from_an_old_position():
    """Core#5: 29 s after the last sample the planner still commanded a
    setpoint with a phantom velocity."""
    c, h = _controller(t=100.0)
    lat, lng = h.to_latlng(0.3, 0.0)
    h.add(lat, lng, 10.0, 0.0, t=100.1)                        # a streaming feed, then silence
    c.grid.pin_disc(8.0, 0.0, 1.0, now=100.0)
    c.state, c.intervened = AvoidanceState.AVOIDING, True
    d = c.decide_local((40.0, 0.0), None, now=105.0)
    assert d.action == "hold" and "stale" in d.reason


def test_a_still_hover_is_not_a_stale_pose():
    """Sensing#12: identical samples used to freeze the timestamp."""
    h = pose_history.PoseHistory()
    for k in range(50):
        h.add(LAT0, LNG0, 5.0, 0.0, t=10.0 + k * 0.1)
    assert abs(h.latest().t - 14.9) < 1e-9 and h.sample_count() == 1


def test_sensor_loss_brakes_then_holds_and_freezes_the_map():
    """Core#4: with the sensor dead the aircraft steered on a fading map,
    then 'resumed' into the pillar it had forgotten."""
    c, h = _controller(t=1000.0)
    c.armed = True
    pos, yaw = (0.0, 0.0), 0.0
    for k in range(5):                                        # 0.5 s of real scans
        c.integrate_scan(_synthetic_scan(pos, yaw, [(10.0, 0.0, 1.0)]), 1000.0 + k * 0.1, "depth")
    d = c.decide_local((40.0, 0.0), 10.0, now=1000.5)
    assert d.action == "avoid" and c.state == AvoidanceState.AVOIDING
    for k in range(60):                                       # sensor dies, pose keeps coming
        h.add(LAT0, LNG0, 10.0, 0.0, t=1000.6 + k * 0.1)
        d = c.decide_local((40.0, 0.0), 10.0, now=1000.6 + k * 0.1)
        assert d.action != "resume", (k, d.reason)
        if 1000.6 + k * 0.1 - 1000.4 > c.SENSOR_STALE_S + 0.2 and d.action == "avoid":
            assert d.setpoint.speed == 0.0 and "sensor lost" in d.reason
    assert d.action == "hold" and "sensor lost" in d.reason
    assert c.grid.polar(0.0, 0.0, 18.0, 5.0, 1000.4)[0] < 12.0    # evidence still there


def test_map_wipe_holds_until_fresh_scans_arrive():
    """Core#2a / Core#3B: a pose-frame switch mid-avoid used to flip to
    NOMINAL on an empty map ('obstacle gone') with Offboard still open."""
    c, h = _controller(t=50.0)
    c.armed = True
    c.grid.pin_disc(8.0, 0.0, 1.0, now=50.0)
    c.decide_local((40.0, 0.0), 10.0, now=50.0)
    assert c.state == AvoidanceState.AVOIDING
    c.intervened = True
    h.add_ne(0.0, 0.0, 10.0, 0.0, t=50.1)                      # GPS -> local frame
    d = c.decide_local((40.0, 0.0), 10.0, now=50.1)
    assert d.action == "hold" and "frame" in d.reason
    for k in range(20):                                        # empty map, no scans: stay held
        h.add_ne(0.0, 0.0, 10.0, 0.0, t=50.2 + k * 0.1)
        assert c.decide_local((40.0, 0.0), 10.0, now=50.2 + k * 0.1).action != "resume"


def test_pose_source_does_not_flap_on_a_gps_flicker(monkeypatch):
    """Sensing#2 / Indoor#5: a 1 s fix drop bumped the epoch (map wiped) twice."""
    c = AvoidanceController("flap"); c.set_enabled(True)
    h = pose_history.history("flap"); h.origin = None; h._s.clear(); h.source = None; h.epoch = 0
    av_loop._listeners.pop("flap", None); av_loop._src_change.pop("flap", None)
    snap = TelemetrySnapshot()
    snap.position.latitude_deg, snap.position.longitude_deg = 17.5, 78.1
    snap.gps.fix_type, snap.gps.seen = 3, True
    m = _Mgr()
    m._snapshot = snap
    av_loop._ensure_pose_feed(c, m)
    fn = av_loop._listeners["flap"][1]
    t0 = time.monotonic()
    fn(snap)
    assert h.source == "gps" and h.epoch == 0
    snap.gps.fix_type = 2                                       # GPS bad for one second
    snap.local_position = LocalPositionData(1.0, 1.0, -10.0, valid=True, t=t0)
    fn(snap)
    assert h.epoch == 0 and h.source == "gps"                   # within the dwell: no switch
    av_loop._src_change["flap"] = t0 - 10.0                     # ... held bad long enough
    snap.local_position = LocalPositionData(1.0, 1.0, -10.0, valid=True, t=time.monotonic())
    fn(snap)
    assert h.source == "local" and h.epoch == 1


def test_gps_fix_zero_after_gps_data_means_no_gps():
    """Indoor#3: MAVSDK FixType.NO_GPS is 0 - it was read as 'unknown = ok'."""
    s = TelemetrySnapshot()
    s.position.latitude_deg, s.position.longitude_deg = 17.5, 78.1
    assert av_loop._gps_ok(s)                                   # no GPS message yet: coordinates decide
    s.gps.seen = True
    assert not av_loop._gps_ok(s)


# -- indoor bootstrap and link handling -------------------------------------------

class _Sess:
    def __init__(self, sid, d):
        self.session_id, self.drone = sid, {"id": d}


class _SM:
    def __init__(self, m, did):
        self.m, self.did = m, did

    def all_sessions(self):
        return [_Sess("s1", self.did)]

    def get_telemetry(self, sid):
        return self.m

    def get(self, sid):
        return _Sess(sid, self.did)


def test_no_gps_link_still_resolves_so_the_pose_feed_can_start(monkeypatch):
    """Indoor#1: with lat/lng 0 the link resolved to nothing, so the local
    position feed was never subscribed - indoor navigation never started."""
    m = TelemetryManager(on_update=lambda d: None)
    m._connected = True
    monkeypatch.setattr(TelemetryManager, "is_connected", property(lambda self: True), raising=False)
    monkeypatch.setattr(av_loop, "_session_manager", _SM(m, "d-nogps"))
    pose_history.history("d-nogps")._s.clear()
    mgr, pose, in_air, mode = av_loop._resolve_link("d-nogps")
    assert mgr is m and pose is None


def test_link_loss_keeps_the_flight_state(monkeypatch):
    """Core#7: a link blip reset the flight (intervened -> False) and the
    next HOLD looked like an operator hold that never resumes."""
    c = AvoidanceController("blip"); c.set_enabled(True); c.armed = True
    c.state, c.intervened = AvoidanceState.HOLDING, True
    c.grid.pin_disc(5.0, 0.0, 1.0, now=1.0)
    av_loop._airborne["blip"] = True
    monkeypatch.setattr(av_loop, "_resolve_link", lambda d: (None, None, False, ""))
    asyncio.run(av_loop._tick_one(c, 2.0))
    assert c.state == AvoidanceState.HOLDING and c.intervened and c.grid.cells


def test_one_drones_error_does_not_starve_the_others(monkeypatch):
    """Core#6: no per-drone isolation in the tick."""
    from app.avoidance.core import controller as avoidance
    a = avoidance.controller("bad"); a.set_enabled(True)
    b = avoidance.controller("good"); b.set_enabled(True)
    seen = []

    async def one(c, now):
        seen.append(c.drone_id)
        if c.drone_id == "bad":
            raise RuntimeError("boom")
    monkeypatch.setattr(av_loop, "_tick_one", one)
    asyncio.run(av_loop._tick())
    assert "good" in seen and "loop error" in a._last_reason


def test_session_bound_to_a_drone_without_avoidance_is_not_guarded_by_another(monkeypatch):
    """FG#8: the sole enabled controller guarded every session's tracker."""
    from app.avoidance.core import controller as avoidance
    other = avoidance.controller("other-drone"); other.set_enabled(True)
    monkeypatch.setattr(av_loop, "_session_manager", _SM(None, "no-avoid-drone"))
    assert av_loop._controller_for_session("s1") is None
    assert av_loop.guard_follow("s1", 1.3, 0.2) == (1.3, 0.2)


# -- environment ------------------------------------------------------------------

def test_no_auto_switch_while_holding_and_gps_alone_does_not_shrink_clearance_at_speed():
    """Core#3: HOLDING was not in the no-switch set; a GPS dropout outdoors
    applied the indoor profile (0.45 m clearance) at mission speed."""
    c, _ = _controller(t=0.0)
    c.state = AvoidanceState.HOLDING
    c.note_gps(False)
    c.update_env(now=0.0)
    assert c.update_env(now=6.0) is None and c.env == "outdoor"
    c.state = AvoidanceState.NOMINAL
    c.note_vision_env(0.3, 25.0, False, now=6.0)               # camera says open sky
    assert c.update_env(now=6.0) is None
    assert c.update_env(now=12.0) is None and c.env == "outdoor"


def test_camera_verdict_alone_needs_a_real_sky_mask_and_low_speed():
    c, _ = _controller(t=0.0)
    c.note_gps(True)
    c._last_speed_m_s = 3.5
    c.note_vision_env(0.0, 3.0, True, now=0.0)
    c.update_env(now=0.0)
    c.note_vision_env(0.0, 3.0, True, now=5.5)
    assert c.update_env(now=5.5) is None                        # too fast for a facade to count
    c._last_speed_m_s = 0.5
    c.note_vision_env(None, 3.0, True, now=5.6)                 # no sky head: not enough
    assert c.update_env(now=5.6) is None


def test_indoor_profile_never_returns_home():
    """Indoor#4: RTL under a ceiling."""
    from app.avoidance.core.controller import INDOOR_PROFILE
    assert INDOOR_PROFILE["allow_return"] == 0.0


# -- sensing and map ---------------------------------------------------------------

def test_mono_evidence_is_not_double_counted():
    """Sensing#3: two sub-rays stamped the same hit cell - 2 frames = occupied."""
    g = OccupancyGrid()
    b = [ScanBin(bearing_deg=1.0, half_width_deg=1.0, hit_m=10.0, free_m=10.0, top_m=0.0, points=3)]
    g.integrate(0, 0, 0, b, "monocular", now=1.0)
    g.integrate(0, 0, 0, b, "monocular", now=1.1)
    assert not g.occupied(1.2)
    assert max(c.l for c in g.cells.values()) == pytest.approx(0.9, abs=0.05)


def test_older_scan_does_not_rewind_cell_time():
    """Sensing#7: an out-of-order scan decayed newer evidence."""
    g = OccupancyGrid()
    b = [ScanBin(bearing_deg=0.0, half_width_deg=1.0, hit_m=5.0, free_m=5.0, top_m=0.0, points=3)]
    g.integrate(0, 0, 0, b, "depth", now=10.0)
    g.integrate(0, 0, 0, b, "depth", now=8.0)
    assert max(c.t for c in g.cells.values()) == 10.0


def test_no_ground_fit_with_a_stale_scale_yields_no_obstacles():
    """Sensing#1: documented rule, was only true with scale None."""
    z = np.full((120, 160), 30.0, np.float32); z[20:100, 60:100] = 4.0
    ctx = {"alt_m": 10.0, "roll_deg": 0.0, "pitch_deg": 0.0, "cam_pitch_deg": 0.0, "scale": 1.5,
           "fit_age_s": 30.0}
    assert camera.analyze_depth(z, 160, 120, ctx, 70.0, 20.0)["scan"] is None
    ctx["fit_age_s"] = 0.5
    assert camera.analyze_depth(z, 160, 120, ctx, 70.0, 20.0)["scan"] is not None


def test_mono_tops_are_unknown():
    """Sensing#11: a scale-dependent top authorised flying over a mast."""
    c, h = _controller(alt=12.0)
    now = time.monotonic()
    pose_history.history("sup").add(LAT0, LNG0, 12.0, 0.0, t=now)
    b = [ScanBin(bearing_deg=0.0, half_width_deg=1.0, hit_m=8.0, free_m=8.0, top_m=7.0, points=3)]
    c.integrate_scan(b, now, "monocular")
    assert all(cell.top_m == 0.0 for cell in c.grid.cells.values())


def test_person_ruler_rejects_implausible_scales():
    """Sensing#9: 45x was accepted because it was self-consistent."""
    d = np.full((360, 640), 9.0, np.float32); d[100:300, 280:360] = 0.05
    f, H = 320.0, 1.7
    box_h = f * H / 5.0
    y0 = 180 - box_h / 2
    scale, why = person_ruler.scale_from_box([[285, y0, 355, y0 + box_h]], d, 640, 360, 90.0, H)
    assert scale is None and "not a usable" in why


def test_depth_scan_route_rejects_absurd_and_stale_bodies():
    """Sensing#6: max_range 1e9 walked rays for 3e9 steps; NaN hfov -> 500."""
    from fastapi.testclient import TestClient
    from fastapi import FastAPI
    from app.avoidance import routes
    from app.avoidance.core import controller as avoidance
    c = avoidance.controller("scan-route"); c.set_enabled(True)
    h = pose_history.history("scan-route"); h.origin = (LAT0, LNG0)
    h.add(LAT0, LNG0, 10.0, 0.0, t=time.monotonic())
    app = FastAPI(); app.include_router(routes.router)
    cl = TestClient(app)
    from app.config import get_settings
    hdr = {"X-Auth-Token": get_settings().secret_token}
    body = {"captured_wall": time.time(), "hfov_deg": 73.0, "vfov_deg": 58.0, "rows": 2, "cols": 2,
            "depth": [5.0] * 4, "max_range_m": 1e9}
    assert cl.post("/api/avoidance/scan-route/depth_scan", json=body, headers=hdr).status_code == 400
    body["max_range_m"] = 19.0; body["hfov_deg"] = float("nan")
    r = cl.post("/api/avoidance/scan-route/depth_scan", json={**body, "hfov_deg": 1e3}, headers=hdr)
    assert r.status_code == 400
    body["hfov_deg"] = 73.0; body["captured_wall"] = time.time() - 5.0
    r = cl.post("/api/avoidance/scan-route/depth_scan", json=body, headers=hdr)
    assert r.status_code == 200 and r.json()["ok"] is False and "stale" in r.json()["reason"]


def test_status_route_does_not_create_phantom_controllers():
    """UI#2: GET status for any id created a disabled controller."""
    from fastapi.testclient import TestClient
    from fastapi import FastAPI
    from app.avoidance import routes
    from app.avoidance.core import controller as avoidance
    app = FastAPI(); app.include_router(routes.router)
    assert TestClient(app).get("/api/avoidance/never-seen-id/status").status_code == 404
    assert not avoidance.has_controller("never-seen-id")


# -- follow guard ------------------------------------------------------------------

def test_guard_does_not_slide_fast_into_unseen_space():
    """FG#6: a second pillar the camera never saw, 2 m to the right."""
    c, _ = _controller(t=100.0); c.armed = True
    c.grid.pin_disc(7.0, 0.0, 1.0, now=100.0)
    f, r, _ = c.guard_body(3.0, 0.0, now=100.0)
    assert math.hypot(f, r) <= c.params.guard_unseen_speed_m_s + 1e-6


def test_guard_hold_raises_an_event_after_a_while():
    """FG#7: holding forever with nothing reaching the operator."""
    c, _ = _controller(t=100.0); c.armed = True
    for k in range(-9, 10):
        a = math.radians(k * 10)
        c.grid.pin_disc(2.0 * math.cos(a), 2.0 * math.sin(a), 0.4, now=100.0)
    evs = [c.guard_body(2.5, 0.0, now=100.0 + k * 0.5)[2] for k in range(14)]
    assert "start" in evs and "hold" in evs
