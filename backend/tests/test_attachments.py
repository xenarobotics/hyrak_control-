"""
Attachments (app/attachments, docs/ATTACHMENTS.md):

  * validation: per-kind defaults, wiring options, custom states, limits,
    icons, at most eight per drone;
  * what each action sends: actuator values per kind, the sprayer level,
    gripper and winch operations;
  * permissions: configure needs drones.manage on the drone's workspace,
    listing needs view, anything else is a 404;
  * the bench Test: linked and disarmed only, not under a takeover;
  * every in-flight guard and its reason code, the staff takeover holder,
    the command's own failures (not_supported, failed with the drone's
    words), attachment_result / attachment_state and the audit row;
  * mission actions done when reached (and refused when passed);
  * the custom-model rule action: validation, the accepted snapshot,
    the forced confirm;
  * the real socket handler, guarded.

Everything below the handlers runs against stand-ins: no drone, no link.
"""
import asyncio
from types import SimpleNamespace

import pytest

from app.attachments import control, kinds, mission, people
from app.attachments import store as att_store
from app.auth import service as auth
from app.sessions import takeover


# ── validation ───────────────────────────────────────────────────────────

def test_each_kind_gets_its_defaults():
    rel = kinds.clean({"kind": "release", "wiring": {"type": "actuator", "index": 3}})
    assert rel["name"] == "Drop hook" and rel["icon"] == "package-open" and rel["enabled"]
    assert rel["actions"] == [{"id": "drop", "label": "Drop", "hazard": True, "value": 1.0}]
    assert rel["limits"] == {"min_alt_m": 2.0, "max_alt_m": None, "people_check": True}
    assert kinds._ID.match(rel["id"])
    grip = kinds.clean({"kind": "gripper"})                     # gripper wiring by default
    assert grip["wiring"] == {"type": "gripper", "instance": 0}
    assert [(a["id"], a["hazard"]) for a in grip["actions"]] == [("open", True), ("close", False)]
    assert all("value" not in a for a in grip["actions"])        # values are actuator only
    winch = kinds.clean({"kind": "winch"})
    assert [a["id"] for a in winch["actions"]] == ["lower", "raise", "stop"]
    light = kinds.clean({"kind": "light", "wiring": {"type": "actuator", "index": 1}})
    assert [a["id"] for a in light["actions"]] == ["on", "off"]   # strobe only when asked
    assert light["limits"]["people_check"] is False and light["limits"]["min_alt_m"] == 0.0
    light = kinds.clean({"kind": "light", "wiring": {"type": "actuator", "index": 1},
                         "actions": [{"id": "strobe", "label": "Blink", "value": 0.2}]})
    assert [(a["id"], a["label"], a["value"]) for a in light["actions"]] == [
        ("on", "On", 1.0), ("off", "Off", -1.0), ("strobe", "Blink", 0.2)]
    spray = kinds.clean({"kind": "sprayer", "wiring": {"type": "actuator", "index": 2}})
    assert spray["limits"]["min_alt_m"] == 2.0 and spray["actions"][0]["hazard"] is True
    assert kinds.clean({"kind": "speaker", "wiring": {"type": "actuator", "index": 6}})["name"] == "Speaker"


def test_custom_kind_names_its_own_states():
    c = kinds.clean({"kind": "custom", "name": "Flare", "wiring": {"type": "actuator", "index": 4},
                     "actions": [{"id": "fire", "label": "Fire", "value": 1},
                                 {"id": "safe", "label": "Safe", "value": -1, "hazard": False}]})
    assert [(a["id"], a["hazard"]) for a in c["actions"]] == [("fire", True), ("safe", False)]
    assert c["limits"]["people_check"] is True                   # a state can hurt someone


@pytest.mark.parametrize("body", [
    "nope", {"kind": "drone"}, {"kind": "light"},                                  # no output
    {"kind": "light", "wiring": {"type": "actuator", "index": 7}},
    {"kind": "light", "wiring": {"type": "actuator", "index": True}},
    {"kind": "light", "wiring": {"type": "gripper"}},                              # not offered
    {"kind": "release", "wiring": {"type": "winch"}},
    {"kind": "gripper", "wiring": {"type": "gripper", "instance": -1}},
    {"kind": "light", "wiring": {"type": "actuator", "index": 1}, "name": "x" * 41},
    {"kind": "light", "wiring": {"type": "actuator", "index": 1}, "icon": "skull"},
    {"kind": "light", "wiring": {"type": "actuator", "index": 1},
     "actions": [{"id": "on", "value": 2}]},
    {"kind": "light", "wiring": {"type": "actuator", "index": 1},
     "actions": [{"id": "dim", "value": 0}]},
    {"kind": "light", "wiring": {"type": "actuator", "index": 1},
     "actions": [{"id": "on", "label": "x" * 25}]},
    {"kind": "light", "wiring": {"type": "actuator", "index": 1}, "limits": {"min_alt_m": 501}},
    {"kind": "light", "wiring": {"type": "actuator", "index": 1},
     "limits": {"min_alt_m": 10, "max_alt_m": 5}},
    {"kind": "light", "wiring": {"type": "actuator", "index": 1}, "limits": {"people_check": "yes"}},
    {"kind": "light", "wiring": {"type": "actuator", "index": 1}, "enabled": 1},
    {"kind": "custom", "wiring": {"type": "actuator", "index": 1},
     "actions": [{"id": "a", "label": "A", "value": 1}]},                          # one state
    {"kind": "custom", "wiring": {"type": "actuator", "index": 1},
     "actions": [{"id": "A!", "label": "A", "value": 1}, {"id": "b", "label": "B", "value": 0}]},
    {"kind": "custom", "wiring": {"type": "actuator", "index": 1},
     "actions": [{"id": "a", "label": "A", "value": 1}, {"id": "a", "label": "B", "value": 0}]},
    {"kind": "custom", "wiring": {"type": "actuator", "index": 1},
     "actions": [{"id": "a", "label": "A"}, {"id": "b", "label": "B", "value": 0}]},
    {"kind": "light", "id": "BAD", "wiring": {"type": "actuator", "index": 1}},
])
def test_bad_records_are_refused_with_a_plain_reason(body):
    with pytest.raises(kinds.AttachmentError) as e:
        kinds.clean(body)
    assert str(e.value) and "\u2014" not in str(e.value)


def test_a_patch_keeps_what_it_does_not_name_and_cannot_change_the_kind():
    old = kinds.clean({"kind": "release", "wiring": {"type": "actuator", "index": 3},
                       "limits": {"min_alt_m": 5}})
    new = kinds.clean({"name": "Left hook", "limits": {"max_alt_m": 40}}, existing=old)
    assert new["id"] == old["id"] and new["wiring"] == old["wiring"]
    assert new["limits"] == {"min_alt_m": 5.0, "max_alt_m": 40.0, "people_check": True}
    moved = kinds.clean({"wiring": {"type": "gripper", "instance": 1}}, existing=old)
    assert moved["wiring"] == {"type": "gripper", "instance": 1} and "value" not in moved["actions"][0]
    with pytest.raises(kinds.AttachmentError, match="cannot change"):
        kinds.clean({"kind": "light"}, existing=old)


# ── what each action sends ───────────────────────────────────────────────

def _att(kind, wiring=None, **kw):
    return kinds.clean({"kind": kind, "wiring": wiring or {"type": "actuator", "index": 2}, **kw})


@pytest.mark.parametrize("kind,action,value", [
    ("release", "drop", 1.0), ("gripper", "open", 1.0), ("gripper", "close", -1.0),
    ("winch", "lower", 1.0), ("winch", "raise", -1.0), ("winch", "stop", 0.0),
    ("light", "on", 1.0), ("light", "off", -1.0), ("speaker", "on", 1.0), ("speaker", "off", -1.0),
    ("sprayer", "off", -1.0),
])
def test_actuator_values_per_kind(kind, action, value):
    att = _att(kind)
    cmd = kinds.command_for(att, kinds.find_action(att, action))
    assert cmd == {"type": "actuator", "index": 2, "value": value}


def test_sprayer_level_runs_from_off_to_full():
    att = _att("sprayer")
    level = kinds.find_action(att, "level")
    assert [kinds.command_for(att, level, p)["value"] for p in (0, 25, 50, 100)] == [-1.0, -0.5, 0.0, 1.0]
    assert kinds.command_for(att, level)["value"] == 0.0              # 50 % when not given
    # A calibrated sprayer: off at -0.6, full at 0.8.
    att = _att("sprayer", actions=[{"id": "level", "value": 0.8}, {"id": "off", "value": -0.6}])
    assert kinds.command_for(att, kinds.find_action(att, "level"), 50)["value"] == 0.1
    with pytest.raises(kinds.AttachmentError):
        kinds.level_pct(101)


def test_gripper_and_winch_wiring_operations():
    rel = _att("release", {"type": "gripper", "instance": 1})
    assert kinds.command_for(rel, rel["actions"][0]) == {"type": "gripper", "instance": 1, "op": "release"}
    grip = _att("gripper", {"type": "gripper"})
    assert [kinds.command_for(grip, a)["op"] for a in grip["actions"]] == ["release", "grab"]
    winch = _att("winch", {"type": "winch", "instance": 2})
    assert [kinds.command_for(winch, a)["op"] for a in winch["actions"]] == ["deliver", "retract", "hold"]


def test_catalogue_lists_every_kind():
    cat = kinds.catalogue()
    assert [k["kind"] for k in cat["kinds"]] == list(kinds.KINDS)
    assert cat["max_per_drone"] == 8 and cat["actuator_outputs"] == [1, 2, 3, 4, 5, 6]
    light = next(k for k in cat["kinds"] if k["kind"] == "light")
    assert light["people_check"] is False and light["actions"][2]["optional"] is True


# ── guards against stand-ins ─────────────────────────────────────────────

class Tel:
    def __init__(self):
        self.is_connected = True
        self.last_action_error = None
        self.calls = []
        self.answer = True
        self.missing = False
        self.snapshot = SimpleNamespace(
            link_ok=True, mission_current_index=-1,
            flight_mode=SimpleNamespace(mode="HOLD", is_in_air=True, is_armed=True),
            position=SimpleNamespace(latitude_deg=17.6, longitude_deg=78.1, relative_altitude_m=20.0))

    async def _do(self, call):
        if self.missing:
            raise NotImplementedError(call[0])
        self.calls.append(call)
        if not self.answer:
            self.last_action_error = "the drone refused the command (pre-arm check failed)"
        return self.answer

    async def set_actuator(self, index, value):
        return await self._do(("actuator", index, value))

    async def gripper_command(self, instance, op):
        return await self._do(("gripper", instance, op))

    async def winch_command(self, instance, op):
        return await self._do(("winch", instance, op))


class Sio:
    def __init__(self):
        self.emitted = []

    async def emit(self, event, data=None, to=None, **kw):
        self.emitted.append((event, data, to))

    def of(self, event):
        return [d for e, d, _ in self.emitted if e == event]


DRONE = {"id": "d1", "name": "Hexa", "workspace_id": "ws1"}


@pytest.fixture
def rig(monkeypatch):
    from app.zones import engine
    monkeypatch.setattr(auth, "_db_up", lambda: False)
    auth.reset_for_tests()
    auth.allow_memory_writes(True)
    att_store.reset_for_tests()
    control.reset_for_tests()
    mission.reset_for_tests()
    takeover.reset_for_tests()
    zone = {"cls": "green", "zones": []}
    monkeypatch.setattr(engine, "check_point", lambda *a: {"zone_class": zone["cls"], "zones": zone["zones"]})
    sio, tel = Sio(), Tel()
    s = SimpleNamespace(session_id="sess-1", socket_id="sock-1", zone_lock=False, drone=dict(DRONE),
                        user_id="u1", username="pat", role="member", client_ip="10.0.0.1",
                        workspace_id="ws1", mode=None)
    rig = SimpleNamespace(sio=sio, tel=tel, s=s, zone=zone, links={"sess-1": tel})
    sm = SimpleNamespace(get=lambda sid: s if sid == s.session_id else None,
                         get_by_socket=lambda sid: s if sid == s.socket_id else None,
                         get_telemetry=lambda sid: rig.links.get(sid),
                         all_sessions=lambda: [s])
    rig.sm = sm
    control.configure(sio, sm)
    yield rig
    control.configure(None, None)
    control.reset_for_tests()
    mission.reset_for_tests()
    takeover.reset_for_tests()
    att_store.reset_for_tests()
    auth.reset_for_tests()


async def add(body, drone_id="d1"):
    return await att_store.write_store().create(drone_id, kinds.clean(body))


async def drop_hook(**kw):
    return await add({"kind": "release", "id": "hook0001", "wiring": {"type": "actuator", "index": 3},
                      **kw})


def see(session_id, persons=(), age=0.0):
    import time
    people.note(session_id, "object-detection",
                {"detections": [{"name": n, "score": sc, "box": [0, 0, 10, 10]} for n, sc in persons]},
                now=time.monotonic() - age)


async def test_a_harmless_action_just_goes(rig):
    light = await add({"kind": "light", "id": "lamp0001", "wiring": {"type": "actuator", "index": 5}})
    out = await control.use(rig.s, light["id"], "on")
    assert out["ok"] is True and out["message"] == "Light: On: sent" and "reason_code" not in out
    assert rig.tel.calls == [("actuator", 5, 1.0)]
    assert rig.sio.of("attachment_result")[-1] == out
    st = rig.sio.of("attachment_state")[-1]["attachments"]
    assert [(a["id"], a["last_action_id"], a["ok"]) for a in st] == [("lamp0001", "on", True)]
    # Harmless: not flying, too low, a red zone, people below hold nothing back.
    rig.tel.snapshot.flight_mode.is_in_air = False
    rig.zone["cls"] = "red"
    see("sess-1", [("person", 0.9)])
    assert (await control.use(rig.s, light["id"], "off"))["ok"] is True


@pytest.mark.parametrize("setup,code", [
    (lambda r: setattr(r.tel, "is_connected", False), "no_link"),
    (lambda r: r.links.clear(), "no_link"),
    (lambda r: takeover.start("sess-1", "staff-1", user_id="u9", username="ops", workspace_id=None),
     "taken_over"),
    (lambda r: setattr(r.tel.snapshot.flight_mode, "is_in_air", False), "not_flying"),
    (lambda r: setattr(r.tel.snapshot.position, "relative_altitude_m", 1.5), "too_low"),
    (lambda r: setattr(r.tel.snapshot.position, "relative_altitude_m", None), "no_altitude"),
    (lambda r: setattr(r.tel.snapshot.position, "relative_altitude_m", float("nan")), "no_altitude"),
    (lambda r: setattr(r.s, "zone_lock", True), "red_zone"),
    (lambda r: r.zone.update(cls="red"), "red_zone"),
    (lambda r: see("sess-1", [("person", 0.45)]), "people_below"),
    (lambda r: see("sess-1", [("Pedestrian", 0.8)]), "people_below"),
])
async def test_each_guard_refuses_a_drop(rig, setup, code):
    await drop_hook()
    setup(rig)
    out = await control.use(rig.s, "hook0001", "drop", confirm=True)
    assert (out["ok"], out["reason_code"]) == (False, code)
    assert out["message"].startswith("Drop hook: Drop not done: ")
    assert rig.tel.calls == []
    assert rig.sio.of("attachment_state") == []                  # nothing was sent


async def test_drop_needs_a_confirm_and_the_attachment_must_be_there(rig):
    await drop_hook()
    out = await control.use(rig.s, "hook0001", "drop")
    assert out["reason_code"] == "needs_confirm"
    assert (await control.use(rig.s, "nope0000", "drop", confirm=True))["reason_code"] == "no_attachment"
    assert (await control.use(rig.s, "hook0001", "open", confirm=True))["reason_code"] == "no_attachment"
    await att_store.write_store().update("d1", {**(await att_store.read_store().get("d1", "hook0001")),
                                                "enabled": False})
    assert (await control.use(rig.s, "hook0001", "drop", confirm=True))["reason_code"] == "disabled"
    rig.s.drone = {"id": "d2"}                                   # another drone: not fitted
    assert (await control.use(rig.s, "hook0001", "drop", confirm=True))["reason_code"] == "no_attachment"
    assert rig.tel.calls == []


async def test_height_limits_and_orange_zones(rig, monkeypatch):
    from app.zones import monitor
    await drop_hook(limits={"min_alt_m": 5, "max_alt_m": 30})
    rig.tel.snapshot.position.relative_altitude_m = 31.0
    assert (await control.use(rig.s, "hook0001", "drop", confirm=True))["reason_code"] == "too_high"
    rig.tel.snapshot.position.relative_altitude_m = 12.0
    rig.zone.update(cls="orange", zones=[{"id": "z1", "zone_class": "orange", "permission_required": True}])
    permitted = set()

    async def permits(session, lat, lng, fresh=False):
        assert fresh is True                                     # read now, not the cache
        if permitted == {"boom"}:
            raise RuntimeError("database down")
        return permitted
    monkeypatch.setattr(monitor, "permitted_zone_ids", permits)
    assert (await control.use(rig.s, "hook0001", "drop", confirm=True))["reason_code"] == "orange_no_permit"
    permitted.add("boom")                                        # a failed read counts as none
    assert (await control.use(rig.s, "hook0001", "drop", confirm=True))["reason_code"] == "orange_no_permit"
    permitted.clear()
    permitted.add("z1")
    out = await control.use(rig.s, "hook0001", "drop", confirm=True)
    assert out["ok"] is True and rig.tel.calls == [("actuator", 3, 1.0)]


async def test_people_check_uses_fresh_results_only(rig):
    await drop_hook()
    # No AI at all: allowed, and the answer says there was no people check.
    out = await control.use(rig.s, "hook0001", "drop", confirm=True)
    assert out["ok"] and out["message"].endswith("(no people check: no AI running)")
    see("sess-1", [("person", 0.9)], age=2.5)                     # stale: no AI running
    assert (await control.use(rig.s, "hook0001", "drop", confirm=True))["ok"] is True
    see("sess-1", [("person", 0.3), ("car", 0.9)])               # weak person, other classes
    out = await control.use(rig.s, "hook0001", "drop", confirm=True)
    assert out["ok"] and "no people check" not in out["message"]
    people.note("sess-1", "human-tracking", {"person_count": 2})  # a count with no boxes
    assert (await control.use(rig.s, "hook0001", "drop", confirm=True))["reason_code"] == "people_below"
    # Switched off on the attachment: not checked.
    await att_store.write_store().update("d1", kinds.clean(
        {"limits": {"people_check": False}}, existing=await att_store.read_store().get("d1", "hook0001")))
    assert (await control.use(rig.s, "hook0001", "drop", confirm=True))["ok"] is True


async def test_staff_holding_the_takeover_may_use_it(rig):
    await drop_hook()
    takeover.start("sess-1", "staff-1", user_id="u9", username="ops", workspace_id=None)
    staff = SimpleNamespace(session_id="staff-1", socket_id="sock-staff", user_id="u9",
                            username="ops", role="admin", client_ip="")
    out = await control.use(rig.s, "hook0001", "drop", confirm=True, actor_session=staff)
    assert out["ok"] is True
    assert {to for e, _, to in rig.sio.emitted if e == "attachment_result"} == {"sock-1", "sock-staff"}
    assert (await control.use(rig.s, "hook0001", "drop", confirm=True))["reason_code"] == "taken_over"


async def test_command_failures_say_why(rig):
    await drop_hook()
    rig.tel.answer = False
    out = await control.use(rig.s, "hook0001", "drop", confirm=True)
    assert out["reason_code"] == "failed"
    assert out["message"].endswith("the drone refused the command (pre-arm check failed)")
    assert rig.sio.of("attachment_state")[-1]["attachments"][0]["ok"] is False
    rig.tel.missing = True
    assert (await control.use(rig.s, "hook0001", "drop", confirm=True))["reason_code"] == "not_supported"


async def test_gripper_and_winch_wiring_reach_their_plugins(rig):
    await add({"kind": "gripper", "id": "grip0001", "wiring": {"type": "gripper", "instance": 1}})
    await add({"kind": "winch", "id": "winc0001", "wiring": {"type": "winch"}})
    assert (await control.use(rig.s, "grip0001", "close"))["ok"]
    assert (await control.use(rig.s, "winc0001", "lower", confirm=True))["ok"]
    assert rig.tel.calls == [("gripper", 1, "grab"), ("winch", 0, "deliver")]


async def test_every_use_is_audited(rig):
    await drop_hook()
    await control.use(rig.s, "hook0001", "drop", confirm=True)
    await control.use(rig.s, "hook0001", "drop")
    rows = await auth.memory_store().list_audit(None, 10, None)
    assert [r.action for r in rows] == ["attachment.use", "attachment.use"]
    refused, done = rows
    assert done.actor_name == "pat" and done.target_id == "d1" and done.workspace_id == "ws1"
    assert done.detail["attachment_id"] == "hook0001" and done.detail["action_id"] == "drop"
    assert done.detail["ok"] is True and refused.detail["reason_code"] == "needs_confirm"


async def test_real_manager_methods_report_missing_plugins():
    from app.telemetry.manager import TelemetryManager
    tel = TelemetryManager.__new__(TelemetryManager)
    tel._drone = SimpleNamespace(action=SimpleNamespace(), gripper=None)
    tel.last_action_error = None
    with pytest.raises(NotImplementedError):
        await tel.set_actuator(1, 1.0)
    with pytest.raises(NotImplementedError):
        await tel.gripper_command(0, "grab")
    with pytest.raises(NotImplementedError):
        await tel.winch_command(0, "deliver")
    sent = []

    async def set_actuator(i, v):
        sent.append((i, v))
    tel._drone = SimpleNamespace(action=SimpleNamespace(set_actuator=set_actuator))
    assert await tel.set_actuator(3, -1) is True and sent == [(3, -1.0)]


def test_installed_mavsdk_has_the_plugins():
    from mavsdk.action import Action
    from mavsdk.gripper import Gripper
    from mavsdk.winch import Winch
    assert hasattr(Action, "set_actuator")
    assert hasattr(Gripper, "grab") and hasattr(Gripper, "release")
    for op in ("deliver", "retract", "hold"):
        assert hasattr(Winch, op)


# ── mission actions ──────────────────────────────────────────────────────

WP = [{"lat": 17.600, "lng": 78.100, "altitude": 20.0},
      {"lat": 17.601, "lng": 78.100, "altitude": 20.0},
      {"lat": 17.602, "lng": 78.100, "altitude": 20.0}]


def wps(*acts):
    out = [dict(w) for w in WP]
    for i, a in acts:
        out[i].setdefault("actions", []).append(a)
    return out


async def test_mission_actions_are_checked_at_upload(rig):
    await drop_hook()
    await add({"kind": "light", "id": "lamp0001", "wiring": {"type": "actuator", "index": 5}})
    assert await mission.prepare(rig.s, WP, allow=False) is None
    drop = {"attachment_id": "hook0001", "action_id": "drop"}
    with pytest.raises(mission.MissionActionError) as e:
        await mission.prepare(rig.s, wps((1, drop)), allow=False)
    assert e.value.code == "needs_confirm" and "Waypoint 2" in str(e.value)
    plan = await mission.prepare(rig.s, wps((1, drop), (2, {"attachment_id": "lamp0001",
                                                            "action_id": "on"})), allow=True)
    assert sorted(plan.by_wp) == [1, 2]
    light = {"attachment_id": "lamp0001", "action_id": "on"}
    with pytest.raises(mission.MissionActionError, match="at most 3"):
        await mission.prepare(rig.s, wps(*[(0, light)] * 4), allow=True)
    with pytest.raises(mission.MissionActionError) as e:
        await mission.prepare(rig.s, wps((0, {"attachment_id": "gone0000", "action_id": "on"})), allow=True)
    assert e.value.code == "no_attachment"
    rig.s.drone = None
    with pytest.raises(mission.MissionActionError, match="not identified"):
        await mission.prepare(rig.s, wps((0, light)), allow=True)


async def settle():
    for _ in range(10):
        await asyncio.sleep(0)


def at(rig, i, mode="MISSION", alt=20.0):
    snap = rig.tel.snapshot
    snap.flight_mode.mode = mode
    snap.mission_current_index = i
    snap.position.latitude_deg, snap.position.longitude_deg = WP[i]["lat"], WP[i]["lng"]
    snap.position.relative_altitude_m = alt


async def test_mission_actions_run_when_the_waypoint_is_reached(rig):
    await drop_hook()
    await add({"kind": "light", "id": "lamp0001", "wiring": {"type": "actuator", "index": 5}})
    plan = await mission.prepare(rig.s, wps((1, {"attachment_id": "hook0001", "action_id": "drop"}),
                                            (2, {"attachment_id": "lamp0001", "action_id": "on"})),
                                 allow=True)
    mission.arm("sess-1", plan)
    # Heading for waypoint 2, not there yet: nothing.
    at(rig, 1)
    rig.tel.snapshot.position.latitude_deg = 17.5995
    mission.on_telemetry(rig.s, rig.tel)
    await settle()
    assert rig.tel.calls == []
    # Paused in HOLD at the waypoint: nothing (only a flying mission).
    at(rig, 1, mode="HOLD")
    mission.on_telemetry(rig.s, rig.tel)
    await settle()
    assert rig.tel.calls == []
    at(rig, 1)
    mission.on_telemetry(rig.s, rig.tel)
    await settle()
    assert rig.tel.calls == [("actuator", 3, 1.0)]
    res = rig.sio.of("attachment_result")[-1]
    assert res["ok"] and res["source"] == "mission" and res["waypoint"] == 2
    mission.on_telemetry(rig.s, rig.tel)                          # once per pass
    await settle()
    assert len(rig.tel.calls) == 1
    # Restarted from the first waypoint: it runs again on the next pass.
    at(rig, 0)
    mission.on_telemetry(rig.s, rig.tel)
    at(rig, 1)
    mission.on_telemetry(rig.s, rig.tel)
    await settle()
    assert len(rig.tel.calls) == 2


async def test_mission_hazard_actions_keep_their_guards_and_are_refused_when_passed(rig):
    await drop_hook()
    await add({"kind": "light", "id": "lamp0001", "wiring": {"type": "actuator", "index": 5}})
    plan = await mission.prepare(rig.s, wps((0, {"attachment_id": "hook0001", "action_id": "drop"}),
                                            (0, {"attachment_id": "lamp0001", "action_id": "on"}),
                                            (1, {"attachment_id": "hook0001", "action_id": "drop"})),
                                 allow=True)
    mission.arm("sess-1", plan)
    # Waypoint 1 skipped in a telemetry gap: the drone is past it.
    at(rig, 1)
    rig.tel.snapshot.position.latitude_deg = 17.5995
    mission.on_telemetry(rig.s, rig.tel)
    await settle()
    results = rig.sio.of("attachment_result")
    assert [(r["attachment_id"], r["ok"], r.get("reason_code")) for r in results] == [
        ("hook0001", False, "passed_waypoint"), ("lamp0001", True, None)]
    # Waypoint 2 reached with someone below: the guard still holds.
    see("sess-1", [("person", 0.9)])
    at(rig, 1)
    mission.on_telemetry(rig.s, rig.tel)
    await settle()
    assert rig.sio.of("attachment_result")[-1]["reason_code"] == "people_below"
    assert rig.tel.calls == [("actuator", 5, 1.0)]
    mission.clear("sess-1")
    assert mission.plan_of("sess-1") is None


# ── custom-model rules ───────────────────────────────────────────────────

def arule(**kw):
    r = {"id": "rule0001", "label": "person", "action": "attachment",
         "attachment_kind": "release", "attachment_action": "drop"}
    r.update(kw)
    return r


def test_attachment_rules_validate_and_hazards_always_ask():
    from app.models_custom import rules
    out = rules.validate_rules([arule(confirm=False)])[0]
    assert out["confirm"] is True and out["attachment_kind"] == "release"
    light = rules.validate_rules([arule(attachment_kind="light", attachment_action="on",
                                        confirm=False)])[0]
    assert light["confirm"] is False and "attachment_value" not in light
    spray = rules.validate_rules([arule(attachment_kind="sprayer", attachment_action="level")])[0]
    assert spray["attachment_value"] == 50.0 and spray["confirm"] is True
    custom = rules.validate_rules([arule(attachment_kind="custom", attachment_action="fire",
                                         confirm=False)])[0]
    assert custom["confirm"] is True                             # unknown states count as hazards
    assert rules.validate_rules([arule()], task="classify")      # no box needed
    for bad in (arule(attachment_kind="drone"), arule(attachment_action="open"),
                arule(attachment_kind="custom", attachment_action="Fire!"),
                arule(attachment_kind="sprayer", attachment_action="level", attachment_value=120)):
        with pytest.raises(rules.RuleError):
            rules.validate_rules([bad])
    # The rules without an attachment action look as before.
    assert "attachment_kind" not in rules.validate_rules([arule(action="alert")])[0]


@pytest.fixture
def rules_rig(rig, monkeypatch):
    from app.models_custom import actions, runtime
    spec = SimpleNamespace(model_id="m1", name="Crowd", via_catalogue=False, labels=["person"])
    rig.s.mode = SimpleNamespace(value="custom:m1", spec=spec)
    live = {"rules": []}
    monkeypatch.setattr(runtime, "live", lambda model_id: live if model_id == "m1" else None)
    actions.reset_for_tests()
    actions.configure(rig.sio, rig.sm, None)
    rig.live = live
    yield rig
    actions.reset_for_tests()
    actions.configure(None, None, None)


def afire(rule):
    return {"rule": rule, "label": "person", "score": 0.9, "box": [0, 0, 10, 10],
            "model_id": "m1", "model_name": "Crowd"}


async def test_attachment_rules_need_model_control_and_always_ask_for_a_drop(rules_rig):
    from app.models_custom import actions, rules
    r = rules_rig
    await drop_hook()
    rule = rules.clean_rule(arule(confirm=False))
    r.live["rules"] = [rule]
    f = afire(rule)
    await actions.run_attachment(r.s, f, actions._base(f, r.s))
    ev = r.sio.of("rule_event")[-1]
    assert (ev["status"], ev["reason_code"]) == ("refused", "model_control_off")
    await actions.set_enabled(r.s, True)
    await actions.run_attachment(r.s, f, actions._base(f, r.s))
    ask = r.sio.of("rule_event")[-1]
    assert ask["status"] == "awaiting_confirm" and ask["message"] == "Person seen (90%). Drop hook: Drop?"
    assert ask["attachment_kind"] == "release" and ask["attachment_id"] == "hook0001"
    assert r.tel.calls == []
    await actions.confirm(r.s, ask["token"], True)
    ev = r.sio.of("rule_event")[-1]
    assert ev["status"] == "done" and ev["token"] == ask["token"]
    assert r.tel.calls == [("actuator", 3, 1.0)]
    res = r.sio.of("attachment_result")[-1]
    assert res["source"] == "rule" and res["rule_id"] == "rule0001"


async def test_attachment_rules_refused_by_the_attachment_guards(rules_rig):
    from app.models_custom import actions, rules
    r = rules_rig
    light_rule = rules.clean_rule(arule(attachment_kind="light", attachment_action="on", confirm=False))
    r.live["rules"] = [light_rule]
    await actions.set_enabled(r.s, True)
    f = afire(light_rule)
    await actions.run_attachment(r.s, f, actions._base(f, r.s))
    assert r.sio.of("rule_event")[-1]["reason_code"] == "no_attachment"
    await add({"kind": "light", "id": "lamp0001", "wiring": {"type": "actuator", "index": 5}})
    await actions.run_attachment(r.s, f, actions._base(f, r.s))      # harmless, no ask: just done
    assert r.sio.of("rule_event")[-1]["status"] == "done" and r.tel.calls == [("actuator", 5, 1.0)]
    takeover.start("sess-1", "staff-1", user_id="u9", username="ops", workspace_id=None)
    await actions.run_attachment(r.s, f, actions._base(f, r.s))
    assert r.sio.of("rule_event")[-1]["reason_code"] == "taken_over"


async def test_editing_an_attachment_rule_switches_model_control_off(rules_rig):
    from app.models_custom import actions, rules
    r = rules_rig
    rule = rules.clean_rule(arule(attachment_kind="light", attachment_action="on", confirm=False))
    r.live["rules"] = [rule]
    await actions.set_enabled(r.s, True)
    assert actions._moving_rules(r.s) != ()                       # in the accepted snapshot
    r.live["rules"] = [{**rule, "attachment_action": "off"}]
    actions.on_telemetry("sess-1")
    await settle()
    assert not actions.is_enabled("sess-1")
    assert r.sio.of("model_control")[-1]["reason_code"] == "rules_changed"


# ── REST and the real socket handler ─────────────────────────────────────

from test_live_scope import live  # noqa: E402,F401  (fixture)


@pytest.fixture
def clean_attachments():
    att_store.reset_for_tests()
    control.reset_for_tests()
    yield
    att_store.reset_for_tests()
    control.reset_for_tests()


async def test_configure_needs_drones_manage_and_list_needs_view(live, clean_attachments):  # noqa: F811
    from test_live_scope import hdr, world
    w = await world(live)
    auth.memory_store()._drones["d1"] = {"id": "d1", "name": "Hexa", "workspace_id": w.iith["id"],
                                         "is_simulated": False}
    cl = live.cl
    body = {"kind": "release", "wiring": {"type": "actuator", "index": 3}}
    r = cl.post("/api/drones/d1/attachments", headers=hdr(w.pat[1]), json=body)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "forbidden"     # pilot
    r = cl.post("/api/drones/d1/attachments", headers=hdr(w.olga[1]), json=body)
    assert r.status_code == 200, r.text
    att = r.json()["attachment"]
    assert att["name"] == "Drop hook" and att["wiring"] == {"type": "actuator", "index": 3}
    r = cl.get("/api/drones/d1/attachments", headers=hdr(w.vic[1]))             # viewer reads
    assert r.status_code == 200
    got = r.json()
    assert [a["id"] for a in got["attachments"]] == [att["id"]]
    assert got["can_manage"] is False and got["linked"] is False and got["armed"] is None
    assert cl.get("/api/drones/d1/attachments", headers=hdr(w.olga[1])).json()["can_manage"] is True
    # Another organization's customer, a HYRAK pilot: not even there.
    _, sky_owner = await _owner_of(live, w, w.sky)
    assert cl.get("/api/drones/d1/attachments", headers=hdr(sky_owner)).status_code == 404
    assert cl.get("/api/drones/d1/attachments", headers=hdr(w.hp[1])).status_code == 404
    assert cl.get("/api/drones/nope/attachments", headers=hdr(w.olga[1])).status_code == 404
    # Edit, refuse a bad edit, delete; the founder may too.
    url = f"/api/drones/d1/attachments/{att['id']}"
    r = cl.patch(url, headers=hdr(w.olga[1]), json={"name": "Left hook"})
    assert r.status_code == 200 and r.json()["attachment"]["name"] == "Left hook"
    r = cl.patch(url, headers=hdr(w.olga[1]), json={"wiring": {"type": "winch"}})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "bad_request"
    assert "release" in r.json()["detail"]["error"]
    assert cl.patch(url, headers=hdr(w.pat[1]), json={"name": "x"}).status_code == 403
    assert cl.delete(url, headers=hdr(w.founder[1])).status_code == 200
    assert cl.delete(url, headers=hdr(w.founder[1])).status_code == 404
    # At most eight.
    for i in range(8):
        assert cl.post("/api/drones/d1/attachments", headers=hdr(w.olga[1]), json=body).status_code == 200
    r = cl.post("/api/drones/d1/attachments", headers=hdr(w.olga[1]), json=body)
    assert r.status_code == 400 and "at most 8" in r.json()["detail"]["error"]
    rows = await auth.memory_store().list_audit(None, 50, None)
    assert {"attachment.create", "attachment.update", "attachment.delete"} <= {x.action for x in rows}
    kinds_out = cl.get("/api/attachments/kinds", headers=hdr(w.vic[1])).json()
    assert kinds_out["max_per_drone"] == 8


async def _owner_of(live, w, ws):
    from test_live_scope import account, hdr, ok
    u = await account("skyowner")
    ok(live.cl.post(f"/api/workspaces/{ws['id']}/members", headers=hdr(w.founder[1]),
                    json={"login": "skyowner", "role": "owner"}))
    return u


async def test_bench_test_only_on_a_linked_disarmed_drone(live, clean_attachments):  # noqa: F811
    from test_live_scope import connect, hdr, world
    w = await world(live)
    drone = {"id": "d1", "name": "Hexa", "workspace_id": w.iith["id"], "is_simulated": False}
    auth.memory_store()._drones["d1"] = dict(drone)
    cl = live.cl
    att = cl.post("/api/drones/d1/attachments", headers=hdr(w.olga[1]),
                  json={"kind": "release", "wiring": {"type": "actuator", "index": 3}}).json()["attachment"]
    url = f"/api/drones/d1/attachments/{att['id']}/test"
    out = cl.post(url, headers=hdr(w.olga[1]), json={"action_id": "drop"}).json()
    assert (out["ok"], out["reason_code"]) == (False, "not_linked")
    await connect(live, "p", w.pat[1])
    s = live.sm.get_by_socket("p")
    tel = Tel()
    live.sm._telemetry[s.session_id] = tel
    s.drone = dict(drone)
    out = cl.post(url, headers=hdr(w.olga[1]), json={"action_id": "drop"}).json()
    assert out["reason_code"] == "armed" and tel.calls == []
    assert cl.get("/api/drones/d1/attachments", headers=hdr(w.olga[1])).json()["armed"] is True
    tel.snapshot.flight_mode.is_armed = False
    tel.snapshot.flight_mode.is_in_air = False
    out = cl.post(url, headers=hdr(w.olga[1]), json={"action_id": "drop"}).json()
    assert out["ok"] is True and out["source"] == "test" and tel.calls == [("actuator", 3, 1.0)]
    assert cl.post(url, headers=hdr(w.pat[1]), json={"action_id": "drop"}).status_code == 403
    assert cl.post(url, headers=hdr(w.olga[1]), json={"action_id": "open"}).status_code == 400
    takeover.start(s.session_id, "staff-1", user_id="someone", username="ops", workspace_id=None)
    try:
        out = cl.post(url, headers=hdr(w.olga[1]), json={"action_id": "drop"}).json()
        assert out["reason_code"] == "taken_over" and len(tel.calls) == 1
    finally:
        takeover.reset_for_tests()
    rows = await auth.memory_store().list_audit(None, 50, None)
    tests = [x for x in rows if x.action == "attachment.test"]
    assert len(tests) == 4 and tests[-1].detail["reason_code"] == "not_linked"


async def test_socket_handler_is_guarded_and_answers(live, clean_attachments):  # noqa: F811
    from test_live_scope import connect, errors, world
    w = await world(live)
    drone = {"id": "d1", "name": "Hexa", "workspace_id": w.iith["id"], "is_simulated": False}
    auth.memory_store()._drones["d1"] = dict(drone)
    await att_store.write_store().create("d1", kinds.clean(
        {"kind": "release", "id": "hook0001", "wiring": {"type": "actuator", "index": 3}}))
    await connect(live, "v", w.vic[1])
    await connect(live, "p", w.pat[1])
    h = live.sio.handlers["/"]
    payload = {"attachment_id": "hook0001", "action_id": "drop", "confirm": True}
    await h["attachment_action"]("v", payload)
    assert errors(live, "v")[-1]["event"] == "attachment_action"           # viewers do not command
    res = live.rec.of("attachment_result", "v")[-1]
    assert res["ok"] is False and res["reason_code"] == "forbidden" and res["attachment_id"] == "hook0001"
    await h["attachment_action"]("p", payload)
    assert live.rec.of("attachment_result", "p")[-1]["reason_code"] == "no_link"
    s = live.sm.get_by_socket("p")
    tel = Tel()
    live.sm._telemetry[s.session_id] = tel
    s.drone, s.drone_fly = dict(drone), True
    await h["attachment_action"]("p", {**payload, "confirm": False})
    assert live.rec.of("attachment_result", "p")[-1]["reason_code"] == "needs_confirm"
    await h["attachment_action"]("p", payload)
    assert live.rec.of("attachment_result", "p")[-1]["ok"] is True
    assert tel.calls == [("actuator", 3, 1.0)]
    assert live.rec.of("attachment_state", "p")[-1]["attachments"][0]["last_action_id"] == "drop"


async def test_attachment_ids_are_unique_across_drones_and_results_carry_the_name(live, clean_attachments):  # noqa: F811
    from test_live_scope import hdr, world
    w = await world(live)
    for d in ("d1", "d2"):
        auth.memory_store()._drones[d] = {"id": d, "name": d, "workspace_id": w.iith["id"],
                                          "is_simulated": False}
    body = {"kind": "light", "id": "lamp0001", "wiring": {"type": "actuator", "index": 1}}
    assert live.cl.post("/api/drones/d1/attachments", headers=hdr(w.olga[1]), json=body).status_code == 200
    r = live.cl.post("/api/drones/d2/attachments", headers=hdr(w.olga[1]), json=body)
    assert r.status_code == 400 and "already used" in r.json()["detail"]["error"]
    # A null value falls back to the kind's default.
    r = live.cl.post("/api/drones/d2/attachments", headers=hdr(w.olga[1]),
                     json={**body, "id": "lamp0002", "actions": [{"id": "on", "value": None}]})
    assert r.json()["attachment"]["actions"][0]["value"] == 1.0
    out = live.cl.post("/api/drones/d1/attachments/lamp0001/test", headers=hdr(w.olga[1]),
                       json={"action_id": "on"}).json()
    assert out["name"] == "Light" and out["reason_code"] == "not_linked"
