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


# --------------------------------------------------------------------------- #
# The altitude in the COMMAND — what QGroundControl does                        #
# --------------------------------------------------------------------------- #
#
# Verified in both codebases rather than inferred:
#
#   PX4  navigator_main.cpp      rep->current.alt = cmd.param7;
#   QGC  PX4FirmwarePlugin.cc    takeoffAltAMSL = takeoffAltRel + altitudeAMSL
#                                sendMavCommand(..., NAV_TAKEOFF, ..., takeoffAltAMSL)
#   MAVSDK action_impl.cpp       takeoff_async_px4: NO param7 at all
#                                set_takeoff_altitude_px4: writes MIS_TAKEOFF_ALT
#
# So on PX4 the altitude reaches the aircraft through MAVSDK only as a
# parameter, and through QGC as a command field. That one difference is the
# whole of "it works in QGC".

class _RecordingDirect:
    def __init__(self, fail=False):
        self.sent = []
        self.fail = fail

    async def send_message(self, message):
        if self.fail:
            raise RuntimeError("mavlink_direct unavailable")
        self.sent.append(message)


def flying_manager(action, direct=None, lat=17.5, lng=78.3, amsl=540.0):
    t = manager(action)
    t._drone.mavlink_direct = direct if direct is not None else _RecordingDirect()
    t._snapshot.position.latitude_deg = lat
    t._snapshot.position.longitude_deg = lng
    t._snapshot.position.absolute_altitude_m = amsl
    return t


def _fields(msg) -> dict:
    import json as _json
    return _json.loads(msg.fields_json)


@pytest.mark.asyncio
async def test_the_altitude_travels_in_the_command_as_amsl():
    """param7 is AMSL, exactly as QGC computes it: requested relative height
    plus the vehicle's own absolute altitude."""
    a = _StubAction()
    t = flying_manager(a, amsl=540.0)
    t._snapshot.position.relative_altitude_m = 2.0    # airborne straight away
    assert await t._takeoff_with_altitude_in_the_command(2.0) is True
    f = _fields(t._drone.mavlink_direct.sent[0])
    assert f["command"] == 22                          # MAV_CMD_NAV_TAKEOFF
    assert f["param7"] == pytest.approx(542.0)
    assert a.attempts == 0, "no parameter is written on this path at all"


@pytest.mark.asyncio
async def test_no_field_is_ever_nan():
    """JSON has no NaN. PX4 substitutes the current position when param5/6 are
    non-finite, so the drone's own coordinates go in instead — same behaviour,
    every field a finite float that survives the encoding."""
    t = flying_manager(_StubAction(), lat=17.5, lng=78.3)
    t._snapshot.position.relative_altitude_m = 2.0
    await t._takeoff_with_altitude_in_the_command(5.0)
    f = _fields(t._drone.mavlink_direct.sent[0])
    for k, v in f.items():
        assert v == v, f"{k} is NaN and will not survive JSON"
    assert f["param5"] == pytest.approx(17.5)
    assert f["param6"] == pytest.approx(78.3)


@pytest.mark.asyncio
async def test_no_absolute_altitude_means_no_direct_takeoff():
    """param7 is AMSL. Without an absolute altitude there is no correct value
    to put in it, and guessing would fly the aircraft to a height nobody
    chose."""
    t = flying_manager(_StubAction(), amsl=0.0)
    assert await t._takeoff_with_altitude_in_the_command(5.0) is False
    assert t._drone.mavlink_direct.sent == []


@pytest.mark.asyncio
async def test_no_position_means_no_direct_takeoff():
    t = flying_manager(_StubAction(), lat=0.0, lng=0.0)
    assert await t._takeoff_with_altitude_in_the_command(5.0) is False


@pytest.mark.asyncio
async def test_an_aircraft_that_never_moves_reports_the_direct_path_failed():
    """The command is fire-and-forget, so without checking the aircraft
    actually left the ground a rejected message would leave an armed drone
    with props spinning and the UI reporting success."""
    t = flying_manager(_StubAction())
    t._snapshot.position.relative_altitude_m = 0.0
    assert await t._takeoff_with_altitude_in_the_command(5.0) is False


@pytest.mark.asyncio
async def test_takeoff_falls_back_to_the_parameter_path_when_direct_fails():
    """This can only ever ADD a way for the takeoff to succeed — never remove
    one. A build without mavlink_direct behaves exactly as before."""
    a = _StubAction()
    t = flying_manager(a, direct=_RecordingDirect(fail=True))
    assert await t.takeoff(4.0) is True
    _cancel(t)
    assert a.takeoffs == 1, "the MAVSDK takeoff path still ran"
    assert a.value == 4.0, "and the parameter was still set and verified"


@pytest.mark.asyncio
async def test_a_successful_direct_takeoff_writes_no_parameter():
    """The point of the whole exercise: MIS_TAKEOFF_ALT is persistent on the
    vehicle, so not touching it is not merely faster — it stops one takeoff
    silently reconfiguring the next mission."""
    a = _StubAction(initial=10.0)
    t = flying_manager(a)
    t._snapshot.position.relative_altitude_m = 3.0
    assert await t.takeoff(3.0) is True
    _cancel(t)
    assert a.attempts == 0
    assert a.takeoffs == 0
    assert a.value == 10.0, "the vehicle's own setting is left untouched"


# --------------------------------------------------------------------------- #
# Which link the stream rates are chosen for                                    #
# --------------------------------------------------------------------------- #

class _RateRecorder:
    def __init__(self):
        self.rates = {}

    def _setter(self, name):
        async def set_rate(hz):
            self.rates[name] = hz
        return set_rate


def rate_manager(address: str, link_kind: str = "local"):
    t = manager(_StubAction())
    rec = _RateRecorder()

    class _Tel:
        pass
    tel = _Tel()
    for n in ("position", "attitude_euler", "velocity_ned", "battery",
              "gps_info", "home", "in_air"):
        setattr(tel, f"set_rate_{n}", rec._setter(n))
    t._drone.telemetry = tel
    t._address = address
    t._link_kind = "local"
    t.set_link_kind(link_kind)
    return t, rec


@pytest.mark.asyncio
async def test_a_relayed_radio_is_recognised_despite_a_loopback_address():
    """THE BUG. The radio is plugged into the operator's machine and relayed
    here, so MAVSDK always sees udpin://127.0.0.1 whatever is at the far end —
    which made startswith("serial://") false on every real-radio flight this
    platform has ever made, and selected the fast profile over a 57600 baud
    half-duplex link every single time."""
    fast, rec_fast = rate_manager("udpin://127.0.0.1:41234", "local")
    await fast._set_rates()
    slow, rec_slow = rate_manager("udpin://127.0.0.1:41234", "radio")
    await slow._set_rates()
    assert rec_slow.rates["position"] < rec_fast.rates["position"]
    assert rec_slow.rates["attitude_euler"] < rec_fast.rates["attitude_euler"]


@pytest.mark.asyncio
async def test_a_plain_serial_address_still_counts_as_a_radio():
    """The address remains a fallback for a genuinely local serial cable —
    the declaration is an addition, not a replacement."""
    t, rec = rate_manager("serial:///dev/ttyUSB0:57600", "local")
    await t._set_rates()
    fast, rec_fast = rate_manager("udpin://127.0.0.1:41234", "local")
    await fast._set_rates()
    assert rec.rates["position"] < rec_fast.rates["position"]


@pytest.mark.asyncio
async def test_the_streams_that_fly_the_aircraft_outrank_the_dashboard():
    """Position and attitude feed the tracking geometry; battery percentage and
    home position change over minutes and cost the same per message."""
    t, rec = rate_manager("udpin://127.0.0.1:1", "radio")
    await t._set_rates()
    assert rec.rates["position"] >= 4.0
    assert rec.rates["attitude_euler"] >= 8.0
    assert rec.rates["battery"] <= 1.0
    assert rec.rates["home"] <= 0.5


@pytest.mark.asyncio
async def test_in_air_is_not_starved():
    """It is 2 bytes of payload and the UI picks TAKEOFF vs SET ALT from it —
    losing it is what made the altitude box look dead in flight."""
    for kind in ("radio", "local"):
        t, rec = rate_manager("udpin://127.0.0.1:1", kind)
        await t._set_rates()
        assert rec.rates["in_air"] >= 2.0


@pytest.mark.asyncio
async def test_an_unknown_link_kind_is_ignored_rather_than_believed():
    t, _ = rate_manager("udpin://127.0.0.1:1", "local")
    t.set_link_kind("wifi")
    assert t._link_kind == "local"
