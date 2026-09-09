"""Red-zone geofence simplification for the PX4 FC backstop.

PX4 rejects a geofence past its vertex ceiling (TOO_MANY_GEOFENCE_ITEMS) and
then uploads NOTHING - the aircraft flies with no FC-level no-fly enforcement.
red_polygon_rings(max_total_vertices=...) must shrink the vertex count under
the cap WITHOUT ever exposing a real red-zone corner: the simplified polygon
must strictly contain the original.
"""
import math

from shapely.geometry import Polygon

import app.zones.engine as engine


def _blob(cx, cy, n=50, r=0.002):
    """A wiggly ~n-vertex polygon around (cx, cy) in lng/lat."""
    return Polygon([
        (cx + r * math.cos(2 * math.pi * i / n) * (1 + 0.15 * math.sin(6 * i)),
         cy + r * math.sin(2 * math.pi * i / n) * (1 + 0.15 * math.sin(6 * i)))
        for i in range(n)
    ])


def _install_red_zones(monkeypatch, polys):
    monkeypatch.setattr(
        engine, "_zones",
        [{"zone_class": "red", "geom": p} for p in polys], raising=False)


def test_below_budget_returns_rings_unchanged(monkeypatch):
    polys = [_blob(78.12, 17.59, n=8)]
    _install_red_zones(monkeypatch, polys)
    rings = engine.red_polygon_rings(max_total_vertices=90)
    assert sum(len(r) for r in rings) == 8  # untouched: already under budget


def test_over_budget_is_simplified_under_cap(monkeypatch):
    polys = [_blob(78.12 + 0.01 * k, 17.59 + 0.01 * k, n=50) for k in range(4)]
    _install_red_zones(monkeypatch, polys)
    raw = engine.red_polygon_rings()
    assert sum(len(r) for r in raw) == 200

    simp = engine.red_polygon_rings(max_total_vertices=90)
    assert sum(len(r) for r in simp) <= 90


def test_simplified_fence_never_shrinks_below_the_real_zone(monkeypatch):
    polys = [_blob(78.12 + 0.01 * k, 17.59 + 0.01 * k, n=50) for k in range(4)]
    _install_red_zones(monkeypatch, polys)
    simp = engine.red_polygon_rings(max_total_vertices=90)

    # A safety fence may over-cover but must never expose a real corner:
    # each simplified polygon has to contain its original zone.
    for orig, ring in zip(polys, simp):
        sp = Polygon([(lng, lat) for lat, lng in ring])
        assert sp.buffer(1e-9).contains(orig)
