"""Bench 2026-10-25 13:38: the drone's session link died (LINK LOST) after a
NEW session for the same drone had connected. The old session was held 90 s
for its client and its manager kept is_connected True, so the avoidance loop
(which took the first connected session) read pose from the dead link: pose
stale for 90 s. Avoidance braked into its own HOLD, and with no route that
HOLD never ended - the keep-clear reflex only ran for an operator HOLD."""
import time

from app.avoidance.core import loop as av_loop
from app.avoidance.core.controller import AvoidanceState
from app.avoidance.mapping import pose_history
from app.telemetry.manager import TelemetryManager

from avoid_harness import _controller

DRONE = "d-handover"


class _Sess:
    def __init__(self, sid, drone_id):
        self.session_id, self.drone = sid, {"id": drone_id}


class _SM:
    def __init__(self, links):
        self.links = links            # [(sid, manager)] in creation order

    def all_sessions(self):
        return [_Sess(sid, DRONE) for sid, _ in self.links]

    def get_telemetry(self, sid):
        return dict(self.links).get(sid)


def _mgr(lat, alt):
    m = TelemetryManager(on_update=lambda d: None)
    m._connected = True
    m._snapshot.position.latitude_deg = lat
    m._snapshot.position.longitude_deg = 78.1
    m._snapshot.position.relative_altitude_m = alt
    m._snapshot.flight_mode.mode = "HOLD"
    return m


async def test_old_link_dies_after_new_link_connects(monkeypatch):
    old, new = _mgr(17.5, 4.5), _mgr(17.6, 15.0)
    now = time.monotonic()
    old._last_rx_t = now - 0.1
    monkeypatch.setattr(av_loop, "_session_manager", _SM([("old", old)]))
    av_loop._listeners.pop(DRONE, None)
    c, _ = _controller()
    c.drone_id = DRONE
    try:
        mgr, _, _, _ = av_loop._resolve_link(DRONE)
        assert mgr is old
        av_loop._ensure_pose_feed(c, mgr)
        assert old._pose_listeners

        # A new session links the same drone and receives; then the old link
        # goes silent (LINK LOST) while its session is still held.
        new._last_rx_t = now
        monkeypatch.setattr(av_loop, "_session_manager", _SM([("old", old), ("new", new)]))
        old._link_lost_since = now - 2.0
        mgr, pose, in_air, mode = av_loop._resolve_link(DRONE)
        assert mgr is new, "pose must follow the link that is receiving"
        assert abs(pose.alt_m - 15.0) < 1e-6 and in_air and mode == "HOLD"
        av_loop._ensure_pose_feed(c, mgr)
        assert not old._pose_listeners and new._pose_listeners
        assert av_loop._listeners[DRONE][0] is new
        # The new link's updates now feed the history.
        new._notify_pose()
        s = pose_history.history(DRONE).latest()
        assert s is not None and time.monotonic() - s.t < 1.0

        # Both alive: the one heard from most recently wins.
        old._link_lost_since = None
        old._last_rx_t = time.monotonic() + 1.0
        assert av_loop._resolve_link(DRONE)[0] is old
    finally:
        av_loop._release_pose_feed(DRONE)


def test_own_hold_with_no_route_runs_the_keep_clear_reflex():
    """Avoidance's own HOLD (intervened, no route) with something 0.7 m ahead
    backs away; before, it held there for good with the old reason."""
    c, h = _controller(t=50.0)
    c.set_armed(True)
    c.intervened = True
    c.state = AvoidanceState.HOLDING
    c._last_reason = "pose stale (90.0 s) - holding"
    c._last_frame_t = 50.0
    c.grid.pin_disc(1.2, 0.0, 0.5, now=50.0)            # ~0.7 m ahead (north)
    d = c.decide_local(None, None, now=50.0)
    assert d.action == "avoid" and d.setpoint is not None, d.reason
    assert d.setpoint.vn < -0.5                          # backing south
    assert "pose stale" not in c._last_reason
    lat, lng = h.to_latlng(-5.5, 0.0)                    # past keep_clear_release_m
    h.add(lat, lng, 10.0, 0.0, t=56.0)
    c._last_frame_t = 56.0
    d = c.decide_local(None, None, now=56.0)
    assert d.action == "hold", d.reason
    d = c.decide_local(None, None, now=56.1)
    assert d.action == "hold" and "no route" in d.reason, d.reason


def test_own_hold_with_no_route_and_nothing_close_stays_put():
    c, _ = _controller(t=60.0)
    c.intervened = True
    c.state = AvoidanceState.HOLDING
    c._last_frame_t = 60.0
    c.grid.pin_disc(8.0, 0.0, 1.0, now=60.0)            # in view, not close
    d = c.decide_local(None, None, now=60.0)
    assert d.action == "hold" and "nearest obstacle" in d.reason, d.reason
