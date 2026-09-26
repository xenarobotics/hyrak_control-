"""Background obstacle sensing - the drone's eyes, independent of the AI tab.

Avoidance is a flight-safety function tied to the Avoidance toggle, not to
what the operator happens to be looking at. This module runs the metric depth
model on the session's frames in the background whenever the session's drone
has avoidance enabled, in EVERY AI mode (Depth mapping included - the depth
module no longer extracts obstacles itself). At most SENSE_HZ frames per
second per session, never queued (a frame arriving while inference is busy is
dropped), on its own thread so the video path never waits.

Per frame (step D of docs/avoidance/ARCHITECTURE_REVIEW.md):
  1. the frame's capture time is stamped and the aircraft's pose AT that time
     taken from the pose history (step B);
  2. the model's raw depth is pooled and its scale fitted to the ground plane
     (mono_calibration) - known camera height and tilt give true ground depth;
  3. the calibrated depth goes through the same geometric scan as a real
     depth camera (depth_scan: ground rejected by height, attitude removed);
  4. the scan is integrated into the occupancy grid with mono's weak weights
     (several agreeing frames before a cell counts as occupied).
Frames without a usable ground fit produce no obstacles - an uncalibrated
mono range is the error behind most of the SITL phantoms. The legacy
flat-segment detector is used only when there is no pose at all (no link).
"""
from __future__ import annotations

import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

logger = logging.getLogger("verocore.avoidance.sensing")

SENSE_HZ = 5.0            # 4 m/s -> a frame every 0.8 m; the model does 33 ms
POOL_ROWS, POOL_COLS = 60, 80

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="avoid-sense")
_depth = None             # lazily built DepthMapper (the same module Depth mapping uses)
_depth_failed = False
_last_at: dict[str, float] = {}
_busy: set[str] = set()
_announced: set[str] = set()


def warm() -> None:
    """Load the depth model now (when avoidance is switched on) instead of on
    the first frame - the 2-3 s load happened 20 s into a mission once.
    Called by POST /enable; it went missing in the layered cleanup and every
    Detection-on click answered 500 ("Failed to fetch" in the browser)."""
    if _depth is None and not _depth_failed:
        _executor.submit(_analyze, np.zeros((480, 640, 3), np.uint8), None)


def wants_frame(session_id: str, mode_value: str | None) -> bool:
    """Should this session's next frame go through the sensor? Cheap: a dict
    lookup and a controller check, so it is safe to call per frame."""
    if _depth_failed:
        return False
    from app.avoidance.core import controller as avoidance
    if not avoidance.any_enabled():
        return False
    from app.avoidance.core import loop as av_loop
    c = av_loop._controller_for_session(session_id)
    if c is None:
        return False
    # A real range sensor is streaming: mono would only add its errors.
    if c.sensor_mode() == "range":
        return False
    if session_id in _busy:
        return False
    now = time.monotonic()
    if now - _last_at.get(session_id, 0.0) < 1.0 / SENSE_HZ:
        return False
    _last_at[session_id] = now
    return True


def _mapper():
    global _depth, _depth_failed
    if _depth is None:
        from app.vision.modules.depth_mapper import DepthMapper
        try:
            _depth = DepthMapper()
        except Exception as e:
            _depth_failed = True
            logger.error(f"Background obstacle sensing unavailable - depth model failed to load: {e}")
            return None
    return _depth


def analyze_depth(depth: np.ndarray, frame_w: int, frame_h: int, ctx: dict | None,
                  hfov_deg: float, max_range_m: float) -> dict:
    """Pure part of the per-frame work (testable without the model)."""
    if ctx is None:
        from app.avoidance.sensing.flat_segment import observations_from_depth
        obs = observations_from_depth(depth, hfov_deg=hfov_deg, max_distance_m=max_range_m)
        return {"legacy": [
            {"bearing_deg": o.bearing_deg, "distance_m": o.distance_m,
             "half_width_deg": o.half_width_deg, "confidence": o.confidence,
             "source": o.source, "top_m": o.top_m} for o in obs]}
    from app.avoidance.sensing.depth_scan import pool_min, scan_from_depth, vfov_for
    from app.avoidance.sensing.mono_calibration import fit_scale
    vfov = vfov_for(hfov_deg, frame_w, frame_h)
    pooled = pool_min(depth, POOL_ROWS, POOL_COLS, percentile=20)
    if ctx.get("bench"):
        # Fixed camera on a bench: the model's metres as they come, camera
        # level at a known height (the floor/desk is rejected as ground).
        scan = scan_from_depth(pooled, hfov_deg, vfov, alt_m=ctx["bench_h"],
                               max_range_m=max_range_m, invalid_is_free=False)
        return {"fit": None, "scan": scan, "bench": True}
    fit = fit_scale(pooled, hfov_deg, vfov, alt_m=ctx["alt_m"], roll_deg=ctx["roll_deg"],
                    pitch_deg=ctx["pitch_deg"], cam_pitch_deg=ctx["cam_pitch_deg"])
    scale = ctx.get("scale")
    if fit is not None:
        scale = fit.scale if scale is None else 0.7 * scale + 0.3 * fit.scale
    if scale is None:
        return {"fit": None, "scan": None}
    scan = scan_from_depth(pooled * scale, hfov_deg, vfov, alt_m=ctx["alt_m"],
                           roll_deg=ctx["roll_deg"], pitch_deg=ctx["pitch_deg"],
                           cam_pitch_deg=ctx["cam_pitch_deg"], max_range_m=max_range_m,
                           invalid_is_free=False)
    return {"fit": fit, "scan": scan}


def _analyze(img_bgr: np.ndarray, ctx: dict | None) -> dict | None:
    """Worker thread: model inference + analyze_depth."""
    m = _mapper()
    if m is None:
        return None
    from app.config import get_settings
    cfg = get_settings()
    depth = np.nan_to_num(m.predict_metric(img_bgr), nan=0.0, posinf=0.0, neginf=0.0)
    h, w = img_bgr.shape[:2]
    return analyze_depth(depth, w, h, ctx, float(cfg.camera_hfov_deg),
                         float(cfg.depth_obstacle_max_m))


def submit(session_id: str, img_bgr: np.ndarray) -> None:
    """Hand one BGR frame to the sensor. Returns immediately; the result is
    integrated from the executor's completion, on the event loop."""
    captured_at = time.monotonic()
    from app.avoidance.core import loop as av_loop
    from app.avoidance.mapping import pose_history
    c = av_loop._controller_for_session(session_id)
    ctx = None
    if c is not None:
        pose = pose_history.history(c.drone_id).at(captured_at)
        if pose is not None:
            ctx = {"alt_m": pose.alt_m, "roll_deg": pose.roll_deg, "pitch_deg": pose.pitch_deg,
                   "cam_pitch_deg": float(c.params.camera_pitch_deg),
                   "scale": c.mono_scale.scale,
                   "bench": bool(c.params.mono_bench),
                   "bench_h": float(c.params.bench_cam_height_m)}
    _busy.add(session_id)
    loop = asyncio.get_running_loop()
    fut = loop.run_in_executor(_executor, _analyze, img_bgr, ctx)

    def _done(f):
        _busy.discard(session_id)
        try:
            res = f.result()
        except Exception as e:
            logger.debug(f"obstacle sensing frame failed: {e}")
            return
        if session_id not in _announced:
            _announced.add(session_id)
            logger.info(f"Background obstacle sensing active for session {session_id[:8]} "
                        f"(~{SENSE_HZ:.0f} fps, independent of the AI mode)")
        cc = av_loop._controller_for_session(session_id)
        if cc is None or res is None:
            return
        # A processed frame IS the camera feeding, whether or not it held an
        # obstacle and whatever the altitude (the arm interlock reads this).
        from app.avoidance.sensing import registry as sensor_registry
        sensor_registry.mark_data(cc.drone_id, "monocular")
        cc._mono_data_t = time.monotonic()      # mono gates apply even when a frame fails to calibrate
        if "legacy" in res:
            if res["legacy"]:
                av_loop.observe_from_session(session_id, res["legacy"], captured_at=captured_at)
            return
        if not res.get("bench"):
            cc.mono_scale.update(res.get("fit"))
        if res.get("scan"):
            cc.integrate_scan(res["scan"], captured_at, "monocular")

    fut.add_done_callback(_done)
