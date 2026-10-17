"""
relay_video_source: the free-port probe must see a port another socket
holds (SO_REUSEADDR hid it), and the ingest table is guarded by a lock.
udp_video_source: the SDP temp file is removed once ffmpeg has read it,
whether the open succeeded or not.
"""
import glob
import os
import socket
import tempfile
import threading

import pytest

from app.webrtc import relay_video_source as rvs
from app.webrtc import udp_video_source as uvs


def test_free_port_skips_a_port_someone_else_holds():
    base, limit = 47400, 47410
    holder = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        holder.bind(("0.0.0.0", base))
        assert rvs._free_port(base, limit, "udp") == base + 1
    finally:
        holder.close()


def test_free_port_exhausted():
    holders = []
    base, limit = 47420, 47423
    try:
        for p in range(base, limit):
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.bind(("0.0.0.0", p))
            holders.append(s)
        with pytest.raises(RuntimeError):
            rvs._free_port(base, limit, "tcp")
    finally:
        for s in holders:
            s.close()


def test_ingest_table_has_a_thread_lock():
    assert isinstance(rvs._ingests_lock, type(threading.Lock()))
    assert rvs.get("no-such-session") is None
    rvs.release("no-such-session")       # no-op, must not raise


def _sdp_files():
    return glob.glob(os.path.join(tempfile.gettempdir(), "hyrak_air_unit_*.sdp"))


def test_sdp_file_removed_after_failed_open(monkeypatch):
    before = set(_sdp_files())

    def boom(path, port, timeout, max_delay_us):
        assert os.path.exists(path), "ffmpeg must still be able to read it during open"
        raise RuntimeError("no stream")

    monkeypatch.setattr(uvs, "_open_player", boom)
    with pytest.raises(RuntimeError):
        uvs.open_air_unit_video(port=5699, timeout=0.1)
    assert set(_sdp_files()) == before


def test_sdp_file_removed_after_successful_open(monkeypatch):
    before = set(_sdp_files())

    class _Player:
        video = object()

    seen = {}

    def ok(path, port, timeout, max_delay_us):
        seen["content"] = open(path).read()
        return _Player()

    monkeypatch.setattr(uvs, "_open_player", ok)
    assert uvs.open_air_unit_video(port=5698, timeout=0.1) is _Player.video
    assert "m=video 5698 RTP/AVP 96" in seen["content"]
    assert set(_sdp_files()) == before


def test_sdp_carries_parameter_sets():
    path = uvs._sdp_file(5600, {33: b"\x00\x00\x00\x01\x42\x01", 34: b"\x00\x00\x01\x44\x01"})
    try:
        text = open(path).read()
        assert "sprop-sps=QgE=" in text and "sprop-pps=RAE=" in text
    finally:
        uvs._remove_sdp(path)
    assert not os.path.exists(path)


# --------------------------------------------------------------------------- #
# The ingest lock guards the dict only: ffmpeg spawn and teardown run outside  #
# it, so a slow allocate never stalls get() on the event loop.                 #
# --------------------------------------------------------------------------- #

class _FakeIngest:
    """Stands in for RelayIngest: records whether the module lock was held
    while the blocking calls ran, and can hold start() open on demand."""
    gate = None            # threading.Event: start() waits on it when set
    started_locked = []
    closed_locked = []

    def __init__(self, session_id, transport="srt", latency_ms=0):
        self.session_id, self.transport = session_id, transport
        self.public_port = 3478
        self.proc = None
        self.closed = False

    def start(self):
        _FakeIngest.started_locked.append(rvs._ingests_lock.locked())
        if _FakeIngest.gate is not None:
            _FakeIngest.gate.wait(5.0)
        self.proc = type("P", (), {"poll": staticmethod(lambda: None)})()

    def close(self):
        _FakeIngest.closed_locked.append(rvs._ingests_lock.locked())
        self.closed = True
        self.proc = type("P", (), {"poll": staticmethod(lambda: 0)})()


@pytest.fixture
def fake_ingests(monkeypatch):
    monkeypatch.setattr(rvs, "RelayIngest", _FakeIngest)
    monkeypatch.setattr(rvs, "_ingests", {})
    _FakeIngest.gate = None
    _FakeIngest.started_locked.clear()
    _FakeIngest.closed_locked.clear()
    yield


def test_allocate_blocks_outside_the_lock_and_get_never_waits(fake_ingests):
    _FakeIngest.gate = threading.Event()
    worker = threading.Thread(target=rvs.allocate, args=("slow-session",), daemon=True)
    worker.start()
    # allocate is now parked inside start(); the lock must be free.
    for _ in range(50):
        if _FakeIngest.started_locked:
            break
        threading.Event().wait(0.01)
    assert _FakeIngest.started_locked == [False]
    assert rvs._ingests_lock.acquire(timeout=0.2), "lock held across ffmpeg spawn"
    rvs._ingests_lock.release()
    assert rvs.get("other-session") is None          # does not block
    _FakeIngest.gate.set()
    worker.join(2.0)
    assert rvs.get("slow-session") is not None


def test_dead_ingest_is_closed_outside_the_lock_and_replaced(fake_ingests):
    first = rvs.allocate("s1", transport="srt")
    first.close()                                    # ffmpeg died
    _FakeIngest.closed_locked.clear()
    second = rvs.allocate("s1", transport="srt")
    assert second is not first and rvs.get("s1") is second
    assert _FakeIngest.closed_locked == [False]
    assert rvs.allocate("s1", transport="srt") is second, "live ingest is reused"
    rvs.release("s1")
    assert rvs.get("s1") is None and second.closed


def test_concurrent_allocates_for_one_session_keep_a_single_ingest(fake_ingests):
    _FakeIngest.gate = threading.Event()
    results = []
    threads = [threading.Thread(target=lambda: results.append(rvs.allocate("race")), daemon=True)
               for _ in range(2)]
    for t in threads:
        t.start()
    threading.Event().wait(0.05)
    _FakeIngest.gate.set()
    for t in threads:
        t.join(2.0)
    assert len(results) == 2 and results[0] is results[1]
    assert rvs.get("race") is results[0] and not results[0].closed
    assert len(rvs._ingests) == 1
