"""Bench test of the camera path: a fixed webcam beside a flying SITL drone.
No ground fit is possible (the picture has no ground 20 m below), so bench
mode takes the model's metres as they are, camera level at a known height."""
import numpy as np

from app.avoidance.core.controller import AvoidanceController
from app.avoidance.sensing.camera import analyze_depth


def _box_ahead(dist=1.2, rows=120, cols=160):
    z = np.full((rows, cols), 8.0, np.float32)          # room far away
    z[20:100, 60:100] = dist                             # a box held in front
    return z


def test_bench_scan_sees_an_object_held_in_front_without_a_ground_fit():
    ctx = {"alt_m": 20.0, "roll_deg": 0.0, "pitch_deg": 0.0, "cam_pitch_deg": 0.0,
           "scale": None, "bench": True, "bench_h": 1.0}
    res = analyze_depth(_box_ahead(), 160, 120, ctx, hfov_deg=70.0, max_range_m=20.0)
    hits = [b for b in res["scan"] if b.hit_m is not None and abs(b.bearing_deg) < 10]
    assert res["bench"] and hits
    assert min(b.hit_m for b in hits) < 1.6


def test_flight_mode_still_refuses_an_uncalibrated_frame():
    ctx = {"alt_m": 20.0, "roll_deg": 0.0, "pitch_deg": 0.0, "cam_pitch_deg": 0.0,
           "scale": None}
    res = analyze_depth(_box_ahead(), 160, 120, ctx, hfov_deg=70.0, max_range_m=20.0)
    assert res["scan"] is None


def test_bench_drops_the_camera_height_floors():
    c = AvoidanceController("bench"); c.set_enabled(True)
    c._mono_data_t = __import__("time").monotonic()
    assert c.acting_floor_m() == c.params.mono_min_alt_m
    c.params.mono_bench = 1.0
    assert c.acting_floor_m() == c.params.range_min_alt_m
