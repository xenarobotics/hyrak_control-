"""
The gap between Offboard and a human on the sticks.

REPORTED: "everything is done in offboard mode, so when I arm and take off from
my application the drone is in offboard. If I want to take control from the RC
it should switch to position or stabilised — right now I am unable to do it."

THE APP'S BELIEF THAT IT WAS FLYING WAS NEVER CHECKED AGAINST THE AIRCRAFT.
`_offboard_active` was written by start_offboard, cleared by stop_offboard and
read by the watchdog — three places, all of them inside this process. PX4 ends
Offboard on its own every single time a pilot takes over, on the mode switch or
on the sticks, and nothing here noticed. The tracker stayed armed, the watchdog
kept the setpoint stream alive so PX4's offboard-loss failsafe could never fire,
and the panel still said "following" while a human flew the aircraft.

These tests pin the detection, the latch that stops the app grabbing the
aircraft back, and the deliberate handover in the other direction.

NOTHING HERE HAS BEEN FLOWN. They are unit tests over a fake MAVSDK.
"""
import pytest

from app.telemetry.manager import TelemetryManager
from app.telemetry.schemas import TelemetrySnapshot


class _Offboard:
    def __init__(self, fail: bool = False):
        self.started = 0
        self.stopped = 0
        self.setpoints = 0
        self.fail = fail

    async def set_velocity_body(self, _v):
        self.setpoints += 1

    async def start(self):
        if self.fail:
            raise RuntimeError("no setpoints streaming")
        self.started += 1

    async def stop(self):
        self.stopped += 1


class _Action:
    def __init__(self):
        self.calls = []

    async def disarm(self):
        self.calls.append("disarm")

    async def kill(self):
        self.calls.append("kill")

    async def hold(self):
        self.calls.append("hold")

    async def land(self):
        self.calls.append("land")


class _MavlinkDirect:
    def __init__(self):
        self.sent = []

    async def send_message(self, msg):
        import json
        self.sent.append(json.loads(msg.fields_json))


class _Drone:
    def __init__(self, offboard_fail: bool = False):
        self.offboard = _Offboard(fail=offboard_fail)
        self.action = _Action()
        self.mavlink_direct = _MavlinkDirect()


def _manager(mode: str = "OFFBOARD", offboard_fail: bool = False):
    """A manager with no event loop behind it — every field the paths under
    test touch, and nothing else."""
    t = TelemetryManager.__new__(TelemetryManager)
    t._drone = _Drone(offboard_fail=offboard_fail)
    t._snapshot = TelemetrySnapshot()
    t._snapshot.flight_mode.mode = mode
    t._snapshot.flight_mode.is_armed = True
    t._snapshot.flight_mode.is_in_air = True
    t._snapshot.position.relative_altitude_m = 20.0
    t._on_update = None
    t._on_pilot_override = None
    t._last_emit = 0.0
    t._fleet_mode = False
    t._running = True
    t._connected = True
    t._address = "udpin://127.0.0.1:1"
    t._status_text = []
    # The status-text loop also drives the calibration picture (see
    # test_sensor_calibration). Hand-built managers have to carry that handle
    # too, or the feed raises and the loop that carries the autopilot's own
    # refusal reasons ends on the first message.
    t._calibration = None
    t._status_event = None
    t.last_action_error = None
    t._offboard_active = False
    t._offboard_hold_alt = None
    t._offboard_stale = False
    t._last_velocity_cmd_t = 0.0
    t._pilot_override_mode = None
    t._offboard_release_until = 0.0
    t._alt_verify_task = None
    t._MODE_CONFIRM_S = 0.3
    return t


def _flying(mode: str = "OFFBOARD"):
    """A manager the app is actively flying in Offboard."""
    t = _manager(mode)
    t._offboard_active = True
    t._snapshot.offboard_active = True
    t._offboard_hold_alt = 20.0
    t._last_velocity_cmd_t = 1234.0
    return t


# --------------------------------------------------------------------------- #
# The departure is noticed                                                      #
# --------------------------------------------------------------------------- #

def test_leaving_offboard_unasked_is_read_as_the_pilot_taking_over():
    """THE REPORTED GAP. PX4 says POSCTL; the app was still flying a chase."""
    t = _flying()
    t._check_offboard_departure("POSCTL")
    assert t.pilot_has_control is True
    assert t._snapshot.pilot_override == "POSCTL"
    assert t._offboard_active is False
    assert t._snapshot.offboard_active is False


@pytest.mark.parametrize("mode", ["POSCTL", "ALTCTL", "STABILIZED", "MANUAL",
                                  "HOLD", "RETURN_TO_LAUNCH", "LAND", "ACRO"])
def test_any_mode_that_is_not_offboard_counts(mode):
    """The pilot's mode switch has six slots and the operator does not get to
    choose which one it is in. Whatever PX4 moved to, the app is not flying."""
    t = _flying()
    t._check_offboard_departure(mode)
    assert t.pilot_has_control is True


def test_staying_in_offboard_changes_nothing():
    t = _flying()
    t._check_offboard_departure("OFFBOARD")
    assert t.pilot_has_control is False
    assert t._offboard_active is True


def test_a_mode_change_when_we_were_never_flying_is_not_an_override():
    """The operator switching HOLD -> POSCTL from the app's own menu with no
    tracking running is an ordinary mode change, not a takeover."""
    t = _manager("HOLD")
    t._check_offboard_departure("POSCTL")
    assert t.pilot_has_control is False


def test_the_hold_altitude_is_dropped_so_a_resumed_follow_cannot_fly_to_a_stale_height():
    """_offboard_hold_alt is the height the app was holding when it last had
    the aircraft. After a pilot has flown it somewhere else that number is a
    height nobody chose, and it must not survive to be flown back to."""
    t = _flying()
    t._check_offboard_departure("POSCTL")
    assert t._offboard_hold_alt is None


def test_the_watchdog_stops_streaming_zeros():
    """The watchdog re-sends a zero setpoint every 200 ms ON PURPOSE, so
    Offboard never goes stale. After a takeover that is exactly wrong: it keeps
    Offboard instantly re-enterable for the rest of the flight and stops PX4's
    offboard-loss failsafe from ever firing. Clearing _offboard_active is what
    silences it — the watchdog's own first test."""
    t = _flying()
    t._check_offboard_departure("POSCTL")
    assert not (t._offboard_active and t._connected)
    assert t._last_velocity_cmd_t == 0.0


def test_the_override_is_announced_to_whoever_is_listening():
    seen = []
    t = _flying()
    t._on_pilot_override = seen.append
    t._check_offboard_departure("ALTCTL")
    assert seen == ["ALTCTL"], "the event layer has to stop the tracker"


def test_a_callback_that_raises_does_not_leave_the_app_thinking_it_is_flying():
    """The stand-down is the important half. If the notification fails, the
    aircraft state must already be correct."""
    def _boom(_mode):
        raise RuntimeError("socket gone")
    t = _flying()
    t._on_pilot_override = _boom
    t._check_offboard_departure("POSCTL")
    assert t.pilot_has_control is True
    assert t._offboard_active is False


# --------------------------------------------------------------------------- #
# Our own departures are not pilots                                             #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_our_own_stop_offboard_is_not_a_takeover():
    """stop_offboard causes the very mode change the detector watches for. If
    it read as a takeover, ending a follow normally would latch the app out of
    Offboard and every subsequent follow would refuse."""
    t = _flying()
    await t.stop_offboard()
    t._check_offboard_departure("HOLD")
    assert t.pilot_has_control is False


@pytest.mark.asyncio
async def test_landing_from_the_app_is_not_a_takeover():
    t = _flying("LAND")
    await t.set_flight_mode("LAND")
    t._check_offboard_departure("LAND")
    assert t.pilot_has_control is False


@pytest.mark.asyncio
async def test_disarming_from_the_app_is_not_a_takeover():
    t = _flying()
    await t.disarm()
    t._check_offboard_departure("HOLD")
    assert t.pilot_has_control is False


@pytest.mark.asyncio
async def test_a_kill_is_not_a_takeover():
    t = _flying()
    await t.emergency_stop()
    t._check_offboard_departure("HOLD")
    assert t.pilot_has_control is False


def test_the_window_expires_so_a_later_takeover_is_still_seen():
    """The claim covers ONE mode change, not the rest of the flight. A pilot
    grabbing the aircraft three seconds after the app stopped a follow and
    started another must still register."""
    import time as _time
    t = _flying()
    t._claim_next_mode_change()
    t._offboard_release_until = _time.monotonic() - 0.01   # window already gone
    t._check_offboard_departure("POSCTL")
    assert t.pilot_has_control is True


# --------------------------------------------------------------------------- #
# The latch: the app does not grab the aircraft back                            #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_offboard_is_refused_while_the_pilot_has_it():
    """EVERY FOLLOW CONTROL IS STILL ON SCREEN AND STILL TAPPABLE after a
    takeover. One tap must not put an autonomous chase back on an aircraft
    somebody is hand-flying out of trouble."""
    t = _flying()
    t._check_offboard_departure("POSCTL")
    assert await t.start_offboard() is False
    assert t._drone.offboard.started == 0
    assert "pilot" in (t.last_action_error or "").lower()


@pytest.mark.asyncio
async def test_the_refusal_names_the_mode_the_pilot_took_it_in():
    t = _flying()
    t._check_offboard_departure("ALTCTL")
    await t.start_offboard()
    assert "ALTCTL" in (t.last_action_error or "")


@pytest.mark.asyncio
async def test_taking_control_back_is_a_deliberate_act_and_then_offboard_works():
    t = _flying()
    t._check_offboard_departure("POSCTL")
    assert await t.resume_from_pilot() is True
    assert t.pilot_has_control is False
    assert await t.start_offboard() is True


@pytest.mark.asyncio
async def test_taking_control_back_does_not_itself_re_enter_offboard():
    """Clearing the latch says "the app may fly again", not "fly now". Offboard
    is entered by arming a tracking mode, which is a separate decision."""
    t = _flying()
    t._check_offboard_departure("POSCTL")
    await t.resume_from_pilot()
    assert t._drone.offboard.started == 0
    assert t._offboard_active is False


def test_a_disarm_clears_the_latch():
    """The latch exists to stop the app grabbing an aircraft out of a flying
    pilot's hands. On the ground there is nothing to grab, and a latch that
    survived the flight would refuse the next one for a reason that stopped
    being true when the props did."""
    t = _flying()
    t._check_offboard_departure("POSCTL")
    t._clear_pilot_override()
    assert t.pilot_has_control is False


def test_clearing_a_latch_that_was_never_set_is_harmless():
    t = _manager("HOLD")
    t._clear_pilot_override()
    assert t._snapshot.pilot_override is None


# --------------------------------------------------------------------------- #
# The other direction: the operator hands the aircraft over                     #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_handover_puts_the_aircraft_in_position_and_says_so():
    """POSITION is what a pilot recovering an aircraft wants: centred sticks
    hold position, so letting go is safe."""
    t = _flying("POSCTL")
    ok, mode = await t.handover_to_pilot()
    assert (ok, mode) == (True, "POSITION")
    assert t._drone.offboard.stopped == 1
    assert t.pilot_has_control is True


@pytest.mark.asyncio
async def test_handover_falls_back_when_position_is_refused():
    """If the reason the pilot is taking over is that the position estimate
    died, POSITION is the one mode PX4 will refuse. Refusing to hand over at
    all would be the worst possible answer to "give me the aircraft"."""
    t = _flying("ALTCTL")     # aircraft will only confirm ALTCTL
    ok, mode = await t.handover_to_pilot()
    assert (ok, mode) == (True, "ALTITUDE")


@pytest.mark.asyncio
async def test_handover_falls_all_the_way_to_stabilized():
    t = _flying("STABILIZED")
    ok, mode = await t.handover_to_pilot()
    assert (ok, mode) == (True, "STABILIZED")


@pytest.mark.asyncio
async def test_the_fallback_order_is_position_then_altitude_then_stabilized():
    assert TelemetryManager._HANDOVER_MODES == ("POSITION", "ALTITUDE", "STABILIZED")


@pytest.mark.asyncio
async def test_a_handover_that_did_not_happen_is_not_reported_as_one():
    """The operator is about to let go of the aircraft on the strength of this
    answer. A false success here is the worst lie in the file."""
    t = _flying("OFFBOARD")   # confirms nothing else
    ok, detail = await t.handover_to_pilot()
    assert ok is False
    assert "POSITION" in detail and "ALTITUDE" in detail and "STABILIZED" in detail


@pytest.mark.asyncio
async def test_handover_stops_offboard_before_changing_mode():
    t = _flying("POSCTL")
    await t.handover_to_pilot()
    assert t._offboard_active is False


@pytest.mark.asyncio
async def test_handover_works_even_when_the_app_was_not_flying():
    """The mode switch sitting already in the slot the pilot wants is the case
    PX4 acts on only when it CHANGES — so this button has to work regardless of
    what the app was doing."""
    t = _manager("POSCTL")
    ok, mode = await t.handover_to_pilot()
    assert (ok, mode) == (True, "POSITION")
    assert t._drone.offboard.stopped == 0, "nothing to stop"


@pytest.mark.asyncio
async def test_a_handover_latches_so_a_stray_tap_cannot_undo_it():
    t = _flying("POSCTL")
    await t.handover_to_pilot()
    assert await t.start_offboard() is False


# --------------------------------------------------------------------------- #
# Can the transmitter take it back at all? Answered before takeoff              #
# --------------------------------------------------------------------------- #

def _verdict(name, value):
    return TelemetryManager._rc_param_verdict(name, value)[0]


def test_joystick_only_locks_the_transmitter_out_entirely():
    """COM_RC_IN_MODE=1 means PX4 ignores the transmitter, mode switch and all.
    No amount of stick movement or switch flipping will take the aircraft."""
    assert _verdict("COM_RC_IN_MODE", 1) == "blocked"


def test_stick_input_disabled_is_blocked_too():
    assert _verdict("COM_RC_IN_MODE", 4) == "blocked"


def test_keep_first_is_flagged_because_this_app_can_win_the_race():
    """COM_RC_IN_MODE=3 gives the aircraft to whichever manual source PX4
    hears FIRST. This app has a virtual joystick, so if it sends before the
    transmitter is switched on, the transmitter is locked out until reboot —
    which looks exactly like a dead radio."""
    assert _verdict("COM_RC_IN_MODE", 3) == "warn"


def test_rc_transmitter_only_is_fine():
    assert _verdict("COM_RC_IN_MODE", 0) == "ok"


def test_stick_override_off_for_offboard_is_flagged():
    """COM_RC_OVERRIDE bit 1 covers Offboard and is CLEAR by default. With the
    default value of 1, moving the sticks while the app is flying does nothing
    at all — which is the reported symptom exactly."""
    assert _verdict("COM_RC_OVERRIDE", 1) == "warn"


def test_stick_override_on_for_both_is_ok():
    assert _verdict("COM_RC_OVERRIDE", 3) == "ok"


def test_stick_override_off_for_auto_is_flagged():
    """Bit 0 covers HOLD, which is where the aircraft sits after an app
    takeoff — before any tracking has started."""
    assert _verdict("COM_RC_OVERRIDE", 2) == "warn"


def test_an_unmapped_mode_switch_is_flagged():
    """RC_MAP_FLTMODE=0 means no channel is the mode switch, so the switch on
    the transmitter changes nothing."""
    assert _verdict("RC_MAP_FLTMODE", 0) == "warn"


def test_a_mapped_mode_switch_names_its_channel():
    verdict, detail = TelemetryManager._rc_param_verdict("RC_MAP_FLTMODE", 5)
    assert verdict == "ok" and "5" in detail


def test_a_stick_threshold_low_enough_to_trip_on_noise_is_flagged():
    assert _verdict("COM_RC_STICK_OV", 2.0) == "warn"


def test_a_stick_threshold_needing_half_deflection_is_flagged():
    assert _verdict("COM_RC_STICK_OV", 60.0) == "warn"


def test_an_ordinary_stick_threshold_is_ok():
    assert _verdict("COM_RC_STICK_OV", 30.0) == "ok"


@pytest.mark.asyncio
async def test_the_readiness_report_fails_closed_when_params_cannot_be_read():
    """A ground station that cannot read the parameters does not know whether
    the pilot can take over, and must not say yes."""
    t = _manager("HOLD")

    async def _none():
        return {}
    t.get_all_params = _none
    report = await t.rc_takeover_readiness()
    assert report["ok"] is False
    assert set(report["unreadable"]) == set(TelemetryManager._RC_TAKEOVER_PARAMS)


@pytest.mark.asyncio
async def test_a_healthy_airframe_reports_ok():
    t = _manager("HOLD")

    async def _params():
        return {
            "COM_RC_IN_MODE":  {"value": 0, "type": "int"},
            "COM_RC_OVERRIDE": {"value": 3, "type": "int"},
            "COM_RC_STICK_OV": {"value": 30.0, "type": "float"},
            "COM_RCL_EXCEPT":  {"value": 4, "type": "int"},
            "RC_MAP_FLTMODE":  {"value": 5, "type": "int"},
        }
    t.get_all_params = _params
    report = await t.rc_takeover_readiness()
    assert report["ok"] is True
    assert len(report["findings"]) == 5


@pytest.mark.asyncio
async def test_the_reported_configuration_is_not_ok():
    """The combination that produces "I cannot take control from the RC":
    joystick-only input, and no stick override in Offboard."""
    t = _manager("HOLD")

    async def _params():
        return {
            "COM_RC_IN_MODE":  {"value": 1, "type": "int"},
            "COM_RC_OVERRIDE": {"value": 1, "type": "int"},
            "COM_RC_STICK_OV": {"value": 30.0, "type": "float"},
            "COM_RCL_EXCEPT":  {"value": 0, "type": "int"},
            "RC_MAP_FLTMODE":  {"value": 0, "type": "int"},
        }
    t.get_all_params = _params
    report = await t.rc_takeover_readiness()
    assert report["ok"] is False
    blocked = [f for f in report["findings"] if f["verdict"] == "blocked"]
    assert [f["param"] for f in blocked] == ["COM_RC_IN_MODE"]


@pytest.mark.asyncio
async def test_the_readiness_check_never_writes_a_parameter():
    """These belong to whoever set the airframe up. A ground station that
    quietly rewrites RC behaviour mid-campaign is a worse problem than the one
    it solves — and the operator would have no idea it had happened."""
    t = _manager("HOLD")
    writes = []

    async def _params():
        return {n: {"value": 0, "type": "int"} for n in TelemetryManager._RC_TAKEOVER_PARAMS}

    async def _set(*a, **k):
        writes.append(a)
        return True
    t.get_all_params = _params
    t.set_param = _set
    await t.rc_takeover_readiness()
    assert writes == []


# --------------------------------------------------------------------------- #
# What goes on the wire                                                         #
# --------------------------------------------------------------------------- #

def test_the_snapshot_carries_who_is_flying():
    """"OFFBOARD" on the mode line told the operator which mode PX4 was in, not
    whether this app believed it was flying — and after a takeover those two
    answers differ, which is the only time the question matters."""
    snap = TelemetrySnapshot()
    d = snap.to_dict()
    assert d["offboard_active"] is False
    assert d["pilot_override"] is None


# --------------------------------------------------------------------------- #
# Holes found on cross-check                                                    #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_starting_offboard_claims_the_change_too():
    """ENTERING RACES THE SAME WAY LEAVING DOES. offboard.start() returns on
    PX4's ACK, but flight_mode comes off a 1 Hz HEARTBEAT — one already in
    flight still carries the OLD mode. Arriving after _offboard_active went
    true, that stale report read as a departure, and the app latched itself out
    of the Offboard session it had just successfully started."""
    t = _manager("TAKEOFF")
    assert await t.start_offboard() is True
    t._check_offboard_departure("HOLD")   # the stale heartbeat
    assert t.pilot_has_control is False, "the app locked itself out of its own session"
    assert t._offboard_active is True


#: Every method that commands a flight-mode change. SET ALT and RTL sit on
#: screen DURING a follow, so a missing claim here is not theoretical: using
#: either mid-chase would stop the tracker and lock the operator out of
#: Offboard for a pilot who was never there.
_MODE_CHANGING = [
    ("takeoff", ()),
    ("goto_altitude", (10.0,)),
    ("goto_custom_rtl", (1.0, 2.0, 10.0)),
    ("goto_home", ()),
    ("start_mission", ()),
    ("restart_mission", ()),
    ("pause_mission", ()),
    ("arm_and_start_mission", ()),
    ("arm_and_restart_mission", ()),
    ("disarm", ()),
    ("emergency_stop", ()),
    ("set_flight_mode", ("HOLD",)),
    ("start_offboard", ()),
    ("stop_offboard", ()),
    ("handover_to_pilot", ()),
    ("resume_mission_from_offboard", (3,)),
]


@pytest.mark.parametrize("name,args", _MODE_CHANGING)
def test_every_mode_changing_method_claims_the_change(name, args):
    """Walks the list rather than trusting nine scattered calls to stay in
    step — this codebase has already grown seven hand-copied copies of one
    analyzer list that silently drifted apart."""
    fn = getattr(TelemetryManager, name)
    assert getattr(fn, "_claims_mode_change", False) is True, (
        f"{name} moves the aircraft but does not claim the mode change it "
        f"causes — using it mid-follow would read as a pilot taking over"
    )


@pytest.mark.asyncio
async def test_setting_altitude_mid_follow_is_not_a_takeover():
    """THE REGRESSION THE DECORATOR EXISTS FOR. SET ALT during a chase moves
    the aircraft through PX4's reposition path, which changes mode."""
    t = _flying()
    t._snapshot.position.latitude_deg = 17.6
    t._snapshot.position.longitude_deg = 78.1
    t._snapshot.flight_mode.is_in_air = True

    class _Loc:
        async def goto_location(self, *a):
            return None
    t._drone.action.goto_location = _Loc().goto_location
    await t.goto_altitude(25.0)
    t._check_offboard_departure("HOLD")
    assert t.pilot_has_control is False
    # goto_altitude spawns a verifier that outlives this test's loop.
    if t._alt_verify_task is not None:
        t._alt_verify_task.cancel()


@pytest.mark.asyncio
async def test_a_setpoint_in_flight_does_not_reach_a_hand_flown_aircraft():
    """The trackers are stopped by the callback, but a vision result computed
    just before the takeover can still be on its way down."""
    t = _flying()
    t._check_offboard_departure("POSCTL")
    before = t._drone.offboard.setpoints
    await t.send_velocity_command(forward_m_s=3.0)
    assert t._drone.offboard.setpoints == before
