"""Viser viewer: browser-based alternative to Rerun.

Useful when the operator is on another machine and cannot install a viewer --
viser serves a web page, so a ground station only needs a browser. It is a
polling viewer rather than a streaming one, so it carries less history than
Rerun; the pipeline treats them interchangeably through the same interface.
"""

from __future__ import annotations

import logging
from typing import Optional

import numpy as np

from ..config import Config
from ..types import Keyframe

log = logging.getLogger(__name__)


class ViserViewer:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.vcfg = cfg.viz
        self.enabled = False
        self._traj: list[np.ndarray] = []
        self._kf_count = 0
        self._frame_count = 0
        try:
            import viser
        except ImportError:
            log.warning("viser not installed; live visualisation disabled "
                        "(pip install viser)")
            return
        self.server = viser.ViserServer(port=self.vcfg.serve_port)
        self._viser = viser
        self.enabled = True
        log.info("viser viewer on http://localhost:%d", self.vcfg.serve_port)

    def log_frame(self, index, timestamp, image, T_wc, intrinsics, state="tracking"):
        if not self.enabled:
            return
        self._frame_count += 1
        self._traj.append(np.asarray(T_wc)[:3, 3].copy())
        if len(self._traj) >= 2:
            pts = np.array(self._traj, np.float32)
            self.server.scene.add_spline_catmull_rom(
                "/trajectory", pts, color=(0.3, 0.8, 1.0), line_width=2.0)
        if self._frame_count % max(1, self.vcfg.image_every_n) == 0:
            self.server.scene.add_camera_frustum(
                "/camera", fov=2 * np.arctan(intrinsics.height / (2 * intrinsics.fy)),
                aspect=intrinsics.width / intrinsics.height, scale=0.15,
                image=image, wxyz=_quat(T_wc), position=T_wc[:3, 3])

    def log_keyframe(self, kf: Keyframe) -> None:
        if not self.enabled or not self.vcfg.show_frusta:
            return
        self._kf_count += 1
        K = kf.intrinsics
        self.server.scene.add_camera_frustum(
            f"/keyframes/{kf.kf_id}",
            fov=2 * np.arctan(K.height / (2 * K.fy)),
            aspect=K.width / K.height, scale=0.08,
            color=(1.0, 0.7, 0.2), wxyz=_quat(kf.T_wc), position=kf.T_wc[:3, 3])

    def log_point_cloud(self, xyz, rgb=None) -> None:
        if not self.enabled or len(xyz) == 0:
            return
        if len(xyz) > self.vcfg.max_points_preview:
            step = int(np.ceil(len(xyz) / self.vcfg.max_points_preview))
            xyz, rgb = xyz[::step], (rgb[::step] if rgb is not None else None)
        self.server.scene.add_point_cloud(
            "/surface", points=xyz.astype(np.float32),
            colors=(rgb if rgb is not None else np.full((len(xyz), 3), 200, np.uint8)),
            point_size=self.cfg.fusion.voxel_size_m * 0.8)

    def log_landmarks(self, xyz, rgb=None) -> None:
        if not self.enabled or len(xyz) == 0:
            return
        self.server.scene.add_point_cloud(
            "/landmarks", points=np.asarray(xyz, np.float32),
            colors=(rgb if rgb is not None else np.full((len(xyz), 3), 80, np.uint8)),
            point_size=0.02)

    def log_mesh(self, verts, faces, colors=None) -> None:
        if not self.enabled or len(verts) == 0:
            return
        self.server.scene.add_mesh_simple(
            "/mesh", vertices=np.asarray(verts, np.float32),
            faces=np.asarray(faces, np.uint32))

    def log_loop_closure(self, a, b) -> None:
        if not self.enabled:
            return
        self.server.scene.add_spline_catmull_rom(
            f"/loops/{self._kf_count}",
            np.array([a[:3, 3], b[:3, 3]], np.float32),
            color=(1.0, 0.4, 0.1), line_width=3.0)

    def log_stats(self, stats: dict) -> None:
        pass

    def reset_trajectory(self, poses) -> None:
        self._traj = [np.asarray(T)[:3, 3].copy() for T in poses]

    def close(self) -> None:
        if self.enabled:
            try:
                self.server.stop()
            except Exception:  # noqa: BLE001
                pass


def _quat(T: np.ndarray) -> tuple[float, float, float, float]:
    """Rotation matrix -> (w, x, y, z), the ordering viser expects."""
    R = np.asarray(T)[:3, :3]
    tr = np.trace(R)
    if tr > 0:
        s = np.sqrt(tr + 1.0) * 2
        return (0.25 * s, (R[2, 1] - R[1, 2]) / s,
                (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s)
    i = int(np.argmax(np.diag(R)))
    if i == 0:
        s = np.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2]) * 2
        return ((R[2, 1] - R[1, 2]) / s, 0.25 * s,
                (R[0, 1] + R[1, 0]) / s, (R[0, 2] + R[2, 0]) / s)
    if i == 1:
        s = np.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2]) * 2
        return ((R[0, 2] - R[2, 0]) / s, (R[0, 1] + R[1, 0]) / s,
                0.25 * s, (R[1, 2] + R[2, 1]) / s)
    s = np.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1]) * 2
    return ((R[1, 0] - R[0, 1]) / s, (R[0, 2] + R[2, 0]) / s,
            (R[1, 2] + R[2, 1]) / s, 0.25 * s)
