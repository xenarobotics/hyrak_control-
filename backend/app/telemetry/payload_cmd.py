"""Config > Payload and Radio: gripper test and Spektrum bind.

  MAV_CMD_DO_GRIPPER (211)
      param1 gripper instance (1), param2 action: 0 release (open), 1 grab
      (close). PX4's payload_deliverer answers IN_PROGRESS, then ACCEPTED once
      PD_GRIPPER_TO has run (no feedback sensor), or FAILED when no gripper
      is configured (PD_GRIPPER_TYPE / an output set to Gripper).

  MAV_CMD_START_RX_PAIR (500)
      param1 0 = Spektrum, param2 0 DSM2, 1 DSMX, 2 DSMX8. PX4 pulses the
      receiver into bind mode (boards with SPEKTRUM_POWER only), refused while
      armed.

Both are bench actions, refused here in words unless the aircraft is
connected, disarmed, on the ground and not flown by this app (the same rule
as the actuator test, actuator_control.refusal), and only with the operator's
explicit confirmation in the payload. The vehicle's COMMAND_ACK comes back in
the result so the page shows what the autopilot said.
"""
from __future__ import annotations

import logging

from app.telemetry import actuator_control
from app.telemetry.mav_command import command_fields, send_command

logger = logging.getLogger("verocore.payload_cmd")

MAV_CMD_DO_GRIPPER = 211
MAV_CMD_START_RX_PAIR = 500

GRIPPER_ACTIONS = {"open": 0, "close": 1}
SPEKTRUM_MODES = {"dsm2": 0, "dsmx": 1, "dsmx8": 2}


def gripper_fields(target_sysid: int, action: str) -> dict:
    if action not in GRIPPER_ACTIONS:
        raise ValueError(f"Unknown gripper action {action!r}")
    return command_fields(target_sysid, MAV_CMD_DO_GRIPPER, param1=1.0, param2=float(GRIPPER_ACTIONS[action]))


def rx_pair_fields(target_sysid: int, mode: str) -> dict:
    if mode not in SPEKTRUM_MODES:
        raise ValueError(f"Unknown Spektrum mode {mode!r}")
    return command_fields(target_sysid, MAV_CMD_START_RX_PAIR, param1=0.0, param2=float(SPEKTRUM_MODES[mode]))


async def handle(tel, action: str, data: dict) -> dict:
    """drone_action entry point for gripper_test / rx_pair."""
    data = data or {}
    why = actuator_control.refusal(tel)
    if why:
        return {"action": action, "ok": False, "error": why}
    if not data.get("confirmed"):
        return {"action": action, "ok": False, "error": "Confirm first"}
    sysid = int(getattr(tel, "_target_sysid", 1) or 1)
    try:
        if action == "gripper_test":
            what = str(data.get("gripper", ""))
            fields = gripper_fields(sysid, what)
            # Long enough for PD_GRIPPER_TO (default 1 s) plus the radio.
            timeout = 2.0 + max(0.0, min(10.0, float(data.get("timeout_s", 1.0) or 1.0)))
            label = f"Gripper {what}"
        elif action == "rx_pair":
            what = str(data.get("mode", ""))
            fields = rx_pair_fields(sysid, what)
            timeout = 3.0
            label = f"Spektrum bind ({what.upper()})"
        else:
            return {"action": action, "ok": False, "error": f"Unknown action {action}"}
    except (TypeError, ValueError) as e:
        return {"action": action, "ok": False, "error": str(e)}
    out = await send_command(tel, fields, ack_timeout=timeout, final=True)
    logger.info(f"{label}: {out.name or ('no ack' if out.sent else 'not sent')}")
    if not out.sent:
        return {"action": action, "ok": False, "error": out.error}
    if out.result is not None and not out.accepted:
        return {"action": action, "ok": False, "ack": out.name,
                "error": f"{label}: the drone answered {out.name} ({out.words})"}
    return {"action": action, "ok": True, "ack": out.name,
            "msg": f"{label}: " + ("the drone accepted it" if out.accepted else out.words)}
