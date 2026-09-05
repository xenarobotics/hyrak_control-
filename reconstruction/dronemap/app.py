"""Pipeline orchestrator: wires the threads, owns the session.

Thread topology (see README for the diagram):

    ingest  -> q_track -> tracker -> q_kf -> local mapper -> q_fuse -> fusion
                                        \\-> q_viz -> visualiser

Every link is a bounded queue. The tracker and visualiser links **drop oldest**
so a slow consumer can never stall frame acquisition; the fusion link is
lossless, because dropping a keyframe there leaves a permanent hole in the
reconstruction.

Threads own distinct resources and communicate only through the queues and the
lock-protected `SceneMap`, so there is exactly one place where shared mutable
state lives.
"""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Any, Optional

import numpy as np

from .concurrency import DropOldestQueue, RateLimiter, Stage, StageStats
from .config import Config
from .control.lifecycle import SessionLifecycle, SessionState
from .depth.base import build_depth_estimator
from .depth.scale_anchor import ScaleAnchor
from .fusion.base import build_mapper
from .fusion.reintegrate import Reintegrator, ReintegrationPolicy, max_drift
from .ingest.base import build_source
from .profiling.gpu_monitor import GpuMonitor
from .tracking.frontend import TrackState, VisualOdometry
from .tracking.keyframe import KeyframeSelector
from .tracking.local_mapping import LocalMapper
from .tracking.mapdb import SceneMap
from .types import Frame, Keyframe
from .viz.rerun_viewer import build_viewer

log = logging.getLogger(__name__)


class _StatView:
    """Adapts a bare StageStats to the (name, stats) shape progress logging wants."""

    __slots__ = ("name", "stats")

    def __init__(self, name: str, stats: StageStats) -> None:
        self.name = name
        self.stats = stats


def ensure_track_aspect(cfg: Config) -> None:
    """Force the tracking resolution to preserve the camera's aspect ratio.

    A preset written for 16:9 fed by a 4:3 camera produces anisotropically
    scaled intrinsics (fx/fy warped by the aspect mismatch), and PnP fails on
    the first real motion -- tracking dies at LOST with one keyframe. That is
    a config bug with a catastrophic, hard-to-diagnose failure mode, so it is
    corrected here rather than merely warned about.
    """
    cw, ch = cfg.camera.width, cfg.camera.height
    tw, th = cfg.source.track_width, cfg.source.track_height
    if not (cw and ch and tw and th):
        return
    cam_aspect = cw / ch
    if abs(tw / th - cam_aspect) <= 0.02 * cam_aspect:
        return
    fixed = max(2, int(round(tw / cam_aspect / 2.0)) * 2)
    log.error(
        "track resolution %dx%d does not preserve the camera's %dx%d aspect; "
        "correcting track height %d -> %d (anisotropic intrinsics break PnP)",
        tw, th, cw, ch, th, fixed,
    )
    cfg.source.track_height = fixed


class DroneMapApp:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.lifecycle = SessionLifecycle()
        self.map = SceneMap()
        self.gpu = GpuMonitor(cfg.profiling.nvml_interval_s)

        self.source = None
        self.depth = None
        self.mapper = None
        self.vo: Optional[VisualOdometry] = None
        self.local_mapper: Optional[LocalMapper] = None
        self.viewer = None
        self.control = None
        self.scale_anchor = ScaleAnchor(cfg)
        self.reintegrator: Optional[Reintegrator] = None
        self.keyframe_selector = KeyframeSelector(cfg)

        # Depth 2 keeps the tracker on recent frames; a deeper queue would only
        # let it fall further behind the live edge before dropping anyway.
        self.q_track: DropOldestQueue[Frame] = DropOldestQueue(2, "track")
        self.q_kf: DropOldestQueue[Any] = DropOldestQueue(
            max(2, cfg.pipeline.queue_keyframes), "keyframe")
        self.q_fuse: DropOldestQueue[Keyframe] = DropOldestQueue(16, "fusion", lossless=True)
        self.q_viz: DropOldestQueue[Any] = DropOldestQueue(2, "viz")

        self._threads: list[threading.Thread] = []
        self._ingest_thread: Optional[threading.Thread] = None
        self.stats = {name: StageStats(name)
                      for name in ("ingest", "tracker", "mapper", "fusion", "viz")}
        self._start_time = 0.0
        self._frames_seen = 0
        self._export_lock = threading.Lock()
        self._last_export: dict = {}
        self._fused_count = 0
        #: Latest JPEG-encoded frames for the panel's live feeds. Written by
        #: the viz stage, read by the HTTP streaming endpoints; plain attribute
        #: swaps are atomic under the GIL so no lock is needed.
        self.latest_frame_jpeg: Optional[bytes] = None
        self.latest_depth_jpeg: Optional[bytes] = None
        self._mesh_dirty = False
        #: Keyframes the gate wanted but the mapper had no room for.
        self._kf_backpressure = 0
        self._last_reloc_frame = -(10 ** 9)
        self._used = False
        #: Per-stage (errors_seen, successes_at_first_error) for dead-stage
        #: detection; see _on_stage_error.
        self._stage_err: dict[str, tuple[int, int]] = {}
        #: Final surface, captured before teardown so callers (the selftest,
        #: an embedding process) can inspect the result after run() returns.
        self.final_cloud: tuple[np.ndarray, np.ndarray] = (
            np.zeros((0, 3), np.float32), np.zeros((0, 3), np.uint8))

        self.lifecycle.on_stream_start(self._on_start)
        self.lifecycle.on_stream_stop(self._on_stop)

    # -- setup --------------------------------------------------------------

    def _on_start(self) -> None:
        cfg = self.cfg
        log.info("initialising pipeline (session=%s)", cfg.session_name)
        ensure_track_aspect(cfg)
        self._start_time = time.monotonic()
        self._seed_rngs()
        self.map.enable_spill(cfg.keyframe.max_in_memory)

        if cfg.profiling.enabled:
            self.gpu.start()

        # Constructed now, opened last. Opening the transport starts frames
        # flowing immediately, and loading the depth model takes seconds -- long
        # enough that a live source fills and overruns its buffer, and a short
        # recording can play out entirely, before anything is ready to consume
        # it. Everything else is initialised first so the very first frame
        # delivered is also the first frame tracked.
        self.source = build_source(cfg)

        self.depth = build_depth_estimator(cfg)
        self.depth.warmup()

        self.mapper = build_mapper(cfg)
        self.reintegrator = Reintegrator(
            self.mapper,
            ReintegrationPolicy(
                trans_threshold_m=cfg.fusion.reintegrate_trans_m,
                rot_threshold_deg=cfg.fusion.reintegrate_rot_deg,
                enabled=cfg.fusion.reintegrate_enabled,
                voxel_size_m=cfg.fusion.voxel_size_m,
                deterministic=(cfg.pipeline.mode == "sequential"),
            ),
        )

        intrinsics = (self.source.source_intrinsics or cfg.build_intrinsics()).scaled(
            cfg.source.track_width, cfg.source.track_height
        )
        self.vo = VisualOdometry(cfg, intrinsics, self.map, self._predict_depth)
        self.local_mapper = LocalMapper(
            cfg, self.map, self.depth, self.vo,
            on_keyframe=self._on_keyframe,
            on_loop_closure=self._on_loop_closure,
        )
        self.viewer = build_viewer(cfg)

        self.source.open()
        log.info("pipeline ready")

    def _seed_rngs(self) -> None:
        """Make runs repeatable as far as the chosen mode allows.

        OpenCV's RANSAC draws from a thread-local RNG and its operators are
        internally parallelised, so identical input still yields slightly
        different PnP results run to run. Seeding fixes the draw; pinning to one
        thread fixes the order. Both are only worth paying for in sequential
        mode, which exists precisely to be reproducible -- a live session wants
        the parallelism far more than it wants determinism.
        """
        import cv2

        cv2.setRNGSeed(int(self.cfg.seed))
        np.random.seed(int(self.cfg.seed))
        if self.cfg.pipeline.mode == "sequential":
            cv2.setNumThreads(1)
            log.info("sequential mode: OpenCV pinned to 1 thread, RNG seeded (%d)",
                     self.cfg.seed)

    def _predict_depth(self, image: np.ndarray, intrinsics,
                       frame_index: Optional[int] = None) -> np.ndarray:
        return self.depth.predict(image, intrinsics, frame_index)

    # -- stage bodies -------------------------------------------------------

    def _ingest_loop(self) -> None:
        """Pull frames from the transport into the tracking queue."""
        limiter = RateLimiter(self.cfg.source.target_fps
                              if self.cfg.source.kind in ("folder",) else 0)
        try:
            for frame in self.source.frames():
                if self.lifecycle.should_stop:
                    break
                t0 = time.perf_counter()
                self._frames_seen += 1
                if not self.q_track.put(frame) and self.cfg.source.strict_no_drop:
                    raise RuntimeError("frame dropped with strict_no_drop enabled")
                self.stats["ingest"].record(time.perf_counter() - t0)
                limiter.wait()
            reason = "stalled" if self.source.stalled else "end_of_stream"
        except Exception as exc:  # noqa: BLE001
            log.exception("ingest failed: %s", exc)
            self.lifecycle.info.error = str(exc)
            reason = "ingest_error"
        finally:
            self.q_track.close()
        if not self.lifecycle.should_stop:
            self.lifecycle.request_stop(reason)

    def _track_frame(self, frame: Frame):
        """Per-frame VO, plus the keyframe decision."""
        result = self.vo.process(frame)

        if result.state is TrackState.INITIALIZING:
            return None

        # Confidence gate (the one architectural fix that matters): only a
        # LOCKED pose earns the expensive path. Every softer variant was
        # measured on the synthetic harness and rejected:
        #   - down-weighted fusion of dead-reckoned keyframes -> phantom
        #     surfaces (low weight into empty space still creates geometry);
        #   - promoting them for landmark re-seeding without fusion -> wrong
        #     landmarks anchor PnP, tracking goes confidently wrong (41 cm
        #     median error vs 1.5 cm with the strict gate).
        # DEGRADED/LOST stretches therefore leave honest holes; shortening
        # them is relocalization's job, not fusion's -- which happens here:
        if result.state is not TrackState.TRACKING:
            if result.state is TrackState.LOST:
                self._attempt_relocalization(frame)
            self.q_viz.put(("frame", result))
            return None

        decision = self.keyframe_selector.evaluate(
            result.T_wc, frame.timestamp,
            median_depth=result.median_depth or 1.0,
            n_tracks=result.n_tracked,
            track_ratio=result.track_ratio,
            force=bool(result.extras.get("force_keyframe")),
        )

        self.q_viz.put(("frame", result))
        if decision.accept:
            result.extras["pose_conf"] = self._pose_confidence(result)
            if self.q_kf.full:
                # The mapper is saturated. Promoting anyway would run a depth
                # inference on this thread and then have the keyframe discarded
                # by the drop-oldest queue downstream -- paying the most
                # expensive step in the tracker's budget for nothing, and
                # slowing tracking while doing it. Skip instead, and let the
                # gate re-fire once the mapper drains; the accumulated motion
                # means the keyframe it picks then is the more useful one.
                self._kf_backpressure += 1
                self.keyframe_selector.reset_last_accepted()
                return None
            result.extras["kf_reason"] = decision.reason
            # Depth and landmark seeding happen here, on the tracker thread,
            # because seeding writes into the live feature arrays. See
            # LocalMapper for why doing it downstream breaks tracking.
            kf = self.local_mapper.build_keyframe(result)
            if kf is not None:
                self.q_kf.put(kf)
        return None

    def _pose_confidence(self, result) -> float:
        """Quantified pose trust in [0, 1] from measurables the tracker already
        produces. v1 deliberately simple: PnP inlier support relative to twice
        the acceptance floor. Feeds fusion down-weighting - a keyframe that
        scraped past PnP contributes geometry at reduced weight instead of
        stamping itself into the volume at full strength."""
        if result.state is TrackState.DEGRADED:
            return self.DEGRADED_POSE_CONF
        if result.state is not TrackState.TRACKING:
            return 0.0
        floor = max(1, 2 * self.cfg.tracking.pnp_min_inliers)
        return float(min(1.0, result.n_inliers / floor))

    #: Fusion weight for a keyframe promoted while DEGRADED (dead-reckoned
    #: pose): enough to fill coverage and re-seed landmarks, never enough to
    #: overwrite geometry laid down while tracking was locked.
    DEGRADED_POSE_CONF = 0.25

    #: Frames between relocalization attempts while LOST. ORB + BoW scoring +
    #: up-to-8 PnP solves is too heavy for every frame of a long blackout, and
    #: consecutive frames look alike anyway. Frame-count (not wall-clock) so
    #: sequential replays stay deterministic.
    RELOC_EVERY_N_FRAMES = 5

    def _attempt_relocalization(self, frame) -> bool:
        """Try to re-acquire the camera pose for a LOST frame.

        Place recognition against the keyframe database recovers a pose plus
        pixel<->world correspondences; those are seeded as landmarks *before*
        the tracker adopts the pose, because a pose with no landmarks under it
        just re-loses on the next frame. Runs on the tracker thread.
        """
        if frame.index - self._last_reloc_frame < self.RELOC_EVERY_N_FRAMES:
            return False
        self._last_reloc_frame = frame.index
        if self.map.n_keyframes == 0:
            return False

        gray = frame.ensure_gray()
        kps, desc = self.vo.compute_orb(gray)
        if desc is None:
            return False
        # Plausibility bound for the recovered pose, anchored at the loss
        # point. Two terms, take the larger:
        #   - 1.5x the extrapolated travel (pre-loss speed x frames lost);
        #     the speed estimate is unreliable (underestimates during the
        #     degraded run-up to a loss, can freeze near zero), so it cannot
        #     be the only term;
        #   - one median scene depth: appearance-ambiguity modes in a
        #     self-similar scene sit a scene-width apart (opposite walls),
        #     while legitimate blackout travel stays within the scene.
        # Measured on the synthetic room: correct relocs land <=1.4 m from the
        # loss point, wrong-wall modes >=3.6 m; scene depth ~2 m separates
        # them with margin. The deliberate cost: after a very long blackout in
        # a *self-similar* scene, a genuine far-away recovery is also rejected
        # and the map ends with an honest hole -- without an external prior
        # (MAVLink) that case is indistinguishable from the wrong-wall match.
        # The rotation gate does the discriminating (see relocalize's
        # docstring): the wrong mode of a self-similar scene can sit near the
        # loss point, but its orientation is wildly off the constant-velocity
        # prediction. Allowance grows with blackout length (prediction decays),
        # capped: past 90 deg any appearance match would be unfalsifiable.
        travel = self.vo.per_frame_speed_m * max(self.vo.lost_frames, 1)
        max_jump = max(0.5, 1.5 * travel, self.vo.median_scene_depth_m)
        max_rot = min(90.0, 45.0 + 1.5 * self.vo.lost_frames)
        hit = self.local_mapper.loop_closer.relocalize(
            desc, kps, self.map.keyframes, self.vo.K_obj,
            T_pred=self.vo.T_wc, T_loss=self.vo.pose_at_loss,
            max_jump_m=max_jump, max_rot_deg=max_rot)
        if hit is None:
            return False

        T_wc, anchor_id, px, world = hit
        h, w = frame.image.shape[:2]
        xs = np.clip(np.round(px[:, 0]).astype(int), 0, w - 1)
        ys = np.clip(np.round(px[:, 1]).astype(int), 0, h - 1)
        pids = self.map.add_points(world, frame.image[ys, xs], kf_id=anchor_id)
        self.vo.relocalize(T_wc, px, pids, gray=gray)
        return True

    def _map_keyframe(self, kf):
        kf = self.local_mapper.process(kf)
        if kf is None:
            return None

        # Scale anchoring runs here because it needs a settled pose.
        factor = self.scale_anchor.observe(kf.timestamp, kf.T_wc)
        if factor is not None and abs(factor - 1.0) > 1e-4:
            log.info("applying metric scale correction x%.4f", factor)
            self.map.rescale(factor)

        self.q_fuse.put(kf)
        self.q_viz.put(("keyframe", kf))
        return None

    def _fuse_keyframe(self, kf: Keyframe):
        if kf.depth is None:
            return None
        # Dead-reckoned keyframes exist to re-seed landmarks and let tracking
        # re-anchor - they NEVER touch the volume. Down-weighting was tried
        # and is not enough: into empty space even a low-weight integration
        # creates surface, and the phantom-geometry test catches it.
        if kf.pose_conf <= self.DEGRADED_POSE_CONF:
            return None
        wm = self.mapper.weight_map_for(kf.depth, kf.intrinsics, kf.depth_conf) \
            if hasattr(self.mapper, "weight_map_for") else None
        # Confidence-weighted integration: a marginal (but locked) pose still
        # contributes, at reduced weight against confident geometry.
        if kf.pose_conf < 1.0:
            wm = (wm * kf.pose_conf if wm is not None
                  else np.full(kf.depth.shape, kf.pose_conf, np.float32))
        self.mapper.integrate(kf.depth, kf.image, kf.T_wc, kf.intrinsics, wm)
        kf.fused_T_wc = kf.T_wc.copy()
        kf.is_fused = True
        self._fused_count += 1
        self.reintegrator.note_keyframe()
        self._mesh_dirty = True

        # Rebuild if optimization has moved the map away from what was fused.
        drift_t, drift_r = max_drift(self.map.all_keyframes())
        if self.reintegrator.should_rebuild(drift_t, drift_r):
            log.info("map drifted %.3f m / %.2f deg from the fused volume; rebuilding",
                     drift_t, drift_r)
            self.reintegrator.rebuild(
                [k for k in self.map.all_keyframes()
                 if k.pose_conf > self.DEGRADED_POSE_CONF],
                # Pose confidence survives rebuilds too - a loop closure
                # refines poses but does not resurrect trust in a keyframe
                # that was dead-reckoned when captured.
                weight_fn=lambda k: self.mapper.weight_map_for(
                    k.depth, k.intrinsics, k.depth_conf) * k.pose_conf,
            )
            self.local_mapper.clear_pending_correction()
            self._mesh_dirty = True
        return None

    def _viz_item(self, item):
        import cv2

        kind, payload = item
        if kind == "frame":
            r = payload
            self.viewer.log_frame(r.frame_index, r.timestamp, r.frame.image,
                                  r.T_wc, r.frame.intrinsics, r.state.value)
            if r.frame_index % 3 == 0:
                ok, buf = cv2.imencode(".jpg",
                                       cv2.cvtColor(r.frame.image, cv2.COLOR_RGB2BGR),
                                       [cv2.IMWRITE_JPEG_QUALITY, 80])
                if ok:
                    self.latest_frame_jpeg = buf.tobytes()
        elif kind == "keyframe":
            kf = payload
            if kf.depth is not None:
                d = kf.depth
                valid = d > 0
                if valid.any():
                    # Inverse depth reads better: near = bright, far = dark.
                    inv = np.zeros_like(d)
                    inv[valid] = 1.0 / d[valid]
                    hi = float(np.percentile(inv[valid], 98)) or 1.0
                    u8 = np.clip(inv / hi * 255.0, 0, 255).astype(np.uint8)
                    vis = cv2.applyColorMap(u8, cv2.COLORMAP_TURBO)
                    vis[~valid] = 0
                    ok, buf = cv2.imencode(".jpg", vis, [cv2.IMWRITE_JPEG_QUALITY, 80])
                    if ok:
                        self.latest_depth_jpeg = buf.tobytes()
            self.viewer.log_keyframe(kf)
            n_kf = self.map.n_keyframes
            if self._mesh_dirty and n_kf % max(1, self.cfg.viz.mesh_every_n_kf) == 0:
                try:
                    xyz, rgb = self.mapper.extract_point_cloud(
                        min_weight=self.cfg.fusion.min_extract_weight)
                    self.viewer.log_point_cloud(xyz, rgb)
                    self._mesh_dirty = False
                except Exception as exc:  # noqa: BLE001 - preview must never kill the run
                    log.debug("live preview failed: %s", exc)
            self.viewer.log_stats(self._scalar_metrics())
        return None

    # -- callbacks ----------------------------------------------------------

    def _on_keyframe(self, kf: Keyframe) -> None:
        log.debug("keyframe %d at frame %d", kf.kf_id, kf.frame_index)

    #: A stage that has erred this many times without one success in between
    #: is dead (CUDA OOM, kernel-launch failure), not digesting bad data.
    STAGE_DEAD_AFTER_ERRORS = 15

    def _on_stage_error(self, name: str, exc: BaseException) -> None:
        """Stage error policy: survive bad data, but stop a dead session.

        A single corrupt frame must not end a flight, so per-item errors are
        only counted. But a stage failing on *every* item -- no successes
        between errors -- means the session is silently producing nothing
        while /status reports running. That gets surfaced and stopped.
        """
        stage = next((s for s in self._threads if s.name == name), None)
        successes = stage.stats.count if stage is not None else 0
        errors, at_first = self._stage_err.get(name, (0, successes))
        if successes > at_first:  # progress since the streak began: reset
            errors, at_first = 0, successes
        errors += 1
        self._stage_err[name] = (errors, at_first)
        if errors >= self.STAGE_DEAD_AFTER_ERRORS and not self.lifecycle.should_stop:
            msg = f"stage {name} failed {errors}x in a row: {exc}"
            log.error("%s -- stopping the session", msg)
            self.lifecycle.info.error = msg
            self.lifecycle.request_stop(f"stage_failure:{name}")

    def _on_loop_closure(self, poses: dict, shift: float) -> None:
        traj = [poses[k] for k in sorted(poses)]
        self.viewer.reset_trajectory(traj)
        log.info("loop closure moved the trajectory by up to %.3f m", shift)

    # -- run ----------------------------------------------------------------

    def run(self) -> dict:
        """Run one session start-to-finish. Blocks until the stream ends.

        Single-use: queues cannot reopen once closed, so a second run() on the
        same instance would start stages that exit instantly. Construct a fresh
        DroneMapApp per session (the Supervisor already does).
        """
        with self._export_lock:
            if self._used:
                raise RuntimeError(
                    "DroneMapApp is single-use; construct a new one per session")
            self._used = True

        self.lifecycle.install_signal_handlers()

        if self.cfg.control.enabled:
            from .control.server import ControlServer

            self.control = ControlServer(self, self.cfg.control.host, self.cfg.control.port)
            self.control.start()

        try:
            started = self.lifecycle.start()
        except Exception as exc:  # noqa: BLE001
            log.error("startup failed: %s", exc)
            self.lifecycle.info.state = SessionState.FAILED
            # Release whatever _on_start managed to build (camera handle,
            # depth model VRAM, GPU monitor, control server) -- re-raising
            # without this leaked the whole half-started session, invisibly
            # so under --serve where run() lives on a daemon thread.
            try:
                self._shutdown()
            except Exception:  # noqa: BLE001
                log.exception("cleanup after failed startup also failed")
            raise
        if not started:
            # A stop request beat the startup thread; honor it.
            self._shutdown()
            return self._last_export

        if self.cfg.pipeline.mode == "sequential":
            try:
                self._run_sequential()
            except KeyboardInterrupt:
                log.warning("interrupted")
                self.lifecycle.request_stop("keyboard_interrupt")
            finally:
                self._shutdown()
            return self._last_export

        self._threads = [
            Stage(name, fn, q, None,
                  on_error=lambda exc, n=name: self._on_stage_error(n, exc))
            for name, fn, q in (
                ("tracker", self._track_frame, self.q_track),
                ("mapper", self._map_keyframe, self.q_kf),
                ("fusion", self._fuse_keyframe, self.q_fuse),
                ("viz", self._viz_item, self.q_viz),
            )
        ]
        for st in self._threads:
            st.start()

        self._ingest_thread = threading.Thread(target=self._ingest_loop,
                                               name="ingest", daemon=True)
        self._ingest_thread.start()

        try:
            self._supervise()
        except KeyboardInterrupt:
            log.warning("interrupted")
            self.lifecycle.request_stop("keyboard_interrupt")
        finally:
            self._shutdown()
        return self._last_export

    def _run_sequential(self) -> None:
        """Single-threaded pass: every stage completes before the next frame.

        For replay, benchmarking and the self-test, where reproducibility matters
        more than latency. It deliberately calls the same stage functions as the
        threaded path, so the two cannot drift apart in behaviour.
        """
        log.info("sequential mode: deterministic, not suitable for live input")
        last_log = time.monotonic()
        try:
            for frame in self.source.frames():
                if self.lifecycle.should_stop:
                    break
                self._frames_seen += 1

                t0 = time.perf_counter()
                result = self.vo.process(frame)
                self.stats["tracker"].record(time.perf_counter() - t0)

                if result.state is TrackState.LOST:
                    self._attempt_relocalization(frame)
                if result.state is TrackState.TRACKING:
                    decision = self.keyframe_selector.evaluate(
                        result.T_wc, frame.timestamp,
                        median_depth=result.median_depth or 1.0,
                        n_tracks=result.n_tracked,
                        track_ratio=result.track_ratio,
                        force=bool(result.extras.get("force_keyframe")),
                    )
                    if decision.accept:
                        result.extras["kf_reason"] = decision.reason
                        result.extras["pose_conf"] = self._pose_confidence(result)
                        t0 = time.perf_counter()
                        kf = self.local_mapper.build_keyframe(result)
                        if kf is not None:
                            self.local_mapper.process(kf)
                            self.stats["mapper"].record(time.perf_counter() - t0)

                            factor = self.scale_anchor.observe(kf.timestamp, kf.T_wc)
                            if factor is not None and abs(factor - 1.0) > 1e-4:
                                self.map.rescale(factor)

                            t0 = time.perf_counter()
                            self._fuse_keyframe(kf)
                            self.stats["fusion"].record(time.perf_counter() - t0)
                            self._viz_item(("keyframe", kf))
                    self._viz_item(("frame", result))

                if (self.cfg.profiling.enabled and
                        time.monotonic() - last_log > self.cfg.profiling.log_interval_s):
                    self._log_progress()
                    last_log = time.monotonic()
            reason = "stalled" if self.source.stalled else "end_of_stream"
        except Exception as exc:  # noqa: BLE001
            log.exception("sequential run failed: %s", exc)
            self.lifecycle.info.error = str(exc)
            reason = "error"
        if not self.lifecycle.should_stop:
            self.lifecycle.request_stop(reason)

    def _supervise(self) -> None:
        """Main-thread loop: periodic logging until the session ends."""
        interval = max(self.cfg.profiling.log_interval_s, 1.0)
        while not self.lifecycle.should_stop:
            if self.lifecycle.wait_for_stop(interval):
                break
            if self.cfg.profiling.enabled:
                self._log_progress()

    def _shutdown(self) -> None:
        log.info("shutting down pipeline...")
        if self.reintegrator is not None:
            self.reintegrator.cancel.set()
        if self.source is not None:
            self.source.close()
        self.q_track.close()

        if self._ingest_thread is not None:
            self._ingest_thread.join(timeout=5)

        # Drain in pipeline order so in-flight keyframes still reach fusion
        # rather than being discarded at the end of a run. "Drained" means the
        # queue is empty AND its consumer is idle -- queue length alone misses
        # the item being processed right now, whose output would land in an
        # already-closed downstream queue.
        stage_by_name = {st.name: st for st in self._threads}
        for name, queue in (("tracker", self.q_track), ("mapper", self.q_kf),
                            ("fusion", self.q_fuse), ("viz", self.q_viz)):
            consumer = stage_by_name.get(name)
            deadline = time.monotonic() + 30
            while ((len(queue) or (consumer is not None and consumer.busy))
                   and time.monotonic() < deadline):
                time.sleep(0.05)
            queue.close()

        for st in self._threads:
            st.stop()
        for st in self._threads:
            st.join(timeout=10)
            if st.is_alive():
                log.warning("stage %s did not stop cleanly", st.name)

        self.lifecycle.run_stop()
        self.lifecycle.restore_signal_handlers()

    def _on_stop(self, reason: str) -> None:
        """Stop hook: export the map, then release resources."""
        if self.cfg.control.auto_export_on_stop and self.map.n_keyframes > 0:
            self.lifecycle.info.state = SessionState.EXPORTING
            try:
                self._last_export = self.export_now()
                self.lifecycle.info.export_manifest = self._last_export
            except Exception as exc:  # noqa: BLE001
                log.exception("export failed: %s", exc)
                self.lifecycle.info.error = str(exc)
        else:
            log.info("nothing to export (reason=%s, keyframes=%d)",
                     reason, self.map.n_keyframes)

        if self.mapper is not None:
            try:
                self.final_cloud = self.mapper.extract_point_cloud(
                    min_weight=self.cfg.fusion.min_extract_weight)
            except Exception as exc:  # noqa: BLE001
                log.warning("could not capture the final point cloud: %s", exc)

        self.gpu.stop()
        self.scale_anchor.close()
        if self.depth is not None:
            self.depth.close()
        if self.mapper is not None:
            # Never free CUDA buffers under a live fusion thread: a stage that
            # missed its join (e.g. mid-reintegration) would fault on freed
            # memory. Leaking until process exit is strictly better.
            fusion = next((s for s in self._threads if s.name == "fusion"), None)
            if fusion is not None and fusion.is_alive():
                fusion.join(timeout=30)
            if fusion is not None and fusion.is_alive():
                log.error("fusion thread still running after 30s; leaving the "
                          "TSDF volume allocated rather than freeing it "
                          "under a live kernel")
            else:
                self.mapper.close()
        if self.viewer is not None:
            self.viewer.close()
        if self.control is not None:
            self.control.stop()
        # After the final export nothing reads spilled payloads again.
        self.map.release_spill()
        self._log_progress(final=True)

    # -- public API used by the control server ------------------------------

    def request_start(self, device: str | None = None) -> None:
        if self._used:
            raise RuntimeError(
                "this session has already run; restart the process (or use "
                "--serve, which builds a fresh session per start)")
        if device:
            self.cfg.source.uri = device
            self.cfg.source.kind = "v4l2"
        threading.Thread(target=self.run, name="session", daemon=True).start()

    def export_now(self) -> dict:
        """Export the current map. Safe to call at any time from any thread."""
        from .export.session import export_session

        if self.mapper is None:
            raise RuntimeError(
                "no map to export: the pipeline is still initialising "
                f"(state={self.lifecycle.info.state.value})"
            )
        with self._export_lock:
            return export_session(self.cfg, self.mapper, self.map,
                                  report=self.metrics())

    def trajectory(self) -> dict:
        """Keyframe path + latest camera pose, for the panel's 3D pane."""
        if self.map is None or self.map.n_keyframes == 0:
            return {"traj": [], "last_T": None}
        kfs = self.map.all_keyframes()
        return {"traj": [kf.T_wc[:3, 3].tolist() for kf in kfs],
                "last_T": kfs[-1].T_wc.tolist()}

    def preview_points(self, max_points: int = 50000):
        if self.mapper is None:
            return np.zeros((0, 3), np.float32), None
        try:
            xyz, rgb = self.mapper.extract_point_cloud(
                min_weight=self.cfg.fusion.min_extract_weight)
        except AttributeError:
            # The panel polls while a stopping session tears the mapper down;
            # an empty preview is the correct answer, not a 500.
            return np.zeros((0, 3), np.float32), None
        if len(xyz) > max_points:
            step = int(np.ceil(len(xyz) / max_points))
            xyz, rgb = xyz[::step], rgb[::step]
        return xyz, rgb

    def status(self) -> dict:
        st = self.lifecycle.status()
        st.update({
            "frames": self._frames_seen,
            "keyframes": self.map.n_keyframes,
            "landmarks": self.map.n_points,
            "tracking_state": self.vo.state.value if self.vo else "n/a",
        })
        return st

    def metrics(self) -> dict:
        m: dict = {
            "session": self.status(),
            "stages": {k: v.summary() for k, v in self.stats.items()},
            "thread_stages": {st.name: st.stats.summary() for st in self._threads},
            "queues": {q.stats["name"]: q.stats
                       for q in (self.q_track, self.q_kf, self.q_fuse, self.q_viz)},
            "keyframe_gate": dict(self.keyframe_selector.stats,
                                  skipped_backpressure=self._kf_backpressure),
            "map": self.map.stats(),
            "scale": self.scale_anchor.stats,
            "gpu": self.gpu.summary(),
        }
        m["gpu"].update(self.gpu.torch_summary())
        if self.mapper is not None:
            fs = self.mapper.stats
            m["fusion"] = {
                "integrations": fs.integrations,
                "blocks": fs.blocks_allocated,
                "capacity": fs.blocks_capacity,
                "occupancy": round(fs.occupancy, 4),
                "vram_mb": round(fs.vram_mb, 1),
                "last_ms": round(fs.last_integrate_ms, 2),
                "overflows": fs.overflow_events,
            }
        if self.local_mapper is not None:
            s = self.local_mapper.stats
            m["mapping"] = {
                "keyframes": s.keyframes, "ba_runs": s.ba_runs,
                "ba_ms": round(s.ba_ms, 1), "depth_ms": round(s.depth_ms, 1),
                "loops": s.loops_found, "align_scale": round(s.align_scale, 4),
                "align_points": s.align_points, "culled": s.culled_landmarks,
            }
            m["loop_closure"] = self.local_mapper.loop_closer.stats
        if self.reintegrator is not None:
            m["reintegration"] = self.reintegrator.stats
        return m

    def _scalar_metrics(self) -> dict:
        m = self.metrics()
        out = {
            "keyframes": m["session"]["keyframes"],
            "landmarks": m["session"]["landmarks"],
            "frames": m["session"]["frames"],
        }
        if "fusion" in m:
            out["tsdf_blocks"] = m["fusion"]["blocks"]
        if m["gpu"].get("available"):
            out["vram_used_mb"] = m["gpu"]["used_mb"]
        for name, st in m["thread_stages"].items():
            out[f"fps_{name}"] = st["fps"]
        return out

    def _log_progress(self, final: bool = False) -> None:
        elapsed = max(time.monotonic() - self._start_time, 1e-9)
        sources = self._threads or [
            _StatView(name, st) for name, st in self.stats.items() if st.count
        ]
        stages = " ".join(
            f"{s.name}={s.stats.fps:.1f}fps/{s.stats.ms_p95:.0f}ms" for s in sources
        )
        gpu = self.gpu.summary()
        vram = (f"{gpu['used_mb']:.0f}/{gpu['total_mb']:.0f}MB" if gpu.get("available")
                else "n/a")
        drops = self.q_track.dropped
        log.info(
            "%s t=%.0fs frames=%d (%.1f fps, %d dropped) kf=%d lm=%d | %s | vram %s",
            "FINAL" if final else "PROGRESS", elapsed, self._frames_seen,
            self._frames_seen / elapsed, drops, self.map.n_keyframes,
            self.map.n_points, stages, vram,
        )
