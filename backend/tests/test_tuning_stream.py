"""Config > Tuning live chart feed (app/telemetry/tuning_stream.py,
app/events/tuning_events.py). Fakes only, no vehicle."""
import asyncio
import json
import math
import sys
import time
from types import SimpleNamespace

import pytest

from app.events import tuning_events as te
from app.telemetry import tuning_stream as ts


# ── parsing ───────────────────────────────────────────────────────────────

def test_attitude_row_in_degrees_on_fc_clock():
    row = ts.parse_row("ATTITUDE", json.dumps({
        "time_boot_ms": 12345, "roll": math.pi / 2, "pitch": 0.0, "yaw": -math.pi,
        "rollspeed": 1.0, "pitchspeed": 0.0, "yawspeed": 0.5}))
    assert row[0] == 12.345
    assert row[1] == 90.0 and row[3] == -180.0
    assert abs(row[4] - 57.296) < 1e-3


def test_attitude_target_quaternion_to_euler_and_mask():
    half = math.radians(10) / 2
    q = [math.cos(half), math.sin(half), 0.0, 0.0]      # 10 deg roll
    row = ts.parse_row("ATTITUDE_TARGET", json.dumps({
        "time_boot_ms": 1000, "q": q, "type_mask": 0,
        "body_roll_rate": 0.1, "body_pitch_rate": 0.0, "body_yaw_rate": 0.0}))
    assert abs(row[1] - 10.0) < 1e-3 and abs(row[2]) < 1e-6
    assert abs(row[4] - 5.73) < 1e-2
    # Bit 7: attitude ignored; bit 2: yaw rate ignored.
    row = ts.parse_row("ATTITUDE_TARGET", json.dumps({
        "time_boot_ms": 1000, "q": q, "type_mask": 0x80 | 0x04,
        "body_roll_rate": 0.1, "body_pitch_rate": 0.2, "body_yaw_rate": 0.3}))
    assert row[1:4] == [None, None, None]
    assert row[6] is None and row[5] is not None


def test_nan_and_garbage_never_reach_the_socket():
    # mavlink_direct writes NaN literally (PX4 fills unused setpoints with NaN).
    row = ts.parse_row("POSITION_TARGET_LOCAL_NED",
                       '{"time_boot_ms": 5, "x": NaN, "y": 1.5, "z": Infinity, "vx": 0.2, "vy": -0.1, "vz": 0}')
    assert row == [0.005, None, 1.5, None, 0.2, -0.1, 0.0]
    assert ts.parse_row("ATTITUDE", "not json") is None
    assert ts.parse_row("ATTITUDE", '{"roll": 1}') is None            # no timestamp
    assert ts.parse_row("HEARTBEAT", '{"time_boot_ms": 1}') is None
    assert ts.quat_to_euler([0, 0, 0, 0]) is None
    assert ts.quat_to_euler([float("nan"), 0, 0, 1]) is None
    json.dumps(ts.parse_row("ATTITUDE_TARGET", '{"time_boot_ms": 1, "q": [NaN, 0, 0, 0]}'), allow_nan=False)


def test_rates_by_link_and_loop_selection():
    assert ts.stream_hz(SimpleNamespace(link_is_radio=True)) == ts.RADIO_HZ == 10
    assert ts.stream_hz(SimpleNamespace(link_is_radio=False)) == ts.LOCAL_HZ == 50
    assert ts.stream_hz(SimpleNamespace(_link_kind="local", _address="serial:///dev/ttyACM0:57600")) == 10
    assert ts.normalise_loop("velocity") == "velocity"
    assert ts.normalise_loop("bogus") == "rate" and ts.normalise_loop(None) == "rate"
    assert ts.LOOPS["position"] == ("LOCAL_POSITION_NED", "POSITION_TARGET_LOCAL_NED")
    # Radio budget for one loop stays around a kilobyte a second.
    assert ts.extra_bytes_s("rate", 10) < 1000


def test_batcher_ten_rows_or_quarter_second():
    b = ts.Batcher(rows=10, max_wait_s=0.25)
    assert not b.due(0.0)
    for i in range(9):
        b.add("att", [i], now=0.0)
    assert not b.due(0.1)
    b.add("att_sp", [9], now=0.1)
    assert b.due(0.1)
    out = b.take()
    assert len(out["att"]) == 9 and len(out["att_sp"]) == 1
    assert not b.due(5.0)
    b.add("att", [1], now=1.0)
    assert not b.due(1.2) and b.due(1.26)


# ── message rates ─────────────────────────────────────────────────────────

class FakeDirect:
    """mavlink_direct: records COMMAND_LONGs, answers GET_MESSAGE_INTERVAL
    from `intervals`, and plays `script` rows on message subscriptions."""

    def __init__(self, intervals=None, script=None, answer=True):
        self.sent: list[dict] = []
        self.intervals = dict(intervals or {})
        self.answer = answer
        self.script = script or {}
        self._replies: list[asyncio.Queue] = []

    async def send_message(self, msg):
        f = json.loads(msg.fields_json)
        self.sent.append(f)
        if f["command"] == ts.MAV_CMD_GET_MESSAGE_INTERVAL and self.answer:
            mid = int(f["param1"])
            reply = SimpleNamespace(component_id=1, fields_json=json.dumps(
                {"message_id": mid, "interval_us": self.intervals.get(mid, 0)}))
            for q in self._replies:
                q.put_nowait(reply)

    async def message(self, name):
        if name == "MESSAGE_INTERVAL":
            q: asyncio.Queue = asyncio.Queue()
            self._replies.append(q)
            try:
                while True:
                    yield await q.get()
            finally:
                self._replies.remove(q)
        for comp, fields in self.script.get(name, []):
            await asyncio.sleep(0.001)
            yield SimpleNamespace(component_id=comp, fields_json=json.dumps(fields))
        await asyncio.Event().wait()


class FakeMsg:
    def __init__(self, name, a, b, sysid, comp, fields_json):
        self.message_name, self.fields_json = name, fields_json


@pytest.fixture(autouse=True)
def fake_mavsdk(monkeypatch):
    monkeypatch.setitem(sys.modules, "mavsdk.mavlink_direct", SimpleNamespace(MavlinkMessage=FakeMsg))


def _tel(radio=False, **kw):
    d = FakeDirect(**kw)
    return SimpleNamespace(is_connected=True, link_is_radio=radio, _target_sysid=7,
                           _drone=SimpleNamespace(mavlink_direct=d)), d


def _sets(d):
    return [(int(f["param1"]), f["param2"]) for f in d.sent if f["command"] == ts.MAV_CMD_SET_MESSAGE_INTERVAL]


async def test_raise_then_restore_exact_prior_interval():
    tel, d = _tel(intervals={30: 100_000, 83: 0})      # ATTITUDE 10 Hz, ATTITUDE_TARGET not streamed
    r = ts.MessageRates()
    await r.acquire(tel, ("ATTITUDE", "ATTITUDE_TARGET"), 50)
    assert _sets(d) == [(30, 20_000.0), (83, 20_000.0)]
    assert all(f["target_system"] == 7 for f in d.sent)
    d.sent.clear()
    await r.release(tel, ("ATTITUDE", "ATTITUDE_TARGET"))
    assert _sets(d) == [(30, 100_000.0), (83, -1.0)]


async def test_never_lowers_a_faster_stream_and_shares_between_sockets():
    tel, d = _tel(intervals={30: 5_000, 83: 500_000})   # ATTITUDE already 200 Hz
    r = ts.MessageRates()
    await r.acquire(tel, ("ATTITUDE", "ATTITUDE_TARGET"), 10)
    await r.acquire(tel, ("ATTITUDE", "ATTITUDE_TARGET"), 10)   # a second tab
    assert _sets(d) == [(83, 100_000.0)]
    assert sum(1 for f in d.sent if f["command"] == ts.MAV_CMD_GET_MESSAGE_INTERVAL) == 2
    d.sent.clear()
    await r.release(tel, ("ATTITUDE", "ATTITUDE_TARGET"))
    assert _sets(d) == []                     # the other tab still watching
    await r.release(tel, ("ATTITUDE", "ATTITUDE_TARGET"))
    assert _sets(d) == [(83, 500_000.0)]      # ATTITUDE was never touched


async def test_no_reply_restores_px4_default(monkeypatch):
    monkeypatch.setattr(ts, "query_interval", _no_answer)
    tel, d = _tel()
    r = ts.MessageRates()
    await r.acquire(tel, ("LOCAL_POSITION_NED",), 10)
    d.sent.clear()
    await r.release(tel, ("LOCAL_POSITION_NED",))
    assert _sets(d) == [(32, 0.0)]


async def _no_answer(tel, msg_id, timeout=1.5):
    return None


async def test_query_interval_times_out_quietly():
    tel, d = _tel(answer=False)
    assert await ts.query_interval(tel, 30, timeout=0.05) is None


# ── the feed ──────────────────────────────────────────────────────────────

async def test_feed_batches_rows_skips_other_components_and_restores_rates():
    att = [(1, {"time_boot_ms": 1000 + i * 20, "roll": 0.0, "pitch": 0.0, "yaw": 0.0,
                "rollspeed": 0.0, "pitchspeed": 0.0, "yawspeed": 0.0}) for i in range(12)]
    att.append((154, {"time_boot_ms": 1, "roll": 9.0, "pitch": 0, "yaw": 0,
                      "rollspeed": 0, "pitchspeed": 0, "yawspeed": 0}))     # a gimbal
    sp = [(1, {"time_boot_ms": 1000 + i * 20, "q": [1, 0, 0, float("nan")], "type_mask": 0,
               "body_roll_rate": float("nan"), "body_pitch_rate": 0, "body_yaw_rate": 0}) for i in range(8)]
    tel, d = _tel(intervals={30: 100_000, 83: 0}, script={"ATTITUDE": att, "ATTITUDE_TARGET": sp})
    feeds = {"s1": {"until": time.monotonic() + 30, "tel": tel, "loop": "rate"}}
    packets = []

    async def emit(p):
        packets.append(p)

    task = asyncio.create_task(te.run_feed("s1", tel, "rate", emit, feeds=feeds, rates=ts.MessageRates()))
    feeds["s1"]["task"] = task
    for _ in range(100):
        await asyncio.sleep(0.02)
        if sum(len(p.get("att", [])) for p in packets) >= 12 and sum(len(p.get("att_sp", [])) for p in packets) >= 8:
            break
    assert packets[0] == {"loop": "rate", "hz": 50.0, "link": "local", "bytes_s": ts.extra_bytes_s("rate", 50)}
    rows = [r for p in packets for r in p.get("att", [])]
    assert len(rows) == 12 and all(r[1] == 0.0 for r in rows)      # gimbal row dropped
    assert all(len(p.get("att", [])) + len(p.get("att_sp", [])) <= 10 for p in packets)
    for p in packets:
        json.dumps(p, allow_nan=False)                                # no NaN on the wire
    assert (30, 20_000.0) in _sets(d)
    d.sent.clear()
    feeds.pop("s1")                     # page said off
    await asyncio.wait_for(task, 1)
    assert _sets(d) == [(30, 100_000.0), (83, -1.0)]


async def test_feed_stops_on_lease_expiry_and_link_loss():
    tel, d = _tel(radio=True)
    feeds = {"s": {"until": time.monotonic() - 1, "tel": tel, "loop": "velocity"}}
    packets = []

    async def emit(p):
        packets.append(p)

    await asyncio.wait_for(te.run_feed("s", tel, "velocity", emit, feeds=feeds, rates=ts.MessageRates()), 5)
    assert packets[0]["hz"] == 10 and packets[0]["link"] == "radio"
    assert "s" not in feeds or feeds["s"].get("task") is None

    tel2, _ = _tel()
    tel2.is_connected = False
    feeds = {"s": {"until": time.monotonic() + 30, "tel": tel2, "loop": "rate"}}
    await asyncio.wait_for(te.run_feed("s", tel2, "rate", emit, feeds=feeds, rates=ts.MessageRates()), 5)


async def test_cancelled_feed_still_restores(monkeypatch):
    tel, d = _tel(intervals={32: 250_000, 85: 0})
    feeds = {"x": {"until": time.monotonic() + 30, "tel": tel, "loop": "position"}}

    async def emit(p):
        pass

    task = asyncio.create_task(te.run_feed("x", tel, "position", emit, feeds=feeds, rates=ts.MessageRates()))
    feeds["x"]["task"] = task
    for _ in range(50):
        await asyncio.sleep(0.01)
        if len(_sets(d)) == 2:
            break
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert _sets(d)[-2:] == [(32, 250_000.0), (85, -1.0)]
    assert "x" not in feeds


async def test_drop_sid_cancels_the_socket_feed():
    t = asyncio.create_task(asyncio.Event().wait())
    te._feeds["gone"] = {"task": t, "until": time.monotonic() + 30}
    await te.drop_sid("gone")
    await asyncio.gather(t, return_exceptions=True)
    assert t.cancelled() and "gone" not in te._feeds
    await te.drop_sid("never-was")
