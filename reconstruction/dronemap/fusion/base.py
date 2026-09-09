"""Mapper interface: the contract every reconstruction backend implements."""

from __future__ import annotations

import abc
import logging
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from ..types import CameraIntrinsics

log = logging.getLogger(__name__)


@dataclass
class FusionStats:
    integrations: int = 0
    blocks_allocated: int = 0
    blocks_capacity: int = 0
    vram_mb: float = 0.0
    last_integrate_ms: float = 0.0
    overflow_events: int = 0
    reintegrations: int = 0
    extra: dict = field(default_factory=dict)

    @property
    def occupancy(self) -> float:
        return self.blocks_allocated / max(self.blocks_capacity, 1)


class Mapper(abc.ABC):
    """Accumulates posed RGB-D observations into a 3D scene representation."""

    @abc.abstractmethod
    def integrate(
        self,
        depth: np.ndarray,
        color: Optional[np.ndarray],
        T_wc: np.ndarray,
        intrinsics: CameraIntrinsics,
        weight_map: Optional[np.ndarray] = None,
    ) -> None:
        """Fuse one posed depth image into the volume."""

    @abc.abstractmethod
    def extract_point_cloud(self, min_weight: float = 1.0):
        """Return (xyz Nx3 float32, rgb Nx3 uint8) at the zero crossing."""

    @abc.abstractmethod
    def extract_mesh(self, min_weight: float = 1.0):
        """Return (vertices Nx3, faces Mx3, colors Nx3 uint8)."""

    @abc.abstractmethod
    def reset(self) -> None:
        """Discard all geometry, keeping allocations, for re-integration."""

    @property
    @abc.abstractmethod
    def stats(self) -> FusionStats:
        ...

    def close(self) -> None:
        pass


def build_mapper(cfg) -> Mapper:
    """Select a fusion backend, preferring CUDA and degrading gracefully."""
    backend = cfg.fusion.backend
    if backend in ("auto", "cuda"):
        try:
            from .tsdf_cuda import CudaTSDFVolume

            return CudaTSDFVolume(cfg)
        except Exception as exc:  # noqa: BLE001
            if backend == "cuda":
                raise
            log.warning("CUDA TSDF unavailable (%s); falling back to Open3D", exc)
    if backend in ("auto", "open3d"):
        from .tsdf_open3d import Open3DTSDFVolume

        return Open3DTSDFVolume(cfg)
    raise ValueError(f"unknown fusion backend: {backend}")


def compute_weight_map(
    depth: np.ndarray,
    intrinsics: CameraIntrinsics,
    confidence: Optional[np.ndarray] = None,
    angle_weighting: bool = True,
    range_weighting: bool = True,
    max_depth: float = 30.0,
    range_ref_m: float = 3.0,
    range_weight_floor: float = 0.08,
) -> np.ndarray:
    """Per-pixel fusion weight.

    Three independent factors, multiplied:

    * **confidence** from the depth backend (edge suppression lives here),
    * **range** -- monocular depth error grows roughly linearly with distance, so
      its variance grows as d^2 and the weight falls off as 1/d^2. The falloff is
      normalised to 1.0 at `range_ref_m` and clamped below by
      `range_weight_floor`: an unfloored 1/d^2 drives far-range weights so close
      to zero that distant surfaces never accumulate enough to survive
      extraction, which shows up as a reconstruction that mysteriously stops a
      few metres from the camera,
    * **incidence angle** -- a surface seen at a grazing angle is sampled by very
      few pixels and its depth is badly conditioned, so it is downweighted via
      the ray/normal angle recovered from the depth gradient.

    Computing this once on the host keeps the CUDA kernel to a single multiply
    and makes the weighting policy easy to change without touching CUDA.
    """
    h, w = depth.shape[:2]
    weight = np.ones((h, w), np.float32)
    valid = depth > 0

    if confidence is not None:
        weight *= confidence.astype(np.float32)

    if range_weighting:
        d = np.maximum(depth, 1e-3)
        ratio = (float(range_ref_m) / d) ** 2
        weight *= np.clip(ratio, range_weight_floor, 4.0).astype(np.float32)

    if angle_weighting:
        # Surface normal from the depth gradient, in camera coordinates.
        dzdy, dzdx = np.gradient(depth.astype(np.float32))
        fx, fy = intrinsics.fx, intrinsics.fy
        d_safe = np.maximum(depth, 1e-3).astype(np.float32)
        nx = -dzdx * fx / d_safe
        ny = -dzdy * fy / d_safe
        nz = np.ones_like(nx)
        norm = np.sqrt(nx * nx + ny * ny + nz * nz)
        cos_incidence = np.clip(nz / np.maximum(norm, 1e-6), 0.05, 1.0)
        weight *= cos_incidence.astype(np.float32)

    weight[~valid] = 0.0
    weight[depth > max_depth] = 0.0
    np.clip(weight, 0.0, 4.0, out=weight)
    return np.ascontiguousarray(weight, dtype=np.float32)
