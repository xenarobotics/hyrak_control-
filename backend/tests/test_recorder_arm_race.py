"""Flight recorder: one Flight row per arm edge (audit B16).

Snapshots arrive as independent tasks. Two of them landing on the arm edge
both saw no active flight, both inserted a Flight, and the loser's row
stayed in_progress forever.
"""
import asyncio
import uuid

import pytest

from app.flights import recorder


class _Flight:
    def __init__(self, drone_id, session_id):
        self.id = str(uuid.uuid4())
        self.drone_id = drone_id
        self.session_id = session_id


class _Db:
    inserted: list = []
    commit_delay = 0.03

    def __init__(self):
        self.pending = []

    def add(self, row):
        self.pending.append(row)

    async def commit(self):
        await asyncio.sleep(self.commit_delay)
        _Db.inserted.extend(self.pending)
        self.pending = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


@pytest.fixture
def fake_db(monkeypatch):
    _Db.inserted = []
    monkeypatch.setattr(recorder, "db_available", lambda: True)
    monkeypatch.setattr(recorder, "get_session", lambda: _Db())
    monkeypatch.setattr(recorder, "Flight", _Flight)
    recorder._active.pop("s1", None)
    yield _Db
    recorder._active.pop("s1", None)


ARMED = {"flight_mode": {"is_armed": True, "mode": "MISSION"},
         "position": {"latitude_deg": 0.0, "longitude_deg": 0.0, "relative_altitude_m": 3.0},
         "battery": {"remaining_percent": 90.0}}


@pytest.mark.asyncio
async def test_concurrent_snapshots_on_the_arm_edge_insert_one_flight(fake_db):
    await asyncio.gather(*(recorder.on_snapshot("s1", "drone-1", ARMED) for _ in range(3)))
    flights = [r for r in fake_db.inserted if isinstance(r, _Flight)]
    assert len(flights) == 1
    assert recorder._active["s1"]["flight_id"] == flights[0].id


@pytest.mark.asyncio
async def test_a_failed_insert_releases_the_slot(fake_db, monkeypatch):
    class _Broken(_Db):
        async def commit(self):
            raise RuntimeError("db down")
    monkeypatch.setattr(recorder, "get_session", lambda: _Broken())
    await recorder.on_snapshot("s1", "drone-1", ARMED)
    assert "s1" not in recorder._active, "a failed insert left a placeholder behind"


@pytest.mark.asyncio
async def test_end_flight_during_the_insert_does_not_record_a_ghost(fake_db):
    fake_db.commit_delay = 0.05
    task = asyncio.create_task(recorder.on_snapshot("s1", "drone-1", ARMED))
    await asyncio.sleep(0.01)
    assert recorder._active["s1"]["flight_id"] is None
    await recorder.end_flight("s1")            # disarm / disconnect mid-insert
    await task
    assert "s1" not in recorder._active
