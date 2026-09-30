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
import math

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
            snap = getattr(manager, "_snapshot", None)
            fm = getattr(snap, "flight_mode", None)
            if intervened and str(getattr(fm, "mode", "")).upper() in ("RETURN", "RETURN_TO_LAUNCH", "RTL"):
                return False, "already returning"
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


async def apply_local(manager, controller, decision, mission_index: int) -> tuple[bool, str]:
    """Apply a local-planner supervisor Decision (params.local_planner = 1).

      avoid  - Offboard: enter it once, then stream the planner's NED velocity
               + heading every tick (10 Hz). No mission upload, ever.
      hold   - HOLD mode (brake), leaving Offboard as our own mode change.
      resume - back to the mission at the waypoint it was flying to.
      return - RTL.
      clear  - nothing: PX4 (or the pilot) is flying.
    """
    if manager is None or not getattr(manager, "is_connected", False):
        return False, "no link"
    action = decision.action
    mode = str(getattr(getattr(getattr(manager, "_snapshot", None), "flight_mode", None), "mode", "") or "")
    try:
        if action == "avoid":
            sp = decision.setpoint
            if sp is None:
                return False, "no setpoint"
            # Independent sanity clamp on every setpoint: finite, within the
            # speed cap and a modest vertical rate, whatever the planner did.
            cap = float(getattr(controller.params, "speed_cap_m_s", 4.0))
            vals = (sp.vn, sp.ve, sp.vd, sp.yaw_deg)
            if not all(math.isfinite(v) for v in vals):
                return False, "setpoint not finite"
            h = math.hypot(sp.vn, sp.ve)
            if h > cap:
                sp.vn, sp.ve = sp.vn * cap / h, sp.ve * cap / h
            sp.vd = max(-1.5, min(1.5, sp.vd))
            # Entered once. Not re-checked against the reported mode: that comes
            # from a 1 Hz heartbeat and lags the switch, and a departure we did
            # not ask for is the pilot latch's job, not a reason to re-enter.
            if not getattr(manager, "_offboard_active", False):
                if not await manager.start_offboard():
                    # Refused (pilot latch) or failed: fall back to a brake.
                    ok = await manager.set_flight_mode("HOLD")
                    controller.intervened = bool(ok) or controller.intervened
                    return bool(ok), "offboard refused - holding"
                # Who opened it: the loop's stand-down keys on this, so a
                # lost decision (ours, orphaned) is told apart from a
                # tracker's session (theirs, leave alone).
                manager._offboard_owner = "avoidance"
            await manager.send_velocity_ned(sp.vn, sp.ve, sp.vd, sp.yaw_deg)
            controller.intervened = True
            return True, "avoid"
        if action == "hold":
            if controller.intervened and mode == "HOLD":
                return False, "already holding"
            # We are leaving Offboard on purpose: say so BEFORE the mode
            # change, or the departure detector (2 s window vs a 4 s mode
            # confirm on a radio link) latches a phantom "pilot has control".
            manager.release_offboard_state()
            ok = await manager.set_flight_mode("HOLD")
            if ok:
                controller.intervened = True
            return bool(ok), "hold"
        if action == "return":
            if mode.upper() in ("RETURN", "RETURN_TO_LAUNCH", "RTL"):
                return False, "already returning"
            manager.release_offboard_state()
            ok = await manager.set_flight_mode("RETURN")
            return bool(ok), "return"
        if action == "resume":
            ok = await manager.resume_mission_from_offboard(mission_index)
            if ok:
                controller.intervened = False
            return bool(ok), "resumed"
        return False, "nominal"
    except Exception as e:
        logger.warning(f"Avoidance local executor {action} failed: {e}")
        return False, f"error: {e}"
