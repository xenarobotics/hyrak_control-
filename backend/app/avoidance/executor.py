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
            # Already parked by us: sending HOLD again every tick only spams
            # PX4 with mode commands ("ack for not-existing command" storm).
            snap = getattr(manager, "_snapshot", None)
            fm = getattr(snap, "flight_mode", None)
            if intervened and getattr(fm, "mode", "") == "HOLD":
                return False, "already holding"
            ok = await manager.set_flight_mode("HOLD")
            return bool(ok), "hold"
        if action == "return":
            ok = await manager.set_flight_mode("RETURN")
            return bool(ok), "return"
        if action in ("reroute", "climb"):
            # A climb-over is a reroute whose waypoints carry a raised
            # altitude - same upload+start path, the aircraft climbs as it
            # flies the new leg.
            if not waypoints:
                return False, f"no {action} waypoints"
            ok, err = await manager.upload_mission(waypoints)
            if not ok:
                return False, f"upload failed: {err}"
            await manager.start_mission()
            return True, action
        if action == "track":
            # Receding horizon: the committed detour is already uploaded and
            # flying - nothing to send, just let it continue.
            return False, "tracking"
        if action == "clear":
            if intervened:
                # Only resume if WE parked it in HOLD. If avoidance rerouted, the
                # detour mission already ends at the goal and the aircraft is
                # flying it - calling start_mission() here restarts from waypoint
                # 0, sending it back to the start over and over (the forward-back
                # oscillation that never reaches the destination). Let it run.
                snap = getattr(manager, "_snapshot", None)
                fm = getattr(snap, "flight_mode", None)
                cur = getattr(fm, "mode", "") if fm else ""
                if cur == "HOLD":
                    await manager.start_mission()
                    return True, "resumed"
                return False, "detour continuing to goal"
            return False, "nominal"
    except Exception as e:
        logger.warning(f"Avoidance executor {action} failed: {e}")
        return False, f"error: {e}"
    return False, "noop"
