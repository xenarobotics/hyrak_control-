"""
Commanded altitude vs achieved altitude.

The reported symptom: a takeoff to 2 m levels at 3-5 m on a real drone over a
3DR radio, and works perfectly in SITL. Nothing in this codebase converts
altitude units — every value is metres from the input box to MAVSDK — so the
difference has to be in something the LINK affects, and there is exactly one
such thing on the takeoff path.

set_takeoff_altitude() is not a command. It is a write to the persistent PX4
parameter MIS_TAKEOFF_ALT, and a parameter write is a round trip over the same
serial link the telemetry streams are already filling. On SITL that round trip
is a local UDP socket. Over 57600 baud it is not, and when it has not landed
before takeoff() is sent PX4 climbs to whatever the parameter ALREADY held.

That same persistence is what makes a 5 m mission start at 10 m: the parameter
survives on the vehicle, so the last manual takeoff silently sets the height
every later mission begins from.
"""
import asyncio

import pytest

from app.telemetry.manager import TelemetryManager


class _StubAction:
    """A vehicle whose parameter write lands only after `lands_on_attempt`
    tries — the behaviour of a saturated serial link, made deterministic."""

    def __init__(self, lands_on_attempt=1, initial=2.5):
        self.value = initial
        self.attempts = 0
        self.lands_on_attempt = lands_on_attempt
        self.takeoffs = 0

    async def set_takeoff_altitude(self, alt):
        self.attempts += 1
        if self.attempts >= self.lands_on_attempt:
            self.value = float(alt)

    async def get_takeoff_altitude(self):
        return self.value

    async def takeoff(self):
        self.takeoffs += 1


def _cancel(t):
    if t._alt_verify_task is not None:
        t._alt_verify_task.cancel()


class _StubDrone:
    def __init__(self, action):
        self.action = action


def manager(action) -> TelemetryManager:
    t = TelemetryManager.__new__(TelemetryManager)
    t._drone = _StubDrone(action)
    from app.telemetry.schemas import TelemetrySnapshot
    t._snapshot = TelemetrySnapshot()
    t._on_update = None
    t._last_emit = 0.0
    t._fleet_mode = False
    t._alt_verify_task = None
    return t


# --------------------------------------------------------------------------- #
# The parameter write                                                           #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_a_write_that_lands_first_time_is_accepted():
    a = _StubAction()
    assert await manager(a)._set_takeoff_altitude_verified(2.0) is True
    assert a.value == 2.0
    assert a.attempts == 1, "no needless retries on a healthy link"


@pytest.mark.asyncio
async def test_a_write_that_does_not_land_is_retried_until_it_does():
    """The whole point. On the first try the vehicle still reports its old
    2.5 m — exactly the value that turns a commanded 2 m into a 2.5 m hover."""
    a = _StubAction(lands_on_attempt=3)
    assert await manager(a)._set_takeoff_altitude_verified(2.0) is True
    assert a.value == 2.0
    assert a.attempts == 3


@pytest.mark.asyncio
async def test_a_write_that_never_lands_is_reported_not_assumed():
    """Returning True here is what produced the original bug: the code
    believed a parameter it had never confirmed."""
    a = _StubAction(lands_on_attempt=99)
    assert await manager(a)._set_takeoff_altitude_verified(2.0) is False
    assert a.value == 2.5, "the vehicle still holds its own default"


@pytest.mark.asyncio
async def test_a_float32_round_trip_is_not_treated_as_a_mismatch():
    """The parameter is a float32 and travels through a MAVLink param message,
    so exact equality would reject values that are in fact correct."""
    a = _StubAction()

    async def lossy(alt):
        a.attempts += 1
        a.value = float(alt) + 0.004
    a.set_takeoff_altitude = lossy
    assert await manager(a)._set_takeoff_altitude_verified(5.0) is True
    assert a.attempts == 1


# --------------------------------------------------------------------------- #
# Takeoff                                                                       #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_takeoff_still_flies_when_the_parameter_refuses_but_says_so():
    """Refusing to take off would strand an ARMED drone with props spinning,
    which is worse than a takeoff to a known-wrong altitude the operator has
    been told about and can correct with SET ALT."""
    a = _StubAction(lands_on_attempt=99)
    t = manager(a)
    assert await t.takeoff(2.0) is True
    _cancel(t)
    assert a.takeoffs == 1
    assert t.snapshot.altitude_warning is not None
    assert "2" in t.snapshot.altitude_warning


@pytest.mark.asyncio
async def test_a_healthy_takeoff_records_the_target_and_raises_no_warning():
    a = _StubAction()
    t = manager(a)
    assert await t.takeoff(6.0) is True
    _cancel(t)
    assert t.snapshot.commanded_altitude_m == 6.0
    assert t.snapshot.altitude_warning is None


@pytest.mark.asyncio
async def test_takeoff_with_no_altitude_touches_no_parameter():
    """A bare takeoff means "use the vehicle's own setting" — writing one would
    change the aircraft's persistent configuration behind the operator."""
    a = _StubAction()
    t = manager(a)
    assert await t.takeoff(None) is True
    assert a.attempts == 0
    assert a.value == 2.5


# --------------------------------------------------------------------------- #
# The mission trap                                                              #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_uploading_a_mission_aligns_the_auto_takeoff_altitude():
    """A mission started from the ground climbs to MIS_TAKEOFF_ALT FIRST, and
    that parameter is whatever the last manual takeoff left on the vehicle. A
    10 m takeoff in the morning made a 5 m survey begin at 10 m that
    afternoon — the mission was never wrong, the leftover parameter was."""
    a = _StubAction(initial=10.0)
    t = manager(a)
    await t._align_takeoff_altitude_to_mission([
        {"type": "waypoint", "altitude": 5.0, "lat": 1.0, "lng": 2.0},
        {"type": "waypoint", "altitude": 5.0, "lat": 1.1, "lng": 2.1},
    ])
    assert a.value == 5.0


@pytest.mark.asyncio
async def test_an_explicit_takeoff_item_states_the_intent_directly():
    a = _StubAction(initial=10.0)
    await manager(a)._align_takeoff_altitude_to_mission([
        {"type": "waypoint", "altitude": 30.0, "lat": 1.0, "lng": 2.0},
        {"type": "takeoff", "altitude": 4.0, "lat": 1.0, "lng": 2.0},
    ])
    assert a.value == 4.0


@pytest.mark.asyncio
async def test_a_mission_with_no_usable_altitude_leaves_the_vehicle_alone():
    a = _StubAction(initial=10.0)
    await manager(a)._align_takeoff_altitude_to_mission([{"lat": 1.0, "lng": 2.0}])
    assert a.value == 10.0
    assert a.attempts == 0


# --------------------------------------------------------------------------- #
# Achieved vs commanded                                                         #
# --------------------------------------------------------------------------- #

async def _settle_at(t: TelemetryManager, alt: float, target: float):
    """Hold a steady reported altitude and let the verifier reach a verdict."""
    t._snapshot.position.relative_altitude_m = alt
    await t._verify_altitude(target)


@pytest.mark.asyncio
async def test_holding_the_commanded_altitude_raises_nothing():
    t = manager(_StubAction())
    t._snapshot.altitude_warning = "stale"
    await _settle_at(t, 5.2, 5.0)
    assert t.snapshot.altitude_warning is None


@pytest.mark.asyncio
async def test_levelling_well_above_the_commanded_altitude_is_reported():
    """"I asked for 2 and it went to 5" — the case that has to be visible while
    there is still flight time to act on it."""
    t = manager(_StubAction())
    await _settle_at(t, 5.0, 2.0)
    assert t.snapshot.altitude_warning is not None
    assert "2.0" in t.snapshot.altitude_warning
    assert "5.0" in t.snapshot.altitude_warning


@pytest.mark.asyncio
async def test_the_verdict_never_corrects_the_aircraft():
    """A ground station cannot fix a barometer, and a correction issued on top
    of a diverging height estimate fights the symptom while hiding the cause."""
    a = _StubAction()
    t = manager(a)
    await _settle_at(t, 5.0, 2.0)
    assert a.takeoffs == 0, "no command was issued in response"


@pytest.mark.asyncio
async def test_a_drone_still_climbing_is_not_judged():
    """A verdict from mid-climb would flag every healthy takeoff."""
    t = manager(_StubAction())
    pos = t._snapshot.position

    async def climb():
        for i in range(40):
            pos.relative_altitude_m = i * 1.0
            await asyncio.sleep(0.01)

    task = asyncio.create_task(climb())
    # Deliberately short: the verifier must not conclude anything before the
    # altitude stops moving, so with the climb still running it produces no
    # verdict at all.
    try:
        await asyncio.wait_for(t._verify_altitude(40.0), timeout=1.0)
    except asyncio.TimeoutError:
        pass
    task.cancel()
    assert t.snapshot.altitude_warning is None


@pytest.mark.asyncio
async def test_a_second_command_supersedes_the_first_verifier():
    """Two verifiers running at once race, and the older one settling last
    would overwrite the newer verdict with a judgement about an altitude
    nobody is flying to any more."""
    t = manager(_StubAction())
    t._start_altitude_verify(2.0)
    first = t._alt_verify_task
    t._start_altitude_verify(20.0)
    await asyncio.sleep(0)
    assert first.cancelled() or first.done()
    assert t._alt_verify_task is not first
    t._alt_verify_task.cancel()
