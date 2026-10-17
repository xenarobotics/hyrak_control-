"""Swarm relay bridge follows the SESSION, not the socket (audit B13).

"Telemetry works, every command times out" after a resume: the uplink came
in on the new socket, the downlink went to the sid captured at creation.
"""
import asyncio
import types

import pytest

from app.telemetry import swarm_relay_bridge as srb


class _Sio:
    def __init__(self):
        self.emitted = []

    async def emit(self, event, data, to=None):
        self.emitted.append((event, data, to))


class _SessionManager:
    def __init__(self, socket_id):
        self.session = types.SimpleNamespace(socket_id=socket_id)
        self.gone = False

    def get(self, session_id):
        return None if self.gone else self.session


@pytest.fixture
def no_bridges():
    saved = dict(srb._bridges)
    srb._bridges.clear()
    yield
    for sid in list(srb._bridges):
        srb.close_bridge(sid)
    srb._bridges.update(saved)


@pytest.mark.asyncio
async def test_downlink_goes_to_the_sessions_current_socket(no_bridges):
    sio, sm = _Sio(), _SessionManager("sid-old")
    bridge = srb.SwarmRelayBridge(sio, "sess-1", sm)
    bridge._emit_downlink(1, b"\xfd")
    await asyncio.sleep(0)
    assert sio.emitted[-1][2] == "sid-old"

    sm.session.socket_id = "sid-new"           # resume_session moved it
    bridge._emit_downlink(2, b"\xfd")
    await asyncio.sleep(0)
    assert sio.emitted[-1][2] == "sid-new"
    assert sio.emitted[-1][1] == b"\x02\xfd"


@pytest.mark.asyncio
async def test_downlink_is_dropped_while_the_session_has_no_socket(no_bridges):
    sio, sm = _Sio(), _SessionManager("sid")
    bridge = srb.SwarmRelayBridge(sio, "sess-1", sm)
    sm.gone = True
    bridge._emit_downlink(1, b"x")
    await asyncio.sleep(0)
    assert sio.emitted == []


@pytest.mark.asyncio
async def test_re_registering_keeps_the_bridge_and_its_endpoints(no_bridges):
    """A re-announce (page reload, resume) used to close the endpoints the
    fleet's mavsdk_servers were bound to - a silent link kill."""
    sio, sm = _Sio(), _SessionManager("sid")
    first = srb.register_bridge("sess-1", srb.SwarmRelayBridge(sio, "sess-1", sm))
    port = await first.get_or_create_port(1)
    ep = first._drones[1]

    sio2 = _Sio()
    again = srb.register_bridge("sess-1", srb.SwarmRelayBridge(sio2, "sess-1", sm))
    assert again is first
    assert first._drones[1] is ep and not ep._transport.is_closing()
    assert await first.get_or_create_port(1) == port
    assert first._sio is sio2, "a re-announce must adopt the current server handle"
    srb.close_bridge("sess-1")
    assert srb.get_bridge("sess-1") is None


def test_legacy_socket_id_constructor_still_resolves():
    sio = _Sio()
    bridge = srb.SwarmRelayBridge(sio, "raw-sid")
    assert bridge.current_socket_id() == "raw-sid"
