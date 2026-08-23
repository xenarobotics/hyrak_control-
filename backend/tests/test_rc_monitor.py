"""
The Radio page's live channel feed. MAVSDK exposes no per-channel RC data,
so rc_monitor parses the RC_CHANNELS MAVLink message off a passively bound
UDP port — these tests feed it real encoded MAVLink and check what comes
out, because the parser path (robust_parsing, mid-stream sync) is exactly
where a wrong assumption would silently produce empty bars.
"""
import time

from pymavlink.dialects.v20 import common as mavlink2

from app.telemetry.rc_monitor import RcChannelMonitor, STALE_AFTER_S


def _rc_packet(**overrides) -> bytes:
    """One genuine RC_CHANNELS message, encoded."""
    mav = mavlink2.MAVLink(None, srcSystem=1, srcComponent=1)
    vals = {f"chan{i}_raw": 1500 for i in range(1, 19)}
    vals.update(chan1_raw=1100, chan3_raw=1900, chancount=8, rssi=180)
    vals.update(overrides)
    msg = mavlink2.MAVLink_rc_channels_message(
        time_boot_ms=1234, **vals
    )
    return msg.pack(mav)


def test_channels_come_out_as_sent():
    got = []
    m = RcChannelMonitor(got.append)
    m._feed(_rc_packet())
    assert len(got) == 1
    p = got[0]
    assert p["count"] == 8
    assert p["channels"][0] == 1100
    assert p["channels"][2] == 1900
    assert p["rssi"] == 180


def test_emits_are_throttled_to_ten_hz():
    """RC_CHANNELS can arrive at 50 Hz; the browser needs 10. The rest must
    be dropped here, not shipped to every connected client."""
    got = []
    m = RcChannelMonitor(got.append)
    for _ in range(20):
        m._feed(_rc_packet())
    assert len(got) == 1


def test_other_messages_are_ignored():
    got = []
    m = RcChannelMonitor(got.append)
    mav = mavlink2.MAVLink(None, srcSystem=1, srcComponent=1)
    hb = mavlink2.MAVLink_heartbeat_message(2, 3, 81, 0, 4, 3).pack(mav)
    m._feed(hb)
    assert got == []


def test_garbage_does_not_kill_the_parser():
    """A shared GCS port sees mid-stream joins and corrupt datagrams; the
    parser must resync on the next clean packet, not raise."""
    got = []
    m = RcChannelMonitor(got.append)
    m._feed(b"\xfd\x00garbage\x00\xff" * 3)
    m._feed(_rc_packet())
    assert len(got) == 1


def test_live_reflects_recency_not_just_binding():
    m = RcChannelMonitor(lambda p: None)
    assert not m.live, "never bound, never live"
    m._transport = object()  # pretend bound
    assert not m.live, "bound but silent is NOT live — that is the USB-serial case"
    m.last_seen = time.monotonic()
    assert m.live
    m.last_seen = time.monotonic() - STALE_AFTER_S - 1
    assert not m.live
