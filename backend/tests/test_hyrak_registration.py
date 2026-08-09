"""
Claiming the ground decoder's feeds, instead of letting it guess.

The Luckfox decoder pushes video and MAVLink to ONE direct-UDP client, and it
has to know which machine that is. Left alone it infers the answer from its own
DHCP lease file. That is a safety net for clients that cannot speak up — VLC, a
plain UDP consumer, a laptop someone just plugged in — and inheriting it costs
us two failure modes for nothing:

  * a STATICALLY ADDRESSED PC never appears in the lease file, so there is
    nothing to infer from;
  * a STALE LEASE outlives its machine. dnsmasq holds leases 12 hours, so a PC
    that replaces another one gets no feeds until the old lease ages out — with
    nothing visibly wrong at either end.

A registration is also a STRONGER claim than a lease, so once made, another
machine's lease renewal cannot pull the stream away.

These read source. The frontend has no test runner (CI builds desktop releases
only), and this suite is the only thing that runs — so the protocol details
that would silently break the feeds are pinned here rather than nowhere. The
parse function's behaviour was verified against the decoder's three documented
reply forms while writing it.
"""
import asyncio
import logging
import re
import socket
import types
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_REG = _ROOT / "frontend" / "src" / "lib" / "hyrakRegister.ts"
_RF = _ROOT / "frontend" / "src" / "lib" / "nativeRfRelay.ts"
_RECV = _ROOT / "frontend" / "src" / "lib" / "hyrakReceiver.ts"
_AGENT = _ROOT / "air_unit_relay" / "telemetry_relay.py"


def _read(p: Path) -> str:
    if not p.exists():
        pytest.skip(f"{p} not present in this checkout")
    return p.read_text()


# --------------------------------------------------------------------------- #
# The protocol, exactly as the decoder defines it                               #
# --------------------------------------------------------------------------- #

def test_the_registration_goes_to_the_documented_port():
    assert "HYRAK_REGISTER_PORT = 9000" in _read(_REG)


def test_the_BARE_form_is_sent_and_never_one_carrying_our_own_address():
    """The decoder takes the address from the UDP source. Sending
    'HYRAK REGISTER <ip>' would replace a fact it can observe with a guess we
    would have to make — and a PC whose address was mistyped into a settings
    box would then point the feeds at nothing. The explicit form exists only
    for deliberately aiming the feeds at some OTHER machine."""
    src = _read(_REG)
    assert "'HYRAK REGISTER'" in src
    assert "HYRAK REGISTER ${" not in src and "HYRAK REGISTER '+" not in src


def test_all_three_reply_forms_are_handled():
    src = _read(_REG)
    for form in ("HYRAK\\s+OK", "HYRAK\\s+IDLE", "HYRAK\\s+ERR"):
        assert form in src, f"{form} reply is not handled"


def test_an_unrecognised_reply_is_not_taken_for_success():
    """A reply from the wrong port, or none at all, must not read as 'ok' —
    that would turn a misconfiguration into a silent one."""
    src = _read(_REG)
    assert "unrecognised reply" in src
    assert "empty reply" in src


def test_registration_repeats_so_it_self_heals():
    """There is no keepalive requirement — the decoder never expires a client.
    The tick exists so that if this PC's address changes, the feeds re-point
    with no user action. Cheap and idempotent: re-registering the same address
    returns early on the decoder without restarting any stream."""
    src = _read(_REG)
    assert "HYRAK_REGISTER_INTERVAL_MS" in src
    assert "setInterval(sendRegister" in src


# --------------------------------------------------------------------------- #
# It must not fight itself                                                      #
# --------------------------------------------------------------------------- #

def test_video_and_telemetry_are_counted_as_separate_owners():
    """They start and stop independently and both need the decoder pointed
    here. Without counting, releasing the telemetry link would kill the tick
    video depends on — invisibly, because stopping does not un-register: the
    feeds keep flowing and only the self-healing goes away. That would surface
    weeks later as a dead feed after an address change."""
    src = _read(_REG)
    assert "owners" in src
    assert "if (owners.size > 0) return" in src
    assert "'telemetry'" in _read(_RF)
    assert "'video'" in _read(_RECV)


def test_retargeting_bypasses_the_owner_count():
    """Pointing at a different decoder must tear the socket down first, and
    must NOT go through the owner-counting stop — the owner was just added, so
    that path returns early and leaves the socket aimed at the old address."""
    src = _read(_REG)
    assert "if (active) await teardown()" in src


def test_the_claim_is_released_on_a_clean_shutdown():
    """A REGISTRATION OUTLIVES THE PROCESS, which is the point — it is what
    stops another machine's DHCP lease pulling the stream away mid-flight.
    The cost is symmetrical and only appears after we are gone: nothing
    expires it (the decoder's CLIENT_TIMEOUT is 0), so the feeds stay pinned
    to this PC's address forever and a later lease-following client on
    another machine can never take over, because weak never overrides strong.

    Adding a re-registration timer is what made this worth fixing, so the
    release belongs with it."""
    src = _read(_REG)
    assert "'HYRAK UNREGISTER'" in src
    assert "sendUnregister()" in src


def test_the_release_survives_the_app_simply_being_closed():
    """The stranded-claim case is not a tidy stop() call — it is the window
    going away, which is precisely when nobody calls anything. Both events
    are registered because neither is reliable alone across platforms."""
    src = _read(_REG)
    assert "'pagehide'" in src and "'beforeunload'" in src


def test_the_socket_is_not_closed_out_from_under_the_release():
    """dgram.send is asynchronous. Closing in the same tick can discard the
    queued packet, and the packet whose entire job is to release the claim is
    the worst one to lose."""
    src = _read(_REG)
    i, j = src.index("sendUnregister()\n    // Let the datagram"), src.index("stop('udp', BRIDGE_ID)")
    assert i < j, "release must be sent before the socket is stopped"
    assert "setTimeout(r, 50)" in src


def test_registration_never_breaks_the_link_it_is_helping():
    """It is UDP to an unauthenticated port on a box that may not be there.
    The feeds run regardless, so a failure here must not throw into the relay
    start path or stop telemetry from connecting."""
    rf = _read(_RF)
    assert "void startHyrakRegistration" in rf, "fire-and-forget, never awaited into the failure path"
    reg = _read(_REG)
    assert "if (!isDesktopApp()) return" in reg, "a browser tab has no socket; that is not an error"


# --------------------------------------------------------------------------- #
# The browser path must not be left depending on inference                      #
# --------------------------------------------------------------------------- #

def test_the_relay_agent_registers_so_browser_sessions_do_not_need_a_lease():
    """THE ONE CASE THAT ACTUALLY BIT. Every decoder VIDEO path is desktop-only
    (hyrakReceiver refuses in a browser, and the server-sourced feed requires
    the desktop app to push), so no browser video depends on the decoder's
    lease-following. Telemetry is different: telemetry_relay.py binds 14550 and
    IS the browser fallback, consuming the decoder's raw UDP push — and a
    browser tab cannot send a registration, which is the whole reason the agent
    exists.

    So the agent registers on its own behalf. It is not a browser: it already
    owns a UDP socket and already knows the decoder's address."""
    src = _read(_AGENT)
    assert b'HYRAK REGISTER'.decode() in src
    assert "args.register_port" in src


def test_the_agent_does_not_claim_feeds_it_cannot_receive():
    """A loopback uplink host means the decoder is this machine, or the host
    was never configured. Firing registrations at our own loopback would be
    noise, and worse, a default that looks like it did something."""
    src = _read(_AGENT)
    # Matched as the WHOLE guard, not the loopback tuple alone. That tuple
    # also appears in the startup log warning further down the file, so the
    # loose version of this assertion passed with the guard deleted — a
    # vacuous test that would have shipped the bug it was written to prevent.
    assert 'if args.no_register or args.uplink_host in ("127.0.0.1", "localhost"):' in src


def test_the_agents_registration_can_be_turned_off():
    """Registering redirects BOTH feeds to this machine and there is exactly
    one direct-UDP client. A rig where something else should own them needs a
    way to say so."""
    assert "--no-register" in _read(_AGENT)


def test_a_failed_registration_never_takes_the_relay_down():
    """It is UDP to an unauthenticated port on a box that may be absent. The
    telemetry it is helping must not depend on it."""
    src = _read(_AGENT)
    assert "except OSError" in src
    assert "feeds unaffected" in src


# --------------------------------------------------------------------------- #
# Two registrants, one client — the thrash                                      #
# --------------------------------------------------------------------------- #
#
# There is exactly ONE direct-UDP client on the decoder, and an explicit
# registration beats everything including another explicit registration. A
# registration from a DIFFERENT address does not update a variable — it tears
# down and respawns both wfb_rx processes. So two components registering on
# independent timers from different machines restart the feeds every few
# seconds, indefinitely, and the symptom looks exactly like an RF or air-unit
# fault. Given how much of this investigation was spent on precisely that class
# of misattribution, these run the REAL loop rather than grepping it.


def _register_loop(*, uplink_host, register_port, has_browser, loop, log):
    """The agent's own _register body, lifted from source and made runnable.

    Executing the real thing is the point: a grep-shaped assertion would
    happily pass on a loop that no longer works, and this file has already
    produced one vacuous test that did exactly that.
    """
    src = _read(_AGENT)
    body = re.search(r"    async def _register\(\) -> None:\n(.*?)\n    async def _report",
                     src, re.S).group(1)
    fast = types.SimpleNamespace(**{k: getattr(asyncio, k) for k in dir(asyncio)
                                    if not k.startswith("_")})
    fast.sleep = lambda _s: asyncio.sleep(0.02)
    ns = {
        "args": types.SimpleNamespace(no_register=False, uplink_host=uplink_host,
                                      register_port=register_port),
        "socket": socket, "asyncio": fast, "loop": loop, "logger": log,
        "current_client": {"ws": object() if has_browser else None},
    }
    exec("async def _register() -> None:\n" + body, ns)
    return ns["_register"]


class _FakeDecoder(asyncio.DatagramProtocol):
    """Answers registrations, optionally flipping the destination it reports —
    which is what a second registrant on another machine looks like from here."""

    def __init__(self, flap: bool):
        self.flap = flap
        self.seen = 0

    def connection_made(self, transport):
        self._t = transport

    def datagram_received(self, data, addr):
        self.seen += 1
        ip = ("192.168.50.39" if self.seen % 2 else "192.168.50.77") if self.flap else "192.168.50.39"
        self._t.sendto(
            f"HYRAK OK video={ip}:5600 mavlink={ip}:14550 rtsp=rtsp://d:8554/video".encode(),
            addr,
        )


async def _serve(flap: bool, port: int):
    dec = _FakeDecoder(flap)
    await asyncio.get_running_loop().create_datagram_endpoint(
        lambda: dec, local_addr=("127.0.0.2", port))
    return dec


@pytest.mark.asyncio
async def test_an_idle_agent_claims_nothing():
    """The sharp version of the regression. An agent left running on a spare
    laptop with no browser attached is consuming nothing, and must not fight a
    working ground station on another machine every ten seconds forever."""
    dec = await _serve(flap=False, port=9151)
    loop = asyncio.get_running_loop()
    fn = _register_loop(uplink_host="127.0.0.2", register_port=9151,
                        has_browser=False, loop=loop, log=logging.getLogger("t"))
    task = asyncio.ensure_future(fn())
    await asyncio.sleep(0.6)
    task.cancel()
    assert dec.seen == 0


@pytest.mark.asyncio
async def test_an_agent_that_is_serving_a_browser_does_claim_the_feed():
    """The other half — the gate must not be so tight that it never registers."""
    dec = await _serve(flap=False, port=9152)
    loop = asyncio.get_running_loop()
    fn = _register_loop(uplink_host="127.0.0.2", register_port=9152,
                        has_browser=True, loop=loop, log=logging.getLogger("t"))
    task = asyncio.ensure_future(fn())
    await asyncio.sleep(0.4)
    task.cancel()
    assert dec.seen > 0


@pytest.mark.asyncio
async def test_a_registration_fight_is_detected_and_conceded():
    """Two registrants cannot both win, so the right move is to stop feeding
    the fight: back off, let the other one hold the feeds, and say so loudly.
    A stable stream with a clear log beats both sides restarting it forever."""
    dec = await _serve(flap=True, port=9153)
    loop = asyncio.get_running_loop()
    fn = _register_loop(uplink_host="127.0.0.2", register_port=9153,
                        has_browser=True, loop=loop, log=logging.getLogger("t"))
    # The loop RETURNS on conceding. If it never does, this times out — which
    # is the failure being guarded against: an endless registration war.
    await asyncio.wait_for(fn(), timeout=10)
    assert dec.seen < 12, "conceded after a few flaps, not after hundreds"


@pytest.mark.asyncio
async def test_a_steady_decoder_is_never_mistaken_for_a_fight():
    """The detector keys on the destination CHANGING between our own
    registrations. A decoder answering consistently must never trip it, or the
    agent would concede a feed nobody is contesting."""
    dec = await _serve(flap=False, port=9154)
    loop = asyncio.get_running_loop()
    fn = _register_loop(uplink_host="127.0.0.2", register_port=9154,
                        has_browser=True, loop=loop, log=logging.getLogger("t"))
    task = asyncio.ensure_future(fn())
    await asyncio.sleep(0.8)
    still_running = not task.done()
    task.cancel()
    assert still_running, "conceded a feed that was never contested"
    assert dec.seen > 3
