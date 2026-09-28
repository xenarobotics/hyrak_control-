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
    from app.avoidance.sensing import person_ruler
    c = av_loop._controller_for_session(session_id)
    if c is None:
        return False
    if session_id in _busy:
        return False
    # A person-ruler calibration run needs frames whatever the sensor mode.
    if person_ruler.pending(c.drone_id):
        now = time.monotonic()
        if now - _last_at.get(session_id, 0.0) < 1.0 / SENSE_HZ:
            return False
        _last_at[session_id] = now
        return True
    # A real range sensor is streaming: mono would only add its errors.
    if c.sensor_mode() == "range":
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
        # Fixed camera on a bench: the model's metres (times this camera's
        # person-ruler scale, when one was measured), camera level at a
        # known height (the floor/desk is rejected as ground).
        pooled = pooled * float(ctx.get("stored_scale") or 1.0)
        scan = scan_from_depth(pooled, hfov_deg, vfov, alt_m=ctx["bench_h"],
                               max_range_m=max_range_m, invalid_is_free=False)
        return {"fit": None, "scan": scan, "bench": True}
    fit = fit_scale(pooled, hfov_deg, vfov, alt_m=ctx["alt_m"], roll_deg=ctx["roll_deg"],
                    pitch_deg=ctx["pitch_deg"], cam_pitch_deg=ctx["cam_pitch_deg"])
    scale = ctx.get("scale")
    if scale is None and fit is not None and ctx.get("scale_seed"):
        scale = float(ctx["scale_seed"])
    if fit is not None:
        scale = fit.scale if scale is None else 0.7 * scale + 0.3 * fit.scale
    if scale is None:
        return {"fit": None, "scan": None}
    scan = scan_from_depth(pooled * scale, hfov_deg, vfov, alt_m=ctx["alt_m"],
                           roll_deg=ctx["roll_deg"], pitch_deg=ctx["pitch_deg"],
                           cam_pitch_deg=ctx["cam_pitch_deg"], max_range_m=max_range_m,
                           invalid_is_free=False)
    return {"fit": fit, "scan": scan}


def _analyze(img_bgr: np.ndarray, ctx: dict | None, session_id: str | None = None) -> dict | None:
    """Worker thread: model inference + analyze_depth (or, during a
    person-ruler run, one ruler measurement instead)."""
    m = _mapper()
    if m is None:
        return None
    from app.config import get_settings
    from app.avoidance.sensing import person_ruler
    from app.vision import camera_profiles
    cfg = get_settings()
    hfov = camera_profiles.hfov_for(session_id)          # this session's lens
    depth = np.nan_to_num(m.predict_metric(img_bgr, hfov), nan=0.0, posinf=0.0, neginf=0.0)
    h, w = img_bgr.shape[:2]
    key = person_ruler.profile_key(w, h, hfov, m.model_name)
    if ctx is not None and ctx.get("ruler_height"):
        try:
            scale, why = person_ruler.measure(img_bgr, depth, hfov, ctx["ruler_height"])
        except Exception as e:
            scale, why = None, f"person detector failed: {e}"
        return {"ruler": (scale, why, key)}
    if ctx is not None:
        stored = _stored_scale(key)
        ctx = {**ctx, "stored_scale": stored}
        if ctx.get("scale") is None and stored:
            # Flight: seed the ground fit with it - blended into a real fit
            # only. A frame with NO ground fit still yields no obstacles.
            ctx["scale_seed"] = stored
    return analyze_depth(depth, w, h, ctx, hfov, float(cfg.depth_obstacle_max_m))


_scale_cache: dict[str, tuple[float, float | None]] = {}


def _stored_scale(key: str) -> float | None:
    """The person-ruler scale for a camera profile, re-read at most every 5 s."""
    from app.avoidance.sensing import person_ruler
    now = time.monotonic()
    hit = _scale_cache.get(key)
    if hit and now - hit[0] < 5.0:
        return hit[1]
    rec = person_ruler._load().get(key)
    val = float(rec["scale"]) if rec and rec.get("scale") else None
    _scale_cache[key] = (now, val)
    return val


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
        from app.avoidance.sensing import person_ruler
        if person_ruler.pending(c.drone_id):
            ctx = {"ruler_height": person_ruler.status(c.drone_id).get("height_m", 1.70)}
    _busy.add(session_id)
    loop = asyncio.get_running_loop()
    fut = loop.run_in_executor(_executor, _analyze, img_bgr, ctx, session_id)

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
        if "ruler" in res:
            from app.avoidance.sensing import person_ruler
            scale, why, key = res["ruler"]
            person_ruler.add_sample(cc.drone_id, scale, why, key)
            if scale is not None:
                _scale_cache.pop(key, None)
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
