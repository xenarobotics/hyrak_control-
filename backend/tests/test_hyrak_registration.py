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
