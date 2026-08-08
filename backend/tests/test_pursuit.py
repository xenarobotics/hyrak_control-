"""
Pursuit policy.

Mostly tests that the drone REFUSES to do things: climb without knowing its
altitude, climb past a ceiling, climb because a target is briefly behind a
tree, or keep hunting forever. An autonomous climb with no upper bound is the
one outcome that must be impossible, so it gets its own test.
"""
import pytest

from app.vision.pursuit import (
    COAST_UNTIL_S, REID_UNTIL_S, WIDEN_UNTIL_S,
    ElevateDecision, LockState, PursuitLimits,
    decide_elevation, has_given_up, is_outpaced, lock_state_for,
    should_widen_search,
)

LIM = PursuitLimits(max_altitude_agl_m=120.0, max_depression_deg=70.0)


def elevate(**kw) -> ElevateDecision:
    args = dict(target_outpacing=True, agl_m=50.0, depression_deg=45.0, limits=LIM)
    args.update(kw)
    return decide_elevation(**args)


# --------------------------------------------------------------------------- #
# Auto-elevate: when it fires                                                   #
# --------------------------------------------------------------------------- #

def test_does_not_climb_when_the_target_is_within_reach():
    """It is an exception path, not a mode."""
    d = elevate(target_outpacing=False)
    assert d.elevating is False
    assert d.climb_m_s == 0.0


def test_climbs_upward_when_outpaced():
    d = elevate(agl_m=50.0)
    assert d.elevating is True
    # NED: negative is up. A sign error here flies the drone into the ground.
    assert d.climb_m_s < 0
    assert d.climb_m_s == pytest.approx(-LIM.climb_rate_m_s)


# --------------------------------------------------------------------------- #
# Auto-elevate: the refusals                                                    #
# --------------------------------------------------------------------------- #

def test_refuses_to_climb_without_knowing_altitude():
    """Neither ceiling can be enforced without AGL, and an unbounded
    autonomous climb must be impossible."""
    d = elevate(agl_m=None)
    assert d.elevating is False
    assert d.blocked_by == "no_altitude"
    assert "refusing" in d.reason


def test_stops_at_the_regulatory_ceiling():
    d = elevate(agl_m=120.0)
    assert d.elevating is False
    assert d.blocked_by == "altitude_cap"
    d_above = elevate(agl_m=135.0)
    assert d_above.elevating is False
    assert d_above.climb_m_s == 0.0


def test_stops_at_the_recognition_ceiling_with_a_different_reason():
    """A separate failure from the legal cap: still flying, but the analytics
    have gone worthless. The operator must be able to tell which happened."""
    d = elevate(agl_m=50.0, depression_deg=75.0)
    assert d.elevating is False
    assert d.blocked_by == "depression_cap"
    assert "unreadable" in d.reason
    # ...and it is genuinely distinct from the altitude stop.
    assert elevate(agl_m=120.0).blocked_by == "altitude_cap"


def test_unknown_depression_does_not_block_a_legal_climb():
    """Missing recognition data is not a safety problem; missing altitude is."""
    d = elevate(agl_m=50.0, depression_deg=None)
    assert d.elevating is True


def test_climb_rate_eases_off_near_the_ceiling():
    """Otherwise the drone slams into the cap and bounces."""
    fast = elevate(agl_m=50.0).climb_m_s
    slow = elevate(agl_m=117.0).climb_m_s
    assert abs(slow) < abs(fast)
    assert abs(slow) > 0.0


def test_every_decision_explains_itself():
    """A climb the pilot cannot explain is a climb they will fight."""
    for d in (elevate(target_outpacing=False), elevate(agl_m=None),
              elevate(agl_m=120.0), elevate(agl_m=50.0)):
        assert d.reason, "decision carried no reason"
        assert d.to_dict()["reason"]


# --------------------------------------------------------------------------- #
# Outpaced detection                                                           #
# --------------------------------------------------------------------------- #

def test_saturated_command_alone_is_not_outpaced():
    """A drone accelerating from a standstill is briefly at full command while
    CLOSING. Climbing then would be exactly wrong."""
    assert is_outpaced(10.0, 10.0, LIM, target_growing_distance=False) is False
    assert is_outpaced(10.0, 10.0, LIM, target_growing_distance=True) is True


def test_outpaced_triggers_below_full_saturation():
    """By the time forward speed is fully saturated the gap is already opening,
    so the threshold sits under 1.0."""
    assert LIM.outpaced_fraction < 1.0
    assert is_outpaced(8.6, 10.0, LIM) is True     # 86% of top speed
    assert is_outpaced(5.0, 10.0, LIM) is False


def test_unknown_top_speed_never_reports_outpaced():
    assert is_outpaced(10.0, 0.0, LIM) is False
    assert is_outpaced(10.0, -1.0, LIM) is False


# --------------------------------------------------------------------------- #
# Reacquisition ladder                                                          #
# --------------------------------------------------------------------------- #

def test_ladder_is_ordered():
    assert COAST_UNTIL_S < REID_UNTIL_S < WIDEN_UNTIL_S


def test_visible_target_is_locked():
    state, msg = lock_state_for(visible=True, seconds_lost=0.0, tracking=True)
    assert state is LockState.LOCKED
    assert msg == ""


def test_not_tracking_is_idle():
    state, _ = lock_state_for(visible=False, seconds_lost=99.0, tracking=False)
    assert state is LockState.IDLE


@pytest.mark.parametrize("lost,expected", [
    (0.5, LockState.COASTING),
    (1.4, LockState.COASTING),
    (2.0, LockState.SEARCHING),
    (4.9, LockState.SEARCHING),
    (8.0, LockState.SEARCHING),
    (16.0, LockState.LOST),
    (60.0, LockState.LOST),
])
def test_ladder_progresses_with_elapsed_time(lost, expected):
    state, msg = lock_state_for(visible=False, seconds_lost=lost, tracking=True)
    assert state is expected
    assert msg, "every non-locked state needs operator-facing text"


def test_coasting_is_distinct_from_searching():
    """The important distinction: coasting means the drone still believes it
    knows where the target is, searching means it is guessing. One 'tracking'
    flag hides that."""
    coast, _ = lock_state_for(visible=False, seconds_lost=1.0, tracking=True)
    search, _ = lock_state_for(visible=False, seconds_lost=3.0, tracking=True)
    assert coast is not search


def test_search_widens_only_in_the_third_rung():
    """Climbing to search during a two-frame occlusion loses more locks than
    it saves."""
    assert should_widen_search(1.0) is False    # coasting
    assert should_widen_search(3.0) is False    # re-identifying
    assert should_widen_search(8.0) is True     # widening
    assert should_widen_search(20.0) is False   # given up


def test_giving_up_is_bounded():
    """A drone quietly drifting off after a target it no longer has is worse
    than one that admits it lost them."""
    assert has_given_up(10.0) is False
    assert has_given_up(WIDEN_UNTIL_S + 0.1) is True
    state, msg = lock_state_for(visible=False, seconds_lost=30.0, tracking=True)
    assert state is LockState.LOST
    assert "holding position" in msg


def test_limits_come_from_settings():
    """Operational caps live in settings, separate from the camera calibration
    which is a fixed property of the rig."""
    lim = PursuitLimits.from_settings()
    assert lim.max_altitude_agl_m == 120.0     # DGCA
    assert lim.max_depression_deg == 70.0


# --------------------------------------------------------------------------- #
# The altitude floor — the crash this codebase actually had                     #
# --------------------------------------------------------------------------- #
#
# A SITL vehicle-follow flew itself into the ground. The ulog shows a sustained
# +0.5 m/s commanded descent for ~12s taking the aircraft 6.6m -> 2.5m -> 0m,
# ending in "[mc_pos_control] invalid setpoints / Failsafe: blind land".
#
# Nothing in the loop objected, because there WAS no floor: decide_elevation
# enforced a ceiling and no counterpart existed anywhere in the codebase. From
# the altitude controller's point of view, descending was simply how you get
# the subject where you want it in frame.

from app.vision.pursuit import _DESCENT_TAPER_M, limit_descent


def _limits(floor=5.0):
    return PursuitLimits(min_altitude_agl_m=floor)


def test_descent_is_blocked_at_the_floor():
    allowed, why = limit_descent(0.5, agl_m=5.0, limits=_limits())
    assert allowed == 0.0
    assert "floor" in why


def test_descent_is_blocked_below_the_floor():
    """Already too low — the command must not deepen the problem."""
    allowed, _ = limit_descent(0.9, agl_m=2.0, limits=_limits())
    assert allowed == 0.0


def test_descent_without_an_altitude_reading_is_refused():
    """Same stance decide_elevation takes on climbing blind: neither bound can
    be enforced without a height, and refusing to descend is the recoverable
    mistake."""
    allowed, why = limit_descent(0.5, agl_m=None, limits=_limits())
    assert allowed == 0.0
    assert "blind" in why


def test_descent_eases_rather_than_stopping_dead():
    """Arriving at the floor at full rate and cutting to zero reads as a bounce
    and upsets the position controller."""
    full, _ = limit_descent(0.6, agl_m=5.0 + _DESCENT_TAPER_M + 1, limits=_limits())
    assert full == pytest.approx(0.6), "outside the taper band it must pass through"
    eased, _ = limit_descent(0.6, agl_m=5.0 + _DESCENT_TAPER_M / 2, limits=_limits())
    assert 0.0 < eased < 0.6


def test_climb_is_never_touched_by_the_floor():
    """Climbing has its own ceiling in decide_elevation; clamping it here too
    would silently duplicate that bound."""
    for agl in (None, 0.5, 3.0, 50.0):
        out, why = limit_descent(-1.2, agl_m=agl, limits=_limits())
        assert out == -1.2 and why is None


def test_the_recorded_crash_profile_cannot_repeat():
    """
    Replay of the real descent, from the ulog: 6.6m falling at the commanded
    +0.5 m/s, ~2.5s per sample. Without a floor this reached 0. With one it
    must arrest above the floor and stay there.
    """
    limits = _limits(5.0)
    agl, dt, commanded = 6.6, 2.5, 0.5
    for _ in range(20):
        allowed, _ = limit_descent(commanded, agl_m=agl, limits=limits)
        agl -= allowed * dt
        assert agl > 0.0, "flew into the ground again"
    assert agl >= limits.min_altitude_agl_m - 0.01, (
        f"settled at {agl:.2f}m, below the {limits.min_altitude_agl_m}m floor"
    )
