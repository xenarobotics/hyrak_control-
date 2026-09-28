"""Indoor navigation: PX4 local position instead of GPS, the indoor profile,
the auto indoor/outdoor switch, and the indoor failsafe advice."""
import math
import types

import numpy as np

from app.avoidance.core import controller as avoidance
from app.avoidance.core import loop as av_loop
from app.avoidance.core.controller import AvoidanceController, AvoidanceState, INDOOR_PROFILE
from app.avoidance.mapping import pose_history
from app.avoidance.mapping.pose_history import PoseHistory
from app.avoidance.sensing.camera import environment_stats
from app.telemetry import failsafe_check
from app.telemetry.schemas import LocalPositionData, TelemetrySnapshot


# -- pose source ----------------------------------------------------------------

def test_local_samples_and_a_source_switch_starts_a_new_frame():
    h = PoseHistory()
    h.add(17.5, 78.1, 10.0, 0.0, t=1.0)
    assert h.source == "gps" and h.epoch == 0
    h.add_ne(3.0, -2.0, 1.2, 90.0, t=2.0, origin_latlng=(17.5, 78.1))
    assert h.source == "local" and h.epoch == 1
    s = h.latest()
    assert (s.north_m, s.east_m, s.alt_m) == (3.0, -2.0, 1.2)
    assert abs(s.lat - (17.5 + 3.0 / pose_history.M_PER_DEG_LAT)) < 1e-9


def _snap(lat=0.0, lng=0.0, fix=0, local=None, home=(0.0, 0.0)):
    s = TelemetrySnapshot()
    s.position.latitude_deg, s.position.longitude_deg = lat, lng
    s.gps.fix_type = fix
    s.home_lat, s.home_lng = home
    if local is not None:
        import time
        s.local_position = LocalPositionData(*local, valid=True, t=time.monotonic())
    return s


class _Mgr:
    def __init__(self, snap):
        self._snapshot = snap
        self.fns = []

    def add_pose_listener(self, fn):
        self.fns.append(fn)

    def remove_pose_listener(self, fn):
        pass


def _feed(c, snap):
    av_loop._listeners.pop(c.drone_id, None)
    pose_history._histories.pop(c.drone_id, None) if hasattr(pose_history, "_histories") else None
    m = _Mgr(snap)
    av_loop._ensure_pose_feed(c, m)
    return pose_history.history(c.drone_id)


def test_no_gps_navigates_on_px4_local_position():
    c = AvoidanceController("in1"); c.set_enabled(True)
    h = _feed(c, _snap(local=(4.0, 1.0, -1.5)))
    assert h.source == "local"
    s = h.latest()
    assert (s.north_m, s.east_m) == (4.0, 1.0) and abs(s.alt_m - 1.5) < 1e-9
    pose = av_loop._local_pose("in1")
    assert pose is not None and abs(pose.alt_m - 1.5) < 1e-9


def test_gps_outdoors_is_unchanged():
    c = AvoidanceController("out1"); c.set_enabled(True)
    h = _feed(c, _snap(lat=17.5, lng=78.1, fix=3, local=(4.0, 1.0, -10.0)))
    assert h.source == "gps"


def test_indoor_env_uses_local_even_with_gps():
    c = AvoidanceController("in2"); c.set_enabled(True)
    c._apply_env("indoor")
    h = _feed(c, _snap(lat=17.5, lng=78.1, fix=3, local=(4.0, 1.0, -1.0)))
    assert h.source == "local"
    assert abs(h.origin[0] - (17.5 - 4.0 / pose_history.M_PER_DEG_LAT)) < 1e-9   # anchored to GPS


def test_grid_is_cleared_when_the_frame_changes():
    c = AvoidanceController("fr1"); c.set_enabled(True)
    h = pose_history.history("fr1")
    h.origin = (17.5, 78.1)
    h.add(17.5, 78.1, 5.0, 0.0, t=10.0)
    c.grid.pin_disc(5.0, 0.0, 1.0, now=10.0)
    c.decide_local(None, None, now=10.0)
    assert c.grid.cells
    h.add_ne(0.0, 0.0, 1.0, 0.0, t=11.0)
    c.decide_local(None, None, now=11.0)
    assert not c.grid.cells


# -- profiles and the auto switch -----------------------------------------------

def test_operator_indoor_applies_and_restores_the_outdoor_tuning():
    c = AvoidanceController("pr1")
    c.params.speed_cap_m_s = 3.3                  # operator-tuned outdoor value
    c.params.env_mode = 2.0
    assert c.update_env(now=0.0) == "indoor"
    for k, v in INDOOR_PROFILE.items():
        assert getattr(c.params, k) == v
    c.params.env_mode = 1.0
    assert c.update_env(now=1.0) == "outdoor"
    assert c.params.speed_cap_m_s == 3.3 and c.params.local_clearance_m == 3.0


def test_auto_switches_only_after_it_settles_and_not_mid_manoeuvre():
    c = AvoidanceController("au1")
    c.note_gps(False)
    assert c.update_env(now=0.0) is None                 # candidate only
    c.state = AvoidanceState.AVOIDING
    assert c.update_env(now=6.0) is None                 # busy dodging
    c.state = AvoidanceState.NOMINAL
    assert c.update_env(now=6.1) == "indoor" and "GPS" in c.env_reason
    c.note_gps(True)
    assert c.update_env(now=7.0) is None
    assert c.update_env(now=12.5) == "outdoor"


def test_camera_verdict_can_call_it_indoor_with_gps():
    c = AvoidanceController("au2")
    c.note_gps(True)
    c.note_vision_env(0.0, 3.5, True, now=0.0)
    c.update_env(now=0.0)
    c.note_vision_env(0.0, 3.5, True, now=5.5)
    assert c.update_env(now=5.5) == "indoor"


def test_persisted_params_keep_the_outdoor_values(tmp_path, monkeypatch):
    import json
    monkeypatch.setattr(avoidance, "_STATE_FILE", tmp_path / "s.json")
    c = avoidance.controller("pe1"); c.set_enabled(True)
    c._apply_env("indoor")
    avoidance.persist_state()
    saved = json.loads((tmp_path / "s.json").read_text())["pe1"]["params"]
    assert saved["local_clearance_m"] == 3.0 and saved["speed_cap_m_s"] == 4.0


def test_a_corridor_is_flyable_indoors_but_not_with_outdoor_clearance():
    def corridor(c):                              # 1.6 m wide: wall faces at +-0.8 m
        for i in range(0, 120):
            for y in (-0.9, 0.9):
                c.grid.pin_disc(i * 0.2, y, 0.1 if c.grid.cell_m < 0.5 else 0.3, now=50.0)
    out = AvoidanceController("co1"); out.set_enabled(True)
    ind = AvoidanceController("co2"); ind.set_enabled(True); ind._apply_env("indoor")
    for c in (out, ind):
        h = pose_history.history(c.drone_id); h.origin = (17.5, 78.1)
        h.add(17.5, 78.1, 1.5, 0.0, t=50.0)
        corridor(c)
        c.state = AvoidanceState.AVOIDING
    sp_out = out.decide_local((20.0, 0.0), None, now=50.0).setpoint
    sp_in = ind.decide_local((20.0, 0.0), None, now=50.0).setpoint
    assert sp_out is not None and sp_out.blocked
    assert sp_in is not None and not sp_in.blocked and sp_in.vn > 0.1
    assert abs(sp_in.ve) < 0.2                   # straight down the middle


# -- camera verdict, failsafe ----------------------------------------------------

def test_environment_stats_room_vs_open():
    room = np.full((60, 80), 3.0, np.float32)
    sky_none = np.zeros((60, 80), np.float32)
    s, med, ceil = environment_stats(room, sky_none)
    assert s == 0.0 and med == 3.0 and ceil
    field = np.full((60, 80), 25.0, np.float32)
    sky = np.zeros((60, 80), np.float32); sky[:20] = 1.0
    s, med, ceil = environment_stats(field, sky)
    assert s > 0.3 and not ceil


def test_indoor_failsafe_advice():
    p = {"NAV_DLL_ACT": 2, "COM_OBL_RC_ACT": 3, "COM_DL_LOSS_T": 10, "COM_OF_LOSS_T": 1.0}
    _, warn = failsafe_check.evaluate(p, gps_denied=True)
    assert any("NAV_DLL_ACT" in w and "Land" in w for w in warn)
    assert any("COM_OBL_RC_ACT" in w for w in warn)
    _, warn_out = failsafe_check.evaluate(p, gps_denied=False)
    assert not any("indoors" in w for w in warn_out)
