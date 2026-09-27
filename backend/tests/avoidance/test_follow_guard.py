"""Follow guard: avoidance filters a tracker's velocity command instead of
taking the aircraft. Pass-through cases must be EXACT - that is the promise
that follow behaves as before wherever the guard has nothing to say."""
import asyncio
import math

import pytest

from app.avoidance.core import loop as av_loop
from app.avoidance.core.controller import AvoidanceState

from avoid_harness import _controller


def _c(yaw=0.0, t=100.0, alt=10.0):
    c, h = _controller(yaw=yaw, alt=alt, t=t)
    c.armed = True
    return c


# -- pass-through: bit-for-bit the tracker's command ------------------------

@pytest.mark.parametrize("setup", ["clear", "disabled", "steer_off", "guard_off", "low", "hover"])
def test_pass_through_is_exact(setup):
    c = _c(alt=1.0 if setup == "low" else 10.0)
    c.grid.pin_disc(30.0, 30.0, 1.0, now=100.0)          # far off to the side
    if setup == "disabled":
        c.set_enabled(False)
    if setup == "steer_off":
        c.armed = False
    if setup == "guard_off":
        c.params.guard_follow = 0.0
    if setup == "low":
        c.grid.pin_disc(4.0, 0.0, 1.0, now=100.0)        # below the floor: not judged
    fwd, right = (0.05, 0.05) if setup == "hover" else (1.7, -0.4)
    assert c.guard_body(fwd, right, now=100.0)[:2] == (fwd, right)


def test_no_controller_means_untouched():
    assert av_loop.guard_follow("no-such-session", 1.3, 0.2) == (1.3, 0.2)


def test_guard_never_raises(monkeypatch):
    c = _c()
    monkeypatch.setattr(av_loop, "_controller_for_session", lambda sid: c)
    monkeypatch.setattr(c, "guard_body", lambda *a, **k: 1 / 0)
    assert av_loop.guard_follow("s", 2.0, 0.5) == (2.0, 0.5)


# -- bending, slowing, holding ----------------------------------------------

def test_obstacle_ahead_is_slid_around_not_flown_into():
    c = _c()
    c.grid.pin_disc(7.0, 0.0, 1.0, now=100.0)            # 6 m straight ahead (north)
    f, r, ev = c.guard_body(3.0, 0.0, now=100.0)
    assert ev == "start"
    assert abs(r) > 0.2                                    # sideways component appeared
    assert math.hypot(f, r) <= 3.0 + 1e-9                  # never faster than asked
    assert "follow guard" in c._last_reason


def test_wall_all_round_the_front_holds_position():
    c = _c()
    for k in range(-9, 10):
        a = math.radians(k * 10)
        c.grid.pin_disc(2.0 * math.cos(a), 2.0 * math.sin(a), 0.4, now=100.0)
    f, r, _ = c.guard_body(2.5, 0.0, now=100.0)
    assert math.hypot(f, r) < 1e-6
    assert "holding position" in c._last_reason


def test_body_frame_follows_the_heading():
    c = _c(yaw=90.0)                                       # nose east
    c.grid.pin_disc(0.0, 5.0, 1.0, now=100.0)             # 4 m ahead of the nose
    f, r, _ = c.guard_body(3.0, 0.0, now=100.0)
    assert f < 3.0 - 0.3                                   # forward reduced / bent


def test_moving_where_the_camera_does_not_look_is_capped():
    c = _c()
    f, r, _ = c.guard_body(0.0, 4.0, now=100.0)          # straight right, nothing mapped
    assert abs(math.hypot(f, r) - c.params.guard_unseen_speed_m_s) < 1e-6
    assert r > 0


def test_episode_start_and_end_events():
    c = _c()
    c.grid.pin_disc(7.0, 0.0, 1.0, now=100.0)
    assert c.guard_body(3.0, 0.0, now=100.0)[2] == "start"
    assert c.guard_body(3.0, 0.0, now=100.1)[2] is None
    c.grid.clear()
    assert c.guard_body(3.0, 0.0, now=100.2)[2] == "end"
    assert c.status(now=100.2)["following"] is True


# -- the mission supervisor stands down while following ---------------------

class _Mgr:
    is_connected = True
    _pilot_override_mode = None

    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        async def rec(*a, **k):
            self.calls.append(name)
            return True
        return rec


def test_supervisor_stands_down_while_a_follow_commands():
    c = _c()
    c.state, c.intervened = AvoidanceState.AVOIDING, True
    c.grid.pin_disc(6.0, 0.0, 1.0, now=100.0)
    c.guard_body(2.0, 0.0, now=100.0)                      # tracker is live
    m = _Mgr()
    from app.avoidance.mapping import pose_history
    pose = pose_history.history(c.drone_id).latest()
    asyncio.run(av_loop._local_step(c, m, pose, True, "OFFBOARD", 100.3))
    assert c.state == AvoidanceState.NOMINAL and not c.intervened
    assert not [x for x in m.calls if x in ("set_flight_mode", "start_offboard", "send_velocity_ned",
                                            "resume_mission_from_offboard")]


def test_supervisor_returns_once_the_follow_stops():
    c = _c()
    c.guard_body(2.0, 0.0, now=100.0)
    assert c.following(100.5) and not c.following(101.2)


def test_closed_loop_follow_past_a_pillar_keeps_clear_and_keeps_following():
    """A tracker chases a target that walks behind a pillar. Kinematic
    aircraft, nose kept on the target (as the trackers yaw), guard in the
    loop. It must never get inside the pillar's clearance and must still
    end near the target."""
    from app.avoidance.mapping import pose_history
    c = _c(t=0.0)
    h = pose_history.history(c.drone_id)
    pillar, pr = (15.0, 0.0), 1.0
    c.grid.pin_disc(pillar[0], pillar[1], pr, now=0.0)
    pos, target = [0.0, 0.0], [30.0, 0.0]
    min_gap, dt = math.inf, 0.1
    for i in range(1, 400):
        t = i * dt
        dn, de = target[0] - pos[0], target[1] - pos[1]
        yaw = math.degrees(math.atan2(de, dn)) % 360.0
        lat, lng = h.to_latlng(pos[0], pos[1])
        h.add(lat, lng, 10.0, yaw, t=t)
        dist = math.hypot(dn, de)
        fwd = min(3.0, 0.6 * max(0.0, dist - 3.0))            # tracker: close to 3 m
        f, r, _ = c.guard_body(fwd, 0.0, now=t)
        y = math.radians(yaw)
        pos[0] += (f * math.cos(y) - r * math.sin(y)) * dt
        pos[1] += (f * math.sin(y) + r * math.cos(y)) * dt
        min_gap = min(min_gap, math.hypot(pos[0] - pillar[0], pos[1] - pillar[1]) - pr)
    assert min_gap > 1.5, min_gap
    assert math.hypot(target[0] - pos[0], target[1] - pos[1]) < 6.0, pos
