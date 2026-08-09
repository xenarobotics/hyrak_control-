"""
The uplink host must never be a literal again.

THREE TIMES, THE SAME BUG, IN THREE LANGUAGES. RFBridge (backend),
telemetry_relay.py (the laptop agent) and nativeRfRelay.ts (the desktop
relay) each hardcoded 127.0.0.1 as the uplink target while making the PORT
configurable. Each was written when wfb_tx ran on the same machine as the
code. Each broke silently the moment the RF decoder moved onto its own board.

WHY IT KEPT RECURRING is that the failure is invisible by construction:

  * downlink is a BIND. It hears whoever sends and needs no address at all,
    so it keeps working perfectly throughout.
  * uplink is a SEND. A wrong host means every datagram leaves for an address
    with nothing on it. UDP reports nothing back — not to the sender, not to
    any counter anywhere. Every byte counter in the chain, including the one
    added to the server for exactly this investigation, truthfully reports
    the commands as SENT.

Measured on the live rig: 3910 bytes in 106 packets left the server and 17737
came back, while not one command was ever acknowledged. wfb_tx was listening
on the decoder at 192.168.50.12:14551, bound 0.0.0.0 and provably working — a
peer session drove 20 frames into it and got 1160 PARAM_VALUE replies from
the aircraft. Nothing was listening on 127.0.0.1:14551.

These tests read source. That is deliberate: what regressed was a literal in
one call, and the frontend has no test runner of its own (CI builds desktop
releases only), so this suite is the only thing that will catch a fourth.
"""
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_RELAY_TS = _ROOT / "frontend" / "src" / "lib" / "nativeRfRelay.ts"
_RF_BRIDGE_TS = _ROOT / "frontend" / "src" / "lib" / "rfBridge.ts"
_AGENT_PY = _ROOT / "air_unit_relay" / "telemetry_relay.py"


def _read(p: Path) -> str:
    if not p.exists():
        pytest.skip(f"{p} not present in this checkout")
    return p.read_text()


# --------------------------------------------------------------------------- #
# The desktop relay — the one that was actually broken on the rig              #
# --------------------------------------------------------------------------- #

def test_the_desktop_rf_relay_does_not_hardcode_its_uplink_target():
    src = _read(_RELAY_TS)
    assert "getRfUplinkHost" in src, "the setting exists; this relay must read it"
    assert "remoteHost: uplinkHost" in src
    for literal in ("remoteHost: '127.0.0.1'", 'remoteHost: "127.0.0.1"'):
        assert literal not in src, "a literal uplink host is the bug itself"


def test_the_uplink_host_setting_does_not_default_to_loopback():
    """Loopback is correct only while the decoder is on this machine. As a
    DEFAULT it is what turned 'commands do not work' into an evening spent
    checking a radio that was fine the whole time."""
    src = _read(_RF_BRIDGE_TS)
    assert "DEFAULT_RF_UPLINK_HOST" in src
    line = next(ln for ln in src.splitlines() if "DEFAULT_RF_UPLINK_HOST =" in ln)
    assert "127.0.0.1" not in line and "localhost" not in line


# --------------------------------------------------------------------------- #
# The laptop agent                                                              #
# --------------------------------------------------------------------------- #

def test_the_relay_agent_takes_an_uplink_host_flag():
    src = _read(_AGENT_PY)
    assert "--uplink-host" in src
    assert "uplink_sock.sendto(bytes(message), uplink_addr)" in src, (
        "the send must use the configured address, not a literal"
    )


def test_the_relay_agent_reports_both_directions():
    """One number cannot show this failure: telemetry pouring in says nothing
    about whether commands are leaving. Printed side by side, a dead uplink is
    obvious at a glance."""
    src = _read(_AGENT_PY)
    assert 'counts["up"]' in src and 'counts["down"]' in src


# --------------------------------------------------------------------------- #
# The server bridge — fixed first, and it must stay fixed                       #
# --------------------------------------------------------------------------- #

def test_the_server_rf_bridge_resolves_its_uplink_host_from_settings():
    from app.config import get_settings
    import inspect
    from app.telemetry import rf_bridge

    src = inspect.getsource(rf_bridge)
    assert 'self._transport.sendto(data, self.uplink_addr)' in src
    assert get_settings().rf_uplink_host not in ("127.0.0.1", "localhost")


def test_every_uplink_path_is_configurable():
    """The point of the whole exercise. Three components, three languages,
    one rule: the port was always a setting and the host never was, and the
    host is the half that moved."""
    assert "--uplink-host" in _read(_AGENT_PY)
    assert "getRfUplinkHost" in _read(_RELAY_TS)
    from app.config import Settings
    assert "rf_uplink_host" in Settings.model_fields
