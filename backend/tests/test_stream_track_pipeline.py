"""
MultiModeVideoStreamTrack.recv with fakes for every collaborator.

  V7   caches are cleared on a mode change and while the analyzer is away
  V13  client-overlay mode skips the BGR conversion and the submit while
       the analyzer is still busy with this session's previous frame
  V14  the observer snapshot is encoded off the loop
  V15  velocity commands go through one latest-wins slot and one sender
"""
import asyncio
from enum import Enum
from types import SimpleNamespace

import numpy as np
import pytest
from aiortc.mediastreams import MediaStreamTrack
from av import VideoFrame

from app.sessions import observer
from app.webrtc import stream_track
from app.webrtc.stream_track import MultiModeVideoStreamTrack


class _Mode(Enum):
    MANUAL = "manual-control"
    DETECT = "object-detection"
    DEPTH = "depth-mapping"


class _Source(MediaStreamTrack):
    kind = "video"

    def __init__(self):
        super().__init__()
        self.n = 0

    async def recv(self):
        self.n += 1
        f = VideoFrame(width=64, height=48, format="bgr24")
        f.pts, f.time_base = self.n, None
        return f


class _Analyzer:
    """Returns one result per submitted frame, on the next recv."""

    def __init__(self):
        self.submitted = 0
        self.results = []
        self._inflight = set()
        self.draw_calls = 0

    def submit_frame(self, client_id, frame_bgr, telemetry=None):
        self.submitted += 1
        self.results.append((np.zeros((48, 64, 3), np.uint8), {"n": self.submitted}))

    def get_latest_result(self, client_id):
        return self.results.pop(0) if self.results else None

    def draw_overlay(self, frame_bgr, meta):
        self.draw_calls += 1
        return frame_bgr


class _Pool:
    def __init__(self, analyzer):
        self.analyzer = analyzer

    def get_for_session(self, session_id):
        return self.analyzer


class _Sessions:
    def __init__(self, mode, tel=None):
        self.session = SimpleNamespace(mode=mode, drone=None)
        self.tel = tel

    def get(self, session_id):
        return self.session

    def get_telemetry(self, session_id):
        return self.tel


class _Tel:
    def __init__(self, hold=0.0):
        self.is_connected = True
        self.snapshot = SimpleNamespace(to_dict=lambda: {"alt": 1.0})
        self.hold = hold
        self.sent = []
        self.in_flight = 0
        self.max_in_flight = 0

    async def send_velocity_command(self, **kw):
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            await asyncio.sleep(self.hold)
            self.sent.append(kw)
        finally:
            self.in_flight -= 1


def _track(sessions, pool, return_video=True, **kw):
    return MultiModeVideoStreamTrack(
        source_track=_Source(), session_id="sess-track", vision_pool=pool,
        session_manager=sessions, return_video=return_video, **kw,
    )


@pytest.fixture(autouse=True)
def no_sensing(monkeypatch):
    monkeypatch.setattr(stream_track._sensing, "wants_frame", lambda *a: False)


# --------------------------------------------------------------------------- #
# V7                                                                           #
# --------------------------------------------------------------------------- #

async def test_caches_cleared_on_mode_change_and_while_analyzer_is_away():
    analyzer = _Analyzer()
    pool = _Pool(analyzer)
    sessions = _Sessions(_Mode.DETECT)
    t = _track(sessions, pool)
    try:
        await t.recv()                     # submit
        await t.recv()                     # result lands in the caches
        assert "object-detection" in t._frame_cache and "object-detection" in t._meta_cache

        sessions.session.mode = _Mode.DEPTH
        await t.recv()
        assert "object-detection" not in t._frame_cache
        assert "object-detection" not in t._meta_cache

        await t.recv()
        assert "depth-mapping" in t._frame_cache
        pool.analyzer = None               # model reloading
        await t.recv()
        assert not t._frame_cache and not t._meta_cache
    finally:
        t.stop()


# --------------------------------------------------------------------------- #
# V13                                                                          #
# --------------------------------------------------------------------------- #

async def test_overlay_mode_skips_convert_and_submit_while_busy(monkeypatch):
    analyzer = _Analyzer()
    analyzer._inflight.add("sess-track")
    sessions = _Sessions(_Mode.DETECT)
    t = _track(sessions, _Pool(analyzer), return_video=False)
    conversions = []

    class _CountingExecutor:
        """av.VideoFrame is an immutable type, so count the executor jobs:
        in this mode the only pixel job recv submits is the conversion."""

        def __init__(self, inner):
            self.inner = inner

        def submit(self, fn, *a, **kw):
            conversions.append(1)
            return self.inner.submit(fn, *a, **kw)

        def shutdown(self, *a, **kw):
            return self.inner.shutdown(*a, **kw)

    t._px_executor = _CountingExecutor(t._px_executor)
    try:
        for _ in range(3):
            await t.recv()
        assert analyzer.submitted == 0 and conversions == []

        analyzer._inflight.clear()
        await t.recv()
        assert analyzer.submitted == 1 and len(conversions) == 1
    finally:
        t.stop()


async def test_processed_stream_always_converts_even_when_busy():
    analyzer = _Analyzer()
    analyzer._inflight.add("sess-track")
    t = _track(_Sessions(_Mode.DETECT), _Pool(analyzer), return_video=True)
    try:
        out = await t.recv()
        assert analyzer.submitted == 1
        assert out.width == 64
    finally:
        t.stop()


async def test_overlay_result_payload_carries_frame_size_without_conversion():
    analyzer = _Analyzer()
    payloads = []

    async def emit(p):
        payloads.append(p)

    sessions = _Sessions(_Mode.DETECT)
    t = _track(sessions, _Pool(analyzer), return_video=False, emit_callback=emit)
    try:
        await t.recv()                     # submits, result queued
        analyzer._inflight.add("sess-track")
        await t.recv()                     # busy: no convert, but the result is emitted
        await asyncio.sleep(0.01)
        assert payloads and payloads[-1]["frame_w"] == 64 and payloads[-1]["frame_h"] == 48
    finally:
        t.stop()


# --------------------------------------------------------------------------- #
# V14                                                                          #
# --------------------------------------------------------------------------- #

async def test_snapshot_encodes_off_the_loop(monkeypatch):
    monkeypatch.setattr(observer, "has_watchers", lambda sid: True)
    snaps = []

    async def snap(session_id, jpeg):
        snaps.append(jpeg)

    t = _track(_Sessions(_Mode.MANUAL), _Pool(None), snapshot_callback=snap)
    ran_on = []
    real = t._encode_snapshot

    def spy(img, frame):
        import threading
        ran_on.append(threading.current_thread().name)
        return real(img, frame)

    t._encode_snapshot = spy
    try:
        await t.recv()
        await asyncio.sleep(0.1)
        assert snaps and snaps[0][:2] == b"\xff\xd8", "a JPEG reached the observer"
        assert ran_on and "MainThread" not in ran_on[0]
    finally:
        t.stop()


# --------------------------------------------------------------------------- #
# V15                                                                          #
# --------------------------------------------------------------------------- #

async def test_velocity_commands_never_pile_up():
    tel = _Tel(hold=0.05)
    analyzer = _Analyzer()
    t = _track(_Sessions(_Mode.DETECT, tel), _Pool(analyzer))
    try:
        # Six results before the sender gets a turn: one send, the latest.
        for i in range(6):
            t._queue_velocity(tel, dict(forward_m_s=float(i), right_m_s=0.0,
                                        down_m_s=0.0, yaw_deg_s=0.0))
        await asyncio.sleep(0.01)
        assert tel.in_flight == 1
        # More arrive while that one is still in flight: they collapse too.
        for i in range(6, 9):
            t._queue_velocity(tel, dict(forward_m_s=float(i), right_m_s=0.0,
                                        down_m_s=0.0, yaw_deg_s=0.0))
        await asyncio.sleep(0.25)
        assert tel.max_in_flight == 1
        assert [s["forward_m_s"] for s in tel.sent] == [5.0, 8.0]
    finally:
        t.stop()
        await asyncio.sleep(0)
        assert t._vel_task.cancelled() or t._vel_task.done()


async def test_stalled_send_is_dropped_not_queued(monkeypatch):
    monkeypatch.setattr(MultiModeVideoStreamTrack, "_VEL_SEND_TIMEOUT_S", 0.05)
    tel = _Tel(hold=10.0)
    t = _track(_Sessions(_Mode.DETECT, tel), _Pool(_Analyzer()))
    try:
        t._queue_velocity(tel, dict(forward_m_s=1.0, right_m_s=0.0, down_m_s=0.0, yaw_deg_s=0.0))
        await asyncio.sleep(0.1)
        assert tel.in_flight == 0, "the stalled call was cancelled by the timeout"
        t._queue_velocity(tel, dict(forward_m_s=2.0, right_m_s=0.0, down_m_s=0.0, yaw_deg_s=0.0))
        await asyncio.sleep(0.02)
        assert tel.max_in_flight == 1
    finally:
        t.stop()


async def test_result_with_drone_command_uses_the_slot(monkeypatch):
    from app.avoidance.core import loop as av_loop
    monkeypatch.setattr(av_loop, "guard_follow", lambda sid, f, r: (f, r))
    tel = _Tel()
    analyzer = _Analyzer()
    analyzer.submit_frame = lambda cid, fr, telemetry=None: analyzer.results.append(
        (np.zeros((48, 64, 3), np.uint8),
         {"drone_command": {"type": "velocity", "forward_m_s": 1.5}}))
    t = _track(_Sessions(_Mode.DETECT, tel), _Pool(analyzer))
    try:
        await t.recv()
        await t.recv()
        await asyncio.sleep(0.02)
        assert tel.sent and tel.sent[-1]["forward_m_s"] == 1.5
    finally:
        t.stop()
