"""
Frame context plumbing.

The bug this guards against does not crash: it pairs one frame's pixels with
a different frame's telemetry. That produces a plausible number that is
wrong, and it gets worse the more loaded the machine is — so it needs a test
rather than an inspection.
"""
import asyncio
import time
from typing import Any, Dict, Tuple

import numpy as np
import pytest

from app.vision.base import BaseAnalyzer, FrameContext
from app.vision.geometry import pose_from_telemetry
from app.telemetry.schemas import TelemetrySnapshot


class _Probe(BaseAnalyzer):
    """Records the context visible from inside the blocking analyse call."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.seen: list[tuple[int, float, Dict[str, Any] | None]] = []
        self.client_id = "sess-a"
        self.hold = 0.0

    def _analyze_frame_blocking(self, frame_bgr) -> Tuple[np.ndarray, Dict[str, Any]]:
        ctx = self.frame_context(self.client_id)
        if self.hold:
            time.sleep(self.hold)
        self.seen.append((
            ctx.frame_index if ctx else -1,
            float(frame_bgr[0, 0, 0]),          # frame's identifying value
            ctx.telemetry if ctx else None,
        ))
        return frame_bgr, {}


def _frame(marker: int) -> np.ndarray:
    return np.full((16, 16, 3), marker, dtype=np.uint8)


def _telemetry(alt: float, pitch: float = 0.0) -> Dict[str, Any]:
    snap = TelemetrySnapshot()
    snap.position.relative_altitude_m = alt
    snap.attitude.pitch_deg = pitch
    return snap.to_dict()


async def _drain(probe: _Probe, expected: int, timeout: float = 3.0):
    deadline = time.monotonic() + timeout
    while len(probe.seen) < expected and time.monotonic() < deadline:
        await asyncio.sleep(0.01)


# --------------------------------------------------------------------------- #

async def test_telemetry_reaches_the_blocking_call():
    probe = _Probe()
    probe.register_client("sess-a")
    probe.submit_frame("sess-a", _frame(7), telemetry=_telemetry(50.0))
    await _drain(probe, 1)

    idx, marker, tel = probe.seen[0]
    assert idx == 1
    assert marker == 7
    assert tel["position"]["relative_altitude_m"] == 50.0
    await probe.unregister_client("sess-a")


async def test_missing_telemetry_is_none_not_a_default():
    """No telemetry connected must yield None, so metric outputs are omitted
    rather than computed from a made-up altitude."""
    probe = _Probe()
    probe.register_client("sess-a")
    probe.submit_frame("sess-a", _frame(1))
    await _drain(probe, 1)

    assert probe.seen[0][2] is None
    assert pose_from_telemetry(None) is None
    await probe.unregister_client("sess-a")


async def test_context_stays_married_to_its_frame_when_frames_drop():
    """The core invariant. Analysis is slowed so submissions pile up and get
    dropped; every context a module sees must still describe the frame it was
    handed, never a newer one."""
    probe = _Probe()
    probe.hold = 0.05
    probe.register_client("sess-a")

    # Altitude is set equal to the frame marker, so a mismatch is detectable.
    for marker in range(1, 9):
        probe.submit_frame("sess-a", _frame(marker), telemetry=_telemetry(float(marker)))
        await asyncio.sleep(0.005)
    await _drain(probe, 2)
    await asyncio.sleep(0.2)

    assert len(probe.seen) < 8, "expected frames to be dropped under load"
    for idx, marker, tel in probe.seen:
        assert tel["position"]["relative_altitude_m"] == marker, (
            f"frame {marker} was analysed with altitude "
            f"{tel['position']['relative_altitude_m']} — context desynchronised"
        )
    await probe.unregister_client("sess-a")


async def test_frame_index_increments_across_drops():
    """Indices must count SUBMISSIONS, not analyses, so a module can tell how
    many frames it never saw."""
    probe = _Probe()
    probe.hold = 0.04
    probe.register_client("sess-a")
    for marker in range(1, 7):
        probe.submit_frame("sess-a", _frame(marker), telemetry=_telemetry(10.0))
        await asyncio.sleep(0.005)
    await _drain(probe, 2)
    await asyncio.sleep(0.2)

    indices = [idx for idx, _, _ in probe.seen]
    assert indices == sorted(indices)
    assert indices[-1] > len(indices), "index should outrun the analysed count"
    await probe.unregister_client("sess-a")


async def test_unregister_clears_context():
    probe = _Probe()
    probe.register_client("sess-a")
    probe.submit_frame("sess-a", _frame(3), telemetry=_telemetry(20.0))
    await _drain(probe, 1)
    await probe.unregister_client("sess-a")
    assert probe.frame_context("sess-a") is None


# --------------------------------------------------------------------------- #
# dt — the reason nominal fps cannot be assumed                                 #
# --------------------------------------------------------------------------- #

def test_dt_since_uses_monotonic_gaps():
    a = FrameContext(captured_at=100.0)
    b = FrameContext(captured_at=100.05)
    assert b.dt_since(a) == pytest.approx(0.05)
    assert a.dt_since(None) is None
    # Identical or backwards timestamps are not a usable time base and must
    # not come back as zero, which would divide by zero downstream.
    assert a.dt_since(a) is None
    assert a.dt_since(b) is None


async def test_capture_age_is_reported_separately_from_analysis_time():
    """analysis_time_ms excludes the queue wait; capture_age_ms includes it.
    Only the second one describes how stale the overlay actually is."""
    probe = _Probe()
    probe.hold = 0.06
    probe.register_client("sess-a")
    probe.submit_frame("sess-a", _frame(1), telemetry=_telemetry(30.0))
    await _drain(probe, 1)

    result = probe.get_latest_result("sess-a")
    assert result is not None
    _, meta = result
    assert meta["frame_index"] == 1
    assert meta["capture_age_ms"] >= meta["analysis_time_ms"]
    await probe.unregister_client("sess-a")


# --------------------------------------------------------------------------- #
# The handoff into geometry                                                     #
# --------------------------------------------------------------------------- #

def test_pose_from_real_telemetry_dict():
    pose = pose_from_telemetry(_telemetry(50.0, pitch=5.0))
    assert pose is not None
    assert pose.agl_m == pytest.approx(50.0)
    assert pose.pitch_deg == pytest.approx(5.0)


def test_grounded_drone_yields_no_pose():
    """On the ground there is no ground plane below the camera to project
    onto, and every metric reading must be withheld."""
    assert pose_from_telemetry(_telemetry(0.0)) is None
    assert pose_from_telemetry({}) is None
