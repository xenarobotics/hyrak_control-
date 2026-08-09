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
    t._rate_counts = {}
    t._rate_window_start = None
    t._measured_rates = {}
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
    a = _StubAction(lands_on_attempt=2)
    assert await manager(a)._set_takeoff_altitude_verified(2.0) is True
    assert a.value == 2.0
    assert a.attempts == 2


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
    # RELATIVE, not absolute. The absolute figures are a tuning decision that
    # depends on the radio in front of them — pinning them here turned a
    # deliberate walk-back to safer rates into a test failure, which is the
    # test asserting a preference rather than an invariant. What must always
    # hold is the ORDERING: the two streams the tracking geometry is computed
    # from outrank the ones that only feed a dashboard.
    assert rec.rates["position"] > rec.rates["home"]
    assert rec.rates["attitude_euler"] >= rec.rates["position"]
    assert rec.rates["attitude_euler"] > rec.rates["battery"]
    assert rec.rates["home"] <= rec.rates["battery"]


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


# --------------------------------------------------------------------------- #
# Achieved rates                                                                #
# --------------------------------------------------------------------------- #
#
# A 3DR radio's ceiling is AIR_SPEED and ECC — set on the RADIO, invisible from
# here, and unrelated to the 57600 printed on the box (that is the wire to the
# computer, not the air link). So the request is only a request, and the only
# honest answer to "how fast can this link go" is to measure what arrives.

@pytest.mark.asyncio
async def test_arrivals_are_counted_into_a_measured_rate(monkeypatch):
    t = manager(_StubAction())
    clock = {"now": 1000.0}
    monkeypatch.setattr("time.monotonic", lambda: clock["now"])

    for _ in range(30):
        t._count("attitude")
    assert t.snapshot.measured_rates == {}, "no verdict before the window closes"

    clock["now"] += TelemetryManager._RATE_WINDOW_S
    t._count("attitude")
    assert t.snapshot.measured_rates["attitude"] == pytest.approx(6.2, abs=0.2)


@pytest.mark.asyncio
async def test_a_starved_stream_reads_far_below_what_was_asked(monkeypatch):
    """The whole point. Requesting 10 Hz and receiving 3 is indistinguishable
    from a healthy link unless the arrivals are counted."""
    t = manager(_StubAction())
    clock = {"now": 500.0}
    monkeypatch.setattr("time.monotonic", lambda: clock["now"])
    for _ in range(15):
        t._count("position")
    clock["now"] += TelemetryManager._RATE_WINDOW_S
    t._count("position")
    assert t.snapshot.measured_rates["position"] < 4.0


@pytest.mark.asyncio
async def test_each_window_is_independent_of_the_last(monkeypatch):
    """A radio setting turned up must show its effect while you are still
    standing there, not be averaged away by the previous ten minutes."""
    t = manager(_StubAction())
    clock = {"now": 0.0}
    monkeypatch.setattr("time.monotonic", lambda: clock["now"])
    for _ in range(5):
        t._count("position")
    clock["now"] += TelemetryManager._RATE_WINDOW_S
    t._count("position")
    slow = t.snapshot.measured_rates["position"]

    for _ in range(100):
        t._count("position")
    clock["now"] += TelemetryManager._RATE_WINDOW_S
    t._count("position")
    assert t.snapshot.measured_rates["position"] > slow * 5


@pytest.mark.asyncio
async def test_velocity_is_not_requested_separately():
    """position and velocity are ONE message. MAVSDK keeps max() of the two
    rates for GLOBAL_POSITION_INT, so a separate velocity request can only push
    position up — never buy a second stream, and never lower anything."""
    t, rec = rate_manager("udpin://127.0.0.1:1", "radio")
    await t._set_rates()
    assert "velocity_ned" not in rec.rates
    assert rec.rates["position"] > 0


# --------------------------------------------------------------------------- #
# RF bridge: downlink and uplink are not symmetric                              #
# --------------------------------------------------------------------------- #
#
# The downlink is a send TO us and we bind 0.0.0.0, so it arrives from anywhere
# on the network with no configuration. The uplink is a send FROM us to a fixed
# listener, so it needs to know where that listener is — and it was hardcoded
# to loopback, which is only true while the RF decoder shares this machine.
#
# Moving the decoder to its own board therefore breaks exactly one direction,
# silently: telemetry streams in perfectly and every command is dropped into
# local loopback.

@pytest.mark.asyncio
async def test_the_uplink_goes_where_the_decoder_actually_is():
    from app.telemetry.rf_bridge import RFBridge
    b = RFBridge(14550, 14551, "192.168.50.12")
    assert b.uplink_addr == ("192.168.50.12", 14551)
    assert b.downlink_port == 14550


@pytest.mark.asyncio
async def test_the_deployed_default_is_the_real_decoder_not_loopback():
    """The decoder is its own board on the network. Defaulting to loopback
    means the very first connect after a fresh install has working telemetry
    and no working commands — the failure that is hardest to spot."""
    from app.config import get_settings
    assert get_settings().rf_uplink_host != "127.0.0.1"


@pytest.mark.asyncio
async def test_the_default_is_resolved_from_settings_not_hardcoded():
    """One place to change it, and .env can override for a different rig."""
    from app.telemetry import rf_bridge
    import inspect
    assert inspect.signature(rf_bridge.ensure_started).parameters["uplink_host"].default is None


@pytest.mark.asyncio
async def test_an_explicit_host_still_wins_over_the_default():
    from app.telemetry.rf_bridge import RFBridge
    b = RFBridge(14550, 14551, "10.0.0.9")
    assert b.uplink_addr == ("10.0.0.9", 14551)


@pytest.mark.asyncio
async def test_a_changed_uplink_host_rebinds_rather_than_reusing():
    """ensure_started is idempotent on matching config. If it compared only
    the PORTS, editing the host would silently hand back the old bridge still
    pointed at loopback — the setting would appear to save and change
    nothing."""
    from app.telemetry.rf_bridge import RFBridge
    a = RFBridge(14550, 14551, "127.0.0.1")
    b = RFBridge(14550, 14551, "192.168.50.12")
    assert (a.downlink_port, a.uplink_addr) != (b.downlink_port, b.uplink_addr)


# --------------------------------------------------------------------------- #
# A failed radio connect has to say WHY                                         #
# --------------------------------------------------------------------------- #
#
# "Connection timed out at udpin://127.0.0.1:59810" names a loopback port the
# operator has never heard of. Whether the radio was unplugged, the permission
# was not granted, the baud is wrong, or the aircraft is out of range, the log
# said the same thing — and mavsdk_server only ever adds "Waiting to discover
# system". The bridge is the one place that knows whether bytes arrived.

def _bridge():
    from app.telemetry.serial_bridge import SerialBridge, _FrameSniffer
    b = SerialBridge.__new__(SerialBridge)
    b._transport = None
    b.bytes_in = 0
    b.packets_in = 0
    b._sniffer = _FrameSniffer()
    return b


def test_silence_from_the_radio_is_named_as_such():
    b = _bridge()
    msg = b.traffic()
    assert "no bytes" in msg
    assert "baud" in msg


def test_framed_mavlink_without_a_heartbeat_blames_the_airframe():
    """Frames arriving proves the baud and the ground radio are right. What is
    missing is the aircraft, so the message must say so rather than repeating
    "check the baud rate"."""
    b = _bridge()
    for _ in range(3):
        b.uplink(_v2(109, sysid=51))
    msg = b.traffic()
    assert "RADIO_STATUS" in msg
    assert "air-side" in msg
    assert "no bytes" not in msg


def test_unframed_noise_blames_the_baud_rate():
    """The opposite diagnosis, from the same symptom of "bytes are arriving"."""
    b = _bridge()
    b.uplink(bytes([0x41] * 200))
    msg = b.traffic()
    assert "baud" in msg
    assert "air-side" not in msg


def test_the_counters_survive_a_closed_transport():
    """uplink() is called from a socket handler and must never raise on a
    torn-down bridge — losing telemetry is bad, losing the socket is worse."""
    b = _bridge()
    b.uplink(b"x" * 10)
    assert b.bytes_in == 10


# --------------------------------------------------------------------------- #
# What is actually on the wire                                                  #
# --------------------------------------------------------------------------- #
#
# "3099 bytes arrived but no heartbeat" is still two diagnoses in one sentence,
# and they point at opposite ends of the system: noise at the wrong baud (fix
# on the operator's machine) versus valid MAVLink with no autopilot in it (fix
# at the airframe). A SiK radio emits RADIO_STATUS from the GROUND module
# whether or not the air side is linked, so framed MAVLink arriving is not
# evidence that the aircraft is talking.

def _v2(msgid: int, sysid: int = 1, payload_len: int = 9) -> bytes:
    return (bytes([0xFD, payload_len, 0, 0, 7, sysid, 1,
                   msgid & 0xFF, (msgid >> 8) & 0xFF, (msgid >> 16) & 0xFF])
            + bytes(payload_len) + b"\x00\x00")


def _sniffed(*chunks: bytes):
    from app.telemetry.serial_bridge import _FrameSniffer
    s = _FrameSniffer()
    for c in chunks:
        s.feed(c)
    return s


def test_noise_at_the_wrong_baud_frames_as_nothing():
    """The distinguishing case. Bytes flowing plus zero frames is a baud
    mismatch, and saying "check the air side is powered" would send the
    operator to the roof for a problem on their desk."""
    assert _sniffed(bytes([0x41] * 300)).summary() == ""


def test_a_radio_talking_to_itself_is_identified_as_such():
    """Ground module chattering with no aircraft behind it: frames arrive,
    they are all RADIO_STATUS, and the system id is the radio's, not an
    autopilot's."""
    s = _sniffed(_v2(109, sysid=51) * 3)
    assert "RADIO_STATUS" in s.summary()
    assert 0 not in s.by_msg, "no heartbeat"
    assert s.sysids == {51}


def test_a_healthy_link_shows_a_heartbeat():
    s = _sniffed(_v2(0) + _v2(30) + _v2(33))
    assert 0 in s.by_msg
    assert "HEARTBEAT" in s.summary()


def test_a_frame_split_across_two_chunks_is_still_counted():
    """Serial reads land on arbitrary boundaries, so frames straddle chunks
    constantly. Dropping those would under-count exactly when the stream is
    slowest — which is when this diagnosis matters most."""
    f = _v2(0)
    assert 0 in _sniffed(f[:5], f[5:]).by_msg


def test_mavlink_v1_is_recognised_too():
    """Older autopilots and some radios still emit v1, and reporting "nothing
    framed" for a perfectly good v1 stream would blame the baud rate."""
    v1 = bytes([0xFE, 9, 7, 1, 1, 0]) + bytes(9) + b"\x00\x00"
    assert 0 in _sniffed(v1).by_msg


def test_the_scan_buffer_cannot_grow_without_bound():
    """A stream that never frames must not accumulate — this runs on every
    chunk from a live radio for the life of the session."""
    s = _sniffed(*[bytes([0x41] * 400) for _ in range(50)])
    assert len(s._buf) <= 512
