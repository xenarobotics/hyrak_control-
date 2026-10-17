"""Telemetry stream lifecycle (audit 2026-10-17, B1 / B11 / B23 / B29).

- every subscription restarts after a stream error instead of ending for the
  rest of the flight (B11), and the link watch counts only real
  position/attitude arrivals, never the cached flight_mode stream;
- fleet managers subscribe in_air (B1) and nobody subscribes wind (B29);
- COMMAND_LONG is addressed to the sysid read off the vehicle's HEARTBEAT,
  with 1 as the fallback (B23).
"""
import asyncio
import json
import time
import types

import pytest

from app.telemetry.manager import TelemetryManager


class _Att:
    roll_deg = 1.0
    pitch_deg = 2.0
    yaw_deg = 90.0


def _forever():
    async def gen():
        await asyncio.Event().wait()
        yield None   # pragma: no cover - never reached
    return gen()


class _FakePlugin:
    """Any set_rate_* is an async no-op that records the request; any other
    attribute is a stream that never yields (a healthy, quiet link)."""

    def __init__(self):
        self.rates: dict[str, float] = {}

    def __getattr__(self, name):
        if name.startswith("set_rate_"):
            async def setter(hz):
                self.rates[name] = hz
            return setter
        return lambda *a, **k: _forever()


def _fake_drone():
    d = types.SimpleNamespace()
    d.telemetry = _FakePlugin()
    d.mission = _FakePlugin()
    d.mavlink_direct = _FakePlugin()
    return d


# --------------------------------------------------------------------------- #
# B11: a stream that dies is restarted                                         #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_a_subscription_restarts_after_a_stream_error():
    """One gRPC hiccup on the position stream used to freeze the map for the
    rest of the flight while link_ok stayed true (attitude kept arriving)."""
    m = TelemetryManager(on_update=lambda d: None)
    m._SUBSCRIBE_RETRY_S = 0.01
    m._running = m._connected = True
    calls = []

    def attitude_euler():
        calls.append(1)

        async def gen():
            if len(calls) == 1:
                raise RuntimeError("gRPC UNAVAILABLE")
            yield _Att()
            await asyncio.Event().wait()
        return gen()

    m._drone = types.SimpleNamespace(telemetry=types.SimpleNamespace(attitude_euler=attitude_euler))
    task = asyncio.create_task(m._subscribe_attitude())
    try:
        await asyncio.sleep(0.15)
        assert len(calls) >= 2, "the subscription was not retried"
        assert m._snapshot.attitude.yaw_deg == 90.0, "the retried stream's data never landed"
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_a_stream_that_ends_on_its_own_is_reopened():
    m = TelemetryManager(on_update=lambda d: None)
    m._SUBSCRIBE_RETRY_S = 0.01
    m._running = m._connected = True
    opened = []

    def position():
        opened.append(1)

        async def gen():
            if False:
                yield None
        return gen()

    m._drone = types.SimpleNamespace(telemetry=types.SimpleNamespace(position=position))
    task = asyncio.create_task(m._subscribe_position())
    try:
        await asyncio.sleep(0.1)
        assert len(opened) >= 2
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_retry_stops_when_the_manager_stops():
    m = TelemetryManager(on_update=lambda d: None)
    m._SUBSCRIBE_RETRY_S = 0.01
    m._running = m._connected = True

    def battery():
        async def gen():
            raise RuntimeError("down")
            yield None   # pragma: no cover
        return gen()

    m._drone = types.SimpleNamespace(telemetry=types.SimpleNamespace(battery=battery))
    task = asyncio.create_task(m._subscribe_battery())
    await asyncio.sleep(0.03)
    m._running = False
    await asyncio.wait_for(task, timeout=1.0)   # returns on its own, no cancel needed


@pytest.mark.asyncio
async def test_retry_backs_off_and_caps():
    m = TelemetryManager(on_update=lambda d: None)
    m._SUBSCRIBE_RETRY_S = 0.01
    m._SUBSCRIBE_RETRY_MAX_S = 0.04
    m._running = m._connected = True
    stamps = []

    def gps_info():
        stamps.append(time.monotonic())

        async def gen():
            raise RuntimeError("down")
            yield None   # pragma: no cover
        return gen()

    m._drone = types.SimpleNamespace(telemetry=types.SimpleNamespace(gps_info=gps_info))
    task = asyncio.create_task(m._subscribe_gps())
    try:
        await asyncio.sleep(0.3)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    gaps = [b - a for a, b in zip(stamps, stamps[1:])]
    assert len(gaps) >= 4
    assert gaps[1] > gaps[0] * 1.5, "no backoff between retries"
    assert max(gaps) < 0.04 + 0.05, "backoff did not cap"


# --------------------------------------------------------------------------- #
# Link watch counts position/attitude, not the cached flight_mode stream       #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_flight_mode_arrivals_do_not_count_as_link_life():
    m = TelemetryManager(on_update=lambda d: None)
    m._running = m._connected = True
    m._last_rx_t = 0.0

    def flight_mode():
        async def gen():
            yield "FlightMode.HOLD"
            await asyncio.Event().wait()
        return gen()

    m._drone = types.SimpleNamespace(telemetry=types.SimpleNamespace(flight_mode=flight_mode))
    task = asyncio.create_task(m._subscribe_flight_mode())
    try:
        await asyncio.sleep(0.05)
        assert m._snapshot.flight_mode.mode == "HOLD"
        assert m._last_rx_t == 0.0, "flight_mode moved the link-life stamp"
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    m._count("position")
    assert m._last_rx_t > 0.0


# --------------------------------------------------------------------------- #
# B1 / B29: which streams each profile opens                                   #
# --------------------------------------------------------------------------- #

async def _started(fleet_mode: bool) -> tuple[TelemetryManager, set[str]]:
    m = TelemetryManager(on_update=lambda d: None, fleet_mode=fleet_mode)
    m._drone = _fake_drone()
    m._connected = True
    await m.start()
    names = {t.get_name() for t in m._tasks}
    return m, names


@pytest.mark.asyncio
async def test_fleet_profile_subscribes_in_air_and_asks_for_its_rate():
    """Without in_air every fleet snapshot said 'landed': the dispatcher
    advanced orders mid-flight and the reserve RETURN never fired."""
    m, names = await _started(fleet_mode=True)
    try:
        assert "fleet_inair" in names
        assert "set_rate_in_air" in m._drone.telemetry.rates
        assert m._drone.telemetry.rates["set_rate_in_air"] >= 0.5
    finally:
        await m.stop(kill_stale=False)


@pytest.mark.asyncio
async def test_no_profile_opens_the_wind_stream():
    """fixedwing_metrics() was subscribed only to write zeros."""
    for fleet in (True, False):
        m, names = await _started(fleet_mode=fleet)
        try:
            assert not any("wind" in n for n in names), names
            assert not hasattr(m, "_subscribe_wind")
        finally:
            await m.stop(kill_stale=False)


@pytest.mark.asyncio
async def test_both_profiles_learn_the_vehicle_sysid():
    for fleet in (True, False):
        m, names = await _started(fleet_mode=fleet)
        try:
            assert any(n.endswith("_sysid") for n in names), names
        finally:
            await m.stop(kill_stale=False)


# --------------------------------------------------------------------------- #
# B23: COMMAND_LONG goes to the vehicle's real sysid                            #
# --------------------------------------------------------------------------- #

def _hb(system_id, component_id):
    return types.SimpleNamespace(message_name="HEARTBEAT", system_id=system_id,
                                 component_id=component_id, target_system_id=0,
                                 target_component_id=0, fields_json="{}")


@pytest.mark.asyncio
async def test_sysid_is_read_from_the_autopilot_heartbeat_only():
    """Our own heartbeats, QGC's and another ground station's pass through the
    same stream; only the autopilot component (1) names the vehicle."""
    m = TelemetryManager(on_update=lambda d: None, sysid=245)
    m._running = m._connected = True

    def message(name):
        assert name == "HEARTBEAT"

        async def gen():
            yield _hb(245, 190)   # us
            yield _hb(255, 190)   # QGC
            yield _hb(7, 1)       # the vehicle
            yield _hb(9, 1)       # a second vehicle on the link: first wins
        return gen()

    m._drone = types.SimpleNamespace(mavlink_direct=types.SimpleNamespace(message=message))
    await asyncio.wait_for(m._learn_target_sysid(), timeout=1.0)
    assert m._target_sysid == 7 and m._target_sysid_learned


def test_sysid_defaults_to_px4s_one_before_any_heartbeat():
    assert TelemetryManager(on_update=lambda d: None)._target_sysid == 1
    assert TelemetryManager.__new__(TelemetryManager)._target_sysid == 1


@pytest.mark.asyncio
async def test_do_set_mode_is_addressed_to_the_learned_sysid():
    m = TelemetryManager(on_update=lambda d: None)
    m._running = m._connected = True
    m._target_sysid = 7
    sent = []

    async def send_message(msg):
        sent.append(msg)

    m._drone = types.SimpleNamespace(mavlink_direct=types.SimpleNamespace(send_message=send_message))
    assert await m._send_px4_mode("HOLD") is True
    msg = sent[0]
    assert msg.target_system_id == 7
    assert json.loads(msg.fields_json)["target_system"] == 7


@pytest.mark.asyncio
async def test_direct_takeoff_is_addressed_to_the_learned_sysid():
    m = TelemetryManager(on_update=lambda d: None)
    m._running = m._connected = True
    m._target_sysid = 42
    m._snapshot.position.latitude_deg = 17.6
    m._snapshot.position.longitude_deg = 78.1
    m._snapshot.position.absolute_altitude_m = 500.0
    sent = []

    async def send_message(msg):
        sent.append(msg)
        m._snapshot.flight_mode.is_in_air = True   # it lifted off

    m._drone = types.SimpleNamespace(mavlink_direct=types.SimpleNamespace(send_message=send_message))
    assert await m._takeoff_with_altitude_in_the_command(10.0) is True
    assert sent[0].target_system_id == 42
    assert json.loads(sent[0].fields_json)["target_system"] == 42
