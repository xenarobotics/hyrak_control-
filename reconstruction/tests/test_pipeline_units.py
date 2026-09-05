"""Keyframe gating, queues, depth alignment, and export round-trips."""

import numpy as np
import pytest

from dronemap.concurrency import DropOldestQueue, RateLimiter, StageStats
from dronemap.config import Config, parse_set_overrides
from dronemap.depth.base import edge_confidence, robust_align_depth
from dronemap.tracking.keyframe import KeyframeSelector
from dronemap.types import se3_exp


# --------------------------------------------------------------------- queues

def test_drop_oldest_discards_oldest_not_newest():
    q = DropOldestQueue(3, "t")
    for i in range(10):
        q.put(i)
    assert len(q) == 3 and q.dropped == 7
    # The three newest survive, in order.
    assert [q.get(), q.get(), q.get()] == [7, 8, 9]


def test_lossless_queue_refuses_to_drop():
    q = DropOldestQueue(2, "l", lossless=True)
    assert q.put(1) and q.put(2)
    assert q.put(3, timeout=0.05) is False
    assert len(q) == 2


def test_get_latest_discards_backlog():
    q = DropOldestQueue(8, "v")
    for i in range(5):
        q.put(i)
    assert q.get_latest() == 4
    assert len(q) == 0


def test_closed_queue_releases_readers():
    q = DropOldestQueue(2, "c")
    q.close()
    assert q.get(timeout=0.1) is None
    assert q.put(1) is False


def test_stage_stats_percentiles():
    s = StageStats("x")
    for v in [0.01, 0.02, 0.03, 0.10]:
        s.record(v)
    assert s.count == 4
    assert 20 <= s.ms_p50 <= 30
    assert s.ms_p95 == pytest.approx(100.0)


# ------------------------------------------------------------------- keyframes

def _selector(**kw):
    cfg = Config()
    for k, v in kw.items():
        setattr(cfg.keyframe, k, v)
    return KeyframeSelector(cfg)


def test_first_frame_is_always_a_keyframe():
    sel = _selector()
    d = sel.evaluate(np.eye(4), 0.0, median_depth=5.0, n_tracks=500)
    assert d.accept and d.reason == "first"


def test_stationary_camera_is_rejected_then_times_out():
    sel = _selector(max_interval_s=1.0, min_interval_s=0.05)
    sel.evaluate(np.eye(4), 0.0, 5.0, 500)
    d = sel.evaluate(np.eye(4), 0.5, 5.0, 500)
    assert not d.accept and d.reason == "redundant"
    d = sel.evaluate(np.eye(4), 1.5, 5.0, 500)
    assert d.accept and d.reason == "timeout"


def test_translation_threshold_scales_with_scene_depth():
    """The same motion should trigger at 2 m and not at 60 m."""
    sel = _selector(trans_ratio=0.15, max_trans_m=100.0)
    near = sel.threshold_for(2.0)
    far = sel.threshold_for(60.0)
    assert near == pytest.approx(0.30)
    assert far == pytest.approx(9.0)

    sel = _selector(trans_ratio=0.15, max_trans_m=100.0)
    sel.evaluate(np.eye(4), 0.0, median_depth=2.0, n_tracks=500)
    T = np.eye(4)
    T[0, 3] = 0.5
    assert sel.evaluate(T, 0.2, 2.0, 500).accept       # 0.5 m > 0.30 m threshold

    sel = _selector(trans_ratio=0.15, max_trans_m=100.0)
    sel.evaluate(np.eye(4), 0.0, median_depth=60.0, n_tracks=500)
    assert not sel.evaluate(T, 0.2, 60.0, 500).accept  # 0.5 m << 9 m threshold


def test_rotation_triggers_without_translation():
    sel = _selector(rot_deg=8.0)
    sel.evaluate(np.eye(4), 0.0, 5.0, 500)
    T = se3_exp(np.array([0, 0, 0, 0, np.radians(12), 0]))
    d = sel.evaluate(T, 0.3, 5.0, 500)
    assert d.accept and d.reason == "rotation"


def test_track_attrition_triggers():
    sel = _selector(track_ratio=0.65)
    sel.evaluate(np.eye(4), 0.0, 5.0, 500)
    d = sel.evaluate(np.eye(4), 0.3, 5.0, 200, track_ratio=0.4)
    assert d.accept and d.reason == "track_loss"


def test_min_interval_outranks_every_trigger():
    """Rate limiting must win, or a fast rotation floods the mapper."""
    sel = _selector(min_interval_s=0.5, rot_deg=1.0)
    sel.evaluate(np.eye(4), 0.0, 5.0, 500)
    T = se3_exp(np.array([0, 0, 0, 0, np.radians(45), 0]))
    d = sel.evaluate(T, 0.1, 5.0, 500, track_ratio=0.0)
    assert not d.accept and d.reason == "min_interval"


# ----------------------------------------------------------------- depth align

def _depth_field(h=180, w=320):
    return np.clip(np.cumsum(np.ones((h, w), np.float32), axis=1) / w * 8 + 2, 2, 10)


@pytest.mark.parametrize("scale,shift", [(1.0, 0.0), (0.62, 0.0), (1.8, -0.4), (2.5, 1.2)])
def test_alignment_recovers_scale(scale, shift):
    truth = _depth_field()
    pred = (truth - shift) / scale
    rng = np.random.default_rng(0)
    n = 200
    px = np.stack([rng.integers(0, 320, n), rng.integers(0, 180, n)], 1).astype(float)
    ref = truth[px[:, 1].astype(int), px[:, 0].astype(int)] * (1 + rng.normal(scale=0.02, size=n))
    s, t, n_inl, _ = robust_align_depth(pred, px, ref, fit_shift=True)
    assert abs(s - scale) / scale < 0.10


def test_alignment_survives_heavy_outliers():
    truth = _depth_field()
    pred = truth / 0.62
    rng = np.random.default_rng(1)
    n = 200
    px = np.stack([rng.integers(0, 320, n), rng.integers(0, 180, n)], 1).astype(float)
    ref = truth[px[:, 1].astype(int), px[:, 0].astype(int)].astype(float)
    ref[rng.choice(n, 80, replace=False)] = rng.uniform(0.5, 40, 80)   # 40% outliers
    s, _, n_inl, _ = robust_align_depth(pred, px, ref, fit_shift=True)
    assert abs(s - 0.62) / 0.62 < 0.10


def test_alignment_fails_closed_rather_than_guessing():
    """Too few points must return the rejection sentinel, not a fitted value."""
    s, t, n_inl, resid = robust_align_depth(np.ones((10, 10), np.float32),
                                            np.zeros((3, 2)), np.ones(3))
    assert (s, t, n_inl) == (1.0, 0.0, 0)
    assert resid == float("inf")


def test_edge_confidence_suppresses_discontinuities():
    d = np.full((64, 64), 5.0, np.float32)
    d[:, 32:] = 9.0
    c = edge_confidence(d, 0.06)
    assert c[10, 10] > 0.9        # flat region trusted
    assert c[10, 31] < 0.2        # depth step suppressed
    assert (c[d == 0] == 0).all() if (d == 0).any() else True


# ---------------------------------------------------------------------- config

def test_config_overrides_and_validation():
    cfg = Config.model_validate(parse_set_overrides([
        "fusion.voxel_size_m=0.02", "viz.backend=none", "export.formats=[ply,glb]",
    ]))
    assert cfg.fusion.voxel_size_m == 0.02
    assert cfg.viz.backend == "none"
    assert cfg.export.formats == ["ply", "glb"]


@pytest.mark.parametrize("bad", [
    {"depth": {"min_depth_m": 10, "max_depth_m": 1}},
    {"fusion": {"trunc_voxels": 0.5}},
    {"keyframe": {"min_interval_s": 5.0, "max_interval_s": 1.0}},
    {"fusion": {"voxel_size_m": 0.0}},
])
def test_config_rejects_incoherent_values(bad):
    with pytest.raises(Exception):
        Config.model_validate(bad)


def test_rate_limiter_does_not_accumulate_drift():
    import time

    r = RateLimiter(100)
    t0 = time.monotonic()
    for _ in range(10):
        r.wait()
    elapsed = time.monotonic() - t0
    assert 0.05 < elapsed < 0.30


# -- session lifecycle races -------------------------------------------------

def test_stop_before_start_is_honored():
    """A /stop that races the startup thread must win, not be erased."""
    from dronemap.control.lifecycle import SessionLifecycle

    lc = SessionLifecycle()
    lc.request_stop("raced")
    assert lc.start() is False
    assert lc.info.state.value == "finished"
    assert lc.should_stop


def test_active_covers_the_starting_window():
    """`running` is False during STARTING; gating a second start on it opened
    a double-start race. `active` must cover every non-idle state."""
    from dronemap.control.lifecycle import SessionLifecycle, SessionState

    lc = SessionLifecycle()
    assert not lc.active
    for st in (SessionState.STARTING, SessionState.RUNNING,
               SessionState.STOPPING, SessionState.EXPORTING):
        lc.info.state = st
        assert lc.active, st
    for st in (SessionState.IDLE, SessionState.FINISHED, SessionState.FAILED):
        lc.info.state = st
        assert not lc.active, st


def test_keyframe_spill_roundtrip(tmp_path):
    """Payloads beyond the RAM cap spill to disk and reload identically,
    including a map rescale that happened while spilled."""
    import numpy as np

    from dronemap.tracking.mapdb import SceneMap
    from dronemap.types import CameraIntrinsics, Keyframe

    m = SceneMap()
    m.enable_spill(max_in_memory=8, directory=tmp_path)
    K = CameraIntrinsics.from_fov(64, 48, 60.0)
    rng = np.random.default_rng(0)
    for i in range(12):
        m.add_keyframe(Keyframe(
            kf_id=i, frame_index=i, timestamp=float(i),
            image=rng.integers(0, 255, (48, 64, 3), dtype=np.uint8),
            intrinsics=K, T_wc=np.eye(4),
            depth=rng.random((48, 64)).astype(np.float32) + 0.5))

    spilled = [kf for kf in m.all_keyframes() if kf.image is None]
    resident = [kf for kf in m.all_keyframes() if kf.image is not None]
    assert len(spilled) == 4 and len(resident) == 8
    assert all(kf.spill_path for kf in spilled)

    kf = spilled[0]
    m.rescale(2.0)  # while spilled: depth correction must be deferred
    kf.load_payload()
    assert kf.image is not None and kf.depth is not None
    assert kf.depth.min() >= 1.0  # (0.5..1.5) * 2
    kf.drop_payload()
    assert kf.image is None
    kf.load_payload()  # reload applies the scale exactly once, again from disk
    assert kf.depth.min() >= 1.0 and kf.depth.max() <= 3.01
    m.release_spill()


# -- aspect-ratio guards -----------------------------------------------------

def test_aspect_mismatch_falls_back_to_fov_intrinsics():
    """A stream whose aspect differs from the calibrated config is not a
    rescale of that sensor; rescaling anyway warps fx/fy and kills PnP."""
    from dronemap.ingest.base import FrameSource

    class Dummy(FrameSource):
        def open(self): pass
        def _read(self): return None

    cfg = Config()
    cfg.camera.width, cfg.camera.height = 1920, 1080
    cfg.camera.hfov_deg = 52.0
    src = Dummy(cfg)

    # Same aspect: a plain rescale of the calibration.
    K = src._resolve_intrinsics(960, 540)
    ref = cfg.build_intrinsics()
    assert K.fx == pytest.approx(ref.fx * 0.5)
    assert K.fy == pytest.approx(ref.fy * 0.5)

    # 4:3 stream against a 16:9 calibration: square-pixel FOV fallback.
    K = src._resolve_intrinsics(1280, 960)
    assert (K.width, K.height) == (1280, 960)
    assert K.fx == pytest.approx(K.fy, rel=1e-6), \
        "fallback intrinsics must be square-pixel"


def test_track_aspect_is_corrected_to_camera_aspect():
    from dronemap.app import ensure_track_aspect

    cfg = Config()
    cfg.camera.width, cfg.camera.height = 1280, 960     # 4:3 camera
    cfg.source.track_width, cfg.source.track_height = 960, 540  # 16:9 preset
    ensure_track_aspect(cfg)
    assert cfg.source.track_height == 720  # 960 / (4/3)

    # Matching aspect is left alone.
    cfg2 = Config()
    cfg2.camera.width, cfg2.camera.height = 1920, 1080
    cfg2.source.track_width, cfg2.source.track_height = 960, 540
    ensure_track_aspect(cfg2)
    assert cfg2.source.track_height == 540
