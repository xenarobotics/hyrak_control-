"""Dispatcher drone snapshot + eligibility.

The dispatcher builds ONE drone view per cycle instead of recomputing fleet
status and every session snapshot once per task. These tests pin that view's
shape: fleet + sessions merged, the same aircraft deduplicated (fleet wins),
and the dispatch battery floor applied by _eligible_drones (not the snapshot).
"""
import types

import app.tasks.dispatcher as dispatcher


def _session(sid, drone_id, name, lat, lng, in_air=False, batt=100.0,
             connected=True, admin=False):
    snap = types.SimpleNamespace(
        position=types.SimpleNamespace(latitude_deg=lat, longitude_deg=lng),
        flight_mode=types.SimpleNamespace(is_in_air=in_air),
        battery=types.SimpleNamespace(remaining_percent=batt),
    )
    tel = types.SimpleNamespace(is_connected=connected, snapshot=snap)
    sess = types.SimpleNamespace(
        session_id=sid, is_admin=admin,
        drone={"id": drone_id, "name": name} if drone_id else None)
    return sess, tel


def _install(monkeypatch, fleet_rows, sessions):
    from app.fleet import service as fleet_service
    monkeypatch.setattr(fleet_service, "status", lambda: fleet_rows)
    tel_by_sid = {s.session_id: t for s, t in sessions}
    sm = types.SimpleNamespace(
        all_sessions=lambda: [s for s, _ in sessions],
        get_telemetry=lambda sid: tel_by_sid.get(sid))
    monkeypatch.setattr(dispatcher, "_session_manager", sm)


def test_snapshot_merges_fleet_and_sessions(monkeypatch):
    fleet = [{"connected": True, "db_id": "fleet-1", "name": "Station 1",
              "live": {"lat": 17.6, "lng": 78.1, "in_air": True, "battery": 80.0}}]
    sess = [_session("s1", "sess-1", "Browser 1", 17.61, 78.11, batt=90.0)]
    _install(monkeypatch, fleet, sess)

    snap = dispatcher._drone_snapshot()
    assert set(snap) == {"fleet-1", "sess-1"}
    assert snap["fleet-1"]["in_air"] is True
    assert snap["sess-1"]["lat"] == 17.61


def test_same_aircraft_deduped_fleet_wins(monkeypatch):
    fleet = [{"connected": True, "db_id": "dup", "name": "Fleet name",
              "live": {"lat": 1.0, "lng": 2.0, "in_air": False, "battery": 50.0}}]
    sess = [_session("s1", "dup", "Session name", 9.0, 9.0)]
    _install(monkeypatch, fleet, sess)

    snap = dispatcher._drone_snapshot()
    assert len(snap) == 1
    assert snap["dup"]["name"] == "Fleet name"   # fleet precedence
    assert snap["dup"]["lat"] == 1.0


def test_disconnected_and_positionless_and_admin_excluded(monkeypatch):
    fleet = [{"connected": False, "db_id": "off", "name": "x", "live": None}]
    sess = [
        _session("s1", "no-fix", "n", 0.0, 0.0),            # no GPS fix
        _session("s2", "down", "n", 5.0, 5.0, connected=False),  # link down
        _session("s3", "admin", "n", 6.0, 6.0, admin=True),      # admin console
    ]
    _install(monkeypatch, fleet, sess)
    assert dispatcher._drone_snapshot() == {}


def test_eligible_applies_battery_floor(monkeypatch):
    snap = {
        "ok": {"id": "ok", "battery": 40.0},
        "low": {"id": "low", "battery": 20.0},   # under MIN_DISPATCH_BATTERY_PCT
        "unknown": {"id": "unknown", "battery": 0.0},  # 0 = unknown, allowed
    }
    ids = {d["id"] for d in dispatcher._eligible_drones(snap)}
    assert ids == {"ok", "unknown"}
