"""
Per-mode inference width.

The bug this replaces was silent in a specific way: config.py declared
inference_resize_width, but only object_detector.py read it while three other
modules hardcoded 640. Changing the setting appeared to work and did nothing,
which capped crowd counting at roughly 30 m altitude.

The second half of the fix is imgsz. Ultralytics letterboxes to imgsz
(default 640) internally, so pre-resizing to 1280 without also passing
imgsz=1280 hands the model a big frame and has it shrink it straight back.
That one is asserted against the real call sites, because a comment cannot
enforce it.
"""
import re
from pathlib import Path
from typing import Any, Dict, Tuple

import numpy as np
import pytest

from app.config import Settings
from app.vision.base import BaseAnalyzer
from app.vision.modules.__registry__ import ANALYZER_REGISTRY

MODULES = Path(__file__).resolve().parents[1] / "app" / "vision" / "modules"


class _Sized(BaseAnalyzer):
    MODE = "crowd-management"

    def _analyze_frame_blocking(self, frame_bgr) -> Tuple[np.ndarray, Dict[str, Any]]:
        return frame_bgr, {}


# --------------------------------------------------------------------------- #
# Resolution lookup                                                             #
# --------------------------------------------------------------------------- #

def test_crowd_gets_more_pixels_than_the_close_range_trackers():
    """The whole point of per-mode: small people at altitude need resolution,
    a tracker following one large nearby subject does not and should not pay
    2.8x the inference cost for it."""
    s = Settings()
    assert s.inference_width_for("crowd-management") == 1280
    assert s.inference_width_for("human-tracking") == 640
    assert s.inference_width_for("person-tracking") == 640


def test_plate_tracking_runs_at_native_resolution():
    """0 = no downscale, and it is the one mode that genuinely needs it.
    Measured on real footage from this rig, plates arrive 31-79px wide —
    already at the edge of readable — and downscaling the detection pass
    shrinks the vehicle boxes the OCR crops are taken from as well, so it
    costs plate pixels twice over."""
    assert Settings().inference_width_for("vehicle-plate-tracking") == 0


def test_unknown_and_blank_modes_fall_back_rather_than_raise():
    s = Settings()
    assert s.inference_width_for("no-such-mode") == s.inference_resize_width
    assert s.inference_width_for("") == s.inference_resize_width


def test_every_registered_analyzer_declares_its_mode():
    """A blank MODE silently collapses to the global default, so the module
    would look configured while ignoring its own entry."""
    for mode, cls in ANALYZER_REGISTRY.items():
        assert cls.MODE, f"{cls.__name__} has no MODE"
        assert cls.MODE == mode.value, (
            f"{cls.__name__}.MODE is {cls.MODE!r} but it is registered "
            f"under {mode.value!r} — the width lookup would miss"
        )


# --------------------------------------------------------------------------- #
# The resize contract                                                           #
# --------------------------------------------------------------------------- #

def test_scales_map_detections_back_to_full_frame():
    a = _Sized()
    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    small, sx, sy = a.resize_for_inference(frame)

    assert small.shape[1] == 1280
    assert small.shape[0] == 720          # aspect preserved
    assert sx == pytest.approx(1920 / 1280)
    assert sy == pytest.approx(1080 / 720)

    # A box on the right edge of the small frame must land on the right edge
    # of the full frame, not somewhere in the middle.
    assert 1280 * sx == pytest.approx(1920)
    assert 720 * sy == pytest.approx(1080)


def test_small_frames_pass_through_without_upscaling():
    """Upscaling costs time and invents no detail. Scales must stay exactly 1
    so coordinates are untouched."""
    a = _Sized()
    frame = np.zeros((360, 640, 3), dtype=np.uint8)
    out, sx, sy = a.resize_for_inference(frame)
    assert out.shape == frame.shape
    assert (sx, sy) == (1.0, 1.0)
    assert out is frame


def test_width_is_read_live_not_cached_at_construction():
    """A settings change should apply without rebuilding the analyzer and
    reloading its model, which takes seconds."""
    a = _Sized()
    assert a.inference_width == 1280
    a.MODE = "human-tracking"
    assert a.inference_width == 640


# --------------------------------------------------------------------------- #
# imgsz — the half of the fix a comment cannot enforce                          #
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("filename", [
    "crowd_manager.py", "human_tracker.py", "person_tracker.py", "object_detector.py",
])
def test_analysis_path_passes_imgsz(filename):
    """
    The inference path must set imgsz, or the pre-resize is pointless and the
    altitude ceiling never moves.

    Checked over the whole _analyze_frame_blocking body rather than the call
    arguments, because object_detector legitimately passes it in an opts dict
    (`self.model(frame_proc, **opts)`) and an args-only check flags that as a
    failure. Static rather than runtime: constructing these analyzers loads
    YOLO plus, for person_tracker, InsightFace — too heavy for a unit test,
    and the thing worth pinning is that the argument is present at all.
    """
    src = (MODULES / filename).read_text()
    m = re.search(
        r"def _analyze_frame_blocking\(.*?(?=\n    (?:@|def )|\Z)", src, re.S
    )
    assert m, f"could not locate _analyze_frame_blocking in {filename}"
    body = m.group(0)
    assert "self.model" in body, f"no inference call in {filename}"
    assert "imgsz" in body, (
        f"{filename}'s analysis path never sets imgsz — ultralytics would "
        f"letterbox back to 640 and discard the extra resolution"
    )
    assert "imgsz_for" in body, (
        f"{filename} sets imgsz from something other than imgsz_for() — see "
        f"the imgsz=0 tests below for why passing inference_width straight "
        f"through is fatal"
    )


@pytest.mark.parametrize("filename", [
    "crowd_manager.py", "human_tracker.py", "person_tracker.py",
    "object_detector.py", "plate_tracker.py", "traffic_manager.py",
])
def test_no_module_passes_inference_width_straight_to_imgsz(filename):
    """
    THE imgsz=0 BUG, PINNED.

    `inference_width` is a width BUDGET where 0 means "native, do not
    downscale" — correct for resize_for_inference. But ultralytics does not
    read 0 that way, it raises:

        RuntimeError: Calculated padded input size per channel: (2 x 2).
        Kernel size: (3 x 3). Kernel size can't be greater than actual input
        size

    and that raise happens inside the analyzer's worker thread, so the mode
    produces no detections, no metadata and no database rows while the video
    keeps streaming — indistinguishable from a model that simply finds
    nothing. Setting vehicle-plate-tracking to native did exactly this.
    """
    src = (MODULES / filename).read_text()
    assert "imgsz=self.inference_width" not in src, (
        f"{filename} passes inference_width straight to imgsz — a mode "
        f"configured to 0 (native) would raise on every frame. Use "
        f"self.imgsz_for(frame) instead."
    )


class _Native(BaseAnalyzer):
    """A mode configured for native resolution (width 0)."""
    MODE = "vehicle-plate-tracking"

    def _analyze_frame_blocking(self, frame_bgr) -> Tuple[np.ndarray, Dict[str, Any]]:
        return frame_bgr, {}


def test_imgsz_for_never_returns_zero():
    """0 is a legal inference_width (native) but never a legal imgsz."""
    a = _Native.__new__(_Native)
    for h, w in [(1080, 1920), (720, 1280), (480, 640), (1088, 1920)]:
        assert a.imgsz_for(np.zeros((h, w, 3), np.uint8)) > 0


def test_native_imgsz_is_the_frames_own_long_side():
    a = _Native.__new__(_Native)
    assert a.inference_width == 0, "expected this mode to be configured native"
    assert a.imgsz_for(np.zeros((1080, 1920, 3), np.uint8)) == 1920
    assert a.imgsz_for(np.zeros((720, 1280, 3), np.uint8)) == 1280


def test_native_imgsz_is_a_multiple_of_the_network_stride():
    """Ultralytics needs imgsz divisible by 32; an odd frame height must round
    up rather than be handed through as-is."""
    a = _Native.__new__(_Native)
    for h, w in [(1081, 1921), (1080, 1919), (777, 1333)]:
        got = a.imgsz_for(np.zeros((h, w, 3), np.uint8))
        assert got % 32 == 0, f"{w}x{h} -> imgsz {got} is not a multiple of 32"
        assert got >= max(h, w), "native imgsz must not shrink the frame"


def test_a_budgeted_mode_still_gets_exactly_its_configured_width():
    """imgsz_for must be a no-op for every mode that sets a real width, or this
    fix would quietly change the altitude ceiling everywhere else."""
    a = _Sized.__new__(_Sized)          # crowd-management, 1280
    assert a.inference_width == 1280
    frame_proc, _, _ = a.resize_for_inference(np.zeros((1080, 1920, 3), np.uint8))
    assert a.imgsz_for(frame_proc) == 1280


def test_no_module_hardcodes_640_in_a_resize():
    """The original bug, pinned. Four modules each had their own
    cv2.resize(..., 640, ...) which ignored the setting entirely."""
    offenders = []
    for p in MODULES.glob("*.py"):
        for line in p.read_text().splitlines():
            if "cv2.resize" in line and "640" in line:
                offenders.append(f"{p.name}: {line.strip()}")
    assert not offenders, (
        "hardcoded 640 resize found — use BaseAnalyzer.resize_for_inference:\n"
        + "\n".join(offenders)
    )


# --------------------------------------------------------------------------- #
# Undefined names in paths unit tests cannot reach                              #
# --------------------------------------------------------------------------- #

def test_no_analyzer_module_references_an_undefined_name():
    """
    A NameError guard for the flight-control paths.

    _analyze_frame_blocking needs YOLO (and for person_tracker, InsightFace)
    to run, so no unit test executes it — which means a constant used only
    inside the PD block can go missing and every test still passes, right up
    until the drone is armed. That happened: _YAW_PRIORITY_FLOOR was used in
    human_tracker and person_tracker before it was defined in either.

    Compiling the module is not enough (Python resolves globals at runtime),
    so this asks pyflakes for undefined names specifically.
    """
    import shutil
    import subprocess

    if not shutil.which("ruff"):
        pytest.skip("ruff not on PATH")
    files = sorted(str(p) for p in MODULES.glob("*.py") if p.name != "__init__.py")
    proc = subprocess.run(
        ["ruff", "check", "--select", "F821", "--output-format", "concise", *files],
        capture_output=True, text=True,
    )
    undefined = [ln for ln in proc.stdout.splitlines() if "F821" in ln]
    assert not undefined, (
        "undefined names in analyzer modules (these only raise once the drone "
        "is armed):\n" + "\n".join(undefined)
    )
