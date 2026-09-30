"""Log-odds occupancy grid - layer 2 of the avoidance redesign.

The old ObstacleMap trusted every reading: one bad mono frame became a
keep-out circle that held or rerouted the aircraft (81 % of the SITL events
were phantoms). An occupancy grid weighs evidence instead:

  - a HIT raises a cell's log-odds, a ray that passes THROUGH a cell lowers
    it. A phantom that the next frames see through is erased by them, which
    the circle map could never do;
  - a cell counts as occupied only above a threshold, so a weak sensor (mono)
    needs several agreeing frames while a range sensor needs one;
  - evidence decays with time, so something no longer seen fades out
    (tau_s) instead of vanishing at a fixed TTL.

Cells live in the drone's local north/east frame (PoseHistory's metres), in
a dict - only touched cells cost memory. Each scan is integrated ONCE with
the pose at capture time; nothing is re-placed later.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field

from app.avoidance.sensing.depth_scan import ScanBin

# Evidence per reading, by source. A source's hit must reach L_OCC on its own
# only if one reading of it is trusted (a real range sensor); mono needs three.
SOURCE_WEIGHTS = {
    "depth":      (1.4, -0.5),   # (hit, miss)
    "lidar":      (1.4, -0.5),
    "tof":        (1.2, -0.4),
    "rangefinder": (1.2, -0.4),
    "monocular":  (0.45, -0.25),
    "injected":   (1.4, -0.5),
    "hazard":     (3.0, 0.0),
}
L_OCC = 1.2          # occupied above this
L_MIN, L_MAX = -2.0, 3.5
TAU_S = 20.0         # evidence half-life-ish (e-folding) with no new readings


@dataclass
class _Cell:
    l: float
    t: float
    top_m: float = 0.0
    pinned: bool = False     # operator/hazard-DB cells: never decay


@dataclass
class OccupancyGrid:
    cell_m: float = 0.5
    MAX_RAY_M = 60.0     # a client's free_m of 1e9 must not walk the ray forever
    cells: dict = field(default_factory=dict)       # (i, j) -> _Cell

    def _key(self, n: float, e: float) -> tuple[int, int]:
        return int(math.floor(n / self.cell_m)), int(math.floor(e / self.cell_m))

    def _center(self, k: tuple[int, int]) -> tuple[float, float]:
        return (k[0] + 0.5) * self.cell_m, (k[1] + 0.5) * self.cell_m

    def _value(self, c: _Cell, now: float) -> float:
        if c.pinned:
            return c.l
        return c.l * math.exp(-max(0.0, now - c.t) / TAU_S)

    def _update(self, k, dl: float, now: float, top_m: float = 0.0) -> None:
        c = self.cells.get(k)
        if c is None:
            if dl <= 0:
                return                      # free evidence on unknown space: nothing to store
            c = self.cells[k] = _Cell(0.0, now)
        if c.pinned:
            return
        c.l = max(L_MIN, min(L_MAX, self._value(c, now) + dl))
        c.t = max(c.t, now)                 # an out-of-order older scan must not rewind decay
        if top_m > 0:
            c.top_m = max(c.top_m, top_m)
        if c.l <= 0.0 and c.top_m == 0.0:
            self.cells.pop(k, None)         # back to unknown/free: forget it

    # -- ingest -----------------------------------------------------------
    def integrate(self, north_m: float, east_m: float, yaw_deg: float,
                  scan: list[ScanBin], source: str, now: float | None = None,
                  confidence_scale: float = 1.0) -> int:
        """Integrate one scan taken at (north, east) with the nose at yaw.
        Returns how many cells received a hit."""
        now = now if now is not None else time.monotonic()
        l_hit, l_miss = SOURCE_WEIGHTS.get(source, (0.8, -0.3))
        l_hit *= confidence_scale
        l_miss *= confidence_scale
        step = self.cell_m * 0.7
        n_hit = 0
        for b in scan:
            world = math.radians((yaw_deg + b.bearing_deg) % 360.0)
            # Free along the ray up to one cell short of the hit (or the seen
            # free range), with several rays across a wide bin.
            spread = max(1, int(math.ceil(2 * b.half_width_deg / 1.5)))
            # One update per cell per bin per scan: with `seen` inside the
            # sub-ray loop two sub-rays stamped the SAME hit cell, so mono's
            # "three agreeing frames" was really two (and depth got 2.8 from
            # one frame).
            seen = set()
            for s in range(spread):
                a = world + math.radians(-b.half_width_deg + (s + 0.5) * 2 * b.half_width_deg / spread)
                ca, sa = math.cos(a), math.sin(a)
                free_to = min((b.hit_m - self.cell_m) if b.hit_m is not None else b.free_m,
                              self.MAX_RAY_M)
                d = self.cell_m
                while d < free_to:
                    k = self._key(north_m + d * ca, east_m + d * sa)
                    if k not in seen:
                        seen.add(k)
                        self._update(k, l_miss, now)
                    d += step
                if b.hit_m is not None:
                    k = self._key(north_m + b.hit_m * ca, east_m + b.hit_m * sa)
                    if k not in seen:
                        seen.add(k)             # once per bin, whatever the sub-ray
                        self._update(k, l_hit, now, b.top_m)
                        n_hit += 1
        return n_hit

    def pin_disc(self, north_m: float, east_m: float, radius_m: float,
                 top_m: float = 0.0, now: float | None = None) -> None:
        """A known hazard (operator-marked / hazard DB): occupied, not decaying."""
        now = now if now is not None else time.monotonic()
        r = int(math.ceil(radius_m / self.cell_m))
        ci, cj = self._key(north_m, east_m)
        for i in range(ci - r, ci + r + 1):
            for j in range(cj - r, cj + r + 1):
                n, e = self._center((i, j))
                if math.hypot(n - north_m, e - east_m) <= radius_m:
                    self.cells[(i, j)] = _Cell(L_MAX, now, top_m, pinned=True)

    def clear(self) -> None:
        self.cells.clear()

    # -- query ------------------------------------------------------------
    def occupied(self, now: float | None = None, near: tuple[float, float] | None = None,
                 radius_m: float = 1e9) -> list[tuple[float, float, float]]:
        """Occupied cell centres (north, east, top_m), optionally within radius
        of a point. Also garbage-collects cells whose evidence has decayed."""
        now = now if now is not None else time.monotonic()
        out, dead = [], []
        for k, c in self.cells.items():
            v = self._value(c, now)
            if not c.pinned and abs(v) < 0.05:
                dead.append(k)
                continue
            if v < L_OCC:
                continue
            n, e = self._center(k)
            if near is not None and math.hypot(n - near[0], e - near[1]) > radius_m:
                continue
            out.append((n, e, c.top_m))
        for k in dead:
            self.cells.pop(k, None)
        return out

    def polar(self, north_m: float, east_m: float, radius_m: float,
              sector_deg: float = 5.0, now: float | None = None,
              min_top_m: float | None = None) -> list[float]:
        """Nearest occupied range per WORLD sector (0 = north, clockwise) around
        a point; inf = nothing within radius. Cells whose known top is below
        min_top_m (the aircraft flies over them) are ignored."""
        n_sec = int(round(360.0 / sector_deg))
        out = [math.inf] * n_sec
        half_cell = self.cell_m * 0.71
        for n, e, top in self.occupied(now, (north_m, east_m), radius_m):
            if min_top_m is not None and 0.0 < top < min_top_m:
                continue
            dn, de = n - north_m, e - east_m
            d = math.hypot(dn, de)
            brg = math.degrees(math.atan2(de, dn)) % 360.0
            # A cell covers an angular span; paint every sector it touches.
            span = math.degrees(math.atan2(half_cell, max(d, 1e-3)))
            lo = int(math.floor((brg - span) / sector_deg))
            hi = int(math.floor((brg + span) / sector_deg))
            rng = max(0.0, d - half_cell)
            for s in range(lo, hi + 1):
                s %= n_sec
                if rng < out[s]:
                    out[s] = rng
        return out

    def clusters(self, now: float | None = None, link_m: float = 1.1) -> list[dict]:
        """Occupied cells grouped into obstacles (8-connected within link_m):
        centre, radius, top - for the map overlay, the event log and the
        hazard DB."""
        pts = self.occupied(now)
        if not pts:
            return []
        keyed = {self._key(n, e): (n, e, t) for n, e, t in pts}
        reach = max(1, int(math.ceil(link_m / self.cell_m)))
        seen, out = set(), []
        for k in keyed:
            if k in seen:
                continue
            stack, members = [k], []
            seen.add(k)
            while stack:
                cur = stack.pop()
                members.append(keyed[cur])
                for di in range(-reach, reach + 1):
                    for dj in range(-reach, reach + 1):
                        nb = (cur[0] + di, cur[1] + dj)
                        if nb in keyed and nb not in seen:
                            seen.add(nb)
                            stack.append(nb)
            cn = sum(m[0] for m in members) / len(members)
            ce = sum(m[1] for m in members) / len(members)
            rad = max(math.hypot(m[0] - cn, m[1] - ce) for m in members) + self.cell_m
            out.append({"north_m": cn, "east_m": ce, "radius_m": rad,
                        "top_m": max(m[2] for m in members), "cells": len(members)})
        return out
