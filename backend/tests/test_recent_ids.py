"""Bounded recent-id set with an exact session total (audit V19)."""
from app.vision.recent_ids import RecentIds


def test_counts_unique_ids_and_ignores_repeats():
    ids = RecentIds(maxlen=100)
    assert ids.add(1) and ids.add(2) and not ids.add(1)
    assert len(ids) == 2
    assert 1 in ids and 3 not in ids


def test_memory_is_bounded_but_the_total_is_not():
    ids = RecentIds(maxlen=10)
    for tid in range(1000):
        ids.add(tid)
    assert ids.remembered == 10
    assert len(ids) == 1000
    assert 999 in ids and 0 not in ids


def test_an_id_still_in_the_window_is_not_recounted():
    ids = RecentIds(maxlen=3)
    for tid in (1, 2, 3):
        ids.add(tid)
    assert not ids.add(3)
    ids.add(4)                      # evicts 1
    assert not ids.add(2) and len(ids) == 4


def test_module_states_use_the_bounded_set():
    from app.vision.modules import plate_tracker, traffic_manager
    assert isinstance(plate_tracker._make_state("t")["ids_seen"], RecentIds)
    st = traffic_manager._make_state("t")
    assert isinstance(st["ids_seen"], RecentIds)
    assert isinstance(st["person_ids_seen"], RecentIds)
