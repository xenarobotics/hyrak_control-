"""Vertical escape: last resort when no horizontal way exists, only over
obstacles whose top was actually seen."""
import numpy as np

from app.avoidance.core.controller import AvoidanceState
from app.avoidance.sensing.depth_scan import scan_from_depth, vfov_for

from avoid_harness import _controller


def _ring(c, top, now, r=3.0):
    import math
    for k in range(24):
        a = math.radians(k * 15)
        c.grid.pin_disc(r * math.cos(a), r * math.sin(a), 0.6, top_m=top, now=now)


def _engage_and_block(c, t0):
    d = c.decide_local((40.0, 0.0), None, now=t0)
    assert c.state == AvoidanceState.AVOIDING, d.reason
    return c.decide_local((40.0, 0.0), None, now=t0 + c.params.climb_after_blocked_s + 0.1)


def test_boxed_in_below_known_tops_climbs_then_steers_on_at_the_new_height():
    c, h = _controller(alt=5.0, t=10.0)
    _ring(c, top=6.0, now=10.0)
    d = _engage_and_block(c, 10.0)
    assert d.action == "avoid" and c.state == AvoidanceState.CLIMBING, d.reason
    assert d.setpoint.vd < 0 and abs(d.setpoint.vn) < 1e-6 and abs(d.setpoint.ve) < 1e-6
    target = c._climb_target
    assert abs(target - 8.0) < 1e-6                     # top 6 + 2 m margin
    lat, lng = h.to_latlng(0.0, 0.0)
    h.add(lat, lng, 8.0, 0.0, t=14.0)                   # reached it
    d = c.decide_local((40.0, 0.0), None, now=14.0)
    assert c.state == AvoidanceState.AVOIDING and d.setpoint and not d.setpoint.blocked, d.reason
    assert d.setpoint.vn > 0.1                           # on toward the goal


def test_unknown_tops_are_never_climbed():
    c, _ = _controller(alt=5.0, t=20.0)
    _ring(c, top=0.0, now=20.0)
    d = _engage_and_block(c, 20.0)
    assert c.state != AvoidanceState.CLIMBING, d.reason
    d = c.decide_local((40.0, 0.0), None, now=20.0 + c.params.block_hold_s + 0.2)
    assert d.action == "hold"


def test_climb_beyond_the_gain_limit_is_refused():
    c, _ = _controller(alt=5.0, t=30.0)
    _ring(c, top=5.0 + c.params.climb_max_gain_m + 1.0, now=30.0)
    _engage_and_block(c, 30.0)
    assert c.state != AvoidanceState.CLIMBING


def test_no_hand_back_until_clear_at_the_original_height():
    c, h = _controller(alt=5.0, t=40.0)
    _ring(c, top=6.0, now=40.0)
    _engage_and_block(c, 40.0)
    lat, lng = h.to_latlng(0.0, 0.0)
    h.add(lat, lng, 8.0, 0.0, t=44.0)
    for k in range(30):                                  # clear up here, not down there
        d = c.decide_local((10.0, 0.0), None, now=44.0 + k * 0.1)
        assert d.action != "resume", d.reason


def _scan(z, alt=5.0):
    rows, cols = z.shape
    return scan_from_depth(z, 70.0, vfov_for(70.0, cols * 8, rows * 8), alt_m=alt, max_range_m=20.0)


def test_a_top_cut_off_by_the_frame_is_unknown():
    z = np.full((60, 80), np.inf, np.float32)
    z[:, 30:50] = 5.0                                    # pillar through the whole frame
    tops = [b.top_m for b in _scan(z) if b.hit_m is not None]
    assert tops and all(t == 0.0 for t in tops)


def test_a_top_inside_the_frame_is_known():
    z = np.full((60, 80), np.inf, np.float32)
    z[25:, 30:50] = 5.0                                  # box, sky above it
    tops = [b.top_m for b in _scan(z) if b.hit_m is not None]
    assert tops and all(t > 0.0 for t in tops)
