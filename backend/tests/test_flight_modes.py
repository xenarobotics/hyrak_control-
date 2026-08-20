"""
The mode menu offered seven modes and implemented four.

REPORTED: "the modes dropdown is not working accurately, I am unable to enable
a few of them, and if I set Position it went to Hold."

Both halves were real and they were different bugs.

STABILIZED, MISSION and OFFBOARD fell through set_flight_mode's if/elif chain
to `logger.warning("Unknown flight mode")` and returned False. The menu listed
them, selecting them did nothing, and nothing anywhere said why.

POSITION was worse, because it did something. It was deliberately aliased to
HOLD, on the reasoning that PX4's POSCTL is a manual-stick mode while HOLD
gives the same hover with no RC needed. That reasoning is defensible; doing it
silently is not. The aircraft then reported HOLD, and the only way to discover
the substitution was to notice a mode you had not asked for.

And nothing was CONFIRMED. PX4 refuses a mode whose preconditions are not met
without any error MAVSDK surfaces, so even the four implemented modes reported
success for a switch that had not happened.
"""
import asyncio

import pytest

from app.telemetry.manager import TelemetryManager


class _Action:
    def __init__(self):
        self.calls = []

    async def hold(self):
        self.calls.append("hold")

    async def return_to_launch(self):
        self.calls.append("rtl")

    async def land(self):
        self.calls.append("land")

    async def takeoff(self):
        self.calls.append("takeoff")


class _Mission:
    def __init__(self):
        self.started = 0

    async def start_mission(self):
        self.started += 1


class _MavlinkDirect:
    def __init__(self):
        self.sent = []

    async def send_message(self, msg):
        import json
        self.sent.append(json.loads(msg.fields_json) if hasattr(msg, "fields_json") else msg)


class _Drone:
    def __init__(self):
        self.action = _Action()
        self.mission = _Mission()
        self.mavlink_direct = _MavlinkDirect()


def _manager(reports: str = "HOLD"):
    from app.telemetry.schemas import TelemetrySnapshot

    t = TelemetryManager.__new__(TelemetryManager)
    t._drone = _Drone()
    t._snapshot = TelemetrySnapshot()
    t._snapshot.flight_mode.mode = reports
    t._on_update = None
    t._last_emit = 0.0
    t._fleet_mode = False
    t._running = True
    t._address = "udpin://127.0.0.1:1"
    t._status_text = []
    # The status-text loop also drives the calibration picture (see
    # test_sensor_calibration). Hand-built managers have to carry that handle
    # too, or the feed raises and the loop that carries the autopilot's own
    # refusal reasons ends on the first message.
    t._calibration = None
    t._status_event = None
    t.last_action_error = None
    t._MODE_CONFIRM_S = 0.3          # instance override; the class value is a radio round trip
    return t


# --------------------------------------------------------------------------- #
# Every offered mode is actually sent                                           #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_position_is_position_and_not_quietly_hold():
    """THE REPORTED BUG. Asking for Position must put the aircraft in POSCTL,
    or say it could not — never silently hand back a different mode."""
    t = _manager(reports="POSCTL")
    assert await t.set_flight_mode("POSITION") is True
    assert t._drone.action.calls == [], "must not have gone through hold()"
    sent = t._drone.mavlink_direct.sent
    assert len(sent) == 1
    assert sent[0]["command"] == TelemetryManager._MAV_CMD_DO_SET_MODE
    assert sent[0]["param2"] == float(TelemetryManager._PX4_MAIN["POSITION"])


@pytest.mark.asyncio
async def test_stabilized_is_sent_rather_than_rejected_as_unknown():
    t = _manager(reports="STABILIZED")
    assert await t.set_flight_mode("STABILIZED") is True
    assert t._drone.mavlink_direct.sent[0]["param2"] == float(TelemetryManager._PX4_MAIN["STABILIZED"])


@pytest.mark.asyncio
async def test_mission_starts_the_mission():
    t = _manager(reports="MISSION")
    assert await t.set_flight_mode("MISSION") is True
    assert t._drone.mission.started == 1


@pytest.mark.asyncio
async def test_the_proven_plugin_paths_are_unchanged():
    """HOLD, RETURN and LAND worked and are flown regularly. Rewriting them as
    raw commands would risk a regression in the modes that matter most, for no
    gain — they have plugin calls that return a real ACK."""
    for mode, reported, call in (("HOLD", "HOLD", "hold"),
                                 ("RETURN", "RETURN_TO_LAUNCH", "rtl"),
                                 ("LAND", "LAND", "land")):
        t = _manager(reports=reported)
        assert await t.set_flight_mode(mode) is True
        assert t._drone.action.calls == [call]
        assert t._drone.mavlink_direct.sent == [], "no raw command needed here"


# --------------------------------------------------------------------------- #
# A switch that did not happen must not report success                          #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_a_refused_mode_is_reported_as_refused():
    """PX4 rejects a mode whose conditions are not met — no position estimate,
    no mission loaded, not armed — and MAVSDK surfaces nothing for a
    DO_SET_MODE. Without confirmation the UI would show the switch as done and
    the aircraft would simply carry on doing something else."""
    t = _manager(reports="HOLD")          # never becomes POSCTL
    assert await t.set_flight_mode("POSITION") is False
    assert t.last_action_error
    assert "HOLD" in t.last_action_error


@pytest.mark.asyncio
async def test_the_refusal_names_what_the_drone_is_actually_doing():
    t = _manager(reports="MISSION")
    await t.set_flight_mode("STABILIZED")
    assert "MISSION" in (t.last_action_error or "")


@pytest.mark.asyncio
async def test_confirmation_does_not_wait_when_the_mode_is_already_right():
    """Mode is decoded from a 1 Hz heartbeat, so confirmation costs real time.
    It must not spend it when telemetry already agrees."""
    t = _manager(reports="POSCTL")
    loop = asyncio.get_running_loop()
    start = loop.time()
    assert await t.set_flight_mode("POSITION") is True
    assert loop.time() - start < 0.25


# --------------------------------------------------------------------------- #
# Offboard is not a menu item                                                   #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_offboard_explains_itself_instead_of_failing_blankly():
    """PX4 rejects OFFBOARD unless setpoints are ALREADY streaming, which only
    the tracking modes produce. Offering it as a hand-selectable mode could
    only ever fail; the useful thing is to say so."""
    t = _manager()
    assert await t.set_flight_mode("OFFBOARD") is False
    assert "tracking mode" in (t.last_action_error or "")
    assert t._drone.mavlink_direct.sent == []


@pytest.mark.asyncio
async def test_an_unknown_mode_is_named_not_silently_dropped():
    t = _manager()
    assert await t.set_flight_mode("BANANA") is False
    assert "BANANA" in (t.last_action_error or "")


# --------------------------------------------------------------------------- #
# The menu and the backend must agree                                           #
# --------------------------------------------------------------------------- #

def test_every_mode_the_UI_offers_is_one_the_backend_implements():
    """THE ROOT CAUSE. The list and the implementation drifted apart and
    nothing connected them, so three menu entries were dead for as long as they
    had existed. This is the check that would have caught it."""
    import re
    from pathlib import Path

    src = (Path(__file__).resolve().parents[2]
           / "frontend" / "src" / "lib" / "flightModes.ts").read_text()
    offered = set(re.findall(r"value:\s*'([A-Z_]+)'", src))
    assert offered, "could not read the mode list"
    unimplemented = offered - set(TelemetryManager._MODE_REPORTS_AS)
    assert not unimplemented, f"offered in the UI but not implemented: {unimplemented}"


def test_offboard_is_not_offered_in_the_menu():
    """It cannot be entered by hand, so a menu entry for it is a button that
    only ever produces an error."""
    from pathlib import Path

    src = (Path(__file__).resolve().parents[2]
           / "frontend" / "src" / "lib" / "flightModes.ts").read_text()
    assert "value: 'OFFBOARD'" not in src
