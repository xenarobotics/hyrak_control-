"""
Sensor calibration, and why it is a parser rather than a progress bar.

MAVSDK returns a percentage and a cooked status line. Stopping there gives you
a bar that fills while the operator has no idea which way to turn the aircraft.
The useful state — which side PX4 is still waiting for, which it has just
recognised, which are finished — is only in PX4's own STATUSTEXT stream, which
this ground station was already subscribed to for the message log.

So these tests are mostly about one thing: TURNING THE AUTOPILOT'S WORDS INTO A
PICTURE, correctly, including when the words arrive out of order, get dropped
by a lossy radio, or change wording between firmware releases.

NOTHING HERE HAS TOUCHED AN AIRCRAFT. Every line below is a real PX4 message
format from calibration_messages.h, replayed against the state machine.
"""
import pytest

from app.telemetry.calibration import (
    ACTIVE, DONE, PENDING, SIDES, SENSORS,
    CalibrationSession, parse_cal_line,
)


# --------------------------------------------------------------------------- #
# Reading PX4                                                                   #
# --------------------------------------------------------------------------- #

def test_a_line_that_is_not_calibration_is_not_claimed():
    """The same STATUSTEXT stream carries preflight results, EKF warnings and
    arming refusals. Claiming one of those as a calibration event would drive
    the animation off an unrelated message."""
    for line in ("Preflight Fail: Compass Sensor 0 missing",
                 "ARMED by external command",
                 "EKF2 IMU0 tilt alignment complete",
                 "", "   "):
        assert parse_cal_line(line) is None


def test_the_start_names_the_sensor():
    ev = parse_cal_line("[cal] calibration started: 2 accel")
    assert (ev.kind, ev.sensor) == ("started", "accel")


def test_progress_is_read_out_of_the_angle_brackets():
    assert parse_cal_line("[cal] progress <42>").progress == 42


@pytest.mark.parametrize("pct,expect", [("<0>", 0), ("<100>", 100), ("<250>", 100)])
def test_progress_is_clamped(pct, expect):
    """A percentage outside 0..100 would drive a bar off the end of its track."""
    assert parse_cal_line(f"[cal] progress {pct}").progress == expect


def test_the_pending_list_is_read_as_sides():
    ev = parse_cal_line("[cal] pending: down up left right front back")
    assert ev.kind == "pending"
    assert set(ev.sides) == set(SIDES)


def test_a_pending_list_ignores_words_that_are_not_sides():
    """Tolerance, not laziness: the separator and the surrounding wording have
    both changed between PX4 releases, and a parser that only works on the
    version it was written against stops animating one update from now."""
    ev = parse_cal_line("[cal] pending: down, up, left")
    assert set(ev.sides) == {"down", "up", "left"}


def test_an_orientation_is_recognised():
    ev = parse_cal_line("[cal] down orientation detected")
    assert (ev.kind, ev.side) == ("orientation", "down")


def test_a_finished_side_is_recognised():
    ev = parse_cal_line("[cal] left side done, rotate to a pending side")
    assert (ev.kind, ev.side) == ("side_done", "left")


def test_side_done_is_not_confused_with_calibration_done():
    """Both contain the word "done", and reading a side transition as the whole
    calibration finishing would mark five untouched sides complete."""
    assert parse_cal_line("[cal] calibration done: accel").kind == "done"
    assert parse_cal_line("[cal] up side done, rotate to a pending side").kind == "side_done"


def test_a_failure_carries_the_autopilots_own_reason():
    ev = parse_cal_line("[cal] calibration failed: timeout waiting for orientation")
    assert ev.kind == "failed"
    assert "timeout" in ev.text


def test_a_failure_naming_a_sensor_is_not_read_as_a_start():
    """"calibration failed: mag" ends with a sensor name exactly where
    "calibration started: 2 mag" does."""
    assert parse_cal_line("[cal] calibration failed: mag").kind == "failed"


@pytest.mark.parametrize("spelling", ["cancelled", "canceled"])
def test_both_spellings_of_cancelled_are_accepted(spelling):
    assert parse_cal_line(f"[cal] calibration {spelling}").kind == "cancelled"


def test_an_unrecognised_calibration_line_still_reaches_the_operator():
    """"hold vehicle still on a pending side" and "rotate vehicle around the
    detected orientation" are the two most useful sentences PX4 says and
    neither has a structured form. Dropping them would leave the screen silent
    at the moment the operator most needs telling."""
    ev = parse_cal_line("[cal] hold vehicle still on a pending side")
    assert ev.kind == "instruction"
    assert "hold vehicle still" in ev.text.lower()


def test_matching_is_case_insensitive():
    assert parse_cal_line("[CAL] Calibration Done: ACCEL").kind == "done"


# --------------------------------------------------------------------------- #
# A whole accelerometer calibration                                             #
# --------------------------------------------------------------------------- #

def _accel():
    return CalibrationSession("accel")


def test_an_oriented_sensor_starts_with_every_side_still_to_do():
    """PX4 sends its own pending list on the first message, but until then the
    screen has to show something TRUE, and "all six to go" is true."""
    s = _accel().state
    assert s.sides == {side: PENDING for side in SIDES}


def test_a_sensor_with_no_orientations_has_no_sides():
    """A gyro calibration drawn with six greyed-out boxes invites the operator
    to start rotating it, which is the one thing that ruins it."""
    assert CalibrationSession("gyro").state.sides == {}


def test_the_detected_side_becomes_the_active_one():
    c = _accel()
    c.feed("[cal] calibration started: 2 accel")
    c.feed("[cal] down orientation detected")
    assert c.state.sides["down"] == ACTIVE
    assert c.state.sides["up"] == PENDING


def test_only_one_side_is_ever_active():
    """Two lit sides on the model is an instruction the operator cannot obey."""
    c = _accel()
    c.feed("[cal] down orientation detected")
    c.feed("[cal] left orientation detected")
    assert [s for s, v in c.state.sides.items() if v == ACTIVE] == ["left"]


def test_a_finished_side_is_marked_done():
    c = _accel()
    c.feed("[cal] down orientation detected")
    c.feed("[cal] down side done, rotate to a pending side")
    assert c.state.sides["down"] == DONE


def test_the_pending_list_completes_the_sides_it_leaves_out():
    """The list is the authoritative statement of what is LEFT, so anything
    absent from it has been finished — including sides whose completion message
    never arrived."""
    c = _accel()
    c.feed("[cal] pending: left right front back")
    assert c.state.sides["down"] == DONE
    assert c.state.sides["up"] == DONE
    assert c.state.sides["left"] == PENDING


def test_a_repeated_pending_list_does_not_un_finish_completed_work():
    """PX4 re-sends the pending set during a side. Treating it as gospel in
    both directions would walk a finished side back to pending and ask the
    operator to redo it."""
    c = _accel()
    c.feed("[cal] down orientation detected")
    c.feed("[cal] down side done, rotate to a pending side")
    c.feed("[cal] pending: down up left right front back")
    assert c.state.sides["down"] == DONE, "asked the operator to redo a finished side"


def test_a_pending_list_does_not_disturb_the_side_being_held():
    c = _accel()
    c.feed("[cal] left orientation detected")
    c.feed("[cal] pending: up right front back")
    assert c.state.sides["left"] == ACTIVE


def test_progress_never_goes_backwards():
    """PX4 restarts its count per side on some firmwares. A bar that jumps back
    to 12% reads as a failure, and the operator interrupts a calibration that
    was going fine."""
    c = _accel()
    c.feed("[cal] progress <60>")
    c.feed("[cal] progress <10>")
    assert c.state.progress == 60


def test_finishing_marks_every_side_done_and_fills_the_bar():
    c = _accel()
    c.feed("[cal] down orientation detected")
    c.feed("[cal] calibration done: accel")
    assert c.state.phase == "done"
    assert c.state.progress == 100
    assert set(c.state.sides.values()) == {DONE}


def test_a_full_six_sided_run(clockless=None):
    """The whole protocol, in the order a real accelerometer calibration
    produces it."""
    c = _accel()
    c.feed("[cal] calibration started: 2 accel")
    c.feed("[cal] pending: down up left right front back")
    for i, side in enumerate(SIDES):
        c.feed(f"[cal] {side} orientation detected")
        assert c.state.sides[side] == ACTIVE
        c.feed(f"[cal] progress <{(i + 1) * 16}>")
        c.feed(f"[cal] {side} side done, rotate to a pending side")
        assert c.state.sides[side] == DONE
    c.feed("[cal] calibration done: accel")
    assert c.state.phase == "done"
    assert c.state.progress == 100


# --------------------------------------------------------------------------- #
# What the operator is told                                                     #
# --------------------------------------------------------------------------- #

def test_the_instruction_names_a_position_a_person_can_actually_adopt():
    """"back" and "front" describe which face points DOWN and read backwards to
    most people the first time. The screen says what to do with the aircraft,
    not which enum PX4 is on."""
    c = _accel()
    c.feed("[cal] pending: back")
    assert "TAIL" in c.state.instruction.upper()


def test_the_instruction_says_how_many_are_left():
    c = _accel()
    c.feed("[cal] pending: left right front back")
    assert "4 left" in c.state.instruction


def test_the_last_side_says_so():
    c = _accel()
    c.feed("[cal] pending: back")
    assert "last" in c.state.instruction.lower()


def test_a_compass_is_told_to_rotate_and_an_accelerometer_to_hold_still():
    """Opposite instructions from the same PX4 message. Getting this backwards
    ruins the calibration and the operator has no way to know."""
    accel = CalibrationSession("accel")
    accel.feed("[cal] down orientation detected")
    assert "still" in accel.state.instruction.lower()

    mag = CalibrationSession("mag")
    mag.feed("[cal] down orientation detected")
    assert "rotate" in mag.state.instruction.lower()


def test_a_gyro_is_told_not_to_move_it():
    assert "still" in CalibrationSession("gyro").state.instruction.lower()


def test_the_autopilots_own_words_are_kept_beside_our_translation():
    """A wording change we failed to parse is then still VISIBLE rather than
    silently swallowed — which is the difference between a screen that is one
    firmware behind and a screen that is lying."""
    c = _accel()
    c.feed("[cal] some future message we do not know")
    assert "future message" in c.state.detail


# --------------------------------------------------------------------------- #
# The verdict comes from the plugin, not the text                               #
# --------------------------------------------------------------------------- #

def test_a_success_with_no_done_message_still_completes():
    """A calibration can end without a `calibration done` STATUSTEXT ever
    arriving — a lossy radio drops it, or the firmware does not send one for
    that sensor. Left to the text alone the screen sits at 90% forever on a
    calibration that actually succeeded."""
    c = _accel()
    c.feed("[cal] progress <90>")
    c.finish(True)
    assert c.state.phase == "done"
    assert c.state.progress == 100
    assert c.state.ok is True


def test_a_failure_carries_a_reason_the_operator_can_act_on():
    c = _accel()
    c.finish(False, "the vehicle was moved")
    assert c.state.phase == "failed"
    assert c.state.error == "the vehicle was moved"


def test_a_verdict_does_not_overwrite_a_cancellation():
    """The operator pressed Cancel. Reporting that as a failure would send them
    looking for a fault in an aircraft that is fine."""
    c = _accel()
    c.feed("[cal] calibration cancelled")
    c.finish(False)
    assert c.state.phase == "cancelled"


def test_a_reason_already_given_by_the_autopilot_is_not_replaced_by_a_generic_one():
    c = _accel()
    c.feed("[cal] calibration failed: magnetometer 0 saturated")
    c.finish(False, "")
    assert "saturated" in c.state.error


# --------------------------------------------------------------------------- #
# The wire                                                                      #
# --------------------------------------------------------------------------- #

def test_the_wire_state_names_the_active_side_directly():
    """So the UI does not have to scan the map to find the one side it must
    highlight — and cannot disagree with this file about which it is."""
    c = _accel()
    c.feed("[cal] right orientation detected")
    assert c.state.to_dict()["active_side"] == "right"


def test_the_wire_state_carries_the_side_order():
    """The six are drawn in PX4's own order. Sending it rather than hardcoding
    it in the UI means a re-order here cannot silently renumber the operator's
    instructions on screen."""
    assert tuple(_accel().state.to_dict()["side_order"]) == SIDES


def test_every_offered_sensor_has_a_plugin_method_and_a_label():
    """The one table three layers read. A sensor added here without a method
    would offer the operator a button that raises on click."""
    from mavsdk.calibration import Calibration
    for key, spec in SENSORS.items():
        assert hasattr(Calibration, spec["method"]), f"{key} has no MAVSDK method"
        assert spec["label"], key


# --------------------------------------------------------------------------- #
# Refusing, immediately and in a sentence                                       #
# --------------------------------------------------------------------------- #
#
# PX4 refuses an armed calibration itself — but its refusal arrives as
# CalibrationResult.FAILED_ARMED several seconds later, by which time the
# operator has a spinning control and a vehicle they believe is calibrating.
# Saying no straight away, in words, is the whole difference.

def _mgr(armed=False, in_air=False, connected=True, offboard=False, running=None):
    from app.telemetry.manager import TelemetryManager
    from app.telemetry.schemas import TelemetrySnapshot

    t = TelemetryManager.__new__(TelemetryManager)
    t._snapshot = TelemetrySnapshot()
    t._snapshot.flight_mode.is_armed = armed
    t._snapshot.flight_mode.is_in_air = in_air
    t._connected = connected
    t._offboard_active = offboard
    t._calibration = CalibrationSession(running) if running else None
    t._calibration_task = None
    t._on_calibration = None
    return t


def test_a_healthy_disarmed_aircraft_may_calibrate():
    assert _mgr().calibration_refusal("accel") is None


def test_an_armed_aircraft_is_refused_before_the_command_is_sent():
    why = _mgr(armed=True).calibration_refusal("accel")
    assert why and "disarm" in why.lower()


def test_an_airborne_aircraft_is_refused():
    assert _mgr(in_air=True).calibration_refusal("gyro")


def test_a_disconnected_aircraft_is_refused():
    why = _mgr(connected=False).calibration_refusal("mag")
    assert why and "connected" in why.lower()


def test_an_aircraft_being_flown_by_a_tracking_mode_is_refused():
    """Offboard is streaming velocity setpoints. Starting a calibration under
    that is asking the autopilot to hold still while this app tells it to
    move."""
    why = _mgr(offboard=True).calibration_refusal("accel")
    assert why and "tracking" in why.lower()


def test_a_second_calibration_is_refused_by_name():
    """PX4 runs one routine at a time, and a second START while one is live is
    refused by the vehicle in a way that reads, on screen, as the first having
    crashed."""
    why = _mgr(running="mag").calibration_refusal("accel")
    assert why and "Compass" in why


def test_an_unknown_sensor_is_refused_rather_than_attempted():
    assert _mgr().calibration_refusal("lidar")


def test_the_refusal_is_checked_before_a_session_is_created():
    """A refused start that still left a session behind would block every
    subsequent calibration with "already running"."""
    import asyncio
    t = _mgr(armed=True)
    ok, why = asyncio.run(t.start_calibration("accel"))
    assert ok is False and why
    assert t._calibration is None


def test_a_finished_calibration_can_be_dismissed():
    t = _mgr(running="accel")
    t._calibration.finish(True)
    t.dismiss_calibration()
    assert t._calibration is None


def test_a_running_calibration_cannot_be_dismissed():
    """Discarding it would leave PX4 mid-routine — refusing arming and every
    later calibration — with nothing on screen tracking it. The aircraft looks
    bricked."""
    t = _mgr(running="accel")
    t._calibration.feed("[cal] calibration started: 2 accel")
    t.dismiss_calibration()
    assert t._calibration is not None


def test_a_raising_calibration_feed_cannot_kill_the_refusal_reasons():
    """THE SUBSCRIPTION THIS SHARES IS THE ONE THAT CARRIES "arming denied
    because…". An exception anywhere in that loop ends it for the rest of the
    flight, and every refusal after that degrades to "the drone refused the
    command" — which sends the operator to check a radio that is working.

    Drawing a calibration is not worth that, so the feed is guarded at its call
    site the same way the message-log listener is.
    """
    import asyncio

    class _Bomb:
        def feed(self, _text):
            raise RuntimeError("parser blew up")

    class _Status:
        def __init__(self, text):
            self.type = "INFO"
            self.text = text

    class _Tel:
        async def status_text(self):
            for t in ("[cal] progress <10>", "Arming denied: Compass not calibrated"):
                yield _Status(t)

    t = _mgr()
    t._calibration = _Bomb()
    t._running = True
    t._on_fc_message = None
    t._status_text = []
    t._status_event = None
    t._drone = type("D", (), {"telemetry": _Tel()})()
    asyncio.run(t._subscribe_status_text())

    assert len(t._status_text) == 2, "the subscription died on the first message"
    assert "Arming denied" in t._status_text[-1][2]
