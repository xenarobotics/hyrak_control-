"""Shared test harness for the avoidance tests: constants, synthetic scenes,
a synthetic depth camera, and kinematic PX4 stand-ins for closed-loop runs."""
import math
from app.avoidance.core.controller import AvoidanceController, AvoidanceState
import numpy as np
from app.avoidance.mapping import pose_history
from app.avoidance.sensing.depth_scan import ScanBin, scan_from_depth, vfov_for
from app.avoidance.mapping.occupancy import OccupancyGrid


LAT0, LNG0 = 17.596569, 78.125203

HFOV, RANGE = 73.0, 19.1

def _one_hit(bearing=0.0, rng=10.0):
    return [ScanBin(bearing_deg=bearing, half_width_deg=1.0, hit_m=rng, free_m=rng)]

def _ground_and_wall(rows, cols, hfov, vfov, alt, wall_x=None, pitch_deg=0.0):
    """Z-depth image for a camera on an aircraft pitched by pitch_deg over flat
    ground, optionally with a 2 m wide wall of unlimited height at wall_x."""
    th, tv = math.tan(math.radians(hfov / 2)), math.tan(math.radians(vfov / 2))
    z = np.full((rows, cols), np.inf)
    p = math.radians(pitch_deg)
    for r in range(rows):
        for c in range(cols):
            u = ((c + .5) / cols * 2 - 1) * th
            v = ((r + .5) / rows * 2 - 1) * tv
            xl = math.cos(p) + v * math.sin(p)
            zl = -math.sin(p) + v * math.cos(p)
            best = alt / zl if zl > 1e-4 else np.inf
            if wall_x is not None and xl > 0:
                t = wall_x / xl
                if abs(u * t) < 1.0 and t < best:
                    best = t
            z[r, c] = best
    return z

def _polar_with(obstacles, pos=(0.0, 0.0), radius=18.0):
    g = OccupancyGrid()
    for n, e, r in obstacles:
        g.pin_disc(n, e, r)
    return g.polar(pos[0], pos[1], radius, 5.0)

def _controller(pos_ne=(0.0, 0.0), yaw=0.0, alt=10.0, t=None):
    c = AvoidanceController("sup"); c.set_enabled(True)
    h = pose_history.history("sup")
    h.origin = (LAT0, LNG0)
    lat, lng = h.to_latlng(*pos_ne)
    h.add(lat, lng, alt, yaw, t=t)
    return c, h

def _synthetic_scan(pos, yaw_deg, cylinders):
    """Ray-cast a 73 deg / 19.1 m depth camera against vertical cylinders."""
    out = []
    for b in np.arange(-HFOV / 2 + 1.0, HFOV / 2, 2.0):
        a = math.radians(yaw_deg + b)
        dn, de = math.cos(a), math.sin(a)
        best = None
        for cn, ce, r in cylinders:
            fn, fe = pos[0] - cn, pos[1] - ce
            B = fn * dn + fe * de
            C = fn * fn + fe * fe - r * r
            disc = B * B - C
            if disc >= 0:
                t = -B - math.sqrt(disc)
                if 0.2 < t < RANGE and (best is None or t < best):
                    best = t
        out.append(ScanBin(bearing_deg=float(b), half_width_deg=1.0, hit_m=best,
                           free_m=best if best is not None else RANGE, top_m=20.0 if best else 0.0))
    return out

def _fly(cylinders, goal=(80.0, 0.0), cruise=3.0, max_t=90.0, dt=0.1):
    """PX4 stand-in: MISSION flies straight at the goal at cruise; OFFBOARD
    tracks the setpoint with a 0.4 s lag and a 90 deg/s yaw limit."""
    c = AvoidanceController("loop"); c.set_enabled(True); c.set_armed(True)
    c.params.speed_cap_m_s = cruise
    h = pose_history.history("loop"); h.origin = (LAT0, LNG0)
    pos, vel, yaw, t = [0.0, 0.0], [0.0, 0.0], 0.0, 1000.0
    mode, min_clear, events = "MISSION", math.inf, []
    while t < 1000.0 + max_t:
        lat, lng = h.to_latlng(*pos)
        h.add(lat, lng, 10.0, yaw, t=t)
        c.integrate_scan(_synthetic_scan(pos, yaw, cylinders), t, "depth")
        d = c.decide_local(goal, 10.0, now=t)
        if d.action == "avoid":
            mode, want = "OFFBOARD", (d.setpoint.vn, d.setpoint.ve)
            dy = (d.setpoint.yaw_deg - yaw + 180) % 360 - 180
            yaw = (yaw + max(-9.0, min(9.0, dy))) % 360
        elif d.action == "hold":
            mode, want = "HOLD", (0.0, 0.0)
        elif d.action == "resume":
            mode = "MISSION"
        if d.action in ("avoid", "hold", "resume", "return") and (not events or events[-1] != d.action):
            events.append(d.action)
        if mode == "MISSION":
            dn, de = goal[0] - pos[0], goal[1] - pos[1]
            dist = math.hypot(dn, de)
            if dist < 1.0:
                return {"reached": True, "min_clear": min_clear, "t": t - 1000.0, "events": events}
            want = (cruise * dn / dist, cruise * de / dist)
            dy = (math.degrees(math.atan2(de, dn)) - yaw + 180) % 360 - 180
            yaw = (yaw + max(-9.0, min(9.0, dy))) % 360
        a = dt / 0.4
        vel = [vel[0] + (want[0] - vel[0]) * a, vel[1] + (want[1] - vel[1]) * a]
        pos = [pos[0] + vel[0] * dt, pos[1] + vel[1] * dt]
        for cn, ce, r in cylinders:
            min_clear = min(min_clear, math.hypot(pos[0] - cn, pos[1] - ce) - r)
        t += dt
    return {"reached": False, "min_clear": min_clear, "t": max_t, "events": events}

def _moving(vn, ve, t0=100.0, n=8, alt=10.0):
    c = AvoidanceController("mv"); c.set_enabled(True)
    h = pose_history.history("mv"); h.origin = (LAT0, LNG0)
    for k in range(n):
        lat, lng = h.to_latlng(vn * k * 0.1, ve * k * 0.1)
        h.add(lat, lng, alt, 180.0 if vn < 0 else 0.0, t=t0 + k * 0.1)
    return c, h

def _fly_route(route, cylinders, cruise=3.0, max_t=240.0, dt=0.1, accept=2.0):
    """Multi-waypoint PX4 stand-in: MISSION flies to route[i] and moves on
    within `accept` m (PX4 NAV_ACC_RAD); a 'resume' with advance=True moves
    it on as PX4's set_current_mission_item(i+1) would."""
    c = AvoidanceController("route"); c.set_enabled(True); c.set_armed(True)
    c.params.speed_cap_m_s = cruise
    h = pose_history.history("route"); h.origin = (LAT0, LNG0)
    pos, vel, yaw, t, i = [0.0, 0.0], [0.0, 0.0], 0.0, 5000.0, 0
    mode, min_clear, takeovers = "MISSION", math.inf, [0] * len(route)
    prev = None
    while t < 5000.0 + max_t:
        lat, lng = h.to_latlng(*pos)
        h.add(lat, lng, 10.0, yaw, t=t)
        c.integrate_scan(_synthetic_scan(pos, yaw, cylinders), t, "depth")
        d = c.decide_local(route[i], 10.0, now=t)
        if d.action == "avoid":
            if prev != "avoid":
                takeovers[i] += 1
            mode, want = "OFFBOARD", (d.setpoint.vn, d.setpoint.ve)
            dy = (d.setpoint.yaw_deg - yaw + 180) % 360 - 180
            yaw = (yaw + max(-9.0, min(9.0, dy))) % 360
        elif d.action == "hold":
            mode, want = "HOLD", (0.0, 0.0)
        elif d.action == "resume":
            mode = "MISSION"
            if getattr(d, "advance", False) and i < len(route) - 1:
                i += 1
            elif getattr(d, "advance", False):
                return {"done": True, "min_clear": min_clear, "takeovers": takeovers, "t": t - 5000.0}
        prev = d.action
        if mode == "MISSION":
            dn, de = route[i][0] - pos[0], route[i][1] - pos[1]
            dist = math.hypot(dn, de)
            if dist < accept:
                if i == len(route) - 1:
                    return {"done": True, "min_clear": min_clear, "takeovers": takeovers, "t": t - 5000.0}
                i += 1
                continue
            want = (cruise * dn / dist, cruise * de / dist)
            dy = (math.degrees(math.atan2(de, dn)) - yaw + 180) % 360 - 180
            yaw = (yaw + max(-9.0, min(9.0, dy))) % 360
        a = dt / 0.4
        vel = [vel[0] + (want[0] - vel[0]) * a, vel[1] + (want[1] - vel[1]) * a]
        pos = [pos[0] + vel[0] * dt, pos[1] + vel[1] * dt]
        for cn, ce, r in cylinders:
            min_clear = min(min_clear, math.hypot(pos[0] - cn, pos[1] - ce) - r)
        t += dt
    return {"done": False, "min_clear": min_clear, "takeovers": takeovers, "t": max_t}
