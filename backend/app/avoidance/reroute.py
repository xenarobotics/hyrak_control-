"""Airspace-aware reroute around a keep-out.

Thin bridge onto the existing planner. Because a dynamic obstacle paints into
the SAME cost field as the red/orange zones, a reroute that dodges the
obstacle already respects every airspace rule for free - and "there is no way
around within the rules" is simply the planner returning ok:False, which the
state machine turns into HOLD -> RETURN.
"""
from __future__ import annotations

import asyncio
import math

M_PER_DEG_LAT = 111_320.0

# A detour is a LOCAL maneuver, so it is planned over a bounded window ahead,
# not all the way to a distant goal. This keeps the planner's auto-sized grid
# fine (metres, not tens of metres) where the obstacle actually is - a
# km-scale grid rasterises a few-metre keep-out so coarsely that its inflation
# can engulf the drone's own position. Past the window we aim at a rejoin
# point on the original bearing; the mission's remaining legs continue from
# there.
LOCAL_WINDOW_M = 150.0


def _point_along(start: tuple[float, float], goal: tuple[float, float],
                 dist_m: float) -> tuple[float, float]:
    m_lng = M_PER_DEG_LAT * max(0.2, math.cos(math.radians(start[0])))
    north_m = (goal[0] - start[0]) * M_PER_DEG_LAT
    east_m = (goal[1] - start[1]) * m_lng
    total = math.hypot(north_m, east_m)
    if total < 1e-6:
        return goal
    f = dist_m / total
    return (start[0] + (goal[0] - start[0]) * f,
            start[1] + (goal[1] - start[1]) * f)


async def reroute_around(start: tuple[float, float],
                         goal: tuple[float, float],
                         obstacles: list[dict],
                         profile_rules: dict | None = None,
                         cruise_alt_m: float = 10.0,
                         speed_m_s: float = 4.0) -> tuple[list[dict] | None, str]:
    """Plan a LOCAL detour from `start` past `obstacles` (each
    {lat,lng,radius_m}), rejoining the original bearing, honouring every
    airspace rule. Returns (waypoints, "") on success, or (None, reason) when
    no legal way around exists. Runs the CPU-bound planner off the loop."""
    from app.planner import engine as planner_engine

    m_lng = M_PER_DEG_LAT * max(0.2, math.cos(math.radians(start[0])))
    dist = math.hypot((goal[0] - start[0]) * M_PER_DEG_LAT,
                      (goal[1] - start[1]) * m_lng)
    rejoin = goal if dist <= LOCAL_WINDOW_M else _point_along(
        start, goal, LOCAL_WINDOW_M)

    result = await asyncio.to_thread(
        planner_engine.plan, start, rejoin,
        rules=profile_rules, cruise_alt_m=cruise_alt_m,
        speed_m_s=speed_m_s, land=False, obstacles=obstacles,
    )
    if result.get("ok"):
        return result.get("waypoints") or [], ""
    return None, result.get("reason", "no legal path around the obstacle")
