"""
Phase 2b: customer mission planning and permits (docs/ACCESS_MODEL.md 8d),
everything that runs without a database:

  * the planning scope (app/planner/scope.py): whose missions, pads and
    profiles a user reads and writes;
  * the permit rules (app/permits/service.py): window and expiry, drone and
    workspace, mission vs area coverage, who decides (area rules for
    airspace managers and managers, never your own request), the upload
    gate and the zone monitor standing down only under a permit;
  * upload_mission as a session command with drone access, on the real
    socket handler.

The database-backed HTTP flows (isolation of stored rows, the request /
decide / honour flow and its audit rows) are in test_planning_db.py.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Optional

import pytest

from app.auth import perms as P
from app.auth import socket_guard
from app.auth.store import PLATFORM_WORKSPACE_ID
from app.permits import service as permits
from app.planner import scope as plan_scope
from app.workspaces.service import Refused
from app.zones import engine as zone_engine

from test_live_scope import (  # noqa: F401  (live is a fixture)
    connect, errors, hold_link, live, session, world,
)

ROOT = PLATFORM_WORKSPACE_ID


@dataclass(frozen=True)
class WS:
    id: str
    kind: str
    path: str
    operating_area: Optional[dict] = None
    disabled: bool = False
    name: str = ""


@dataclass(frozen=True)
class M:
    workspace_id: str
    workspace_path: str
    workspace_kind: str
    role: str
    area: Optional[dict] = None
    workspace_disabled: bool = False


def box(x0, y0, x1, y1):
    return {"type": "Polygon",
            "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}


HYRAK = WS(ROOT, P.PLATFORM, f"/{ROOT}/", name="HYRAK")
IITH = WS("iith", P.ORGANIZATION, f"/{ROOT}/iith/", operating_area=box(78.0, 17.0, 79.0, 18.0))
CIVIL = WS("civil", P.CLIENT, f"/{ROOT}/iith/civil/")
SKY = WS("sky", P.ORGANIZATION, f"/{ROOT}/sky/", operating_area=box(77.0, 12.0, 78.0, 13.0))


def on(ws, role, area=None):
    return M(ws.id, ws.path, ws.kind, role, area)


class Tree:
    def __init__(self, *ws):
        self.by = {w.id: w for w in ws}

    def get(self, i):
        return self.by.get(i)

    def all(self):
        return list(self.by.values())


TREE = Tree(HYRAK, IITH, CIVIL, SKY)


def user(ms, *, uid="u1"):
    ms = list(ms)
    return SimpleNamespace(id=uid, username=uid, memberships=ms, role=P.compat_role(ms),
                           is_staff=P.is_staff(ms), is_founder=P.is_founder(ms))


def scope(ms, uid="u1"):
    u = user(ms, uid=uid)
    return plan_scope.scope_from(u, u.memberships, TREE)


# ── Planning scope ────────────────────────────────────────────────────────

def test_customer_plans_only_in_their_own_workspaces():
    pilot = scope([on(IITH, "pilot")])
    assert pilot.resolve(None, write=True) == "iith"
    assert pilot.resolve("civil", write=True) == "civil"        # inherited down the tree
    assert pilot.can_read("iith") and pilot.can_write("iith")
    assert not pilot.can_read("sky") and not pilot.can_write("sky")
    with pytest.raises(Refused) as e:
        pilot.resolve("sky", write=False)
    assert e.value.status == 404                                # no existence leak
    with pytest.raises(Refused) as e:
        pilot.resolve("nope", write=False)
    assert e.value.status == 404
    # HYRAK's plans: readable as global vocabulary, never writable.
    assert not pilot.can_write(ROOT)
    assert pilot.readable_global()


def test_viewer_reads_plans_but_cannot_write():
    viewer = scope([on(IITH, "viewer")])
    assert viewer.resolve(None, write=False) == "iith"
    assert viewer.can_read("iith") and not viewer.can_write("iith")
    with pytest.raises(Refused) as e:
        viewer.resolve("iith", write=True)
    assert e.value.status == 403
    with pytest.raises(Refused) as e:
        viewer.resolve(None, write=True)
    assert e.value.status == 403


def test_staff_keep_todays_access():
    hyrak_pilot = scope([on(HYRAK, "pilot")])
    assert hyrak_pilot.resolve(None, write=True) == ROOT
    assert hyrak_pilot.can_read("sky")                          # staff read every plan
    assert not hyrak_pilot.can_write("sky")                     # but plan only with `plan`
    hyrak_viewer = scope([on(HYRAK, "viewer")])
    assert hyrak_viewer.resolve(None, write=False) == ROOT
    with pytest.raises(Refused):
        hyrak_viewer.resolve(None, write=True)                  # HYRAK writes need operator
    manager = scope([on(HYRAK, "viewer"), on(IITH, "manager")])
    assert manager.can_write("iith") and manager.can_write("civil")
    assert not manager.can_write("sky")
    # HYRAK's own plans keep the compatibility operator rank, which a
    # manager holds (pre-8b behaviour, unchanged).
    assert manager.can_write(ROOT)
    founder = scope([on(HYRAK, "founder")])
    assert all(founder.can_write(w) for w in (ROOT, "iith", "civil", "sky"))


# ── Permit rules (pure) ───────────────────────────────────────────────────

ALT = {"floor_m": 0.0, "ceiling_m": None}
RED = {"id": "red1", "name": "Lab", "zone_class": "red", "permission_required": True, **ALT}
RED2 = {"id": "red2", "name": "Tower", "zone_class": "red", "permission_required": True, **ALT}
ORANGE = {"id": "or1", "name": "Hostel", "zone_class": "orange", "permission_required": True, **ALT}
NOFLY = {"id": "nf", "name": "Airport", "zone_class": "red", "permission_required": False, **ALT}

# A red zone over (17.590-17.592, 78.120-78.122) and an orange one next to it.
ZONES = [
    {**RED, "geometry": box(78.120, 17.590, 78.122, 17.592)},
    {**ORANGE, "geometry": box(78.124, 17.590, 78.126, 17.592)},
]
CROSS_RED = [{"lat": 17.589, "lng": 78.121, "altitude": 20.0},
             {"lat": 17.593, "lng": 78.121, "altitude": 20.0}]
CROSS_ORANGE = [{"lat": 17.589, "lng": 78.125, "altitude": 20.0},
                {"lat": 17.593, "lng": 78.125, "altitude": 20.0}]

NOW = datetime(2026, 10, 18, 12, 0, tzinfo=timezone.utc)


def permit(**kw):
    p = {"id": "p1", "workspace_id": "iith", "drone_id": None, "status": "approved",
         "zones": [RED], "waypoints": CROSS_RED, "mission_hash": permits.mission_hash(CROSS_RED),
         "area": None, "valid_from": (NOW - timedelta(hours=1)).isoformat(),
         "valid_until": (NOW + timedelta(hours=1)).isoformat(), "requested_by": "pat"}
    p.update(kw)
    return p


@pytest.fixture
def zones():
    zone_engine.set_zones(ZONES)
    yield
    zone_engine.set_zones([])


def test_window_and_expiry():
    assert permits.in_window(permit(), NOW)
    assert not permits.in_window(permit(), NOW + timedelta(hours=2))         # expired
    assert permits.effective_status(permit(), NOW + timedelta(hours=2)) == "expired"
    assert not permits.in_window(permit(), NOW - timedelta(hours=2))         # not yet
    for st in ("pending", "denied", "revoked", "withdrawn"):
        assert not permits.in_window(permit(status=st), NOW), st
    # A permit from before 8b has no window: valid while approved.
    assert permits.in_window(permit(valid_from=None, valid_until=None), NOW)


def test_permit_follows_the_drones_current_workspace():
    d = {"id": "d1", "workspace_id": "iith"}
    assert permits.applies_to_drone(permit(), d)                             # any drone of IITH
    assert permits.applies_to_drone(permit(drone_id="d1"), d)
    assert not permits.applies_to_drone(permit(drone_id="d2"), d)
    assert not permits.applies_to_drone(permit(), {"id": "d1", "workspace_id": "sky"})  # moved away
    assert not permits.applies_to_drone(permit(), None)


def test_mission_permit_covers_only_its_path_and_zones(zones):
    p = permit()
    assert permits.covers_path(p, CROSS_RED, {"red1"})
    nudged = [dict(w, lat=w["lat"] + 5e-6) for w in CROSS_RED]                  # GPS noise
    assert permits.covers_path(p, nudged, {"red1"})
    edited = [dict(w, lat=w["lat"] + 1e-4) for w in CROSS_RED]                  # a real edit
    assert not permits.covers_path(p, edited, {"red1"})
    # A zone the permit does not name (drawn after approval) is not covered.
    assert not permits.covers_path(p, CROSS_RED, {"red1", "red2"})


def test_area_permit_covers_any_path_inside_it(zones):
    p = permit(area=box(78.118, 17.588, 78.123, 17.594), waypoints=[], mission_hash="")
    assert permits.covers_path(p, CROSS_RED, {"red1"})
    zigzag = CROSS_RED + [{"lat": 17.5915, "lng": 78.1195, "altitude": 30.0}]
    assert permits.covers_path(p, zigzag, {"red1"})
    outside = CROSS_RED + [{"lat": 17.600, "lng": 78.121, "altitude": 30.0}]
    assert not permits.covers_path(p, outside, {"red1"})


def test_permitted_zones_only_on_the_permitted_footprint(zones):
    p = permit()
    on_path = permits.permitted_zone_ids_at([p], 17.591, 78.121, NOW)
    assert on_path == {"red1"}
    off_path = permits.permitted_zone_ids_at([p], 17.591, 78.1218, NOW)        # ~85 m east
    assert off_path == set()
    assert permits.permitted_zone_ids_at([p], 17.591, 78.121, NOW + timedelta(hours=2)) == set()
    assert permits.permitted_zone_ids_at([permit(status="revoked")], 17.591, 78.121, NOW) == set()


def test_split_zones_keeps_prohibited_red_apart():
    red, orange, prohibited = permits.split_zones([RED, ORANGE, NOFLY])
    assert [z["id"] for z in red] == ["red1"]
    assert [z["id"] for z in orange] == ["or1"]
    assert [z["id"] for z in prohibited] == ["nf"]


def test_who_decides_area_rules(zones):
    p = permit()                                     # IITH's permit, flight inside IITH's area
    geoms = zone_engine.geometries({"red1"})
    founder = [on(HYRAK, "founder")]
    air_here = [on(HYRAK, "airspace", area=box(78.1, 17.5, 78.2, 17.6))]
    air_elsewhere = [on(HYRAK, "airspace", area=box(77.0, 12.0, 78.0, 13.0))]
    iith_manager = [on(HYRAK, "viewer"), on(IITH, "manager")]          # falls back to IITH's area
    small_manager = [on(HYRAK, "viewer"), on(IITH, "manager", area=box(78.5, 17.5, 78.6, 17.6))]
    sky_manager = [on(HYRAK, "viewer"), on(SKY, "manager")]
    owner = [on(IITH, "owner")]

    def ok(ms, uid="x"):
        return permits.can_decide(ms, IITH, p, actor_id=uid, zone_geoms=geoms)

    assert ok(founder).ok
    assert ok(air_here).ok
    assert ok(air_elsewhere).status == 409          # outside their area
    assert ok(iith_manager).ok
    assert ok(small_manager).status == 409
    assert ok(sky_manager).status == 403            # not this workspace's manager
    assert ok(owner).status == 403                  # customers request, never decide
    assert ok([on(IITH, "pilot")]).status == 403
    # Never your own request; a founder is the exception.
    assert ok(iith_manager, uid="pat").status == 403
    assert ok(founder, uid="pat").ok


def test_decision_footprint_is_the_restricted_part_only(zones):
    """A long flight that leaves an airspace manager's area is still theirs
    to decide when every restricted zone it crosses is inside it."""
    long_path = [{"lat": 17.589, "lng": 78.121, "altitude": 20.0},
                 {"lat": 17.700, "lng": 78.121, "altitude": 20.0}]
    p = permit(waypoints=long_path, mission_hash=permits.mission_hash(long_path))
    air = [on(HYRAK, "airspace", area=box(78.1, 17.585, 78.2, 17.6))]
    assert permits.can_decide(air, IITH, p, zone_geoms=zone_engine.geometries({"red1"})).ok


def test_transitions():
    assert permits.transition_ok("pending", "approved")
    assert permits.transition_ok("pending", "denied")
    assert permits.transition_ok("approved", "revoked")
    assert permits.transition_ok("approved", "withdrawn")
    assert not permits.transition_ok("denied", "approved")
    assert not permits.transition_ok("revoked", "approved")
    assert not permits.transition_ok("approved", "approved")


# ── The upload gate ───────────────────────────────────────────────────────

@pytest.fixture
def stored(monkeypatch):
    """Permits as the store would return them for a drone."""
    rows: list = []

    async def usable(drone):
        return [p for p in rows if p["status"] == "approved"]
    monkeypatch.setattr(permits, "usable_for_drone", usable)
    monkeypatch.setattr(permits, "db_available", lambda: True)
    return rows


DRONE = {"id": "d1", "workspace_id": "iith"}


def fresh(**kw):
    now = permits.now_utc()
    return permit(**{"valid_from": (now - timedelta(minutes=5)).isoformat(),
                     "valid_until": (now + timedelta(hours=1)).isoformat(), **kw})


async def test_gate_red_needs_an_in_window_permit(zones, stored):
    g = await permits.gate_upload(DRONE, CROSS_RED, ack_orange=False)
    assert not g["ok"] and g["blocked"] == "red" and g["can_request"] is True
    stored.append(fresh())
    g = await permits.gate_upload(DRONE, CROSS_RED, ack_orange=False)
    assert g["ok"] and g["permit"]["id"] == "p1"
    # Expired, rejected or for another workspace's drone: no longer counts.
    now = permits.now_utc()
    stored[0] = fresh(valid_until=(now - timedelta(seconds=1)).isoformat())
    assert (await permits.gate_upload(DRONE, CROSS_RED, ack_orange=False))["blocked"] == "red"
    stored[0] = fresh(status="denied")
    assert (await permits.gate_upload(DRONE, CROSS_RED, ack_orange=False))["blocked"] == "red"
    stored[0] = fresh()
    moved = {"id": "d1", "workspace_id": "sky"}
    assert (await permits.gate_upload(moved, CROSS_RED, ack_orange=False))["blocked"] == "red"
    # No identified drone: no permit applies, and none can be asked for here.
    g = await permits.gate_upload(None, CROSS_RED, ack_orange=False)
    assert g["blocked"] == "red" and g["can_request"] is False


async def test_gate_orange_ack_or_permit(zones, stored):
    g = await permits.gate_upload(DRONE, CROSS_ORANGE, ack_orange=False)
    assert not g["ok"] and g["needs_ack"]
    assert (await permits.gate_upload(DRONE, CROSS_ORANGE, ack_orange=True))["ok"]
    stored.append(fresh(zones=[ORANGE], waypoints=CROSS_ORANGE,
                        mission_hash=permits.mission_hash(CROSS_ORANGE)))
    g = await permits.gate_upload(DRONE, CROSS_ORANGE, ack_orange=False)
    assert g["ok"] and g["permit"] and not g["orange_acked"]


async def test_gate_prohibited_red_admits_no_permit(stored):
    zone_engine.set_zones([{**NOFLY, "geometry": box(78.120, 17.590, 78.122, 17.592)}])
    try:
        stored.append(fresh(zones=[NOFLY]))
        g = await permits.gate_upload(DRONE, CROSS_RED, ack_orange=True)
        assert g["blocked"] == "red" and g["prohibited"] and g["can_request"] is False
    finally:
        zone_engine.set_zones([])


# ── The zone monitor ──────────────────────────────────────────────────────

class _Sio:
    def __init__(self):
        self.out = []

    async def emit(self, event, data=None, to=None, **kw):
        self.out.append((event, data))


def _snap(lat, lng):
    return {"position": {"latitude_deg": lat, "longitude_deg": lng, "relative_altitude_m": 20.0,
                         "absolute_altitude_m": 520.0},
            "flight_mode": {"is_armed": True, "is_in_air": True},
            "velocity": {"north_m_s": 0.0, "east_m_s": 0.0}}


async def _monitor_in_red(monkeypatch, permits_for_drone):
    from app.zones import monitor
    alerts = []

    async def alert(sm, a):
        alerts.append(a)

    async def usable(drone):
        return permits_for_drone
    pushed = []

    async def push(tel, lat, lng, alt):
        pushed.append((lat, lng))
    monkeypatch.setattr(monitor, "emit_admin_alert", alert)
    monkeypatch.setattr(permits, "usable_for_drone", usable)
    monkeypatch.setattr(permits, "db_available", lambda: True)
    monkeypatch.setattr(monitor, "_pushback", push)
    sess = SimpleNamespace(session_id="s-mon", socket_id="sock", drone=dict(DRONE), zone_lock=False)
    monitor.drop("s-mon")
    sio = _Sio()
    try:
        await monitor.on_snapshot(sio, None, sess, None, _snap(17.591, 78.121))
    finally:
        monitor.drop("s-mon")
    return sess, sio, alerts


async def test_monitor_pushes_back_without_a_permit(zones, monkeypatch):
    sess, sio, _ = await _monitor_in_red(monkeypatch, [])
    assert sess.zone_lock is True
    assert any(d.get("locked") for e, d in sio.out if e == "zone_status")


async def test_monitor_stands_down_under_a_permit(zones, monkeypatch):
    sess, sio, alerts = await _monitor_in_red(monkeypatch, [fresh()])
    assert sess.zone_lock is False
    status = [d for e, d in sio.out if e == "zone_status"]
    assert status and "under permit" in status[-1]["message"]
    assert [z["id"] for z in status[-1]["permitted_zones"]] == ["red1"]
    assert not any(a["level"] == "danger" for a in alerts)


async def test_monitor_counts_an_expired_permit_as_none(zones, monkeypatch):
    now = permits.now_utc()
    expired = fresh(valid_until=(now - timedelta(seconds=1)).isoformat())
    sess, _, _ = await _monitor_in_red(monkeypatch, [expired])
    assert sess.zone_lock is True


# ── Fail closed: the monitor's permit cache ───────────────────────────────

class _Fetches:
    """usable_for_drone stand-in: returns `rows`, or raises while `fail`."""

    def __init__(self, rows):
        self.rows, self.fail, self.calls = rows, False, 0

    async def __call__(self, drone):
        self.calls += 1
        if self.fail:
            raise ConnectionError("db down")
        return [p for p in self.rows if p["status"] == "approved"]


@pytest.fixture
def cache(monkeypatch, zones):
    from app.zones import monitor
    rows = [fresh()]
    f = _Fetches(rows)
    monkeypatch.setattr(permits, "usable_for_drone", f)
    monkeypatch.setattr(permits, "db_available", lambda: True)
    sess = SimpleNamespace(session_id="s-cache", drone=dict(DRONE))
    monitor.drop("s-cache")
    yield monitor, sess, f, rows
    monitor.drop("s-cache")


async def test_cached_permit_is_dropped_when_a_write_lands_and_the_refetch_fails(cache):
    monitor, sess, f, rows = cache
    assert await monitor.permitted_zone_ids(sess, 17.591, 78.121) == {"red1"}
    # Revoked while cached: the write bumps the generation; the refetch fails.
    rows[0] = dict(rows[0], status="revoked")
    permits._bump()
    f.fail = True
    assert await monitor.permitted_zone_ids(sess, 17.591, 78.121) == set()
    # And it works out the revocation once the store answers again.
    f.fail = False
    assert await monitor.permitted_zone_ids(sess, 17.591, 78.121) == set()


async def test_a_failed_refetch_does_not_advance_the_cache(cache, monkeypatch):
    monitor, sess, f, rows = cache
    assert await monitor.permitted_zone_ids(sess, 17.591, 78.121) == {"red1"}
    entry = dict(monitor._permit_cache["s-cache"])
    # Due for a refresh; the store fails: the old answer (same generation,
    # not too old) stands, but the cache is not stamped as refreshed.
    monkeypatch.setattr(monitor, "PERMIT_REFRESH_S", 0.0)
    f.fail = True
    calls = f.calls
    assert await monitor.permitted_zone_ids(sess, 17.591, 78.121) == {"red1"}
    assert monitor._permit_cache["s-cache"] == entry
    assert await monitor.permitted_zone_ids(sess, 17.591, 78.121) == {"red1"}
    assert f.calls == calls + 2                                    # every tick retries
    # Too old to trust while the store stays down: nothing counts.
    monkeypatch.setattr(monitor, "PERMIT_MAX_STALE_S", 0.0)
    assert await monitor.permitted_zone_ids(sess, 17.591, 78.121) == set()


async def test_generation_change_empties_the_cached_answer(cache):
    monitor, sess, f, rows = cache
    assert await monitor.permitted_zone_ids(sess, 17.591, 78.121) == {"red1"}
    permits._bump()                                    # any permit write
    f.fail = True
    assert await monitor.permitted_zone_ids(sess, 17.591, 78.121) == set()


async def test_arm_needs_a_fresh_read(cache):
    monitor, sess, f, rows = cache
    assert await monitor.permitted_zone_ids(sess, 17.591, 78.121) == {"red1"}
    f.fail = True
    with pytest.raises(permits.PermitCheckUnavailable):
        await monitor.permitted_zone_ids(sess, 17.591, 78.121, fresh=True)


async def test_upload_refuses_red_when_permits_cannot_be_read(zones, stored, monkeypatch):
    stored.append(fresh())

    async def down(drone):
        raise ConnectionError("db down")
    monkeypatch.setattr(permits, "usable_for_drone", down)
    g = await permits.gate_upload(DRONE, CROSS_RED, ack_orange=True)
    assert g["blocked"] == "red" and g["permit_check_failed"] and "could not be checked" in g["msg"]
    # Orange alone can still be acknowledged.
    assert (await permits.gate_upload(DRONE, CROSS_ORANGE, ack_orange=True))["ok"]
    monkeypatch.setattr(permits, "db_available", lambda: False)
    assert (await permits.gate_upload(DRONE, CROSS_RED, ack_orange=True))["permit_check_failed"]


async def test_arm_in_red_is_refused_when_permits_cannot_be_read(live, zones, monkeypatch):
    w = await world(live)
    await connect(live, "p", w.pat[1])
    s = session(live, "p")
    pos = SimpleNamespace(latitude_deg=17.591, longitude_deg=78.121)
    live.sm._telemetry[s.session_id] = SimpleNamespace(is_connected=True,
                                                        snapshot=SimpleNamespace(position=pos))
    s.drone = {"id": "d-own", "workspace_id": w.iith["id"], "is_simulated": False}
    s.drone_fly = True

    async def down(drone):
        raise ConnectionError("db down")
    monkeypatch.setattr(permits, "usable_for_drone", down)
    monkeypatch.setattr(permits, "db_available", lambda: True)
    await live.sio.handlers["/"]["drone_action"]("p", {"action": "arm"})
    res = live.rec.of("action_result", "p")[-1]
    assert res["ok"] is False and "could not be checked" in res["error"]


# ── Zones that became stricter ────────────────────────────────────────────

def test_a_zone_made_prohibited_is_never_exempted(zones):
    p = permit()
    live = {"red1": {"zone_class": "red", "permission_required": False}}
    assert permits.honoured_zone_ids(p, live) == set()
    assert permits.permitted_zone_ids_at([p], 17.591, 78.121, NOW, live=live) == set()
    assert not permits.covers_path(p, CROSS_RED, {"red1"}, live=live)


def test_a_class_raised_after_approval_is_not_exempted():
    p = permit(zones=[ORANGE], waypoints=CROSS_ORANGE, mission_hash=permits.mission_hash(CROSS_ORANGE))
    assert permits.honoured_zone_ids(p, {"or1": {"zone_class": "orange"}}) == {"or1"}
    assert permits.honoured_zone_ids(p, {"or1": {"zone_class": "red",
                                                 "permission_required": True}}) == set()
    # Any other class counts as a different zone; a deleted one flags nothing.
    assert permits.honoured_zone_ids(p, {"or1": {"zone_class": "green"}}) == set()
    assert permits.honoured_zone_ids(p, {}) == set()


def test_an_altitude_change_ends_the_exemption():
    p = permit()
    assert permits.honoured_zone_ids(p, {"red1": {"zone_class": "red", "floor_m": 0.0,
                                                  "ceiling_m": None}}) == {"red1"}
    assert permits.honoured_zone_ids(p, {"red1": {"zone_class": "red", "floor_m": 5.0,
                                                  "ceiling_m": None}}) == set()
    assert permits.honoured_zone_ids(p, {"red1": {"zone_class": "red", "floor_m": 0.0,
                                                  "ceiling_m": 120.0}}) == set()
    # A permit that never recorded altitudes (approved before 8b) exempts nothing.
    legacy = permit(zones=[{"id": "red1", "name": "Lab", "zone_class": "red"}])
    assert permits.honoured_zone_ids(legacy, {"red1": {"zone_class": "red", "floor_m": 0.0,
                                                       "ceiling_m": None}}) == set()


async def test_a_zone_edit_is_refused_when_its_permits_cannot_be_superseded(live, monkeypatch):
    from app.auth import service as auth_service
    w = await world(live)
    ft = w.founder[1]
    z = live.cl.post("/api/zones", headers={"Authorization": f"Bearer {ft}"}, json={
        "name": "Lab", "zone_class": "red", "geometry": box(78.120, 17.590, 78.122, 17.592)})
    assert z.status_code == 200, z.text
    zid = z.json()["zone"]["properties"]["id"]

    async def broken(zone_id, reason):
        raise ConnectionError("db down")
    monkeypatch.setattr(permits, "supersede_for_zone", broken)
    r = live.cl.patch(f"/api/zones/{zid}", headers={"Authorization": f"Bearer {ft}"},
                      json={"floor_m": 5})
    assert r.status_code == 503 and "not changed" in r.json()["detail"]
    assert auth_service.memory_store()._zones[zid].floor_m == 0.0
    # An edit that changes nothing a permit approved goes through.
    r = live.cl.patch(f"/api/zones/{zid}", headers={"Authorization": f"Bearer {ft}"},
                      json={"name": "Lab 2"})
    assert r.status_code == 200
    # And once permits can be superseded, the edit lands.
    calls = []

    async def fine(zone_id, reason):
        calls.append((zone_id, reason))
        return []
    monkeypatch.setattr(permits, "supersede_for_zone", fine)
    r = live.cl.patch(f"/api/zones/{zid}", headers={"Authorization": f"Bearer {ft}"},
                      json={"floor_m": 5})
    assert r.status_code == 200 and calls and "floor_m" in calls[0][1]
    assert auth_service.memory_store()._zones[zid].floor_m == 5.0


async def test_gate_and_monitor_use_the_live_zone(stored, monkeypatch):
    stored.append(fresh())
    zone_engine.set_zones([{**RED, "permission_required": True,
                            "geometry": box(78.120, 17.590, 78.122, 17.592)}])
    try:
        assert (await permits.gate_upload(DRONE, CROSS_RED, ack_orange=False))["ok"]
        # The zone is made prohibited after approval: the engine says so at once.
        zone_engine.set_zones([{**RED, "permission_required": False,
                                "geometry": box(78.120, 17.590, 78.122, 17.592)}])
        g = await permits.gate_upload(DRONE, CROSS_RED, ack_orange=False)
        assert g["blocked"] == "red" and g["prohibited"]
        assert permits.permitted_zone_ids_at(stored, 17.591, 78.121) == set()
    finally:
        zone_engine.set_zones([])


def test_approval_records_the_zones_as_they_are_now():
    zs, prohibited = permits.record_live_zones(
        [ORANGE, RED], live={"or1": {"zone_class": "red", "permission_required": True},
                             "red1": {"zone_class": "red", "permission_required": False}})
    assert [z["zone_class"] for z in zs] == ["red", "red"]
    assert [z["id"] for z in prohibited] == ["red1"]


# ── upload_mission: a session command with drone access ───────────────────

class _Tel:
    is_connected = True

    def __init__(self):
        self.uploaded = None

    async def upload_mission(self, waypoints, terrain_follow=False):
        self.uploaded = waypoints
        return True, ""


def _give_link(live, sid, drone):
    s = session(live, sid)
    tel = _Tel()
    live.sm._telemetry[s.session_id] = tel
    s.drone = drone
    return s, tel


async def test_upload_mission_is_a_session_command_with_drone_access(live, zones, stored):
    w = await world(live)
    handler = live.sio.handlers["/"]["upload_mission"]
    own = {"id": "d-own", "workspace_id": w.iith["id"], "is_simulated": False}
    foreign = {"id": "d-sky", "workspace_id": w.sky["id"], "is_simulated": False}
    clear = [{"lat": 17.580, "lng": 78.130, "altitude": 15.0},
             {"lat": 17.581, "lng": 78.131, "altitude": 15.0}]

    # A customer viewer cannot upload.
    await connect(live, "v", w.vic[1])
    _, tel = _give_link(live, "v", own)
    session(live, "v").drone_fly = True
    await handler("v", {"waypoints": clear})
    assert tel.uploaded is None and errors(live, "v")[-1]["code"] == "forbidden"

    # A customer pilot cannot upload to a drone of another workspace.
    await connect(live, "p", w.pat[1])
    s, tel = _give_link(live, "p", foreign)
    s.drone_fly = False
    await handler("p", {"waypoints": clear})
    assert tel.uploaded is None and errors(live, "p")[-1]["code"] == "drone_not_in_workspace"

    # Their own drone: uploaded.
    s, tel = _give_link(live, "p", own)
    s.drone_fly = True
    await handler("p", {"waypoints": clear})
    assert tel.uploaded == clear
    assert live.rec.of("mission_upload_result", "p")[-1]["ok"] is True

    # Through a red zone: blocked with a permit path, then flown under one.
    tel.uploaded = None
    await handler("p", {"waypoints": CROSS_RED})
    res = live.rec.of("mission_upload_result", "p")[-1]
    assert res["blocked"] == "red" and res["can_request"] is True and tel.uploaded is None
    stored.append(fresh(workspace_id=w.iith["id"], drone_id="d-own"))
    await handler("p", {"waypoints": CROSS_RED})
    res = live.rec.of("mission_upload_result", "p")[-1]
    assert res["ok"] is True and res["permit_id"] == "p1" and tel.uploaded == CROSS_RED


async def test_staff_upload_also_checks_drone_access(live):
    w = await world(live)
    await connect(live, "op", w.hp[1])
    s, tel = _give_link(live, "op", {"id": "dc", "workspace_id": w.iith["id"], "is_simulated": False})
    s.drone_fly = False
    assert await socket_guard.require_session_fly("op", "upload_mission", {}) is False
    assert errors(live, "op")[-1]["code"] == "drone_not_in_workspace"
