"""
Audit B5 / B17: who owns a session's video resources across a re-offer, and
what a malformed offer gets back.

THE BUG THIS PINS
    on_offer added a new PeerEntry without removing the previous one for the
    socket, and the browser pc's connectionstatechange handler released
    SESSION-keyed resources (the shared feed port, the relay ingest) no matter
    which pc owned them. So a re-offer (mode switch, reconnect, second Start
    click) left two entries, and when the OLD pc finished closing it released
    the port the NEW pc had just acquired: black video and a leaked port.

Negotiation here runs fully in-process: a second RTCPeerConnection plays the
browser and produces a real offer, nothing touches the network.
"""
import asyncio
from enum import Enum
from types import SimpleNamespace

import pytest
from aiortc import RTCPeerConnection
from aiortc.mediastreams import MediaStreamTrack
from av import VideoFrame

from app.webrtc import feeds, relay_video_source, signaling
from app.webrtc.peer_registry import PeerEntry, PeerRegistry


class _Mode(Enum):
    MANUAL = "manual-control"


class _Sio:
    """Records emits and exposes the handlers register_webrtc_events installs."""

    def __init__(self):
        self.handlers = {}
        self.emitted = []

    def on(self, name):
        def deco(fn):
            self.handlers[name] = fn
            return fn
        return deco

    async def emit(self, event, payload=None, to=None, room=None):
        self.emitted.append((event, payload, to))

    def events(self, name):
        return [p for e, p, _ in self.emitted if e == name]


class _Pool:
    def __init__(self):
        self.registered = []
        self.unregistered = []

    def register_session(self, session_id, mode):
        self.registered.append(session_id)

    async def unregister_session(self, session_id):
        self.unregistered.append(session_id)

    def get_for_session(self, session_id):
        return None


class _Sessions:
    def __init__(self, session):
        self.session = session

    def get_by_socket(self, sid):
        return self.session if sid == self.session.sid else None

    def get(self, session_id):
        return self.session if session_id == self.session.session_id else None

    def get_telemetry(self, session_id):
        return None


class _FakeFeedTrack(MediaStreamTrack):
    kind = "video"

    async def recv(self):
        return VideoFrame(width=32, height=24, format="bgr24")


def _session(sid="sock-1"):
    return SimpleNamespace(
        sid=sid, session_id="session-aaaaaaaa", mode=_Mode.MANUAL,
        pc_id=None, is_streaming=False, drone=None, client_ip="127.0.0.1",
    )


def _wire(session=None):
    sio = _Sio()
    registry = PeerRegistry()
    pool = _Pool()
    session = session or _session()
    signaling.register_webrtc_events(sio, registry, pool, _Sessions(session))
    return sio, registry, pool, session


async def _browser_offer():
    pc = RTCPeerConnection()
    pc.addTransceiver("video", direction="recvonly")
    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    sdp = pc.localDescription.sdp
    await pc.close()
    return {"sdp": sdp, "type": "offer"}


@pytest.fixture(autouse=True)
def staff_guard(monkeypatch):
    """These tests pin resource ownership, not access: every guard passes as
    for a staff session (access is covered in test_live_scope.py)."""
    async def allow(*a, **k):
        return True
    monkeypatch.setattr(signaling, "require_session_view", allow)
    monkeypatch.setattr(signaling, "require_staff", allow)


@pytest.fixture
def quiet_feeds(monkeypatch):
    """feeds.acquire hands out a frame-producing fake; release is recorded."""
    released = []
    acquired = []

    async def acquire(port, timeout=5.0):
        acquired.append(port)
        return _FakeFeedTrack()

    async def release(port):
        released.append(port)

    monkeypatch.setattr(feeds, "acquire", acquire)
    monkeypatch.setattr(feeds, "release", release)
    return acquired, released


# --------------------------------------------------------------------------- #
# Registry: resources are released by the entry that holds them, once          #
# --------------------------------------------------------------------------- #

async def test_remove_releases_only_what_the_entry_holds(monkeypatch):
    released, relays = [], []

    async def release(port):
        released.append(port)

    async def release_relay(session_id):
        relays.append(session_id)

    monkeypatch.setattr(feeds, "release", release)
    monkeypatch.setattr(relay_video_source, "release_async", release_relay)

    reg = PeerRegistry()
    holder = PeerEntry(pc_id="a", session_id="s", socket_id="x", pc=RTCPeerConnection(),
                       feed_port=5601, owns_relay=True)
    bystander = PeerEntry(pc_id="b", session_id="s", socket_id="y", pc=RTCPeerConnection())
    reg.add(holder)
    reg.add(bystander)

    await reg.remove("b")
    assert released == [] and relays == [], "an entry without resources released something"

    await reg.remove("a")
    assert released == [5601] and relays == ["s"]
    # Idempotent: the fields were cleared on the way out.
    assert holder.feed_port is None and holder.owns_relay is False


# --------------------------------------------------------------------------- #
# Re-offer: one entry per socket, the new pc keeps its port                    #
# --------------------------------------------------------------------------- #

async def test_reoffer_replaces_entry_and_keeps_new_feed_port(quiet_feeds):
    acquired, released = quiet_feeds
    sio, registry, pool, session = _wire()
    on_offer = sio.handlers["offer"]

    first = {**await _browser_offer(), "videoSource": "air_unit_udp", "airUnitVideoPort": 5607}
    await on_offer(session.sid, first)
    assert len(sio.events("answer")) == 1, sio.emitted
    assert registry.count == 1
    old = registry.get_by_socket(session.sid)
    assert old.feed_port == 5607

    second = {**await _browser_offer(), "videoSource": "air_unit_udp", "airUnitVideoPort": 5607}
    await on_offer(session.sid, second)
    # Let the old pc's "closed" state handler run - this is the moment that
    # used to release the new pc's port.
    await asyncio.sleep(0.05)

    assert len(sio.events("answer")) == 2
    assert registry.count == 1, "the superseded entry must be gone"
    new = registry.get_by_socket(session.sid)
    assert new is not old and new.feed_port == 5607
    assert old.pc.connectionState == "closed"
    # Exactly one release so far: the old entry's ref. The new entry still
    # holds its own, so the shared reader stays up for it.
    assert acquired == [5607, 5607]
    assert released == [5607]
    assert session.pc_id == new.pc_id
    assert session.is_streaming is True

    # The superseded pc's close must not have unregistered the live session.
    assert pool.unregistered == []

    await registry.remove(new.pc_id)
    assert released == [5607, 5607]


async def test_reoffer_hands_relay_ownership_to_the_new_pc(monkeypatch):
    """A relay-sourced pc superseded by another relay-sourced pc: the ingest
    is handed over, never released in between (the desktop is still pushing)."""
    relays = []

    async def release_relay(session_id):
        relays.append(session_id)

    monkeypatch.setattr(relay_video_source, "release_async", release_relay)
    sio, registry, pool, session = _wire()
    old = PeerEntry(pc_id="old", session_id=session.session_id, socket_id=session.sid,
                    pc=RTCPeerConnection(), owns_relay=True)
    registry.add(old)

    # The new offer names a relay source but there is no listener: it fails
    # at the "no relay allocated" check, which is AFTER the hand-over.
    data = {**await _browser_offer(), "videoSource": "rtsp_relay"}
    await sio.handlers["offer"](session.sid, data)

    assert registry.get("old") is None
    assert old.owns_relay is False
    errs = sio.events("error")
    assert errs and "relay" in errs[-1]["msg"].lower()
    # Removing the old entry during hand-over did not release the relay; the
    # failed new entry had not taken ownership yet either.
    assert relays == []


async def test_reoffer_to_a_non_relay_source_releases_the_orphaned_relay(monkeypatch):
    relays = []

    async def release_relay(session_id):
        relays.append(session_id)

    monkeypatch.setattr(relay_video_source, "release_async", release_relay)
    sio, registry, pool, session = _wire()
    old = PeerEntry(pc_id="old", session_id=session.session_id, socket_id=session.sid,
                    pc=RTCPeerConnection(), owns_relay=True)
    registry.add(old)

    data = {**await _browser_offer(), "videoSource": "camera"}
    await sio.handlers["offer"](session.sid, data)
    assert sio.events("answer"), sio.emitted
    assert relays == [session.session_id], "nothing consumes the listener now; it must be freed"


# --------------------------------------------------------------------------- #
# B17: every failure answers with an error event                               #
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("data", [
    None,
    "not a dict",
    {},
    {"sdp": "", "type": "offer"},
    {"sdp": "v=0", "type": "answer"},
    {"sdp": "v=0", "type": "offer", "iceServers": "stun:x"},
    {"sdp": "v=0", "type": "offer", "iceServers": ["stun:x"]},
    {"sdp": "v=0", "type": "offer", "iceServers": [{"urls": 5}]},
    {"sdp": "v=0", "type": "offer", "airUnitVideoPort": "five"},
])
async def test_malformed_offer_emits_error_and_registers_nothing(data):
    sio, registry, pool, session = _wire()
    await sio.handlers["offer"](session.sid, data)
    errs = sio.events("error")
    assert len(errs) == 1 and errs[0]["msg"], sio.emitted
    assert registry.count == 0
    assert pool.registered == []


async def test_unparseable_sdp_emits_error_and_cleans_up(monkeypatch):
    async def boom(self, desc):
        raise ValueError("bad sdp")

    monkeypatch.setattr(RTCPeerConnection, "setRemoteDescription", boom)
    sio, registry, pool, session = _wire()
    await sio.handlers["offer"](session.sid, {"sdp": "v=0\r\ngarbage", "type": "offer"})
    errs = sio.events("error")
    assert len(errs) == 1 and "negotiation failed" in errs[0]["msg"]
    assert registry.count == 0
    assert session.is_streaming is False
    assert pool.unregistered == [session.session_id]


async def test_source_open_failure_emits_error_with_the_cause(monkeypatch):
    async def acquire(port, timeout=5.0):
        raise RuntimeError("udp:5600 is already in use by a GStreamer viewer")

    monkeypatch.setattr(feeds, "acquire", acquire)
    sio, registry, pool, session = _wire()
    data = {**await _browser_offer(), "videoSource": "air_unit_udp"}
    await sio.handlers["offer"](session.sid, data)
    errs = sio.events("error")
    assert len(errs) == 1 and "GStreamer" in errs[0]["msg"]
    assert registry.count == 0
    assert not sio.events("answer")


async def test_superseded_pc_state_change_does_not_touch_session():
    """The old pc's late 'closed' is a no-op once a newer entry owns the id."""
    sio, registry, pool, session = _wire()
    data = {**await _browser_offer(), "videoSource": "camera"}
    await sio.handlers["offer"](session.sid, data)
    entry = registry.get_by_socket(session.sid)
    # Swap the registered entry out from under the pc, as a re-offer does.
    replacement = PeerEntry(pc_id=entry.pc_id, session_id=session.session_id,
                            socket_id=session.sid, pc=RTCPeerConnection())
    registry._peers[entry.pc_id] = replacement
    session.is_streaming = True
    await entry.pc.close()
    await asyncio.sleep(0.05)
    assert session.is_streaming is True
    assert pool.unregistered == []
    assert registry.get(entry.pc_id) is replacement
    await registry.remove(entry.pc_id)
