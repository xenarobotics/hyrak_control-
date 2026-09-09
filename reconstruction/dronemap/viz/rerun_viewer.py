"""Live visualisation via Rerun.

Rerun is used rather than Open3D's window because its viewer is a **separate
process**: on an 8 GB card, an in-process GL viewer competes for exactly the
VRAM the TSDF volume needs, and a visualisation stall would block the mapping
thread. It also serves over the network, so a ground station can watch a flight
without running the pipeline.

Everything logged here is throttled. Visualisation must never become the reason
the pipeline misses frames.
"""

from __future__ import annotations

import logging
from typing import Optional

import numpy as np

from ..config import Config
from ..types import Keyframe, se3_inv

log = logging.getLogger(__name__)


class RerunViewer:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.vcfg = cfg.viz
        self._enabled = False
        self._frame_count = 0
        self._kf_count = 0
        self._traj: list[np.ndarray] = []
        self._rr = None

        try:
            import rerun as rr
        except ImportError:
            log.warning("rerun-sdk not installed; live visualisation disabled")
            return

        self._rr = rr
        # Spawning needs the `rerun` binary on PATH, which it is not when the
        # pipeline is launched with the venv's interpreter but without the venv
        # activated. A missing viewer must not take the reconstruction with it:
        # fall back to a non-spawning recording so the session still runs.
        try:
            rr.init(f"dronemap:{cfg.session_name}", spawn=self.vcfg.spawn_viewer)
        except Exception as exc:  # noqa: BLE001
            if not self.vcfg.spawn_viewer:
                raise
            log.warning(
                "could not spawn the rerun viewer (%s); continuing without it. "
                "Put the venv's bin/ on PATH, or set viz.serve=true and connect "
                "a viewer manually.",
                exc,
            )
            rr.init(f"dronemap:{cfg.session_name}", spawn=False)
        if self.vcfg.serve:
            self._start_server(rr)

        # Right-handed, Y-down: matches the OpenCV camera convention used
        # throughout, so the viewer's world axes agree with the poses.
        try:
            rr.log("world", rr.ViewCoordinates.RIGHT_HAND_Y_DOWN, static=True)
        except Exception:  # noqa: BLE001
            pass
        self._enabled = True
        log.info("rerun viewer ready")

    def _start_server(self, rr) -> None:
        """Expose the stream to remote viewers.

        The serving API was renamed across rerun releases (`serve_web` ->
        `serve_grpc`), so probe rather than pin to one spelling and strand the
        user on whichever version pip resolved.
        """
        port = self.vcfg.serve_port
        for name, kwargs in (
            ("serve_grpc", {"grpc_port": port}),
            ("serve_web", {"open_browser": False, "web_port": port}),
            ("serve", {"open_browser": False, "web_port": port}),
        ):
            fn = getattr(rr, name, None)
            if fn is None:
                continue
            try:
                fn(**kwargs)
                log.info("rerun %s listening on port %d", name, port)
                return
            except Exception as exc:  # noqa: BLE001
                log.debug("rerun %s failed: %s", name, exc)
        log.warning("no usable rerun serving API found; local viewer only")

    @property
    def enabled(self) -> bool:
        return self._enabled

    def _t(self, index: int, timestamp: float) -> None:
        rr = self._rr
        try:
            rr.set_time("frame", sequence=index)
            rr.set_time("time", duration=timestamp)
        except (AttributeError, TypeError):
            # Older rerun API.
            try:
                rr.set_time_sequence("frame", index)
                rr.set_time_seconds("time", timestamp)
            except Exception:  # noqa: BLE001
                pass

    def log_frame(self, index: int, timestamp: float, image: np.ndarray,
                  T_wc: np.ndarray, intrinsics, state: str = "tracking") -> None:
        if not self._enabled:
            return
        rr = self._rr
        self._frame_count += 1
        self._t(index, timestamp)

        self._traj.append(T_wc[:3, 3].copy())
        if len(self._traj) >= 2:
            rr.log("world/trajectory",
                   rr.LineStrips3D([np.array(self._traj, np.float32)],
                                   colors=[[80, 200, 255]], radii=0.01))

        rr.log("world/camera", _transform(rr, T_wc))
        rr.log("world/camera/image",
               rr.Pinhole(focal_length=[intrinsics.fx, intrinsics.fy],
                          principal_point=[intrinsics.cx, intrinsics.cy],
                          width=intrinsics.width, height=intrinsics.height))
        if self._frame_count % max(1, self.vcfg.image_every_n) == 0:
            rr.log("world/camera/image", rr.Image(image))
        rr.log("stats/state", rr.TextLog(state))

    def log_keyframe(self, kf: Keyframe) -> None:
        if not self._enabled:
            return
        rr = self._rr
        self._kf_count += 1
        self._t(kf.frame_index, kf.timestamp)
        if self.vcfg.show_frusta:
            path = f"world/keyframes/{kf.kf_id}"
            rr.log(path, _transform(rr, kf.T_wc))
            rr.log(path, rr.Pinhole(
                focal_length=[kf.intrinsics.fx, kf.intrinsics.fy],
                principal_point=[kf.intrinsics.cx, kf.intrinsics.cy],
                width=kf.intrinsics.width, height=kf.intrinsics.height,
            ))
        if kf.depth is not None:
            rr.log("keyframe/depth", rr.DepthImage(kf.depth, meter=1.0))

    def log_landmarks(self, xyz: np.ndarray, rgb: Optional[np.ndarray] = None) -> None:
        if not self._enabled or len(xyz) == 0:
            return
        xyz, rgb = self._decimate(xyz, rgb, self.vcfg.max_points_preview)
        self._rr.log("world/landmarks",
                     self._rr.Points3D(xyz.astype(np.float32),
                                       colors=rgb, radii=0.015))

    def log_point_cloud(self, xyz: np.ndarray, rgb: Optional[np.ndarray] = None) -> None:
        if not self._enabled or len(xyz) == 0:
            return
        xyz, rgb = self._decimate(xyz, rgb, self.vcfg.max_points_preview)
        self._rr.log("world/surface",
                     self._rr.Points3D(xyz.astype(np.float32), colors=rgb, radii=0.01))

    def log_mesh(self, verts: np.ndarray, faces: np.ndarray,
                 colors: Optional[np.ndarray] = None) -> None:
        if not self._enabled or len(verts) == 0 or len(faces) == 0:
            return
        try:
            self._rr.log("world/mesh", self._rr.Mesh3D(
                vertex_positions=verts.astype(np.float32),
                triangle_indices=faces.astype(np.uint32),
                vertex_colors=colors,
            ))
        except Exception as exc:  # noqa: BLE001
            log.debug("mesh logging failed: %s", exc)

    def log_loop_closure(self, a: np.ndarray, b: np.ndarray) -> None:
        if not self._enabled:
            return
        self._rr.log("world/loops", self._rr.LineStrips3D(
            [np.array([a[:3, 3], b[:3, 3]], np.float32)],
            colors=[[255, 120, 40]], radii=0.02))

    def log_stats(self, stats: dict) -> None:
        if not self._enabled:
            return
        for key, value in stats.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                try:
                    self._rr.log(f"stats/{key}", self._rr.Scalars(float(value)))
                except Exception:  # noqa: BLE001
                    try:
                        self._rr.log(f"stats/{key}", self._rr.Scalar(float(value)))
                    except Exception:  # noqa: BLE001
                        pass

    def reset_trajectory(self, poses: list[np.ndarray]) -> None:
        """Redraw the trajectory after loop closure moved every keyframe."""
        self._traj = [T[:3, 3].copy() for T in poses]

    @staticmethod
    def _decimate(xyz, rgb, limit):
        if len(xyz) <= limit:
            return xyz, rgb
        # Deterministic stride, not random choice: a stable subset avoids the
        # shimmering that random resampling produces between frames.
        step = int(np.ceil(len(xyz) / limit))
        return xyz[::step], (rgb[::step] if rgb is not None else None)

    def close(self) -> None:
        """Flush pending log messages before the process exits.

        Without this the SDK's background sink is torn down mid-send and prints
        "gRPC connection severed" after an otherwise clean shutdown.
        """
        if not self._enabled:
            return
        for name in ("flush", "disconnect"):
            fn = getattr(self._rr, name, None)
            if fn is None:
                continue
            try:
                fn(blocking=True) if name == "flush" else fn()
            except Exception:  # noqa: BLE001
                pass
        self._enabled = False


def _transform(rr, T_wc: np.ndarray):
    return rr.Transform3D(translation=T_wc[:3, 3].astype(np.float32),
                          mat3x3=T_wc[:3, :3].astype(np.float32))


def build_viewer(cfg: Config):
    if cfg.viz.backend == "none":
        return NullViewer()
    if cfg.viz.backend == "rerun":
        viewer = RerunViewer(cfg)
        return viewer if viewer.enabled else NullViewer()
    if cfg.viz.backend == "viser":
        from .viser_viewer import ViserViewer

        return ViserViewer(cfg)
    return NullViewer()


class NullViewer:
    """No-op viewer, so callers never need to check whether viz is enabled."""

    enabled = False

    def __getattr__(self, name):
        def _noop(*args, **kwargs):
            return None
        return _noop
