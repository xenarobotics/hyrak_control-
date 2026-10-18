"""Detections on the map: one object over many frames is one sighting."""
from app.mapdetect.geo import offset_latlon
from app.mapdetect.track import Observation, SightingTracker, match_radius

LAT, LON = 17.6, 78.1


def ob(dn=0.0, de=0.0, t=0.0, label="car", acc=4.0, score=0.5, source="object-detection",
       track_id=None):
    lat, lon = offset_latlon(LAT, LON, dn, de)
    return Observation(label=label, lat=lat, lon=lon, accuracy_m=acc, t=t, score=score,
                       source=source, model_name="Object detection", track_id=track_id)


def test_repeats_fold_into_one_sighting_with_count_times_and_best_score():
    tr = SightingTracker()
    s, created, _ = tr.observe(ob(t=10, score=0.4))
    assert created
    for i, (dn, sc) in enumerate([(1.0, 0.7), (-1.0, 0.6), (0.5, 0.3)]):
        s2, created, improved = tr.observe(ob(dn=dn, t=11 + i, score=sc))
        assert s2 is s and not created
    assert len(tr) == 1
    assert s.count == 4 and s.first_seen == 10 and s.last_seen == 13 and s.best_score == 0.7
    # Equal accuracies: the position is the plain mean (0 + 1 - 1 + 0.5) / 4 north.
    north = (s.lat - LAT) * 111319.5
    assert abs(north - 0.125) < 0.01


def test_different_class_far_away_or_stale_is_a_new_sighting():
    tr = SightingTracker(window_s=30)
    tr.observe(ob(t=0))
    tr.observe(ob(t=1, label="person"))              # other class
    tr.observe(ob(t=2, dn=50))                       # beyond 1.5 x 4 m
    tr.observe(ob(t=40))                             # same spot, 40 s later
    tr.observe(ob(t=3, source="custom:abc"))         # other model
    assert len(tr) == 5


def test_radius_scales_with_accuracy():
    assert match_radius(1, 1) == 3.0 and match_radius(10, 4) == 15.0 and match_radius(100, 1) == 60.0
    tr = SightingTracker()
    tr.observe(ob(acc=20))
    s, created, _ = tr.observe(ob(dn=25, acc=20, t=1))    # 25 m < 30 m radius
    assert not created and s.count == 2


def test_same_track_id_matches_further_out():
    tr = SightingTracker()
    tr.observe(ob(acc=4, track_id=7))
    s, created, _ = tr.observe(ob(dn=12, acc=4, t=1, track_id=7))   # 12 m: past 6 m, inside 18 m
    assert not created
    # The merged mean sits 6 m north now; 9 m past it with another id is new.
    _, created, _ = tr.observe(ob(dn=15, acc=4, t=2, track_id=8))
    assert created


def test_accuracy_is_the_best_observation_not_shrunk():
    tr = SightingTracker()
    s, _, _ = tr.observe(ob(acc=8))
    tr.observe(ob(acc=5, t=1))
    tr.observe(ob(acc=6, t=2))
    assert s.accuracy_m == 5


def test_cap():
    tr = SightingTracker(max_sightings=2)
    tr.observe(ob(dn=0))
    tr.observe(ob(dn=100))
    s, created, _ = tr.observe(ob(dn=200))
    assert s is None and tr.capped and len(tr) == 2
    tr.clear()
    assert len(tr) == 0 and not tr.capped
