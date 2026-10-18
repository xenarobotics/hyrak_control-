"""
Phase 2b against a real Postgres - opt in (docs/ACCESS_MODEL.md 8b).

Skipped unless HYRAK_TEST_DATABASE_URL names a DISPOSABLE database already
migrated to head (`DATABASE_URL=<that url> alembic upgrade head`). Never
point it at the live `hyrak` database: it writes rows.

Runs the real HTTP routes (httpx over ASGI, one event loop with the
engine) with the auth store on the same database, so workspaces, missions,
pads, route profiles, permits and audit rows are real rows:

  * workspace isolation of missions, pads and route profiles;
  * the permit request -> decide -> honour flow, area rules for airspace
    managers and managers, expiry, withdrawal, and the audit trail.

The rules themselves are unit-tested without a database in
test_mission_permits.py.
"""
import os
import uuid
from datetime import timedelta
from types import SimpleNamespace

import pytest

# Imported before any test's event loop exists: the server module installs
# its event loop policy on import.
import app.server  # noqa: F401,E402

URL = os.environ.get("HYRAK_TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="HYRAK_TEST_DATABASE_URL not set")

PW = "correct-horse-battery"


def box(x0, y0, x1, y1):
    return {"type": "Polygon",
            "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}


RED_ID = f"red-{uuid.uuid4().hex[:8]}"
ORANGE_ID = f"orange-{uuid.uuid4().hex[:8]}"
ZONES = [
    {"id": RED_ID, "name": "Lab", "zone_class": "red", "permission_required": True,
     "geometry": box(78.120, 17.590, 78.122, 17.592)},
    {"id": ORANGE_ID, "name": "Hostel", "zone_class": "orange", "permission_required": True,
     "geometry": box(78.124, 17.590, 78.126, 17.592)},
]
CROSS_RED = [{"lat": 17.589, "lng": 78.121, "altitude": 20.0, "type": "takeoff"},
             {"lat": 17.593, "lng": 78.121, "altitude": 20.0}]
CLEAR = [{"lat": 17.580, "lng": 78.130, "altitude": 15.0},
         {"lat": 17.581, "lng": 78.131, "altitude": 15.0}]


@pytest.fixture
async def cl(monkeypatch):
    import httpx
    from app.auth import service
    from app.config import get_settings
    from app.db import engine
    from app.zones import engine as zone_engine
    dbname = URL.split("?", 1)[0].rsplit("/", 1)[-1]
    assert dbname != "hyrak", "refusing to run against the live database"
    monkeypatch.setattr(get_settings(), "database_url", URL)
    assert await engine.init_db()
    service.reset_for_tests()
    zone_engine.set_zones(ZONES)
    from app.server import create_app
    api = create_app().other_asgi_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api), base_url="http://t") as c:
        yield c
    zone_engine.set_zones([])
    service.reset_for_tests()
    await engine.close_db()


def ok(r, code=200):
    assert r.status_code == code, (r.status_code, r.text)
    return r.json()


def hdr(token):
    return {"Authorization": f"Bearer {token}"}


async def account(name, role=None):
    from app.auth import service
    name = f"{name}-{uuid.uuid4().hex[:6]}"
    rec = await service.create_user(name, PW, role, email=f"{name}@example.com",
                                    email_verified=True)
    token, _, _ = await service.login(name, PW, "127.0.0.1")
    return SimpleNamespace(id=rec.id, name=name, h=hdr(token))


async def world(cl):
    """Founder; IITH (operating area around the zones) with client Civil;
    SkyServe elsewhere; IITH pilot / viewer / owner, a Sky owner, an IITH
    manager, airspace managers inside and outside the zones' area."""
    f = await account("founder", "admin")
    iith = ok(await cl.post("/api/workspaces", headers=f.h, json={
        "name": f"IITH {uuid.uuid4().hex[:4]}", "kind": "organization",
        "operating_area": box(78.0, 17.0, 79.0, 18.0)}))["workspace"]
    civil = ok(await cl.post("/api/workspaces", headers=f.h, json={
        "name": "Civil", "kind": "client", "parent_id": iith["id"]}))["workspace"]
    sky = ok(await cl.post("/api/workspaces", headers=f.h, json={
        "name": f"Sky {uuid.uuid4().hex[:4]}", "kind": "organization",
        "operating_area": box(77.0, 12.0, 78.0, 13.0)}))["workspace"]
    w = SimpleNamespace(f=f, iith=iith, civil=civil, sky=sky)
    for attr, ws, role in (("pat", iith, "pilot"), ("vic", iith, "viewer"),
                           ("olga", iith, "owner"), ("sam", sky, "owner")):
        u = await account(attr)
        ok(await cl.post(f"/api/workspaces/{ws['id']}/members", headers=f.h,
                         json={"login": u.name, "role": role}))
        setattr(w, attr, u)
    w.mgr = await account("mgr", "viewer")                  # HYRAK viewer + IITH manager
    ok(await cl.post(f"/api/workspaces/{iith['id']}/members", headers=f.h,
                     json={"login": w.mgr.name, "role": "manager"}))
    w.air_in = await account("airin")
    ok(await cl.post("/api/workspaces/00000000-0000-0000-0000-000000000001/members", headers=f.h,
                     json={"login": w.air_in.name, "role": "airspace",
                           "area": box(78.1, 17.5, 78.2, 17.6)}))
    w.air_out = await account("airout")
    ok(await cl.post("/api/workspaces/00000000-0000-0000-0000-000000000001/members", headers=f.h,
                     json={"login": w.air_out.name, "role": "airspace",
                           "area": box(77.0, 12.0, 78.0, 13.0)}))
    return w


# ── Isolation ─────────────────────────────────────────────────────────────

async def test_missions_belong_to_their_workspace(cl):
    w = await world(cl)
    m = ok(await cl.post("/api/missions", headers=w.pat.h, json={
        "name": "Survey A", "waypoints": CLEAR}))["mission"]
    assert m["workspace_id"] == w.iith["id"] and m["name"] == "Survey A"
    assert m["waypoint_count"] == 2 and m["profile_name"] == "Manual"
    # Planned in the client below: allowed by inheritance.
    mc = ok(await cl.post("/api/missions", headers=w.pat.h, json={
        "name": "Civil job", "waypoints": CLEAR, "workspace_id": w.civil["id"]}))["mission"]

    mine = ok(await cl.get(f"/api/missions?workspace_id={w.iith['id']}", headers=w.pat.h))["missions"]
    assert [x["id"] for x in mine] == [m["id"]] and mine[0]["editable"] is True
    # The viewer reads, cannot write.
    seen = ok(await cl.get("/api/missions", headers=w.vic.h))["missions"]
    assert [x["id"] for x in seen] == [m["id"]] and seen[0]["editable"] is False
    ok(await cl.get(f"/api/missions/{m['id']}", headers=w.vic.h))
    assert (await cl.post("/api/missions", headers=w.vic.h,
                          json={"name": "x", "waypoints": CLEAR})).status_code == 403
    assert (await cl.patch(f"/api/missions/{m['id']}", headers=w.vic.h,
                           json={"name": "y"})).status_code == 403
    assert (await cl.delete(f"/api/missions/{m['id']}", headers=w.vic.h)).status_code == 403

    # Another customer sees nothing of it: 404, never 403.
    assert ok(await cl.get("/api/missions", headers=w.sam.h))["missions"] == []
    for call in (cl.get(f"/api/missions/{m['id']}", headers=w.sam.h),
                 cl.patch(f"/api/missions/{m['id']}", headers=w.sam.h, json={"name": "z"}),
                 cl.delete(f"/api/missions/{m['id']}", headers=w.sam.h),
                 cl.get(f"/api/missions?workspace_id={w.iith['id']}", headers=w.sam.h)):
        assert (await call).status_code == 404
    assert (await cl.post("/api/missions", headers=w.sam.h, json={
        "name": "x", "waypoints": CLEAR, "workspace_id": w.iith["id"]})).status_code == 404

    # Edit and delete by the owner workspace.
    edited = ok(await cl.patch(f"/api/missions/{m['id']}", headers=w.pat.h, json={
        "name": "Survey B", "waypoints": CROSS_RED}))["mission"]
    assert edited["name"] == "Survey B" and edited["zones"][0]["id"] == RED_ID
    ok(await cl.delete(f"/api/missions/{mc['id']}", headers=w.olga.h))
    # Staff keep reading every workspace's missions; the founder edits too.
    all_ids = {x["id"] for x in ok(await cl.get("/api/missions", headers=w.f.h))["missions"]}
    assert m["id"] in all_ids and mc["id"] not in all_ids
    ok(await cl.patch(f"/api/missions/{m['id']}", headers=w.f.h, json={"name": "By founder"}))
    # HYRAK's own missions are not shared vocabulary: a customer neither
    # lists nor opens them.
    hm = ok(await cl.post("/api/missions", headers=w.f.h, json={
        "name": "Delivery leg", "waypoints": CLEAR}))["mission"]
    assert hm["workspace_id"] == "00000000-0000-0000-0000-000000000001"
    for who in (w.pat, w.vic, w.sam):
        assert (await cl.get(f"/api/missions/{hm['id']}", headers=who.h)).status_code == 404
        assert (await cl.patch(f"/api/missions/{hm['id']}", headers=who.h,
                               json={"name": "x"})).status_code == 404
        listed = ok(await cl.get("/api/missions", headers=who.h))["missions"]
        assert hm["id"] not in {x["id"] for x in listed}
        assert (await cl.get("/api/missions?workspace_id=00000000-0000-0000-0000-000000000001",
                             headers=who.h)).status_code == 403
    # A drone named on a plan must be the workspace's.
    assert (await cl.post("/api/missions", headers=w.pat.h, json={
        "name": "x", "waypoints": CLEAR, "drone_id": str(uuid.uuid4())})).status_code == 409


async def test_planner_runs_in_the_customers_workspace(cl):
    w = await world(cl)
    r = ok(await cl.post("/api/missions/plan", headers=w.pat.h, json={
        "start": {"lat": 17.580, "lng": 78.130}, "goal": {"lat": 17.582, "lng": 78.132},
        "name": "Auto"}))
    assert r["ok"] and r["mission"]["workspace_id"] == w.iith["id"]
    assert (await cl.post("/api/missions/plan", headers=w.vic.h, json={
        "start": {"lat": 17.58, "lng": 78.13}, "goal": {"lat": 17.582, "lng": 78.132}})).status_code == 403


async def test_pads_are_per_workspace_and_hyraks_stay_global(cl):
    w = await world(cl)
    hy = ok(await cl.post("/api/pads", headers=w.f.h, json={
        "name": f"HY-{uuid.uuid4().hex[:4]}", "lat": 17.59, "lng": 78.12}))["pad"]
    assert hy["workspace_id"] == "00000000-0000-0000-0000-000000000001"
    mine = ok(await cl.post("/api/pads", headers=w.pat.h, json={
        "name": "Home", "lat": 17.58, "lng": 78.13}))["pad"]
    # Same name in another workspace is fine (unique per workspace).
    ok(await cl.post("/api/pads", headers=w.sam.h, json={"name": "Home", "lat": 12.5, "lng": 77.5}))
    assert (await cl.post("/api/pads", headers=w.pat.h, json={
        "name": "Home", "lat": 17.0, "lng": 78.0})).status_code == 409
    assert (await cl.post("/api/pads", headers=w.pat.h, json={
        "name": "Base", "lat": 17.0, "lng": 78.0, "kind": "station"})).status_code == 400

    pads = ok(await cl.get(f"/api/pads?workspace_id={w.iith['id']}", headers=w.vic.h))["pads"]
    by = {p["id"]: p for p in pads}
    assert by[mine["id"]]["global"] is False and by[hy["id"]]["global"] is True
    assert by[hy["id"]]["editable"] is False
    assert all(p["workspace_id"] in (w.iith["id"], hy["workspace_id"]) for p in pads)
    # Customers never write HYRAK's pads, nor see another customer's.
    assert (await cl.patch(f"/api/pads/{hy['id']}", headers=w.pat.h, json={"name": "x"})).status_code == 403
    assert (await cl.patch(f"/api/pads/{mine['id']}", headers=w.sam.h, json={"name": "x"})).status_code == 404
    assert (await cl.delete(f"/api/pads/{mine['id']}", headers=w.vic.h)).status_code == 403
    ok(await cl.delete(f"/api/pads/{mine['id']}", headers=w.pat.h))
    # The delivery board (staff, no workspace) still lists HYRAK's only.
    assert all(p["workspace_id"] == hy["workspace_id"]
               for p in ok(await cl.get("/api/pads", headers=w.f.h))["pads"])
    # Deliveries resolve HYRAK's pads only.
    from app.tasks import service as task_service
    assert await task_service.resolve_pad("Home") is None


async def test_route_profiles_are_per_workspace(cl):
    w = await world(cl)
    from app.planner import profiles
    await profiles.ensure_builtins()
    rules = {"categories": {"road": {"mode": "prefer", "weight": 0.5}}}
    p = ok(await cl.post("/api/route-profiles", headers=w.pat.h, json={
        "name": "Roads please", "rules": rules}))["profile"]
    assert p["workspace_id"] == w.iith["id"]
    meta = ok(await cl.get(f"/api/planner/meta?workspace_id={w.iith['id']}", headers=w.vic.h))
    names = {x["name"]: x for x in meta["profiles"]}
    assert "Roads please" in names and "Direct" in names
    assert names["Direct"]["global"] is True and names["Direct"]["editable"] is False
    sky_meta = ok(await cl.get("/api/planner/meta", headers=w.sam.h))
    assert "Roads please" not in {x["name"] for x in sky_meta["profiles"]}
    # Another workspace cannot plan with it, nor touch it; HYRAK's builtins
    # stay HYRAK's.
    assert (await cl.post("/api/missions/plan", headers=w.sam.h, json={
        "start": {"lat": 12.5, "lng": 77.5}, "goal": {"lat": 12.51, "lng": 77.51},
        "profile": p["id"]})).status_code == 404
    assert (await cl.patch(f"/api/route-profiles/{p['id']}", headers=w.sam.h,
                           json={"description": "x"})).status_code == 404
    direct = names["Direct"]
    assert (await cl.patch(f"/api/route-profiles/{direct['id']}", headers=w.pat.h,
                           json={"description": "x"})).status_code == 403
    r = ok(await cl.post("/api/missions/plan", headers=w.pat.h, json={
        "start": {"lat": 17.58, "lng": 78.13}, "goal": {"lat": 17.581, "lng": 78.131},
        "profile": "Roads please"}))
    assert r["mission"]["profile_name"] == "Roads please"
    ok(await cl.delete(f"/api/route-profiles/{p['id']}", headers=w.olga.h))


# ── Permits ───────────────────────────────────────────────────────────────

async def _audit(cl, w, action):
    events = ok(await cl.get(f"/api/audit?workspace_id={w.iith['id']}", headers=w.f.h))["events"]
    return [e for e in events if e["action"] == action]


async def _drone(ws_id):
    from app.db import get_session
    from app.db.models import Drone
    d = Drone(hardware_uid=f"uid-{uuid.uuid4().hex}", name="Pat's quad", workspace_id=ws_id)
    async with get_session() as db:
        db.add(d)
        await db.commit()
        return d.to_dict()


async def test_permit_request_decide_and_honour(cl):
    from app.permits import service as permits
    w = await world(cl)
    drone = await _drone(w.iith["id"])
    now = permits.now_utc()
    window = {"valid_from": now.isoformat(), "valid_until": (now + timedelta(hours=2)).isoformat()}

    # Nothing restricted: no permit needed. A viewer cannot ask.
    assert (await cl.post("/api/permits", headers=w.pat.h, json={
        "description": "Survey", "waypoints": CLEAR, **window})).status_code == 400
    assert (await cl.post("/api/permits", headers=w.vic.h, json={
        "description": "Survey", "waypoints": CROSS_RED, **window})).status_code == 403
    assert (await cl.post("/api/permits", headers=w.pat.h, json={
        "description": "Survey", "waypoints": CROSS_RED})).status_code == 400      # no window
    # The gate refuses before any permit.
    gate = await permits.gate_upload(drone, CROSS_RED, ack_orange=False)
    assert gate["blocked"] == "red"
    check = ok(await cl.post("/api/zones/check-path", headers=w.pat.h, json={
        "waypoints": CROSS_RED, "drone_id": drone["id"]}))
    assert check["needs"] == "permit" and check["permit"] is None

    p = ok(await cl.post("/api/permits", headers=w.pat.h, json={
        "description": "Roof inspection", "waypoints": CROSS_RED, "drone_id": drone["id"],
        **window}))["permit"]
    assert p["status"] == "pending" and p["workspace_id"] == w.iith["id"]
    assert [z["id"] for z in p["zones"]] == [RED_ID] and p["drone_name"] == "Pat's quad"
    assert p["can_decide"] is False
    assert len(await _audit(cl, w, "permit.request")) == 1

    # Customers see their own permits; another customer does not.
    mine = ok(await cl.get(f"/api/permits?workspace_id={w.iith['id']}", headers=w.vic.h))["permits"]
    assert [x["id"] for x in mine] == [p["id"]]
    assert (await cl.get(f"/api/permits/{p['id']}", headers=w.sam.h)).status_code == 404
    assert ok(await cl.get("/api/permits", headers=w.pat.h))["permits"] == []   # no queue

    # Who can decide: the airspace manager whose area covers it, IITH's
    # manager inside IITH's area, founders. Not the one outside, not the
    # customer owner, not another workspace's owner.
    queue_in = ok(await cl.get("/api/permits", headers=w.air_in.h))["permits"]
    assert p["id"] in [x["id"] for x in queue_in]
    assert p["id"] not in [x["id"] for x in ok(await cl.get("/api/permits", headers=w.air_out.h))["permits"]]
    assert p["id"] in [x["id"] for x in ok(await cl.get("/api/permits", headers=w.mgr.h))["permits"]]
    # (Staff read every workspace's plans, so the airspace manager outside
    # the area gets the area refusal rather than a 404.)
    for who, code in ((w.air_out, 409), (w.olga, 403), (w.sam, 404), (w.pat, 403)):
        r = await cl.post(f"/api/permits/{p['id']}/decision", headers=who.h, json={"approve": True})
        assert r.status_code == code, (who.name, r.status_code, r.text)

    approved = ok(await cl.post(f"/api/permits/{p['id']}/decision", headers=w.air_in.h,
                                json={"approve": True, "note": "Weekday mornings only"}))["permit"]
    assert approved["status"] == "approved" and approved["decision_note"] == "Weekday mornings only"
    assert approved["decided_by_name"] == w.air_in.name
    assert len(await _audit(cl, w, "permit.approve")) == 1
    # Already decided: nothing more to approve.
    assert (await cl.post(f"/api/permits/{p['id']}/decision", headers=w.mgr.h,
                          json={"approve": True})).status_code == 409

    # Honoured: the gate, the path check and the monitor's permitted zones.
    gate = await permits.gate_upload(drone, CROSS_RED, ack_orange=False)
    assert gate["ok"] and gate["permit"]["id"] == p["id"]
    check = ok(await cl.post("/api/zones/check-path", headers=w.pat.h, json={
        "waypoints": CROSS_RED, "drone_id": drone["id"]}))
    assert check["needs"] == "none" and check["permit"]["id"] == p["id"]
    usable = await permits.usable_for_drone(drone)
    assert RED_ID in permits.permitted_zone_ids_at(usable, 17.591, 78.121)
    # Not for another drone of the workspace (this permit names one).
    other = await _drone(w.iith["id"])
    assert (await permits.gate_upload(other, CROSS_RED, ack_orange=False))["blocked"] == "red"

    # Expired: no longer honoured, shown as expired.
    from sqlalchemy import update
    from app.db import get_session
    from app.db.models import Permit
    async with get_session() as db:
        await db.execute(update(Permit).where(Permit.id == p["id"])
                         .values(valid_until=now - timedelta(seconds=1)))
        await db.commit()
    assert (await permits.gate_upload(drone, CROSS_RED, ack_orange=False))["blocked"] == "red"
    got = ok(await cl.get(f"/api/permits/{p['id']}", headers=w.pat.h))["permit"]
    assert got["status_effective"] == "expired" and got["in_window"] is False

    # Revoke (by a decider) and withdraw (by the workspace) are audited too.
    async with get_session() as db:
        await db.execute(update(Permit).where(Permit.id == p["id"])
                         .values(valid_until=now + timedelta(hours=2)))
        await db.commit()
    ok(await cl.post(f"/api/permits/{p['id']}/decision", headers=w.mgr.h, json={"approve": False}))
    assert (await permits.gate_upload(drone, CROSS_RED, ack_orange=False))["blocked"] == "red"
    assert len(await _audit(cl, w, "permit.revoke")) == 1

    p2 = ok(await cl.post("/api/permits", headers=w.olga.h, json={
        "description": "Area work", "area": box(78.118, 17.588, 78.127, 17.594), **window}))["permit"]
    assert p2["kind"] == "area" and {z["id"] for z in p2["zones"]} == {RED_ID, ORANGE_ID}
    assert p2["drone_id"] is None
    # The manager of IITH decides it; denied permits never count.
    ok(await cl.post(f"/api/permits/{p2['id']}/decision", headers=w.mgr.h, json={"approve": False}))
    assert (await permits.gate_upload(drone, CROSS_RED, ack_orange=False))["blocked"] == "red"
    assert len(await _audit(cl, w, "permit.deny")) == 1

    p3 = ok(await cl.post("/api/permits", headers=w.olga.h, json={
        "description": "Area work again", "area": box(78.118, 17.588, 78.127, 17.594),
        **window}))["permit"]
    ok(await cl.post(f"/api/permits/{p3['id']}/decision", headers=w.f.h, json={"approve": True}))
    # Any drone of the workspace, any path inside the area.
    assert (await permits.gate_upload(other, CROSS_RED, ack_orange=False))["ok"]
    assert (await cl.post(f"/api/permits/{p3['id']}/withdraw", headers=w.vic.h)).status_code == 403
    ok(await cl.post(f"/api/permits/{p3['id']}/withdraw", headers=w.pat.h))
    assert (await permits.gate_upload(other, CROSS_RED, ack_orange=False))["blocked"] == "red"
    assert len(await _audit(cl, w, "permit.withdraw")) == 1
    assert len(await _audit(cl, w, "permit.request")) == 3


async def test_prohibited_red_zone_admits_no_request(cl):
    from app.permits import service as permits
    from app.zones import engine as zone_engine
    w = await world(cl)
    zone_engine.set_zones([{**ZONES[0], "permission_required": False}])
    now = permits.now_utc()
    r = await cl.post("/api/permits", headers=w.pat.h, json={
        "description": "Please", "waypoints": CROSS_RED,
        "valid_until": (now + timedelta(hours=1)).isoformat()})
    assert r.status_code == 409 and "prohibited" in r.json()["detail"]
    check = ok(await cl.post("/api/zones/check-path", headers=w.pat.h, json={"waypoints": CROSS_RED}))
    assert check["needs"] == "prohibited"


async def test_editing_a_zone_supersedes_its_approved_permits(cl):
    import random
    from app.permits import service as permits
    w = await world(cl)
    drone = await _drone(w.iith["id"])
    # A fresh red zone in IITH's area at a random spot (the test database
    # keeps zones from earlier runs; the route reloads them all).
    lat0, lng0 = 17.2 + random.random() * 0.6, 78.2 + random.random() * 0.6
    z = ok(await cl.post("/api/zones", headers=w.f.h, json={
        "name": "Test red", "zone_class": "red",
        "geometry": box(lng0, lat0, lng0 + 0.002, lat0 + 0.002)}))["zone"]
    zid = z["properties"]["id"]
    try:
        path = [{"lat": lat0 - 0.001, "lng": lng0 + 0.001, "altitude": 20.0},
                {"lat": lat0 + 0.003, "lng": lng0 + 0.001, "altitude": 20.0}]
        now = permits.now_utc()
        p = ok(await cl.post("/api/permits", headers=w.pat.h, json={
            "description": "Crossing", "waypoints": path, "drone_id": drone["id"],
            "valid_until": (now + timedelta(hours=1)).isoformat()}))["permit"]
        assert [x["id"] for x in p["zones"]] == [zid]
        ok(await cl.post(f"/api/permits/{p['id']}/decision", headers=w.f.h, json={"approve": True}))
        assert (await permits.gate_upload(drone, path, ack_orange=False))["ok"]

        # A rename changes nothing about the permit.
        ok(await cl.patch(f"/api/zones/{zid}", headers=w.f.h, json={"name": "Renamed"}))
        assert ok(await cl.get(f"/api/permits/{p['id']}", headers=w.pat.h))["permit"]["status"] == "approved"
        # Raising the floor does: superseded, audited, no longer honoured.
        gen = permits.generation()
        ok(await cl.patch(f"/api/zones/{zid}", headers=w.f.h, json={"floor_m": 5}))
        got = ok(await cl.get(f"/api/permits/{p['id']}", headers=w.pat.h))["permit"]
        assert got["status"] == "superseded" and "floor_m" in got["decision_note"]
        assert permits.generation() > gen
        assert len(await _audit(cl, w, "permit.supersede")) == 1
        assert (await permits.gate_upload(drone, path, ack_orange=False))["blocked"] == "red"
        # Superseded is final: it cannot be approved again.
        assert (await cl.post(f"/api/permits/{p['id']}/decision", headers=w.f.h,
                              json={"approve": True})).status_code == 409
        # A pending request on a zone made prohibited cannot be approved.
        p2 = ok(await cl.post("/api/permits", headers=w.pat.h, json={
            "description": "Again", "waypoints": path, "drone_id": drone["id"],
            "valid_until": (now + timedelta(hours=1)).isoformat()}))["permit"]
        ok(await cl.patch(f"/api/zones/{zid}", headers=w.f.h, json={"permission_required": False}))
        r = await cl.post(f"/api/permits/{p2['id']}/decision", headers=w.f.h, json={"approve": True})
        assert r.status_code == 409 and "prohibited" in r.json()["detail"]
    finally:
        ok(await cl.delete(f"/api/zones/{zid}", headers=w.f.h))
