"""Metric scale anchoring.

Monocular reconstruction has one irreducible weakness: a scene and a scaled copy
of it produce identical images. Everything downstream is metric only to the
extent that something external pins the scale down.

Three strategies, all behind one interface:

* ``depth_net`` (default) -- trust the metric depth checkpoint, refined per
  keyframe by aligning to the tracked landmarks. Needs no extra hardware; good
  to roughly 10-20% absolute, and it can drift slowly over a long flight.
* ``mavlink`` -- fuse the flight controller's altitude. This machine already has
  `pymavlink` installed, and a barometric or rangefinder altitude gives a true
  metric reference that does not drift, which makes it the strongest option on a
  real airframe.
* ``fixed`` -- a constant supplied by the operator, from a measured reference.

The MAVLink estimator compares the vehicle's *change* in altitude against the
map's change in the same direction over the same interval. Differences rather
than absolutes, because the two coordinate frames have unrelated origins;
only the ratio of travelled distances carries scale information.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

log = logging.getLogger(__name__)


@dataclass
class ScaleEstimate:
    scale: float = 1.0
    confidence: float = 0.0
    source: str = "none"
    n_samples: int = 0


class ScaleAnchor:
    """Maintains the running world-scale correction factor."""

    def __init__(self, cfg) -> None:
        self.cfg = cfg.scale
        self.mode = self.cfg.mode
        self._scale = 1.0 if self.mode != "fixed" else float(self.cfg.fixed_scale)
        self._lock = threading.Lock()
        self._mav: Optional[MavlinkAltitudeSource] = None
        self._samples: deque[tuple[float, float, np.ndarray]] = deque(maxlen=200)
        self.estimate = ScaleEstimate(self._scale, 1.0 if self.mode == "fixed" else 0.0,
                                      self.mode)

        if self.mode == "mavlink":
            self._mav = MavlinkAltitudeSource(self.cfg.mavlink_url)
            self._mav.start()

    @property
    def scale(self) -> float:
        with self._lock:
            return self._scale

    def observe(self, timestamp: float, T_wc: np.ndarray) -> Optional[float]:
        """Feed a new pose; returns a *relative* rescale factor to apply, or None.

        The returned factor is what the map should be multiplied by right now --
        it is 1.0 when no correction is warranted, so the caller can apply it
        unconditionally.
        """
        if self.mode in ("fixed", "none", "depth_net"):
            return None
        if self._mav is None:
            return None

        alt = self._mav.altitude_at(timestamp)
        if alt is None:
            return None
        with self._lock:
            self._samples.append((timestamp, alt, T_wc[:3, 3].copy()))
            if len(self._samples) < 20:
                return None
            factor = self._estimate_from_samples()
            if factor is None:
                return None

            # Rate-limit: a bad altitude reading must not be able to rescale the
            # entire map in one step.
            max_rate = self.cfg.max_rate
            factor = float(np.clip(factor, 1.0 - max_rate, 1.0 + max_rate))
            self._scale *= factor
            self.estimate = ScaleEstimate(self._scale, min(len(self._samples) / 100, 1.0),
                                          "mavlink", len(self._samples))
            return factor

    def _estimate_from_samples(self) -> Optional[float]:
        """Ratio of MAVLink altitude change to map vertical displacement."""
        ts = np.array([s[0] for s in self._samples])
        alt = np.array([s[1] for s in self._samples])
        pos = np.array([s[2] for s in self._samples])

        span = ts[-1] - ts[0]
        if span < 1.0:
            return None
        # The map's vertical axis is camera -y (OpenCV y points down), so a
        # climb shows up as decreasing y.
        map_alt = -pos[:, 1]
        d_alt = alt - alt.mean()
        d_map = map_alt - map_alt.mean()
        if np.std(d_alt) < 0.30:
            # Level flight: no vertical excursion means no scale information.
            return None
        denom = float(np.dot(d_map, d_map))
        if denom < 1e-9:
            return None
        ratio = float(np.dot(d_map, d_alt) / denom)
        if not np.isfinite(ratio) or ratio <= 0.05 or ratio > 20.0:
            return None
        # Smooth: per-keyframe scale estimates are noisy even when unbiased.
        alpha = 1.0 - self.cfg.smoothing
        return 1.0 + alpha * (ratio - 1.0)

    def close(self) -> None:
        if self._mav is not None:
            self._mav.stop()

    @property
    def stats(self) -> dict:
        return {
            "mode": self.mode,
            "scale": round(self.scale, 5),
            "confidence": round(self.estimate.confidence, 3),
            "samples": self.estimate.n_samples,
            "mavlink_connected": bool(self._mav and self._mav.connected),
        }


class MavlinkAltitudeSource:
    """Background MAVLink listener collecting timestamped altitude."""

    def __init__(self, url: str, max_history: int = 4000) -> None:
        self.url = url
        self._history: deque[tuple[float, float]] = deque(maxlen=max_history)
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self.connected = False
        self._home_alt: Optional[float] = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="mavlink", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        try:
            from pymavlink import mavutil
        except ImportError:
            log.error("pymavlink not installed; MAVLink scale anchoring disabled")
            return
        try:
            conn = mavutil.mavlink_connection(self.url)
            log.info("MAVLink: waiting for heartbeat on %s", self.url)
            conn.wait_heartbeat(timeout=15)
            self.connected = True
            log.info("MAVLink: connected (system %d)", conn.target_system)
        except Exception as exc:  # noqa: BLE001
            log.error("MAVLink connection failed (%s); scale falls back to depth net", exc)
            return

        while not self._stop.is_set():
            try:
                msg = conn.recv_match(
                    type=["GLOBAL_POSITION_INT", "ALTITUDE", "DISTANCE_SENSOR"],
                    blocking=True, timeout=1.0,
                )
            except Exception as exc:  # noqa: BLE001
                log.debug("MAVLink receive error: %s", exc)
                continue
            if msg is None:
                continue
            alt = self._extract_altitude(msg)
            if alt is None:
                continue
            with self._lock:
                self._history.append((time.monotonic(), alt))
        self.connected = False

    def _extract_altitude(self, msg) -> Optional[float]:
        """Prefer a rangefinder, then relative altitude, then AMSL.

        A downward rangefinder measures true height above the surface being
        mapped, which is the quantity that actually correlates with map scale.
        Barometric AMSL drifts and is referenced to sea level.
        """
        t = msg.get_type()
        if t == "DISTANCE_SENSOR":
            d = msg.current_distance / 100.0
            if msg.min_distance / 100.0 < d < msg.max_distance / 100.0:
                return d
            return None
        if t == "GLOBAL_POSITION_INT":
            return msg.relative_alt / 1000.0
        if t == "ALTITUDE":
            return getattr(msg, "altitude_relative", None)
        return None

    def altitude_at(self, timestamp: float, tolerance: float = 0.5) -> Optional[float]:
        """Nearest altitude sample to `timestamp`, if one is close enough."""
        with self._lock:
            if not self._history:
                return None
            times = np.array([h[0] for h in self._history])
            idx = int(np.argmin(np.abs(times - timestamp)))
            if abs(times[idx] - timestamp) > tolerance:
                return None
            return self._history[idx][1]

    def stop(self) -> None:
        self._stop.set()
