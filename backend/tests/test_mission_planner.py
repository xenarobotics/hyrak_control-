"""
Mission path engine tests - all DB-free: zones and map features are
injected straight into the two in-memory engines, which is exactly the
state they would hold after a reload().

Geometry cheat sheet (all boxes in lng/lat order, area ~1 km east-west):

    start (17.6000, 78.1200) ---------------- goal (17.6000, 78.1300)

1 degree lat ~ 111.3 km, so 0.001 deg ~ 111 m.
"""
import math

import pytest
from shapely.geometry import Polygon, box
from shapely.strtree import STRtree

from app.planner import engine as planner
from app.planner import features as feature_engine
from app.planner import profiles
from app.zones import engine as zone_engine

START = (17.6000, 78.1200)
GOAL = (17.6000, 78.1300)


def set_zones(zones):
    """Inject (name, zone_class, geom) triples into the zone engine."""
    entries, geoms = [], []
    for name, cls, geom in zones:
        e = {"id": name, "name": name, "zone_class": cls,
             "floor_m": 0.0, "ceiling_m": None, "geom": geom}
        if cls == "red":
            e["geom_eroded"] = geom.buffer(-5 / 111_320)
        entries.append(e)
        geoms.append(geom)
    with zone_engine._lock:
        zone_engine._zones = entries
        zone_engine._tree_geoms = geoms
        zone_engine._tree = STRtree(geoms) if geoms else None


def set_features(feats):
    """Inject (name, category, geom) triples into the feature overlay."""
    feature_engine.set_features(
        [{"id": n, "name": n, "category": c, "geom": g} for n, c, g in feats]
    )


@pytest.fixture(autouse=True)
def clean_world():
    set_zones([])
    set_features([])
    yield
    set_zones([])
    set_features([])


def path_points(result):
    return [(w["lat"], w["lng"]) for w in result["waypoints"]]


def crosses(result, geom, step_m=5.0):
    """Does the planned polyline enter the geometry anywhere?"""
    pts = path_points(result)
    from shapely.geometry import Point
    for a, b in zip(pts, pts[1:]):
        seg_m = math.hypot((b[0] - a[0]) * 111_320,
                           (b[1] - a[1]) * 111_320 * math.cos(math.radians(a[0])))
        n = max(1, int(seg_m / step_m))
        for i in range(n + 1):
            t = i / n
            p = Point(a[1] + (b[1] - a[1]) * t, a[0] + (b[0] - a[0]) * t)
            if geom.covers(p):
                return True
    return False


# ── The empty world ──────────────────────────────────────────────────────


def test_direct_path_in_empty_world():
    r = planner.plan(START, GOAL)
    assert r["ok"]
    direct = 0.010 * 111_320 * math.cos(math.radians(17.6))
    assert r["distance_m"] < direct * 1.05
    assert r["est_duration_s"] > 0


def test_waypoint_upload_contract():
    r = planner.plan(START, GOAL, cruise_alt_m=45.0, speed_m_s=6.0)
    wps = r["waypoints"]
    assert wps[0]["type"] == "takeoff"
    assert wps[-1]["type"] == "land"
    assert wps[0]["lat"] == pytest.approx(START[0], abs=1e-6)
    assert wps[-1]["lng"] == pytest.approx(GOAL[1], abs=1e-6)
    for w in wps:
        assert w["altitude"] == 45.0
        assert w["speed"] == 6.0
        assert w["hold_time"] == 0.0
        assert w["yaw"] is None
    for w in wps[1:-1]:
        assert w["type"] == "waypoint"
        assert w["turn_radius"] == profiles.DEFAULT_TURN_RADIUS_M
    assert len(wps) <= planner.MAX_WAYPOINTS


def test_no_land_option():
    r = planner.plan(START, GOAL, land=False)
    assert r["waypoints"][-1]["type"] == "waypoint"


def test_span_cap():
    r = planner.plan(START, (17.6000, 78.40))
    assert not r["ok"]
    assert "km apart" in r["reason"]


# ── Zones are law ────────────────────────────────────────────────────────


def test_red_zone_is_routed_around():
    red = box(78.1245, 17.5980, 78.1255, 17.6020)   # straddles the direct line
    set_zones([("airbase", "red", red)])
    r = planner.plan(START, GOAL)
    assert r["ok"]
    assert not crosses(r, red)
    assert all(z["zone_class"] != "red" for z in r["zones"])
    direct = 0.010 * 111_320 * math.cos(math.radians(17.6))
    assert r["distance_m"] > direct  # the detour is real


def test_start_inside_red_fails():
    red = box(78.1195, 17.5995, 78.1205, 17.6005)
    set_zones([("pad-lockdown", "red", red)])
    r = planner.plan(START, GOAL)
    assert not r["ok"]
    assert "no-fly" in r["reason"]
    assert r["blocking_zones"] and r["blocking_zones"][0]["name"] == "pad-lockdown"


def test_goal_sealed_by_red_ring_fails():
    shell = box(78.1290, 17.5990, 78.1310, 17.6010).exterior.coords
    hole = box(78.1297, 17.5997, 78.1303, 17.6003).exterior.coords
    set_zones([("ring", "red", Polygon(shell, [hole]))])
    r = planner.plan(START, GOAL)
    assert not r["ok"]
    assert "No legal path" in r["reason"]


def test_orange_policy_penalize_vs_allow():
    orange = box(78.1245, 17.5990, 78.1255, 17.6010)
    set_zones([("campus-events", "orange", orange)])

    r_allow = planner.plan(START, GOAL,
                           rules={"orange": {"policy": "allow"}})
    assert r_allow["ok"] and crosses(r_allow, orange)

    r_pen = planner.plan(START, GOAL,
                         rules={"orange": {"policy": "penalize", "weight": 6.0}})
    assert r_pen["ok"] and not crosses(r_pen, orange)
    # Skimming the boundary is allowed (penalise != block) - crossing isn't.
    assert r_pen["coverage"]["zones_m"].get("orange", 0.0) < 30.0


# ── Preferences shape the route ──────────────────────────────────────────


def test_road_preference_pulls_route_onto_road():
    # A road corridor ~100 m north of the direct line, spanning the window.
    road = box(78.1180, 17.6009, 78.1320, 17.6018)
    set_features([("main-road", "road", road)])
    rules = {"categories": {"road": {"mode": "prefer", "weight": 0.45}}}

    r_direct = planner.plan(START, GOAL)
    r_road = planner.plan(START, GOAL, rules=rules)
    assert r_road["ok"]

    on_road = r_road["coverage"]["categories_m"].get("road", 0.0)
    total = r_road["coverage"]["total_m"]
    assert on_road > 0.6 * total          # the route actually rides the road
    assert r_road["distance_m"] > r_direct["distance_m"]  # and paid metres for it

    # Without the preference the road is ignored.
    off_road = r_direct["coverage"]["categories_m"].get("road", 0.0)
    assert off_road < 0.2 * r_direct["coverage"]["total_m"]


def test_blocked_category_is_never_crossed():
    hostel = box(78.1245, 17.5995, 78.1255, 17.6005)
    set_features([("hostel-blocks", "hostel", hostel)])

    r_direct = planner.plan(START, GOAL)
    assert crosses(r_direct, hostel)      # sanity: it does sit on the line

    r = planner.plan(START, GOAL,
                     rules={"categories": {"hostel": {"mode": "block"}}})
    assert r["ok"]
    assert not crosses(r, hostel)


def test_avoid_weight_detours_when_cheap():
    resi = box(78.1245, 17.5990, 78.1255, 17.6010)
    set_features([("colony", "residential", resi)])
    r = planner.plan(START, GOAL,
                     rules={"categories": {"residential": {"mode": "avoid", "weight": 8.0}}})
    assert r["ok"]
    assert not crosses(r, resi)


def test_start_inside_blocked_category_still_launches():
    # Home sits inside a blocked category: the drone must still get out.
    everywhere = box(78.1180, 17.5960, 78.1250, 17.6040)
    set_features([("hostel-town", "hostel", everywhere)])
    r = planner.plan(START, GOAL,
                     rules={"categories": {"hostel": {"mode": "block"}}})
    assert r["ok"]


# ── Profiles ─────────────────────────────────────────────────────────────


def test_validate_rules():
    ok, _ = profiles.validate_rules(
        {"categories": {"road": {"mode": "prefer", "weight": 0.5}}})
    assert ok
    assert not profiles.validate_rules(
        {"categories": {"skyscraper": {"mode": "avoid", "weight": 2}}})[0]
    assert not profiles.validate_rules(
        {"categories": {"road": {"mode": "prefer", "weight": 1.5}}})[0]
    assert not profiles.validate_rules(
        {"categories": {"road": {"mode": "avoid", "weight": 0.5}}})[0]
    assert profiles.validate_rules(
        {"categories": {"hostel": {"mode": "block"}}})[0]
    assert not profiles.validate_rules(
        {"orange": {"policy": "detonate"}})[0]


def test_resolved_rules_merging():
    base = {"categories": {"road": {"mode": "prefer", "weight": 0.5},
                           "hostel": {"mode": "block"}}}
    merged = profiles.resolved_rules(
        base,
        {"categories": {"hostel": None,
                        "forest": {"mode": "prefer", "weight": 0.6}}},
    )
    assert "hostel" not in merged["categories"]     # explicit null removes
    assert merged["categories"]["forest"]["weight"] == 0.6
    assert merged["categories"]["road"]["weight"] == 0.5
    assert merged["orange"]["policy"] == "penalize"  # default filled in
    assert merged["turn_radius_m"] == profiles.DEFAULT_TURN_RADIUS_M


def test_builtin_profiles_have_valid_rules():
    for spec in profiles.BUILTIN_PROFILES:
        ok, err = profiles.validate_rules(spec["rules"])
        assert ok, f"{spec['name']}: {err}"


# ── The permit joint ─────────────────────────────────────────────────────


def test_plan_hash_is_stable_and_permit_compatible():
    from app.permits.service import mission_hash
    r1 = planner.plan(START, GOAL)
    r2 = planner.plan(START, GOAL)
    assert mission_hash(r1["waypoints"]) == mission_hash(r2["waypoints"])
