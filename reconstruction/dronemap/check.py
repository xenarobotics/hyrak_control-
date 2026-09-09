"""Source preflight: is this video feed actually usable for SLAM?

Reconstruction failures are very often input failures, and they are easy to
misread — a black or frozen feed produces "tracking lost" spam that looks like a
tracker bug. This walks the source through the same ingest path the pipeline
uses and reports, in order of how often each one is the real culprit:

* Does the source open and deliver frames at all?
* Are the frames changing, or is it a frozen/idle image?
* Is there any light and contrast, or is the lens covered?
* Are there corners to track?
* Do those corners survive optical flow between frames?

Each failure prints what to do about it rather than just a number.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

log = logging.getLogger(__name__)


@dataclass
class SourceReport:
    frames: int = 0
    width: int = 0
    height: int = 0
    fps: float = 0.0
    brightness: float = 0.0
    contrast: float = 0.0
    corners: int = 0
    duplicate_ratio: float = 0.0
    klt_survival: float = 0.0
    median_flow_px: float = 0.0
    problems: list[str] = field(default_factory=list)
    advice: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems


def check_source(cfg, n_frames: int = 40, timeout_s: float = 25.0) -> SourceReport:
    """Grab frames through the real ingest path and grade them."""
    import cv2

    from .ingest.base import build_source

    rep = SourceReport()
    source = build_source(cfg)
    try:
        source.open()
    except Exception as exc:  # noqa: BLE001
        rep.problems.append(f"could not open the source: {exc}")
        rep.advice.append("check the URI/device, and that nothing else has it open")
        return rep

    grays: list[np.ndarray] = []
    t0 = time.monotonic()
    try:
        for frame in source.frames():
            grays.append(frame.ensure_gray())
            rep.width, rep.height = frame.image.shape[1], frame.image.shape[0]
            if len(grays) >= n_frames or time.monotonic() - t0 > timeout_s:
                break
    except Exception as exc:  # noqa: BLE001
        rep.problems.append(f"the source failed while reading: {exc}")
    finally:
        elapsed = max(time.monotonic() - t0, 1e-9)
        source.close()

    rep.frames = len(grays)
    if rep.frames < 2:
        rep.problems.append(f"only {rep.frames} frame(s) arrived in {elapsed:.1f}s")
        rep.advice.append("the source is not delivering video; check that the "
                          "camera/app is streaming and not asleep")
        return rep

    rep.fps = (rep.frames - 1) / elapsed

    # -- is anything changing? ------------------------------------------
    diffs = [float(np.abs(grays[i].astype(np.int16) - grays[i + 1].astype(np.int16)).mean())
             for i in range(len(grays) - 1)]
    rep.duplicate_ratio = float(np.mean([d < 0.5 for d in diffs]))

    ref = grays[len(grays) // 2]
    rep.brightness = float(ref.mean())
    rep.contrast = float(ref.std())

    if rep.brightness < 3.0:
        rep.problems.append("the feed is black")
        rep.advice.append("reconnect the camera app; for a phone keep it in the "
                          "foreground with the screen awake")
    elif rep.brightness < 20:
        rep.problems.append(f"very dark (mean brightness {rep.brightness:.0f}/255)")
        rep.advice.append("add light, or uncover the lens")

    if rep.contrast < 5.0:
        rep.problems.append(f"almost no contrast (std {rep.contrast:.1f})")
        rep.advice.append("the camera may be showing a blank placeholder image")

    if rep.duplicate_ratio > 0.9:
        rep.problems.append(f"{rep.duplicate_ratio:.0%} of frames are identical "
                            "— the feed is frozen")
        rep.advice.append("the source is connected but not producing new frames")

    # -- is there anything to track? ------------------------------------
    corners = cv2.goodFeaturesToTrack(ref, 1000, 0.01, 12)
    rep.corners = 0 if corners is None else len(corners)
    if rep.corners < 100:
        rep.problems.append(f"only {rep.corners} trackable corners")
        rep.advice.append("point the camera at textured surfaces; blank walls, "
                          "sky and glossy floors give a tracker nothing to hold")

    # -- does optical flow survive? --------------------------------------
    survivals, flows = [], []
    for i in range(min(12, len(grays) - 1)):
        p = cv2.goodFeaturesToTrack(grays[i], 600, 0.01, 12)
        if p is None or len(p) < 20:
            continue
        crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01)
        p1, st, _ = cv2.calcOpticalFlowPyrLK(grays[i], grays[i + 1], p, None,
                                             winSize=(21, 21), maxLevel=3,
                                             criteria=crit)
        p0r, st2, _ = cv2.calcOpticalFlowPyrLK(grays[i + 1], grays[i], p1, None,
                                               winSize=(21, 21), maxLevel=3,
                                               criteria=crit)
        fb = np.linalg.norm(p.reshape(-1, 2) - p0r.reshape(-1, 2), axis=1)
        ok = (st.reshape(-1) == 1) & (st2.reshape(-1) == 1) & (fb < 1.0)
        survivals.append(float(ok.mean()))
        if ok.any():
            flows.append(float(np.median(np.linalg.norm(
                p1.reshape(-1, 2)[ok] - p.reshape(-1, 2)[ok], axis=1))))

    rep.klt_survival = float(np.mean(survivals)) if survivals else 0.0
    rep.median_flow_px = float(np.median(flows)) if flows else 0.0

    if survivals and rep.klt_survival < 0.6 and rep.brightness >= 20:
        rep.problems.append(f"optical flow only survives {rep.klt_survival:.0%} "
                            "of features between frames")
        rep.advice.append("move the camera more slowly and smoothly; heavy motion "
                          "blur, rolling shutter or a low frame rate all break flow")

    if rep.median_flow_px < 0.15 and rep.duplicate_ratio < 0.9:
        rep.advice.append("the camera is barely moving — SLAM needs parallax, so "
                          "translate it (walk sideways), do not just rotate in place")

    return rep


def print_report(rep: SourceReport, uri: str) -> None:
    print(f"\n{'=' * 62}\n  SOURCE CHECK: {uri}\n{'=' * 62}")
    print(f"  frames received     {rep.frames} at {rep.fps:.1f} fps")
    print(f"  resolution          {rep.width}x{rep.height}")
    print(f"  brightness / std    {rep.brightness:.0f} / {rep.contrast:.1f}")
    print(f"  identical frames    {rep.duplicate_ratio:.0%}")
    print(f"  trackable corners   {rep.corners}")
    print(f"  optical-flow survival {rep.klt_survival:.0%}"
          f"   median motion {rep.median_flow_px:.2f} px/frame")
    print("=" * 62)
    if rep.ok:
        print("  READY — this feed is usable for reconstruction.")
        for a in rep.advice:
            print(f"  note: {a}")
    else:
        print("  NOT USABLE:")
        for p in rep.problems:
            print(f"    - {p}")
        print("\n  what to do:")
        for a in rep.advice:
            print(f"    - {a}")
    print()
