"""Actuator testing and ESC configuration for Config > Actuators.

The same MAVLink commands QGroundControl's Actuators page sends (PX4 1.14+):

  MAV_CMD_ACTUATOR_TEST (310)
      param1 value: motors 0..1 (0 = minimum spin), servos -1..1.
             For a motor anything below 0 maps to "stopped".
      param2 timeout, seconds. PX4 returns the output to its disarmed value
             when it runs out, so a browser that closes, a socket that drops
             or a server that restarts can never leave a motor running: the
             page has to keep re-sending to keep it turning.
      param5 output function: MAVLink ACTUATOR_OUTPUT_FUNCTION
             (MOTOR1 = 1 .. MOTOR16 = 16, SERVO1 = 33 .. SERVO16 = 48).

  MAV_CMD_CONFIGURE_ACTUATOR (311)
      param1 ACTUATOR_CONFIGURATION: 1 beep, 4 spin direction 1,
             5 spin direction 2 (DShot ESCs).
      param5 output function, as above.

Every request is refused here, in words, before it goes anywhere when the
aircraft is armed, in the air, or being flown by this app: PX4 refuses an
armed actuator test too, but its refusal arrives as a bare COMMAND_ACK the
page cannot see, and "nothing happened" is the wrong answer to a motor test.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math

logger = logging.getLogger("verocore.actuator_test")

MAV_CMD_ACTUATOR_TEST = 310
MAV_CMD_CONFIGURE_ACTUATOR = 311

# PX4 output function numbers (what PWM_MAIN_FUNCn holds) for the ones that
# can be tested.
PX4_MOTOR_FIRST, PX4_MOTOR_LAST = 101, 112
PX4_SERVO_FIRST, PX4_SERVO_LAST = 201, 208

# MAVLink ACTUATOR_OUTPUT_FUNCTION
MAV_MOTOR1 = 1
MAV_SERVO1 = 33

MAX_TIMEOUT_S = 2.0      # the page keeps it alive at ~3 Hz; 2 s is the leash
CONFIGS = {"beep": 1, "spin_direction_1": 4, "spin_direction_2": 5}


def mavlink_function(px4_function: int) -> int | None:
    """PX4 output function -> MAVLink ACTUATOR_OUTPUT_FUNCTION, or None if it
    is not a motor or servo (those are the only ones PX4 tests)."""
    f = int(px4_function)
    if PX4_MOTOR_FIRST <= f <= PX4_MOTOR_LAST:
        return MAV_MOTOR1 + (f - PX4_MOTOR_FIRST)
    if PX4_SERVO_FIRST <= f <= PX4_SERVO_LAST:
        return MAV_SERVO1 + (f - PX4_SERVO_FIRST)
    return None


def is_motor(px4_function: int) -> bool:
    return PX4_MOTOR_FIRST <= int(px4_function) <= PX4_MOTOR_LAST


def refusal(tel) -> str | None:
    """Why no actuator may move now, or None."""
    if tel is None or not getattr(tel, "is_connected", False):
        return "No drone connected"
    snap = getattr(tel, "snapshot", None)
    fm = getattr(snap, "flight_mode", None)
    if fm is not None and getattr(fm, "is_armed", False):
        return "Disarm first. Actuator testing only runs on a disarmed aircraft"
    if fm is not None and getattr(fm, "is_in_air", False):
        return "The aircraft is in the air"
    if getattr(tel, "_offboard_active", False):
        return "This app is flying the aircraft (Offboard). Stop that first"
    return None


def test_fields(target_sysid: int, px4_function: int, value: float | None, timeout_s: float) -> dict:
    """COMMAND_LONG fields for one actuator test. value None = stop.
    Raises ValueError for anything that must not be sent."""
    mf = mavlink_function(px4_function)
    if mf is None:
        raise ValueError(f"Output function {px4_function} is not a motor or servo")
    motor = is_motor(px4_function)
    if value is None:
        # Stop: a motor below 0 is "stopped"; a servo goes back to its
        # disarmed value when this short timeout runs out.
        v, t = (-1.0, 0.1) if motor else (0.0, 0.1)
    else:
        v = float(value)
        if not math.isfinite(v):
            raise ValueError("Value must be a number")
        v = max(0.0, min(1.0, v)) if motor else max(-1.0, min(1.0, v))
        t = float(timeout_s)
        if not math.isfinite(t) or t <= 0:
            raise ValueError("Timeout must be above 0 s")
        t = min(t, MAX_TIMEOUT_S)
    return {
        "target_system": int(target_sysid), "target_component": 1,
        "command": MAV_CMD_ACTUATOR_TEST, "confirmation": 0,
        "param1": v, "param2": t, "param3": 0.0, "param4": 0.0,
        "param5": float(mf), "param6": 0.0, "param7": 0.0,
    }


def configure_fields(target_sysid: int, px4_function: int, config: str) -> dict:
    if config not in CONFIGS:
        raise ValueError(f"Unknown actuator configuration {config!r}")
    if not is_motor(px4_function):
        raise ValueError("Only motors (DShot ESCs) take this configuration")
    return {
        "target_system": int(target_sysid), "target_component": 1,
        "command": MAV_CMD_CONFIGURE_ACTUATOR, "confirmation": 0,
        "param1": float(CONFIGS[config]), "param2": 0.0, "param3": 0.0, "param4": 0.0,
        "param5": float(mavlink_function(px4_function)), "param6": 0.0, "param7": 0.0,
    }


MAV_CMD_PREFLIGHT_CALIBRATION = 241


def esc_calibration_fields(target_sysid: int) -> dict:
    """PREFLIGHT_CALIBRATION with param7 = 1: PX4's ESC PWM range
    calibration. PX4 then asks (STATUSTEXT, "[cal] ...") for the battery to
    be connected, sends every motor output its maximum and then its minimum,
    and reports done or failed the same way."""
    return {
        "target_system": int(target_sysid), "target_component": 1,
        "command": MAV_CMD_PREFLIGHT_CALIBRATION, "confirmation": 0,
        "param1": 0.0, "param2": 0.0, "param3": 0.0, "param4": 0.0,
        "param5": 0.0, "param6": 0.0, "param7": 1.0,
    }


async def _send(tel, fields: dict) -> None:
    from mavsdk.mavlink_direct import MavlinkMessage
    sysid = int(fields["target_system"])
    await asyncio.wait_for(
        tel._drone.mavlink_direct.send_message(
            MavlinkMessage("COMMAND_LONG", 0, 0, sysid, 1, json.dumps(fields))
        ),
        timeout=3.0,
    )


async def handle(tel, action: str, data: dict) -> dict:
    """drone_action entry point for actuator_test / configure_actuator /
    esc_calibration."""
    data = data or {}
    if action == "esc_calibration":
        why = refusal(tel)
        if why:
            return {"action": action, "ok": False, "error": why}
        if not data.get("props_removed"):
            return {"action": action, "ok": False,
                    "error": "Confirm the propellers are removed first"}
        try:
            await _send(tel, esc_calibration_fields(int(getattr(tel, "_target_sysid", 1) or 1)))
        except Exception as e:
            return {"action": action, "ok": False, "error": f"Could not send to the drone ({e})"}
        return {"action": action, "ok": True}
    stop = action == "actuator_test" and data.get("value") is None
    # A stop is always let through while the link is up, armed or not:
    # refusing "stop" is never the safe answer.
    why = None if (stop and tel is not None and getattr(tel, "is_connected", False)) else refusal(tel)
    if why:
        return {"action": action, "ok": False, "error": why}
    try:
        fn = int(data.get("function", 0))
        sysid = int(getattr(tel, "_target_sysid", 1) or 1)
        if action == "actuator_test":
            fields = test_fields(sysid, fn, data.get("value"), float(data.get("timeout_s", 1.0)))
        else:
            fields = configure_fields(sysid, fn, str(data.get("config", "")))
    except (TypeError, ValueError) as e:
        return {"action": action, "ok": False, "error": str(e)}
    try:
        await _send(tel, fields)
    except Exception as e:
        logger.warning(f"{action} f{fields.get('param5')} failed: {e}")
        return {"action": action, "ok": False, "error": f"Could not send to the drone ({e})"}
    return {"action": action, "ok": True, "function": fn}
