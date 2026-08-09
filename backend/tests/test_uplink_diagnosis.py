"""
Telemetry arrives, every command times out.

THE LOG THIS EXISTS TO EXPLAIN, verbatim from a real flight:

    ✅ Drone connected at udpin://127.0.0.1:49745
    Telemetry profile: RADIO — position 2 Hz, attitude 6 Hz
    Telemetry rates configured                       <- 12 s later: all 6 timed out
    Mission download failed: TIMEOUT
    Arm failed: TIMEOUT
    Could not read hardware UID
    Geofence upload failed: TIMEOUT

Six timeouts in a row are not six faults. They are one: the heartbeat arrived,
so the aircraft is alive and the downlink is fine, and nothing we send is
reaching it. Every one of those operations is a ROUND TRIP; the streams, which
are one-way, kept working throughout.

The two directions fail differently, which is what makes this so hard to read:

  * downlink is a BIND. A wrong address means silence — immediately obvious.
  * uplink is a SEND. A wrong address means the bytes leave for somewhere with
    nothing on it. UDP reports nothing back. Telemetry never stops.

The instrument was one-directional too: SerialBridge counted inbound bytes and
not a single outbound one, so it could say a great deal about a link that
delivers nothing and nothing at all about this.
"""
import pytest

from app.telemetry.serial_bridge import SerialBridge


class _Sio:
    async def emit(self, *a, **kw):
        pass


def _bridge(source="local-rf-agent"):
    b = SerialBridge.__new__(SerialBridge)
    b._sio = _Sio()
    b._socket_id = "sid"
    b._transport = None
    b.mavsdk_port = 0
    b.source = source
    b.bytes_in = 0
    b.packets_in = 0
    b.bytes_out = 0
    b.packets_out = 0
    from app.telemetry.serial_bridge import _FrameSniffer
    b._sniffer = _FrameSniffer()
    return b


# --------------------------------------------------------------------------- #
# The outbound direction is now measured                                        #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_outbound_bytes_are_counted():
    b = _bridge()
    b.datagram_received(b"\xfd" + bytes(20), ("127.0.0.1", 1))
    b.datagram_received(b"\xfd" + bytes(30), ("127.0.0.1", 1))
    assert b.packets_out == 2
    assert b.bytes_out == 21 + 31


@pytest.mark.asyncio
async def test_the_two_directions_are_counted_separately():
    """Conflating them would defeat the whole purpose: this failure is
    precisely a large inbound count sitting beside a meaningful outbound one."""
    b = _bridge()
    b.uplink(b"x" * 100)
    b.datagram_received(b"y" * 10, ("127.0.0.1", 1))
    assert (b.bytes_in, b.bytes_out) == (100, 10)


# --------------------------------------------------------------------------- #
# The verdict points downstream, or at us, and says which                       #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_commands_that_left_this_server_point_downstream():
    b = _bridge(source="local-rf-agent")
    for _ in range(20):
        b.datagram_received(b"\xfd" + bytes(30), ("127.0.0.1", 1))
    b.uplink(b"z" * 5000)
    verdict = b.round_trip_verdict()
    assert "ARE leaving this server" in verdict
    assert "local-rf-agent" in verdict, "name the relay — six of them share this path"
    assert "127.0.0.1" in verdict, "name the specific trap that causes this"


def test_commands_that_never_left_point_at_the_server():
    """The opposite diagnosis, and it must not be softened into the same
    words. Nothing outbound means mavsdk produced nothing, which is a fault on
    this machine — sending the operator to check their radio would be wrong."""
    b = _bridge()
    b.uplink(b"z" * 5000)
    verdict = b.round_trip_verdict()
    assert "nothing was sent toward the drone" in verdict
    assert "not on the radio" in verdict


def test_the_verdict_survives_a_link_with_no_traffic_either_way():
    assert _bridge().round_trip_verdict()


# --------------------------------------------------------------------------- #
# Which of the six relays is carrying it                                        #
# --------------------------------------------------------------------------- #

def test_the_relay_is_named_and_defaults_safely():
    """Web Serial, native serial, native RF, the local RF agent, SIYI and
    remote SITL all connect through one event and all logged as 'browser
    radio'. When a link half-works, which one is carrying it is the first
    question and the log could not answer it."""
    assert _bridge(source="siyi-udp").source == "siyi-udp"
    b = SerialBridge.__new__(SerialBridge)
    SerialBridge.__init__(b, _Sio(), "sid")
    assert b.source == "radio", "an older client that sends no label still works"


# --------------------------------------------------------------------------- #
# A timeout must not be explained with an unrelated STATUSTEXT                   #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_a_timeout_is_not_explained_by_routine_chatter():
    """STATUSTEXT travels the DOWNLINK — the half that still works in this
    failure — so there is always something available to misquote. A timeout
    means our command never arrived, so nothing the aircraft happens to be
    saying is the reason it failed."""
    from app.telemetry.manager import TelemetryManager

    t = TelemetryManager.__new__(TelemetryManager)
    t._address = "udpin://127.0.0.1:1"
    t._status_text = [(0.0, "CRITICAL", "Low battery")]
    t._status_event = None

    reason = await t._failure_reason(
        Exception("TIMEOUT: 'Timeout'; origin: arm()"), 0.0, "fallback"
    )
    assert "Low battery" not in reason
    assert "no reply from the drone" in reason


@pytest.mark.asyncio
async def test_a_denial_still_gets_the_autopilots_words():
    """The other branch must keep working — a denial IS explained by the FC,
    and that is the whole value of the status_text subscription."""
    from app.telemetry.manager import TelemetryManager

    t = TelemetryManager.__new__(TelemetryManager)
    t._address = "udpin://127.0.0.1:1"
    t._status_text = [(5.0, "CRITICAL", "Arming denied: no GPS lock")]
    t._status_event = None

    reason = await t._failure_reason(
        Exception("COMMAND_DENIED: 'Command Denied'; origin: arm()"), 0.0, "fallback"
    )
    assert reason == "Arming denied: no GPS lock"
