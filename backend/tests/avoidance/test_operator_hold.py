"""Operator HOLD: never steered toward the route or handed back to the mission;
the only movement is the keep-clear reflex (back away, keep facing it)."""
from app.avoidance.core.controller import AvoidanceState
from app.avoidance.mapping import pose_history

from avoid_harness import _controller


def _hold(c):
    c._operator_hold = True
    return c


def test_operator_hold_never_steers_or_resumes():
    c, _ = _controller(t=10.0)
    _hold(c)
    c.grid.pin_disc(8.0, 0.0, 1.0, now=10.0)            # in view, not close
    for k in range(40):
        d = c.decide_local(None, None, now=10.0 + k * 0.1)
        assert d.action == "clear", d.reason
    assert c.state == AvoidanceState.NOMINAL


def test_keep_clear_backs_away_facing_the_obstacle_then_holds():
    c, h = _controller(t=20.0)
    _hold(c)
    c.grid.pin_disc(2.0, 0.0, 0.5, now=20.0)            # 1.5-2 m ahead (north)
    d = c.decide_local(None, None, now=20.0)
    assert d.action == "avoid" and d.setpoint is not None, d.reason
    assert d.setpoint.vn < -0.5 and abs(d.setpoint.ve) < 0.5   # backing south
    assert abs(((d.setpoint.yaw_deg + 180) % 360) - 180) < 10  # still facing north
    lat, lng = h.to_latlng(-6.0, 0.0)                    # now well clear
    h.add(lat, lng, 10.0, 0.0, t=24.0)
    d = c.decide_local(None, None, now=24.0)
    assert d.action == "hold", d.reason
    d = c.decide_local(None, None, now=24.1)
    assert d.action == "clear"                           # stays in HOLD, no escalation


def test_keep_clear_off_means_hands_off():
    c, _ = _controller(t=30.0)
    _hold(c)
    c.params.keep_clear_m = 0.0
    c.grid.pin_disc(2.0, 0.0, 0.5, now=30.0)
    assert c.decide_local(None, None, now=30.0).action == "clear"


def test_without_operator_hold_manual_flight_still_brakes():
    c, _ = _controller(t=40.0)
    c.grid.pin_disc(8.0, 0.0, 1.0, now=40.0)
    assert c.decide_local(None, None, now=40.0).action == "hold"
