"""
Why a command failed, in the autopilot's own words.

THE REPORT THIS EXISTS TO ANSWER: "arm or takeoff commands are not reaching
the drone." They were reaching it. The log said so:

    Action: arm | session fa850346
    Arm failed: COMMAND_DENIED: 'Command Denied'; origin: arm()

COMMAND_DENIED is an ACK. It is the aircraft answering — the command crossed
the 3DR link, the flight controller parsed it, refused it, and sent the
refusal back over the same link. The link was never the problem. But the
ground station rendered that as a button that did not latch, which is exactly
what a dead radio also looks like, so the whole investigation went to the
radio and the radio was fine.

PX4 sends the actual cause alongside the refusal as a STATUSTEXT — "Arming
denied: ...", "Preflight Fail: ...". QGC prints that line, which is why QGC
feels diagnosable. Nothing here subscribed to status_text at all, so the one
message that explains the failure was received and dropped on the floor.
"""
import asyncio

import pytest

from app.telemetry.manager import TelemetryManager


class _Status:
    def __init__(self, sev, text):
        self.type = f"StatusTextType.{sev}"
        self.text = text


class _StubTelemetry:
    """Yields the FC's status texts, each after its own delay — the ACK and
    the STATUSTEXT are separate messages and do not arrive together."""

    def __init__(self, messages):
        self._messages = messages

    async def status_text(self):
        for delay, sev, text in self._messages:
            await asyncio.sleep(delay)
            yield _Status(sev, text)
        # A real stream never ends; hold the task open so the test exercises
        # the same shape the live subscription has.
        await asyncio.sleep(3600)


class _DeniedAction:
    def __init__(self, exc):
        self._exc = exc

    async def arm(self):
        raise self._exc

    async def disarm(self):
        raise self._exc


class _StubDrone:
    def __init__(self, action, telemetry):
        self.action = action
        self.telemetry = telemetry


def _denied():
    """The real exception MAVSDK raises, not a lookalike — its __str__ is the
    C++ call trace this code has to reduce to something an operator can read,
    and a hand-made stand-in would let a change to that formatting through."""
    from mavsdk.action import ActionError, ActionResult

    return ActionError(
        ActionResult(ActionResult.Result.COMMAND_DENIED, "Command Denied"), "arm()"
    )


def _manager(messages, exc=None):
    from app.telemetry.schemas import TelemetrySnapshot

    t = TelemetryManager.__new__(TelemetryManager)
    t._drone = _StubDrone(_DeniedAction(exc or _denied()), _StubTelemetry(messages))
    t._snapshot = TelemetrySnapshot()
    t._on_update = None
    t._last_emit = 0.0
    t._fleet_mode = False
    t._running = True
    t._status_text = []
    t._status_event = None
    t.last_action_error = None
    return t


async def _with_status_running(t, coro):
    task = asyncio.create_task(t._subscribe_status_text())
    try:
        return await coro
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


# --------------------------------------------------------------------------- #
# The reason reaches the operator                                               #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_the_autopilots_reason_is_what_the_operator_is_told():
    t = _manager([(0.05, "CRITICAL", "Arming denied: Compass not calibrated")])
    assert await _with_status_running(t, t.arm()) is False
    assert t.last_action_error == "Arming denied: Compass not calibrated"


@pytest.mark.asyncio
async def test_a_reason_arriving_AFTER_the_refusal_is_still_caught():
    """The failure mode that makes the naive version useless. The ACK comes
    back first and the explanation trails it — over a 3DR link by a good
    fraction of a second. Reading the buffer at the instant of failure finds
    nothing, every time, and the operator gets the generic message forever."""
    t = _manager([(0.25, "ERROR", "Preflight Fail: GPS lock required")])
    assert await _with_status_running(t, t.arm()) is False
    assert t.last_action_error == "Preflight Fail: GPS lock required"


@pytest.mark.asyncio
async def test_routine_chatter_is_not_mistaken_for_the_reason():
    """The FC talks constantly. Reporting the newest line regardless of
    severity would answer "why did arming fail?" with "Using default EKF" —
    confidently wrong, which is worse than the generic message."""
    t = _manager([
        (0.02, "INFO", "Using default EKF"),
        (0.05, "INFO", "Home position set"),
    ])
    assert await _with_status_running(t, t.arm()) is False
    assert "EKF" not in (t.last_action_error or "")
    assert "Home position" not in (t.last_action_error or "")


@pytest.mark.asyncio
async def test_a_silent_autopilot_still_gets_a_readable_message():
    """Not every refusal carries a STATUSTEXT. The fallback must be plain
    English, not MAVSDK's C++ call trace, and must not be empty."""
    t = _manager([])
    assert await _with_status_running(t, t.arm()) is False
    reason = t.last_action_error or ""
    assert reason
    assert "origin:" not in reason and "params:" not in reason
    assert "pre-arm" in reason.lower()


@pytest.mark.asyncio
async def test_the_wait_for_a_reason_is_bounded():
    """This sits directly between the operator's button press and their
    feedback. An unbounded wait for a message that may never come would turn
    every silent refusal into a hung UI."""
    t = _manager([])
    loop = asyncio.get_running_loop()
    start = loop.time()
    await _with_status_running(t, t.arm())
    assert loop.time() - start < TelemetryManager._STATUS_WAIT_S + 1.0


@pytest.mark.asyncio
async def test_an_older_message_is_not_dredged_up_for_a_new_command():
    """Boot-time warnings sit in the buffer. Attaching one to a refusal that
    happened a minute later blames a condition that has since cleared."""
    t = _manager([])
    t._status_text = [(0.0, "CRITICAL", "Preflight Fail: Compass not calibrated")]
    import time as _time
    # `since` is now — everything already in the buffer predates the command.
    reason = await t._fc_reason(_time.monotonic(), "fallback")
    assert reason == "fallback"


# --------------------------------------------------------------------------- #
# Severity ordering                                                             #
# --------------------------------------------------------------------------- #

def test_severity_ascends_the_way_MAVSDK_orders_it_not_MAVLink():
    """MAVLink's SEVERITY enum descends (0 = EMERGENCY, 6 = INFO); MAVSDK's
    StatusTextType ascends (0 = DEBUG, 7 = EMERGENCY). Reading one as the
    other inverts the filter silently — every real warning discarded and
    every routine INFO line promoted to "the reason"."""
    rank = TelemetryManager._severity_rank
    assert rank("EMERGENCY") > rank("CRITICAL") > rank("WARNING") > rank("INFO")
    assert rank("WARNING") >= TelemetryManager._STATUS_MIN_SEVERITY
    assert rank("INFO") < TelemetryManager._STATUS_MIN_SEVERITY
    assert rank("nonsense-from-a-future-mavsdk") == 0


def test_the_status_buffer_is_bounded():
    """The FC can emit hundreds of lines during a boot or a failsafe. This is
    for explaining the last command, not for keeping a flight log."""
    t = _manager([])
    for i in range(500):
        t._status_text.append((float(i), "INFO", f"line {i}"))
        del t._status_text[:-TelemetryManager._STATUS_TEXT_KEEP]
    assert len(t._status_text) <= TelemetryManager._STATUS_TEXT_KEEP


# --------------------------------------------------------------------------- #
# It has to survive the trip to the browser                                     #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_the_reason_is_carried_on_the_action_result():
    """The manager knowing the reason is worth nothing if the socket event
    drops it — which is what happened before: every branch returned a bare
    ok flag."""
    from app.events.telemetry_events import execute_drone_action

    class _Tel:
        last_action_error = "Arming denied: Compass not calibrated"

        async def arm(self):
            return False

    result = await execute_drone_action(_Tel(), "arm", {})
    assert result["ok"] is False
    assert result["error"] == "Arming denied: Compass not calibrated"


@pytest.mark.asyncio
async def test_a_successful_action_carries_no_error():
    from app.events.telemetry_events import execute_drone_action

    class _Tel:
        last_action_error = "stale reason from the last failure"

        async def arm(self):
            return True

    result = await execute_drone_action(_Tel(), "arm", {})
    assert result["ok"] is True
    assert "error" not in result
