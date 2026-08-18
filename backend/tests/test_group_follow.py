"""
Group follow: keeping two or more subjects in frame at once.

WHAT IS ACTUALLY BEING TESTED, and why it is not just "follow, but twice".

Single-target follow chases a SETPOINT. Group follow enforces a CONTAINMENT
CONSTRAINT. Every test below exists because the naive extension of the first
into the second is wrong in a specific, flyable way:

  * A single fill threshold makes the aircraft pump in and out forever, because
    two independently moving subjects change the group box every frame. The
    band, the dead zone between its edges, and the dwell latch are all one
    answer to that.

  * The group box SHRINKS when a member drops out of frame. The naive signal
    therefore says "too small, close in" at exactly the moment closing in makes
    that member's loss permanent. Forward is clamped to <= 0 while anyone is
    missing, and it is a safety rule rather than a tuning choice.

  * Widening by climbing alone steepens the depression until this module's own
    analytics stop working; widening by retreating alone walks the aircraft
    backwards. The split holds the look angle, so the manoeuvre costs range and
    nothing else.

  * Two subjects walking apart need range that grows without bound. There is no
    manoeuvre that wins, so the attempt is time-bounded and its failure is
    named and reported rather than being flown into indefinitely.
"""
import importlib
import inspect
import math

import pytest

from app.vision.group_follow import (
    GROUP_DWELL_S,
    GROUP_EDGE_MARGIN,
    GROUP_GIVE_UP_S,
    GROUP_MAX_FILL_H,
    GROUP_MAX_FILL_W,
    GROUP_MIN_FILL_H,
    GROUP_MIN_FILL_W,
    GROUP_WIDEN_LIMIT_M,
    MAX_FOLLOW_MEMBERS,
    MEMBER_RETIRE_S,
    GroupAction,
    GroupLatch,
    GroupState,
    assess_framing,
    clamp_members,
    edge_breach,
    fix_from_telemetry,
    group_box,
    required_range_m,
    widen_velocity,
)

W, H = 1920, 1080


def _boxes(*rects):
    return [list(r) for r in rects]


def _framing(*rects):
    bs = _boxes(*rects)
    gb = group_box(bs, W, H)
    return assess_framing(gb, bs, W, H)


def _centred(fill_w, fill_h):
    """One box centred in frame at the requested fill — the group box IS this
    box, so it isolates the fill decision from where the group sits."""
    w, h = fill_w * W, fill_h * H
    x1, y1 = (W - w) / 2, (H - h) / 2
    return [x1, y1, x1 + w, y1 + h]


# --------------------------------------------------------------------------- #
# The group box                                                                 #
# --------------------------------------------------------------------------- #

def test_the_group_box_is_the_union_not_the_average():
    """Two subjects at opposite sides must produce a box spanning both. An
    averaged centre with an averaged size would sit between them and describe
    a region containing neither."""
    gb = group_box(_boxes([100, 200, 300, 600], [1500, 100, 1700, 500]), W, H)
    assert gb.x1 == pytest.approx(100 / W)
    assert gb.x2 == pytest.approx(1700 / W)
    assert gb.y1 == pytest.approx(100 / H)
    assert gb.y2 == pytest.approx(600 / H)


def test_an_empty_group_has_no_box_rather_than_a_box_at_the_origin():
    """A degenerate box at (0,0) would read as a subject in the top-left corner
    and command a hard yaw toward nothing."""
    assert group_box([], W, H) is None


def test_the_group_box_centre_is_between_the_members():
    gb = group_box(_boxes([0, 0, 200, 200], [W - 200, H - 200, W, H]), W, H)
    assert gb.cx == pytest.approx(0.5)
    assert gb.cy == pytest.approx(0.5)


# --------------------------------------------------------------------------- #
# Edge proximity — the signal that actually predicts a loss                     #
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("rect,edge", [
    ([2, 400, 300, 700], "left"),
    ([W - 300, 400, W - 2, 700], "right"),
    ([700, 2, 900, 300], "top"),
    ([700, H - 300, 900, H - 2], "bottom"),
])
def test_each_frame_edge_is_detected(rect, edge):
    assert edge_breach(_boxes(rect), W, H) == edge


def test_edge_proximity_is_checked_per_member_not_on_the_group_box():
    """THE CASE THAT MOTIVATES IT. Three subjects: the union sits comfortably
    inside the margins only if you ignore that one of them is hugging an edge.
    Checking the union alone would report the group as safely framed."""
    inner = _boxes([600, 400, 800, 700], [1000, 400, 1200, 700])
    assert edge_breach(inner, W, H) is None
    with_edge = inner + [[W - 40, 400, W - 5, 700]]
    assert edge_breach(with_edge, W, H) == "right"


def test_a_group_that_is_small_but_touching_an_edge_still_widens():
    """Fill says "close in", the edge says "back off". The edge must win: fill
    only correlates with losing someone, edge proximity predicts it."""
    f = _framing([20, 450, 220, 650])
    assert f.fill_w < GROUP_MIN_FILL_W and f.fill_h < GROUP_MIN_FILL_H
    assert f.action == GroupAction.WIDEN
    assert f.error < 0
    assert f.edge == "left"


def test_the_edge_margin_leaves_room_to_act_before_truncation():
    """The point of acting at 4% rather than 0% is that a truncated box stops
    describing its subject, so the controller loses its input just as it needs
    it most."""
    assert 0.01 < GROUP_EDGE_MARGIN < 0.10


# --------------------------------------------------------------------------- #
# The containment band                                                          #
# --------------------------------------------------------------------------- #

def test_a_group_inside_the_band_commands_nothing():
    """The dead zone IS the feature. A controller with an exact setpoint here
    would chase a target that moves every time either subject takes a step."""
    mid_w = (GROUP_MAX_FILL_W + GROUP_MIN_FILL_W) / 2
    mid_h = (GROUP_MAX_FILL_H + GROUP_MIN_FILL_H) / 2
    f = _framing(_centred(mid_w, mid_h))
    assert f.action == GroupAction.HOLD
    assert f.error == 0.0


def test_too_wide_backs_off():
    f = _framing(_centred(GROUP_MAX_FILL_W + 0.10, 0.30))
    assert f.action == GroupAction.WIDEN
    assert f.error < 0


def test_too_tall_backs_off_even_when_the_width_is_fine():
    """Fitting on one axis is not fitting. With a downward camera the vertical
    axis is the range axis, so this is the breach that happens in practice."""
    f = _framing(_centred(0.50, GROUP_MAX_FILL_H + 0.10))
    assert f.action == GroupAction.WIDEN
    assert f.error < 0


def test_too_small_closes_in():
    f = _framing(_centred(GROUP_MIN_FILL_W - 0.20, GROUP_MIN_FILL_H - 0.20))
    assert f.action == GroupAction.CLOSE
    assert f.error > 0


def test_the_band_has_real_width_in_both_axes():
    """A band narrower than the frame-to-frame noise is a threshold wearing a
    band's clothes."""
    assert GROUP_MAX_FILL_W - GROUP_MIN_FILL_W >= 0.2
    assert GROUP_MAX_FILL_H - GROUP_MIN_FILL_H >= 0.2


def test_the_height_margin_is_tighter_than_the_width_margin():
    """Fixed downward mount: subjects exit the BOTTOM of frame long before a
    side-by-side pair troubles the width. If these were equal the vertical
    breach would always arrive unannounced."""
    assert GROUP_MAX_FILL_H < GROUP_MAX_FILL_W


def test_closing_in_stops_at_the_nearer_floor_not_the_further_one():
    """Closing until the TIGHTER axis reaches its minimum overshoots the other
    straight back out of the band, which is a self-inflicted oscillation."""
    # Width is far below its floor, height only just below its own.
    f = _framing(_centred(0.10, GROUP_MIN_FILL_H - 0.02))
    assert f.action == GroupAction.CLOSE
    assert f.error == pytest.approx(0.02, abs=1e-6)


# --------------------------------------------------------------------------- #
# The dwell latch, and the asymmetry in it                                      #
# --------------------------------------------------------------------------- #

def test_widening_is_adopted_immediately():
    """Waiting half a second to react to a subject leaving the frame defeats
    the entire feature."""
    latch = GroupLatch()
    assert latch.settle(GroupAction.WIDEN, 100.0) == GroupAction.WIDEN


def test_closing_in_has_to_be_wanted_for_a_while_first():
    """One noisy frame must not command a manoeuvre. Closing in is the risky
    direction — it is what loses a member — so it waits."""
    latch = GroupLatch()
    assert latch.settle(GroupAction.CLOSE, 100.0) == GroupAction.HOLD
    assert latch.settle(GroupAction.CLOSE, 100.0 + GROUP_DWELL_S / 2) == GroupAction.HOLD
    assert latch.settle(GroupAction.CLOSE, 100.0 + GROUP_DWELL_S + 0.01) == GroupAction.CLOSE


def test_a_single_frame_of_close_does_not_survive_a_change_of_mind():
    latch = GroupLatch()
    latch.settle(GroupAction.CLOSE, 100.0)
    latch.settle(GroupAction.HOLD, 100.1)
    # The CLOSE dwell must have been abandoned, not merely paused.
    assert latch.settle(GroupAction.CLOSE, 100.0 + GROUP_DWELL_S + 0.01) == GroupAction.HOLD


def test_leaving_a_widen_also_waits():
    """Symmetry with closing in: the aircraft should not stop backing off on
    one frame that happened to look framed."""
    latch = GroupLatch()
    latch.settle(GroupAction.WIDEN, 100.0)
    assert latch.settle(GroupAction.HOLD, 100.05) == GroupAction.WIDEN
    # The dwell runs from when HOLD was first wanted, not from the widen.
    assert latch.settle(GroupAction.HOLD, 100.05 + GROUP_DWELL_S + 0.01) == GroupAction.HOLD


# --------------------------------------------------------------------------- #
# The widen split                                                               #
# --------------------------------------------------------------------------- #

def test_widening_at_45_degrees_splits_evenly():
    fwd, down = widen_velocity(-1.0, 45.0)
    assert fwd == pytest.approx(-math.sqrt(0.5), abs=1e-6)
    assert down == pytest.approx(-math.sqrt(0.5), abs=1e-6)


def test_looking_straight_down_widens_by_climbing_only():
    """Moving horizontally under a subject directly below changes the slant
    range by almost nothing, so a retreat there is wasted motion."""
    fwd, down = widen_velocity(-2.0, 90.0)
    assert fwd == pytest.approx(0.0, abs=1e-6)
    assert down == pytest.approx(-2.0, abs=1e-6)


def test_looking_level_widens_by_retreating_only():
    fwd, down = widen_velocity(-2.0, 0.0)
    assert fwd == pytest.approx(-2.0, abs=1e-6)
    assert down == pytest.approx(0.0, abs=1e-6)


@pytest.mark.parametrize("theta", [0.0, 15.0, 30.0, 45.0, 60.0, 75.0, 90.0])
def test_the_split_preserves_the_requested_range_rate(theta):
    """The whole point is to grow the SLANT RANGE at the commanded rate. A
    split that lost magnitude would widen slower than the controller asked and
    read as an under-tuned gain."""
    fwd, down = widen_velocity(-1.5, theta)
    assert math.hypot(fwd, down) == pytest.approx(1.5, abs=1e-6)


@pytest.mark.parametrize("theta", [0.0, 30.0, 60.0, 90.0])
def test_widening_never_descends_and_never_advances(theta):
    """Both halves have exactly one legal sign. A positive `down` here would be
    a descent commanded by a framing controller, which is how the SITL aircraft
    was flown into the ground."""
    fwd, down = widen_velocity(-1.0, theta)
    assert fwd <= 0.0
    assert down <= 0.0


def test_no_depression_reading_means_no_climb():
    """Same stance decide_elevation takes: without pose there is no AGL, so
    neither altitude bound can be enforced and an autonomous climb would be
    unbounded. Retreat is the survivable half."""
    fwd, down = widen_velocity(-1.0, None)
    assert fwd == pytest.approx(-1.0)
    assert down == 0.0


def test_a_zero_widen_commands_nothing():
    assert widen_velocity(0.0, 45.0) == (0.0, 0.0)


def test_the_depression_angle_is_clamped_to_the_physical_range():
    """A bad pose can report anything. Past 90 degrees the cosine flips sign and
    the retreat becomes an ADVANCE while the group is overflowing the frame."""
    fwd, down = widen_velocity(-1.0, 140.0)
    assert fwd <= 0.0 and down <= 0.0


# --------------------------------------------------------------------------- #
# Reporting the range that would be needed                                      #
# --------------------------------------------------------------------------- #

def test_a_group_that_already_fits_needs_no_extra_range():
    f = _framing(_centred(0.50, 0.40))
    assert required_range_m(f, 30.0, 45.0) is None


def test_the_required_range_scales_with_the_overflow():
    """"Cannot frame all" and "cannot frame all, needs about 45 m" are
    different messages: only the second tells the operator whether to back off
    or drop a member."""
    f = _framing(_centred(GROUP_MAX_FILL_W * 2, 0.30))
    r_now = 30.0 / math.sin(math.radians(45.0))
    assert required_range_m(f, 30.0, 45.0) == pytest.approx(r_now * 2.0, rel=1e-3)


def test_without_a_pose_no_range_is_claimed():
    f = _framing(_centred(0.95, 0.30))
    assert required_range_m(f, None, 45.0) is None
    assert required_range_m(f, 30.0, None) is None


# --------------------------------------------------------------------------- #
# Giving up, and the clock it gives up on                                       #
# --------------------------------------------------------------------------- #

def test_the_time_bound_is_only_a_fallback_and_is_shorter_than_the_lost_ladder():
    """DELIBERATELY DECOUPLED from the reacquisition ladder's WIDEN_UNTIL_S,
    which it was briefly tied to.

    The tie was justified as stopping the flown timeout drifting from the
    displayed one, but the two never measured the same thing: the ladder counts
    time since the subject was last SEEN, and this counts time spent widening
    while every subject is in plain sight. There was nothing for them to
    disagree about, so matching them only made this one longer than it needed
    to be — and the widen is the one that is actually flying the aircraft
    somewhere while it runs."""
    from app.vision.pursuit import WIDEN_UNTIL_S
    assert GROUP_GIVE_UP_S < WIDEN_UNTIL_S


def test_the_distance_limit_is_a_radius_an_operator_can_still_see():
    """The bound exists so the aircraft does not end up somewhere nobody put
    it. A limit larger than the distance at which you can tell what the drone
    is doing is not a bound, it is a formality."""
    assert 5.0 <= GROUP_WIDEN_LIMIT_M <= 30.0


def test_a_group_that_cannot_be_framed_is_given_up_on():
    gs = GroupState()
    gs.note(GroupAction.WIDEN, 100.0)
    assert not gs.has_given_up(100.0 + GROUP_GIVE_UP_S - 0.1)
    assert gs.has_given_up(100.0 + GROUP_GIVE_UP_S + 0.1)


def test_a_widen_that_succeeds_clears_the_clock():
    """Otherwise a long flight accumulates unrelated widens into a give-up that
    fires on a group which is framed perfectly."""
    gs = GroupState()
    gs.note(GroupAction.WIDEN, 100.0)
    gs.note(GroupAction.HOLD, 105.0)
    assert gs.struggling_for(200.0) == 0.0
    assert not gs.has_given_up(200.0)


def test_the_struggle_clock_starts_once_not_on_every_frame():
    gs = GroupState()
    for t in range(100, 110):
        gs.note(GroupAction.WIDEN, float(t))
    assert gs.struggling_for(110.0) == pytest.approx(10.0)


# --------------------------------------------------------------------------- #
# The widen budget: measured metres, with time as the fallback                  #
# --------------------------------------------------------------------------- #

def _fix_tel(lat=12.99, lon=77.59, fix=3, sats=12):
    return {"gps": {"fix_type": fix, "satellites_visible": sats},
            "position": {"latitude_deg": lat, "longitude_deg": lon}}


def test_a_good_fix_is_read_from_the_raw_snapshot():
    """The position was already arriving every frame and being discarded one
    layer up: pose_from_telemetry keeps only altitude and attitude, because
    that is all the rest of the vision layer needs."""
    assert fix_from_telemetry(_fix_tel()) == (12.99, 77.59)


@pytest.mark.parametrize("tel,why", [
    (None, "no telemetry at all"),
    ({}, "empty snapshot"),
    (_fix_tel(fix=2), "2D fix — no usable horizontal accuracy"),
    (_fix_tel(sats=4), "too few satellites — the solution wanders"),
    (_fix_tel(lat=0.0, lon=0.0), "null island: a zeroed dataclass, not a reading"),
])
def test_an_unusable_fix_is_refused_rather_than_trusted(tel, why):
    """A marginal fix is WORSE than none here. Differencing two positions turns
    any wander in the solution into apparent travel, so it would spend the
    widen budget while the aircraft hovers — and the drone would give up on a
    group it was framing perfectly."""
    assert fix_from_telemetry(tel) is None, why


def test_without_a_fix_the_budget_falls_back_to_time():
    gs = GroupState()
    gs.note(GroupAction.WIDEN, 100.0, None)
    b = gs.budget(100.0 + GROUP_GIVE_UP_S + 0.1, None)
    assert b.by == "time"
    assert b.exhausted


def test_with_a_fix_the_budget_is_measured_in_metres():
    gs = GroupState()
    gs.note(GroupAction.WIDEN, 100.0, (12.99, 77.59))
    b = gs.budget(101.0, (12.99, 77.59))
    assert b.by == "distance"
    assert b.spent_m == pytest.approx(0.0, abs=0.1)
    assert not b.exhausted


def test_the_distance_bound_fires_at_the_limit():
    gs = GroupState()
    gs.note(GroupAction.WIDEN, 100.0, (12.99, 77.59))
    far = (12.99 + (GROUP_WIDEN_LIMIT_M + 1.0) / 111_320.0, 77.59)
    assert gs.budget(101.0, far).exhausted


def test_a_stationary_aircraft_never_spends_the_distance_budget():
    """THE WHOLE POINT OF MEASURING. A widen that is commanded but not achieved
    — held by the yaw gate, by wind, by a saturated controller — has cost
    nothing and must not count against a budget that exists to bound where the
    aircraft ends up. A time bound cannot tell the two apart."""
    gs = GroupState()
    gs.note(GroupAction.WIDEN, 100.0, (12.99, 77.59))
    assert not gs.budget(100.0 + GROUP_GIVE_UP_S * 10, (12.99, 77.59)).exhausted


def test_the_budget_says_which_bound_is_in_force():
    """Substituting the looser bound quietly would read as the tighter one
    being enforced. Same stance limit_climb takes when it has no AGL."""
    gs = GroupState()
    gs.note(GroupAction.WIDEN, 100.0, None)
    assert "GPS" in gs.budget(101.0, None).describe()
    gs2 = GroupState()
    gs2.note(GroupAction.WIDEN, 100.0, (12.99, 77.59))
    assert "m of the" in gs2.budget(101.0, (12.99, 77.59)).describe()


def test_the_origin_is_stamped_when_the_widen_starts_not_on_every_frame():
    """Re-stamping each frame would measure one frame of travel forever and the
    budget would never be spent."""
    gs = GroupState()
    gs.note(GroupAction.WIDEN, 100.0, (12.99, 77.59))
    moved = (12.99 + 10.0 / 111_320.0, 77.59)
    gs.note(GroupAction.WIDEN, 101.0, moved)
    assert gs.budget(101.0, moved).spent_m == pytest.approx(10.0, abs=0.5)


def test_a_fix_arriving_mid_widen_is_not_backdated():
    """Crediting the widen with metres covered while the fix was unusable would
    be inventing them — the aircraft may have been sitting still."""
    gs = GroupState()
    gs.note(GroupAction.WIDEN, 100.0, None)
    late = (12.99, 77.59)
    gs.note(GroupAction.WIDEN, 101.0, late)
    assert gs.budget(101.0, late).spent_m == pytest.approx(0.0, abs=0.1)


def test_a_successful_widen_forgets_where_it_started():
    """Otherwise the next widen is measured from a stale origin and gives up
    immediately, somewhere unrelated to where it began."""
    gs = GroupState()
    gs.note(GroupAction.WIDEN, 100.0, (12.99, 77.59))
    gs.note(GroupAction.HOLD, 101.0, (12.99, 77.59))
    assert gs.widen_origin is None
    far = (12.99 + 50.0 / 111_320.0, 77.59)
    gs.note(GroupAction.WIDEN, 102.0, far)
    assert not gs.budget(102.0, far).exhausted


# --------------------------------------------------------------------------- #
# Membership                                                                    #
# --------------------------------------------------------------------------- #

def test_membership_is_capped():
    assert clamp_members([1, 2, 3, 4, 5, 6]) == [1, 2, 3, 4][:MAX_FOLLOW_MEMBERS]


def test_membership_keeps_the_first_clicked_subject_first():
    """members[0] is the primary — it carries the plate identity and the hold
    distance — so the order is load-bearing, not cosmetic."""
    assert clamp_members([7, 3, 9])[0] == 7


def test_membership_does_not_duplicate():
    assert clamp_members([7, 7, 3, 7]) == [7, 3]


def test_the_cap_is_low_enough_that_the_analytics_survive():
    """Past a handful of subjects the range needed makes plates and faces
    unreadable, and what the operator wants is crowd management — which this
    same module already does properly."""
    assert 2 <= MAX_FOLLOW_MEMBERS <= 4


# --------------------------------------------------------------------------- #
# Through the real traffic_manager: selection                                   #
# --------------------------------------------------------------------------- #

def _make_state_for(name):
    """Other modules' _make_state signatures differ — plate and traffic take a
    session id, the rest take nothing."""
    mod = importlib.import_module(f"app.vision.modules.{name}")
    params = inspect.signature(mod._make_state).parameters
    return mod._make_state("t") if params else mod._make_state()


def _tt():
    return importlib.import_module("test_traffic_manager")


def _armed(multi=True):
    tt = _tt()
    t = tt.bare_tracker()
    t.set_multi_follow("s", multi)
    t.set_tracking("s", True)
    return t, t._client_state["s"], tt


def _step(t, tt, ids_boxes, pose=None, ctx=None):
    """One _follow frame with the given vehicles present."""
    vehicles = [tt.vehicle(tid, *box) for tid, box in ids_boxes]
    return t._follow(t._client_state["s"], vehicles, [], "s", W, H, ctx, pose)


def test_single_follow_still_replaces_rather_than_accumulating():
    """The regression that would make every existing single-target flight into
    an accidental group."""
    t, state, tt = _armed(multi=False)
    t.request_follow("s", 7)
    _step(t, tt, [(7, (100, 100, 400, 350))])
    t.request_follow("s", 8)
    _step(t, tt, [(8, (100, 100, 400, 350))])
    assert state["follow_members"] == [8]
    assert state["locked_track_id"] == 8


def test_a_tap_in_flight_when_multi_was_switched_off_does_not_leave_a_phantom_group():
    """The sequence that reaches the second of the two guards. A tap is pending
    when the operator switches multi-follow off, so by the time the module
    resolves it the request was made under one rule and lands under another.
    Appending there leaves a group the toggle says does not exist — which flies
    a containment controller with the group UI switched off."""
    t, state, tt = _armed()
    t.request_follow("s", 7)
    _step(t, tt, [(7, (100, 400, 300, 700))])
    t.request_follow("s", 8)                 # queued while multi is ON
    t.set_multi_follow("s", False)           # ...and off before it resolves
    _step(t, tt, [(7, (100, 400, 300, 700)), (8, (600, 400, 800, 700))])
    assert state["follow_members"] == [8]
    assert state["locked_track_id"] == 8


def test_a_second_tap_adds_a_member_when_multi_follow_is_on():
    t, state, tt = _armed()
    t.request_follow("s", 7)
    _step(t, tt, [(7, (100, 400, 300, 700))])
    t.request_follow("s", 8)
    _step(t, tt, [(7, (100, 400, 300, 700)), (8, (600, 400, 800, 700))])
    assert state["follow_members"] == [7, 8]


def test_adding_a_member_does_not_move_the_primary():
    """members[0] carries the plate identity and the hold distance. Handing
    those to whoever was tapped last would change the group's whole readout
    every time the operator added someone."""
    t, state, tt = _armed()
    t.request_follow("s", 7)
    _step(t, tt, [(7, (100, 400, 300, 700))])
    t.request_follow("s", 8)
    _step(t, tt, [(7, (100, 400, 300, 700)), (8, (600, 400, 800, 700))])
    assert state["locked_track_id"] == 7


def test_tapping_a_member_again_drops_them():
    """The tap has to mean both add and drop: a separate removal control is one
    the operator would be hunting for mid-flight, and dropping a member is the
    answer to a group the aircraft has just said it cannot frame."""
    t, state, tt = _armed()
    t.request_follow("s", 7)
    _step(t, tt, [(7, (100, 400, 300, 700))])
    t.request_follow("s", 8)
    _step(t, tt, [(7, (100, 400, 300, 700)), (8, (600, 400, 800, 700))])
    t.request_follow("s", 8)
    assert state["follow_members"] == [7]


def test_dropping_the_primary_promotes_the_next_member():
    t, state, tt = _armed()
    t.request_follow("s", 7)
    _step(t, tt, [(7, (100, 400, 300, 700))])
    t.request_follow("s", 8)
    _step(t, tt, [(7, (100, 400, 300, 700)), (8, (600, 400, 800, 700))])
    t.request_follow("s", 7)
    assert state["follow_members"] == [8]
    assert state["locked_track_id"] == 8


def test_tapping_the_last_member_does_not_release_the_lock():
    """Releasing is a much larger action than a tap appears to offer — it stops
    the aircraft. The X on the panel is what releases."""
    t, state, tt = _armed()
    t.request_follow("s", 7)
    _step(t, tt, [(7, (100, 400, 300, 700))])
    t.request_follow("s", 7)
    assert state["follow_members"] == [7]
    assert state["locked_track_id"] == 7


def test_the_group_refuses_to_grow_past_the_cap():
    t, state, tt = _armed()
    present = []
    for i, tid in enumerate(range(1, MAX_FOLLOW_MEMBERS + 2)):
        present.append((tid, (100 + i * 120, 400, 200 + i * 120, 700)))
        t.request_follow("s", tid)
        _step(t, tt, present)
    assert len(state["follow_members"]) == MAX_FOLLOW_MEMBERS


def test_turning_multi_follow_off_keeps_the_primary_rather_than_stopping():
    """An operator flipping the toggle off is saying "just this one", not
    "stop"."""
    t, state, tt = _armed()
    t.request_follow("s", 7)
    _step(t, tt, [(7, (100, 400, 300, 700))])
    t.request_follow("s", 8)
    _step(t, tt, [(7, (100, 400, 300, 700)), (8, (600, 400, 800, 700))])
    t.set_multi_follow("s", False)
    assert state["follow_members"] == [7]
    assert state["locked_track_id"] == 7
    assert state["tracking"] is True


def test_releasing_clears_the_whole_group():
    t, state, tt = _armed()
    t.request_follow("s", 7)
    _step(t, tt, [(7, (100, 400, 300, 700))])
    t.request_follow("s", 8)
    _step(t, tt, [(7, (100, 400, 300, 700)), (8, (600, 400, 800, 700))])
    t.request_follow("s", None)
    assert state["follow_members"] == []
    assert state["locked_track_id"] is None
    assert state["tracking"] is False


# --------------------------------------------------------------------------- #
# Through the real traffic_manager: flight                                      #
# --------------------------------------------------------------------------- #
#
# These run on a FAKE CLOCK. The dwell latch and the give-up window are both in
# seconds, and a test that fires ten frames inside one microsecond exercises
# neither — it would pass against a build with no latch at all.


class _Clock:
    """Stands in for the `time` module inside traffic_manager. Anything it does
    not define falls through to the real one, so only monotonic is faked."""

    def __init__(self, t0: float = 1000.0):
        self.t = t0

    def monotonic(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds

    def __getattr__(self, name):
        import time as _real
        return getattr(_real, name)


@pytest.fixture
def clock(monkeypatch):
    from app.vision.modules import traffic_manager as tm
    c = _Clock()
    monkeypatch.setattr(tm, "time", c)
    return c


class _Pose:
    agl_m = 30.0

    def depression_deg(self, cam, x, y):
        return 45.0


def _tel(lat=12.9900, lon=77.5900, fix=3, sats=12):
    """A telemetry snapshot in the shape pose/fix readers expect."""
    return {
        "gps": {"fix_type": fix, "satellites_visible": sats},
        "position": {"latitude_deg": lat, "longitude_deg": lon,
                     "relative_altitude_m": 30.0},
        "attitude": {"roll_deg": 0.0, "pitch_deg": 0.0, "yaw_deg": 0.0},
    }


class _Ctx:
    """No usable fix — the widen falls back to the time bound."""
    width, height = W, H
    telemetry = None


class _FixedCtx:
    """A good fix that never moves: the aircraft is being commanded to widen
    and going nowhere, so the DISTANCE budget never gets spent."""
    width, height = W, H
    telemetry = _tel()


class _DriftCtx:
    """A good fix that walks north, one metre per frame read."""
    width, height = W, H

    def __init__(self, step_m=1.0):
        self._n = 0
        self._step = step_m

    @property
    def telemetry(self):
        # ~1.11e5 m per degree of latitude.
        self._n += 1
        return _tel(lat=12.9900 + (self._n * self._step) / 111_320.0)


def _settle(t, tt, ids_boxes, clock, seconds=2.0, step=0.1, pose=None, ctx=None):
    """Fly the same scene for a while, so the dwell latch has a chance to adopt
    what the assessment is asking for."""
    cmd = None
    for _ in range(max(1, int(seconds / step))):
        clock.advance(step)
        cmd = _step(t, tt, ids_boxes, pose=pose, ctx=ctx)
    return cmd


def _two_up(t, tt, boxes, clock, pose=None, ctx=None, seconds=2.0):
    """Lock two subjects, then fly the scene until the controller has settled."""
    ids = [(7, boxes[0]), (8, boxes[1])]
    t.request_follow("s", 7)
    _step(t, tt, [ids[0]], pose=pose, ctx=ctx)
    t.request_follow("s", 8)
    return _settle(t, tt, ids, clock, seconds=seconds, pose=pose, ctx=ctx)


def test_a_single_subject_reports_no_group_framing(clock):
    """The framing readout appearing IS the evidence that group control has the
    aircraft. It must not appear when it does not."""
    t, state, tt = _armed(multi=False)
    t.request_follow("s", 7)
    _step(t, tt, [(7, (100, 400, 300, 700))])
    assert state["group_framing"] is None


def test_a_group_reports_what_it_is_filling(clock):
    t, state, tt = _armed()
    _two_up(t, tt, [(200, 300, 500, 800), (1300, 300, 1600, 800)], clock)
    g = state["group_framing"]
    assert g is not None
    assert g["members_total"] == 2 and g["members_visible"] == 2
    assert g["fill_w_pct"] > 0 and g["fill_h_pct"] > 0


def test_a_group_that_overflows_the_frame_backs_off(clock):
    """THE FEATURE. Two subjects spread across nearly the whole frame: the only
    correct command is away from them."""
    t, state, tt = _armed()
    cmd = _two_up(t, tt, [(20, 60, 400, 1000), (1500, 60, 1900, 1000)], clock)
    assert state["group_framing"]["action"] == "widen"
    assert cmd["forward_m_s"] < 0


def test_a_group_bunched_in_the_middle_closes_in(clock):
    t, state, tt = _armed()
    cmd = _two_up(t, tt, [(880, 480, 940, 560), (980, 480, 1040, 560)], clock)
    assert state["group_framing"]["action"] == "close"
    assert cmd["forward_m_s"] > 0


def test_closing_in_waits_out_the_dwell_before_it_starts(clock):
    """A bunched group on ONE frame is noise. Without the latch the aircraft
    lunges at whatever the last detection happened to look like."""
    t, state, tt = _armed()
    # Settle inside the band first, so what is being measured is the reaction
    # to the group bunching up rather than the transition into group mode.
    framed = [(7, (500, 250, 800, 850)), (8, (1100, 250, 1400, 850))]
    _two_up(t, tt, [framed[0][1], framed[1][1]], clock)
    assert state["group_framing"]["action"] == "hold"

    bunched = [(7, (880, 480, 940, 560)), (8, (980, 480, 1040, 560))]
    for _ in range(3):
        clock.advance(0.03)
        cmd = _step(t, tt, bunched)
    assert state["group_framing"]["action"] == "hold", "lunged on one noisy frame"
    assert cmd["forward_m_s"] == pytest.approx(0.0, abs=0.01)


def test_the_group_box_centre_is_what_yaw_steers_on(clock):
    """Neither subject is centred, and that is correct. The yaw command has to
    come from the box that contains both."""
    t, state, tt = _armed()
    cmd = _two_up(t, tt, [(1300, 400, 1450, 700), (1600, 400, 1750, 700)], clock)
    assert cmd["yaw_deg_s"] > 0, "group sits right of centre — yaw right"


def test_a_missing_member_never_produces_an_advance(clock):
    """THE TRAP. Losing a member SHRINKS the group box, which reads as "too
    small, close in" — so the naive signal says advance at exactly the moment
    advancing makes that member's loss permanent. And the smoother carries the
    previous frames' momentum, so zeroing the controller is not enough."""
    t, state, tt = _armed()
    _two_up(t, tt, [(880, 480, 940, 560), (980, 480, 1040, 560)], clock)
    assert state["group_framing"]["action"] == "close"    # was advancing
    for _ in range(6):
        clock.advance(0.1)
        cmd = _step(t, tt, [(7, (880, 480, 940, 560))])
        assert cmd["forward_m_s"] <= 0.0, "advanced with a member out of frame"
    assert state["group_framing"]["members_visible"] == 1


def test_a_missing_member_still_lets_the_aircraft_back_off(clock):
    """The retreat is the half that helps find them again, so the clamp must be
    one-sided rather than a freeze."""
    t, state, tt = _armed()
    _two_up(t, tt, [(20, 60, 400, 1000), (1500, 60, 1900, 1000)], clock)
    cmd = _settle(t, tt, [(7, (20, 60, 900, 1000))], clock, seconds=1.0)
    assert cmd["forward_m_s"] < 0


def test_the_primary_going_missing_does_not_abandon_the_group(clock):
    """Single-subject follow treats the primary's absence as a total loss,
    correctly. A group that is mostly still visible is not lost."""
    t, state, tt = _armed()
    _two_up(t, tt, [(200, 300, 500, 800), (1300, 300, 1600, 800)], clock)
    clock.advance(0.1)
    cmd = _step(t, tt, [(8, (1300, 300, 1600, 800))])
    assert state["group_framing"] is not None
    assert state["group_framing"]["members_visible"] == 1
    assert cmd is not None


def test_everyone_missing_still_keeps_the_setpoint_stream_alive(clock):
    """Returning None gaps Offboard and PX4 flies on at the last velocity —
    the defect a77c90f fixed, which a new code path could reintroduce."""
    t, state, tt = _armed()
    _two_up(t, tt, [(200, 300, 500, 800), (1300, 300, 1600, 800)], clock)
    clock.advance(0.1)
    cmd = _step(t, tt, [])
    assert cmd is not None and cmd["type"] == "velocity"


def test_an_unframeable_group_stops_translating_but_keeps_looking(clock):
    """Two subjects walking apart need range that grows without bound. Flying
    backwards forever is just leaving the area; yaw keeps them centred so the
    operator can see what to drop."""
    t, state, tt = _armed()
    ids = [(7, (20, 60, 400, 1000)), (8, (1500, 60, 1900, 1000))]
    _two_up(t, tt, [ids[0][1], ids[1][1]], clock)
    assert state["group_framing"]["action"] == "widen"

    cmd = _settle(t, tt, ids, clock, seconds=GROUP_GIVE_UP_S + 3.0)
    assert state["group_framing"]["action"] == "unframeable"
    assert cmd["forward_m_s"] == pytest.approx(0.0, abs=0.01)
    assert "cannot frame" in state["group_framing"]["reason"]


def test_a_widen_that_goes_nowhere_is_not_given_up_on(clock):
    """THE REASON THE BOUND IS METRES. The aircraft is commanded to widen and
    is not moving — a good fix, unchanged. Under the old time bound this gave
    up after 15 s of having cost nothing; now it keeps trying, because nothing
    the bound exists to prevent has happened."""
    t, state, tt = _armed()
    ids = [(7, (20, 60, 400, 1000)), (8, (1500, 60, 1900, 1000))]
    _two_up(t, tt, [ids[0][1], ids[1][1]], clock, pose=_Pose(), ctx=_FixedCtx())
    _settle(t, tt, ids, clock, seconds=GROUP_GIVE_UP_S * 3,
            pose=_Pose(), ctx=_FixedCtx())
    g = state["group_framing"]
    assert g["widen_budget"]["by"] == "distance"
    assert g["action"] == "widen", "gave up on a widen that cost no ground"


def test_a_widen_that_actually_travels_is_given_up_on_by_distance(clock):
    """The same scene with the aircraft genuinely moving. The budget is spent
    in metres flown, and it fires well before the time fallback would."""
    t, state, tt = _armed()
    ids = [(7, (20, 60, 400, 1000)), (8, (1500, 60, 1900, 1000))]
    ctx = _DriftCtx(step_m=1.0)
    _two_up(t, tt, [ids[0][1], ids[1][1]], clock, pose=_Pose(), ctx=ctx)
    cmd = _settle(t, tt, ids, clock, seconds=4.0, step=0.1,
                  pose=_Pose(), ctx=ctx)
    g = state["group_framing"]
    assert g["widen_budget"]["by"] == "distance"
    assert g["widen_budget"]["spent_m"] >= GROUP_WIDEN_LIMIT_M
    assert g["action"] == "unframeable"
    assert cmd["forward_m_s"] == pytest.approx(0.0, abs=0.01)
    # The point of the change: it stopped on metres, not on the clock.
    assert g["widening_for_s"] < GROUP_GIVE_UP_S


def test_the_reason_names_the_bound_that_actually_stopped_it(clock):
    """"Cannot frame all" is the same sentence whether 15 m of ground or 8
    seconds of clock ended it, and the two mean different things about how far
    the aircraft has gone."""
    t, state, tt = _armed()
    ids = [(7, (20, 60, 400, 1000)), (8, (1500, 60, 1900, 1000))]
    _two_up(t, tt, [ids[0][1], ids[1][1]], clock)
    _settle(t, tt, ids, clock, seconds=GROUP_GIVE_UP_S + 3.0)
    assert state["group_framing"]["widen_budget"]["by"] == "time"
    assert "no usable GPS" in state["group_framing"]["reason"]


def test_it_keeps_widening_right_up_to_the_give_up_point(clock):
    """Giving up early would abandon groups that were about to fit."""
    t, state, tt = _armed()
    ids = [(7, (20, 60, 400, 1000)), (8, (1500, 60, 1900, 1000))]
    _two_up(t, tt, [ids[0][1], ids[1][1]], clock)
    cmd = _settle(t, tt, ids, clock, seconds=GROUP_GIVE_UP_S - 3.0)
    assert state["group_framing"]["action"] == "widen"
    assert cmd["forward_m_s"] < 0


def test_an_unframeable_group_says_what_range_it_would_have_needed(clock):
    """"Cannot do it" and "cannot do it, needs about 45 m" are different
    messages, and only one of them is actionable."""
    t, state, tt = _armed()
    ids = [(7, (20, 60, 400, 1000)), (8, (1500, 60, 1900, 1000))]
    _two_up(t, tt, [ids[0][1], ids[1][1]], clock, pose=_Pose(), ctx=_Ctx())
    _settle(t, tt, ids, clock, seconds=GROUP_GIVE_UP_S + 3.0,
            pose=_Pose(), ctx=_Ctx())
    assert state["group_framing"]["action"] == "unframeable"
    assert state["group_framing"]["required_range_m"] > 30.0


def test_widening_with_a_known_look_angle_climbs_as_well_as_backs_off(clock):
    """The split is the answer chosen over pure retreat and pure climb: it
    grows the range while leaving the depression — and so this module's own
    analytics — where they were."""
    t, state, tt = _armed()
    cmd = _two_up(t, tt, [(20, 60, 400, 1000), (1500, 60, 1900, 1000)], clock,
                  pose=_Pose(), ctx=_Ctx())
    assert cmd["forward_m_s"] < 0, "should be backing off"
    assert cmd["down_m_s"] < 0, "should also be climbing"


def test_widening_without_a_pose_does_not_climb_blind(clock):
    t, state, tt = _armed()
    cmd = _two_up(t, tt, [(20, 60, 400, 1000), (1500, 60, 1900, 1000)], clock)
    assert cmd["forward_m_s"] < 0
    assert cmd["down_m_s"] >= 0.0, "climbed with no altitude reading"


def test_the_widen_climb_still_passes_the_altitude_ceiling(clock):
    """A framing controller is just another source of climb, and the ceiling
    belongs at the one convergence point rather than inside each source."""
    class _AtCeiling(_Pose):
        agl_m = 500.0

    t, state, tt = _armed()
    cmd = _two_up(t, tt, [(20, 60, 400, 1000), (1500, 60, 1900, 1000)], clock,
                  pose=_AtCeiling(), ctx=_Ctx())
    assert cmd["down_m_s"] >= 0.0, "climbed through the ceiling to frame a group"
    assert state["altitude_floor_reason"]


# --------------------------------------------------------------------------- #
# MEMBERSHIP OUTLIVES A TRACK ID                                                #
# --------------------------------------------------------------------------- #
#
# A ByteTrack id is not a person. Walk behind a pole and come back and you are
# a new id — so a member bound to the old one is gone for the session, while
# standing in plain sight with their name drawn over them by the face
# recogniser. The group says "1 of 2" and the overlay says "Japesh", about the
# same human, at the same time.
#
# It is worse than the single-subject version of the same fragility, which
# degrades boundedly: blind ladder, hover, operator taps again. Here closing in
# is blocked while ANY member is missing, so the aircraft can never approach
# again for the rest of the flight and no control undoes it short of releasing
# the whole lock.

def _enrol(state, tid, person_id="p-japesh", name="Japesh", confirmed=True):
    state["face_identities"][tid] = {
        "person_id": person_id, "name": name, "votes": 3,
        "best_sim": 0.82, "last_sim": 0.82, "margin": 0.2,
        "last_seen": 0.0, "confirmed": confirmed,
    }


def _group_of_two(t, tt, a, b, people=True):
    """Lock two subjects and run a frame with both up."""
    mk = tt.person if people else tt.vehicle
    t.request_follow("s", a[0])
    t._follow(t._client_state["s"], [] if people else [mk(*a)],
              [mk(*a)] if people else [], "s", W, H, None, None)
    t.request_follow("s", b[0])
    subs = [mk(*a), mk(*b)]
    t._follow(t._client_state["s"], [] if people else subs,
              subs if people else [], "s", W, H, None, None)


def test_a_recognised_person_returning_as_a_new_track_is_rebound(clock):
    """THE REPORTED CASE. Japesh is in the gallery, joins the group as #12,
    steps behind a pole, and comes back as #47 — still recognised."""
    t, state, tt = _armed()
    _enrol(state, 12)
    _group_of_two(t, tt, (12, 800, 300, 900, 700), (20, 1000, 300, 1100, 700))
    assert state["follow_members"] == [12, 20]

    _enrol(state, 47)                      # recognised again under a new id
    clock.advance(0.1)
    t._follow(state, [], [tt.person(47, 810, 300, 910, 700),
                          tt.person(20, 1000, 300, 1100, 700)],
              "s", W, H, None, None)

    assert state["follow_members"] == [47, 20], "lost a member to a new id"
    assert state["group_framing"]["members_visible"] == 2
    assert state["group_framing"]["missing"] == []


def test_an_unconfirmed_face_does_not_rebind_the_group(clock):
    """A single-vote guess re-binding the group would put the aircraft on the
    WRONG subject, which is worse than losing the right one."""
    t, state, tt = _armed()
    _enrol(state, 12)
    _group_of_two(t, tt, (12, 800, 300, 900, 700), (20, 1000, 300, 1100, 700))

    _enrol(state, 47, confirmed=False)
    clock.advance(0.1)
    t._follow(state, [], [tt.person(47, 810, 300, 910, 700),
                          tt.person(20, 1000, 300, 1100, 700)],
              "s", W, H, None, None)
    assert 47 not in state["follow_members"]


def test_a_person_with_no_gallery_entry_cannot_be_rebound(clock):
    """Honest limit, pinned so nobody assumes more than is there: without an
    enrolled face there is no identity to re-bind through, and the member is
    retired rather than silently swapped for whoever is nearest."""
    t, state, tt = _armed()
    _group_of_two(t, tt, (12, 800, 300, 900, 700), (20, 1000, 300, 1100, 700))
    clock.advance(0.1)
    t._follow(state, [], [tt.person(47, 810, 300, 910, 700),
                          tt.person(20, 1000, 300, 1100, 700)],
              "s", W, H, None, None)
    assert state["follow_members"] == [12, 20]


def test_a_vehicle_rebinds_through_its_persistent_id(clock):
    """The plate registry already restores vehicle_id when a returning
    vehicle's plate matches. Follow simply was not reading it — the module's
    own comment claimed the plate 'survives a track id change' while nothing
    used it to re-acquire anything."""
    t, state, tt = _armed()
    v1, v2 = tt.vehicle(1, 100, 400, 400, 700), tt.vehicle(2, 900, 400, 1200, 700)
    v1.vehicle_id, v2.vehicle_id = "VH-000001", "VH-000002"
    t.request_follow("s", 1)
    t._follow(state, [v1], [], "s", W, H, None, None)
    t.request_follow("s", 2)
    t._follow(state, [v1, v2], [], "s", W, H, None, None)
    assert state["follow_members"] == [1, 2]

    back = tt.vehicle(9, 110, 400, 410, 700)
    back.vehicle_id = "VH-000001"          # same car, new track
    clock.advance(0.1)
    t._follow(state, [back, v2], [], "s", W, H, None, None)
    assert state["follow_members"] == [9, 2]


def test_a_vehicle_rebinds_through_its_plate_before_it_has_an_id(clock):
    t, state, tt = _armed()
    v1, v2 = tt.vehicle(1, 100, 400, 400, 700), tt.vehicle(2, 900, 400, 1200, 700)
    v1.plate, v2.plate = "719257C", "KA01AB1234"
    t.request_follow("s", 1)
    t._follow(state, [v1], [], "s", W, H, None, None)
    t.request_follow("s", 2)
    t._follow(state, [v1, v2], [], "s", W, H, None, None)

    back = tt.vehicle(9, 110, 400, 410, 700)
    back.plate = "719257C"
    clock.advance(0.1)
    t._follow(state, [back, v2], [], "s", W, H, None, None)
    assert state["follow_members"] == [9, 2]


def test_rebinding_never_steals_a_track_that_is_already_a_member(clock):
    """Two members collapsing onto one subject would report a full group while
    following half of it."""
    t, state, tt = _armed()
    _enrol(state, 12, person_id="p-a")
    _enrol(state, 20, person_id="p-a")      # same identity, pathological
    _group_of_two(t, tt, (12, 800, 300, 900, 700), (20, 1000, 300, 1100, 700))
    clock.advance(0.1)
    t._follow(state, [], [tt.person(20, 1000, 300, 1100, 700)],
              "s", W, H, None, None)
    assert len(set(state["follow_members"])) == len(state["follow_members"])


def test_the_primary_rebinding_carries_the_lock_with_it(clock):
    """members[0] carries the labelling and the hold distance. Left pointing at
    a dead id, the readout stays blank while the subject is on screen."""
    t, state, tt = _armed()
    _enrol(state, 12)
    _group_of_two(t, tt, (12, 800, 300, 900, 700), (20, 1000, 300, 1100, 700))
    assert state["locked_track_id"] == 12
    _enrol(state, 47)
    clock.advance(0.1)
    t._follow(state, [], [tt.person(47, 810, 300, 910, 700),
                          tt.person(20, 1000, 300, 1100, 700)],
              "s", W, H, None, None)
    assert state["locked_track_id"] == 47


# ── Retirement ─────────────────────────────────────────────────────────────

def test_a_member_who_is_genuinely_gone_is_retired(clock):
    """Not tidiness. Closing in is blocked while any member is missing, so one
    person walking away pins the aircraft at its current distance for the rest
    of the flight, with no control that undoes it short of releasing."""
    t, state, tt = _armed()
    _group_of_two(t, tt, (12, 800, 300, 900, 700), (20, 1000, 300, 1100, 700))
    for _ in range(int((MEMBER_RETIRE_S + 2) / 0.5)):
        clock.advance(0.5)
        t._follow(state, [], [tt.person(20, 1000, 300, 1100, 700)],
                  "s", W, H, None, None)
    assert state["follow_members"] == [20]
    assert 12 in state["retired_members"]


def test_the_group_can_close_in_again_once_a_lost_member_is_retired(clock):
    """The whole point: the aircraft recovers instead of staying crippled."""
    t, state, tt = _armed()
    _group_of_two(t, tt, (12, 880, 480, 940, 560), (20, 980, 480, 1040, 560))
    for _ in range(int((MEMBER_RETIRE_S + 3) / 0.5)):
        clock.advance(0.5)
        t._follow(state, [], [tt.person(20, 980, 480, 1040, 560)],
                  "s", W, H, None, None)
    assert state["follow_members"] == [20]
    assert state["group_no_advance"] is False


def test_a_member_is_not_retired_early(clock):
    t, state, tt = _armed()
    _group_of_two(t, tt, (12, 800, 300, 900, 700), (20, 1000, 300, 1100, 700))
    for _ in range(int((MEMBER_RETIRE_S - 3) / 0.5)):
        clock.advance(0.5)
        t._follow(state, [], [tt.person(20, 1000, 300, 1100, 700)],
                  "s", W, H, None, None)
    assert state["follow_members"] == [12, 20]


def test_the_last_member_is_never_retired(clock):
    """Retiring everyone would release the lock on a timer — a much larger
    action than the operator asked for, and it stops the aircraft."""
    t, state, tt = _armed()
    t.request_follow("s", 12)
    t._follow(state, [], [tt.person(12, 800, 300, 900, 700)], "s", W, H, None, None)
    for _ in range(int((MEMBER_RETIRE_S + 5) / 0.5)):
        clock.advance(0.5)
        t._follow(state, [], [], "s", W, H, None, None)
    assert state["follow_members"] == [12]
    assert state["locked_track_id"] == 12


def test_retiring_the_primary_promotes_rather_than_releases(clock):
    t, state, tt = _armed()
    _group_of_two(t, tt, (12, 800, 300, 900, 700), (20, 1000, 300, 1100, 700))
    for _ in range(int((MEMBER_RETIRE_S + 2) / 0.5)):
        clock.advance(0.5)
        t._follow(state, [], [tt.person(20, 1000, 300, 1100, 700)],
                  "s", W, H, None, None)
    assert state["locked_track_id"] == 20
    assert state["tracking"] is True


# ── The deliberate scope limit ──────────────────────────────────────────────

def test_single_subject_follow_is_deliberately_left_alone(clock):
    """SCOPED ON PURPOSE, and pinned so it does not drift in by accident.

    Single follow has the same track-id fragility but degrades boundedly — the
    blind ladder, a hover, and the operator taps again. Group loss is permanent
    and silent. Changing what single follow does is a change to behaviour being
    flown today and was not asked for."""
    t, state, tt = _armed(multi=False)
    v = tt.vehicle(1, 100, 400, 400, 700)
    v.vehicle_id = "VH-000001"
    t.request_follow("s", 1)
    t._follow(state, [v], [], "s", W, H, None, None)

    back = tt.vehicle(9, 110, 400, 410, 700)
    back.vehicle_id = "VH-000001"
    clock.advance(0.1)
    t._follow(state, [back], [], "s", W, H, None, None)
    assert state["follow_members"] == [1], "single follow silently gained re-binding"


# ── The readout must not contradict itself ─────────────────────────────────

def test_the_reason_never_describes_an_action_that_is_not_being_taken(clock):
    """assess_framing writes its reason before the dwell latch has had a say,
    so the payload read "closing in" while the action was "hold"."""
    t, state, tt = _armed()
    framed = [(7, (500, 250, 800, 850)), (8, (1100, 250, 1400, 850))]
    _two_up(t, tt, [framed[0][1], framed[1][1]], clock)

    bunched = [(7, (880, 480, 940, 560)), (8, (980, 480, 1040, 560))]
    for _ in range(3):
        clock.advance(0.03)
        _step(t, tt, bunched)
    g = state["group_framing"]
    assert g["action"] == "hold"
    assert "steady for now" in g["reason"]
    assert not g["reason"].rstrip().endswith("closing in")


# --------------------------------------------------------------------------- #
# OTHER MODES ARE UNTOUCHED                                                     #
# --------------------------------------------------------------------------- #
#
# Group follow lives in traffic-management alone, because that is the only
# module that finds people and vehicles in ONE detection pass — so a track id
# identifies exactly one subject across both lists and a mixed group is even
# expressible. Everywhere else the same feature would need a second id space to
# disambiguate and would mean something different in each.
#
# These are structural rather than behavioural on purpose: the risk is not that
# another module computes a group wrongly, it is that it acquires the machinery
# at all and starts carrying state nobody reads.

_OTHER_MODULES = ["human_tracker", "person_tracker", "crowd_manager",
                  "plate_tracker"]


@pytest.mark.parametrize("name", _OTHER_MODULES)
def test_no_other_module_imports_group_follow(name):
    src = inspect.getsource(importlib.import_module(f"app.vision.modules.{name}"))
    assert "group_follow" not in src
    assert "multi_follow" not in src


@pytest.mark.parametrize("name", _OTHER_MODULES)
def test_no_other_module_carries_group_state(name):
    """A key that exists but is never read is how a feature leaks sideways: the
    next person to touch the module sees it and wires something to it."""
    state = _make_state_for(name)
    for key in ("follow_members", "multi_follow", "group", "group_framing",
                "member_identity", "retired_members"):
        assert key not in state, f"{name} picked up {key}"


def test_the_socket_handler_refuses_every_analyzer_but_traffic():
    """Ungated, `set_multi_follow` would raise AttributeError on four of the
    five follow modules — which surfaces to the operator as a dead control on a
    mode that never offered the feature."""
    src = inspect.getsource(
        importlib.import_module("app.events.telemetry_events"))
    handler = src[src.index('@sio.on("set_multi_follow")'):]
    handler = handler[:handler.index("@sio.on", 10)]
    assert "isinstance(analyzer, TrafficManager)" in handler


def test_the_shared_follow_panel_still_shows_distance_without_a_group():
    """FollowControls is shared by crowd, traffic and vehicle-plate. The
    Distance control is hidden in GROUP mode because containment drives the
    forward axis there and the slider would do nothing — but the guard must be
    optional-safe, or hiding it in one mode hides it in all three."""
    import pathlib
    root = pathlib.Path(__file__).resolve().parents[2] / "frontend/src/components/vision"
    panel = (root / "FollowControls.tsx").read_text()
    # Optional chaining on a prop the other panels never pass.
    assert "!(multi?.enabled && multi.members.length > 1)" in panel
    for other in ("CrowdManagementPanel.tsx", "VehiclePlateTrackingPanel.tsx"):
        assert "multi={" not in (root / other).read_text(), \
            f"{other} started passing a group to the shared control"
