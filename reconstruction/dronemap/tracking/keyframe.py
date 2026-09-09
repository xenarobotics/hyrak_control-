"""Dynamic keyframe selection.

The gate that decides which frames are worth the expensive path (depth network,
bundle adjustment, volumetric integration). Getting it wrong is expensive in
both directions: too permissive and the mapper drowns in redundant views of the
same wall; too strict and the reconstruction develops holes and the tracker runs
out of landmarks.

Four independent triggers, ORed together:

1. **Translation parallax** -- expressed as a fraction of median scene depth,
   not as an absolute distance. Moving 30 cm matters enormously at 2 m range and
   not at all at 60 m, and a drone does both in one flight.
2. **Rotation** -- rotation produces new viewpoints without parallax, and a
   purely rotational gap starves the tracker even though nothing translated.
3. **Track attrition** -- when enough features have been lost, the overlap with
   the last keyframe is gone regardless of how far the camera moved.
4. **Timeout** -- guarantees the map keeps refreshing even from a stationary
   hover, so exposure or scene changes still get captured.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

import numpy as np

from ..config import Config
from ..types import pose_distance

log = logging.getLogger(__name__)


@dataclass
class KeyframeDecision:
    accept: bool
    reason: str
    trans: float = 0.0
    rot_deg: float = 0.0
    track_ratio: float = 1.0
    dt: float = 0.0
    threshold: float = 0.0


class KeyframeSelector:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg.keyframe
        self._last_T: Optional[np.ndarray] = None
        self._last_t: float = -1e9
        self._prev_T: Optional[np.ndarray] = None
        self._prev_t: float = -1e9
        self._last_n_tracks: int = 0
        self.n_accepted = 0
        self.n_rejected = 0
        self._reasons: dict[str, int] = {}

    def reset(self) -> None:
        self._last_T = None
        self._last_t = -1e9

    def reset_last_accepted(self) -> None:
        """Undo the bookkeeping of the most recent accept.

        Used when the pipeline declines a keyframe the gate approved (because
        the mapper is saturated). Without this the gate measures the next
        candidate against a pose that never entered the map, so it waits for a
        second full threshold of motion and leaves a gap.
        """
        self._last_T = self._prev_T
        self._last_t = self._prev_t
        self.n_accepted = max(0, self.n_accepted - 1)

    def threshold_for(self, median_depth: float) -> float:
        """Scale-relative translation threshold, clamped to sane absolutes."""
        c = self.cfg
        raw = c.trans_ratio * max(median_depth, 1e-6)
        return float(np.clip(raw, c.min_trans_m, c.max_trans_m))

    def evaluate(
        self,
        T_wc: np.ndarray,
        timestamp: float,
        median_depth: float,
        n_tracks: int,
        track_ratio: float = 1.0,
        force: bool = False,
        allow_attrition: bool = True,
    ) -> KeyframeDecision:
        c = self.cfg
        thr = self.threshold_for(median_depth)

        if force or self._last_T is None:
            return self._accept("first" if self._last_T is None else "forced",
                                T_wc, timestamp, n_tracks, 0.0, 0.0, track_ratio, thr)

        dt = timestamp - self._last_t
        trans, rot = pose_distance(self._last_T, T_wc)

        # The rate limit wins over every trigger below it: back-to-back
        # keyframes cost the mapper far more than they add.
        if dt < c.min_interval_s:
            return self._reject("min_interval", trans, rot, track_ratio, dt, thr)

        if trans >= thr:
            return self._accept("translation", T_wc, timestamp, n_tracks,
                                trans, rot, track_ratio, thr)
        if rot >= c.rot_deg:
            return self._accept("rotation", T_wc, timestamp, n_tracks,
                                trans, rot, track_ratio, thr)
        # Attrition is a valid trigger only while tracking is HEALTHY (losing
        # features while PnP still locks means the view genuinely changed).
        # While degraded it IS the failure signal - promoting on it turned
        # every rough patch into keyframe spam at dead-reckoned poses.
        if allow_attrition and track_ratio < c.track_ratio:
            return self._accept("track_loss", T_wc, timestamp, n_tracks,
                                trans, rot, track_ratio, thr)
        if dt >= c.max_interval_s:
            return self._accept("timeout", T_wc, timestamp, n_tracks,
                                trans, rot, track_ratio, thr)
        return self._reject("redundant", trans, rot, track_ratio, dt, thr)

    def _accept(self, reason, T_wc, ts, n_tracks, trans, rot, ratio, thr) -> KeyframeDecision:
        self._prev_T = None if self._last_T is None else self._last_T.copy()
        self._prev_t = self._last_t
        self._last_T = np.array(T_wc, dtype=np.float64, copy=True)
        self._last_t = ts
        self._last_n_tracks = n_tracks
        self.n_accepted += 1
        self._reasons[reason] = self._reasons.get(reason, 0) + 1
        return KeyframeDecision(True, reason, trans, rot, ratio, 0.0, thr)

    def _reject(self, reason, trans, rot, ratio, dt, thr) -> KeyframeDecision:
        self.n_rejected += 1
        return KeyframeDecision(False, reason, trans, rot, ratio, dt, thr)

    @property
    def stats(self) -> dict:
        total = self.n_accepted + self.n_rejected
        return {
            "accepted": self.n_accepted,
            "rejected": self.n_rejected,
            "accept_rate": round(self.n_accepted / max(total, 1), 3),
            "reasons": dict(self._reasons),
        }
