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
