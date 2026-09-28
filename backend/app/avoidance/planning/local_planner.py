"""Local planner - layer 3 of the avoidance redesign (step C).

A pure function run at 10 Hz while avoidance has the aircraft in Offboard:
occupancy around the drone in, one velocity + yaw setpoint out. It replaces
"upload a detour mission and restart it" (1-2 s per decision, legs
restarted, the aircraft still flying the old leg meanwhile) with continuous
steering.

Method, VFH-style on the grid's polar histogram:
  1. Every obstacle sector is ENLARGED by the angle the clearance subtends at
     its range (asin(clearance / d)), so a direction counts as free only if
     the whole body plus margin fits past everything.
  2. Candidate headings every sector; a candidate needs enough free distance
     to stop inside it at the speed it would be flown (v^2 / 2a + margin).
  3. Cost = deviation from the goal bearing, plus smaller terms for turning
     away from the current heading and from the previous choice (stops
     dithering between two gaps).
  4. Speed from free distance (can always stop in time), from time-to-
     collision along the CURRENT velocity (brake below ttc_brake_s), and from
     heading alignment: the camera looks forward, so the aircraft turns to
     face a new direction before it moves into it - it never flies sideways
     into space it has not seen.
  5. Altitude held at the goal altitude by a clamped P term.
Nothing here touches an aircraft; the supervisor applies the setpoint.
"""
from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass
class PlannerParams:
    cruise_m_s: float = 3.0         # speed while dodging (capped further for mono)
    clearance_m: float = 3.0        # body + margin kept from every occupied cell
    lookahead_m: float = 18.0       # histogram radius / "free enough" horizon
    decel_m_s2: float = 2.0         # braking the planner assumes it can do
    min_free_m: float = 4.0         # least room a chosen direction must have (room-sized indoors)
    ttc_brake_s: float = 2.0        # closing on something faster than this: brake
    ttc_slow_s: float = 4.0         # below this, speed scales down with TTC
    sensor_half_fov_deg: float = 35.0   # forward camera; outside it space is unseen
    sector_deg: float = 5.0
    w_goal: float = 1.0
    w_heading: float = 0.35
    w_prev: float = 0.25
    # A direction that is only free for a short way costs up to this many
    # degrees of goal deviation: steer early around what is ahead instead of
    # flying at it until there is barely room to stop (the late-turn failure).
    w_short_deg: float = 90.0
    alt_kp: float = 0.6
    max_vz_m_s: float = 1.0


@dataclass
class Setpoint:
    vn: float
    ve: float
    vd: float
    yaw_deg: float
    speed: float
    chosen_deg: float | None
    free_m: float
    ttc_s: float | None
    blocked: bool
    reason: str


def _adiff(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


def enlarged_free(polar: list[float], sector_deg: float, clearance_m: float) -> list[float]:
    """Free travel distance per sector once every obstacle is grown by the
    clearance. polar: nearest occupied range per world sector (inf = none)."""
    n = len(polar)
    free = [math.inf] * n
    for s, d in enumerate(polar):
        if not math.isfinite(d):
            continue
        if d <= clearance_m:
            span = 90.0                       # inside the margin: everything towards it is blocked
        else:
            span = math.degrees(math.asin(min(1.0, clearance_m / d)))
        reach = int(math.ceil(span / sector_deg))
        travel = max(0.0, d - clearance_m)
        for k in range(-reach, reach + 1):
            j = (s + k) % n
            if travel < free[j]:
                free[j] = travel
    return free


def ttc_along(polar: list[float], sector_deg: float, vn: float, ve: float,
              body_half_width_m: float = 1.0) -> float | None:
    """Time to collision along the current ground velocity: nearest occupied
    range in the sectors the aircraft's swept width covers, over speed."""
    speed = math.hypot(vn, ve)
    if speed < 0.3:
        return None
    brg = math.degrees(math.atan2(ve, vn)) % 360.0
    n = len(polar)
    best = math.inf
    for s, d in enumerate(polar):
        if not math.isfinite(d):
            continue
        centre = (s + 0.5) * sector_deg
        half = math.degrees(math.atan2(body_half_width_m, max(d, 0.5)))
        if _adiff(centre, brg) <= half + sector_deg / 2.0:
            best = min(best, d)
    return best / speed if math.isfinite(best) else None


def plan(pos_ne: tuple[float, float], alt_m: float, yaw_deg: float,
         vel_ne: tuple[float, float], goal_ne: tuple[float, float], goal_alt_m: float,
         polar: list[float], p: PlannerParams, prev_deg: float | None = None) -> Setpoint:
    n_sec = len(polar)
    sd = p.sector_deg
    dn, de = goal_ne[0] - pos_ne[0], goal_ne[1] - pos_ne[1]
    dist_goal = math.hypot(dn, de)
    goal_brg = math.degrees(math.atan2(de, dn)) % 360.0
    free = enlarged_free(polar, sd, p.clearance_m)
    ttc = ttc_along(polar, sd, vel_ne[0], vel_ne[1], body_half_width_m=p.clearance_m * 0.5)

    vd = max(-p.max_vz_m_s, min(p.max_vz_m_s, p.alt_kp * (alt_m - goal_alt_m)))

    # Free distance needed in a direction to fly it at cruise and still stop.
    stop_m = p.cruise_m_s ** 2 / (2.0 * p.decel_m_s2) + 1.0
    need = min(max(stop_m, p.min_free_m), max(1.0, dist_goal))

    horizon = max(need, min(p.lookahead_m, dist_goal))
    best, best_cost = None, math.inf
    for s in range(n_sec):
        centre = (s + 0.5) * sd
        f = free[s]
        if f < need:
            continue
        cost = p.w_goal * _adiff(centre, goal_brg) + p.w_heading * _adiff(centre, yaw_deg)
        cost += p.w_short_deg * max(0.0, 1.0 - f / horizon)
        if prev_deg is not None:
            cost += p.w_prev * _adiff(centre, prev_deg)
        if cost < best_cost:
            best, best_cost = s, cost
    if best is None:
        # Nothing has room to stop in at cruise: take the most open direction
        # if it has any room at all, slowly; otherwise brake.
        s = max(range(n_sec), key=lambda k: free[k])
        if free[s] < 1.5:
            return Setpoint(0.0, 0.0, vd, yaw_deg, 0.0, None, free[s], ttc, True,
                            "boxed in - braking")
        best = s
    chosen = (best + 0.5) * sd
    f = free[best]

    speed = min(p.cruise_m_s, math.sqrt(max(0.0, 2.0 * p.decel_m_s2 * max(0.0, f - 1.0))))
    reason = "clear toward goal" if _adiff(chosen, goal_brg) < sd else "steering around obstacle"
    if ttc is not None and ttc < p.ttc_slow_s:
        speed *= max(0.0, (ttc - p.ttc_brake_s) / (p.ttc_slow_s - p.ttc_brake_s))
        reason = f"TTC {ttc:.1f}s - slowing"
    if ttc is not None and ttc < p.ttc_brake_s:
        # Closing too fast on something ahead of the current motion. Unless
        # the chosen direction already points away from it, stop first.
        vel_brg = math.degrees(math.atan2(vel_ne[1], vel_ne[0])) % 360.0
        if _adiff(chosen, vel_brg) < 90.0:
            return Setpoint(0.0, 0.0, vd, chosen, 0.0, chosen, f, ttc, False,
                            f"TTC {ttc:.1f}s - braking")
    # Face the direction before moving into it (the camera sees forward only).
    err = _adiff(chosen, yaw_deg)
    if err >= p.sensor_half_fov_deg:
        speed = 0.0
        reason = "turning to look before moving"
    else:
        speed *= math.cos(math.radians(err))
    # Arrive at the waypoint, do not overshoot it.
    # Arrive, do not overshoot: the braking curve alone still allowed ~2.8 m/s
    # at 2 m, and with the vehicle's velocity lag that carried it past the
    # waypoint into a turn-around orbit. Proportional in the last metres.
    speed = min(speed, math.sqrt(2.0 * p.decel_m_s2 * dist_goal), max(0.5, 0.8 * dist_goal))
    rad = math.radians(chosen)
    return Setpoint(speed * math.cos(rad), speed * math.sin(rad), vd, chosen, speed,
                    chosen, f, ttc, False, reason)


def direct_path_clear(polar: list[float], p: PlannerParams, pos_ne, goal_ne) -> bool:
    """Is the straight line to the goal free (with clearance) out to the goal
    or the lookahead? The supervisor hands the aircraft back to its mission
    only when this has held for a while."""
    dn, de = goal_ne[0] - pos_ne[0], goal_ne[1] - pos_ne[1]
    dist = math.hypot(dn, de)
    brg = math.degrees(math.atan2(de, dn)) % 360.0
    free = enlarged_free(polar, p.sector_deg, p.clearance_m)
    s = int(brg // p.sector_deg) % len(polar)
    return free[s] >= min(dist, p.lookahead_m)
