"""
No-code rules for custom models (app/models_custom/rules.py, actions.py,
events.py):

  * validation: bad values, more than six rules, two follow rules, box
    actions on a classifier;
  * the engine: seen-for with gaps up to 0.5 s, cooldown, rules_state;
  * "Ask me first" tokens: accept, decline, expire, wrong session;
  * the guards in front of hover and follow (model control off, taken over,
    pilot control, red zone, orange without a permit) and mark without a
    position;
  * model control switching itself off (link lost, red-zone lock, pilot,
    takeover, leaving the model) and a follow ending on a lost target;
  * drone_command reaching stream_track only while a follow is on;
  * the real socket handlers, classified and guarded.

Everything below the handlers runs against stand-ins: no drone, no link.
"""
import asyncio
from types import SimpleNamespace

import pytest

from app.models_custom import actions, rules
from app.sessions import takeover


# ── validation ───────────────────────────────────────────────────────────

def rule(**kw):
    r = {"id": "rule0001", "label": "person", "action": "alert"}
    r.update(kw)
    return r


def test_valid_rules_get_their_defaults():
    out = rules.validate_rules([rule(), rule(id="rule0002", action="hover", label="PERSON")],
                               labels=["person", "car"])
    assert out[0] == {"id": "rule0001", "enabled": True, "label": "person", "min_score": 0.5,
                      "for_s": 1.0, "action": "alert", "confirm": False, "cooldown_s": 30.0}
    assert out[1]["confirm"] is True and out[1]["label"] == "person"
    assert rules.validate_rules(None) is None and rules.validate_rules([]) == []


@pytest.mark.parametrize("bad", [
    rule(min_score=1.5), rule(min_score=0.01), rule(for_s=31), rule(for_s=-1),
    rule(cooldown_s=1), rule(cooldown_s=601), rule(action="fly"), rule(id="ABC"),
    rule(id="short"), rule(label=""), rule(label="dog"), rule(enabled="yes"),
    rule(min_score="high"), rule(min_score=True), "not a rule",
])
def test_bad_rules_are_refused_with_a_reason(bad):
    with pytest.raises(rules.RuleError) as e:
        rules.validate_rules([bad], labels=["person", "car"])
    assert str(e.value)


def test_at_most_six_rules_and_one_follow():
    with pytest.raises(rules.RuleError, match="at most 6"):
        rules.validate_rules([rule(id=f"rule000{i}") for i in range(7)])
    two = [rule(action="follow"), rule(id="rule0002", action="follow")]
    with pytest.raises(rules.RuleError, match="one follow"):
        rules.validate_rules(two)
    two[1]["enabled"] = False
    assert len(rules.validate_rules(two)) == 2              # a second one switched off is fine
    with pytest.raises(rules.RuleError, match="same id"):
        rules.validate_rules([rule(), rule()])


def test_classifier_models_get_no_box_actions():
    for action in ("mark", "follow"):
        with pytest.raises(rules.RuleError, match="boxes"):
            rules.validate_rules([rule(action=action)], task="classify")
    assert rules.validate_rules([rule(action="hover")], task="classify")


# ── the engine ───────────────────────────────────────────────────────────

HIT = [("person", 0.8, [10, 10, 50, 90])]


def test_seen_for_survives_short_gaps_and_resets_on_long_ones():
    eng = rules.RuleEngine()
    r = [rules.clean_rule(rule(for_s=1.0))]
    fires, st = eng.update(r, HIT, 0.0)
    assert not fires and st[0]["seen_for_s"] == 0.0 and not st[0]["firing"]
    eng.update(r, [], 0.2)                                   # a 0.45 s gap still counts
    fires, st = eng.update(r, HIT, 0.45)
    assert not fires and st[0]["seen_for_s"] == 0.45
    fires, st = eng.update(r, [], 1.2)                       # 0.75 s gap: starts again
    assert st[0]["seen_for_s"] == 0.0
    eng.update(r, HIT, 2.0)
    eng.update(r, HIT, 2.5)
    fires, st = eng.update(r, HIT, 3.0)
    assert len(fires) == 1 and st[0]["firing"] and st[0]["cooling_s"] == 30.0
    assert fires[0] == {"rule": r[0], "label": "person", "score": 0.8, "box": [10, 10, 50, 90]}


def test_low_scores_and_other_classes_do_not_count():
    eng = rules.RuleEngine()
    r = [rules.clean_rule(rule(for_s=0.0, min_score=0.9))]
    assert eng.update(r, HIT + [("car", 0.99, None)], 0.0)[0] == []
    assert len(eng.update(r, [("Person", 0.95, None)], 0.1)[0]) == 1      # case-insensitive


def test_cooldown_holds_a_rule_back_then_lets_it_fire_again():
    eng = rules.RuleEngine()
    r = [rules.clean_rule(rule(for_s=0.0, cooldown_s=5))]
    assert len(eng.update(r, HIT, 0.0)[0]) == 1
    t = 0.1
    while t < 5.0:
        fires, st = eng.update(r, HIT, t)
        assert not fires and st[0]["cooling_s"] > 0
        t += 0.25
    assert len(eng.update(r, HIT, 5.05)[0]) == 1


def test_disabled_rules_report_but_never_fire():
    eng = rules.RuleEngine()
    r = [rules.clean_rule(rule(for_s=0.0, enabled=False))]
    fires, st = eng.update(r, HIT, 0.0)
    assert fires == [] and st[0]["rule_id"] == "rule0001" and not st[0]["firing"]


# ── confirm tokens ───────────────────────────────────────────────────────

def test_confirm_tokens_accept_once_expire_and_stay_with_their_session():
    p = rules.PendingConfirms(ttl_s=10.0)
    a = p.add("s1", {"x": 1}, now=100.0)
    assert a.expires_at == 110.0
    assert p.take(a.token, "s2", now=101.0) is None          # another session's
    assert p.take(a.token, "s1", now=101.0).entry == {"x": 1}
    assert p.take(a.token, "s1", now=101.0) is None          # used up
    b = p.add("s1", {}, now=100.0)
    assert p.take(b.token, "s1", now=110.5) is None          # expired
    c = p.add("s1", {}, now=100.0)
    assert p.expired(now=105.0) == [] and [x.token for x in p.expired(now=111.0)] == [c.token]
    assert len(p) == 0


# ── actions against stand-ins ────────────────────────────────────────────

class Tel:
    def __init__(self):
        self.is_connected = True
        self.pilot_has_control = False
        self.automation_locked = False
        self._offboard_active = False
        self.last_action_error = None
        self.offboard_ok = True
        self.calls = []
        self.snapshot = SimpleNamespace(
            link_ok=True, flight_mode=SimpleNamespace(mode="HOLD", is_in_air=True),
            position=SimpleNamespace(latitude_deg=17.6, longitude_deg=78.1, relative_altitude_m=20.0))

    async def start_offboard(self):
        self.calls.append("start_offboard")
        if not self.offboard_ok:
            self.last_action_error = "the drone refused Offboard"
            return False
        self._offboard_active = True
        return True

    async def stop_offboard(self):
        self.calls.append("stop_offboard")
        self._offboard_active = False
        return True

    async def set_flight_mode(self, mode):
        self.calls.append(f"mode:{mode}")
        return True

    async def pause_mission(self):
        self.calls.append("pause_mission")
        return True


class Analyzer:
    def __init__(self):
        self.follow = None
        self.now = None                 # what current_box answers: (box, score) or None

    def current_box(self, label, near):
        return self.now

    def start_follow(self, label, box, score):
        self.follow = (label, box, score)

    def stop_follow(self):
        self.follow = None

    @property
    def following(self):
        return self.follow is not None


class Sio:
    def __init__(self):
        self.emitted = []

    async def emit(self, event, data=None, to=None, **kw):
        self.emitted.append((event, data, to))

    def of(self, event):
        return [d for e, d, _ in self.emitted if e == event]


@pytest.fixture
def rig(monkeypatch):
    sio, tel, an = Sio(), Tel(), Analyzer()
    spec = SimpleNamespace(model_id="m1", name="Cracks")
    s = SimpleNamespace(session_id="sess-1", socket_id="sock-1", zone_lock=False, drone=None,
                        mode=SimpleNamespace(value="custom:m1", spec=spec))
    sm = SimpleNamespace(get=lambda sid: s if sid == s.session_id else None,
                         get_telemetry=lambda sid: rig.tel if sid == s.session_id else None,
                         all_sessions=lambda: [s])
    pool = SimpleNamespace(get_for_session=lambda sid: an)
    rig = SimpleNamespace(sio=sio, tel=tel, an=an, s=s, sm=sm)
    actions.reset_for_tests()
    actions.configure(sio, sm, pool)
    takeover.reset_for_tests()
    yield rig
    actions.reset_for_tests()
    actions.configure(None, None, None)
    takeover.reset_for_tests()


async def settle():
    for _ in range(5):
        await asyncio.sleep(0)


def fire(action, *, confirm=False, label="person", score=0.82, box=(10, 10, 50, 90)):
    r = rules.clean_rule(rule(action=action, confirm=confirm))
    return {"rule": r, "label": label, "score": score, "box": list(box) if box else None,
            "model_id": "m1", "model_name": "Cracks"}


def last_event(rig):
    return rig.sio.of("rule_event")[-1]


async def test_model_control_on_is_refused_without_its_conditions(rig):
    rig.tel.is_connected = False
    assert (await actions.set_enabled(rig.s, True))["reason_code"] == "no_link"
    rig.tel.is_connected = True
    rig.tel.pilot_has_control = True
    assert (await actions.set_enabled(rig.s, True))["reason_code"] == "pilot_control"
    rig.tel.pilot_has_control = False
    takeover.start(rig.s.session_id, "staff-1", user_id="u", username="ops", workspace_id=None)
    assert (await actions.set_enabled(rig.s, True))["reason_code"] == "taken_over"
    takeover.reset_for_tests()
    manual = rig.s.mode
    rig.s.mode = SimpleNamespace(value="manual-control")
    out = await actions.set_enabled(rig.s, True)
    assert out == {"enabled": False, "reason_code": "mode_changed",
                   "reason": "no custom model is running"}
    rig.s.mode = manual
    assert await actions.set_enabled(rig.s, True) == {"enabled": True}
    assert rig.sio.of("model_control")[-1] == {"enabled": True}
    assert actions.is_enabled("sess-1")


async def test_moving_actions_need_model_control(rig):
    for action in ("hover", "follow"):
        await actions.run_moving(rig.s, fire(action), actions._base(fire(action), rig.s))
        ev = last_event(rig)
        assert ev["status"] == "refused" and ev["reason_code"] == "model_control_off"
        assert ev["message"].endswith("model control is off") and ev["action"] == action
    assert rig.tel.calls == []


@pytest.mark.parametrize("setup,code", [
    (lambda r: takeover.start(r.s.session_id, "staff-1", user_id="u", username="ops",
                              workspace_id=None), "taken_over"),
    (lambda r: setattr(r.tel, "pilot_has_control", True), "pilot_control"),
    (lambda r: setattr(r.tel, "is_connected", False), "no_link"),
    (lambda r: setattr(r.tel.snapshot.flight_mode, "is_in_air", False), "not_flying"),
    (lambda r: setattr(r.s, "zone_lock", True), "red_zone"),
])
async def test_each_guard_refuses_hover_and_follow(rig, setup, code):
    await actions.set_enabled(rig.s, True)
    setup(rig)
    for action in ("hover", "follow"):
        await actions.run_moving(rig.s, fire(action), actions._base(fire(action), rig.s))
        ev = last_event(rig)
        assert (ev["status"], ev["reason_code"]) == ("refused", code), action
    assert rig.tel.calls == [] and rig.an.follow is None


async def test_follow_refused_in_red_and_in_orange_without_a_permit(rig, monkeypatch):
    from app.zones import engine, monitor
    await actions.set_enabled(rig.s, True)
    zone = {"id": "z1", "name": "Campus", "zone_class": "red", "permission_required": True}
    monkeypatch.setattr(engine, "check_point", lambda *a: {"zone_class": zone["zone_class"],
                                                           "zones": [zone]})
    permitted = set()

    async def permits(session, lat, lng, **kw):
        return permitted
    monkeypatch.setattr(monitor, "permitted_zone_ids", permits)
    await actions.run_moving(rig.s, fire("follow"), actions._base(fire("follow"), rig.s))
    assert last_event(rig)["reason_code"] == "red_zone"
    zone["zone_class"] = "orange"
    await actions.run_moving(rig.s, fire("follow"), actions._base(fire("follow"), rig.s))
    assert last_event(rig)["reason_code"] == "orange_no_permit"
    permitted.add("z1")                                       # under a permit: allowed
    await actions.run_moving(rig.s, fire("follow"), actions._base(fire("follow"), rig.s))
    assert last_event(rig)["status"] == "done" and rig.an.follow is not None
    # Hover is a stop, so an orange zone does not hold it back.
    permitted.clear()
    await actions.stop_follow("sess-1", "model_control_off")
    await actions.run_moving(rig.s, fire("hover"), actions._base(fire("hover"), rig.s))
    assert last_event(rig)["status"] == "done"


async def test_hover_holds_or_pauses_the_mission(rig):
    await actions.set_enabled(rig.s, True)
    await actions.run_moving(rig.s, fire("hover"), actions._base(fire("hover"), rig.s))
    ev = last_event(rig)
    assert ev["status"] == "done" and ev["message"] == "Person seen (82%): hovering"
    assert rig.tel.calls == ["mode:HOLD"]
    rig.tel.snapshot.flight_mode.mode = "MISSION"
    await actions.run_moving(rig.s, fire("hover"), actions._base(fire("hover"), rig.s))
    assert rig.tel.calls[-1] == "pause_mission"


async def test_ask_me_first_accept_decline_and_expire(rig):
    await actions.set_enabled(rig.s, True)
    f = fire("follow", confirm=True)
    await actions.run_moving(rig.s, f, actions._base(f, rig.s))
    ask = last_event(rig)
    assert ask["status"] == "awaiting_confirm" and ask["token"] and ask["expires_at"] > ask["ts"]
    assert ask["message"] == "Person seen (82%). Follow it?"
    assert rig.tel.calls == [] and rig.an.follow is None      # nothing moves before the yes
    # The yes runs every guard again: here the pilot took the drone meanwhile.
    rig.tel.pilot_has_control = True
    await actions.confirm(rig.s, ask["token"], True)
    ev = last_event(rig)
    assert (ev["status"], ev["reason_code"], ev["token"]) == ("refused", "pilot_control", ask["token"])
    rig.tel.pilot_has_control = False
    # Used up: the same token again is expired.
    await actions.confirm(rig.s, ask["token"], True)
    assert last_event(rig)["status"] == "expired" and last_event(rig)["token"] == ask["token"]

    h = fire("hover", confirm=True)
    await actions.run_moving(rig.s, h, actions._base(h, rig.s))
    ask = last_event(rig)
    assert ask["message"] == "Person seen (82%). Stop and hover here?"
    await actions.confirm(rig.s, ask["token"], False)
    ev = last_event(rig)
    assert ev["status"] == "declined" and ev["token"] == ask["token"] and rig.tel.calls == []

    await actions.run_moving(rig.s, h, actions._base(h, rig.s))
    ask = last_event(rig)
    await actions.confirm(rig.s, ask["token"], True)
    ev = last_event(rig)
    assert ev["status"] == "done" and ev["token"] == ask["token"] and rig.tel.calls == ["mode:HOLD"]

    # Nobody answers: the next frame after the deadline says so.
    await actions.run_moving(rig.s, h, actions._base(h, rig.s))
    ask = last_event(rig)
    actions._pending._by_token[ask["token"]].expires_at = 0.0
    await actions.on_result("sess-1", "custom:m1", {})
    await settle()
    ev = last_event(rig)
    assert ev["status"] == "expired" and ev["token"] == ask["token"]
    await actions.confirm(rig.s, "no-such-token", True)
    assert last_event(rig)["status"] == "expired"


async def test_follow_starts_offboard_then_steers_and_stops_on_a_lost_target(rig):
    await actions.set_enabled(rig.s, True)
    f = fire("follow")
    await actions.run_moving(rig.s, f, actions._base(f, rig.s))
    assert last_event(rig)["status"] == "done" and last_event(rig)["message"].endswith("following")
    assert rig.tel.calls == ["start_offboard"] and rig.an.follow == ("person", [10, 10, 50, 90], 0.82)
    assert rig.sio.of("model_control")[-1]["following"]["label"] == "person"
    cmd = rules.velocity(forward=1.0)
    meta = {"drone_command": dict(cmd), "follow": {"active": True}}
    await actions.on_result("sess-1", "custom:m1", meta)
    assert meta["drone_command"] == cmd and meta["model_control"] is True
    # A second firing while following does nothing.
    await actions.run_moving(rig.s, f, actions._base(f, rig.s))
    assert rig.tel.calls == ["start_offboard"]

    meta = {"_follow_lost": True, "drone_command": dict(cmd)}
    await actions.on_result("sess-1", "custom:m1", meta)
    await settle()
    assert "drone_command" not in meta and "_follow_lost" not in meta
    assert rig.an.follow is None and not actions.following("sess-1")
    assert rig.tel.calls[1:] == ["stop_offboard", "mode:HOLD"]
    ev = last_event(rig)
    assert (ev["status"], ev["reason_code"], ev["action"]) == ("stopped", "target_lost", "follow")
    assert actions.is_enabled("sess-1")                       # control stays on


async def test_confirmed_follow_locks_on_where_the_target_is_now(rig):
    await actions.set_enabled(rig.s, True)
    f = fire("follow", confirm=True)
    await actions.run_moving(rig.s, f, actions._base(f, rig.s))
    ask = last_event(rig)
    # Seconds later the person has moved: the follow locks on the new box.
    rig.an.now = ([200, 40, 260, 160], 0.9)
    await actions.confirm(rig.s, ask["token"], True)
    assert last_event(rig)["status"] == "done"
    assert rig.an.follow == ("person", [200, 40, 260, 160], 0.9)


async def test_confirmed_follow_with_the_target_out_of_view_starts_nothing(rig):
    await actions.set_enabled(rig.s, True)
    f = fire("follow", confirm=True)
    await actions.run_moving(rig.s, f, actions._base(f, rig.s))
    ask = last_event(rig)
    rig.an.now = None
    await actions.confirm(rig.s, ask["token"], True)
    ev = last_event(rig)
    assert (ev["status"], ev["reason_code"]) == ("refused", "target_lost")
    assert rig.tel.calls == [] and rig.an.follow is None and not actions.following("sess-1")


def test_current_box_picks_the_nearest_box_of_the_class_on_a_fresh_frame():
    import time as _t
    from app.models_custom.analyzer import CustomModelAnalyzer

    class Stub:
        _last_hits = (_t.monotonic(), [("person", 0.9, [0, 0, 10, 10]), ("car", 0.99, [50, 50, 60, 60]),
                                       ("Person", 0.6, [100, 100, 110, 110])])
    pick = CustomModelAnalyzer.current_box
    assert pick(Stub, "person", [95, 95, 105, 105]) == ([100, 100, 110, 110], 0.6)
    assert pick(Stub, "person", None) == ([0, 0, 10, 10], 0.9)
    assert pick(Stub, "dog", None) is None
    Stub._last_hits = (_t.monotonic() - 5, Stub._last_hits[1])          # stale frame
    assert pick(Stub, "person", None) is None


async def test_follow_refused_when_offboard_is(rig):
    await actions.set_enabled(rig.s, True)
    rig.tel.offboard_ok = False
    await actions.run_moving(rig.s, fire("follow"), actions._base(fire("follow"), rig.s))
    ev = last_event(rig)
    assert ev["status"] == "refused" and ev["reason_code"] == "failed"
    assert "refused Offboard" in ev["message"] and rig.an.follow is None


async def test_drone_command_only_while_a_follow_is_on(rig):
    meta = {"drone_command": rules.velocity(forward=2.0), "follow": {"active": True}}
    await actions.on_result("sess-1", "custom:m1", meta)
    assert "drone_command" not in meta and "follow" not in meta and meta["model_control"] is False
    await actions.set_enabled(rig.s, True)
    meta = {"drone_command": rules.velocity(forward=2.0)}
    await actions.on_result("sess-1", "custom:m1", meta)
    assert "drone_command" not in meta and meta["model_control"] is True
    # A stale follow left on the analyzer is stopped too.
    rig.an.follow = ("person", None, 0.5)
    await actions.on_result("sess-1", "custom:m1", {})
    assert rig.an.follow is None


async def following_rig(rig):
    await actions.set_enabled(rig.s, True)
    await actions.run_moving(rig.s, fire("follow"), actions._base(fire("follow"), rig.s))
    assert actions.following("sess-1")
    rig.tel.calls.clear()


@pytest.mark.parametrize("trigger,code,holds", [
    (lambda r: setattr(r.tel.snapshot, "link_ok", False), "link_lost", False),
    (lambda r: setattr(r.s, "zone_lock", True), "red_zone", False),
    (lambda r: setattr(r.tel, "pilot_has_control", True), "pilot_control", False),
    (lambda r: takeover.start(r.s.session_id, "staff-1", user_id="u", username="ops",
                              workspace_id=None), "taken_over", False),
    (lambda r: setattr(r.s, "mode", SimpleNamespace(value="object-detection")), "mode_changed", True),
])
async def test_model_control_switches_itself_off(rig, trigger, code, holds):
    await following_rig(rig)
    trigger(rig)
    actions.on_telemetry("sess-1")
    meta = {"drone_command": rules.velocity(forward=2.0)}
    await actions.on_result("sess-1", "custom:m1", meta)
    await settle()
    assert "drone_command" not in meta
    assert not actions.is_enabled("sess-1") and not actions.following("sess-1")
    assert rig.an.follow is None
    off = [m for m in rig.sio.of("model_control") if m.get("reason_code")][-1]
    assert off == {"enabled": False, "reason_code": code, "reason": actions.REASONS[code]}
    stopped = [e for e in rig.sio.of("rule_event") if e["status"] == "stopped"]
    assert len(stopped) == 1 and stopped[0]["reason_code"] == code
    # HOLD only when nobody else owns the drone at that moment.
    assert ("mode:HOLD" in rig.tel.calls) is holds


async def test_switch_off_hooks_and_the_pilots_own_off(rig):
    await following_rig(rig)
    assert await actions.switch_off("sess-1", "taken_over") is True
    assert await actions.switch_off("sess-1", "taken_over") is False       # already off
    assert rig.tel.calls == []
    await following_rig(rig)
    out = await actions.set_enabled(rig.s, False)
    assert out == {"enabled": False}
    assert rig.tel.calls == ["stop_offboard", "mode:HOLD"]
    assert last_event(rig)["reason_code"] == "model_control_off"


async def test_alert_and_mark(rig, monkeypatch):
    actions.handle_fire(rig.s, "custom:m1", fire("alert"))
    await settle()
    ev = last_event(rig)
    assert (ev["status"], ev["action"], ev["message"]) == ("done", "alert", "Person seen (82%)")
    assert ev["rule_id"] == "rule0001" and ev["model_id"] == "m1" and ev["model_name"] == "Cracks"
    # Mark with no telemetry for the frame: nowhere to put it.
    actions.handle_fire(rig.s, "custom:m1", fire("mark"), {"model_name": "Cracks"}, None)
    await settle()
    ev = last_event(rig)
    assert (ev["status"], ev["reason_code"]) == ("refused", "no_position")


async def test_mark_pins_a_sighting_that_survives_a_clear(rig, monkeypatch):
    from app.mapdetect import live, store
    saved = []

    async def upsert(rows):
        saved.extend(rows)
        return len(rows)
    monkeypatch.setattr(store, "upsert", upsert)
    monkeypatch.setattr(live, "_sessions", {})
    tel = {"position": {"latitude_deg": 17.6, "longitude_deg": 78.1, "relative_altitude_m": 30.0},
           "attitude": {"roll_deg": 0.0, "pitch_deg": 0.0, "yaw_deg": 0.0}, "heading_deg": 0.0,
           "gps": {"fix_type": 3, "num_satellites": 12, "hdop": 0.8}}
    capture = {"telemetry": tel, "width": 640, "height": 480, "wall_time": 1000.0}
    from app.mapdetect import geo
    monkeypatch.setattr(geo, "has_fix", lambda t: True)
    actions.handle_fire(rig.s, "custom:m1", fire("mark", box=(300, 300, 340, 400)),
                        {"model_name": "Cracks"}, capture)
    await settle()
    ev = last_event(rig)
    assert ev["status"] == "done" and ev["message"] == "Person seen (82%): marked on the map"
    m = live.get("sess-1")
    pins = [s for s in m.tracker.sightings.values() if s.pinned]
    assert len(pins) == 1 and pins[0].to_dict()["pinned"] is True and pins[0].rule == "person"
    assert not m.recording and saved and saved[0]["pinned"] is True    # saved, recording off
    await live.clear("sess-1")
    assert [s.id for s in m.tracker.sightings.values()] == [pins[0].id]
    assert store._decode_pin({"source": "custom:m1#pin", "label": "person"}) == {
        "source": "custom:m1", "label": "person", "pinned": True, "rule": "person"}


# ── the real handlers ────────────────────────────────────────────────────

async def test_handlers_are_guarded_and_answer(live):  # noqa: F811
    from test_live_scope import connect, errors, hold_link, world
    w = await world(live)
    await connect(live, "v", w.vic[1])
    await connect(live, "hp", w.hp[1])
    h = live.sio.handlers["/"]
    await h["set_model_control"]("v", {"enabled": True})
    assert errors(live, "v")[-1]["event"] == "set_model_control"      # viewers do not command
    await h["set_model_control"]("hp", {"enabled": True})
    assert live.rec.of("model_control", "hp")[-1]["reason_code"] == "no_link"
    hold_link(live, "hp")
    await h["set_model_control"]("hp", {"enabled": True})
    assert live.rec.of("model_control", "hp")[-1]["reason_code"] == "mode_changed"
    await h["rule_confirm"]("hp", {"token": "nope", "accept": True})
    assert live.rec.of("rule_event", "hp")[-1]["status"] == "expired"
    actions.reset_for_tests()


from test_live_scope import live  # noqa: E402,F401  (fixture)
