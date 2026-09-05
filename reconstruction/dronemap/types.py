"""Core data types shared across every pipeline stage.

Conventions used consistently throughout dronemap:

* Poses are **camera-to-world** 4x4 matrices ``T_wc``. A 3D point in camera
  coordinates ``p_c`` maps to world as ``p_w = T_wc[:3,:3] @ p_c + T_wc[:3,3]``.
* Camera frame is OpenCV style: ``+x`` right, ``+y`` down, ``+z`` forward.
* Depth is metric, in metres, and ``0`` means "no measurement".
* Images are ``uint8`` HxWx3 in **RGB** order (OpenCV's BGR is converted at the
  ingest boundary exactly once, so nothing downstream has to think about it).
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

# --------------------------------------------------------------------------
# SE(3) helpers
#
# Small enough that pulling in a Lie-group dependency is not worth it, and
# having them here keeps the convention above in one auditable place.
# --------------------------------------------------------------------------


def skew(v: np.ndarray) -> np.ndarray:
    """Skew-symmetric matrix such that ``skew(a) @ b == np.cross(a, b)``."""
    x, y, z = v
    return np.array([[0.0, -z, y], [z, 0.0, -x], [-y, x, 0.0]], dtype=np.float64)


def so3_exp(w: np.ndarray) -> np.ndarray:
    """Rodrigues exponential: rotation vector (3,) -> rotation matrix (3,3)."""
    theta = float(np.linalg.norm(w))
    if theta < 1e-12:
        # Second-order expansion; exact enough well below float64 resolution.
        W = skew(w)
        return np.eye(3) + W + 0.5 * (W @ W)
    axis = w / theta
    W = skew(axis)
    return np.eye(3) + np.sin(theta) * W + (1.0 - np.cos(theta)) * (W @ W)


def so3_log(R: np.ndarray) -> np.ndarray:
    """Rotation matrix -> rotation vector. Inverse of :func:`so3_exp`."""
    cos_theta = np.clip((np.trace(R) - 1.0) * 0.5, -1.0, 1.0)
    theta = float(np.arccos(cos_theta))
    if theta < 1e-8:
        return np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]]) * 0.5
    if theta > np.pi - 1e-5:
        # Near pi the antisymmetric part vanishes; recover the axis from R + I.
        A = (R + np.eye(3)) * 0.5
        axis = np.sqrt(np.clip(np.diag(A), 0.0, None))
        # Fix signs from the off-diagonal terms, anchored on the largest element.
        k = int(np.argmax(axis))
        if axis[k] > 1e-8:
            for i in range(3):
                if i != k:
                    axis[i] = np.copysign(axis[i], A[k, i])
        return axis / (np.linalg.norm(axis) + 1e-12) * theta
    w = np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]])
    return w * (theta / (2.0 * np.sin(theta)))


def se3_exp(xi: np.ndarray) -> np.ndarray:
    """Exponential map of a twist ``xi = [rho(3), phi(3)]`` -> 4x4 transform."""
    rho, phi = np.asarray(xi[:3], float), np.asarray(xi[3:], float)
    R = so3_exp(phi)
    theta = float(np.linalg.norm(phi))
    if theta < 1e-12:
        V = np.eye(3) + 0.5 * skew(phi)
    else:
        W = skew(phi / theta)
        V = (
            np.eye(3)
            + ((1.0 - np.cos(theta)) / theta) * W
            + ((theta - np.sin(theta)) / theta) * (W @ W)
        )
    T = np.eye(4)
    T[:3, :3] = R
    T[:3, 3] = V @ rho
    return T


def se3_log(T: np.ndarray) -> np.ndarray:
    """Inverse of :func:`se3_exp`."""
    phi = so3_log(T[:3, :3])
    theta = float(np.linalg.norm(phi))
    if theta < 1e-12:
        V_inv = np.eye(3) - 0.5 * skew(phi)
    else:
        W = skew(phi / theta)
        half = 0.5 * theta
        V_inv = np.eye(3) - 0.5 * skew(phi) + (1.0 - half / np.tan(half)) / (theta**2) * (
            skew(phi) @ skew(phi)
        )
    return np.concatenate([V_inv @ T[:3, 3], phi])


def se3_inv(T: np.ndarray) -> np.ndarray:
    """Inverse of a rigid transform, without a general matrix inverse."""
    R, t = T[:3, :3], T[:3, 3]
    out = np.eye(4, dtype=T.dtype)
    out[:3, :3] = R.T
    out[:3, 3] = -R.T @ t
    return out


def pose_distance(T_a: np.ndarray, T_b: np.ndarray) -> tuple[float, float]:
    """Relative (translation_metres, rotation_degrees) between two poses."""
    rel = se3_inv(T_a) @ T_b
    trans = float(np.linalg.norm(rel[:3, 3]))
    rot = float(np.degrees(np.linalg.norm(so3_log(rel[:3, :3]))))
    return trans, rot


# --------------------------------------------------------------------------
# Camera
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class CameraIntrinsics:
    """Pinhole intrinsics plus optional Brown-Conrady distortion."""

    width: int
    height: int
    fx: float
    fy: float
    cx: float
    cy: float
    dist: tuple[float, ...] = (0.0, 0.0, 0.0, 0.0, 0.0)

    @property
    def K(self) -> np.ndarray:
        return np.array(
            [[self.fx, 0.0, self.cx], [0.0, self.fy, self.cy], [0.0, 0.0, 1.0]],
            dtype=np.float64,
        )

    @property
    def dist_coeffs(self) -> np.ndarray:
        return np.asarray(self.dist, dtype=np.float64)

    @property
    def has_distortion(self) -> bool:
        return bool(np.any(np.abs(self.dist_coeffs) > 1e-9))

    def scaled(self, width: int, height: int) -> "CameraIntrinsics":
        """Rescale intrinsics for a resized image.

        Distortion coefficients are dimensionless in normalised coordinates, so
        they carry over unchanged.
        """
        sx, sy = width / self.width, height / self.height
        return CameraIntrinsics(
            width=width,
            height=height,
            fx=self.fx * sx,
            fy=self.fy * sy,
            cx=self.cx * sx,
            cy=self.cy * sy,
            dist=self.dist,
        )

    @staticmethod
    def from_fov(width: int, height: int, hfov_deg: float) -> "CameraIntrinsics":
        """Fallback when the camera is uncalibrated: derive f from horizontal FOV.

        Good enough to bootstrap tracking; run a real calibration for metric work.
        """
        f = (width * 0.5) / np.tan(np.radians(hfov_deg) * 0.5)
        return CameraIntrinsics(width, height, f, f, width * 0.5, height * 0.5)


# --------------------------------------------------------------------------
# Pipeline payloads
# --------------------------------------------------------------------------


@dataclass
class Frame:
    """One decoded video frame travelling from ingest to the tracker."""

    index: int
    timestamp: float  # seconds, monotonic capture clock
    image: np.ndarray  # uint8 HxWx3 RGB, tracking resolution
    gray: Optional[np.ndarray] = None  # uint8 HxW, lazily built by the tracker
    full: Optional[np.ndarray] = None  # uint8 RGB at source resolution, if retained
    intrinsics: Optional[CameraIntrinsics] = None  # matches `image`

    def ensure_gray(self) -> np.ndarray:
        if self.gray is None:
            import cv2

            self.gray = cv2.cvtColor(self.image, cv2.COLOR_RGB2GRAY)
        return self.gray


@dataclass
class Keyframe:
    """A frame promoted to a keyframe: carries pose, depth and map associations.

    Keyframes are retained for the whole session because loop closure can
    invalidate previously fused geometry, and re-integration needs the original
    RGB-D observations back.
    """

    kf_id: int
    frame_index: int
    timestamp: float
    image: np.ndarray  # uint8 HxWx3 RGB
    intrinsics: CameraIntrinsics
    T_wc: np.ndarray  # 4x4 camera-to-world

    depth: Optional[np.ndarray] = None  # float32 HxW metres, 0 = invalid
    depth_conf: Optional[np.ndarray] = None  # float32 HxW in [0,1]
    #: Source-resolution RGB, kept when the ingest retains full-res frames.
    #: Live tracking never touches it; it exists so offline REFINE and texture
    #: baking use everything the camera sent, not the downscaled track image.
    image_full: Optional[np.ndarray] = None  # uint8 HxWx3 RGB
    #: ORB keypoints, used for loop closure and relocalization.
    keypoints: Optional[np.ndarray] = None  # float32 Nx2 pixel coords
    descriptors: Optional[np.ndarray] = None  # uint8 Nx32 ORB
    #: The tracker's KLT features. A different set from `keypoints`: these carry
    #: the landmark associations, so they are what bundle adjustment consumes.
    keypoints_tracked: Optional[np.ndarray] = None  # float32 Mx2
    point_ids: Optional[np.ndarray] = None  # int64 M, -1 where unassociated

    # Pose actually used for the most recent TSDF integration. Comparing it to
    # `T_wc` tells the fusion thread how stale the fused geometry has become.
    fused_T_wc: Optional[np.ndarray] = None
    is_fused: bool = False
    #: Tracker's trust in T_wc at promotion time, [0, 1]. Fusion scales its
    #: integration weight by this so marginal poses cannot overwrite geometry
    #: laid down by confident ones. 1.0 = full-strength.
    pose_conf: float = 1.0

    #: Where a spilled payload lives on disk (npz), or None while the payload
    #: is resident. Keyframes are retained for the whole session (loop closure
    #: re-integration needs the original RGB-D back), but a long-running
    #: service cannot keep every image and depth map in RAM -- old keyframes
    #: spill and reload on demand. Pose, keypoints and descriptors always stay
    #: resident; only the heavy arrays move.
    spill_path: Optional[str] = None
    #: Map rescales that happened while the payload was on disk; applied to
    #: depth at reload so a spilled keyframe re-enters at the current scale.
    spill_depth_scale: float = 1.0

    @property
    def payload_available(self) -> bool:
        """True if image/depth can be obtained (resident or spilled)."""
        return self.image is not None or self.spill_path is not None

    def spill(self, directory) -> None:
        """Write image/depth/depth_conf to disk and drop them from RAM."""
        if self.spill_path is not None or self.image is None:
            return
        from pathlib import Path as _P

        path = _P(directory) / f"kf_{self.kf_id:06d}.npz"
        arrays = {"image": self.image}
        if self.depth is not None:
            arrays["depth"] = self.depth
        if self.depth_conf is not None:
            arrays["depth_conf"] = self.depth_conf
        if self.image_full is not None:
            arrays["image_full"] = self.image_full
        np.savez(path, **arrays)
        self.spill_path = str(path)
        self.image = None
        self.depth = None
        self.depth_conf = None
        self.image_full = None

    def load_payload(self) -> None:
        """Reload a spilled payload into the fields. No-op when resident."""
        if self.image is not None or self.spill_path is None:
            return
        with np.load(self.spill_path) as z:
            self.image = z["image"]
            self.depth = z["depth"] if "depth" in z.files else None
            self.depth_conf = z["depth_conf"] if "depth_conf" in z.files else None
            self.image_full = z["image_full"] if "image_full" in z.files else None
        if self.depth is not None and self.spill_depth_scale != 1.0:
            self.depth = self.depth * np.float32(self.spill_depth_scale)

    def drop_payload(self) -> None:
        """Drop a payload reloaded from spill. No-op if never spilled."""
        if self.spill_path is None:
            return
        self.image = None
        self.depth = None
        self.depth_conf = None
        self.image_full = None

    def median_depth(self) -> float:
        """Median of valid depth; the natural scene-scale unit for thresholds."""
        if self.depth is None:
            return 0.0
        valid = self.depth[self.depth > 0]
        return float(np.median(valid)) if valid.size else 0.0


@dataclass
class MapPoint:
    """A triangulated 3D landmark observed by two or more keyframes."""

    point_id: int
    position: np.ndarray  # float64 (3,) world coordinates
    color: np.ndarray = field(default_factory=lambda: np.zeros(3, np.uint8))
    observations: dict[int, int] = field(default_factory=dict)  # kf_id -> kp index
    descriptor: Optional[np.ndarray] = None
    n_visible: int = 0  # times predicted visible; denominator for the ratio below
    n_found: int = 0  # times actually matched
    is_bad: bool = False

    @property
    def found_ratio(self) -> float:
        return self.n_found / max(self.n_visible, 1)


class AtomicCounter:
    """Thread-safe monotonically increasing id source."""

    __slots__ = ("_value", "_lock")

    def __init__(self, start: int = 0) -> None:
        self._value = start
        self._lock = threading.Lock()

    def next(self) -> int:
        with self._lock:
            v = self._value
            self._value += 1
            return v

    @property
    def value(self) -> int:
        with self._lock:
            return self._value
