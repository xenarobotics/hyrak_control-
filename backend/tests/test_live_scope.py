"""
Phase 2a: customers in the live app, scoped to their workspace
(docs/ACCESS_MODEL.md 8a).

Runs the real server object (create_app, no startup, no network) against
the memory auth store: the socket connect handler for the handshake,
resume and session_ready; the real socket handlers for the staff-only
refusals; socket_guard for the session guards, drone access and the safety
exception; the HTTP routes for REST scoping. Accounts and workspaces are
made through the HTTP API, like the frontend would.
"""
import asyncio
import inspect
from types import SimpleNamespace

import pytest
import socketio
from fastapi.testclient import TestClient

from app.auth import live_scope, service, socket_guard
from app.auth.store import PLATFORM_WORKSPACE_ID

PW = "correct-horse-battery"


class Recorder:
    def __init__(self):
        self.emitted, self.disconnected = [], []

    async def emit(self, event, data=None, to=None, room=None, **kw):
        self.emitted.append((event, data, to or room))

    async def disconnect(self, sid, **kw):
        self.disconnected.append(sid)

    async def enter_room(self, sid, room, **kw):
        pass

    def of(self, event, to=None):
        return [d for e, d, t in self.emitted if e == event and (to is None or t == to)]


@pytest.fixture
def live(monkeypatch):
    from app.events import admin_events
    from app.server import create_app
    from app.utils import geoip
    from app.webrtc import turn
    from app.zones import engine as zone_engine

    monkeypatch.setattr(service, "_db_up", lambda: False)
    service.reset_for_tests()
    service.allow_memory_writes(True)

    async def nothing(*a, **k):
        return None

    async def stun_only():
        return [{"urls": "stun:stun.example.org"}]

    async def no_reload():
        return 0
    monkeypatch.setattr(geoip, "locate", nothing)
    monkeypatch.setattr(turn, "get_ice_servers", stun_only)
    monkeypatch.setattr(zone_engine, "reload", no_reload)
    asgi = create_app()
    sio = admin_events._sio
    rec = Recorder()
    monkeypatch.setattr(sio, "emit", rec.emit)
    monkeypatch.setattr(sio, "disconnect", rec.disconnect)
    monkeypatch.setattr(sio, "enter_room", rec.enter_room)
    api = asgi.other_asgi_app
    yield SimpleNamespace(sio=sio, rec=rec, cl=TestClient(api), sm=api.state.session_manager,
                          pool=api.state.vision_pool)
    service.reset_for_tests()


def ok(r, code=200):
    assert r.status_code == code, (r.status_code, r.text)
    return r.json()


async def account(name, role=None):
    rec = await service.create_user(name, PW, role, memory_only=True,
                                    email=f"{name}@example.com", email_verified=True)
    token, _, _ = await service.login(name, PW, "127.0.0.1")
    return rec, token


def hdr(token):
    return {"Authorization": f"Bearer {token}"}


async def world(live):
    """Founder; IITH (organization) with client Civil; SkyServe; a customer
    pilot and viewer on IITH; a HYRAK pilot and a HYRAK viewer."""
    cl = live.cl
    f, ft = await account("founder", "admin")
    iith = ok(cl.post("/api/workspaces", headers=hdr(ft), json={"name": "IITH", "kind": "organization"}))["workspace"]
    civil = ok(cl.post("/api/workspaces", headers=hdr(ft), json={
        "name": "Civil", "kind": "client", "parent_id": iith["id"]}))["workspace"]
    sky = ok(cl.post("/api/workspaces", headers=hdr(ft), json={"name": "SkyServe", "kind": "organization"}))["workspace"]
    w = SimpleNamespace(founder=(f, ft), iith=iith, civil=civil, sky=sky)
    for name, ws, role in (("pat", iith, "pilot"), ("vic", iith, "viewer"), ("olga", iith, "owner")):
        u = await account(name)
        m = ok(cl.post(f"/api/workspaces/{ws['id']}/members", headers=hdr(ft),
                       json={"login": name, "role": role}))["member"]
        setattr(w, name, u)
        setattr(w, name + "_m", m)
    w.hp = await account("hp", "operator")          # HYRAK pilot
    w.hv = await account("hv", "viewer")            # HYRAK viewer
    return w


async def connect(live, sid, token, **auth):
    """Run the real connect handler. Returns session_ready, or the refusal
    message string."""
    try:
        await live.sio.handlers["/"]["connect"](sid, {"REMOTE_ADDR": "127.0.0.1"},
                                                {"token": token, **auth})
    except socketio.exceptions.ConnectionRefusedError as e:
        return e.error_args["message"]
    await asyncio.sleep(0.1)
    return live.rec.of("session_ready", sid)[-1]


def session(live, sid):
    return live.sm.get_by_socket(sid)


def errors(live, sid):
    return live.rec.of("error", sid)


def hold_link(live, sid, drone=None):
    """Give the session a telemetry link (a stand-in manager) and a drone."""
    s = session(live, sid)
    live.sm._telemetry[s.session_id] = SimpleNamespace(is_connected=True)
    s.drone = drone
    return s


# ── handshake ────────────────────────────────────────────────────────────

async def test_staff_land_on_hyrak_and_session_ready_carries_scope(live):
    w = await world(live)
    ready = await connect(live, "f1", w.founder[1])
    assert ready["workspace_id"] == PLATFORM_WORKSPACE_ID and ready["staff"] is True
    assert "fly" in ready["perms"] and "zones.regulatory" in ready["perms"]
    assert ready["perms"] == sorted(ready["perms"])
    for k in ("session_id", "resume_secret", "user", "device"):
        assert k in ready
    ready = await connect(live, "hp1", w.hp[1])
    assert ready["staff"] is True and ready["perms"] == ["fly", "models.run", "plan", "view"]
    s = session(live, "hp1")
    assert s.is_staff and s.workspace_id == PLATFORM_WORKSPACE_ID
    assert live.pool.gallery_allowed(s.session_id)


async def test_customer_gets_first_workspace_or_a_named_one(live):
    w = await world(live)
    ready = await connect(live, "p1", w.pat[1])
    assert ready["workspace_id"] == w.iith["id"] and ready["staff"] is False
    assert ready["perms"] == ["fly", "models.run", "plan", "view"]
    assert ready["user"]["role"] == "member"
    s = session(live, "p1")
    assert not s.is_staff and s.workspace_id == w.iith["id"]
    assert not live.pool.gallery_allowed(s.session_id)      # no global face gallery
    # Inherited: an IITH pilot may open a session in IITH's client.
    assert (await connect(live, "p2", w.pat[1], workspace_id=w.civil["id"]))["workspace_id"] == w.civil["id"]
    # Not theirs: a sibling organization, HYRAK itself, nonsense.
    for ws in (w.sky["id"], PLATFORM_WORKSPACE_ID, "no-such-id", 42):
        assert await connect(live, "p3", w.pat[1], workspace_id=ws) == "no_workspace_access"
    assert session(live, "p3") is None


async def test_customer_without_view_is_refused(live):
    w = await world(live)
    _, lonely = await account("lonely")                     # no memberships at all
    assert await connect(live, "l1", lonely) == "no_workspace_access"
    # A disabled workspace takes view away from its customers.
    ok(live.cl.patch(f"/api/workspaces/{w.iith['id']}", headers=hdr(w.founder[1]), json={"disabled": True}))
    assert await connect(live, "p1", w.pat[1]) == "no_workspace_access"
    assert await connect(live, "x", "not-a-token") == "unauthorized"


async def test_staff_naming_a_workspace_needs_view_on_it(live):
    w = await world(live)
    # A HYRAK pilot does not inherit into customers.
    assert await connect(live, "hp1", w.hp[1], workspace_id=w.iith["id"]) == "no_workspace_access"
    # A manager (staff) on IITH may open an IITH session, still a staff session.
    ok(live.cl.post(f"/api/workspaces/{w.iith['id']}/members", headers=hdr(w.founder[1]),
                    json={"login": "hv", "role": "manager"}))
    ready = await connect(live, "m1", w.hv[1], workspace_id=w.iith["id"])
    assert ready["staff"] is True and ready["workspace_id"] == w.iith["id"]
    assert "drones.manage" in ready["perms"]


# ── guards ───────────────────────────────────────────────────────────────

async def test_guards_staff_vs_customer_pilot_vs_customer_viewer(live):
    w = await world(live)
    await connect(live, "op", w.hp[1])
    await connect(live, "sv", w.hv[1])
    await connect(live, "p", w.pat[1])
    await connect(live, "v", w.vic[1])
    view = socket_guard.require_session_view
    fly = socket_guard.require_session_fly
    assert await view("op", "offer") and await view("sv", "offer")
    assert await view("p", "offer") and await view("v", "offer")
    assert await fly("op", "set_analysis_mode", {}) is True
    assert await fly("sv", "set_analysis_mode", {}) is False         # staff viewer: no operator rank
    assert await fly("p", "set_analysis_mode", {}) is True           # customer pilot: fly
    assert await fly("v", "set_analysis_mode", {}) is False          # customer viewer: view only
    assert errors(live, "v")[-1]["code"] == "forbidden"
    # The compatibility guards are staff only.
    assert await socket_guard.require_operator("op", "connect_telemetry") is True
    assert await socket_guard.require_operator("p", "connect_telemetry") is False
    assert await socket_guard.require_staff("sv", "start_rc_monitor") is True
    assert await socket_guard.require_staff("p", "start_rc_monitor") is False
    assert await socket_guard.require_admin("p", "admin_hello") is False
    assert await view("nobody", "offer") is False


async def test_customer_is_refused_by_every_staff_handler(live):
    w = await world(live)
    await connect(live, "p", w.pat[1])
    h = live.sio.handlers["/"]
    from app.auth import socket_classes
    # Every staff event, called with a plausible payload: each must refuse
    # with `forbidden` before doing anything.
    staff_events = [e for e, c in socket_classes.EVENTS.items() if c == socket_classes.STAFF]
    payloads = {"allocate_video_relay": {}, "release_video_relay": {},
                "datachannel_video_offer": {"sdp": "v=0"}, "datachannel_video_stats": {}}
    for ev in staff_events:
        before = len(live.rec.emitted)
        fn = h[ev]
        params = list(inspect.signature(fn).parameters)
        args = ("p",) if len(params) == 1 else ("p", payloads.get(ev, {"x": 1}))
        out = await fn(*args)
        new = live.rec.emitted[before:]
        assert any(e == "error" and d.get("code") == "forbidden" for e, d, _ in new), ev
        assert not any(e in ("rc_monitor_status", "telemetry_status", "swarm_scan_started",
                             "mission_upload_result", "gallery_mode_set") for e, _, _ in new), ev
        if isinstance(out, dict):
            assert out.get("code") == "forbidden", ev


async def test_offer_video_sources_and_ai_modes_for_customers(live):
    w = await world(live)
    await connect(live, "p", w.pat[1])
    await connect(live, "op", w.hp[1])
    h = live.sio.handlers["/"]
    await h["offer"]("p", {"videoSource": "air_unit_udp", "sdp": "x", "type": "offer"})
    assert errors(live, "p")[-1]["code"] == "forbidden"
    await h["offer"]("p", {"videoSource": "camera", "type": "offer"})        # passes the gate
    assert errors(live, "p")[-1]["msg"] == "offer is missing sdp"
    await h["offer"]("op", {"videoSource": "air_unit_udp", "type": "offer"})  # staff: allowed
    assert errors(live, "op")[-1]["msg"] == "offer is missing sdp"
    await h["set_analysis_mode"]("p", {"mode": "3d-reconstruction"})
    assert errors(live, "p")[-1]["code"] == "forbidden"
    assert session(live, "p").mode.value == "manual-control"


# ── drone access ─────────────────────────────────────────────────────────

async def test_unassigned_drone_is_claimed_by_the_session_workspace(live, monkeypatch):
    from app.registry import drones as registry
    w = await world(live)
    await connect(live, "p", w.pat[1])
    s = session(live, "p")
    seen = []

    async def upsert(uid, is_simulated=False, claim_workspace_id=None):
        seen.append((uid, is_simulated, claim_workspace_id))
        return {"id": "d-new", "name": "Drone-NEW", "is_simulated": is_simulated,
                "workspace_id": claim_workspace_id or PLATFORM_WORKSPACE_ID,
                **({"claimed": True} if claim_workspace_id else {})}
    monkeypatch.setattr(registry, "upsert_seen", upsert)
    drone = await live_scope.identify_drone(s, "UID-1", is_simulated=False)
    assert seen == [("UID-1", False, w.iith["id"])]
    assert drone["workspace_id"] == w.iith["id"] and "claimed" not in drone
    assert s.drone_fly is True
    events = ok(live.cl.get(f"/api/audit?workspace_id={w.iith['id']}", headers=hdr(w.olga[1])))["events"]
    claim = [e for e in events if e["action"] == "drone.claimed"]
    assert claim and claim[0]["actor_name"] == "pat" and claim[0]["target_id"] == "d-new"
    # Simulated drones are never claimed and never block.
    await live_scope.identify_drone(s, "SITL", is_simulated=True)
    assert seen[-1] == ("SITL", True, None) and s.drone_fly is True


async def test_drone_in_another_workspace_is_read_only(live):
    w = await world(live)
    await connect(live, "p", w.pat[1])
    s = hold_link(live, "p", {"id": "d1", "workspace_id": PLATFORM_WORKSPACE_ID, "is_simulated": False})
    s.drone_fly = await live_scope.drone_fly_allowed(s, s.drone)
    assert s.drone_fly is False
    fly = socket_guard.require_session_fly
    assert await fly("p", "drone_action", {"action": "arm"}) is False
    err = errors(live, "p")[-1]
    assert err["code"] == "drone_not_in_workspace" and "move it" in err["msg"]
    result = live.rec.of("action_result", "p")[-1]
    assert result["ok"] is False and result["code"] == "drone_not_in_workspace"
    assert await fly("p", "drone_command", {}, quiet=True) is False
    assert await fly("p", "set_param", {"key": "X"}) is False
    assert await fly("p", "set_tracking", {"active": True}) is False
    # The session's own AI pipeline is not the drone.
    assert await fly("p", "set_analysis_mode", {"mode": "crowd-management"}) is True
    # Reading the drone is fine.
    assert await socket_guard.require_session_view("p", "fetch_params") is True
    # Moved into the pilot's workspace: the next revalidation sees it.
    service.memory_store()._drones["d1"] = {"id": "d1", "workspace_id": w.iith["id"], "is_simulated": False}
    s.auth_checked_at = 0.0
    assert await fly("p", "drone_action", {"action": "arm"}) is True and s.drone_fly is True


async def test_safety_actions_are_never_refused_on_a_held_link(live):
    w = await world(live)
    await connect(live, "p", w.pat[1])
    await connect(live, "v", w.vic[1])
    foreign = {"id": "d1", "workspace_id": w.sky["id"], "is_simulated": False}
    for sid in ("p", "v"):
        s = hold_link(live, sid, foreign)
        s.drone_fly = False
    fly = socket_guard.require_session_fly
    for data in ({"action": "land"}, {"action": "hold"}, {"action": "return"},
                 {"action": "pause_mission"},
                 {"action": "set_mode", "mode": "LAND"}, {"action": "set_mode", "mode": "hold"}):
        assert await fly("p", "drone_action", data) is True, data      # foreign drone
        assert await fly("v", "drone_action", data) is True, data      # and no fly at all
    # rtl_home takes a caller-chosen altitude: a goto, not covered.
    assert await fly("p", "drone_action", {"action": "rtl_home", "altitude": 1}) is False
    assert await fly("v", "drone_action", {"action": "rtl_home"}) is False
    assert await fly("p", "drone_action", {"action": "takeoff"}) is False
    assert await fly("v", "drone_action", {"action": "arm"}) is False
    assert errors(live, "v")[-1]["code"] == "forbidden"
    assert await fly("p", "drone_action", {"action": "set_mode", "mode": "MISSION"}) is False
    # No link held: the exception does not apply (nothing to protect).
    live.sm._telemetry.pop(session(live, "v").session_id)
    assert await fly("v", "drone_action", {"action": "land"}) is False


async def test_unidentified_drone_blocks_customers_not_staff(live):
    w = await world(live)
    await connect(live, "p", w.pat[1])
    await connect(live, "op", w.hp[1])
    hold_link(live, "p")
    hold_link(live, "op")
    fly = socket_guard.require_session_fly
    assert await fly("p", "drone_action", {"action": "arm"}) is False
    assert errors(live, "p")[-1]["code"] == "drone_unidentified"
    assert await fly("p", "drone_action", {"action": "land"}) is True
    assert await fly("op", "drone_action", {"action": "arm"}) is True
    # Without a link a customer pilot's commands pass (there is no drone to protect).
    await connect(live, "p2", w.pat[1])
    assert await fly("p2", "drone_action", {"action": "arm"}) is True


async def test_drone_access_follows_fly_on_the_drones_workspace(live):
    w = await world(live)
    customer_drone = {"id": "dc", "workspace_id": w.civil["id"], "is_simulated": False}
    hyrak_drone = {"id": "dh", "workspace_id": PLATFORM_WORKSPACE_ID, "is_simulated": False}
    ok(live.cl.post(f"/api/workspaces/{w.iith['id']}/members", headers=hdr(w.founder[1]),
                    json={"login": "hv", "role": "manager"}))
    for sid, token in (("f", w.founder[1]), ("hp", w.hp[1]), ("m", w.hv[1]), ("p", w.pat[1])):
        await connect(live, sid, token)
    cases = {("f", "dc"): True, ("f", "dh"): True,
             ("m", "dc"): True,                       # manager of IITH flies its client's drone
             ("m", "dh"): True,                       # ... and HYRAK's, as before 2a (HYRAK viewer + manager)
             ("hp", "dh"): True, ("hp", "dc"): False,  # HYRAK pilot: HYRAK's drones only
             ("p", "dc"): True, ("p", "dh"): False}
    for (sid, did), want in cases.items():
        s = session(live, sid)
        assert await live_scope.drone_fly_allowed(s, customer_drone if did == "dc" else hyrak_drone) is want, (sid, did)
    # A HYRAK viewer without a manager role does not fly HYRAK's drones.
    await connect(live, "sv", (await account("plainviewer", "viewer"))[1])
    assert await live_scope.drone_fly_allowed(session(live, "sv"), hyrak_drone) is False
    # The stored is_simulated flag does not skip ownership; only the
    # current link being a simulator does.
    p = session(live, "p")
    stored_sim = {**hyrak_drone, "is_simulated": True}
    assert await live_scope.drone_fly_allowed(p, stored_sim) is False
    p.link_simulated = True
    assert await live_scope.drone_fly_allowed(p, stored_sim) is True
    legacy = SimpleNamespace(user_id=service.LEGACY_USER_ID, memberships=())
    assert await live_scope.drone_fly_allowed(legacy, hyrak_drone) is True
    assert await live_scope.drone_fly_allowed(legacy, customer_drone) is False


# ── revalidation and resume ──────────────────────────────────────────────

async def test_revalidation_refreshes_perms_and_drops_lost_view(live):
    w = await world(live)
    await connect(live, "p", w.pat[1])
    s = session(live, "p")
    fly = socket_guard.require_session_fly
    assert await fly("p", "set_analysis_mode", {}) is True
    # Pilot -> viewer: perms shrink at the next check, the socket stays.
    ok(live.cl.patch(f"/api/workspaces/{w.iith['id']}/members/{w.pat_m['id']}",
                     headers=hdr(w.founder[1]), json={"role": "viewer"}))
    s.auth_checked_at = 0.0
    assert await fly("p", "set_analysis_mode", {}) is False
    assert s.perms == frozenset({"view"}) and await socket_guard.require_session_view("p", "offer")
    # Removed from the workspace: view is gone, the socket is dropped.
    live.rec.disconnected.clear()
    ok(live.cl.delete(f"/api/workspaces/{w.iith['id']}/members/{w.pat_m['id']}", headers=hdr(w.founder[1])))
    s.auth_checked_at = 0.0
    assert await socket_guard.require_session_view("p", "offer") is False
    assert "p" in live.rec.disconnected and s.perms == frozenset()


async def test_staff_demoted_to_customer_loses_the_hyrak_session(live):
    w = await world(live)
    await connect(live, "hv", w.hv[1])
    s = session(live, "hv")
    ok(live.cl.post(f"/api/workspaces/{w.iith['id']}/members", headers=hdr(w.founder[1]),
                    json={"login": "hv", "role": "pilot"}))
    hyrak = ok(live.cl.get(f"/api/workspaces/{PLATFORM_WORKSPACE_ID}/members", headers=hdr(w.founder[1])))
    mid = next(m["id"] for m in hyrak["members"] if m["user"]["username"] == "hv")
    ok(live.cl.delete(f"/api/workspaces/{PLATFORM_WORKSPACE_ID}/members/{mid}", headers=hdr(w.founder[1])))
    s.auth_checked_at = 0.0
    assert await socket_guard.revalidate(s) is False
    # They can come back as a customer, in their customer workspace.
    ready = await connect(live, "hv2", w.hv[1])
    assert ready["staff"] is False and ready["workspace_id"] == w.iith["id"]


async def test_resume_is_bound_to_user_and_workspace(live):
    w = await world(live)
    first = await connect(live, "p1", w.pat[1], workspace_id=w.civil["id"])
    sid0, secret = first["session_id"], first["resume_secret"]
    # Same user, same workspace (named or omitted): the session comes back.
    again = await connect(live, "p2", w.pat[1], resume_session=sid0, resume_secret=secret)
    assert again["resumed"] is True and again["session_id"] == sid0
    assert again["workspace_id"] == w.civil["id"]
    again = await connect(live, "p3", w.pat[1], workspace_id=w.civil["id"],
                          resume_session=sid0, resume_secret=secret)
    assert again["resumed"] is True and again["session_id"] == sid0
    # Another workspace: a fresh session, the old one is left alone.
    other = await connect(live, "p4", w.pat[1], workspace_id=w.iith["id"],
                          resume_session=sid0, resume_secret=secret)
    assert "resumed" not in other and other["session_id"] != sid0 and other["workspace_id"] == w.iith["id"]
    assert live.sm.get(sid0).workspace_id == w.civil["id"]
    # Another user with the secret: a fresh session of their own.
    stolen = await connect(live, "o1", w.olga[1], resume_session=sid0, resume_secret=secret)
    assert "resumed" not in stolen and stolen["session_id"] != sid0
    # Lost view on the session's workspace: the resume is refused.
    ok(live.cl.delete(f"/api/workspaces/{w.iith['id']}/members/{w.pat_m['id']}", headers=hdr(w.founder[1])))
    assert await connect(live, "p5", w.pat[1], resume_session=sid0, resume_secret=secret) == "no_workspace_access"


# ── REST ─────────────────────────────────────────────────────────────────

async def test_rest_global_data_is_staff_only(live):
    w = await world(live)
    cl = live.cl
    staff_only = ["/api/drones", "/api/fleet", "/api/missions", "/api/missions/m1", "/api/pads",
                  "/api/tasks", "/api/tasks/t1", "/api/permits", "/api/planner/meta",
                  "/api/map-features", "/api/drones/d1/flights", "/api/flights/f1",
                  "/api/flights/f1/download", "/api/vision/crowd-history",
                  "/api/vision/plate-history", "/api/vision/plate-history/e1/image",
                  "/api/vision/face-gallery", "/api/vision/sightings", "/api/sessions",
                  "/api/avoidance/status", "/api/avoidance/d1/obstacles", "/api/avoidance/hazards",
                  "/api/video/mesh-units", "/api/video/feeds", "/api/latency-probe",
                  "/api/latency-probe/stats", "/api/recon/engine", "/api/recon/results"]
    for path in staff_only:
        assert cl.get(path).status_code == 401, path
        assert cl.get(path, headers=hdr(w.pat[1])).status_code == 403, path
    for path in ("/api/drones", "/api/fleet", "/api/vision/plate-history", "/api/pads"):
        assert cl.get(path, headers=hdr(w.hv[1])).status_code == 200, path
    signed_in = ["/api/zones", "/api/zones/check?lat=17.5&lng=78.5", "/api/vision/calibration",
                 "/api/webrtc/ice-servers"]
    for path in signed_in:
        assert cl.get(path).status_code == 401, path
        assert cl.get(path, headers=hdr(w.vic[1])).status_code == 200, path
    assert cl.get("/api/terrain/elevation?lats=1&lngs=1").status_code == 401
    assert cl.get("/api/health").status_code == 200


async def test_session_reports_belong_to_their_user(live):
    w = await world(live)
    ready = await connect(live, "p", w.pat[1])
    sid = ready["session_id"]
    for kind in ("crowd-report", "plate-report"):
        url = f"/api/sessions/{sid}/{kind}/download"
        assert live.cl.get(url).status_code == 401
        assert live.cl.get(url, headers=hdr(w.pat[1])).status_code == 200
        assert live.cl.get(url, headers=hdr(w.vic[1])).status_code == 404
        assert live.cl.get(url, headers=hdr(w.hv[1])).status_code == 200      # staff
        assert live.cl.get(f"/api/sessions/nope/{kind}/download", headers=hdr(w.pat[1])).status_code == 404
    # The owner record outlives the live session.
    await live.sm.destroy(sid)
    assert live.cl.get(f"/api/sessions/{sid}/crowd-report/download", headers=hdr(w.pat[1])).status_code == 200


async def test_org_owner_console_is_scoped_to_their_subtree(live):
    """Section 6 of the brief: the existing workspaces, zones and audit
    routes already scope an organization owner to their own subtree."""
    w = await world(live)
    oh = hdr(w.olga[1])
    cl = live.cl
    seen = {x["name"] for x in ok(cl.get("/api/workspaces", headers=oh))["workspaces"]}
    assert seen == {"IITH", "Civil"}
    for ws in (w.iith, w.civil):
        ok(cl.get(f"/api/workspaces/{ws['id']}/members", headers=oh))
        ok(cl.get(f"/api/workspaces/{ws['id']}/invites", headers=oh))
        ok(cl.get(f"/api/workspaces/{ws['id']}/drones", headers=oh))
        ok(cl.get(f"/api/audit?workspace_id={ws['id']}", headers=oh))
    for ws_id in (w.sky["id"], PLATFORM_WORKSPACE_ID):
        assert cl.get(f"/api/workspaces/{ws_id}/members", headers=oh).status_code == 404
        assert cl.get(f"/api/workspaces/{ws_id}/drones", headers=oh).status_code == 404
        assert cl.get(f"/api/audit?workspace_id={ws_id}", headers=oh).status_code == 404
    assert cl.get("/api/audit", headers=oh).status_code == 400
    assert cl.get("/api/staff", headers=oh).status_code == 403
    # A customer pilot has no console rights even in their own workspace.
    assert cl.get(f"/api/audit?workspace_id={w.iith['id']}", headers=hdr(w.pat[1])).status_code == 403


async def _slow_verify(monkeypatch, calls, *, delay, revoke=False):
    real = socket_guard.verify_token_hash

    async def slow(h):
        calls.append(h)
        await asyncio.sleep(delay)
        return None if revoke else await real(h)
    monkeypatch.setattr(socket_guard, "verify_token_hash", slow)


async def test_concurrent_callers_share_one_revalidation_and_its_answer(live, monkeypatch):
    """A stream arriving while the store is slow starts one re-check, and
    every caller waits for its answer instead of passing on the stale stamp."""
    w = await world(live)
    await connect(live, "p", w.pat[1])
    s = session(live, "p")
    calls = []
    await _slow_verify(monkeypatch, calls, delay=0.05)
    # Demoted to viewer while the stamp still says pilot.
    ok(live.cl.patch(f"/api/workspaces/{w.iith['id']}/members/{w.pat_m['id']}",
                     headers=hdr(w.founder[1]), json={"role": "viewer"}))
    s.auth_checked_at = 0.0
    results = await asyncio.gather(*(socket_guard.require_session_fly("p", "set_analysis_mode", {})
                                     for _ in range(10)))
    assert results == [False] * 10 and len(calls) == 1
    assert s.perms == frozenset({"view"}) and s.auth_checked_at > 0
    assert not socket_guard._inflight


async def test_a_revoked_token_denies_every_waiting_caller(live, monkeypatch):
    w = await world(live)
    await connect(live, "p", w.pat[1])
    hold_link(live, "p")
    s = session(live, "p")
    calls = []
    await _slow_verify(monkeypatch, calls, delay=0.05, revoke=True)
    s.auth_checked_at = 0.0
    results = await asyncio.gather(
        *(socket_guard.require_session_view("p", "serial_uplink") for _ in range(5)),
        *(socket_guard.require_session_fly("p", "drone_action", {"action": "land"}) for _ in range(5)),
        socket_guard.require_session_fly("p", "set_analysis_mode", {}))
    assert results == [False] * 11 and len(calls) == 1
    assert live.rec.disconnected == ["p"]


async def test_a_timed_out_recheck_holds_commands_but_not_safety_or_view(live, monkeypatch):
    w = await world(live)
    await connect(live, "p", w.pat[1])
    await connect(live, "op", w.hp[1])
    for sid in ("p", "op"):
        s = hold_link(live, sid, {"id": "d1", "workspace_id": w.iith["id"], "is_simulated": False})
        s.drone_fly = True
    calls = []
    await _slow_verify(monkeypatch, calls, delay=1.0)
    monkeypatch.setattr(socket_guard, "REVALIDATE_TIMEOUT_S", 0.05)
    fly = socket_guard.require_session_fly
    for sid in ("p", "op"):
        session(live, sid).auth_checked_at = 0.0
        assert await fly(sid, "drone_action", {"action": "arm"}) is False
        assert errors(live, sid)[-1]["code"] == "access_unverified"
        assert await fly(sid, "set_analysis_mode", {}) is False
        for data in ({"action": "land"}, {"action": "return"}, {"action": "hold"},
                     {"action": "set_mode", "mode": "LAND"}):
            assert await fly(sid, "drone_action", data) is True, (sid, data)
        assert await socket_guard.require_session_view(sid, "serial_uplink") is True
        assert session(live, sid).auth_checked_at == 0.0          # still stale: retried next time
    assert await socket_guard.require_operator("op", "connect_telemetry") is False
    assert errors(live, "op")[-1]["code"] == "access_unverified"
    assert live.rec.disconnected == []
