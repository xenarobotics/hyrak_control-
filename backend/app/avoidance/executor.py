"""Decision -> real control.

The ONLY place avoidance commands an aircraft, and it does so through the same
proven primitives the rest of the platform uses:
  hold    -> PX4 HOLD (loiter in place; the reserve-return guard uses the same
             set_flight_mode path)
  return  -> PX4 RETURN (RTL)
  reroute -> upload the detour mission + start it
  clear   -> if WE had intervened (held), resume the mission; otherwise leave
             the operator's aircraft alone

Nothing here runs unless a controller is ARMED - detection can run in advisory
mode for as long as it takes to trust it, commanding nothing. Every executed
action is idempotent-ish: re-issuing HOLD while already holding is harmless, so
the loop can call apply() every tick.
"""
from __future__ import annotations

import logging

logger = logging.getLogger("verocore.avoidance.executor")


async def apply(manager, action: str, waypoints: list | None,
                intervened: bool) -> tuple[bool, str]:
    """Apply one Decision action via `manager` (a TelemetryManager).
    `intervened` = did avoidance already take control (so `clear` should hand
    it back). Returns (did_command, note)."""
    if manager is None or not getattr(manager, "is_connected", False):
        return False, "no link"
    try:
        if action == "hold":
            ok = await manager.set_flight_mode("HOLD")
            return bool(ok), "hold"
        if action == "return":
            ok = await manager.set_flight_mode("RETURN")
            return bool(ok), "return"
        if action == "reroute":
            if not waypoints:
                return False, "no reroute waypoints"
            ok, err = await manager.upload_mission(waypoints)
            if not ok:
                return False, f"upload failed: {err}"
            await manager.start_mission()
            return True, "reroute"
        if action == "clear":
            if intervened:
                # Hand control back: resume the mission the drone was flying.
                await manager.start_mission()
                return True, "resumed"
            return False, "nominal"
    except Exception as e:
        logger.warning(f"Avoidance executor {action} failed: {e}")
        return False, f"error: {e}"
    return False, "noop"
