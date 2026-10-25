"""One COMMAND_LONG through MAVSDK's mavlink_direct, with the vehicle's
COMMAND_ACK read back.

The Config pages send a few commands MAVSDK has no plugin for (airspeed
calibration, gripper, Spektrum bind). Fire-and-forget was fine for the
actuator test, whose result is visible on the bench, but a gripper that did
not move or a bind the receiver never entered needs the autopilot's own
answer on screen: ACCEPTED, DENIED, UNSUPPORTED... So a COMMAND_ACK reader is
opened BEFORE the command goes out (an ack that arrives first would be
missed otherwise) and the first matching ack is the answer.

IN_PROGRESS (5) is an interim answer: PX4's payload deliverer sends it for a
gripper and the final ACCEPTED once the gripper's timeout has run. With
`final=True` the reader waits past it.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger("verocore.mav_command")

#: MAV_RESULT, and what each means to a pilot.
RESULTS = {
    0: ("ACCEPTED", "accepted"),
    1: ("TEMPORARILY_REJECTED", "refused for now (busy, or armed)"),
    2: ("DENIED", "refused"),
    3: ("UNSUPPORTED", "not supported by this firmware or hardware"),
    4: ("FAILED", "accepted but it failed"),
    5: ("IN_PROGRESS", "in progress"),
    6: ("CANCELLED", "cancelled"),
}
IN_PROGRESS = 5


@dataclass
class Outcome:
    sent: bool
    #: MAV_RESULT number from the vehicle, or None when no ack came back.
    result: Optional[int] = None
    error: str = ""

    @property
    def name(self) -> Optional[str]:
        return None if self.result is None else RESULTS.get(self.result, (f"RESULT_{self.result}", ""))[0]

    @property
    def words(self) -> str:
        if not self.sent:
            return self.error or "not sent"
        if self.result is None:
            return "sent, but the drone did not acknowledge it"
        return RESULTS.get(self.result, ("", f"answered {self.result}"))[1]

    @property
    def accepted(self) -> bool:
        return self.sent and self.result == 0


def command_fields(target_sysid: int, command: int, **params: float) -> dict:
    """COMMAND_LONG fields; every param defaults to 0.0 (never NaN: the
    fields go out as JSON)."""
    out = {
        "target_system": int(target_sysid), "target_component": 1,
        "command": int(command), "confirmation": 0,
    }
    for i in range(1, 8):
        out[f"param{i}"] = float(params.get(f"param{i}", 0.0))
    return out


def _ack_of(msg, command: int) -> Optional[int]:
    try:
        f = json.loads(getattr(msg, "fields_json", "") or "{}")
    except (TypeError, ValueError):
        return None
    if not isinstance(f, dict) or int(f.get("command", -1)) != int(command):
        return None
    try:
        return int(f.get("result"))
    except (TypeError, ValueError):
        return None


async def send_command(tel, fields: dict, *, ack_timeout: float = 3.0, final: bool = False) -> Outcome:
    """Send `fields` as COMMAND_LONG and wait up to `ack_timeout` s for the
    vehicle's COMMAND_ACK. Never raises."""
    try:
        from mavsdk.mavlink_direct import MavlinkMessage
    except Exception:          # pragma: no cover - mavsdk always present in the app
        MavlinkMessage = None
    direct = getattr(getattr(tel, "_drone", None), "mavlink_direct", None)
    if direct is None:
        return Outcome(False, error="No drone connected")
    command = int(fields["command"])
    got: asyncio.Future = asyncio.get_running_loop().create_future()

    async def _listen():
        try:
            async for msg in direct.message("COMMAND_ACK"):
                r = _ack_of(msg, command)
                if r is None or (final and r == IN_PROGRESS):
                    continue
                if not got.done():
                    got.set_result(r)
                return
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.debug(f"COMMAND_ACK reader ended: {e}")

    reader = asyncio.create_task(_listen(), name=f"ack_{command}")
    try:
        await asyncio.sleep(0.05)          # let the reader subscribe first
        sysid = int(fields["target_system"])
        payload = json.dumps(fields)
        msg = (MavlinkMessage("COMMAND_LONG", 0, 0, sysid, 1, payload) if MavlinkMessage
               else ("COMMAND_LONG", payload))
        await asyncio.wait_for(direct.send_message(msg), timeout=3.0)
    except Exception as e:
        reader.cancel()
        return Outcome(False, error=f"Could not send to the drone ({e})")
    try:
        result = await asyncio.wait_for(got, timeout=ack_timeout)
        return Outcome(True, result=int(result))
    except asyncio.TimeoutError:
        return Outcome(True)
    finally:
        reader.cancel()
