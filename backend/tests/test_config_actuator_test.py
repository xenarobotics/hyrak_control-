"""Config > Actuators: actuator test / configure commands (app/telemetry/actuator_test.py)."""
import asyncio
import json
import math
from types import SimpleNamespace

import pytest

from app.telemetry import actuator_test as at
from app.telemetry import failsafe_check as fs


def _tel(armed=False, in_air=False, connected=True, offboard=False):
    sent = []

    class _Direct:
        async def send_message(self, msg):
            sent.append(msg)

    tel = SimpleNamespace(
        is_connected=connected,
        snapshot=SimpleNamespace(flight_mode=SimpleNamespace(is_armed=armed, is_in_air=in_air)),
        _offboard_active=offboard,
        _target_sysid=1,
        _drone=SimpleNamespace(mavlink_direct=_Direct()),
    )
    return tel, sent


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_function_mapping():
    assert at.mavlink_function(101) == 1
    assert at.mavlink_function(112) == 12
    assert at.mavlink_function(201) == 33
    assert at.mavlink_function(208) == 40
    for bad in (0, 1, 2, 100, 113, 200, 209, 400, 2000):
        assert at.mavlink_function(bad) is None


def test_motor_value_clamped_and_timeout_leashed():
    f = at.test_fields(1, 103, 1.7, 30.0)
    assert f["command"] == 310 and f["param5"] == 3.0
    assert f["param1"] == 1.0
    assert f["param2"] == at.MAX_TIMEOUT_S
    assert at.test_fields(1, 101, -0.5, 1.0)["param1"] == 0.0     # motors never below 0 when running


def test_servo_range_and_stop():
    assert at.test_fields(1, 202, -3, 1.0)["param1"] == -1.0
    stop_m = at.test_fields(1, 101, None, 1.0)
    assert stop_m["param1"] < 0 and stop_m["param2"] <= 0.1          # below 0 = stopped
    stop_s = at.test_fields(1, 201, None, 1.0)
    assert stop_s["param1"] == 0.0 and stop_s["param2"] <= 0.1


def test_rejects_non_actuators_and_non_finite():
    with pytest.raises(ValueError):
        at.test_fields(1, 400, 0.1, 1.0)
    with pytest.raises(ValueError):
        at.test_fields(1, 101, math.nan, 1.0)
    with pytest.raises(ValueError):
        at.test_fields(1, 101, 0.1, 0)
    with pytest.raises(ValueError):
        at.configure_fields(1, 201, "beep")
    with pytest.raises(ValueError):
        at.configure_fields(1, 101, "reverse_everything")


def test_handle_refuses_armed_in_air_offboard_and_no_link():
    for kw, word in ((dict(armed=True), "Disarm"), (dict(in_air=True), "air"),
                     (dict(offboard=True), "Offboard"), (dict(connected=False), "No drone")):
        tel, sent = _tel(**kw)
        r = run(at.handle(tel, "actuator_test", {"function": 101, "value": 0.1, "timeout_s": 1}))
        assert r["ok"] is False and word in r["error"]
        assert sent == []


def test_handle_lets_stop_through_even_when_armed():
    tel, sent = _tel(armed=True)
    r = run(at.handle(tel, "actuator_test", {"function": 101, "value": None}))
    assert r["ok"] is True and len(sent) == 1


def test_handle_sends_command_long(monkeypatch):
    import sys
    calls = []

    class FakeMsg:
        def __init__(self, name, a, b, sysid, comp, fields):
            calls.append((name, sysid, json.loads(fields)))

    monkeypatch.setitem(sys.modules, "mavsdk.mavlink_direct", SimpleNamespace(MavlinkMessage=FakeMsg))
    tel, sent = _tel()
    r = run(at.handle(tel, "actuator_test", {"function": 102, "value": 0.08, "timeout_s": 1}))
    assert r["ok"] is True
    name, sysid, fields = calls[0]
    assert name == "COMMAND_LONG" and fields["command"] == 310 and fields["param5"] == 2.0
    assert abs(fields["param1"] - 0.08) < 1e-9
    r = run(at.handle(tel, "configure_actuator", {"function": 101, "config": "spin_direction_2"}))
    assert r["ok"] is True and calls[-1][2]["command"] == 311 and calls[-1][2]["param1"] == 5.0


def test_esc_calibration_needs_props_confirmation_and_ground():
    tel, sent = _tel()
    r = run(at.handle(tel, "esc_calibration", {}))
    assert r["ok"] is False and "propellers" in r["error"] and sent == []
    tel, sent = _tel(armed=True)
    r = run(at.handle(tel, "esc_calibration", {"props_removed": True}))
    assert r["ok"] is False and sent == []
    f = at.esc_calibration_fields(1)
    assert f["command"] == 241 and f["param7"] == 1.0


def test_failsafe_cache_forget():
    class M:  # weakref-able stand-in for a TelemetryManager
        pass
    m = M()
    fs._cache[m] = (0.0, {"NAV_DLL_ACT": 2})
    fs.forget(m)
    assert m not in fs._cache
    fs.forget(object())   # not weakref-able / not cached: no error


def test_shell_clean_command():
    from app.events.shell_events import clean_command, MAX_CMD
    assert clean_command("ver all") == "ver all"
    assert clean_command("top\nreboot") == "top"           # one line only
    assert clean_command("ls\x1b[2J /fs") == "ls[2J /fs"    # control bytes dropped
    assert clean_command(42) is None
    assert clean_command("x" * (MAX_CMD + 1)) is None


def test_shell_classify():
    from app.events.shell_events import classify
    for c in ["ver all", "top", "listener vehicle_status", "param show MPC_XY_VEL_MAX", "commander status",
              "ekf2 status", "sensors status", "dshot status", "ls /fs/microsd", ""]:
        assert classify(c) == "read", c
    for c in ["param set MPC_XY_VEL_MAX 20", "reboot", "logger off"]:
        assert classify(c) == "write", c
    for c in ["commander arm", "commander takeoff", "motor_test test -m 1 -p 20", "actuator_test set -m 1 -v 0.2",
              "ver; commander arm", "ver && commander arm", "ver | sh", "ls > /x", "/bin/commander arm", "/fs/microsd/x/ver", "./ver", "VER",
              "sh /fs/microsd/x", "source /x", "pwm test -c 1 -p 1500", "dshot beep1 -m 1", "ekf2 stop",
              "mavlink stop", "rm /fs/microsd/x", "rm status", "cat `x`", "ver $(x)", "param show *",
              "ekf2 status extra", "control_allocator stop", "navigator fencefile"]:
        assert classify(c) == "never", c
