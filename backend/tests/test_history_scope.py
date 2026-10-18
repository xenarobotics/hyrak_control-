"""
Phase 2b: staff monitoring and per-workspace history and avoidance
(docs/ACCESS_MODEL.md 8b).

Same harness as test_live_scope.py (the real server object against the
memory auth store). The database is offline in this suite, so the history
routes are checked at their seam: the workspace filter each route hands to
the persistence layer, and the single-row lookups with a stand-in session.
The SQL itself runs against Postgres in test_auth_dbstore.py (opt in).
"""
import asyncio
from types import SimpleNamespace

import pytest

from app.auth import data_scope, live_scope, perms
from app.auth.store import PLATFORM_WORKSPACE_ID
from test_live_scope import (  # noqa: F401  (live is a fixture)
    account, connect, hdr, hold_link, live, ok, session, world,
)


def fake_tel(armed=False, in_air=False):
    snap = SimpleNamespace(
        position=SimpleNamespace(latitude_deg=17.6, longitude_deg=78.1, relative_altitude_m=5.0),
        heading_deg=90.0, battery=SimpleNamespace(remaining_percent=80.0),
        flight_mode=SimpleNamespace(is_armed=armed, is_in_air=in_air, mode="HOLD"))
    return SimpleNamespace(is_connected=True, snapshot=snap)


async def staffed(live):
    """world() plus: mgr (HYRAK viewer, manager of IITH), sm (HYRAK viewer,
    manager of SkyServe), air (airspace manager), sky (SkyServe owner)."""
    w = await world(live)
    fh = hdr(w.founder[1])
    w.mgr = await account("mgr", "viewer")
    w.smgr = await account("smgr", "viewer")
    ok(live.cl.post(f"/api/workspaces/{w.iith['id']}/members", headers=fh,
                    json={"login": "mgr", "role": "manager"}))
    ok(live.cl.post(f"/api/workspaces/{w.sky['id']}/members", headers=fh,
                    json={"login": "smgr", "role": "manager"}))
    w.skyo = await account("skyo")
    ok(live.cl.post(f"/api/workspaces/{w.sky['id']}/members", headers=fh,
                    json={"login": "skyo", "role": "owner"}))
    return w


async def scope_of(rec_token_pair):
    from app.auth import service
    user = await service.authenticate(rec_token_pair[1])
    return await data_scope.scope_for(user)


# ── the scope itself ─────────────────────────────────────────────────────

async def test_data_scope_follows_view_by_the_perms(live):
    w = await staffed(live)
    I, C, S, H = w.iith["id"], w.civil["id"], w.sky["id"], PLATFORM_WORKSPACE_ID
    founder = await scope_of(w.founder)
    assert founder.everything and founder.ids() is None and founder.can("deleted-ws")
    mgr = await scope_of(w.mgr)
    assert set(mgr.ids()) == {I, C, H}            # managed org + its client, HYRAK as viewer
    assert not mgr.can(S)
    assert mgr.can(I, perms.SESSIONS_TAKEOVER) and not mgr.can(H, perms.SESSIONS_TAKEOVER)
    hp = await scope_of(w.hp)
    assert hp.ids() == [H] and hp.can(H, perms.FLY)
    pat = await scope_of(w.pat)
    assert set(pat.ids()) == {I, C} and not pat.staff
    assert (await scope_of(w.skyo)).ids() == [S]
    # Narrowing to one workspace: outside the scope reads nothing.
    assert pat.narrow(C) == [C] and pat.narrow(S) == [] and set(pat.narrow(None)) == {I, C}
    assert founder.narrow(S) == [S]
    hyrak = founder.tree.get(H)
    air = SimpleNamespace(workspace_id=H, workspace_path=hyrak.path, workspace_kind="platform",
                          role="airspace", area={"type": "Polygon"})
    assert data_scope.scope_from([air], founder.tree).ids() == []   # no view anywhere
    legacy = data_scope.scope_from((), None, legacy=True)
    assert legacy.ids() == [H] and legacy.can(H, perms.FLY)


# ── /api/sessions, the console socket ─────────────────────────────────────

async def test_session_list_is_scoped_and_carries_the_monitor_fields(live):
    w = await staffed(live)
    await connect(live, "p", w.pat[1])                              # IITH
    await connect(live, "k", w.skyo[1])                             # SkyServe
    await connect(live, "h", w.hp[1])                               # HYRAK
    s = hold_link(live, "p", {"id": "d1", "name": "Hawk", "workspace_id": w.iith["id"]})
    live.sm._telemetry[s.session_id] = fake_tel(armed=True, in_air=True)
    s.link_kind = live_scope.RELAY_LINK
    s.is_streaming = True

    def ids(token):
        return {x["session_id"] for x in ok(live.cl.get("/api/sessions", headers=hdr(token)))["sessions"]}
    sid = {k: session(live, k).session_id for k in ("p", "k", "h")}
    assert ids(w.founder[1]) == set(sid.values())
    assert ids(w.mgr[1]) == {sid["p"], sid["h"]}                     # IITH (managed) + HYRAK (viewer)
    assert ids(w.smgr[1]) == {sid["k"], sid["h"]}
    assert ids(w.hp[1]) == {sid["h"]}
    for customer in (w.pat, w.skyo):
        assert live.cl.get("/api/sessions", headers=hdr(customer[1])).status_code == 403
    row = next(x for x in ok(live.cl.get("/api/sessions", headers=hdr(w.mgr[1])))["sessions"]
               if x["session_id"] == sid["p"])
    assert row["workspace_id"] == w.iith["id"] and row["workspace_name"] == "IITH"
    assert row["username"] == "pat" and row["role"] == "pilot" and row["staff"] is False
    assert row["link_kind"] == "client_relay" and row["video"] is True
    assert row["drone"]["name"] == "Hawk" and row["ai_mode"] == "manual-control"
    assert row["armed"] is True and row["in_air"] is True and row["takeover"] is None
    assert row["live"]["lat"] == 17.6


async def test_console_socket_is_staff_and_watches_only_what_it_can_view(live):
    w = await staffed(live)
    await connect(live, "p", w.pat[1])
    await connect(live, "k", w.skyo[1])
    await connect(live, "m", w.mgr[1])
    await connect(live, "c", w.olga[1])
    h = live.sio.handlers["/"]
    await h["admin_hello"]("m", {})
    assert session(live, "m").is_admin
    await h["admin_hello"]("c", {})                                 # customer owner: no
    assert not session(live, "c").is_admin
    assert live.rec.of("error", "c")[-1]["code"] == "forbidden"
    from app.sessions import observer
    p_id, k_id = session(live, "p").session_id, session(live, "k").session_id
    await h["watch_session"]("m", {"session_id": p_id})
    assert observer.has_watchers(p_id)
    await h["watch_session"]("m", {"session_id": k_id})             # SkyServe: not theirs
    assert not observer.has_watchers(k_id)
    assert live.rec.of("error", "m")[-1]["msg"] == "Session not found"
    await h["watch_session"]("m", {"session_id": "nope"})
    assert live.rec.of("error", "m")[-1]["msg"] == "Session not found"


async def test_admin_alerts_reach_only_observers_who_can_see_the_session(live):
    w = await staffed(live)
    from app.events import admin_events
    await connect(live, "k", w.skyo[1])
    for sid, token in (("m", w.mgr[1]), ("sm", w.smgr[1]), ("f", w.founder[1])):
        await connect(live, sid, token)
        session(live, sid).is_admin = True
    await admin_events.emit_admin_alert(live.sm, {"session_id": session(live, "k").session_id,
                                                  "message": "red zone"})
    got = {t for e, d, t in live.rec.emitted if e == "admin_alert"}
    assert got == {"sm", "f"}


async def test_workspace_activity_view(live, monkeypatch):
    w = await staffed(live)
    from app.api import routes
    seen = {}

    async def flights(ids, *, limit=30, drone_id=None):
        seen["ids"] = ids
        return [{"id": "f1"}]
    monkeypatch.setattr(routes, "_list_flights", flights)
    await connect(live, "p", w.pat[1])
    url = f"/api/workspaces/{w.iith['id']}/activity"
    a = ok(live.cl.get(url, headers=hdr(w.mgr[1])))
    assert set(seen["ids"]) == {w.iith["id"], w.civil["id"]}
    assert [s["username"] for s in a["sessions"]] == ["pat"] and a["flights"] == [{"id": "f1"}]
    assert isinstance(a["audit"], list)                             # manager: audit.view
    assert ok(live.cl.get(url, headers=hdr(w.pat[1])))["audit"] is None   # pilot: no audit
    for token in (w.smgr[1], w.skyo[1], w.hp[1]):
        assert live.cl.get(url, headers=hdr(token)).status_code == 404
    hy = ok(live.cl.get(f"/api/workspaces/{PLATFORM_WORKSPACE_ID}/activity", headers=hdr(w.founder[1])))
    assert seen["ids"] == [PLATFORM_WORKSPACE_ID] and hy["sessions"] == []


# ── history routes ───────────────────────────────────────────────────────

async def test_history_routes_hand_the_scope_to_the_store(live, monkeypatch):
    w = await staffed(live)
    from app.api import routes
    from app.vision import persistence
    calls = []

    def spy(name, result):
        async def fn(*a, **k):
            calls.append((name, k.get("workspace_ids", a[0] if a else None)))
            return result
        return fn
    monkeypatch.setattr(persistence, "list_crowd_history", spy("crowd", {"sessions": [], "alerts": []}))
    monkeypatch.setattr(persistence, "list_plate_history", spy("plate", []))
    monkeypatch.setattr(persistence, "list_sightings", spy("sight", []))
    monkeypatch.setattr(persistence, "clear_crowd_history", spy("clear", None))
    monkeypatch.setattr(routes, "_list_flights", spy("flights", []))
    I, C, S, H = w.iith["id"], w.civil["id"], w.sky["id"], PLATFORM_WORKSPACE_ID
    cl = live.cl

    def last(name):
        return [c for c in calls if c[0] == name][-1][1]
    ok(cl.get("/api/vision/crowd-history", headers=hdr(w.pat[1])))
    assert set(last("crowd")) == {I, C}
    ok(cl.get(f"/api/vision/plate-history?workspace_id={C}", headers=hdr(w.vic[1])))
    assert last("plate") == [C]
    ok(cl.get(f"/api/vision/plate-history?workspace_id={S}", headers=hdr(w.vic[1])))
    assert last("plate") == []                                      # not theirs: nothing
    ok(cl.get("/api/flights", headers=hdr(w.skyo[1])))
    assert last("flights") == [S]
    ok(cl.get("/api/drones/d1/flights", headers=hdr(w.hp[1])))
    assert last("flights") == [H]
    ok(cl.get("/api/flights", headers=hdr(w.founder[1])))
    assert last("flights") is None
    # Sightings (face matches) stay staff-only, per workspace.
    assert cl.get("/api/vision/sightings", headers=hdr(w.pat[1])).status_code == 403
    ok(cl.get("/api/vision/sightings", headers=hdr(w.mgr[1])))
    assert set(last("sight")) == {I, C, H}
    # Clearing: staff operators, only where they fly; customers never.
    assert cl.delete("/api/vision/crowd-history", headers=hdr(w.pat[1])).status_code == 403
    ok(cl.delete("/api/vision/crowd-history", headers=hdr(w.hp[1])))
    assert last("clear") == [H]
    ok(cl.delete("/api/vision/crowd-history", headers=hdr(w.mgr[1])))
    assert set(last("clear")) == {I, C}                              # no fly on HYRAK as a viewer
    ok(cl.delete("/api/vision/crowd-history", headers=hdr(w.founder[1])))
    assert last("clear") is None
    # The face gallery itself stays HYRAK staff.
    assert cl.get("/api/vision/face-gallery", headers=hdr(w.olga[1])).status_code == 403


class _Rows:
    def __init__(self, rows):
        self.rows = rows

    def scalar_one_or_none(self):
        return self.rows[0] if self.rows else None

    def scalars(self):
        return self

    def all(self):
        return self.rows


class _FakeDb:
    def __init__(self, flight):
        self.flight, self.n = flight, 0

    async def execute(self, q):
        samples = "flight_samples" in str(q)
        return _Rows([] if samples or not self.flight else [self.flight])

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


async def test_one_flight_and_its_csv_follow_the_flights_workspace(live, monkeypatch):
    w = await staffed(live)
    import app.db as db
    from datetime import datetime, timezone
    flight = SimpleNamespace(
        id="f1", drone_id="d1", session_id="s1", workspace_id=w.civil["id"],
        started_at=datetime(2026, 10, 18, tzinfo=timezone.utc), ended_at=None, duration_s=1.0,
        max_alt_m=1.0, distance_m=0.0, samples_count=0, crossed_orange=False, crossed_red=False)
    flight.to_dict = lambda: {"id": "f1", "workspace_id": w.civil["id"]}
    monkeypatch.setattr(db, "db_available", lambda: True)
    monkeypatch.setattr(db, "get_session", lambda: _FakeDb(flight))
    for token, want in ((w.vic[1], 200), (w.olga[1], 200), (w.mgr[1], 200), (w.founder[1], 200),
                        (w.skyo[1], 404), (w.hp[1], 404), (w.smgr[1], 404)):
        assert live.cl.get("/api/flights/f1", headers=hdr(token)).status_code == want, token
        assert live.cl.get("/api/flights/f1/download", headers=hdr(token)).status_code == want
    monkeypatch.setattr(db, "get_session", lambda: _FakeDb(None))
    assert live.cl.get("/api/flights/f1", headers=hdr(w.founder[1])).status_code == 404


async def test_plate_image_follows_the_rows_workspace(live, monkeypatch, tmp_path):
    w = await staffed(live)
    from app.vision import persistence
    img = tmp_path / "p.jpg"
    img.write_bytes(b"\xff\xd8jpeg")

    async def lookup(event_id):
        return (str(img), w.iith["id"]) if event_id == "e1" else (None, None)
    monkeypatch.setattr(persistence, "get_plate_image", lookup)
    assert live.cl.get("/api/vision/plate-history/e1/image", headers=hdr(w.vic[1])).status_code == 200
    assert live.cl.get("/api/vision/plate-history/e1/image", headers=hdr(w.skyo[1])).status_code == 404
    assert live.cl.get("/api/vision/plate-history/e2/image", headers=hdr(w.vic[1])).status_code == 404


# ── record time ──────────────────────────────────────────────────────────

class _Collect:
    added: list = []

    def add(self, row):
        _Collect.added.append(row)

    async def commit(self):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


async def test_vision_rows_are_stamped_with_the_sessions_workspace(monkeypatch):
    from app.vision import persistence
    _Collect.added = []
    monkeypatch.setattr(persistence, "db_available", lambda: True)
    monkeypatch.setattr(persistence, "get_session", lambda: _Collect())
    persistence.set_workspace_resolver({"s1": "ws-a"}.get)
    try:
        await persistence.persist_events("s1", [
            {"table": "crowd_alert", "message": "x"},
            {"table": "plate_event", "plate_text": "AB12", "workspace_id": "forged"},
        ])
        await persistence.persist_events("s-unknown", [{"table": "crowd_alert"}])
    finally:
        persistence.set_workspace_resolver(None)
    a, b, c = _Collect.added
    assert a.workspace_id == "ws-a" and b.workspace_id == "ws-a"    # the payload cannot pick
    assert c.workspace_id in (None, PLATFORM_WORKSPACE_ID)          # column default: HYRAK


async def test_session_manager_remembers_the_workspace_after_teardown(live):
    w = await staffed(live)
    ready = await connect(live, "p", w.pat[1])
    sid = ready["session_id"]
    assert live.sm.workspace_of(sid) == w.iith["id"]
    await live.sm.destroy(sid)
    assert live.sm.workspace_of(sid) == w.iith["id"] and live.sm.owner_of(sid) == w.pat[0].id


async def test_flights_take_the_drones_workspace(monkeypatch):
    from app.flights import recorder
    from test_recorder_arm_race import ARMED, _Db, _Flight
    _Db.inserted = []
    monkeypatch.setattr(recorder, "db_available", lambda: True)
    monkeypatch.setattr(recorder, "get_session", lambda: _Db())
    monkeypatch.setattr(recorder, "Flight", _Flight)

    async def registry(drone_id):
        return "ws-of-drone"
    monkeypatch.setattr(recorder, "_drone_workspace", registry)
    for sid in ("a", "b"):
        recorder._active.pop(sid, None)
    await recorder.on_snapshot("a", "d1", ARMED, workspace_id="ws-hint")
    await recorder.on_snapshot("b", "d1", ARMED)                   # swarm path: registry decides
    by_session = {f.session_id: f.workspace_id for f in _Db.inserted if isinstance(f, _Flight)}
    assert by_session == {"a": "ws-hint", "b": "ws-of-drone"}
    for sid in ("a", "b"):
        recorder._active.pop(sid, None)


# ── avoidance for customers ──────────────────────────────────────────────

async def test_customer_avoidance_on_their_own_drone(live):
    w = await staffed(live)
    from app.auth import service
    cl = live.cl
    await connect(live, "p", w.pat[1])
    s = hold_link(live, "p", {"id": "d1", "workspace_id": w.iith["id"]})
    s.drone_fly = True
    reads = ["/api/avoidance/d1/status", "/api/avoidance/d1/sensors", "/api/avoidance/d1/events",
             "/api/avoidance/d1/obstacles"]
    for path in reads:
        assert cl.get(path, headers=hdr(w.pat[1])).status_code == 200, path
        assert cl.get(path, headers=hdr(w.vic[1])).status_code == 200, path     # view
        assert cl.get(path, headers=hdr(w.skyo[1])).status_code == 404, path    # other customer
    enable = {"enabled": False}
    assert cl.post("/api/avoidance/d1/enable", headers=hdr(w.pat[1]), json=enable).status_code == 200
    assert cl.post("/api/avoidance/d1/enable", headers=hdr(w.vic[1]), json=enable).status_code == 404
    assert cl.post("/api/avoidance/d1/arm", headers=hdr(w.skyo[1]), json={"armed": False}).status_code == 404
    # A link to someone else's drone is read-only: no writes through it.
    s.drone_fly = False
    assert cl.post("/api/avoidance/d1/enable", headers=hdr(w.pat[1]), json=enable).status_code == 404
    assert cl.get("/api/avoidance/d1/status", headers=hdr(w.pat[1])).status_code == 200
    # Drone access alone (registry puts it in their workspace), no session.
    live.sm._telemetry.clear()
    service.memory_store()._drones["d2"] = {"id": "d2", "workspace_id": w.civil["id"]}
    assert cl.post("/api/avoidance/d2/enable", headers=hdr(w.pat[1]), json=enable).status_code == 200
    assert cl.get("/api/avoidance/d2/status", headers=hdr(w.skyo[1])).status_code == 404
    # Staff-only and global pieces.
    assert cl.get("/api/avoidance/status", headers=hdr(w.pat[1])).status_code == 403
    assert cl.get("/api/avoidance/auto/calibrate_person", headers=hdr(w.pat[1])).status_code == 404
    assert cl.get("/api/avoidance/hazards", headers=hdr(w.vic[1])).status_code == 200
    assert cl.post("/api/avoidance/hazards", headers=hdr(w.pat[1]),
                   json={"lat": 1, "lng": 1}).status_code == 403
    assert cl.post("/api/avoidance/hazards/clear", headers=hdr(w.olga[1])).status_code == 403
    # Staff keep the rank check: a HYRAK viewer reads, does not write.
    assert cl.get("/api/avoidance/d1/status", headers=hdr(w.hv[1])).status_code == 200
    assert cl.post("/api/avoidance/d1/enable", headers=hdr(w.hv[1]), json=enable).status_code == 403
    assert cl.post("/api/avoidance/d1/enable", headers=hdr(w.hp[1]), json=enable).status_code == 200
