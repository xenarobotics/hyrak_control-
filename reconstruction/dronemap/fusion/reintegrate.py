"""Deferred re-integration after loop closure.

A TSDF cannot be deformed. Once a depth image has been averaged into a voxel
grid, moving the camera that produced it is not an operation the representation
supports. So when loop closure shifts the trajectory, the fused geometry is
simply wrong -- it encodes the pre-closure poses.

The fix is to rebuild: clear the volume and re-integrate every keyframe from its
corrected pose. That is expensive (hundreds of integrations), so it is triggered
only when the accumulated correction actually exceeds the voxel resolution --
below that, rebuilding would produce a volume indistinguishable from the one
already there.

This is why keyframes retain their depth maps for the whole session.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Callable, Optional

import numpy as np

from ..types import Keyframe, pose_distance
from .base import Mapper

log = logging.getLogger(__name__)


@dataclass
class ReintegrationPolicy:
    """When a rebuild is worth its cost."""

    trans_threshold_m: float = 0.10
    rot_threshold_deg: float = 3.0
    enabled: bool = True
    #: Never rebuild more often than this; a burst of closures should coalesce
    #: into one rebuild rather than triggering several back to back. Measured in
    #: wall-clock seconds, so it is disabled in deterministic runs (see
    #: `deterministic`) where it would otherwise make the output depend on how
    #: fast the machine happens to be.
    min_interval_s: float = 20.0
    #: Use the keyframe-counted rate limit instead of the wall-clock one, so
    #: rebuild timing does not depend on machine speed. Without any rate limit,
    #: a deterministic run rebuilds on almost every keyframe -- on the validation
    #: sequence that cost ~8 s of a 20 s run for no accuracy gain.
    deterministic: bool = False
    #: Keyframes that must pass between rebuilds when `deterministic`.
    min_interval_kf: int = 10
    #: Skip the rebuild if the correction is small relative to the voxel size --
    #: sub-voxel corrections cannot change the discretised result.
    voxel_size_m: float = 0.04


class Reintegrator:
    def __init__(self, mapper: Mapper, policy: ReintegrationPolicy) -> None:
        self.mapper = mapper
        self.policy = policy
        self._last_rebuild = 0.0
        self._keyframes_since_rebuild = 0
        self.rebuilds = 0
        self.last_duration_s = 0.0
        #: Set by shutdown: a rebuild over hundreds of keyframes must not hold
        #: the fusion thread hostage past the session's stop request.
        self.cancel = threading.Event()

    def should_rebuild(self, correction_m: float, correction_deg: float) -> bool:
        p = self.policy
        if not p.enabled:
            return False
        if correction_m < max(p.trans_threshold_m, p.voxel_size_m):
            # Below one voxel the rebuild cannot change the result.
            if correction_deg < p.rot_threshold_deg:
                return False
        if p.deterministic:
            if self._keyframes_since_rebuild < p.min_interval_kf:
                return False
        elif time.monotonic() - self._last_rebuild < p.min_interval_s:
            log.debug("rebuild suppressed: last one was %.1fs ago",
                      time.monotonic() - self._last_rebuild)
            return False
        return True

    def note_keyframe(self) -> None:
        """Advance the deterministic rate-limit counter."""
        self._keyframes_since_rebuild += 1

    def rebuild(
        self,
        keyframes: list[Keyframe],
        weight_fn: Optional[Callable[[Keyframe], np.ndarray]] = None,
        progress_every: int = 50,
    ) -> int:
        """Clear and re-integrate every keyframe at its current pose.

        Spilled keyframes reload one at a time and drop again after their
        integration, so a rebuild over a long session stays at O(1) payloads
        in RAM rather than pulling the whole history back in.
        """
        usable = [kf for kf in keyframes
                  if kf.depth is not None or kf.spill_path is not None]
        if not usable:
            log.warning("re-integration requested but no keyframe has depth")
            return 0

        t0 = time.perf_counter()
        log.info("re-integrating %d keyframes after loop closure...", len(usable))
        self.mapper.reset()

        for i, kf in enumerate(usable):
            if self.cancel.is_set():
                log.warning("re-integration cancelled at %d/%d (shutdown)",
                            i, len(usable))
                break
            was_spilled = kf.image is None
            kf.load_payload()
            try:
                if kf.depth is None:
                    continue
                wm = weight_fn(kf) if weight_fn is not None else None
                self.mapper.integrate(kf.depth, kf.image, kf.T_wc,
                                      kf.intrinsics, wm)
                kf.fused_T_wc = kf.T_wc.copy()
                kf.is_fused = True
            finally:
                if was_spilled:
                    kf.drop_payload()
            if progress_every and (i + 1) % progress_every == 0:
                log.info("  re-integrated %d/%d", i + 1, len(usable))

        self.last_duration_s = time.perf_counter() - t0
        self._last_rebuild = time.monotonic()
        self._keyframes_since_rebuild = 0
        self.rebuilds += 1
        log.info("re-integration complete: %d keyframes in %.1fs",
                 len(usable), self.last_duration_s)
        return len(usable)

    @property
    def stats(self) -> dict:
        return {
            "rebuilds": self.rebuilds,
            "last_duration_s": round(self.last_duration_s, 2),
        }


def max_drift(keyframes: list[Keyframe]) -> tuple[float, float]:
    """Largest gap between a keyframe's current pose and the pose it was fused at."""
    worst_t = worst_r = 0.0
    for kf in keyframes:
        if kf.fused_T_wc is None:
            continue
        t, r = pose_distance(kf.fused_T_wc, kf.T_wc)
        worst_t = max(worst_t, t)
        worst_r = max(worst_r, r)
    return worst_t, worst_r
