"""
HYRAK Copilot (app/copilot): the voice assistant's planning and safety.

  * the local parser: every example phrase of the contract and variants,
    numbers in words, yes / no / "number two";
  * the Claude planner against a fake Anthropic client: the request shape
    (model, adaptive thinking, effort low, strict tools, tool_choice auto,
    fallbacks), refusal and max_tokens handled before content, a tool
    choice validated like a local plan;
  * every skill's guard refusals (fly access, takeover, pilot, link, in
    air / on the ground, red-zone lock, destination zones, ceiling);
  * plan cards: confirm, decline, expiry after 15 s, choose, guards again
    on accept;
  * follow: Florence's grounded boxes matched to tracker track ids, the
    tracker's own follow_track / request_follow, Offboard, then tracking;
  * survey waypoints: count, inside the circle, altitude, spacing;
  * a running task stopping on takeover, pilot override, link loss, red
    zone lock, Copilot off, hold, a lost follow-me position;
  * the real socket handlers, classified and guarded.

No models load, no network, no drone: stand-ins throughout.
"""
import asyncio
import math
import time
from types import SimpleNamespace

import pytest

from app.copilot import planner, service, skills, survey
from app.copilot.planner import parse_local, parse_reply
from app.sessions import takeover


# ── the local parser ─────────────────────────────────────────────────────

@pytest.mark.parametrize("said,skill,args", [
    ("hold", "hold", {}),
    ("Hold.", "hold", {}),
    ("stop", "hold", {}),
    ("Stop!", "hold", {}),
    ("hover here", "hold", {}),
    ("land", "land", {}),
    ("Land now please", "land", {}),
    ("come back", "return_home", {}),
    ("Come back home", "return_home", {}),
    ("return home", "return_home", {}),
    ("Return to home.", "return_home", {}),
    ("go home", "return_home", {}),
    ("RTL", "return_home", {}),
    ("take off to 15 metres", "takeoff", {"altitude_m": 15.0}),
    ("Take off to fifteen meters", "takeoff", {"altitude_m": 15.0}),
    ("takeoff to 15m", "takeoff", {"altitude_m": 15.0}),
    ("take off", "takeoff", {}),
    ("Take off to one hundred and twenty metres", "takeoff", {"altitude_m": 120.0}),
    ("go up 10 metres", "change_altitude", {"delta_m": 10.0}),
    ("Go up ten metres.", "change_altitude", {"delta_m": 10.0}),
    ("climb 5 m", "change_altitude", {"delta_m": 5.0}),
    ("go up twenty five metres", "change_altitude", {"delta_m": 25.0}),
    ("go down 3 metres", "change_altitude", {"delta_m": -3.0}),
    ("descend 5 metres", "change_altitude", {"delta_m": -5.0}),
    ("climb to 40 m", "change_altitude", {"altitude_m": 40.0}),
    ("go to 30 metres", "change_altitude", {"altitude_m": 30.0}),
    ("move forward 20 metres", "move", {"forward_m": 20.0, "right_m": 0.0}),
    ("Move forward twenty metres.", "move", {"forward_m": 20.0, "right_m": 0.0}),
    ("go back 10 m", "move", {"forward_m": -10.0, "right_m": 0.0}),
    ("move left 5 metres", "move", {"forward_m": 0.0, "right_m": -5.0}),
    ("go right 12 metres", "move", {"forward_m": 0.0, "right_m": 12.0}),
    ("fly 30 metres forward", "move", {"forward_m": 30.0, "right_m": 0.0}),
    ("follow the man in the red shirt", "follow", {"target": "man in the red shirt"}),
    ("Follow the man in the red shirt.", "follow", {"target": "man in the red shirt"}),
    ("follow the white car", "follow", {"target": "white car"}),
    ("follow the one in blue", "follow", {"target": "one in blue"}),
    ("Follow the man in the red shirt and take off to fifteen metres.", "follow",
     {"target": "man in the red shirt"}),
    ("follow the man and his dog", "follow", {"target": "man and his dog"}),
    ("follow me", "follow", {"target": "me"}),
    ("Follow me please", "follow", {"target": "me"}),
    ("track the red car", "track", {"target": "red car"}),
    ("Track the red car.", "track", {"target": "red car"}),
    ("count the people", "count", {"what": "people"}),
    ("how many cars", "count", {"what": "cars"}),
    ("How many cars?", "count", {"what": "cars"}),
    ("how many people are there", "count", {"what": "people"}),
    ("what do you see?", "describe", {"question": "what do you see?"}),
    ("What do you see", "describe", {"question": "What do you see"}),
    ("is anyone lying on the ground?", "describe", {"question": "is anyone lying on the ground?"}),
    ("describe the scene", "describe", {"question": "describe the scene"}),
    ("survey a 50 metre radius at 30 metres", "survey", {"radius_m": 50.0, "altitude_m": 30.0}),
    ("Survey a 50 meter radius at 30 meters.", "survey", {"radius_m": 50.0, "altitude_m": 30.0}),
    ("survey a radius of 100 metres at 40 metres", "survey", {"radius_m": 100.0, "altitude_m": 40.0}),
    ("survey a fifty metre radius", "survey", {"radius_m": 50.0}),
    ("orbit here at 20 metres radius", "orbit", {"center": "drone", "radius_m": 20.0}),
    ("Orbit here at twenty metres radius.", "orbit", {"center": "drone", "radius_m": 20.0}),
    ("orbit the target at a radius of 30 metres", "orbit", {"center": "target", "radius_m": 30.0}),
    ("battery?", "status", {}),
    ("Battery", "status", {}),
    ("status", "status", {}),
    ("how much battery is left", "status", {}),
    ("stop following", "stop_task", {}),
    ("stop tracking", "stop_task", {}),
])
def test_local_parser_covers_the_contract_phrases(said, skill, args):
    p = parse_local(said)
    assert p is not None, said
    assert (p.skill, p.args) == (skill, args), said
    assert p.source == "local"


@pytest.mark.parametrize("said", ["", "hello there", "sing me a song", "landing gear status report"])
def test_local_parser_leaves_what_it_does_not_know(said):
    p = parse_local(said)
    assert p is None or p.skill == "status"     # "...status report" may read as status


@pytest.mark.parametrize("said,reply", [
    ("yes", ("confirm", True)), ("Yes, do it.", ("confirm", True)), ("confirm", ("confirm", True)),
    ("do it", ("confirm", True)), ("go ahead", ("confirm", True)),
    ("no", ("confirm", False)), ("cancel", ("confirm", False)), ("abort", ("confirm", False)),
    ("number two", ("choose", 2)), ("Number 3.", ("choose", 3)), ("2", ("choose", 2)),
    ("option one", ("choose", 1)), ("the second one", ("choose", 2)), ("the first", ("choose", 1)),
    ("land", None), ("follow the white car", None),
])
def test_replies_to_a_card(said, reply):
    assert parse_reply(said) == reply


# ── argument checks ──────────────────────────────────────────────────────

@pytest.mark.parametrize("skill,args", [
    ("takeoff", {"altitude_m": 1}), ("takeoff", {"altitude_m": 150}),
    ("change_altitude", {}), ("change_altitude", {"delta_m": 5, "altitude_m": 20}),
    ("change_altitude", {"delta_m": 0}),
    ("move", {"forward_m": 250}), ("move", {"forward_m": 0, "right_m": 0}),
    ("follow", {"target": ""}), ("track", {"target": "me"}),
    ("survey", {"radius_m": 5}), ("survey", {"radius_m": 600}), ("survey", {}),
    ("survey", {"radius_m": 50, "center_lat": 17.6}),
    ("orbit", {"radius_m": 2}), ("orbit", {"radius_m": 20, "speed_m_s": 8}),
    ("orbit", {"radius_m": 20, "center": "moon"}),
    ("takeoff", {"altitude_m": "high"}), ("takeoff", {"altitude_m": True}),
    ("fly_to_mars", {}),
])
def test_out_of_range_arguments_are_refused_not_clamped(skill, args):
    with pytest.raises(skills.ArgError):
        skills.validate(skill, args)


def test_defaults_fill_in():
    assert skills.validate("takeoff", {}) == {"altitude_m": 10.0}
    assert skills.validate("survey", {"radius_m": 50})["altitude_m"] == 30.0
    assert skills.validate("orbit", {"radius_m": 20}) == {"radius_m": 20.0, "speed_m_s": 2.0,
                                                          "center": "drone"}
    assert skills.validate("follow", {"target": "Me"}) == {"target": "me"}


def test_tool_schemas_are_strict_and_cover_the_catalogue():
    tools = skills.tool_schemas()
    assert [t["name"] for t in tools] == list(skills.SKILLS)
    for t in tools:
        assert t["strict"] is True
        s = t["input_schema"]
        assert s["type"] == "object" and s["additionalProperties"] is False
        assert set(s["required"]) == set(s["properties"])
        for v in s["properties"].values():          # strict mode: no numeric constraints
            assert "minimum" not in v and "maximum" not in v


# ── the Claude planner, with a fake client ───────────────────────────────

class FakeMessages:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def create(self, **kw):
        self.calls.append(kw)
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def fake_client(*responses):
    m = FakeMessages(responses)
    return SimpleNamespace(beta=SimpleNamespace(messages=m)), m


def resp(stop="tool_use", *blocks):
    return SimpleNamespace(stop_reason=stop, content=list(blocks))


def tool(name, **inp):
    return SimpleNamespace(type="tool_use", id="toolu_1", name=name, input=inp)


def text(t):
    return SimpleNamespace(type="text", text=t)


async def test_claude_request_shape_and_a_tool_choice():
    client, m = fake_client(resp("tool_use", tool("follow", target="man in the red shirt")))
    p = await planner.ClaudePlanner(client).plan("go after that guy in red", "Flight mode HOLD.",
                                                 [{"pilot": "hi", "copilot": "Hello."}])
    assert (p.skill, p.args, p.source) == ("follow", {"target": "man in the red shirt"}, "claude")
    kw = m.calls[0]
    assert kw["model"] == "claude-opus-5-5"
    assert kw["thinking"] == {"type": "adaptive"}
    assert kw["output_config"] == {"effort": "low"}
    assert kw["tool_choice"] == {"type": "auto", "disable_parallel_tool_use": True}
    assert kw["betas"] == ["server-side-fallback-2026-07-01"] and kw["fallbacks"] == "default"
    assert all(t["strict"] for t in kw["tools"])
    assert kw["messages"][0] == {"role": "user", "content": "Pilot: hi"}
    assert kw["messages"][-1]["content"].endswith("Pilot: go after that guy in red")
    assert "Flight mode HOLD." in kw["messages"][-1]["content"]


async def test_claude_history_keeps_the_last_ten_exchanges():
    client, m = fake_client(resp("end_turn", text("Sure.")))
    hist = [{"pilot": f"p{i}", "copilot": f"c{i}"} for i in range(15)]
    await planner.ClaudePlanner(client).plan("x", "", hist)
    msgs = m.calls[0]["messages"]
    assert len(msgs) == 21 and msgs[0]["content"] == "Pilot: p5"


async def test_claude_refusal_and_max_tokens_are_never_read_as_plans():
    client, _ = fake_client(resp("refusal", tool("land")),
                            resp("max_tokens", tool("land")))
    c = planner.ClaudePlanner(client)
    p = await c.plan("x", "", [])
    assert p.skill is None and p.status == "refused"
    p = await c.plan("x", "", [])
    assert p.skill is None and p.status == "error"


async def test_claude_text_only_unknown_tool_and_null_arguments():
    client, _ = fake_client(resp("end_turn", text("How far forward?")),
                            resp("tool_use", tool("self_destruct")),
                            resp("tool_use", tool("change_altitude", delta_m=None, altitude_m=40)))
    c = planner.ClaudePlanner(client)
    p = await c.plan("move", "", [])
    assert p.skill is None and p.reply == "How far forward?" and p.status == "done"
    p = await c.plan("x", "", [])
    assert p.skill is None and p.status == "error"
    p = await c.plan("x", "", [])
    assert p.skill == "change_altitude" and p.args == {"altitude_m": 40}
    assert skills.validate(p.skill, p.args) == {"altitude_m": 40.0}


async def test_fallbacks_dropped_once_when_the_api_rejects_them():
    import anthropic
    import httpx2
    req = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    bad = anthropic.BadRequestError("fallbacks: unknown parameter",
                                    response=httpx2.Response(400, request=req), body=None)
    client, m = fake_client(bad, resp("tool_use", tool("hold")))
    c = planner.ClaudePlanner(client)
    p = await c.plan("stop it", "", [])
    assert p.skill == "hold"
    assert "fallbacks" not in m.calls[1] and c._fallbacks is False


async def test_scene_question_sends_the_frame_as_jpeg():
    client, m = fake_client(resp("end_turn", text("Two people, nobody lying down.")))
    p = await planner.ClaudePlanner(client).answer_scene("is anyone lying down?", b"\xff\xd8jpeg",
                                                         "Video: live.")
    assert p.reply.startswith("Two people") and p.skill is None
    content = m.calls[0]["messages"][0]["content"]
    assert content[0]["type"] == "image" and content[0]["source"]["media_type"] == "image/jpeg"
    assert "tools" not in m.calls[0]


# ── a session rig ────────────────────────────────────────────────────────

class Tel:
    def __init__(self):
        self.is_connected = True
        self.pilot_has_control = False
        self.automation_locked = False
        self._offboard_active = False
        self.last_action_error = None
        self.calls = []
        self.ok = True
        self.snapshot = SimpleNamespace(
            link_ok=True, heading_deg=90.0, mission_finished=False,
            flight_mode=SimpleNamespace(mode="HOLD", is_in_air=True, is_armed=True),
            position=SimpleNamespace(latitude_deg=17.6, longitude_deg=78.1,
                                     relative_altitude_m=20.0, absolute_altitude_m=520.0),
            battery=SimpleNamespace(remaining_percent=76.0, voltage_v=15.2),
            gps=SimpleNamespace(seen=True, satellites_visible=14, fix_type=3),
            home_alt=500.0)

    async def get_param(self, *a):
        return None

    async def start_offboard(self):
        self.calls.append("start_offboard")
        self._offboard_active = self.ok
        return self.ok

    async def stop_offboard(self):
        self.calls.append("stop_offboard")
        self._offboard_active = False
        return True

    async def set_flight_mode(self, mode):
        self.calls.append(f"mode:{mode}")
        return self.ok

    async def goto_altitude(self, alt):
        self.calls.append(("goto_altitude", alt))
        return self.ok

    async def goto_custom_rtl(self, lat, lng, alt):
        self.calls.append(("goto", round(lat, 6), round(lng, 6), alt))
        return self.ok

    async def arm(self):
        self.calls.append("arm")
        self.snapshot.flight_mode.is_armed = True
        return self.ok

    async def takeoff(self, alt=None):
        self.calls.append(("takeoff", alt))
        return self.ok

    async def start_mission(self):
        self.calls.append("start_mission")
        return self.ok

    async def upload_mission(self, wps, terrain_follow=False):
        self.calls.append(("upload", len(wps)))
        return self.ok, None

    async def do_orbit(self, r, v, lat, lng, alt):
        self.calls.append(("orbit", r, v))
        return self.ok


class Tracker:
    """A built-in tracker's follow surface."""
    def __init__(self, kind="person"):
        self.kind = kind
        self.locked = None
        self.tracking = False

    def follow_track(self, cid, tid):
        self.locked = tid

    def request_follow(self, cid, tid):
        self.locked = tid

    def set_tracking(self, cid, active):
        self.tracking = active


class Sio:
    def __init__(self):
        self.emitted = []

    async def emit(self, event, data=None, to=None, **kw):
        self.emitted.append((event, data, to))

    def of(self, event):
        return [d for e, d, _ in self.emitted if e == event]


async def _no_warm(*a, **k):
    return None


def _empty_slots():
    from app.copilot import stt, vision
    stt.slot._obj = None
    vision.slot._obj = None


@pytest.fixture
def rig(monkeypatch):
    from app.zones import engine
    monkeypatch.setattr(service, "_warm", _no_warm)       # never load a real model here
    sio, tel, tr = Sio(), Tel(), Tracker()
    s = SimpleNamespace(session_id="sess-1", socket_id="sock-1", zone_lock=False, drone=None,
                        drone_fly=True, role="operator", is_staff=True, workspace_id=None,
                        perms=frozenset(), last_mission=None,
                        mode=SimpleNamespace(value="person-tracking"))
    sm = SimpleNamespace(get=lambda sid: s if sid == s.session_id else None,
                         get_telemetry=lambda sid: r.tel if sid == s.session_id else None,
                         set_mode=lambda sid, m: setattr(s, "mode", m),
                         all_sessions=lambda: [s])
    pool = SimpleNamespace(get_for_session=lambda sid: r.tracker)
    r = SimpleNamespace(sio=sio, tel=tel, tracker=tr, s=s, sm=sm)
    service.reset_for_tests()
    service.configure(sio, sm, pool)
    service.set_planner_client(None)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    takeover.reset_for_tests()
    engine.set_zones([])
    yield r
    _empty_slots()
    service.reset_for_tests()
    service.configure(None, None, None)
    service.set_planner_client(None)
    takeover.reset_for_tests()
    engine.set_zones([])


def msgs(rig):
    return [m for m in rig.sio.of("copilot_message") if m["role"] != "pilot"]


def last(rig):
    return msgs(rig)[-1]


def card(rig):
    return next(m["card"] for m in reversed(rig.sio.of("copilot_message")) if m.get("card"))


async def on(rig):
    service.state("sess-1") or None
    st = service._states.setdefault("sess-1", service.State())
    st.enabled = True


def square(lat, lng, half_m=200.0):
    d = half_m / 111_320.0
    e = half_m / (111_320.0 * math.cos(math.radians(lat)))
    return {"type": "Polygon", "coordinates": [[[lng - e, lat - d], [lng + e, lat - d],
                                                [lng + e, lat + d], [lng - e, lat + d],
                                                [lng - e, lat - d]]]}


# ── guards ───────────────────────────────────────────────────────────────

MOTION = ["land", "return_home", "change_altitude", "move", "survey", "orbit", "follow"]
EXAMPLE = {"land": {}, "return_home": {}, "change_altitude": {"delta_m": 5.0},
           "move": {"forward_m": 20.0, "right_m": 0.0}, "survey": {"radius_m": 50.0, "altitude_m": 30.0},
           "orbit": {"radius_m": 20.0}, "follow": {"target": "me"}, "takeoff": {"altitude_m": 15.0},
           "hold": {}}


@pytest.mark.parametrize("skill", MOTION + ["takeoff", "hold"])
@pytest.mark.parametrize("setup,code", [
    ("no_fly", "no_fly_permission"),
    ("drone_read_only", "no_fly_permission"),
    ("taken_over", "taken_over"),
    ("pilot", "pilot_control"),
    ("no_link", "no_link"),
    ("zone_lock", "red_zone"),
])
async def test_every_motion_skill_refuses_on_each_guard(rig, skill, setup, code):
    await on(rig)
    if skill == "takeoff":
        rig.tel.snapshot.flight_mode.is_in_air = False
    if setup == "no_fly":
        rig.s.role = "viewer"
    elif setup == "drone_read_only":
        rig.s.drone_fly = False
    elif setup == "taken_over":
        takeover.start("sess-1", "staff-1", user_id="u", username="staff", workspace_id=None)
    elif setup == "pilot":
        rig.tel.pilot_has_control = True
    elif setup == "no_link":
        rig.tel.is_connected = False
    elif setup == "zone_lock":
        rig.s.zone_lock = True
    assert await skills.guard(rig.s, rig.tel, skill) == code
    await service.run_plan(rig.s, planner.Plan(skill=skill, args=EXAMPLE[skill]))
    m = last(rig)
    assert m["status"] == "refused" and skills.REASONS[code] in m["text"]
    assert not any(isinstance(c, tuple) or str(c).startswith("mode:") or c == "start_offboard"
                   for c in rig.tel.calls)


@pytest.mark.parametrize("skill", MOTION)
async def test_motion_skills_need_the_drone_in_the_air(rig, skill):
    await on(rig)
    rig.tel.snapshot.flight_mode.is_in_air = False
    assert await skills.guard(rig.s, rig.tel, skill) == "not_flying"


async def test_takeoff_needs_the_ground_and_non_motion_skills_need_nothing(rig):
    assert await skills.guard(rig.s, rig.tel, "takeoff") == "already_flying"
    rig.tel.is_connected = False
    for s in ("track", "count", "describe", "status"):
        assert await skills.guard(rig.s, rig.tel, s) is None


async def test_a_customer_without_fly_access_is_refused(rig):
    rig.s.is_staff, rig.s.workspace_id, rig.s.perms = False, "ws-1", frozenset({"view"})
    assert skills.control_reason(rig.s, rig.tel) == "no_fly_permission"
    rig.s.perms = frozenset({"view", "fly"})
    assert skills.control_reason(rig.s, rig.tel) is None


async def test_move_into_a_red_zone_is_refused_and_a_permit_lets_it_through(rig, monkeypatch):
    from app.zones import engine, monitor
    await on(rig)
    # Heading east (90 deg): 100 m forward lands inside a red square east of the drone.
    east = survey.offset(17.6, 78.1, 100.0, 0.0)
    engine.set_zones([{"id": "r1", "name": "Hostel", "zone_class": "red",
                       "geometry": square(east[0], east[1], 30.0)}])
    permitted = set()

    async def permits(session, lat, lng, **kw):
        return permitted
    monkeypatch.setattr(monitor, "permitted_zone_ids", permits)
    rig.s.drone = {"id": "d1"}
    await service.run_plan(rig.s, planner.Plan(skill="move", args={"forward_m": 100.0}))
    assert last(rig)["status"] == "refused" and "red" in last(rig)["text"]
    # The path crosses it too: 200 m forward ends beyond, still refused.
    await service.run_plan(rig.s, planner.Plan(skill="move", args={"forward_m": 200.0}))
    assert last(rig)["status"] == "refused"
    permitted.add("r1")
    await service.run_plan(rig.s, planner.Plan(skill="move", args={"forward_m": 100.0}))
    assert last(rig)["card"]["skill"] == "move"


async def test_orange_without_a_permit_and_a_failed_permit_read_count_as_none(rig, monkeypatch):
    from app.zones import engine, monitor
    await on(rig)
    north = survey.offset(17.6, 78.1, 0.0, 0.0)
    engine.set_zones([{"id": "o1", "name": "Campus", "zone_class": "orange",
                       "geometry": square(north[0], north[1], 400.0)}])

    async def broken(session, lat, lng, **kw):
        raise RuntimeError("db down")
    monkeypatch.setattr(monitor, "permitted_zone_ids", broken)
    rig.s.drone = {"id": "d1"}
    await service.run_plan(rig.s, planner.Plan(skill="change_altitude", args={"delta_m": 5.0}))
    assert last(rig)["status"] == "refused" and "orange" in last(rig)["text"]


async def test_climb_into_restricted_airspace_is_refused(rig):
    from app.zones import engine
    await on(rig)
    engine.set_zones([{"id": "c1", "name": "Airway", "zone_class": "red", "floor_m": 60.0,
                       "geometry": square(17.6, 78.1, 500.0)}])
    await service.run_plan(rig.s, planner.Plan(skill="change_altitude", args={"altitude_m": 80.0}))
    assert last(rig)["status"] == "refused" and "no-fly" in last(rig)["text"]
    # A layer that needs no permit is still a ceiling nothing automatic climbs through.
    engine.set_zones([{"id": "c2", "name": "Approach", "zone_class": "orange", "floor_m": 60.0,
                       "permission_required": False, "geometry": square(17.6, 78.1, 500.0)}])
    await service.run_plan(rig.s, planner.Plan(skill="change_altitude", args={"altitude_m": 80.0}))
    assert last(rig)["status"] == "refused" and "restricted airspace" in last(rig)["text"]
    await service.run_plan(rig.s, planner.Plan(skill="change_altitude", args={"altitude_m": 40.0}))
    assert last(rig)["card"]["title"] == "Climb to 40 m"


async def test_takeoff_goes_through_the_drone_action_checks(rig, monkeypatch):
    from app.events import telemetry_events
    await on(rig)
    rig.tel.snapshot.flight_mode.is_in_air = False
    rig.tel.snapshot.flight_mode.is_armed = False
    seen = []
    real = telemetry_events.run_guarded_action

    async def spy(sio, session, tel, action, data, sid):
        seen.append(action)
        return await real(sio, session, tel, action, data, sid)
    monkeypatch.setattr(telemetry_events, "run_guarded_action", spy)
    await service.run_plan(rig.s, planner.Plan(skill="takeoff", args={"altitude_m": 15}))
    c = card(rig)
    assert c["title"] == "Arm and take off to 15 m" and c["moves"] is True
    await service.confirm(rig.s, c["token"], True)
    assert seen == ["arm", "takeoff"]
    assert ("takeoff", 15.0) in rig.tel.calls
    assert rig.sio.of("copilot_card_update")[-1]["status"] == "done"


async def test_takeoff_inside_a_red_zone_is_blocked_by_the_shared_check(rig, monkeypatch):
    from app.copilot import skills as sk
    from app.zones import engine
    await on(rig)
    rig.tel.snapshot.flight_mode.is_in_air = False
    engine.set_zones([{"id": "r1", "name": "Hostel", "zone_class": "red",
                       "geometry": square(17.6, 78.1, 50.0)}])

    async def no_dest(*a, **k):        # past Copilot's own check: the drone_action one must hold
        return None
    monkeypatch.setattr(sk, "dest_reason", no_dest)
    ok = await service.execute(rig.s, "takeoff", {"altitude_m": 15.0})
    assert ok is False and "NO-FLY" in last(rig)["text"]
    assert not any(isinstance(c, tuple) and c[0] == "takeoff" for c in rig.tel.calls)


# ── cards ────────────────────────────────────────────────────────────────

async def test_confirm_runs_the_plan_and_decline_does_nothing(rig):
    await on(rig)
    await service.run_plan(rig.s, planner.Plan(skill="change_altitude", args={"delta_m": 10.0}))
    c = card(rig)
    assert c["kind"] == "confirm" and c["moves"] is True and c["skill"] == "change_altitude"
    assert c["expires_at"] == pytest.approx(time.time() + 15.0, abs=1.0)
    await service.confirm(rig.s, c["token"], True)
    assert ("goto_altitude", 30.0) in rig.tel.calls
    ups = rig.sio.of("copilot_card_update")
    assert [u["status"] for u in ups] == ["accepted", "done"]
    # Once only.
    await service.confirm(rig.s, c["token"], True)
    assert rig.tel.calls.count(("goto_altitude", 30.0)) == 1
    await service.run_plan(rig.s, planner.Plan(skill="land"))
    c2 = card(rig)
    await service.confirm(rig.s, c2["token"], False)
    assert rig.sio.of("copilot_card_update")[-1]["status"] == "declined"
    assert "mode:LAND" not in rig.tel.calls


async def test_cards_expire_after_fifteen_seconds(rig):
    await on(rig)
    await service.run_plan(rig.s, planner.Plan(skill="land"))
    c = card(rig)
    await service.tick_once("sess-1", now=c["expires_at"] + 0.1)
    assert rig.sio.of("copilot_card_update")[-1] == {"token": c["token"], "status": "expired",
                                                     "message": "Nobody answered in time; nothing was done."}
    await service.confirm(rig.s, c["token"], True)
    assert "mode:LAND" not in rig.tel.calls and last(rig)["status"] == "refused"


async def test_spoken_yes_accepts_the_open_card_and_guards_run_again(rig):
    await on(rig)
    await service.handle_text(rig.s, "land")
    c = card(rig)
    rig.tel.pilot_has_control = True               # the pilot grabbed the sticks meanwhile
    await service.handle_text(rig.s, "yes")
    assert "mode:LAND" not in rig.tel.calls
    assert rig.sio.of("copilot_card_update")[-1]["status"] == "refused"
    rig.tel.pilot_has_control = False
    await service.handle_text(rig.s, "land")
    await service.handle_text(rig.s, "do it")
    assert "mode:LAND" in rig.tel.calls


async def test_hold_is_immediate_and_expires_an_open_card(rig):
    await on(rig)
    await service.handle_text(rig.s, "return home")
    c = card(rig)
    await service.handle_text(rig.s, "hold")
    assert "mode:HOLD" in rig.tel.calls
    assert any(u["token"] == c["token"] and u["status"] == "expired"
               for u in rig.sio.of("copilot_card_update"))
    assert last(rig)["text"] == "Holding."


async def test_safety_words_never_wait_for_the_planner(rig):
    await on(rig)
    gate = asyncio.Event()

    class Slow:
        async def create(self, **kw):
            await gate.wait()
            return resp("end_turn", text("ok"))
    service.set_planner_client(SimpleNamespace(beta=SimpleNamespace(messages=Slow())))
    slow = asyncio.create_task(service.handle_text(rig.s, "do a barrel roll"))
    await asyncio.sleep(0.05)
    await asyncio.wait_for(service.handle_text(rig.s, "stop"), 1.0)
    assert "mode:HOLD" in rig.tel.calls
    gate.set()
    await slow


async def test_planner_used_when_a_key_is_set_and_local_fallback_on_failure(rig):
    await on(rig)
    client, m = fake_client(resp("tool_use", tool("change_altitude", delta_m=5.0, altitude_m=None)),
                            RuntimeError("network"))
    service.set_planner_client(client)
    assert service.state_payload("sess-1")["ready"]["planner"] == "claude"
    await service.handle_text(rig.s, "get a bit higher, like five metres")
    assert card(rig)["skill"] == "change_altitude"
    await service.handle_text(rig.s, "go up 10 metres")       # Claude fails: the local parse
    assert card(rig)["args"] == {"delta_m": 10.0}
    assert len(m.calls) == 2


async def test_refusal_from_claude_is_said_and_nothing_runs(rig):
    await on(rig)
    client, _ = fake_client(resp("refusal"))
    service.set_planner_client(client)
    await service.handle_text(rig.s, "something odd")
    assert last(rig)["status"] == "refused" and rig.tel.calls == []


async def test_copilot_off_refuses_utterances(rig):
    await service.handle_text(rig.s, "land")
    assert last(rig)["role"] == "system" and last(rig)["status"] == "refused"


# ── follow: grounded boxes to tracker tracks ─────────────────────────────

def test_grounded_boxes_match_tracks_by_iou_or_centre():
    tracks = [{"id": 7, "box": [100, 100, 200, 300], "kind": "person", "label": "person"},
              {"id": 9, "box": [400, 100, 500, 300], "kind": "person", "label": "person"},
              {"id": 3, "box": [600, 300, 800, 400], "kind": "vehicle", "label": "white car"}]
    grounded = [{"label": "man", "box": [405, 110, 495, 290], "score": 1.0},
                {"label": "man", "box": [90, 95, 210, 310], "score": 1.0},
                {"label": "man", "box": [1000, 0, 1100, 50], "score": 1.0}]
    c = service.match_candidates(grounded, tracks, "person", 1280, 720)
    assert [x["track_id"] for x in c] == [7, 9]              # numbered left to right
    assert [x["index"] for x in c] == [1, 2]
    assert c[0]["frame_w"] == 1280 and c[0]["box"] == [100.0, 100.0, 200.0, 300.0]
    # A loose box around a small track still matches through the centres.
    loose = [{"label": "car", "box": [560, 250, 860, 470], "score": 1.0}]
    c = service.match_candidates(loose, tracks, "vehicle")
    assert [x["track_id"] for x in c] == [3]
    assert service.match_candidates(loose, tracks, "person") == []
    # Florence boxed the described part (a tie): it goes to the smallest track around it.
    big = [{"id": 1, "box": [100, 200, 1150, 716], "kind": "person", "label": "person"},
           {"id": 2, "box": [400, 300, 560, 716], "kind": "person", "label": "person"}]
    c = service.match_candidates([{"label": "tie", "box": [434, 438, 528, 600]}], big, "person")
    assert [x["track_id"] for x in c] == [2]
    # Two grounded boxes on one track give one candidate.
    c = service.match_candidates(grounded[:2] + [{"label": "m", "box": [101, 101, 199, 299]}],
                                 tracks, "person")
    assert len(c) == 2


def test_subject_and_tracker_mode():
    assert service.subject_of("white car") == "vehicle"
    assert service.subject_of("man in the red shirt") == "person"
    assert service.subject_of("red thing") is None
    assert service.mode_for("person", "manual-control") == "person-tracking"
    assert service.mode_for("person", "traffic-management") == "traffic-management"
    assert service.mode_for("vehicle", "person-tracking") == "traffic-management"
    assert service.mode_for(None, "person-tracking") == "traffic-management"


def test_tracks_from_each_tracker():
    person = {"persons": [{"id": 4, "box": [1, 2, 3, 4], "conf": 0.9}]}
    traffic = {"people": [{"id": 5, "box": [1, 2, 3, 4]}],
               "vehicles": [{"track_id": 6, "box": [5, 6, 7, 8], "type": "car", "color": "white"},
                            {"track_id": 8, "box": [5, 6, 7, 8], "type": "truck", "color": "unknown"}]}
    assert service.tracks_from_meta("person-tracking", person) == [
        {"id": 4, "box": [1, 2, 3, 4], "kind": "person", "label": "person"}]
    t = service.tracks_from_meta("traffic-management", traffic)
    assert [(x["id"], x["kind"], x["label"]) for x in t] == [
        (5, "person", "person"), (6, "vehicle", "white car"), (8, "vehicle", "truck")]


def feed(rig, persons, mode="person-tracking", **extra):
    meta = {"persons": persons, "person_count": len(persons), **extra}
    service.on_result("sess-1", mode, meta, {"width": 1280, "height": 720}, None)
    return meta


async def follow_setup(rig, monkeypatch, boxes):
    import numpy as np
    from app.copilot import vision
    await on(rig)
    st = service.state("sess-1")
    st.frame, st.frame_t = np.zeros((720, 1280, 3), dtype=np.uint8), time.monotonic()
    feed(rig, [{"id": 7, "box": [100, 100, 200, 300]}, {"id": 9, "box": [400, 100, 500, 300]}])
    vision.slot.set_for_tests(object())
    monkeypatch.setattr(vision, "ground", lambda frame, phrase: boxes)


async def test_follow_one_match_confirm_locks_the_track_then_offboard_then_tracking(rig, monkeypatch):
    await follow_setup(rig, monkeypatch, [{"label": "man", "box": [402, 98, 498, 305], "score": 1.0}])
    await service.handle_text(rig.s, "follow the man in the red shirt")
    c = card(rig)
    assert c["kind"] == "confirm" and c["skill"] == "follow" and c["moves"] is True
    assert c["candidates"][0]["box"] == [400.0, 100.0, 500.0, 300.0]
    await service.handle_text(rig.s, "yes")
    assert rig.tracker.locked == 9 and rig.tracker.tracking is True
    assert rig.tel.calls == ["start_offboard"]
    task = service.state_payload("sess-1")["task"]
    assert task["kind"] == "follow" and task["label"] == "man in the red shirt"
    meta = feed(rig, [{"id": 9, "box": [410, 100, 510, 300]}], target_id=9, tracking=True)
    assert meta["copilot_target"]["box"] == [410, 100, 510, 300]
    assert meta["copilot_target"]["label"] == "man in the red shirt"


async def test_follow_several_matches_choose_then_confirm(rig, monkeypatch):
    await follow_setup(rig, monkeypatch, [{"label": "man", "box": [402, 98, 498, 305]},
                                          {"label": "man", "box": [98, 102, 203, 296]}])
    await service.handle_text(rig.s, "follow the man")
    c = card(rig)
    assert c["kind"] == "choose" and [x["index"] for x in c["candidates"]] == [1, 2]
    assert rig.tel.calls == []
    await service.handle_text(rig.s, "number two")
    c2 = card(rig)
    assert c2["kind"] == "confirm" and c2["candidates"][0]["box"][0] == 400.0
    await service.confirm(rig.s, c2["token"], True)
    assert rig.tracker.locked == 9 and rig.tracker.tracking


async def test_choose_with_a_bad_index_or_token_does_nothing(rig, monkeypatch):
    await follow_setup(rig, monkeypatch, [{"label": "man", "box": [402, 98, 498, 305]},
                                          {"label": "man", "box": [98, 102, 203, 296]}])
    await service.handle_text(rig.s, "follow the man")
    c = card(rig)
    await service.choose(rig.s, c["token"], 5)
    assert last(rig)["status"] == "refused"
    await service.choose(rig.s, "wrong", 1)
    assert last(rig)["status"] == "refused"
    assert rig.tracker.locked is None


async def test_follow_with_nothing_matched_says_so(rig, monkeypatch):
    await follow_setup(rig, monkeypatch, [])
    await service.handle_text(rig.s, "follow the woman in green")
    assert last(rig)["status"] == "refused" and "can't see" in last(rig)["text"]


async def test_follow_refused_when_offboard_is(rig, monkeypatch):
    await follow_setup(rig, monkeypatch, [{"label": "man", "box": [402, 98, 498, 305]}])
    await service.handle_text(rig.s, "follow the man")
    rig.tel.ok = False
    await service.handle_text(rig.s, "yes")
    assert rig.tracker.tracking is False and rig.tracker.locked is None
    assert service.state_payload("sess-1")["task"] is None


async def test_track_highlights_without_moving(rig, monkeypatch):
    await follow_setup(rig, monkeypatch, [{"label": "man", "box": [402, 98, 498, 305]}])
    await service.handle_text(rig.s, "track the man in red")
    assert rig.tel.calls == [] and rig.tracker.tracking is False and rig.tracker.locked is None
    assert service.state_payload("sess-1")["task"]["kind"] == "track"
    meta = feed(rig, [{"id": 9, "box": [400, 100, 500, 300]}])
    assert meta["copilot_target"]["box"] == [400, 100, 500, 300]
    meta = {"persons": []}
    service.on_result("sess-1", "person-tracking", meta, None, None)
    assert "copilot_target" in meta                     # last box, marked lost after a second


async def test_follow_switches_the_tracker_on_when_another_mode_runs(rig, monkeypatch):
    from app.events import telemetry_events
    import numpy as np
    from app.copilot import vision
    await on(rig)
    rig.s.mode = SimpleNamespace(value="manual-control")
    st = service.state("sess-1")
    st.frame, st.frame_t = np.zeros((720, 1280, 3), dtype=np.uint8), time.monotonic()
    switched = []

    async def switch(sio, sm, pool, session, old, new, sid):
        switched.append(new.value)
        feed(rig, [{"id": 3, "box": [10, 10, 60, 120]}])
        return True
    monkeypatch.setattr(telemetry_events, "apply_mode_switch", switch)
    vision.slot.set_for_tests(object())
    monkeypatch.setattr(vision, "ground", lambda f, p: [{"label": "man", "box": [12, 8, 62, 118]}])
    await service.handle_text(rig.s, "follow the man")
    assert switched == ["person-tracking"] and rig.s.mode.value == "person-tracking"
    assert card(rig)["candidates"][0]["box"] == [10.0, 10.0, 60.0, 120.0]
    assert {"mode": "person-tracking"} in rig.sio.of("mode_changed")


# ── survey ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("radius,alt", [(50, 30), (100, 40), (10, 5), (500, 120), (200, 20)])
def test_survey_waypoints(radius, alt):
    p = survey.plan(17.6, 78.1, radius, alt)
    spacing = 2 * alt * math.tan(math.radians(70) / 2) * 0.7
    assert p["spacing_m"] == pytest.approx(spacing, abs=0.1)
    n = math.ceil(2 * radius / spacing)
    assert p["lines"] == n
    wps = p["waypoints"]
    assert len(wps) in (2 * n, 2 * n - 1, 2 * n - 2)
    for w in wps:
        assert w["altitude"] == alt and w["type"] == "waypoint"
        assert survey.distance_m(17.6, 78.1, w["lat"], w["lng"]) <= radius + 0.5
    # Lines are `spacing` apart north-south, and alternate direction.
    norths = sorted({round((w["lat"] - 17.6) * survey.M_PER_DEG_LAT, 1) for w in wps})
    gaps = [b - a for a, b in zip(norths, norths[1:])]
    assert all(g == pytest.approx(spacing, abs=0.3) for g in gaps)
    if len(wps) >= 4:
        assert (wps[1]["lng"] - wps[0]["lng"]) * (wps[3]["lng"] - wps[2]["lng"]) < 0
    assert p["preview"]["area"]["radius_m"] == radius
    assert len(p["preview"]["waypoints"]) == len(wps)


def test_survey_at_30_metres_spaces_lines_about_29_metres():
    assert survey.line_spacing_m(30) == pytest.approx(29.4, abs=0.1)


async def test_survey_card_previews_then_uploads_through_the_gate_and_starts(rig, monkeypatch):
    from app.permits import service as permits
    await on(rig)
    gates = []
    real = permits.gate_upload

    async def gate(drone, wps, *, ack_orange, **kw):
        gates.append(ack_orange)
        return await real(drone, wps, ack_orange=ack_orange, **kw)
    monkeypatch.setattr(permits, "gate_upload", gate)
    monkeypatch.setattr("app.attachments.mission.prepare", _no_attachments)
    monkeypatch.setattr("app.planner.service.mark_uploaded_by_hash", _nothing)
    await service.handle_text(rig.s, "survey a 50 metre radius at 30 metres")
    c = card(rig)
    assert c["skill"] == "survey" and c["preview"]["area"]["radius_m"] == 50.0
    n = len(c["preview"]["waypoints"])
    await service.confirm(rig.s, c["token"], True)
    assert ("upload", n) in rig.tel.calls and "start_mission" in rig.tel.calls
    assert gates and not any(gates)                     # orange is never acked by voice
    assert service.state_payload("sess-1")["task"]["kind"] == "survey"


async def _no_attachments(*a, **k):
    return SimpleNamespace(by_wp={})


async def _nothing(*a, **k):
    return None


async def test_survey_over_an_orange_zone_without_a_permit_is_refused(rig):
    from app.zones import engine
    await on(rig)
    engine.set_zones([{"id": "o1", "name": "Campus", "zone_class": "orange",
                       "geometry": square(17.6, 78.1, 30.0)}])
    await service.handle_text(rig.s, "survey a 50 metre radius at 30 metres")
    assert last(rig)["status"] == "refused" and "orange" in last(rig)["text"]


# ── orbit ────────────────────────────────────────────────────────────────

async def test_orbit_around_the_drone_and_not_supported(rig):
    await on(rig)
    await service.handle_text(rig.s, "orbit here at 20 metres radius")
    c = card(rig)
    assert c["preview"]["area"]["radius_m"] == 20.0
    await service.confirm(rig.s, c["token"], True)
    assert ("orbit", 20.0, 2.0) in rig.tel.calls
    assert service.state_payload("sess-1")["task"]["kind"] == "orbit"

    async def none(*a):
        raise NotImplementedError
    rig.tel.do_orbit = none
    await service.handle_text(rig.s, "orbit here at 20 metres radius")
    await service.confirm(rig.s, card(rig)["token"], True)
    assert "does not support" in last(rig)["text"]


async def test_orbit_round_the_target_needs_its_position(rig):
    await on(rig)
    await service.handle_text(rig.s, "orbit the target at 30 metres radius")
    assert last(rig)["status"] == "refused" and "target is on the map" in last(rig)["text"]


# ── follow me ────────────────────────────────────────────────────────────

def test_standoff_point_is_ten_metres_from_the_pilot_on_the_drones_side():
    pilot = (17.6, 78.1)
    drone = survey.offset(17.6, 78.1, 0.0, 40.0)            # 40 m north
    lat, lng = service.standoff_point(*pilot, *drone)
    assert survey.distance_m(*pilot, lat, lng) == pytest.approx(10.0, abs=0.1)
    assert lat > pilot[0]


async def follow_me(rig):
    await on(rig)
    await service.handle_text(rig.s, "follow me")
    await service.handle_text(rig.s, "yes")
    assert service.state_payload("sess-1")["task"]["kind"] == "follow_me"


async def test_follow_me_repositions_at_most_once_a_second(rig):
    await follow_me(rig)
    pos = survey.offset(17.6, 78.1, 0.0, -50.0)              # pilot 50 m south
    await service.pilot_position(rig.s, {"lat": pos[0], "lon": pos[1], "accuracy_m": 5})
    gotos = [c for c in rig.tel.calls if isinstance(c, tuple) and c[0] == "goto"]
    assert len(gotos) == 1 and gotos[0][3] == 20.0           # altitude held
    assert survey.distance_m(pos[0], pos[1], gotos[0][1], gotos[0][2]) == pytest.approx(10, abs=0.5)
    await service.pilot_position(rig.s, {"lat": pos[0] + 0.0001, "lon": pos[1], "accuracy_m": 5})
    assert len([c for c in rig.tel.calls if isinstance(c, tuple) and c[0] == "goto"]) == 1
    # Coarse fixes are not steered by.
    service.state("sess-1").last_reposition = 0
    await service.pilot_position(rig.s, {"lat": pos[0] + 0.001, "lon": pos[1], "accuracy_m": 80})
    assert len([c for c in rig.tel.calls if isinstance(c, tuple) and c[0] == "goto"]) == 1


async def test_follow_me_stops_with_hold_when_the_position_stops(rig):
    await follow_me(rig)
    pos = survey.offset(17.6, 78.1, 0.0, -50.0)
    await service.pilot_position(rig.s, {"lat": pos[0], "lon": pos[1], "accuracy_m": 5})
    service.state("sess-1").pilot_pos["mono"] -= 6.0
    await service.tick_once("sess-1")
    assert service.state_payload("sess-1")["task"] is None
    assert "mode:HOLD" in rig.tel.calls
    assert "position stopped arriving" in last(rig)["text"]


async def test_follow_me_refuses_a_red_destination(rig, monkeypatch):
    from app.zones import engine
    await follow_me(rig)
    spot = survey.offset(17.6, 78.1, 0.0, -45.0)
    engine.set_zones([{"id": "r1", "name": "Hostel", "zone_class": "red",
                       "geometry": square(spot[0], spot[1], 15.0)}])
    pos = survey.offset(17.6, 78.1, 0.0, -50.0)
    await service.pilot_position(rig.s, {"lat": pos[0], "lon": pos[1], "accuracy_m": 5})
    assert not any(isinstance(c, tuple) and c[0] == "goto" for c in rig.tel.calls)
    assert service.state_payload("sess-1")["task"] is None


# ── tasks stop on their triggers ─────────────────────────────────────────

async def running_follow(rig, monkeypatch):
    await follow_setup(rig, monkeypatch, [{"label": "man", "box": [402, 98, 498, 305]}])
    await service.handle_text(rig.s, "follow the man")
    await service.handle_text(rig.s, "yes")
    assert rig.tracker.tracking
    rig.tel.calls.clear()


@pytest.mark.parametrize("trigger,holds", [
    ("takeover", False), ("pilot", False), ("link", False), ("zone_lock", False),
    ("off", True), ("hold", True), ("stop", True), ("cancel", True), ("mode", True),
    ("socket_gone", True), ("released", False),
])
async def test_follow_stops_on_each_trigger(rig, monkeypatch, trigger, holds):
    await running_follow(rig, monkeypatch)
    if trigger == "takeover":
        takeover.start("sess-1", "staff-1", user_id="u", username="staff", workspace_id=None)
        await service.on_takeover("sess-1")
    elif trigger == "pilot":
        rig.tel.pilot_has_control = True
        await service.on_pilot_override("sess-1")
    elif trigger == "link":
        rig.tel.is_connected = False
        service.on_telemetry("sess-1")
    elif trigger == "zone_lock":
        rig.s.zone_lock = True
        service.on_telemetry("sess-1")
    elif trigger == "off":
        await service.set_enabled(rig.s, False)
    elif trigger == "hold":
        await service.handle_text(rig.s, "hold")
    elif trigger == "stop":
        await service.handle_text(rig.s, "stop following")
    elif trigger == "cancel":
        await service.cancel(rig.s)
    elif trigger == "mode":
        await service.on_mode_changed("sess-1", "crowd-management")
    elif trigger == "socket_gone":
        await service.switch_off("sess-1", "link_lost", hold=True)
    elif trigger == "released":
        await service.on_link_released("sess-1")
    for _ in range(5):
        await asyncio.sleep(0)
    assert service.state_payload("sess-1")["task"] is None
    assert rig.tracker.tracking is False
    assert ("mode:HOLD" in rig.tel.calls) is holds


async def test_orbit_ends_when_the_flight_mode_moves_on(rig):
    await on(rig)
    await service.handle_text(rig.s, "orbit here at 20 metres radius")
    await service.confirm(rig.s, card(rig)["token"], True)
    t = service.state("sess-1").task
    t.started -= 5
    rig.tel.snapshot.flight_mode.mode = "UNKNOWN"
    service.on_telemetry("sess-1")
    assert service.state("sess-1").task is not None       # the mode it orbits in, noted
    rig.tel.snapshot.flight_mode.mode = "POSCTL"
    service.on_telemetry("sess-1")
    for _ in range(5):
        await asyncio.sleep(0)
    assert service.state("sess-1").task is None and "mode:HOLD" not in rig.tel.calls


# ── status, count, describe without Claude ───────────────────────────────

async def test_status(rig):
    await on(rig)
    await service.handle_text(rig.s, "battery?")
    t = last(rig)["text"]
    assert "Battery 76 percent" in t and "20 metres" in t and "14 satellites" in t


async def test_count_uses_the_tracker_then_florence(rig, monkeypatch):
    import numpy as np
    from app.copilot import vision
    await on(rig)
    feed(rig, [{"id": 1, "box": [0, 0, 1, 1]}, {"id": 2, "box": [2, 2, 3, 3]}])
    await service.handle_text(rig.s, "how many people are there")
    assert last(rig)["text"] == "I count 2 people in view."
    st = service.state("sess-1")
    st.frame, st.frame_t = np.zeros((10, 10, 3), dtype=np.uint8), time.monotonic()
    vision.slot.set_for_tests(object())
    asked = []
    monkeypatch.setattr(vision, "ground",
                        lambda f, p, **kw: asked.append(kw) or [{"box": [0, 0, 1, 1]}] * 3)
    await service.handle_text(rig.s, "count the boats")
    assert last(rig)["text"] == "I count 3 boats in view."
    assert asked == [{"every": True}]          # counts ask for every instance


async def test_describe_uses_florence_without_a_key(rig, monkeypatch):
    import numpy as np
    from app.copilot import vision
    await on(rig)
    await service.handle_text(rig.s, "what do you see?")
    assert "start the video" in last(rig)["text"]
    st = service.state("sess-1")
    st.frame, st.frame_t = np.zeros((10, 10, 3), dtype=np.uint8), time.monotonic()
    vision.slot.set_for_tests(object())
    monkeypatch.setattr(vision, "caption", lambda f: "A road with two cars.")
    await service.handle_text(rig.s, "what do you see?")
    assert last(rig)["text"] == "A road with two cars."
    await service.handle_text(rig.s, "is anyone lying on the ground?")
    assert last(rig)["text"] == "Here is what I see: A road with two cars."


async def test_describe_with_a_key_sends_the_frame_to_claude(rig):
    import numpy as np
    await on(rig)
    client, m = fake_client(resp("end_turn", text("Nobody is lying down.")))
    service.set_planner_client(client)
    st = service.state("sess-1")
    st.frame, st.frame_t = np.zeros((720, 1920, 3), dtype=np.uint8), time.monotonic()
    await service.handle_text(rig.s, "is anyone lying on the ground?")
    assert last(rig)["text"] == "Nobody is lying down."
    img = m.calls[0]["messages"][0]["content"][0]
    assert img["type"] == "image"


def test_florence_box_parsing():
    from app.copilot import vision
    out = vision.parse_boxes({"bboxes": [[10, 20, 30, 40], [5, 5, 4, 4]], "labels": ["man", "x"]},
                             back=2.0, phrase="man")
    assert out == [{"label": "man", "box": [20.0, 40.0, 60.0, 80.0], "score": 1.0}]
    out = vision.parse_boxes({"bboxes": [[1, 1, 2, 2]], "bboxes_labels": ["<s>car</s>"]})
    assert out[0]["label"] == "car"
    assert vision.parse_boxes("not a dict") == []


def test_audio_decoding_rejects_empty_and_huge():
    from app.copilot import stt
    with pytest.raises(stt.AudioError):
        stt.decode_audio(b"")
    with pytest.raises(stt.AudioError):
        stt.decode_audio(b"x" * (stt.MAX_BYTES + 1))


def test_audio_decoding_reads_a_wav(tmp_path):
    import shutil
    import struct
    from app.copilot import stt
    if not shutil.which("ffmpeg"):
        pytest.skip("no ffmpeg")
    n = 16000
    pcm = b"".join(struct.pack("<h", int(8000 * math.sin(i / 10))) for i in range(n))
    wav = (b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " +
           struct.pack("<IHHIIHH", 16, 1, 1, 16000, 32000, 2, 16) + b"data" +
           struct.pack("<I", len(pcm)) + pcm)
    a = stt.decode_audio(wav)
    assert a.dtype.name == "float32" and abs(len(a) - n) < 200
    # What browsers record: webm/opus (Chrome), ogg/opus (Firefox), mp4/aac (Safari).
    import subprocess
    src = tmp_path / "a.wav"
    src.write_bytes(wav)
    for ext, codec, mime in (("webm", "libopus", "audio/webm"), ("ogg", "libopus", "audio/ogg"),
                             ("m4a", "aac", "audio/mp4")):
        out = tmp_path / f"a.{ext}"
        r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
                            "-c:a", codec, str(out)], capture_output=True)
        if r.returncode != 0:
            continue                      # this ffmpeg lacks the encoder
        a = stt.decode_audio(out.read_bytes(), mime=mime)
        assert abs(len(a) - n) < 2000, ext


# ── models unload after Copilot goes off ─────────────────────────────────

async def test_models_unload_after_the_last_session_switches_off(rig, monkeypatch):
    from app.copilot import models, stt, vision
    monkeypatch.setattr(service, "UNLOAD_AFTER_S", 0.01)
    stt.slot.set_for_tests(object())
    vision.slot.set_for_tests(object())
    await service.set_enabled(rig.s, True)
    await service.set_enabled(rig.s, False)
    for _ in range(50):
        await asyncio.sleep(0.01)
        if not stt.slot.loaded and not vision.slot.loaded:
            break
    assert not stt.slot.loaded and not vision.slot.loaded
    assert models.UNLOAD_AFTER_S == 600.0


async def test_state_payload_shape(rig):
    await service.set_enabled(rig.s, True)
    st = rig.sio.of("copilot_state")[-1]
    assert st["enabled"] is True and set(st["ready"]) == {"stt", "vision", "planner"}
    assert st["ready"]["planner"] == "local" and isinstance(st["ready"]["stt"], bool)
    assert st["task"] is None and isinstance(st["loading"], list)
    await service.set_enabled(rig.s, False)


# ── the real handlers ────────────────────────────────────────────────────

async def test_handlers_are_guarded_and_answer(live, monkeypatch):  # noqa: F811
    monkeypatch.setattr(service, "_warm", _no_warm)
    from test_live_scope import connect, errors, world
    w = await world(live)
    await connect(live, "v", w.vic[1])
    await connect(live, "hp", w.hp[1])
    h = live.sio.handlers["/"]
    await h["copilot_set"]("v", {"enabled": True})
    assert errors(live, "v")[-1]["event"] == "copilot_set"           # viewers do not command
    refused = live.rec.of("copilot_message", "v")[-1]
    assert refused["role"] == "system" and refused["status"] == "refused"
    await h["copilot_set"]("hp", {"enabled": True})
    assert live.rec.of("copilot_state", "hp")[-1]["enabled"] is True
    await h["copilot_text"]("hp", {"text": "land"})
    m = live.rec.of("copilot_message", "hp")[-1]
    assert m["status"] == "refused" and "no drone link" in m["text"]
    await h["copilot_confirm"]("hp", {"token": "nope", "accept": True})
    assert live.rec.of("copilot_message", "hp")[-1]["status"] == "refused"
    await h["copilot_set"]("hp", {"enabled": False})
    assert live.rec.of("copilot_state", "hp")[-1]["enabled"] is False
    service.reset_for_tests()


from test_live_scope import live  # noqa: E402,F401  (fixture)
