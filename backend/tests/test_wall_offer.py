"""
Audit B28: bad wall_offer input answers with wall_error, and a wall that is
replaced while still acquiring its feeds gives those feeds back.
"""
import asyncio

import pytest
from aiortc.mediastreams import MediaStreamTrack
from av import VideoFrame

from app.webrtc import feeds, wall


class _Sio:
    def __init__(self):
        self.handlers, self.emitted = {}, []

    def on(self, name):
        def deco(fn):
            self.handlers[name] = fn
            return fn
        return deco

    async def emit(self, event, payload=None, to=None):
        self.emitted.append((event, payload))

    def events(self, name):
        return [p for e, p in self.emitted if e == name]


class _Track(MediaStreamTrack):
    kind = "video"

    async def recv(self):
        return VideoFrame(width=16, height=16, format="bgr24")


@pytest.fixture
def sio(monkeypatch):
    # Staff-only since phase 2a; these tests pin input handling and feed
    # ownership, so the guard passes (access is covered in test_live_scope.py).
    from app.auth import socket_guard

    async def allow(*a, **k):
        return True
    monkeypatch.setattr(socket_guard, "require_staff", allow)
    s = _Sio()
    wall.register(s)
    yield s
    wall._walls.clear()


@pytest.mark.parametrize("data", [
    None,
    "nope",
    {"sdp": "v=0", "type": "offer", "ports": ["abc"]},
    {"sdp": "v=0", "type": "offer", "ports": "5600"},
    {"sdp": "v=0", "type": "offer", "ports": [5600], "iceServers": ["stun:x"]},
    {"sdp": "v=0", "type": "offer", "ports": [70000]},
    {"type": "offer", "ports": [5600]},
])
async def test_bad_input_answers_wall_error(sio, data):
    await sio.handlers["wall_offer"]("sid-1", data)
    errs = sio.events("wall_error")
    assert len(errs) == 1 and errs[0]["error"]
    assert "sid-1" not in wall._walls


async def test_wall_replaced_mid_acquire_releases_its_feed(sio, monkeypatch):
    gate = asyncio.Event()
    released = []

    async def acquire(port, timeout=3.0):
        await gate.wait()
        return _Track()

    async def release(port):
        released.append(port)

    monkeypatch.setattr(feeds, "acquire", acquire)
    monkeypatch.setattr(feeds, "release", release)

    task = asyncio.create_task(sio.handlers["wall_offer"](
        "sid-2", {"sdp": "v=0", "type": "offer", "ports": [5601, 5602]}))
    await asyncio.sleep(0.02)
    # Registered before any feed was acquired, so a disconnect can find it.
    assert "sid-2" in wall._walls
    first_pc = wall._walls["sid-2"][0]

    await wall.close_for_sid("sid-2")          # what disconnect does
    gate.set()
    await task

    assert released == [5601], "the feed acquired after replacement must be given back"
    assert "sid-2" not in wall._walls
    assert first_pc.connectionState == "closed"
    assert not sio.events("wall_answer")


async def test_ports_capped_and_coerced():
    assert wall._parse_ports(["5600", 5601.0]) == [5600, 5601]
    assert len(wall._parse_ports(list(range(5600, 5640)))) == wall.MAX_WALL_FEEDS
    with pytest.raises(ValueError):
        wall._parse_ports([True])
