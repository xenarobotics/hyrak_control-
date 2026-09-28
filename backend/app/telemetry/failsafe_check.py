"""Pre-flight check of PX4's link-loss failsafes for cloud-companion flight.

In HYRAK the cloud IS the companion computer: missions, AI follow and
avoidance command the aircraft over the telemetry + internet link, often in
Offboard. PX4's own failsafes decide what the aircraft does in the seconds a
link is gone, so they are checked before every arm/takeoff/mission start:

  BLOCK (arming refused) - settings that make a link loss dangerous:
    NAV_DLL_ACT   = 0 (no action when the ground station is lost),
                    5/6 (terminate / lockdown: drops or freezes the aircraft)
    COM_OBL_RC_ACT= 6/7 (terminate / disarm when Offboard is lost)
  WARN (arming allowed, operator told) - workable but worth knowing:
    COM_DL_LOSS_T outside 3-30 s, COM_OF_LOSS_T below 0.5 s (cloud jitter
    would trip it) or above 5 s, RTL_RETURN_ALT below the mission's highest
    waypoint.

Pure evaluation (evaluate) is separate from reading the parameters
(read_params) so the rules are testable without an aircraft.
"""
from __future__ import annotations

import asyncio
import logging
import time

logger = logging.getLogger("verocore.failsafe_check")

PARAMS = {                       # name -> MAVSDK param type
    "NAV_DLL_ACT": "int",
    "COM_DL_LOSS_T": "int",
    "COM_OBL_RC_ACT": "int",
    "COM_OF_LOSS_T": "float",
    "RTL_RETURN_ALT": "float",
}
NAV_DLL = {0: "disabled", 1: "Hold", 2: "Return", 3: "Land", 5: "Terminate", 6: "Lockdown"}
OBL = {0: "Position", 1: "Altitude", 2: "Manual", 3: "Return", 4: "Land", 5: "Hold",
       6: "Terminate", 7: "Disarm"}
CACHE_S = 120.0

_cache: dict[int, tuple[float, dict]] = {}     # id(manager) -> (when, params)


def evaluate(p: dict, mission_max_alt_m: float | None = None,
             gps_denied: bool = False) -> tuple[list[str], list[str]]:
    """(blocking problems, warnings) for a parameter dict. Missing values are
    reported as warnings - an unreadable parameter is not proof of danger.
    gps_denied: indoors / no GPS - PX4 cannot fly a Return without a global
    position, so a Return failsafe there degrades to whatever PX4 falls back
    to; say so and suggest Land or Hold."""
    block, warn = [], []
    dll = p.get("NAV_DLL_ACT")
    if dll is None:
        warn.append("could not read NAV_DLL_ACT (ground-station-loss action)")
    elif int(dll) == 0:
        block.append("NAV_DLL_ACT = 0: the aircraft does NOTHING if the cloud link is lost. "
                     "Set 1 (Hold) or 2 (Return).")
    elif int(dll) in (5, 6):
        block.append(f"NAV_DLL_ACT = {int(dll)} ({NAV_DLL[int(dll)]}): a link loss would "
                     f"{'cut the motors' if int(dll) == 5 else 'freeze the aircraft'}. Set 1 (Hold) or 2 (Return).")
    obl = p.get("COM_OBL_RC_ACT")
    if obl is None:
        warn.append("could not read COM_OBL_RC_ACT (Offboard-loss action)")
    elif int(obl) in (6, 7):
        block.append(f"COM_OBL_RC_ACT = {int(obl)} ({OBL[int(obl)]}): losing cloud Offboard control "
                     f"would {'cut the motors' if int(obl) == 6 else 'disarm in the air'}. Set 5 (Hold).")
    if gps_denied:
        if dll is not None and int(dll) == 2:
            warn.append("indoors / no GPS: NAV_DLL_ACT = 2 (Return) needs a global position PX4 does not "
                        "have here - set 3 (Land) or 1 (Hold) for indoor flight")
        if obl is not None and int(obl) == 3:
            warn.append("indoors / no GPS: COM_OBL_RC_ACT = 3 (Return) - set 5 (Hold) or 4 (Land)")
    t = p.get("COM_DL_LOSS_T")
    if t is not None and not (3 <= float(t) <= 30):
        warn.append(f"COM_DL_LOSS_T = {float(t):g} s: link-loss reaction outside 3-30 s")
    of = p.get("COM_OF_LOSS_T")
    if of is not None:
        if float(of) < 0.5:
            warn.append(f"COM_OF_LOSS_T = {float(of):g} s: tighter than internet jitter; cloud Offboard may trip it")
        elif float(of) > 5.0:
            warn.append(f"COM_OF_LOSS_T = {float(of):g} s: the aircraft keeps a stale Offboard command that long")
    rtl = p.get("RTL_RETURN_ALT")
    if rtl is not None and mission_max_alt_m is not None and float(rtl) + 0.5 < mission_max_alt_m:
        warn.append(f"RTL_RETURN_ALT = {float(rtl):g} m is below this mission's highest waypoint "
                    f"({mission_max_alt_m:g} m): a link-loss return could fly lower than the route")
    return block, warn


async def read_params(manager, force: bool = False) -> dict:
    """The failsafe parameters, cached per link for CACHE_S (they do not change
    mid-flight unless someone edits them, and reading costs a round trip each)."""
    key = id(manager)
    hit = _cache.get(key)
    if hit and not force and time.monotonic() - hit[0] < CACHE_S:
        return hit[1]
    out: dict = {}

    async def one(name, kind):
        try:
            v = await manager.get_param(name, kind)
            if v is not None:
                out[name] = v
        except Exception:
            pass
    try:
        await asyncio.wait_for(asyncio.gather(*(one(n, k) for n, k in PARAMS.items())), timeout=6.0)
    except asyncio.TimeoutError:
        pass
    if out:
        _cache[key] = (time.monotonic(), out)
    return out


def mission_max_alt(waypoints) -> float | None:
    alts = []
    for w in waypoints or []:
        for k in ("altitude", "alt", "relative_altitude_m"):
            if isinstance(w, dict) and w.get(k) is not None:
                try:
                    alts.append(float(w[k]))
                except (TypeError, ValueError):
                    pass
                break
    return max(alts) if alts else None


def mission_min_alt(waypoints) -> float | None:
    """Lowest altitude among a mission's waypoints (takeoff/land items skipped)."""
    alts = []
    for w in waypoints or []:
        if not isinstance(w, dict) or w.get("type") in ("takeoff", "land", "rtl"):
            continue
        for k in ("altitude", "alt", "relative_altitude_m"):
            if w.get(k) is not None:
                try:
                    alts.append(float(w[k]))
                except (TypeError, ValueError):
                    pass
                break
    return min(alts) if alts else None
