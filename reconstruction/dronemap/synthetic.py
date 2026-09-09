"""Deterministic synthetic scene with exact ground truth.

An analytic ray tracer over axis-aligned boxes. No OpenGL, no EGL, no dataset
download -- which means the end-to-end correctness test runs anywhere, including
headless CI, and is byte-reproducible from a seed.

It emits exactly what the pipeline needs to be graded against:

* RGB frames with dense high-frequency texture (KLT needs real corners; a
  smooth-shaded render would silently make tracking look better than it is)
* metrically exact depth maps
* ground-truth camera poses
* the ground-truth surface, as a point sample, for reconstruction accuracy

Geometry is a closed room (rendered from the inside) plus interior boxes, so the
scene has occlusion boundaries and genuine parallax rather than a single plane.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Iterator, Optional

import numpy as np

from .types import CameraIntrinsics, so3_exp

log = logging.getLogger(__name__)


@dataclass
class Box:
    """Axis-aligned box. ``interior=True`` means the camera lives inside it."""

    lo: np.ndarray
    hi: np.ndarray
    interior: bool = False
    texture_seed: int = 0
    base_color: tuple[float, float, float] = (0.7, 0.7, 0.7)


def _make_texture(seed: int, size: int = 512) -> np.ndarray:
    """Procedural texture: multi-octave value noise + a checker + speckle.

    The speckle layer is deliberate -- it supplies isolated high-contrast corners
    at pixel scale, which is what Shi-Tomasi actually keys on.
    """
    rng = np.random.default_rng(seed)
    img = np.zeros((size, size), np.float32)
    for octave in range(4):
        n = 4 << octave
        coarse = rng.random((n, n)).astype(np.float32)
        idx = (np.arange(size) * n // size)
        img += coarse[np.ix_(idx, idx)] / (octave + 1.5)
    checker = (((np.arange(size)[:, None] // 64) + (np.arange(size)[None, :] // 64)) % 2)
    img = img * 0.75 + checker * 0.25
    speckle = rng.random((size, size)) < 0.02
    img[speckle] = rng.random(int(speckle.sum())).astype(np.float32)
    img -= img.min()
    img /= max(img.max(), 1e-6)
    return img


class SyntheticScene:
    """A textured box world that can be ray-traced from any pose."""

    def __init__(self, seed: int = 0, room: tuple[float, float, float] = (12.0, 6.0, 8.0)) -> None:
        self.seed = seed
        rng = np.random.default_rng(seed)
        w, h, d = room
        self.room = np.array([[-w / 2, -h / 2, -d / 2], [w / 2, h / 2, d / 2]])
        self.boxes: list[Box] = [
            Box(self.room[0], self.room[1], interior=True, texture_seed=seed,
                base_color=(0.80, 0.78, 0.72))
        ]
        # Interior clutter: creates occlusions, depth discontinuities and the
        # parallax that separates real tracking from pure-rotation guessing.
        palette = [(0.85, 0.35, 0.30), (0.30, 0.55, 0.85), (0.35, 0.75, 0.45),
                   (0.90, 0.75, 0.25), (0.65, 0.45, 0.80)]
        for i in range(9):
            size = rng.uniform(0.5, 1.8, size=3)
            centre = np.array([
                rng.uniform(-w / 2 + 1.5, w / 2 - 1.5),
                rng.uniform(-h / 2 + 0.4, h / 2 - 1.5),
                rng.uniform(-d / 2 + 1.5, d / 2 - 1.5),
            ])
            self.boxes.append(
                Box(centre - size / 2, centre + size / 2, interior=False,
                    texture_seed=seed * 100 + i + 1,
                    base_color=palette[i % len(palette)])
            )
        self._textures = {b.texture_seed: _make_texture(b.texture_seed) for b in self.boxes}

    # -- rendering ----------------------------------------------------------

    def render(
        self, T_wc: np.ndarray, K: CameraIntrinsics
    ) -> tuple[np.ndarray, np.ndarray]:
        """Render (rgb uint8 HxWx3, depth float32 HxW metres) from a pose."""
        h, w = K.height, K.width
        # Ray directions in camera frame (OpenCV: +x right, +y down, +z forward).
        u, v = np.meshgrid(np.arange(w, dtype=np.float64), np.arange(h, dtype=np.float64))
        dirs_cam = np.stack(
            [(u - K.cx) / K.fx, (v - K.cy) / K.fy, np.ones_like(u)], axis=-1
        )
        dirs_cam /= np.linalg.norm(dirs_cam, axis=-1, keepdims=True)
        R, origin = T_wc[:3, :3], T_wc[:3, 3]
        dirs = dirs_cam.reshape(-1, 3) @ R.T
        origins = np.broadcast_to(origin, dirs.shape)

        best_t = np.full(len(dirs), np.inf)
        best_face = np.full(len(dirs), -1, np.int8)
        best_box = np.full(len(dirs), -1, np.int16)

        for bi, box in enumerate(self.boxes):
            t, face = _ray_box(origins, dirs, box.lo, box.hi, box.interior)
            hit = np.isfinite(t) & (t > 1e-4) & (t < best_t)
            best_t[hit] = t[hit]
            best_face[hit] = face[hit]
            best_box[hit] = bi

        points = origins + dirs * best_t[:, None]
        rgb = self._shade(points, best_box, best_face, dirs)

        # Depth is the z-component along the optical axis, not the ray length --
        # that is what a real depth sensor and every projection formula assume.
        depth = (best_t.reshape(h, w) * dirs_cam[..., 2]).astype(np.float32)
        depth[~np.isfinite(depth)] = 0.0
        return rgb.reshape(h, w, 3), depth

    def _shade(
        self, points: np.ndarray, box_idx: np.ndarray, face: np.ndarray, dirs: np.ndarray
    ) -> np.ndarray:
        out = np.zeros((len(points), 3), np.uint8)
        for bi, box in enumerate(self.boxes):
            m = box_idx == bi
            if not m.any():
                continue
            tex = self._textures[box.texture_seed]
            p, f = points[m], face[m]
            # Project onto the two axes tangent to the hit face.
            uv = np.zeros((len(p), 2))
            for axis in range(3):
                sel = (f % 3) == axis
                if not sel.any():
                    continue
                a, b = (axis + 1) % 3, (axis + 2) % 3
                uv[sel, 0] = p[sel, a]
                uv[sel, 1] = p[sel, b]
            ts = tex.shape[0]
            ui = (np.mod(uv[:, 0] * 48.0, ts)).astype(np.int32) % ts
            vi = (np.mod(uv[:, 1] * 48.0, ts)).astype(np.int32) % ts
            val = tex[vi, ui]
            # Simple Lambert on the face normal so faces are distinguishable.
            normal = np.zeros((len(p), 3))
            normal[np.arange(len(p)), np.clip(f % 3, 0, 2)] = np.where(f < 3, -1.0, 1.0)
            lambert = 0.55 + 0.45 * np.abs((normal * dirs[m]).sum(axis=1))
            shade = np.clip(val * 0.65 + 0.35, 0, 1) * lambert
            col = np.array(box.base_color)[None, :] * shade[:, None]
            out[m] = np.clip(col * 255.0, 0, 255).astype(np.uint8)
        return out

    # -- ground truth surface ----------------------------------------------

    def sample_surface(self, n_per_face: int = 20000, seed: int = 0) -> np.ndarray:
        """Uniform point sample of every visible surface, for accuracy scoring."""
        rng = np.random.default_rng(seed)
        pts = []
        for box in self.boxes:
            lo, hi = box.lo, box.hi
            for axis in range(3):
                a, b = (axis + 1) % 3, (axis + 2) % 3
                for side in (lo[axis], hi[axis]):
                    p = np.zeros((n_per_face, 3))
                    p[:, axis] = side
                    p[:, a] = rng.uniform(lo[a], hi[a], n_per_face)
                    p[:, b] = rng.uniform(lo[b], hi[b], n_per_face)
                    pts.append(p)
        return np.concatenate(pts)


def _ray_box(
    origins: np.ndarray, dirs: np.ndarray, lo: np.ndarray, hi: np.ndarray, interior: bool
) -> tuple[np.ndarray, np.ndarray]:
    """Slab-method ray/AABB intersection.

    Returns (t, face) where face is 0..2 for the low faces and 3..5 for the high
    faces. For ``interior`` boxes the *exit* intersection is returned, which is
    what a camera inside a room sees.
    """
    with np.errstate(divide="ignore", invalid="ignore"):
        inv = 1.0 / dirs
        t_lo = (lo - origins) * inv
        t_hi = (hi - origins) * inv
    t_near_axis = np.minimum(t_lo, t_hi)
    t_far_axis = np.maximum(t_lo, t_hi)
    t_near = np.nanmax(t_near_axis, axis=1)
    t_far = np.nanmin(t_far_axis, axis=1)
    valid = t_far >= np.maximum(t_near, 0.0)

    if interior:
        t = np.where(valid, t_far, np.inf)
        axis = np.nanargmin(np.where(np.isfinite(t_far_axis), t_far_axis, np.inf), axis=1)
        # Exiting through the high slab means we hit the high face.
        is_hi = t_hi[np.arange(len(axis)), axis] <= t_lo[np.arange(len(axis)), axis]
    else:
        t = np.where(valid & (t_near > 0), t_near, np.inf)
        axis = np.nanargmax(np.where(np.isfinite(t_near_axis), t_near_axis, -np.inf), axis=1)
        is_hi = t_hi[np.arange(len(axis)), axis] < t_lo[np.arange(len(axis)), axis]
    face = (axis + np.where(is_hi, 3, 0)).astype(np.int8)
    return t, face


# --------------------------------------------------------------------------
# Trajectories
# --------------------------------------------------------------------------


def look_at(eye: np.ndarray, target: np.ndarray, up=(0.0, -1.0, 0.0)) -> np.ndarray:
    """Camera-to-world pose looking from `eye` at `target`, OpenCV axes."""
    fwd = target - eye
    n = np.linalg.norm(fwd)
    fwd = fwd / n if n > 1e-9 else np.array([0.0, 0.0, 1.0])
    up_v = np.asarray(up, float)
    right = np.cross(up_v, fwd)
    rn = np.linalg.norm(right)
    if rn < 1e-6:  # degenerate: looking straight along `up`
        right = np.cross(np.array([1.0, 0.0, 0.0]), fwd)
        rn = np.linalg.norm(right)
    right /= rn
    down = np.cross(fwd, right)
    T = np.eye(4)
    T[:3, 0], T[:3, 1], T[:3, 2] = right, down, fwd
    T[:3, 3] = eye
    return T


def orbit_trajectory(
    n_frames: int = 240, radius: float = 3.2, height: float = 0.4,
    turns: float = 1.0, wobble: float = 0.10, seed: int = 0,
) -> list[np.ndarray]:
    """A closed orbit: returns to the start, so loop closure is exercised."""
    rng = np.random.default_rng(seed)
    poses = []
    for i in range(n_frames):
        a = 2 * np.pi * turns * i / n_frames
        eye = np.array([
            radius * np.cos(a),
            height + wobble * np.sin(a * 3.0),
            radius * np.sin(a),
        ])
        # Look inward and slightly ahead, like a survey flight.
        target = np.array([0.3 * np.cos(a + 0.6), height * 0.3, 0.3 * np.sin(a + 0.6)])
        T = look_at(eye, target)
        if wobble > 0:
            # Small pose jitter so the tracker sees realistic hand/airframe shake.
            T[:3, :3] = T[:3, :3] @ so3_exp(rng.normal(scale=0.004, size=3))
            T[:3, 3] += rng.normal(scale=0.002, size=3)
        poses.append(T)
    return poses


def forward_trajectory(n_frames: int = 200, length: float = 5.0, seed: int = 0) -> list[np.ndarray]:
    """A straight translating pass -- the easy case, good for isolating bugs."""
    rng = np.random.default_rng(seed)
    poses = []
    for i in range(n_frames):
        s = i / max(n_frames - 1, 1)
        eye = np.array([-length / 2 + s * length, 0.3, -2.0])
        T = look_at(eye, eye + np.array([0.15, 0.0, 1.0]))
        T[:3, :3] = T[:3, :3] @ so3_exp(rng.normal(scale=0.003, size=3))
        poses.append(T)
    return poses


TRAJECTORIES = {"orbit": orbit_trajectory, "forward": forward_trajectory}


@dataclass
class SyntheticSequence:
    """Rendered sequence plus its ground truth."""

    scene: SyntheticScene
    poses: list[np.ndarray]
    intrinsics: CameraIntrinsics
    images: list[np.ndarray] = field(default_factory=list)
    depths: list[np.ndarray] = field(default_factory=list)

    def render_all(self, with_depth: bool = True, progress: bool = False) -> "SyntheticSequence":
        for i, T in enumerate(self.poses):
            rgb, depth = self.scene.render(T, self.intrinsics)
            self.images.append(rgb)
            if with_depth:
                self.depths.append(depth)
            if progress and i % 20 == 0:
                log.info("rendered %d/%d", i, len(self.poses))
        return self

    def iter_frames(self) -> Iterator[tuple[int, np.ndarray, np.ndarray, np.ndarray]]:
        for i, T in enumerate(self.poses):
            if i < len(self.images):
                yield i, self.images[i], (self.depths[i] if i < len(self.depths) else None), T
            else:
                rgb, depth = self.scene.render(T, self.intrinsics)
                yield i, rgb, depth, T


def build_sequence(
    trajectory: str = "orbit", n_frames: int = 120, width: int = 640, height: int = 360,
    hfov_deg: float = 82.0, seed: int = 0, **traj_kw,
) -> SyntheticSequence:
    scene = SyntheticScene(seed=seed)
    poses = TRAJECTORIES[trajectory](n_frames=n_frames, seed=seed, **traj_kw)
    K = CameraIntrinsics.from_fov(width, height, hfov_deg)
    return SyntheticSequence(scene=scene, poses=poses, intrinsics=K)
