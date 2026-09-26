"""Mapping: pose history, occupancy grid (current), keep-out map (legacy)."""
import pytest
from app.avoidance.core import controller as avoidance
from app.avoidance.mapping import pose_history
from app.avoidance.sensing.depth_scan import ScanBin, scan_from_depth, vfov_for
from app.avoidance.mapping.occupancy import OccupancyGrid

from avoid_harness import LAT0, LNG0, _one_hit


def test_pose_at_capture_interpolates_position_and_wraps_heading():
    h = pose_history.PoseHistory()
    h.add(LAT0, LNG0, 10.0, 350.0, t=100.0)
    lat1 = LAT0 + 10.0 / 111_320.0
    h.add(lat1, LNG0, 12.0, 10.0, t=101.0)
    p = h.at(100.5)
    assert p.north_m == pytest.approx(5.0, abs=0.01)
    assert p.alt_m == pytest.approx(11.0)
    assert p.yaw_deg == pytest.approx(0.0, abs=0.01)     # 350 -> 10 the short way
    assert h.at(99.0).t == 100.0 and h.at(105.0).t == 101.0   # clamped, never extrapolated

def test_velocity_from_position_history():
    h = pose_history.PoseHistory()
    for k in range(11):
        h.add(LAT0 + (k * 0.3) / 111_320.0, LNG0, 10.0, 0.0, t=200.0 + k * 0.1)
    vn, ve = h.velocity_ne()
    assert vn == pytest.approx(3.0, rel=0.05) and abs(ve) < 0.05

def test_range_sensor_hit_is_occupied_at_once_mono_needs_agreement():
    g = OccupancyGrid()
    g.integrate(0, 0, 0, _one_hit(), "depth", now=1.0)
    assert g.occupied(now=1.0)
    m = OccupancyGrid()
    m.integrate(0, 0, 0, _one_hit(), "monocular", now=1.0)
    m.integrate(0, 0, 0, _one_hit(), "monocular", now=1.1)
    assert not m.occupied(now=1.1)                 # two mono frames: not yet
    m.integrate(0, 0, 0, _one_hit(), "monocular", now=1.2)
    assert m.occupied(now=1.2)                     # three agreeing frames

def test_seeing_through_a_phantom_erases_it():
    g = OccupancyGrid()
    for k in range(3):
        g.integrate(0, 0, 0, _one_hit(rng=8.0), "monocular", now=1.0 + k * 0.1)
    assert g.occupied(now=1.3)
    free = [ScanBin(bearing_deg=0.0, half_width_deg=1.0, hit_m=None, free_m=18.0)]
    for k in range(6):
        g.integrate(0, 0, 0, free, "monocular", now=1.4 + k * 0.1)
    assert not g.occupied(now=2.0)

def test_polar_histogram_points_at_the_obstacle():
    g = OccupancyGrid()
    g.integrate(0, 0, 90.0, _one_hit(0.0, 12.0), "depth", now=1.0)   # nose east
    polar = g.polar(0, 0, 20.0, 5.0, now=1.0)
    s = min(range(len(polar)), key=lambda i: polar[i])
    assert 85.0 <= (s + 0.5) * 5.0 <= 95.0 and 10.5 < polar[s] < 12.5

def test_keepout_radius_converges_to_recent_estimate():
    from app.avoidance.mapping.keepouts import ObstacleMap
    m = ObstacleMap()
    m.add({"lat": 17.60, "lng": 78.12, "radius_m": 15}, confidence=0.5, now=100.0)
    for k in range(1, 6):   # closer, tighter, higher-confidence estimates
        m.add({"lat": 17.60, "lng": 78.12, "radius_m": 5},
              confidence=0.9, now=100.0 + k * 0.3)
    r = m.active(now=101.5)[0].radius_m
    assert r < 8.0   # converged down from 15 toward 5, not stuck at the max

def test_obstacle_map_merges_nearby_keeps_distinct_and_expires():
    from app.avoidance.mapping.keepouts import ObstacleMap
    m = ObstacleMap(ttl_s=5.0, merge_dist_m=5.0)
    m.add({"lat": 17.60, "lng": 78.12, "radius_m": 4}, top_m=6, confidence=0.5, now=100)
    m.add({"lat": 17.600005, "lng": 78.12, "radius_m": 7}, confidence=0.9, now=101)  # ~0.5m -> merge
    m.add({"lat": 17.602, "lng": 78.12, "radius_m": 3}, now=101)                     # ~220m -> distinct
    act = m.active(now=101)
    assert len(act) == 2
    merged = min(act, key=lambda o: abs(o.lat - 17.60))
    # radius now converges (confidence-weighted EMA) toward the newer estimate
    assert 4 < merged.radius_m <= 7 and merged.top_m == 6 and merged.hits == 2
    assert m.active(now=200) == []   # both expired past ttl

def test_static_obstacle_is_confirmed_but_mover_is_not():
    from app.avoidance.mapping.keepouts import ObstacleMap
    m = ObstacleMap()
    for k in range(4):                       # stationary, seen 4x
        m.add({"lat": 17.60, "lng": 78.12, "radius_m": 3}, now=100.0 + k * 0.3)
    assert m.active(now=101.2)[0].is_static()   # -> written to the hazard map

    m2 = ObstacleMap()
    m2.add({"lat": 17.60, "lng": 78.12, "radius_m": 3}, now=200.0)
    m2.add({"lat": 17.60, "lng": 78.12003, "radius_m": 3}, now=200.4)  # ~8 m/s
    m2.add({"lat": 17.60, "lng": 78.12006, "radius_m": 3}, now=200.8)
    assert not m2.active(now=200.8)[0].is_static()   # a mover is never a hazard

def test_dynamic_obstacle_velocity_is_estimated_and_predicted():
    from app.avoidance.mapping.keepouts import ObstacleMap
    m = ObstacleMap()
    m.add({"lat": 17.600, "lng": 78.120, "radius_m": 3}, now=100.0)
    # ~2.1 m east in 0.4 s (within the 5 m merge radius) = a ~5 m/s mover
    m.add({"lat": 17.600, "lng": 78.12002, "radius_m": 3}, now=100.4)
    o = m.active(now=100.4)[0]
    assert o.hits == 2 and o.ve_mps > 1.5   # merged, moving east
    pk = o.predicted_keepout(1.5)
    assert pk["lng"] > o.lng              # keep-out leads where it is going
    assert pk["radius_m"] > o.radius_m    # grown to cover the swept path
