"""
Geometry conventions, pinned.

These are here because a sign error in a rotation matrix does not raise —
it quietly puts the target on the wrong side of the drone and reports a
plausible-looking speed. Each test states a fact that should be obvious from
the outside ("looking straight down, the frame centre is directly below us")
so that a future change to the frame conventions fails loudly.
"""
import math

import pytest

from app.vision.geometry import (
    CameraModel, CameraPose, MountOffset,
    ScaleEstimate, resolve_scale, scale_from_altitude, scale_from_object_width,
)

HFOV = 70.0
W, H = 1920, 1080


def cam() -> CameraModel:
    return CameraModel(W, H, HFOV)


def centre(c: CameraModel):
    return c.cx, c.cy


# --------------------------------------------------------------------------- #
# Intrinsics                                                                    #
# --------------------------------------------------------------------------- #

def test_vfov_derives_from_aspect_ratio():
    c = cam()
    expected = 2 * math.degrees(math.atan(math.tan(math.radians(HFOV) / 2) * H / W))
    assert c.derived_vfov_deg == pytest.approx(expected, abs=1e-6)
    # The number the mount-tilt reasoning depends on: a 70 deg lens spans
    # 43 deg of depression at once, which is what lets one fixed mount serve
    # both a shallow ID view and a steep ground-projection view.
    assert c.derived_vfov_deg == pytest.approx(43.0, abs=0.5)


def test_square_pixels_unless_vfov_given():
    assert cam().fy == cam().fx
    c = CameraModel(W, H, HFOV, vfov_deg=60.0)
    assert c.fy != c.fx


def test_rejects_impossible_intrinsics():
    with pytest.raises(ValueError):
        CameraModel(0, H, HFOV)
    with pytest.raises(ValueError):
        CameraModel(W, H, 200.0)


def test_scaled_to_preserves_fov():
    """A 640-wide detection box must not be projected with 1920-wide
    intrinsics. Same lens, same FOV, halved focal length."""
    full = cam()
    small = full.scaled_to(640, 360)
    assert small.hfov_deg == full.hfov_deg
    assert small.fx == pytest.approx(full.fx * 640 / W)


# --------------------------------------------------------------------------- #
# Pose: the facts that must hold                                                #
# --------------------------------------------------------------------------- #

def test_nadir_camera_sees_straight_down():
    c = cam()
    pose = CameraPose(agl_m=50.0, mount=MountOffset(tilt_deg=90.0))
    north, east, slant = pose.project_to_ground(c, *centre(c))
    assert north == pytest.approx(0.0, abs=1e-6)
    assert east == pytest.approx(0.0, abs=1e-6)
    assert slant == pytest.approx(50.0, abs=1e-6)
    assert pose.depression_deg(c, *centre(c)) == pytest.approx(90.0, abs=1e-6)


def test_45_degree_mount_puts_centre_one_altitude_ahead():
    """Ground range is h*cot(theta), so at 45 deg it equals the altitude —
    and it must land NORTH (ahead) with zero yaw, not behind or beside."""
    c = cam()
    pose = CameraPose(agl_m=50.0, mount=MountOffset(tilt_deg=45.0))
    north, east, slant = pose.project_to_ground(c, *centre(c))
    assert north == pytest.approx(50.0, abs=1e-6)
    assert east == pytest.approx(0.0, abs=1e-6)
    assert slant == pytest.approx(50.0 * math.sqrt(2), abs=1e-6)


def test_depression_at_centre_equals_mount_tilt_when_level():
    c = cam()
    for tilt in (20.0, 45.0, 60.0, 90.0):
        pose = CameraPose(agl_m=40.0, mount=MountOffset(tilt_deg=tilt))
        assert pose.depression_deg(c, *centre(c)) == pytest.approx(tilt, abs=1e-6)


def test_pitching_nose_up_raises_the_view():
    """MAVSDK pitch is positive nose-UP, so a positive pitch must DECREASE
    depression. Getting this backwards is the classic silent inversion."""
    c = cam()
    level = CameraPose(agl_m=50.0, mount=MountOffset(tilt_deg=45.0))
    nose_up = CameraPose(agl_m=50.0, pitch_deg=10.0, mount=MountOffset(tilt_deg=45.0))
    nose_dn = CameraPose(agl_m=50.0, pitch_deg=-10.0, mount=MountOffset(tilt_deg=45.0))

    assert nose_up.depression_deg(c, *centre(c)) == pytest.approx(35.0, abs=1e-6)
    assert nose_dn.depression_deg(c, *centre(c)) == pytest.approx(55.0, abs=1e-6)
    # ...and looking up pushes the ground intersection further away
    assert (nose_up.project_to_ground(c, *centre(c))[0]
            > level.project_to_ground(c, *centre(c))[0])


def test_yaw_rotates_ground_point_clockwise_from_above():
    c = cam()
    pose = CameraPose(agl_m=50.0, yaw_deg=90.0, mount=MountOffset(tilt_deg=45.0))
    north, east, _ = pose.project_to_ground(c, *centre(c))
    # Yaw +90 (clockwise from above, i.e. facing East) moves the point that
    # was 50 m North to 50 m East.
    assert north == pytest.approx(0.0, abs=1e-6)
    assert east == pytest.approx(50.0, abs=1e-6)


def test_above_horizon_returns_none_rather_than_a_huge_number():
    """The failure that matters. At a shallow mount the moment the airframe
    pitches up, the ray misses the ground — callers must get None, not a
    target parked 40 km away moving at Mach 3."""
    c = cam()
    pose = CameraPose(agl_m=50.0, pitch_deg=40.0, mount=MountOffset(tilt_deg=20.0))
    assert pose.project_to_ground(c, c.cx, 0.0) is None
    assert pose.depression_deg(c, c.cx, 0.0) is None


def test_no_altitude_returns_none():
    c = cam()
    assert CameraPose(agl_m=0.0).project_to_ground(c, *centre(c)) is None
    assert CameraPose(agl_m=-5.0).project_to_ground(c, *centre(c)) is None


# --------------------------------------------------------------------------- #
# Ground sample distance                                                        #
# --------------------------------------------------------------------------- #

def test_nadir_gsd_matches_the_closed_form():
    """At nadir, frame width on the ground is 2*h*tan(hfov/2), so
    m/px = that / image width. 50 m on a 70 deg 1080p lens is ~36.5 mm/px."""
    c = cam()
    pose = CameraPose(agl_m=50.0, mount=MountOffset(tilt_deg=90.0))
    expected = 2 * 50.0 * math.tan(math.radians(HFOV) / 2) / W
    assert pose.gsd_at_pixel(c, *centre(c)) == pytest.approx(expected, rel=1e-3)
    assert pose.gsd_at_pixel(c, *centre(c)) == pytest.approx(0.0365, abs=0.0005)


def test_gsd_grows_with_altitude_and_toward_the_horizon():
    c = cam()
    low = CameraPose(agl_m=25.0, mount=MountOffset(tilt_deg=90.0))
    high = CameraPose(agl_m=100.0, mount=MountOffset(tilt_deg=90.0))
    assert high.gsd_at_pixel(c, *centre(c)) == pytest.approx(
        4 * low.gsd_at_pixel(c, *centre(c)), rel=1e-3)

    # Perspective: a pixel near the top of frame covers more ground than one
    # at the bottom. This is why a single frame-wide GSD is wrong everywhere
    # except where it was computed.
    oblique = CameraPose(agl_m=50.0, mount=MountOffset(tilt_deg=45.0))
    near = oblique.gsd_at_pixel(c, c.cx, H * 0.75)
    far = oblique.gsd_at_pixel(c, c.cx, H * 0.25)
    assert far > near * 1.2


# --------------------------------------------------------------------------- #
# Scale resolution                                                              #
# --------------------------------------------------------------------------- #

def test_altitude_scale_error_shrinks_with_height():
    c = cam()
    mount = MountOffset(tilt_deg=90.0)
    low = scale_from_altitude(CameraPose(agl_m=10.0, mount=mount), c, *centre(c))
    high = scale_from_altitude(CameraPose(agl_m=50.0, mount=mount), c, *centre(c))
    assert low.error_pct == pytest.approx(15.0, abs=0.1)   # +-1.5m at 10m
    assert high.error_pct == pytest.approx(3.0, abs=0.1)   # +-1.5m at 50m


def test_object_scale_is_altitude_independent():
    s = scale_from_object_width(px_width=100.0, known_width_m=1.80)
    assert s.m_per_px == pytest.approx(0.018)
    assert s.error_pct == pytest.approx(4.0)
    assert scale_from_object_width(px_width=0.5, known_width_m=1.80) is None


def test_agreeing_sources_are_marked_agreed():
    a = ScaleEstimate(0.0360, "altitude", 3.0)
    b = ScaleEstimate(0.0365, "object", 4.0)
    out = resolve_scale(a, b, mode="auto", max_disagreement_pct=10.0)
    assert out.reliable is True
    assert out.source == "agreed"
    assert out.disagreement_pct < 2.0


def test_disagreeing_sources_are_flagged_not_averaged():
    """The whole point of two sources. A 50% mismatch means one of them is
    wrong, and the honest response is to withhold the reading."""
    a = ScaleEstimate(0.0360, "altitude", 3.0)
    b = ScaleEstimate(0.0540, "object", 4.0)
    out = resolve_scale(a, b, mode="auto", max_disagreement_pct=10.0)
    assert out.reliable is False
    assert out.disagreement_pct > 10.0
    assert "disagree" in out.note
    # and it must not have silently split the difference
    assert out.m_per_px in (a.m_per_px, b.m_per_px)


def test_explicit_mode_overrides_and_missing_source_degrades():
    a = ScaleEstimate(0.0360, "altitude", 3.0)
    b = ScaleEstimate(0.0540, "object", 4.0)
    assert resolve_scale(a, b, mode="altitude").m_per_px == a.m_per_px
    assert resolve_scale(a, b, mode="object").m_per_px == b.m_per_px
    assert resolve_scale(None, b, mode="auto").m_per_px == b.m_per_px
    assert resolve_scale(a, None, mode="auto").m_per_px == a.m_per_px
    assert resolve_scale(None, None, mode="auto") is None


# --------------------------------------------------------------------------- #
# Runtime calibration                                                           #
# --------------------------------------------------------------------------- #
#
# The values here are measured on a bench and stored server-side. The test that
# matters is that geometry READS them: reading get_settings() directly would
# silently ignore whatever was measured, which is the only source of these
# numbers that is ever right.

def test_calibration_overrides_reach_geometry(tmp_path, monkeypatch):
    from app.vision import calibration
    from app.vision.geometry import camera_from_settings, mount_from_settings

    monkeypatch.setattr(
        calibration, "CALIBRATION_PATH", str(tmp_path / "cal.json")
    )
    calibration.reset()
    try:
        assert camera_from_settings(1920, 1080).hfov_deg == 70.0   # default

        calibration.save({"camera_hfov_deg": 48.0, "camera_mount_tilt_deg": 33.0})
        # No restart, no new session — the next frame uses the new lens.
        assert camera_from_settings(1920, 1080).hfov_deg == 48.0
        assert mount_from_settings().tilt_deg == 33.0
    finally:
        calibration.reset()


def test_calibration_rejects_out_of_range_and_saves_nothing(tmp_path, monkeypatch):
    """All-or-nothing: a half-applied calibration would be flying."""
    from app.vision import calibration
    monkeypatch.setattr(calibration, "CALIBRATION_PATH", str(tmp_path / "cal.json"))
    calibration.reset()
    try:
        calibration.save({"camera_hfov_deg": 55.0})
        with pytest.raises(ValueError):
            calibration.save({"camera_hfov_deg": 60.0, "max_depression_deg": 999.0})
        # The valid field in the rejected batch must NOT have been applied.
        assert calibration.effective()["camera_hfov_deg"] == 55.0
    finally:
        calibration.reset()


def test_calibration_rejects_unknown_keys_and_bad_enums(tmp_path, monkeypatch):
    from app.vision import calibration
    monkeypatch.setattr(calibration, "CALIBRATION_PATH", str(tmp_path / "cal.json"))
    with pytest.raises(ValueError, match="unknown setting"):
        calibration.coerce("definitely_not_a_field", 1)
    with pytest.raises(ValueError, match="one of"):
        calibration.coerce("agl_source", "lidar")


def test_corrupt_calibration_file_falls_back_to_defaults(tmp_path, monkeypatch):
    """A bad file must not take the vision pipeline down with it."""
    from app.vision import calibration
    path = tmp_path / "cal.json"
    path.write_text("{ this is not json")
    monkeypatch.setattr(calibration, "CALIBRATION_PATH", str(path))
    calibration._cache = None
    assert calibration.effective()["camera_hfov_deg"] == 70.0


def test_schema_serves_ranges_for_the_ui(tmp_path, monkeypatch):
    """Ranges are defined once, in Python, and handed to the frontend. Declaring
    them in both languages is how the two drift and the form starts accepting
    values the backend rejects."""
    from app.vision import calibration
    monkeypatch.setattr(calibration, "CALIBRATION_PATH", str(tmp_path / "cal.json"))
    calibration._cache = None
    schema = calibration.schema()
    assert schema["calibrated"] is False
    keys = {f["key"] for f in schema["fields"]}
    assert "camera_hfov_deg" in keys
    assert "max_altitude_agl_m" in keys
    for f in schema["fields"]:
        assert f["help"], f"{f['key']} has no help text"
        assert f["group"] in ("camera", "limits")
        if f["type"] != "enum":
            assert f["min"] < f["max"]
        else:
            assert f["options"]


def test_pursuit_limits_follow_the_calibration(tmp_path, monkeypatch):
    """An operator lowering the ceiling for one mission must be honoured, not
    the deploy-time default."""
    from app.vision import calibration
    from app.vision.pursuit import PursuitLimits
    monkeypatch.setattr(calibration, "CALIBRATION_PATH", str(tmp_path / "cal.json"))
    calibration.reset()
    try:
        assert PursuitLimits.from_settings().max_altitude_agl_m == 120.0
        calibration.save({"max_altitude_agl_m": 60.0})
        assert PursuitLimits.from_settings().max_altitude_agl_m == 60.0
    finally:
        calibration.reset()
