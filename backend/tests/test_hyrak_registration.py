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


def test_registration_never_breaks_the_link_it_is_helping():
    """It is UDP to an unauthenticated port on a box that may not be there.
    The feeds run regardless, so a failure here must not throw into the relay
    start path or stop telemetry from connecting."""
    rf = _read(_RF)
    assert "void startHyrakRegistration" in rf, "fire-and-forget, never awaited into the failure path"
    reg = _read(_REG)
    assert "if (!isDesktopApp()) return" in reg, "a browser tab has no socket; that is not an error"
