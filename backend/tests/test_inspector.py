"""Config > Analyze MAVLink Inspector (app/telemetry/inspector.py,
app/events/inspector_events.py). Fakes only, no vehicle."""
import asyncio
import json
import sys
import time
from types import SimpleNamespace

import pytest

from app.events import inspector_events as ie
from app.telemetry import inspector as ins
from app.telemetry import tuning_stream as ts


# ── pure parts ────────────────────────────────────────────────────────────

def test_keys_and_fields_parse_strictly():
    assert ins.parse_key("ATTITUDE:1:1") == ("ATTITUDE", 1, 1)
    assert ins.parse_key("attitude:1:1") is None
    assert ins.parse_key("ATTITUDE:1") is None and ins.parse_key(None) is None
    assert ins.parse_field("roll") == ("roll", None)
    assert ins.parse_field("q[3]") == ("q", 3)
    for bad in ("q[", "a b", "__import__('x')", "x" * 80, 5, "q[1000]"):
        assert ins.parse_field(bad) is None


def test_nan_long_strings_and_arrays_are_made_safe():
    raw = ins.load_fields('{"a": NaN, "b": Infinity, "c": 1.5, "d": [1, NaN, 3], "e": "%s", "f": true, "g": {"x": 1}}'
                          % ("x" * 500))
    out = ins.clean_fields(raw)
    assert out["a"] is None and out["b"] is None and out["c"] == 1.5
    assert out["d"] == [1, None, 3] and len(out["e"]) == ins.MAX_STR and out["f"] == 1 and out["g"] is None
    json.dumps(out, allow_nan=False)
    assert ins.load_fields("nope") is None and ins.load_fields("[1]") is None
    assert ins.numeric_at({"q": [1, 2]}, "q", 1) == 2.0
    assert ins.numeric_at({"q": [1, 2]}, "q", 5) is None
    assert ins.numeric_at({"s": "text"}, "s", None) is None
    assert ins.numeric_at({"v": float("nan")}, "v", None) is None


def test_counts_rates_open_fields_and_plot_samples():
    i = ins.Inspector(t0=0.0)
    i.set_plot([{"key": "ATTITUDE:1:1", "field": "roll"}, {"key": "ATTITUDE:1:1", "field": "q[0]"},
                {"key": "bad", "field": "roll"}])
    assert len(i.plot) == 2
    for k in range(11):                                  # 10 Hz for a second
        i.feed("ATTITUDE", 1, 1, json.dumps({"roll": k * 0.1, "q": [1, 0, 0, 0]}), now=k * 0.1)
    i.feed("ATTITUDE", 1, 154, '{"roll": 9}', now=1.0)    # a gimbal: its own row
    i.feed("HEARTBEAT", 1, 1, '{"type": 2}', now=1.0)
    s = i.summary(open_keys=["ATTITUDE:1:1"], now=1.0)
    rows = {m["key"]: m for m in s["msgs"]}
    assert set(rows) == {"ATTITUDE:1:1", "ATTITUDE:1:154", "HEARTBEAT:1:1"}
    att = rows["ATTITUDE:1:1"]
    assert att["n"] == 11 and abs(att["hz"] - 10) < 0.01 and att["fields"]["roll"] == 1.0
    assert "fields" not in rows["HEARTBEAT:1:1"]
    assert len(s["plot"]["ATTITUDE:1:1|roll"]) == 11 and s["plot"]["ATTITUDE:1:1|q[0]"][0] == [0.0, 1.0]
    assert "ATTITUDE:1:154|roll" not in s["plot"]
    json.dumps(s, allow_nan=False)
    # Samples are handed out once; a stale message reads 0 Hz.
    assert i.summary(now=1.2)["plot"] == {}
    assert {m["key"]: m for m in i.summary(now=10.0)["msgs"]}["ATTITUDE:1:1"]["hz"] == 0.0


def test_limits_hold():
    i = ins.Inspector(t0=0.0)
    acc = i.set_plot([{"key": f"M{k}:1:1", "field": "x"} for k in range(20)])
    assert len(acc) == ins.MAX_PLOT
    for k in range(ins.MAX_KEYS + 5):
        i.feed(f"M{k}", 1, 1, '{"x": 1}', now=0.0)
    assert len(i.stats) == ins.MAX_KEYS and i.dropped == 5
    for _ in range(ins.MAX_SAMPLES + 50):
        i.feed("M0", 1, 1, '{"x": 2}', now=0.0)
    assert len(i.samples["M0:1:1|x"]) == ins.MAX_SAMPLES
    # Dropping a plotted pair forgets its samples.
    i.set_plot([])
    assert i.samples == {}


def test_message_ids_and_radio_budget():
    assert ins.message_info("ATTITUDE")[0] == 30
    assert ins.message_info("NOT_A_MESSAGE") is None
    chosen, skipped, b = ins.raise_plan(["ATTITUDE", "HEARTBEAT", "BOGUS"], 50, radio=False)
    assert chosen == ["ATTITUDE"] and set(skipped) == {"HEARTBEAT", "BOGUS"} and b == (28 + 12) * 50
    many = ["ATTITUDE", "LOCAL_POSITION_NED", "VFR_HUD", "HIGHRES_IMU", "GLOBAL_POSITION_INT", "VIBRATION"]
    chosen, skipped, b = ins.raise_plan(many, 10, radio=True)
    assert b <= ins.RADIO_BUDGET_BYTES_S and skipped and chosen
    assert len(ins.raise_plan(many, 50, radio=False)[0]) == len(many)


# ── the feed ──────────────────────────────────────────────────────────────

class FakeDirect:
    def __init__(self, intervals=None, script=()):
        self.sent: list[dict] = []
        self.intervals = dict(intervals or {})
        self.script = list(script)
        self._replies: list[asyncio.Queue] = []

    async def send_message(self, msg):
        f = json.loads(msg.fields_json)
        self.sent.append(f)
        if f["command"] == ts.MAV_CMD_GET_MESSAGE_INTERVAL:
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
        assert name == ""
        while True:
            for n, sysid, comp, fields in self.script:
                await asyncio.sleep(0.005)
                yield SimpleNamespace(message_name=n, system_id=sysid, component_id=comp,
                                      fields_json=json.dumps(fields))
            if not self.script:
                await asyncio.Event().wait()


class FakeMsg:
    def __init__(self, name, a, b, sysid, comp, fields_json):
        self.message_name, self.fields_json = name, fields_json


@pytest.fixture(autouse=True)
def fake_mavsdk(monkeypatch):
    monkeypatch.setitem(sys.modules, "mavsdk.mavlink_direct", SimpleNamespace(MavlinkMessage=FakeMsg))
    monkeypatch.setattr(ie, "RECHECK_S", 0.05)
    monkeypatch.setattr(ie, "EMIT_S", 0.05)


def _tel(radio=False, **kw):
    d = FakeDirect(**kw)
    return SimpleNamespace(is_connected=True, link_is_radio=radio, _target_sysid=1,
                           _drone=SimpleNamespace(mavlink_direct=d)), d


def _sets(d):
    return [(int(f["param1"]), f["param2"]) for f in d.sent if f["command"] == ts.MAV_CMD_SET_MESSAGE_INTERVAL]


SCRIPT = [("ATTITUDE", 1, 1, {"time_boot_ms": 1, "roll": float("nan"), "pitch": 0.1}),
          ("VFR_HUD", 1, 1, {"alt": 12.5})]


async def _wait(pred, n=100):
    for _ in range(n):
        await asyncio.sleep(0.02)
        if pred():
            return True
    return False


async def test_passive_feed_sends_nothing_to_the_vehicle():
    tel, d = _tel(script=SCRIPT)
    feeds = {"s": {"until": time.monotonic() + 30, "tel": tel, "open": ["ATTITUDE:1:1"],
                   "plot": [{"key": "VFR_HUD:1:1", "field": "alt"}], "fast": True}}
    packets = []

    async def emit(p):
        packets.append(p)

    # No still_may_raise: a view-only socket. `fast` asked for, never done.
    task = asyncio.create_task(ie.run_feed("s", tel, emit, feeds=feeds, rates=ts.MessageRates()))
    feeds["s"]["task"] = task
    assert await _wait(lambda: any(p.get("plot", {}).get("VFR_HUD:1:1|alt") for p in packets))
    assert d.sent == []
    for p in packets:
        json.dumps(p, allow_nan=False)
    last = [p for p in packets if p["msgs"]][-1]
    att = next(m for m in last["msgs"] if m["name"] == "ATTITUDE")
    assert att["fields"]["roll"] is None and att["fields"]["pitch"] == 0.1
    assert last["fast"]["allowed"] is False and last["fast"]["raised"] == []
    feeds.pop("s")
    await asyncio.wait_for(task, 1)


async def test_fast_raises_plotted_messages_and_restores_on_close():
    tel, d = _tel(intervals={74: 250_000}, script=SCRIPT)
    feeds = {"s": {"until": time.monotonic() + 30, "tel": tel, "open": [],
                   "plot": [{"key": "VFR_HUD:1:1", "field": "alt"}], "fast": True}}
    packets = []

    async def emit(p):
        packets.append(p)

    task = asyncio.create_task(ie.run_feed("s", tel, emit, feeds=feeds, rates=ts.MessageRates(),
                                           still_may_raise=lambda: True))
    feeds["s"]["task"] = task
    assert await _wait(lambda: (74, 20_000.0) in _sets(d))
    assert await _wait(lambda: any(p["fast"]["raised"] == ["VFR_HUD"] for p in packets))
    # Untick the plot: the rate goes back while the feed carries on.
    d.sent.clear()
    feeds["s"]["plot"] = []
    assert await _wait(lambda: _sets(d) == [(74, 250_000.0)])
    feeds["s"]["plot"] = [{"key": "VFR_HUD:1:1", "field": "alt"}]
    assert await _wait(lambda: (74, 20_000.0) in _sets(d))
    d.sent.clear()
    feeds.pop("s")
    await asyncio.wait_for(task, 1)
    assert _sets(d) == [(74, 250_000.0)]


async def test_losing_the_right_to_fly_puts_rates_back():
    tel, d = _tel(radio=True, intervals={30: 0}, script=SCRIPT)
    feeds = {"s": {"until": time.monotonic() + 30, "tel": tel, "open": [],
                   "plot": [{"key": "ATTITUDE:1:1", "field": "pitch"}], "fast": True}}
    allowed = {"v": True}
    packets = []

    async def emit(p):
        packets.append(p)

    task = asyncio.create_task(ie.run_feed("s", tel, emit, feeds=feeds, rates=ts.MessageRates(),
                                           still_may_raise=lambda: allowed["v"]))
    feeds["s"]["task"] = task
    assert await _wait(lambda: (30, 100_000.0) in _sets(d))      # radio: 10 Hz
    d.sent.clear()
    allowed["v"] = False
    assert await _wait(lambda: _sets(d) == [(30, -1.0)])
    assert await _wait(lambda: packets[-1]["fast"]["allowed"] is False and packets[-1]["fast"]["hz"] == 0)
    d.sent.clear()
    feeds.pop("s")
    await asyncio.wait_for(task, 1)
    assert _sets(d) == []                                         # not restored twice


async def test_cancelled_feed_restores_and_shares_with_tuning():
    tel, d = _tel(intervals={30: 100_000}, script=SCRIPT)
    rates = ts.MessageRates()
    await rates.acquire(tel, ("ATTITUDE",), 50)          # the Tuning chart, open
    feeds = {"x": {"until": time.monotonic() + 30, "tel": tel, "open": [],
                   "plot": [{"key": "ATTITUDE:1:1", "field": "pitch"}], "fast": True}}

    async def emit(p):
        pass

    task = asyncio.create_task(ie.run_feed("x", tel, emit, feeds=feeds, rates=rates,
                                           still_may_raise=lambda: True))
    feeds["x"]["task"] = task
    assert await _wait(lambda: rates.msgs.get("ATTITUDE", {}).get("count") == 2)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert rates.msgs["ATTITUDE"]["count"] == 1          # Tuning still holds it
    d.sent.clear()
    await rates.release(tel, ("ATTITUDE",))
    assert _sets(d) == [(30, 100_000.0)]
    assert "x" not in feeds


async def test_feed_stops_on_lease_expiry_and_link_loss():
    tel, _ = _tel()
    feeds = {"s": {"until": time.monotonic() - 1, "tel": tel}}

    async def emit(p):
        pass

    await asyncio.wait_for(ie.run_feed("s", tel, emit, feeds=feeds), 2)
    tel.is_connected = False
    feeds = {"s": {"until": time.monotonic() + 30, "tel": tel}}
    await asyncio.wait_for(ie.run_feed("s", tel, emit, feeds=feeds), 2)


async def test_drop_sid_and_request_cleaning():
    t = asyncio.create_task(asyncio.Event().wait())
    ie._feeds["gone"] = {"task": t, "until": time.monotonic() + 30}
    await ie.drop_sid("gone")
    await asyncio.gather(t, return_exceptions=True)
    assert t.cancelled() and "gone" not in ie._feeds
    await ie.drop_sid("never-was")
    req = ie._clean_request({"open": ["ATTITUDE:1:1", "../etc", 5] + [f"M{i}:1:1" for i in range(30)],
                             "plot": "nope", "fast": 1})
    assert req["open"][0] == "ATTITUDE:1:1" and len(req["open"]) == ins.MAX_OPEN
    assert req["plot"] == [] and req["fast"] is True
