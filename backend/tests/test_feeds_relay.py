"""
Audit B21 and the re-acquire race in feeds.py.

  * DecodedTrack.recv raises MediaStreamError once stopped - the one error
    aiortc's MediaRelay and RTCRtpSender unwind on. A bare Exception escaped
    the relay's serve loop and left consumers hanging.
  * subscribe_decoded asks the relay for an unbuffered proxy: the default
    gives every wall tile an unbounded queue.
  * A reader that was just stopped is joined before the port is re-opened,
    so a restarted view never sees its own predecessor as "in use".
"""
import asyncio

import pytest
from aiortc.contrib.media import MediaRelay
from aiortc.mediastreams import MediaStreamError

from app.webrtc import feeds


async def test_decoded_track_ends_with_media_stream_error():
    t = feeds.DecodedTrack(asyncio.get_running_loop())
    waiter = asyncio.create_task(t.recv())
    await asyncio.sleep(0.01)
    assert not waiter.done()
    t.stop()                       # must wake the parked recv
    with pytest.raises(MediaStreamError):
        await asyncio.wait_for(waiter, 1.0)
    with pytest.raises(MediaStreamError):
        await t.recv()


async def test_decoded_track_delivers_pushed_frame():
    t = feeds.DecodedTrack(asyncio.get_running_loop())
    t.push("frame-1")
    assert await asyncio.wait_for(t.recv(), 1.0) == "frame-1"


async def test_subscribe_decoded_is_unbuffered(monkeypatch):
    r = feeds.SharedReader.__new__(feeds.SharedReader)   # no reader thread
    r.track = feeds.DecodedTrack(asyncio.get_running_loop())
    r.relay = MediaRelay()
    seen = {}

    def subscribe(self, track, buffered=True):
        seen["buffered"] = buffered
        return "proxy"

    monkeypatch.setattr(MediaRelay, "subscribe", subscribe)
    assert r.subscribe_decoded() == "proxy"
    assert seen["buffered"] is False


class _Reader:
    def __init__(self):
        self.refs = 0
        self.raw_refs = 0
        self.transcoders = {}
        self.stopped = False
        self.joined = None

    @property
    def idle(self):
        return True

    def stop(self):
        self.stopped = True

    def join(self, timeout):
        self.joined = timeout


async def test_reacquire_joins_the_stopped_reader(monkeypatch):
    port = 56999
    old = _Reader()
    monkeypatch.setattr(feeds, "_feeds", {port: old})
    monkeypatch.setattr(feeds, "_stopping", {})
    feeds._maybe_stop(port)
    assert old.stopped and feeds._stopping[port] is old and port not in feeds._feeds

    started = []

    class _New(_Reader):
        def __init__(self, p, loop):
            super().__init__()
            started.append(p)

    monkeypatch.setattr(feeds, "SharedReader", _New)
    r = await feeds._get_or_start(port)
    assert isinstance(r, _New) and started == [port]
    assert old.joined is not None, "the previous reader's thread must be joined first"
    assert port not in feeds._stopping
