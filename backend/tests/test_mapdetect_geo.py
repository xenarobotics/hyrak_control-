"""
Detections on the map: the ground projection (app/mapdetect/geo.py) with
known geometry, its accuracy model and its refusals.
"""
import math

import pytest

from app.mapdetect import geo
from app.utils.geo import haversine_m

LAT, LON = 17.6, 78.1
W, H = 1920, 1080
M_PER_DEG_LAT = math.radians(1) * geo.EARTH_RADIUS_M


def tel(alt=100.0, heading=0.0, roll=0.0, pitch=0.0, fix=3, hdop=0.8, **extra):
    t = {"position": {"latitude_deg": LAT, "longitude_deg": LON, "relative_altitude_m": alt,
                      "absolute_altitude_m": 500.0 + alt},
         "attitude": {"roll_deg": roll, "pitch_deg": pitch, "yaw_deg": heading},
         "heading_deg": heading, "gps": {"seen": True, "fix_type": fix, "hdop": hdop},
         "rangefinder_m": None}
    t.update(extra)
    return t


def ne(fix):
    """(north_m, east_m) of a fix from the drone."""
    north = (fix.lat - LAT) * M_PER_DEG_LAT
    east = (fix.lon - LON) * M_PER_DEG_LAT * math.cos(math.radians(LAT))
    return north, east


NADIR = geo.CameraSetup(hfov_deg=80.0, pitch_deg=-90.0, source="setting")


def test_nadir_100m_80deg_footprint():
    # Half the footprint width at 100 m with an 80 deg lens: 100 * tan(40).
    half_w = 100.0 * math.tan(math.radians(40.0))
    half_h = half_w * (H / W)                      # square pixels
    c = geo.project_pixel(tel(), W / 2, H / 2, W, H, NADIR).fix
    assert abs(c.lat - LAT) < 1e-9 and abs(c.lon - LON) < 1e-9 and c.off_nadir_deg == 0
    r = ne(geo.project_pixel(tel(), W, H / 2, W, H, NADIR).fix)
    assert r[0] == pytest.approx(0, abs=0.01) and r[1] == pytest.approx(half_w, abs=0.05)
    l = ne(geo.project_pixel(tel(), 0, H / 2, W, H, NADIR).fix)
    assert l[1] == pytest.approx(-half_w, abs=0.05)
    top = ne(geo.project_pixel(tel(), W / 2, 0, W, H, NADIR).fix)      # top of frame = nose
    assert top[0] == pytest.approx(half_h, abs=0.05) and top[1] == pytest.approx(0, abs=0.01)
    bottom = ne(geo.project_pixel(tel(), W / 2, H, W, H, NADIR).fix)
    assert bottom[0] == pytest.approx(-half_h, abs=0.05)
    assert half_w == pytest.approx(83.91, abs=0.01)


def test_heading_rotates_the_footprint():
    # Facing east, the top of the frame is east and the right edge south.
    top = ne(geo.project_pixel(tel(heading=90), W / 2, 0, W, H, NADIR).fix)
    assert top[0] == pytest.approx(0, abs=0.05) and top[1] == pytest.approx(47.2, abs=0.1)
    right = ne(geo.project_pixel(tel(heading=90), W, H / 2, W, H, NADIR).fix)
    assert right[0] == pytest.approx(-83.91, abs=0.1) and right[1] == pytest.approx(0, abs=0.1)


def test_oblique_forward_camera():
    fwd = geo.CameraSetup(hfov_deg=80.0, pitch_deg=-30.0, source="setting")
    f = geo.project_pixel(tel(), W / 2, H / 2, W, H, fwd).fix
    n, e = ne(f)
    assert n == pytest.approx(100.0 / math.tan(math.radians(30)), abs=0.1)   # 173.2 m ahead
    assert e == pytest.approx(0, abs=0.01)
    assert f.off_nadir_deg == pytest.approx(60.0, abs=0.01)
    # Steeper rays (lower in the frame) land nearer and are more accurate.
    low = geo.project_pixel(tel(), W / 2, H, W, H, fwd).fix
    assert low.ground_range_m < f.ground_range_m and low.accuracy_m < f.accuracy_m


def test_fixed_mount_follows_airframe_pitch_but_stabilised_does_not():
    nose_down = tel(pitch=-10.0)       # MAVSDK: positive pitch is nose up
    fixed = ne(geo.project_pixel(nose_down, W / 2, H / 2, W, H, NADIR).fix)
    # A nose-down airframe tips a nadir lens backwards: the centre lands behind.
    assert fixed[0] == pytest.approx(-100 * math.tan(math.radians(10)), abs=0.05)
    stab = geo.CameraSetup(hfov_deg=80, pitch_deg=-90, stabilised=True, source="setting")
    s = ne(geo.project_pixel(nose_down, W / 2, H / 2, W, H, stab).fix)
    assert s[0] == pytest.approx(0, abs=0.01)


def test_gimbal_pitch_wins_over_the_setting():
    t = tel(pitch=-10.0, gimbal={"pitch_deg": -45.0})
    f = geo.project_pixel(t, W / 2, H / 2, W, H, NADIR).fix
    assert f.angle_source == "gimbal"
    assert ne(f)[0] == pytest.approx(100.0, abs=0.05)      # 45 deg down from 100 m


def test_height_sources():
    f = geo.project_pixel(tel(alt=100, rangefinder_m=20.0), W, H / 2, W, H, NADIR).fix
    assert f.height_source == "rangefinder" and f.agl_m == 20.0
    # Terrain 30 m higher under the drone than at home: 70 m above it.
    f = geo.project_pixel(tel(alt=100), W, H / 2, W, H, NADIR, terrain_offset_m=30.0).fix
    assert f.height_source == "terrain" and f.agl_m == 70.0
    assert ne(f)[1] == pytest.approx(70 * math.tan(math.radians(40)), abs=0.05)


@pytest.mark.parametrize("t,reason", [
    (tel(fix=1), "no_gps"),
    ({**tel(), "position": {"latitude_deg": 0.0, "longitude_deg": 0.0, "relative_altitude_m": 50}},
     "no_gps"),
    (None, "no_gps"),
    (tel(alt=0.2), "no_altitude"),
    ({**tel(), "position": {"latitude_deg": LAT, "longitude_deg": LON}}, "no_altitude"),
])
def test_refusals(t, reason):
    r = geo.project_pixel(t, W / 2, H / 2, W, H, NADIR)
    assert not r.ok and r.reason == reason


def test_rays_at_or_above_the_horizon_are_refused():
    level = geo.CameraSetup(hfov_deg=80, pitch_deg=0.0, source="setting")
    assert geo.project_pixel(tel(), W / 2, 0, W, H, level).reason == "above_horizon"
    assert geo.project_pixel(tel(), W / 2, H / 2, W, H, level).reason == "above_horizon"
    # Just below the horizon: metres of pitch error become kilometres.
    assert geo.project_pixel(tel(), W / 2, H / 2 + 20, W, H, level).reason == "too_shallow"


def test_accuracy_grows_with_altitude_and_obliqueness():
    a50 = geo.project_pixel(tel(alt=50), W / 2, H / 2, W, H, NADIR).fix.accuracy_m
    a100 = geo.project_pixel(tel(alt=100), W / 2, H / 2, W, H, NADIR).fix.accuracy_m
    edge = geo.project_pixel(tel(alt=100), W, H / 2, W, H, NADIR).fix.accuracy_m
    assert a50 < a100 < edge
    assert a100 == 8.0           # documented figure: 100 m nadir, fixed camera, angle set
    default = geo.project_pixel(tel(alt=100), W / 2, H / 2, W, H, geo.CameraSetup()).fix
    assert default.accuracy_m > a100 and default.angle_source == "default"
    poor_gps = geo.project_pixel(tel(alt=100, hdop=4.0), W / 2, H / 2, W, H, NADIR).fix
    assert poor_gps.accuracy_m > a100


def test_nominal_accuracy_matches_the_frame_centre():
    assert geo.nominal_accuracy_m(100, NADIR) == 8.0
    assert geo.nominal_accuracy_m(0.1, NADIR) is None


def test_box_anchor():
    assert geo.box_anchor([100, 50, 200, 250], "detect", W, H) == (150.0, 250.0)
    assert geo.box_anchor(None, "classify", W, H) == (W / 2, H / 2)
    assert geo.box_anchor([1, 2, 3, 4], "classify", W, H) == (W / 2, H / 2)


def test_camera_setup_from_device_settings_is_clamped():
    c = geo.CameraSetup.from_dict({"hfov_deg": 500, "pitch_deg": 20, "set": True})
    assert c.hfov_deg == 170.0 and c.pitch_deg == 0.0 and c.source == "setting"
    d = geo.CameraSetup.from_dict({"hfov_deg": "x"})
    assert d.hfov_deg == geo.DEFAULT_HFOV_DEG and d.pitch_deg == -90.0 and d.source == "default"


def test_offset_latlon_round_trip():
    lat, lon = geo.offset_latlon(LAT, LON, 300.0, -400.0)
    assert haversine_m(LAT, LON, lat, lon) == pytest.approx(500.0, rel=2e-3)
