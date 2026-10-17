"""Delivery fleet service (audit 2026-10-17, B1 / B14 / B15).

- in_air in the fleet status is in_air OR altitude > 1 m (B1 belt and braces),
  and the dispatcher derives the same for sessions;
- a NaN / zero / missing battery never passes the reserve check and never
  reaches a status dict (B15);
- two connects for the same instance cannot race: one mavsdk_server, and
  nobody's stop() lands on the other's fresh link (B14).
"""
import asyncio
import math
import types

import pytest

from app.fleet import service as fleet_service
import app.tasks.dispatcher as dispatcher


@pytest.fixture
def clean_fleet():
    saved = {k: dict(getattr(fleet_service, k)) for k in
             ("_managers", "_state", "_db_ids", "_names", "_last_update")}
    for k in saved:
        getattr(fleet_service, k).clear()
    fleet_service._adopted.clear()
    fleet_service._connect_locks.clear()
    yield
    for k, v in saved.items():
        d = getattr(fleet_service, k)
        d.clear()
        d.update(v)
    fleet_service._adopted.clear()
    fleet_service._connect_locks.clear()


# --------------------------------------------------------------------------- #
# B1: in_air derivation                                                        #
# --------------------------------------------------------------------------- #

def test_in_air_from_stream_flag():
    assert fleet_service.in_air_from({"is_in_air": True}, {"relative_altitude_m": 0.0})


def test_in_air_from_altitude_when_the_flag_says_landed():
    """The fleet profile never carried EXTENDED_SYS_STATE before; a drone at
    30 m reported 'landed' and the dispatcher marked its order delivered."""
    assert fleet_service.in_air_from({"is_in_air": False}, {"relative_altitude_m": 30.0})
    assert not fleet_service.in_air_from({"is_in_air": False}, {"relative_altitude_m": 0.4})
    assert not fleet_service.in_air_from({}, {})


def test_in_air_from_ignores_a_nan_altitude():
    assert not fleet_service.in_air_from({}, {"relative_altitude_m": float("nan")})


def test_dispatcher_airborne_helper_matches():
    assert dispatcher._airborne(False, 5.0)
    assert dispatcher._airborne(True, 0.0)
    assert not dispatcher._airborne(False, 0.5)
    assert not dispatcher._airborne(False, float("nan"))
    assert not dispatcher._airborne(False, None)


def test_dispatcher_session_snapshot_uses_altitude(monkeypatch):
    snap = types.SimpleNamespace(
        position=types.SimpleNamespace(latitude_deg=17.6, longitude_deg=78.1,
                                       relative_altitude_m=12.0),
        flight_mode=types.SimpleNamespace(is_in_air=False),
        battery=types.SimpleNamespace(remaining_percent=80.0),
    )
    tel = types.SimpleNamespace(is_connected=True, snapshot=snap)
    sess = types.SimpleNamespace(session_id="s1", is_admin=False,
                                 drone={"id": "d1", "name": "One"})
    monkeypatch.setattr(fleet_service, "status", lambda: [])
    monkeypatch.setattr(dispatcher, "_session_manager", types.SimpleNamespace(
        all_sessions=lambda: [sess], get_telemetry=lambda sid: tel))
    assert dispatcher._drone_snapshot()["d1"]["in_air"] is True


def test_dispatcher_fleet_snapshot_uses_altitude(monkeypatch):
    rows = [{"connected": True, "db_id": "f1", "name": "F",
             "live": {"lat": 1.0, "lng": 2.0, "alt": 8.0, "in_air": False, "battery": 50.0}}]
    monkeypatch.setattr(fleet_service, "status", lambda: rows)
    monkeypatch.setattr(dispatcher, "_session_manager", None)
    assert dispatcher._drone_snapshot()["f1"]["in_air"] is True


# --------------------------------------------------------------------------- #
# B15: battery reserve and NaN                                                 #
# --------------------------------------------------------------------------- #

def test_reserve_breached_only_for_a_known_low_battery():
    assert fleet_service.reserve_breached(fleet_service.RESERVE_PCT - 1)
    assert not fleet_service.reserve_breached(fleet_service.RESERVE_PCT)
    assert not fleet_service.reserve_breached(float("nan"))
    assert not fleet_service.reserve_breached(float("-inf"))
    assert not fleet_service.reserve_breached(0.0)
    assert not fleet_service.reserve_breached(None)
    assert not fleet_service.reserve_breached("n/a")


def test_status_never_carries_a_non_finite_float(clean_fleet):
    import time
    fleet_service._managers[3] = types.SimpleNamespace(is_connected=True)
    fleet_service._last_update[3] = time.monotonic()
    fleet_service._state[3] = {
        "position": {"latitude_deg": 17.6, "longitude_deg": 78.1,
                     "relative_altitude_m": float("nan")},
        "flight_mode": {"is_armed": True, "is_in_air": True, "mode": "MISSION"},
        "battery": {"remaining_percent": float("nan")},
        "heading_deg": float("inf"),
    }
    [row] = fleet_service.status()
    lv = row["live"]
    assert lv["battery"] is None
    assert lv["heading"] is None
    assert lv["alt"] == 0.0
    assert lv["in_air"] is True
    import json
    json.dumps(row, allow_nan=False)   # would raise on a bare NaN


# --------------------------------------------------------------------------- #
# B14: per-instance connect lock                                               #
# --------------------------------------------------------------------------- #

class _FakeManager:
    built: list["_FakeManager"] = []

    def __init__(self, on_update=None, fleet_mode=False, sysid=245):
        self.is_connected = False
        self.stopped = False
        self.sysid = sysid
        _FakeManager.built.append(self)

    async def connect(self, address, kill_stale=True):
        await asyncio.sleep(0.05)       # the slow heartbeat wait
        self.is_connected = True
        return True

    async def start(self):
        pass

    async def stop(self, kill_stale=True):
        self.stopped = True
        self.is_connected = False

    async def get_hardware_uid(self):
        return None


@pytest.fixture
def fake_manager(monkeypatch, clean_fleet):
    import app.telemetry.manager as mgr_mod
    _FakeManager.built = []
    monkeypatch.setattr(mgr_mod, "TelemetryManager", _FakeManager)

    async def no_db(uid, is_simulated=False):
        return None
    monkeypatch.setattr(fleet_service.drone_registry, "upsert_seen", no_db)
    return _FakeManager


@pytest.mark.asyncio
async def test_two_connects_for_one_instance_build_one_link(fake_manager):
    """Before the lock both built a manager (two mavsdk_servers on one port)
    and the loser's stop(kill_stale=True) could take the winner's down."""
    results = await asyncio.gather(fleet_service.connect_one(1), fleet_service.connect_one(1))
    assert sorted(results) == ["already connected", "connected"]
    assert len(fake_manager.built) == 1
    assert not fake_manager.built[0].stopped
    assert fleet_service._managers[1] is fake_manager.built[0]


@pytest.mark.asyncio
async def test_rebuild_and_connect_do_not_kill_each_others_server(fake_manager):
    results = await asyncio.gather(fleet_service._rebuild(1), fleet_service.connect_one(1))
    live = fleet_service._managers[1]
    assert live.is_connected and not live.stopped
    assert results[0] is live
    assert len(fake_manager.built) == 1


@pytest.mark.asyncio
async def test_rebuild_replaces_a_dead_link_under_the_lock(fake_manager):
    await fleet_service.connect_one(1)
    old = fleet_service._managers[1]
    new = await fleet_service._rebuild(1)
    assert old.stopped and new is not old and new.is_connected
    assert fleet_service._managers[1] is new


@pytest.mark.asyncio
async def test_a_fresh_link_is_not_stale(fake_manager):
    """The watchdog's stale test read the PREVIOUS link's last update and
    tore a just-built link down before its first snapshot arrived."""
    fleet_service._last_update[1] = 0.0
    await fleet_service.connect_one(1)
    assert not fleet_service._is_stale(1)


@pytest.mark.asyncio
async def test_different_instances_connect_in_parallel(fake_manager):
    import time
    t0 = time.monotonic()
    await asyncio.gather(*(fleet_service.connect_one(i) for i in (1, 2, 3)))
    assert time.monotonic() - t0 < 0.12, "per-instance locks must not serialise the fleet"
    assert len(fake_manager.built) == 3
