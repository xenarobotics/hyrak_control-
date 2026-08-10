"""
Fixed altitude: the frame row is the range signal, and it was going unread.

REPORTED FROM FLIGHT: "in fixed altitude, when the person is on the lower side
of the frame the drone moves FORWARD instead of moving back."

Two separate defects produced that, and both are here.

1.  FIXED MODE HAD NO VERTICAL FRAMING CONTROL AT ALL. err_alt was computed on
    every frame and then discarded unless the mode was Auto, so where the
    subject sat vertically drove nothing. The only thing steering forward/back
    was apparent size — an estimate that needs the mount tilt and the subject's
    real height to mean anything.

    Yet with altitude HELD and the camera bolted down, the row the subject's
    feet occupy IS horizontal range: high in frame is far, low in frame is near.
    That is the whole geometry, it needs no calibration, and it was being
    thrown away.

2.  THE POSITION-BASED RANGE ESTIMATE HAD A FORWARD BIAS. _range_observable
    projected the box CENTRE to the ground while its own comment said "Feet,
    not centre". A centre floats half a subject's height up, so its ray cleared
    the subject and hit the ground beyond them:

        over-estimate = AGL / (AGL - h/2),  independent of viewing angle
        6 m AGL -> +17%    4 m -> +27%    3 m -> +40%    2 m -> +74%

    Range too long reads as "further than wanted", which commands FORWARD. And
    the position estimate is blended in hardest at STEEP depression — i.e.
    exactly when the subject is low in the frame — so the fault switched itself
    on precisely where it was reported.

Auto altitude mode is deliberately left alone; it is flying well. The only
change it sees is the bias in (2) going away, which it can only benefit from.
"""
import pytest

from app.vision.controllers import PDController
from app.vision.geometry import CameraModel, CameraPose, MountOffset
from app.vision.pursuit import (
    PursuitLimits,
    ROW_NUDGE_STEP,
    _ROW_TARGET_MAX,
    _ROW_TARGET_MIN,
    clamp_row_target,
    distance_axis,
    foot_row,
    frame_row_range_error,
    limit_climb,
    limit_descent,
    new_row_pd,
    row_reference_is_stale,
    scale_forward,
)


def _state(target_row=None, altitude_mode="fixed"):
    """The subset of a follow module's state dict that distance_axis touches."""
    return {
        "row_pd": new_row_pd(),
        "dist_pd": PDController(kp=4.0, kd=1.0, max_output=2.5, deadband=0.08),
        "target_row": target_row,
        "altitude_mode": altitude_mode,
    }


# --------------------------------------------------------------------------- #
# THE REPORTED BUG, in both directions                                          #
# --------------------------------------------------------------------------- #

def test_subject_low_in_frame_moves_BACK():
    """THE REPORTED BUG. Low in frame means near, so the only correct command is
    backwards. This produced forward."""
    st = _state(target_row=0.55)
    forward, err = distance_axis(
        state=st, altitude_mode="fixed",
        foot_row_n=0.85,            # feet well below where we want them
        size_range_error=+0.30,     # size says "far" — must not win
    )
    assert err < 0, "below the target row is TOO CLOSE, so the error is negative"
    assert forward < 0, f"must retreat, commanded {forward:+.2f} m/s"


def test_subject_high_in_frame_moves_FORWARD():
    st = _state(target_row=0.55)
    forward, err = distance_axis(
        state=st, altitude_mode="fixed",
        foot_row_n=0.30,
        size_range_error=-0.30,     # size says "close" — must not win
    )
    assert err > 0
    assert forward > 0, f"must close in, commanded {forward:+.2f} m/s"


def test_apparent_size_cannot_override_the_row_in_fixed_mode():
    """The two estimates disagreeing is exactly the reported failure. In Fixed
    the row wins outright — not a blend, which would let the biased estimate
    drag the sign back."""
    low  = distance_axis(state=_state(0.55), altitude_mode="fixed",
                         foot_row_n=0.85, size_range_error=+9.9)[0]
    high = distance_axis(state=_state(0.55), altitude_mode="fixed",
                         foot_row_n=0.30, size_range_error=-9.9)[0]
    assert low < 0 and high > 0


def test_a_centred_subject_is_left_alone():
    forward, err = distance_axis(state=_state(0.55), altitude_mode="fixed",
                                foot_row_n=0.55, size_range_error=+0.30)
    assert err == pytest.approx(0.0)
    assert forward == 0.0


@pytest.mark.parametrize("row,expect", [
    (0.20, "forward"), (0.40, "forward"), (0.54, "still"),
    (0.56, "still"), (0.70, "back"), (0.90, "back"),
])
def test_the_sign_is_monotonic_across_the_whole_frame(row, expect):
    """No row anywhere in the frame may produce the wrong sign — the bug was a
    sign inversion in one region, not a magnitude error."""
    forward, _ = distance_axis(state=_state(0.55), altitude_mode="fixed",
                               foot_row_n=row, size_range_error=0.0)
    got = "forward" if forward > 0.01 else "back" if forward < -0.01 else "still"
    assert got == expect, f"row {row}: expected {expect}, got {got} ({forward:+.2f})"


# --------------------------------------------------------------------------- #
# Why no camera angle is needed                                                 #
# --------------------------------------------------------------------------- #

def test_the_row_axis_needs_no_calibration_at_all():
    """The operator asked whether the camera angle is involved. It is not, and
    that is the point: the SIGN follows from the camera pointing downward at
    all, and every calibration term would only scale a response the PD gain
    already scales. So this axis works on a rig nobody has measured, which the
    size-based axis does not — that one needs the mount tilt to de-foreshorten
    and the subject's true height to convert fill into distance.

    Pinned by signature: if a tilt, an FOV or an AGL ever has to be threaded in
    here, that claim has stopped being true and this test should fail.
    """
    import inspect
    for fn in (foot_row, frame_row_range_error, clamp_row_target):
        params = set(inspect.signature(fn).parameters)
        leaked = {p for p in params
                  if any(k in p.lower() for k in
                         ("tilt", "fov", "agl", "cam", "pose", "depress", "height_m"))}
        assert not leaked, f"{fn.__name__} took calibration: {leaked}"

    sig = set(inspect.signature(distance_axis).parameters)
    assert sig == {"state", "altitude_mode", "foot_row_n", "size_range_error"}


# --------------------------------------------------------------------------- #
# The target row                                                                #
# --------------------------------------------------------------------------- #

def test_the_target_row_is_taken_from_the_subject_not_from_frame_centre():
    """Hard-coding 0.5 would be wrong on a shallow-mounted camera: the whole
    ground plane images BELOW the horizon there, so frame centre is unreachable
    and "centre the subject" would mean "retreat forever". A row the subject was
    actually observed on is reachable by construction."""
    st = _state(target_row=None)
    forward, err = distance_axis(state=st, altitude_mode="fixed",
                                foot_row_n=0.72, size_range_error=0.0)
    assert st["target_row"] == pytest.approx(0.72)
    assert err == pytest.approx(0.0)
    assert forward == 0.0, "seeding must not itself command motion"


def test_a_subject_locked_near_the_horizon_is_pulled_to_a_measurable_row():
    """Rows near the top of frame are near the horizon, where a pixel of noise
    is tens of metres of range. The target is clamped down out of that band, so
    the drone closes in to somewhere it can actually hold station."""
    st = _state(target_row=None)
    distance_axis(state=st, altitude_mode="fixed",
                  foot_row_n=0.04, size_range_error=0.0)
    assert st["target_row"] == pytest.approx(_ROW_TARGET_MIN)
    forward, _ = distance_axis(state=st, altitude_mode="fixed",
                               foot_row_n=0.04, size_range_error=0.0)
    assert forward > 0, "should close in to the nearest holdable row"


def test_every_legal_target_row_has_a_measurable_error():
    """_ROW_TARGET_MAX must stay clear of the truncation threshold, or a legal
    target row would be one whose error is never readable."""
    from app.vision.pursuit import _ROW_FOOT_OFF_FRAME
    assert _ROW_TARGET_MAX < _ROW_FOOT_OFF_FRAME
    assert 0.0 < _ROW_TARGET_MIN < _ROW_TARGET_MAX < 1.0


# --------------------------------------------------------------------------- #
# Bottom-truncated subject: the one case where the row lies                      #
# --------------------------------------------------------------------------- #

def test_feet_off_the_bottom_of_frame_never_reads_as_far():
    """When the box is cut off at the bottom edge its height is understated, so
    foot_row is understated too — the subject reads HIGHER in frame, i.e.
    further away, and the drone would drive forward at the one moment it is
    nearly on top of them. With a downward camera that is the closest the
    subject ever gets."""
    err = frame_row_range_error(0.995, target_row_n=_ROW_TARGET_MAX)
    assert err < 0, "must read as too close"

    forward, _ = distance_axis(state=_state(_ROW_TARGET_MAX),
                               altitude_mode="fixed",
                               foot_row_n=0.995, size_range_error=+5.0)
    assert forward < 0


def test_the_truncated_retreat_is_bounded():
    """It must be a definite retreat and not a lurch — the aircraft is close to
    something when this fires."""
    forward, _ = distance_axis(state=_state(0.55), altitude_mode="fixed",
                               foot_row_n=1.0, size_range_error=0.0)
    assert -1.0 < forward < 0.0


# --------------------------------------------------------------------------- #
# foot_row                                                                      #
# --------------------------------------------------------------------------- #

def test_the_foot_row_is_below_the_box_centre_by_half_the_box():
    assert foot_row(0.5, 0.30) == pytest.approx(0.65)
    assert foot_row(0.5, 0.0) == pytest.approx(0.5)


def test_a_growing_box_does_not_move_the_foot_row_on_its_own():
    """A subject walking closer grows the box downward AND upward around a
    centre that rises; the feet are what stay on the ground. This is why the
    control reads the feet — using the centre would fold apparent size back into
    the signal that is supposed to be independent of it."""
    # Subject at a fixed ground position, box growing as they approach: the
    # centre climbs the frame while the feet hold their row.
    assert foot_row(0.70, 0.20) == pytest.approx(0.80)
    assert foot_row(0.65, 0.30) == pytest.approx(0.80)
    assert foot_row(0.60, 0.40) == pytest.approx(0.80)


# --------------------------------------------------------------------------- #
# Auto mode is untouched                                                        #
# --------------------------------------------------------------------------- #

def test_auto_mode_still_reads_apparent_size_and_ignores_the_row():
    """The operator's instruction was explicit: Auto is flying well, leave it.
    Its forward axis must come out of the size PD exactly as before, whatever
    the row happens to be."""
    reference = PDController(kp=4.0, kd=1.0, max_output=2.5, deadband=0.08)
    expected = reference.compute(+0.30)

    for row in (0.05, 0.5, 0.99):
        st = _state(target_row=0.55, altitude_mode="auto")
        forward, err = distance_axis(state=st, altitude_mode="auto",
                                     foot_row_n=row, size_range_error=+0.30)
        assert err == pytest.approx(0.30)
        assert forward == pytest.approx(expected)


def test_auto_mode_does_not_seed_or_disturb_the_target_row():
    st = _state(target_row=None, altitude_mode="auto")
    distance_axis(state=st, altitude_mode="auto",
                  foot_row_n=0.8, size_range_error=0.1)
    assert st["target_row"] is None


def test_auto_keeps_the_old_symmetric_yaw_priority():
    """scale_forward's retreat exemption is a Fixed-mode change. Applying it to
    Auto would be a change to how Auto backs off, which is not part of this."""
    assert scale_forward(-2.0, 0.35, "auto") == pytest.approx(-0.70)


# --------------------------------------------------------------------------- #
# A retreat is never throttled                                                  #
# --------------------------------------------------------------------------- #

def test_a_retreat_is_not_scaled_down_for_being_off_axis():
    """Yaw priority exists to stop the drone charging at a subject it has not
    centred. Scaling a RETREAT by the same factor had it back away slowest
    exactly when it was nearest and most off-axis."""
    assert scale_forward(-2.0, 0.35, "fixed") == pytest.approx(-2.0)


def test_forward_is_still_throttled_off_axis():
    assert scale_forward(+2.0, 0.35, "fixed") == pytest.approx(+0.70)


# --------------------------------------------------------------------------- #
# The row reference is only valid while altitude is held                        #
# --------------------------------------------------------------------------- #

def test_a_climb_invalidates_the_row_reference():
    """Row ranging assumes a held altitude — that is its entire premise. A climb
    steepens the depression, drops the subject down the frame and reads as "too
    close", so an uncorrected reference would command a RETREAT during exactly
    the climb auto-elevate ordered to chase something pulling away."""
    assert row_reference_is_stale("fixed", -1.2) is True
    assert row_reference_is_stale("fixed", +0.5) is True


def test_a_held_altitude_keeps_the_reference():
    assert row_reference_is_stale("fixed", 0.0) is False
    assert row_reference_is_stale("fixed", 0.01) is False


def test_auto_mode_never_re_takes_the_row():
    """Auto moves vertically constantly and does not use the row at all;
    re-seeding on its behalf would be churn."""
    assert row_reference_is_stale("auto", -1.2) is False


# --------------------------------------------------------------------------- #
# THE CLIMB CEILING — the gap in the earlier altitude work                      #
# --------------------------------------------------------------------------- #

def test_the_operator_nudge_could_climb_through_the_ceiling():
    """The floor was added everywhere after an unguarded descent flew a SITL
    aircraft into the ground. The CEILING was only ever enforced inside
    decide_elevation, i.e. on the climbs auto-elevate decided. A held ▲ nudge in
    Fixed mode reached down_m_s having passed no altitude check whatsoever."""
    limits = PursuitLimits(max_altitude_agl_m=120.0)
    allowed, reason = limit_climb(-1.0, agl_m=125.0, limits=limits)
    assert allowed == 0.0
    assert reason and "ceiling" in reason


def test_the_climb_eases_onto_the_ceiling():
    limits = PursuitLimits(max_altitude_agl_m=120.0)
    allowed, reason = limit_climb(-1.0, agl_m=119.25, limits=limits)
    assert -1.0 < allowed < 0.0
    assert reason


def test_a_blind_climb_passes_through_but_says_so():
    """Deliberately the OPPOSITE of limit_descent, which zeroes a blind descent.

    decide_elevation already refuses to climb without AGL, so the only climb that
    can arrive here blind is the operator's held ▲ — a deliberate command from
    someone watching their own altitude. Zeroing that kills a manual control in
    exchange for a ceiling we cannot measure anyway. The descent guard is a
    different case: it catches an AUTONOMOUS descent nobody asked for, where the
    failure is immediate and destroys the aircraft.
    """
    allowed, reason = limit_climb(-1.0, agl_m=None, limits=PursuitLimits())
    assert allowed == -1.0
    assert reason and "not being enforced" in reason


def test_a_blind_descent_is_still_refused():
    """The asymmetry above must not have loosened the floor."""
    allowed, reason = limit_descent(+1.0, agl_m=None, limits=PursuitLimits())
    assert allowed == 0.0
    assert reason and "blind" in reason


def test_the_ceiling_is_enforced_on_the_nudge_whenever_agl_is_known():
    """The pass-through is only for the case where the bound is unmeasurable.
    With a reading, a held ▲ is clamped like anything else."""
    limits = PursuitLimits(max_altitude_agl_m=120.0)
    assert limit_climb(-1.0, agl_m=120.0, limits=limits)[0] == 0.0
    assert limit_climb(-1.0, agl_m=119.9, limits=limits)[0] > -0.2   # eased hard
    assert limit_climb(-1.0, agl_m=60.0, limits=limits)[0] == -1.0   # untouched


def test_the_climb_guard_leaves_descent_alone():
    """The two guards must not overlap, or the floor's easing would be applied
    twice or fought."""
    assert limit_climb(+0.8, agl_m=50.0, limits=PursuitLimits()) == (0.8, None)
    assert limit_descent(-0.8, agl_m=50.0, limits=PursuitLimits()) == (-0.8, None)


def test_a_normal_climb_well_inside_the_ceiling_is_untouched():
    limits = PursuitLimits(max_altitude_agl_m=120.0)
    assert limit_climb(-1.2, agl_m=30.0, limits=limits) == (-1.2, None)


# --------------------------------------------------------------------------- #
# The feet-vs-centre projection bias                                            #
# --------------------------------------------------------------------------- #

def _cam():
    return CameraModel(width=1920, height=1080, hfov_deg=70.0)


@pytest.mark.parametrize("agl", [12.0, 6.0, 4.0, 3.0, 2.0])
def test_the_centre_ray_over_estimates_range_by_the_predicted_factor(agl):
    """The magnitude of the bias, pinned by the identity it comes from.

    A single ray hits the plane at height H_p at slant (agl - H_p)/down, and the
    ground at agl/down. So the SAME ray, asked where it meets the ground rather
    than where it meets the subject's mid-height, comes back long by exactly

        agl / (agl - h/2)

    with the ray direction cancelling — which is why the bias does not depend on
    viewing angle, only on how low the aircraft is flying. That is the number
    quoted in _range_observable, and range too long commands FORWARD.
    """
    cam = _cam()
    half_subject = 0.85
    v = cam.height * 0.62          # some row below the horizon; any will do
    u = cam.width / 2.0

    to_ground = CameraPose(agl_m=agl, mount=MountOffset(tilt_deg=45.0)) \
        .project_to_ground(cam, u, v)
    # The same ray asked where it passes the subject's mid-height: identical
    # geometry with the camera that much lower.
    to_subject = CameraPose(agl_m=agl - half_subject,
                            mount=MountOffset(tilt_deg=45.0)) \
        .project_to_ground(cam, u, v)
    assert to_ground is not None and to_subject is not None

    ratio = to_ground[2] / to_subject[2]
    assert ratio == pytest.approx(agl / (agl - half_subject), rel=1e-6)
    assert ratio > 1.0, "the bias is always toward TOO FAR, i.e. toward forward"


@pytest.mark.parametrize("agl", [12.0, 6.0, 3.0])
@pytest.mark.parametrize("tilt", [30.0, 45.0, 65.0])
def test_the_foot_row_always_projects_nearer_than_the_box_centre(agl, tilt):
    """The direction of the fix, across altitudes and mount angles: whatever the
    geometry, the feet are the nearer intersection. The old code took the
    further one and called it the range to the subject."""
    cam = _cam()
    pose = CameraPose(agl_m=agl, mount=MountOffset(tilt_deg=tilt))
    u = cam.width / 2.0
    centre_v, foot_v = cam.height * 0.55, cam.height * 0.72

    from_centre = pose.project_to_ground(cam, u, centre_v)
    from_feet = pose.project_to_ground(cam, u, foot_v)
    assert from_centre is not None and from_feet is not None
    assert from_feet[2] < from_centre[2]


def test_all_four_size_ranging_modules_project_from_the_feet():
    """The comment said "Feet, not centre" in all four while all four passed the
    box centre. A per-module fix would drift again, so this pins every one."""
    from pathlib import Path
    root = Path(__file__).resolve().parents[1] / "app" / "vision" / "modules"
    for name in ("human_tracker", "person_tracker", "crowd_manager", "plate_tracker"):
        src = (root / f"{name}.py").read_text()
        assert "project_to_ground(cam, px, foot_n * H)" in src, name
        assert "project_to_ground(cam, px, py)" not in src, (
            f"{name} still projects the box centre to the ground"
        )


# --------------------------------------------------------------------------- #
# All five follow modules, consistently                                         #
# --------------------------------------------------------------------------- #

_FOLLOW_MODULES = ("human_tracker", "person_tracker", "crowd_manager",
                   "plate_tracker", "traffic_manager")


@pytest.mark.parametrize("name", _FOLLOW_MODULES)
def test_every_follow_module_uses_the_shared_distance_axis(name):
    """These five had already drifted apart once — one still computes its size
    error as a raw fill difference where the rest use a fraction of range. Which
    SENSOR owns the forward axis is not a thing that should be able to differ
    between them, so it lives in pursuit.py and every module calls it."""
    from pathlib import Path
    src = (Path(__file__).resolve().parents[1] / "app" / "vision" / "modules"
           / f"{name}.py").read_text()
    assert "distance_axis(" in src, f"{name} does not use the shared axis"
    assert "scale_forward(" in src, f"{name} does not use the shared yaw priority"
    assert '"row_pd"' in src or "'row_pd'" in src, f"{name} has no row PD"
    assert "target_row" in src, f"{name} has no target row"


@pytest.mark.parametrize("name", _FOLLOW_MODULES)
def test_every_follow_module_bounds_both_ends_of_the_altitude_range(name):
    """limit_descent was applied everywhere; limit_climb was applied nowhere."""
    from pathlib import Path
    src = (Path(__file__).resolve().parents[1] / "app" / "vision" / "modules"
           / f"{name}.py").read_text()
    assert "limit_descent(" in src, f"{name} has no altitude floor"
    assert "limit_climb(" in src, f"{name} has no altitude ceiling"


@pytest.mark.parametrize("name", _FOLLOW_MODULES)
def test_every_follow_module_re_takes_the_row_when_altitude_moves(name):
    from pathlib import Path
    src = (Path(__file__).resolve().parents[1] / "app" / "vision" / "modules"
           / f"{name}.py").read_text()
    assert "row_reference_is_stale(" in src, name


@pytest.mark.parametrize("name", _FOLLOW_MODULES)
def test_no_follow_module_computes_forward_from_the_size_pd_directly(name):
    """The old expression. If it comes back, the row axis has been bypassed."""
    from pathlib import Path
    src = (Path(__file__).resolve().parents[1] / "app" / "vision" / "modules"
           / f"{name}.py").read_text()
    assert 'dist_pd"].compute(' not in src, f"{name} bypasses distance_axis"
    assert "dist_pd.compute(" not in src, f"{name} bypasses distance_axis"


# --------------------------------------------------------------------------- #
# CLOSER / FURTHER keeps working in the mode it no longer natively drives        #
# --------------------------------------------------------------------------- #

def _human():
    from app.vision.modules.human_tracker import HumanTracker, _make_state
    t = HumanTracker.__new__(HumanTracker)
    t._client_state = {"sess": _make_state()}
    return t, t._client_state["sess"]


def test_closer_and_further_move_the_target_row_in_fixed_mode():
    """In Fixed the forward axis reads the row, so a distance RATIO alone would
    not reach it and this control would silently go dead in the default mode."""
    t, st = _human()
    st["target_row"] = 0.50
    start = st["target_distance_ratio"]

    t.set_tracking_params("sess", start + 0.06)          # CLOSER
    assert st["target_row"] == pytest.approx(0.50 + ROW_NUDGE_STEP)

    t.set_tracking_params("sess", start)                 # FURTHER
    assert st["target_row"] == pytest.approx(0.50)


def test_closer_and_further_stay_inside_the_holdable_band():
    t, st = _human()
    st["target_row"] = 0.50
    for i in range(40):
        t.set_tracking_params("sess", 0.10 + 0.01 * i)
    assert st["target_row"] <= _ROW_TARGET_MAX
    for i in range(40):
        t.set_tracking_params("sess", 0.60 - 0.01 * i)
    assert st["target_row"] >= _ROW_TARGET_MIN


def test_the_ratio_is_still_stored_for_auto():
    t, st = _human()
    t.set_tracking_params("sess", 0.42)
    assert st["target_distance_ratio"] == pytest.approx(0.42)


# --------------------------------------------------------------------------- #
# Mode and lock transitions                                                     #
# --------------------------------------------------------------------------- #

def test_switching_into_fixed_re_takes_the_row_at_the_height_reached():
    """Auto will have flown the aircraft somewhere else vertically, so the row
    that described a range under the old height no longer does."""
    t, st = _human()
    st["target_row"] = 0.30
    t.set_altitude_mode("sess", "auto")
    t.set_altitude_mode("sess", "fixed")
    assert st["target_row"] is None


def test_switching_modes_resets_the_incoming_pd():
    """The two PDs carry derivatives in unrelated units — frame heights versus
    a fraction of range — so whichever is about to start must not begin with the
    other's history."""
    t, st = _human()
    st["row_pd"]._prev_error = 0.4
    st["dist_pd"]._prev_error = 0.4
    t.set_altitude_mode("sess", "fixed")
    assert st["row_pd"]._prev_error == 0.0
    t.set_altitude_mode("sess", "auto")
    assert st["dist_pd"]._prev_error == 0.0


def test_a_new_lock_takes_a_fresh_row():
    """The framing on screen when the operator presses start IS the framing they
    asked for; a row left over from the previous subject is not."""
    t, st = _human()
    st["target_row"] = 0.80
    t.set_tracking("sess", True)
    assert st["target_row"] is None


def test_stopping_tracking_clears_the_row_pd():
    t, st = _human()
    st["row_pd"]._prev_error = 0.4
    t.set_tracking("sess", False)
    assert st["row_pd"]._prev_error == 0.0


# --------------------------------------------------------------------------- #
# End to end, through a real follow loop                                        #
# --------------------------------------------------------------------------- #
#
# Everything above tests the shared primitives. This drives an actual module's
# _follow, which is the only way to prove the wiring — the sign could be right in
# pursuit.py and still be read backwards at the call site, and that is precisely
# the class of mistake being fixed here. plate_tracker is used because its follow
# loop is callable without loading a detector.

def _plate_follow(box, target_row, mode="fixed", frames=8):
    import importlib
    tp = importlib.import_module("test_plate_tracker")
    t = tp.bare_tracker()
    st = t._client_state["s"]
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    t.set_altitude_mode("s", mode)
    st["target_row"] = target_row
    v = tp.vehicle(7, *box)
    cmd = None
    for _ in range(frames):
        cmd = t._follow(st, [v], "s", 1920, 1080, None, None)
    return cmd, st


def test_end_to_end_a_subject_low_in_frame_commands_BACKWARD():
    """THE EXACT REPORTED SYMPTOM, through a real follow loop. Box sits low, so
    the ground contact is well below the row we want it on."""
    cmd, _ = _plate_follow((900, 700, 1100, 900), target_row=0.45)
    assert cmd["forward_m_s"] < 0, f"commanded {cmd['forward_m_s']:+.2f} m/s"


def test_end_to_end_a_subject_high_in_frame_commands_FORWARD():
    cmd, _ = _plate_follow((900, 200, 1100, 320), target_row=0.75)
    assert cmd["forward_m_s"] > 0, f"commanded {cmd['forward_m_s']:+.2f} m/s"


def test_end_to_end_altitude_is_not_touched_by_vertical_framing_in_fixed():
    """Fixed means fixed. The vertical framing error now steers forward/back,
    and it must not have leaked into the altitude axis on the way."""
    for box in ((900, 700, 1100, 900), (900, 200, 1100, 320)):
        cmd, _ = _plate_follow(box, target_row=0.45)
        assert cmd["down_m_s"] == 0.0, f"{box} moved altitude: {cmd['down_m_s']}"
