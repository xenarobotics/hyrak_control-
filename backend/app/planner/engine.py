"""
The mission path engine: cost-field A* between two points.

How a plan happens:

 1. A planning window (bounding box around start/goal plus margin) is
    rasterised into a grid of cost multipliers. Base cost is 1.0 per metre.
    Red zones are impassable, always - no profile can argue with them.
    Orange zones and map-feature categories adjust the multiplier per the
    active route profile (prefer < 1, avoid > 1, block = impassable).
 2. A* (8-connected, corner-cut safe) finds the cheapest path through the
    field. "Cheapest" is metres x multiplier, so preferring roads at 0.45
    literally means one metre over a road costs 0.45 straight-line metres -
    the planner will fly up to ~2.2x extra distance to stay on one.
 3. The cell path is smoothed by cost-aware shortcutting: a straight cut is
    taken only when its integrated field cost is no worse than the path it
    replaces. A plain line-of-sight smoother would happily cut across a
    penalised hostel; this one cannot.
 4. The polyline becomes upload-ready waypoints ({lat, lng, altitude,
    speed, hold_time, type, yaw}) with takeoff/land bookends, plus an
    honest coverage report (metres over each category / zone class).

Everything is metric internally (equirectangular metres about the window
centre - fine at mission scale, wrong for continent scale, which the span
cap already forbids).
"""
import heapq
import logging
import math

import numpy as np
import shapely
from shapely.geometry import Point

from app.planner import features as feature_engine
from app.planner import profiles as profile_mod
from app.zones import engine as zone_engine

logger = logging.getLogger("verocore.planner.engine")

M_PER_DEG_LAT = 111_320.0

MAX_SPAN_M = 20_000.0      # refuse to plan across more than 20 km
MIN_CELL_M = 4.0
MAX_CELL_M = 40.0
TARGET_CELLS = 220         # along the window's longer side
MAX_WAYPOINTS = 60
CLIMB_M_S, DESCEND_M_S = 2.5, 1.5

_SQRT2 = math.sqrt(2.0)


class _Field:
    """The rasterised cost field plus the geo transform to and from it."""

    def __init__(self, lat0, lng0, lat1, lng1, cell_m):
        self.cell_m = cell_m
        self.lat0, self.lng0 = lat0, lng0
        self.m_lat = M_PER_DEG_LAT
        self.m_lng = M_PER_DEG_LAT * max(0.2, math.cos(math.radians((lat0 + lat1) / 2)))
        self.rows = max(2, int(math.ceil((lat1 - lat0) * self.m_lat / cell_m)) + 1)
        self.cols = max(2, int(math.ceil((lng1 - lng0) * self.m_lng / cell_m)) + 1)
        # Cost multiplier per cell; np.inf = impassable. Two block strengths:
        # hard (red zones - never relaxed) and soft (a profile's "block"
        # rules - relaxed around start/goal so a drone can leave home even
        # when home sits inside a blocked category).
        self.mult = np.ones((self.rows, self.cols), dtype=np.float64)
        self.hard = np.zeros((self.rows, self.cols), dtype=bool)

    def to_cell(self, lat, lng) -> tuple[int, int]:
        r = int(round((lat - self.lat0) * self.m_lat / self.cell_m))
        c = int(round((lng - self.lng0) * self.m_lng / self.cell_m))
        return (min(max(r, 0), self.rows - 1), min(max(c, 0), self.cols - 1))

    def to_latlng(self, r, c) -> tuple[float, float]:
        return (self.lat0 + r * self.cell_m / self.m_lat,
                self.lng0 + c * self.cell_m / self.m_lng)

    def paint(self, geom, factor=None, block=False, hard=False):
        """Apply one geometry to the field: multiply the multiplier of every
        covered cell by `factor`, or mark the cells impassable."""
        minx, miny, maxx, maxy = geom.bounds  # lng/lat order
        r0, c0 = self.to_cell(miny, minx)
        r1, c1 = self.to_cell(maxy, maxx)
        if r1 < r0 or c1 < c0:
            return
        rr = np.arange(r0, r1 + 1)
        cc = np.arange(c0, c1 + 1)
        lats = self.lat0 + rr * self.cell_m / self.m_lat
        lngs = self.lng0 + cc * self.cell_m / self.m_lng
        gl, gt = np.meshgrid(lngs, lats)          # x=lng, y=lat
        shapely.prepare(geom)
        inside = shapely.contains_xy(geom, gl, gt)
        sub = self.mult[r0:r1 + 1, c0:c1 + 1]
        if block:
            sub[inside] = np.inf
            if hard:
                hs = self.hard[r0:r1 + 1, c0:c1 + 1]
                hs[inside] = True
                self.hard[r0:r1 + 1, c0:c1 + 1] = hs
        else:
            sub[inside] *= factor
        self.mult[r0:r1 + 1, c0:c1 + 1] = sub

    def relax_soft_blocks_near(self, rc: tuple[int, int], radius_cells: int,
                               penalty: float) -> None:
        """Turn soft-blocked cells around a point back into (heavily
        penalised) passable ones. Hard blocks stay impassable."""
        r0 = max(0, rc[0] - radius_cells)
        r1 = min(self.rows - 1, rc[0] + radius_cells)
        c0 = max(0, rc[1] - radius_cells)
        c1 = min(self.cols - 1, rc[1] + radius_cells)
        sub = self.mult[r0:r1 + 1, c0:c1 + 1]
        soft = ~np.isfinite(sub) & ~self.hard[r0:r1 + 1, c0:c1 + 1]
        sub[soft] = penalty
        self.mult[r0:r1 + 1, c0:c1 + 1] = sub


def _build_field(start, goal, rules, cruise_alt_m,
                 obstacles=None) -> tuple[_Field | None, str]:
    """Rasterise zones + features into a cost field. Returns (field, error).

    `obstacles` (optional) are dynamic keep-outs the avoidance layer injects -
    each `{lat, lng, radius_m}`. They paint as HARD blocks exactly like a red
    zone, so a reroute around a detected obstacle automatically also respects
    every airspace rule already in the field, and "no way around within the
    rules" falls out as plan() returning ok:False (the caller then holds or
    returns). A dynamic obstacle is never relaxed near start/goal."""
    lat0, lat1 = sorted((start[0], goal[0]))
    lng0, lng1 = sorted((start[1], goal[1]))
    m_lng = M_PER_DEG_LAT * max(0.2, math.cos(math.radians((lat0 + lat1) / 2)))
    span_m = math.hypot((lat1 - lat0) * M_PER_DEG_LAT, (lng1 - lng0) * m_lng)
    if span_m > MAX_SPAN_M:
        return None, f"Start and goal are {span_m/1000:.1f} km apart (limit {MAX_SPAN_M/1000:.0f} km)"

    margin_m = max(250.0, span_m * 0.35)
    lat0 -= margin_m / M_PER_DEG_LAT
    lat1 += margin_m / M_PER_DEG_LAT
    lng0 -= margin_m / m_lng
    lng1 += margin_m / m_lng

    long_side = max((lat1 - lat0) * M_PER_DEG_LAT, (lng1 - lng0) * m_lng)
    cell_m = min(MAX_CELL_M, max(MIN_CELL_M, long_side / TARGET_CELLS))
    field = _Field(lat0, lng0, lat1, lng1, cell_m)

    # Blocked geometry is inflated by the grid diagonal plus a margin
    # before painting: the grid tests cell CENTRES, and smoothing +
    # decimation can shave up to a cell off a corner - without inflation a
    # "legal" path can clip tens of metres into a no-fly zone. Penalised /
    # preferred areas stay un-inflated; being a few metres off there only
    # costs pennies, not safety.
    inflate_deg = (field.cell_m * 1.7 + 2.0) / field.m_lng

    # Zones first: legality beats preference, and painting red last would
    # let a later feature factor multiply an inf harmlessly anyway - order
    # is for readability, the math is safe either way.
    orange = rules["orange"]
    for z in zone_engine.snapshot():
        if z["floor_m"] and cruise_alt_m < z["floor_m"]:
            continue
        if z["ceiling_m"] is not None and cruise_alt_m > z["ceiling_m"]:
            continue
        if z["zone_class"] == "red":
            field.paint(z["geom"].buffer(inflate_deg), block=True, hard=True)
        elif z["zone_class"] == "orange":
            if orange["policy"] == "block":
                field.paint(z["geom"].buffer(inflate_deg), block=True)
            elif orange["policy"] == "penalize":
                field.paint(z["geom"], factor=float(orange.get("weight", 4.0)))

    # Features: one paint per feature. Overlapping same-category features
    # would double-apply a factor, so paint the union per category.
    cats = rules["categories"]
    if cats:
        by_cat: dict[str, list] = {}
        for f in feature_engine.snapshot():
            if f["category"] in cats:
                by_cat.setdefault(f["category"], []).append(f["geom"])
        for cat, geoms in by_cat.items():
            rule = cats[cat]
            geom = shapely.union_all(geoms) if len(geoms) > 1 else geoms[0]
            if rule["mode"] == "block":
                field.paint(geom.buffer(inflate_deg), block=True)
            else:
                field.paint(geom, factor=float(rule["weight"]))

    # Dynamic obstacles last: hard blocks, radius in metres converted to a
    # degree buffer using the LOCAL lng scaling so the keep-out is at least
    # radius_m in every direction (N-S ends up slightly larger - safe). Plus
    # the same cell-inflation red zones get, so a smoothed path cannot clip it.
    for ob in (obstacles or []):
        try:
            lat, lng = float(ob["lat"]), float(ob["lng"])
            radius_m = max(0.5, float(ob.get("radius_m", 2.0)))
        except (KeyError, TypeError, ValueError):
            continue
        m_lng_local = M_PER_DEG_LAT * max(0.2, math.cos(math.radians(lat)))
        # A dynamic obstacle already carries its safety clearance in radius_m,
        # so it needs only a HALF-CELL rasterisation margin - NOT the full
        # zone-grade inflation (cell*1.7+2). At coarse cell sizes that big
        # inflation balloons a close obstacle's keep-out until it swallows the
        # drone's own position, leaving A* with a blocked start and no path.
        radius_deg = (radius_m + field.cell_m * 0.5) / m_lng_local
        field.paint(shapely.Point(lng, lat).buffer(radius_deg),
                    block=True, hard=True)

    return field, ""


def _astar(field: _Field, start_rc, goal_rc) -> list[tuple[int, int]] | None:
    """8-connected A* over the multiplier grid. Step cost = metres x mean of
    the two cells' multipliers; heuristic = octile metres x the grid's best
    multiplier (admissible by construction)."""
    mult = field.mult
    rows, cols = field.rows, field.cols
    finite = mult[np.isfinite(mult)]
    hmul = float(finite.min()) if finite.size else 1.0
    cell = field.cell_m

    def h(r, c):
        dr, dc = abs(r - goal_rc[0]), abs(c - goal_rc[1])
        return (max(dr, dc) + (_SQRT2 - 1) * min(dr, dc)) * cell * hmul

    g = np.full((rows, cols), np.inf)
    came: dict[tuple[int, int], tuple[int, int]] = {}
    g[start_rc] = 0.0
    open_q = [(h(*start_rc), start_rc)]
    steps = ((-1, -1, _SQRT2), (-1, 0, 1.0), (-1, 1, _SQRT2), (0, -1, 1.0),
             (0, 1, 1.0), (1, -1, _SQRT2), (1, 0, 1.0), (1, 1, _SQRT2))

    while open_q:
        f, (r, c) = heapq.heappop(open_q)
        if (r, c) == goal_rc:
            path = [(r, c)]
            while (r, c) in came:
                r, c = came[(r, c)]
                path.append((r, c))
            return path[::-1]
        if f > g[r, c] + h(r, c) + 1e-9:
            continue  # stale entry
        m_here = mult[r, c]
        for dr, dc, dl in steps:
            nr, nc = r + dr, c + dc
            if not (0 <= nr < rows and 0 <= nc < cols):
                continue
            m_next = mult[nr, nc]
            if not np.isfinite(m_next):
                continue
            # No corner cutting: a diagonal move needs both orthogonal
            # neighbours open, or the path clips a blocked cell's corner.
            if dr and dc and (not np.isfinite(mult[r, nc]) or not np.isfinite(mult[nr, c])):
                continue
            ng = g[r, c] + dl * cell * (m_here + m_next) / 2.0
            if ng < g[nr, nc] - 1e-9:
                g[nr, nc] = ng
                came[(nr, nc)] = (r, c)
                heapq.heappush(open_q, (ng + h(nr, nc), (nr, nc)))
    return None


def _seg_cost(field: _Field, a_rc, b_rc) -> float:
    """Integrated field cost of the straight segment between two cells,
    sampled at half-cell steps. inf if it grazes anything impassable."""
    (r0, c0), (r1, c1) = a_rc, b_rc
    dist = math.hypot(r1 - r0, c1 - c0) * field.cell_m
    n = max(2, int(math.hypot(r1 - r0, c1 - c0) * 2))
    total, prev_m = 0.0, None
    for i in range(n + 1):
        t = i / n
        r = int(round(r0 + (r1 - r0) * t))
        c = int(round(c0 + (c1 - c0) * t))
        m = field.mult[r, c]
        if not np.isfinite(m):
            return math.inf
        if prev_m is not None:
            total += (dist / n) * (prev_m + m) / 2.0
        prev_m = m
    return total


def _smooth(field: _Field, path: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Cost-aware string pulling: shortcut only where the straight segment's
    integrated cost is no worse than the cell path it replaces (small slack
    for sampling noise). This is what keeps a smoothed route from slicing
    across a penalised area the A* correctly went around."""
    if len(path) <= 2:
        return path
    # Cumulative cost along the raw path, segment by segment.
    cum = [0.0]
    for i in range(1, len(path)):
        cum.append(cum[-1] + _seg_cost(field, path[i - 1], path[i]))
    out = [path[0]]
    i = 0
    while i < len(path) - 1:
        j = len(path) - 1
        while j > i + 1:
            cut = _seg_cost(field, path[i], path[j])
            if math.isfinite(cut) and cut <= (cum[j] - cum[i]) * 1.02 + field.cell_m * 0.5:
                break
            j -= 1
        out.append(path[j])
        i = j
    return out


def _decimate(pts: list[tuple[float, float]], tol_m: float, m_lat: float,
              m_lng: float) -> list[tuple[float, float]]:
    """Douglas-Peucker in metres - caps waypoint count for the FC."""
    if len(pts) <= 2:
        return pts

    def perp(p, a, b):
        ax, ay = (a[1] - p[1]) * m_lng, (a[0] - p[0]) * m_lat
        bx, by = (b[1] - a[1]) * m_lng, (b[0] - a[0]) * m_lat
        L = math.hypot(bx, by)
        if L < 1e-9:
            return math.hypot(ax, ay)
        return abs(bx * ay - by * ax) / L

    def rdp(seg):
        if len(seg) <= 2:
            return seg
        dmax, idx = 0.0, 0
        for k in range(1, len(seg) - 1):
            d = perp(seg[k], seg[0], seg[-1])
            if d > dmax:
                dmax, idx = d, k
        if dmax <= tol_m:
            return [seg[0], seg[-1]]
        return rdp(seg[:idx + 1])[:-1] + rdp(seg[idx:])

    return rdp(pts)


def _coverage(pts: list[tuple[float, float]], step_m: float) -> dict:
    """Metres of the final route over each feature category and zone class -
    the honest 'was the preference actually honoured' number."""
    meters: dict[str, float] = {}
    zone_meters = {"green": 0.0, "orange": 0.0, "red": 0.0}
    total = 0.0
    m_lat = M_PER_DEG_LAT
    for a, b in zip(pts, pts[1:]):
        m_lng = M_PER_DEG_LAT * max(0.2, math.cos(math.radians(a[0])))
        seg = math.hypot((b[0] - a[0]) * m_lat, (b[1] - a[1]) * m_lng)
        n = max(1, int(seg / step_m))
        for i in range(n):
            t = (i + 0.5) / n
            lat = a[0] + (b[0] - a[0]) * t
            lng = a[1] + (b[1] - a[1]) * t
            d = seg / n
            total += d
            for cat in feature_engine.categories_at(lat, lng):
                meters[cat] = meters.get(cat, 0.0) + d
            zone_meters[zone_engine.check_point(lat, lng)["zone_class"]] += d
    return {
        "total_m": round(total, 1),
        "categories_m": {k: round(v, 1) for k, v in sorted(meters.items())},
        "zones_m": {k: round(v, 1) for k, v in zone_meters.items() if v > 0},
    }


def plan(start: tuple[float, float], goal: tuple[float, float],
         rules: dict | None = None, cruise_alt_m: float = 60.0,
         speed_m_s: float = 8.0, land: bool = True,
         obstacles: list[dict] | None = None) -> dict:
    """
    Generate a route from start to goal (both (lat, lng)).

    `obstacles` are optional dynamic keep-outs (`{lat, lng, radius_m}`) the
    avoidance layer injects to reroute around a detected obstacle while still
    honouring every airspace rule; ok:False means no legal way around.

    Returns on success:
        {ok: True, waypoints: [...], distance_m, est_duration_s,
         zones: [...crossed...], coverage: {...}, report: {...}}
    and on failure:
        {ok: False, reason: str, blocking_zones: [...]}   (zones only when
        the start/goal themselves sit inside a red zone)
    """
    rules = profile_mod.resolved_rules(rules)
    field, err = _build_field(start, goal, rules, cruise_alt_m, obstacles)
    if field is None:
        return {"ok": False, "reason": err, "blocking_zones": []}

    for name, (lat, lng) in (("Start", start), ("Goal", goal)):
        hit = zone_engine.check_point(lat, lng, cruise_alt_m)
        if hit["zone_class"] == "red":
            return {
                "ok": False,
                "reason": f"{name} point is inside a no-fly zone: "
                          + ", ".join(z["name"] for z in hit["zones"]),
                "blocking_zones": hit["zones"],
            }

    s_rc = field.to_cell(*start)
    g_rc = field.to_cell(*goal)
    # Launch and landing must be reachable even when a preference rule
    # blocks their whole neighbourhood (a drone has to be able to leave
    # home). Soft blocks near the endpoints become a heavy penalty; red
    # zones stay impassable - those were rejected above anyway.
    relax_r = max(3, int(120.0 / field.cell_m))
    for rc in (s_rc, g_rc):
        field.relax_soft_blocks_near(rc, relax_r, penalty=profile_mod._MAX_WEIGHT)

    soft_relaxed = False
    raw = _astar(field, s_rc, g_rc)
    if raw is None:
        # A preference must never make a mission impossible - only law can.
        # If profile-level blocks sealed every corridor, degrade them to the
        # heaviest allowed penalty and try once more; the report says so.
        soft = ~np.isfinite(field.mult) & ~field.hard
        if soft.any():
            field.mult[soft] = profile_mod._MAX_WEIGHT
            soft_relaxed = True
            raw = _astar(field, s_rc, g_rc)
    if raw is None:
        return {"ok": False,
                "reason": "No legal path exists between start and goal in the "
                          "planning window (no-fly zones close every corridor)",
                "blocking_zones": []}

    expanded = len(raw)
    path = _smooth(field, raw)
    pts = [start] + [field.to_latlng(r, c) for (r, c) in path[1:-1]] + [goal]

    m_lng = field.m_lng
    tol = field.cell_m * 0.6
    pts = _decimate(pts, tol, field.m_lat, m_lng)
    while len(pts) > MAX_WAYPOINTS:
        tol *= 1.6
        pts = _decimate(pts, tol, field.m_lat, m_lng)

    distance = 0.0
    for a, b in zip(pts, pts[1:]):
        distance += math.hypot((b[0] - a[0]) * field.m_lat, (b[1] - a[1]) * m_lng)

    turn_radius = rules["turn_radius_m"]
    waypoints = []
    for i, (lat, lng) in enumerate(pts):
        wp_type = "waypoint"
        if i == 0:
            wp_type = "takeoff"
        elif i == len(pts) - 1 and land:
            wp_type = "land"
        waypoints.append({
            "lat": round(lat, 7), "lng": round(lng, 7),
            "altitude": float(cruise_alt_m), "speed": float(speed_m_s),
            "hold_time": 0.0, "type": wp_type, "yaw": None,
            "turn_radius": 0.0 if wp_type != "waypoint" else float(turn_radius),
        })

    est = distance / max(0.5, speed_m_s) + cruise_alt_m / CLIMB_M_S \
        + (cruise_alt_m / DESCEND_M_S if land else 0.0)

    zone_check = zone_engine.check_path(pts)
    coverage = _coverage(pts, step_m=max(5.0, field.cell_m / 2))

    return {
        "ok": True,
        "waypoints": waypoints,
        "distance_m": round(distance, 1),
        "est_duration_s": round(est, 1),
        "zones": zone_check["zones"],
        "zone_class": zone_check["zone_class"],
        "coverage": coverage,
        "report": {
            "cell_m": round(field.cell_m, 2),
            "grid": [field.rows, field.cols],
            "raw_cells": expanded,
            "waypoint_count": len(waypoints),
            "soft_blocks_relaxed": soft_relaxed,
            "rules": rules,
        },
    }
