"""Sensing: observation bus, depth -> scan geometry, mono calibration, legacy flat-segment detector, point clouds."""
import pytest
from app.avoidance.core import controller as avoidance
from app.avoidance.sensing.observations import ObstacleObservation, ObservationBus
import numpy as np
from app.avoidance.sensing.depth_scan import ScanBin, scan_from_depth, vfov_for
from app.avoidance.sensing.mono_calibration import fit_scale

from avoid_harness import _ground_and_wall


def test_nearest_ahead_only_in_forward_cone():
    bus = ObservationBus()
    bus.add(ObstacleObservation(bearing_deg=0, distance_m=5, confidence=0.8, t=100))
    bus.add(ObstacleObservation(bearing_deg=140, distance_m=2, confidence=0.9, t=100))
    near = bus.nearest_ahead(cone_deg=60, min_confidence=0.35, now=100)
    assert near is not None and near.distance_m == 5  # the one behind is ignored

def test_low_confidence_and_stale_are_ignored():
    bus = ObservationBus(ttl_s=2.0)
    bus.add(ObstacleObservation(bearing_deg=0, distance_m=4, confidence=0.1, t=100))
    assert bus.nearest_ahead(min_confidence=0.35, now=100) is None  # low conf
    bus.add(ObstacleObservation(bearing_deg=0, distance_m=4, confidence=0.9, t=100))
    assert bus.nearest_ahead(min_confidence=0.35, now=105) is None  # stale (>ttl)

def test_obstacle_distance_cm_matches_mavlink_shape():
    bus = ObservationBus()
    bus.add(ObstacleObservation(bearing_deg=0, distance_m=3, confidence=0.9, t=100))
    cm = bus.obstacle_distance_cm(now=100)
    assert len(cm) == 72
    assert cm[0] == 300           # 3 m -> 300 cm in the straight-ahead sector
    assert cm[36] == 65535        # nothing behind -> "no reading" sentinel

def test_ground_is_never_an_obstacle_even_low_and_pitched():
    hfov = 73.0; vfov = vfov_for(hfov, 640, 480)
    for alt, pitch in ((3.0, 0.0), (5.0, -8.0), (10.0, 5.0)):
        z = _ground_and_wall(48, 64, hfov, vfov, alt, None, pitch)
        scan = scan_from_depth(z, hfov, vfov, alt_m=alt, pitch_deg=pitch, max_range_m=19.1)
        assert not any(b.hit_m for b in scan), (alt, pitch)

def test_wall_ahead_found_at_its_range_through_a_nose_down_pitch():
    hfov = 73.0; vfov = vfov_for(hfov, 640, 480)
    z = _ground_and_wall(48, 64, hfov, vfov, 10.0, wall_x=14.0, pitch_deg=-6.0)
    scan = scan_from_depth(z, hfov, vfov, alt_m=10.0, pitch_deg=-6.0, max_range_m=19.1)
    hits = [b for b in scan if b.hit_m is not None]
    assert hits and all(abs(b.bearing_deg) < 7 for b in hits)
    assert min(b.hit_m for b in hits) == pytest.approx(14.0, abs=0.6)

def test_ground_plane_fit_recovers_mono_scale():
    hfov = 99.7; vfov = vfov_for(hfov, 640, 480)
    z = _ground_and_wall(60, 80, hfov, vfov, 12.0, wall_x=15.0)
    z = np.where(np.isinf(z), np.nan, z)
    rng = np.random.default_rng(3)
    pred = z * 0.72 * (1 + rng.normal(0, 0.06, z.shape))
    f = fit_scale(pred, hfov, vfov, alt_m=12.0)
    assert f is not None and f.scale == pytest.approx(1 / 0.72, rel=0.03)
    assert f.error_pct < 10

def test_detector_clear_view_returns_none():
    import numpy as np
    from app.avoidance.sensing.flat_segment import observation_from_depth
    depth = np.full((100, 200), 50.0)              # everything beyond range
    assert observation_from_depth(depth, max_distance_m=30) is None

def test_detector_finds_near_blob_and_its_bearing():
    import numpy as np
    from app.avoidance.sensing.flat_segment import observation_from_depth
    depth = np.full((100, 200), 25.0)
    depth[30:70, 20:45] = 3.0                       # near blob, left of centre
    obs = observation_from_depth(depth, hfov_deg=70)
    assert obs is not None
    assert obs.source == "monocular"
    assert 2.5 < obs.distance_m < 3.5
    assert obs.bearing_deg < 0                       # left = negative bearing
    assert obs.confidence <= 0.55                    # capped assist-grade

def test_dense_depth_extraction_preserves_gaps():
    import numpy as np
    from app.avoidance.sensing.flat_segment import observations_from_depth
    depth = np.full((100, 200), 25.0)
    depth[30:70, 20:45] = 3.0     # near obstacle on the LEFT
    depth[30:70, 150:175] = 3.0   # near obstacle on the RIGHT
    # the middle columns stay far = a GAP the drone can fly through
    obs = observations_from_depth(depth, hfov_deg=70, bin_deg=8)
    assert len(obs) >= 2
    near = [o for o in obs if o.distance_m < 10]
    bearings = sorted(o.bearing_deg for o in near)
    assert bearings[0] < -5 and bearings[-1] > 5    # one left, one right
    # the gap straight ahead is NOT reported as a near obstacle
    assert not any(abs(o.bearing_deg) < 4 and o.distance_m < 10 for o in obs)

def test_detector_center_blob_is_straight_ahead():
    import numpy as np
    from app.avoidance.sensing.flat_segment import observation_from_depth
    depth = np.full((100, 200), 25.0)
    depth[30:70, 90:110] = 4.0
    obs = observation_from_depth(depth)
    assert obs is not None and abs(obs.bearing_deg) < 6

def test_pointcloud_extraction_gaps_and_real_heights():
    from app.avoidance.sensing.pointcloud import observations_from_pointcloud
    pts = []
    for z in range(1, 6):                       # vertical columns, up rel -3..1
        pts += [(10.0, -4.0, z - 4.0), (10.0, 4.0, z - 4.0)]  # left & right
    obs = observations_from_pointcloud(pts, sensor_alt_m=4.0,
                                       hfov_deg=120, bin_deg=10)
    assert len(obs) >= 2
    bearings = sorted(o.bearing_deg for o in obs)
    assert bearings[0] < -10 and bearings[-1] > 10       # left + right
    assert not any(abs(o.bearing_deg) < 5 for o in obs)  # GAP straight ahead
    assert all(o.top_m > 4 for o in obs)                 # real absolute heights
