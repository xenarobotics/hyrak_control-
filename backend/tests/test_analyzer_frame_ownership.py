"""
Who owns a submitted frame's pixels.

THE BUG THIS PINS
    stream_track.recv() hands one `img_bgr` to submit_frame() and then, later in
    the same call, passes THAT SAME ARRAY to draw_overlay(). Every cv2 drawing
    call mutates its target in place, so while submit_frame stored the array by
    reference the analyzer's frame sprouted brackets and labels underneath it —
    racing against its own worker thread.

    Two visible consequences, both reported from the field:

      * saved evidence crops had the overlay baked in: a plate crop wearing a
        green bracket, a vehicle shot wearing its own "VH-000001 blue car" label
      * detection, colour classification and OCR ran on a frame carrying the
        PREVIOUS inference's graphics, so each module was partly reading its own
        output back in

    The second is the worse one and was entirely invisible — nothing errors, the
    numbers just quietly describe a frame nobody ever captured.
"""
from typing import Any, Dict, Tuple

import numpy as np
import pytest

from app.vision.base import BaseAnalyzer
from app.vision.modules.__registry__ import ANALYZER_REGISTRY


class _Spy(BaseAnalyzer):
    MODE = "object-detection"

    def _analyze_frame_blocking(self, frame_bgr) -> Tuple[np.ndarray, Dict[str, Any]]:
        return frame_bgr, {}


def _spy() -> _Spy:
    import asyncio
    a = _Spy.__new__(_Spy)
    a._clients = {"c": {"latest_frame": None, "latest_context": None,
                        "lock": asyncio.Lock()}}
    # Pre-marked in-flight so submit_frame stores the frame WITHOUT kicking off
    # _process_loop, which would immediately consume it (and need a real
    # executor). What is under test is the store, not the processing.
    a._inflight = {"c"}
    a._contexts = {}
    a._frame_counters = {}
    return a


async def _submit_and_settle(a, client_id, frame):
    """submit_frame stores via asyncio.create_task, so the store has not
    happened when it returns. Yielding is what makes it observable — without
    this the assertions run against a still-None frame and pass vacuously,
    which is how the first version of this test 'passed' while checking
    nothing."""
    import asyncio
    a.submit_frame(client_id, frame)
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    stored = a._clients[client_id]["latest_frame"]
    assert stored is not None, "frame never reached the analyzer — test is vacuous"
    return stored


async def test_submitted_frame_is_not_the_callers_array():
    """The whole fix in one assertion: the analyzer must hold its own pixels, so
    a caller that keeps drawing on its array cannot reach them."""
    a = _spy()
    caller_frame = np.zeros((64, 64, 3), np.uint8)
    stored = await _submit_and_settle(a, "c", caller_frame)

    caller_frame[:] = 255
    assert stored is not caller_frame
    assert stored.sum() == 0, "the caller's mutation reached the analyzer"


@pytest.mark.parametrize("mode,cls", list(ANALYZER_REGISTRY.items()),
                         ids=lambda x: getattr(x, "value", None) or getattr(x, "__name__", str(x)))
def test_draw_overlay_output_never_feeds_analysis(mode, cls):
    """
    Every overlay module draws in place — that is fine and cheap, and the point
    of this test is not to forbid it but to prove the analyzer cannot be reached
    by it.

    Checked structurally: submit_frame must copy. If that copy is ever removed,
    the in-place drawing every module does becomes a silent corruption of the
    next inference, which is exactly how this shipped once already.
    """
    import inspect
    src = inspect.getsource(BaseAnalyzer.submit_frame)
    assert "frame_bgr.copy()" in src, (
        "submit_frame no longer copies — draw_overlay's in-place drawing will "
        "corrupt the frame the worker thread is analysing"
    )


async def test_a_module_drawing_overlay_cannot_dirty_a_submitted_frame():
    """End-to-end version of the same thing, through a real module's overlay."""
    from app.vision.modules.plate_tracker import PlateTracker

    pt = PlateTracker.__new__(PlateTracker)
    a = _spy()

    camera_frame = np.zeros((720, 1280, 3), np.uint8)
    stored = await _submit_and_settle(a, "c", camera_frame)

    # stream_track then draws this inference's results onto the CAMERA frame.
    pt.draw_overlay(camera_frame, {
        "vehicles": [{
            "track_id": 1, "vehicle_id": "VH-000001", "box": [100, 100, 600, 500],
            "type": "car", "color": "blue", "color_conf": 0.9,
            "plate": "719257C", "plate_box": [300, 400, 380, 440],
            "plate_strong": True, "speed_kmh": 48.0, "speed_reliable": True,
            "locked": True,
        }],
        "tracking": True,
    })
    assert camera_frame.sum() > 0, "overlay drew nothing — test proves nothing"
    assert stored.sum() == 0, (
        "overlay graphics leaked into the frame being analysed — saved crops "
        "would carry brackets and labels, and OCR would read them back"
    )
