"""
Staff takeover of a customer's flight (docs/ACCESS_MODEL.md 8b "Takeover").

The real server object against the memory auth store, like
test_live_scope.py: the real socket handlers (takeover_session,
release_session, drone_action / drone_command with target_session,
disconnect), socket_guard, the avoidance REST dependency, and the audit
rows the memory store keeps. The drone link is a stand-in manager that
records what it was asked to do.
"""
import asyncio
import types
from types import SimpleNamespace

import pytest

from app.auth import service, socket_guard
from app.sessions import takeover
from test_history_scope import fake_tel, staffed
from test_live_scope import (  # noqa: F401  (live is a fixture)
    connect, errors, hdr, live, ok, session,
)


class FakeTel:
    """A drone link that records commands."""
    is_connected = True
    _offboard_active = False
    last_action_error = None

    def __init__(self):
        self.calls = []
        self.automation_locked = False
        self.snapshot = fake_tel().snapshot

    async def set_flight_mode(self, mode):
        self.calls.append(("mode", mode))
        return True

    async def send_command(self, cmd):
        self.calls.append(("manual", cmd.pitch))

    async def stop(self):
        self.calls.append(("stop",))


@pytest.fixture(autouse=True)
def clean_takeovers():
    takeover.reset_for_tests()
    yield
    takeover.reset_for_tests()


async def flying(live):
    """staffed() world with pat (IITH pilot) flying drone d1 on a link, and
    console sockets for mgr (IITH manager), smgr (SkyServe manager), the
    founder and hp (HYRAK pilot)."""
    w = await staffed(live)
    await connect(live, "p", w.pat[1])
    s = session(live, "p")
    s.drone = {"id": "d1", "name": "Hawk", "workspace_id": w.iith["id"]}
    s.drone_fly = True
    tel = FakeTel()
    live.sm._telemetry[s.session_id] = tel
    for sid, tok in (("m", w.mgr[1]), ("sm", w.smgr[1]), ("f", w.founder[1]), ("hp", w.hp[1])):
        await connect(live, sid, tok)
        await live.sio.handlers["/"]["admin_hello"](sid, {})
    return w, s, tel


def audit_rows(action):
    return [r for r in service.memory_store()._audit if r.action == action]


def h(live):
    return live.sio.handlers["/"]


# ── permission scoping ───────────────────────────────────────────────────

async def test_only_founders_and_the_workspaces_managers_take_over(live):
    w, s, tel = await flying(live)
    target = {"session_id": s.session_id}
    for sid in ("sm", "hp"):                       # other workspace's manager, HYRAK pilot
        await h(live)["takeover_session"](sid, target)
        assert live.rec.of("takeover_result", sid)[-1]["ok"] is False
        assert takeover.holder(s.session_id) is None
    await connect(live, "o", w.olga[1])            # customer owner: staff-only event
    await h(live)["takeover_session"]("o", target)
    assert errors(live, "o")[-1]["code"] == "forbidden" and takeover.holder(s.session_id) is None
    await h(live)["takeover_session"]("m", target)
    assert takeover.holder(s.session_id).username == "mgr"
    # Held: another allowed staff member is told who holds it.
    await h(live)["takeover_session"]("f", target)
    res = live.rec.of("takeover_result", "f")[-1]
    assert res["ok"] is False and res["code"] == "taken_over" and "mgr" in res["error"]
    # The permission, not the role, is what is checked.
    from app.auth import perms
    assert perms.SESSIONS_TAKEOVER in perms.ROLE_PERMS["manager"]
    assert perms.SESSIONS_TAKEOVER not in perms.ROLE_PERMS["owner"]


# ── quick actions ────────────────────────────────────────────────────────

async def test_quick_hold_return_land_without_taking_over(live):
    w, s, tel = await flying(live)
    act = h(live)["drone_action"]
    await act("m", {"action": "hold", "target_session": s.session_id})
    await act("m", {"action": "return", "target_session": s.session_id})
    await act("m", {"action": "land", "target_session": s.session_id})
    assert tel.calls == [("mode", "HOLD"), ("mode", "RETURN"), ("mode", "LAND")]
    assert [r["ok"] for r in live.rec.of("action_result", "m")] == [True, True, True]
    assert [d["action"] for d in live.rec.of("staff_intervention", "p")] == ["hold", "return", "land"]
    await asyncio.sleep(0.05)
    rows = audit_rows("session.quick_action")
    assert len(rows) == 3 and rows[0].actor_name == "mgr" and rows[0].workspace_id == w.iith["id"]
    assert rows[0].detail["drone_id"] == "d1" and rows[0].detail["action"] == "hold"
    # Anything else needs the takeover first; other workspaces get nothing.
    await act("m", {"action": "set_mode", "mode": "MISSION", "target_session": s.session_id})
    await act("sm", {"action": "land", "target_session": s.session_id})
    await act("m", {"action": "land", "target_session": "no-such-session"})
    assert len(tel.calls) == 3
    assert "Take control" in errors(live, "m")[-2]["msg"]
    assert errors(live, "sm")[-1]["code"] == "forbidden"
    # Routing is for drone commands only.
    assert await socket_guard.require_session_fly(
        "m", "set_param", {"key": "X", "target_session": s.session_id}) is False


# ── full takeover ────────────────────────────────────────────────────────

async def test_takeover_routes_staff_and_refuses_the_customer_until_release(live):
    w, s, tel = await flying(live)
    fly = socket_guard.require_session_fly
    await h(live)["takeover_session"]("m", {"session_id": s.session_id})
    status = live.rec.of("takeover_status", "p")[-1]
    assert status["active"] is True and status["by"] == "mgr"
    assert tel.automation_locked is True
    assert len(audit_rows("session.takeover")) == 1
    assert audit_rows("session.takeover")[0].detail["drone_name"] == "Hawk"
    # The customer: every command refused, safety actions included.
    for ev, data in (("drone_action", {"action": "land"}), ("drone_action", {"action": "hold"}),
                     ("drone_command", {}), ("set_param", {"key": "X"}),
                     ("set_analysis_mode", {"mode": "crowd-management"})):
        assert await fly("p", ev, data) is False, ev
        assert errors(live, "p")[-1]["code"] == "taken_over"
    assert live.rec.of("action_result", "p")[-1]["code"] == "taken_over"
    # ... but still watches.
    assert await socket_guard.require_session_view("p", "fetch_params") is True
    # Staff commands reach the drone, through the session's own handlers.
    await h(live)["drone_action"]("m", {"action": "set_mode", "mode": "MISSION",
                                        "target_session": s.session_id})
    await h(live)["drone_command"]("m", {"pitch": 0.3, "target_session": s.session_id})
    assert tel.calls == [("mode", "MISSION"), ("manual", 0.3)]
    await asyncio.sleep(0.05)
    assert audit_rows("session.takeover.command")[0].detail["mode"] == "MISSION"
    # Someone else's quick action while mgr holds it: refused.
    await h(live)["drone_action"]("f", {"action": "land", "target_session": s.session_id})
    assert errors(live, "f")[-1]["code"] == "taken_over" and len(tel.calls) == 2
    # Release: the banner comes down, automation and the customer are back.
    await h(live)["release_session"]("m", {"session_id": s.session_id})
    assert live.rec.of("takeover_status", "p")[-1]["active"] is False
    assert takeover.holder(s.session_id) is None and tel.automation_locked is False
    rel = audit_rows("session.release")[-1]
    assert rel.detail["reason"] == "released" and rel.workspace_id == w.iith["id"]
    assert await fly("p", "drone_action", {"action": "land"}) is True
    # The drone keeps its mode: release sends nothing.
    assert tel.calls == [("mode", "MISSION"), ("manual", 0.3)]


async def test_customer_cannot_cut_or_replace_the_link_while_taken_over(live):
    w, s, tel = await flying(live)
    await h(live)["takeover_session"]("m", {"session_id": s.session_id})
    await h(live)["disconnect_telemetry"]("p")
    assert errors(live, "p")[-1]["code"] == "taken_over" and ("stop",) not in tel.calls
    assert live.sm.get_telemetry(s.session_id) is tel
    fly = socket_guard.require_session_fly
    assert await fly("p", "connect_browser_serial", {}) is False      # a link is up
    live.sm._telemetry.pop(s.session_id)
    assert await fly("p", "connect_browser_serial", {}) is True       # relinking a dropped radio
    live.sm._telemetry[s.session_id] = tel


async def test_a_taken_over_staff_session_loses_its_link_and_mission_events(live):
    w, s, tel = await flying(live)
    await connect(live, "pilot", w.hp[1])
    hs = session(live, "pilot")
    live.sm._telemetry[hs.session_id] = FakeTel()
    await h(live)["takeover_session"]("f", {"session_id": hs.session_id})
    assert takeover.holder(hs.session_id).username == "founder"
    for ev in ("connect_telemetry", "connect_rf_bridge", "upload_mission"):
        assert await socket_guard.require_operator("pilot", ev, {}) is False, ev
        assert errors(live, "pilot")[-1]["code"] == "taken_over"
    # Staff events that do not touch the link still work.
    assert await socket_guard.require_operator("pilot", "scan_swarm_drones", {}) is True


async def test_release_when_the_staff_socket_drops(live, monkeypatch):
    w, s, tel = await flying(live)
    monkeypatch.setattr(takeover, "RELEASE_GRACE_S", 0.05)
    await h(live)["takeover_session"]("m", {"session_id": s.session_id})
    await h(live)["disconnect"]("m")
    assert takeover.holder(s.session_id) is not None               # grace first
    await asyncio.sleep(0.2)
    assert takeover.holder(s.session_id) is None
    assert audit_rows("session.release")[-1].detail["reason"] == "staff_disconnected"
    assert live.rec.of("takeover_status", "p")[-1]["active"] is False
    assert tel.calls == []                                          # no auto-land


async def test_a_staff_session_that_returns_in_time_keeps_control():
    released = []

    async def on_release(t):
        released.append(t)
    takeover.start("cust", "staff", user_id="u", username="mgr", workspace_id="w")
    takeover.schedule_release("staff", on_release, grace_s=0.05)
    assert takeover.cancel_pending("staff") == 1
    await asyncio.sleep(0.1)
    assert released == [] and takeover.holder("cust") is not None
    takeover.schedule_release("staff", on_release, grace_s=0.01)
    await asyncio.sleep(0.05)
    assert len(released) == 1 and takeover.holder("cust") is None


async def test_takeover_ends_with_the_session(live):
    w, s, tel = await flying(live)
    await h(live)["takeover_session"]("m", {"session_id": s.session_id})
    from app.events.admin_events import on_session_ended
    await on_session_ended(s.session_id)
    assert takeover.holder(s.session_id) is None
    assert audit_rows("session.release")[-1].detail["reason"] == "session_ended"


# ── other write paths ────────────────────────────────────────────────────

async def test_avoidance_writes_belong_to_the_holder(live):
    w, s, tel = await flying(live)
    cl = live.cl
    body = {"enabled": False}
    assert cl.post("/api/avoidance/d1/enable", headers=hdr(w.pat[1]), json=body).status_code == 200
    await h(live)["takeover_session"]("m", {"session_id": s.session_id})
    r = cl.post("/api/avoidance/d1/enable", headers=hdr(w.pat[1]), json=body)
    assert r.status_code == 423 and r.json()["detail"]["code"] == "taken_over"
    assert cl.post("/api/avoidance/d1/arm", headers=hdr(w.hp[1]), json={"armed": False}).status_code == 423
    assert cl.post("/api/avoidance/d1/enable", headers=hdr(w.mgr[1]), json=body).status_code == 200
    assert cl.get("/api/avoidance/d1/status", headers=hdr(w.pat[1])).status_code == 200   # reads stay


def _v1(msgid, payload=b"\x00\x00"):
    return bytes([0xFE, len(payload), 0, 1, 1, msgid]) + payload + b"\x00\x00"


def _v2(msgid, payload=b"\x00\x00\x00"):
    return (bytes([0xFD, len(payload), 0, 0, 0, 1, 1, msgid & 0xFF, (msgid >> 8) & 0xFF, msgid >> 16])
            + payload + b"\x00\x00")


def test_relay_command_filter_drops_commands_keeps_the_downlink():
    from app.telemetry.serial_bridge import CommandFilter
    f = CommandFilter()
    hb, cmd, setpoint, att = _v2(0), _v2(76), _v1(84), _v2(30)
    stream = b"\x01\x02" + hb + cmd + setpoint + att
    out = b""
    for i in range(0, len(stream), 5):                      # split mid-frame
        out += f.feed(stream[i:i + 5])
    out += f.flush()
    assert out == b"\x01\x02" + hb + att and f.dropped == 2
    signed = bytes([0xFD, 2, 0x01, 0, 0, 1, 1, 11, 0, 0]) + b"\x00\x00" + b"\x00\x00" + bytes(13)
    assert f.feed(signed) == b"" and f.dropped == 3          # SET_MODE, signed frame


async def test_serial_uplink_is_filtered_while_taken_over(live, monkeypatch):
    w, s, tel = await flying(live)
    from app.telemetry import serial_bridge
    seen = []
    bridge = SimpleNamespace(set_command_filter=lambda on: seen.append(on),
                             uplink=lambda data: None)
    monkeypatch.setattr(serial_bridge, "get_bridge", lambda sid: bridge)
    await h(live)["serial_uplink"]("p", b"\xfe\x00")
    await h(live)["takeover_session"]("m", {"session_id": s.session_id})
    await h(live)["serial_uplink"]("p", b"\xfe\x00")        # passes, filtered
    await h(live)["release_session"]("m", {"session_id": s.session_id})
    await h(live)["serial_uplink"]("p", b"\xfe\x00")
    assert seen == [False, True, False]


# ── automated sources ────────────────────────────────────────────────────

async def test_locked_link_refuses_automated_setpoints_and_offboard():
    from app.telemetry.manager import TelemetryManager
    t = TelemetryManager.__new__(TelemetryManager)
    sent = []
    t._connected = True
    t._pilot_override_mode = None
    t._drone = SimpleNamespace(offboard=SimpleNamespace(
        set_velocity_ned=lambda *a: sent.append(a), set_velocity_body=lambda *a: sent.append(a)))
    t.automation_locked = True
    await t.send_velocity_ned(1.0, 0.0, 0.0, 0.0)
    await t.send_velocity_command(1.0, 0.0, 0.0, 0.0)
    assert await t.start_offboard() is False
    assert sent == [] and "taken control" in t.last_action_error


async def test_avoidance_loop_leaves_a_locked_link_alone(monkeypatch):
    from app.avoidance.core import loop
    locked = SimpleNamespace(automation_locked=True)
    monkeypatch.setattr(loop, "_resolve_link", lambda did: (locked, object(), True, "MISSION"))

    def boom(*a, **k):
        raise AssertionError("avoidance acted on a taken-over drone")
    monkeypatch.setattr(loop, "_ensure_pose_feed", boom)
    monkeypatch.setattr(loop, "_local_step", boom)
    await loop._tick_one(SimpleNamespace(drone_id="d1"), 0.0)


def test_dispatcher_offers_no_taken_over_drone(monkeypatch):
    import app.tasks.dispatcher as dispatcher
    from test_dispatcher_snapshot import _install, _session
    _install(monkeypatch, [], [_session("s1", "d1", "A", 1.0, 1.0), _session("s2", "d2", "B", 2.0, 2.0)])
    takeover.start("s1", "staff", user_id="u", username="mgr", workspace_id="w")
    assert set(dispatcher._drone_snapshot()) == {"d2"}


async def test_vision_follow_setpoints_stop_during_takeover():
    import inspect
    from app.webrtc import stream_track
    src = inspect.getsource(stream_track)
    assert "_takeover.is_taken_over(self.session_id)" in src


# ── observers cannot hide ────────────────────────────────────────────────

async def test_a_flying_session_cannot_become_a_hidden_observer(live):
    w, s, tel = await flying(live)
    await h(live)["admin_hello"]("p", {})
    assert not s.is_admin and errors(live, "p")[-1]["event"] == "admin_hello"
    # An observer that later attaches a link stops being one.
    obs = session(live, "hp")
    assert obs.is_admin
    live.sm._sessions[obs.session_id].telemetry_connected = False
    live.sm.attach_telemetry(obs.session_id, FakeTel())
    assert not obs.is_admin
    # And a link always shows up in monitoring, is_admin or not.
    obs.is_admin = True
    rows = ok(live.cl.get("/api/sessions", headers=hdr(w.founder[1])))["sessions"]
    assert obs.session_id in {r["session_id"] for r in rows}
    await h(live)["takeover_session"]("f", {"session_id": obs.session_id})
    assert takeover.holder(obs.session_id) is not None
    # A pure observer (no link, no video) stays off the list.
    assert session(live, "m").session_id not in {r["session_id"] for r in rows}
