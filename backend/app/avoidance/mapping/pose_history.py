"""Pose history - where the aircraft was at any recent moment.

An observation is only as good as the pose used to place it. The old loop
placed body-frame readings with whatever pose it held at DECISION time (a
1-2 Hz fleet snapshot), so during a turn a camera reading taken 0.5 s earlier
was rotated by the wrong heading - metres of lateral error at 20 m. This
keeps a short, timestamped history per drone and answers "what was the pose
at time t" by interpolation, so each reading is placed once, with the pose of
the frame it came from.

Positions are kept in a local north/east/down frame in metres around an
origin fixed at the first sample (flat-earth over a few km is well under a
centimetre of error), which is also the frame the occupancy grid and the
local planner work in.

Two sources feed it:
  add()     GPS latitude/longitude (outdoors, as before)
  add_ne()  PX4's LOCAL position - EKF2 metres from its own origin, which
            exists without GPS (optical flow, rangefinder, visual odometry,
            motion capture): indoor / GPS-denied navigation.
Switching source starts a new frame (`epoch` increments): positions from the
two are not comparable, so whatever was mapped in the old frame must go.
"""
from __future__ import annotations

import math
import time
from bisect import bisect_left
from collections import deque
from dataclasses import dataclass

M_PER_DEG_LAT = 111_320.0
HISTORY_S = 6.0


@dataclass
class PoseSample:
    t: float            # ground-station monotonic time the sample ARRIVED
    lat: float
    lng: float
    north_m: float
    east_m: float
    alt_m: float        # relative altitude (AGL over the home point)
    yaw_deg: float      # compass heading of the nose, 0 = north, clockwise
    roll_deg: float = 0.0
    pitch_deg: float = 0.0


def _wrap(a: float) -> float:
    return (a + 180.0) % 360.0 - 180.0


class PoseHistory:
    def __init__(self) -> None:
        self._s: deque[PoseSample] = deque()
        self.origin: tuple[float, float] | None = None
        self._last_key: tuple | None = None
        self.source: str | None = None        # 'gps' | 'local'
        self.epoch = 0                        # bumps when the frame changes

    def _switch(self, source: str, origin: tuple[float, float] | None) -> None:
        if self.source == source:
            return
        if self.source is not None:
            self.epoch += 1
        self.source = source
        self._s.clear()
        self._last_key = None
        self.origin = origin

    # -- frame conversions ----------------------------------------------------
    def to_ne(self, lat: float, lng: float) -> tuple[float, float]:
        if self.origin is None:
            self.origin = (lat, lng)
        lat0, lng0 = self.origin
        m_lng = M_PER_DEG_LAT * max(0.2, math.cos(math.radians(lat0)))
        return (lat - lat0) * M_PER_DEG_LAT, (lng - lng0) * m_lng

    def to_latlng(self, north_m: float, east_m: float) -> tuple[float, float]:
        lat0, lng0 = self.origin or (0.0, 0.0)
        m_lng = M_PER_DEG_LAT * max(0.2, math.cos(math.radians(lat0)))
        return lat0 + north_m / M_PER_DEG_LAT, lng0 + east_m / m_lng

    # -- ingest ---------------------------------------------------------------
    def add(self, lat: float, lng: float, alt_m: float, yaw_deg: float,
            roll_deg: float = 0.0, pitch_deg: float = 0.0,
            t: float | None = None) -> bool:
        """Record a sample. Identical consecutive readings are skipped, so a
        poller faster than the telemetry stream records each update once
        (and the interpolation sees the real update times). Returns True if
        the sample was new."""
        self._switch("gps", None)
        key = (round(lat, 7), round(lng, 7), round(alt_m, 2), round(yaw_deg, 1),
               round(roll_deg, 1), round(pitch_deg, 1))
        t = t if t is not None else time.monotonic()
        if key == self._last_key:
            if self._s:
                self._s[-1].t = t        # still receiving: a hover is not a stale pose
            return False
        self._last_key = key
        n, e = self.to_ne(lat, lng)
        self._s.append(PoseSample(t, lat, lng, n, e, alt_m, yaw_deg % 360.0,
                                  roll_deg, pitch_deg))
        while self._s and t - self._s[0].t > HISTORY_S:
            self._s.popleft()
        return True

    def add_ne(self, north_m: float, east_m: float, alt_m: float, yaw_deg: float,
               roll_deg: float = 0.0, pitch_deg: float = 0.0, t: float | None = None,
               origin_latlng: tuple[float, float] | None = None) -> bool:
        """Record a sample in PX4's LOCAL frame (metres from the EKF origin).
        origin_latlng anchors that frame to the globe (for mission waypoints
        and the map): the GPS position minus the local offset when GPS is
        also available, else the home point, else (0, 0) - indoors with no
        global reference only relative positions matter."""
        self._switch("local", origin_latlng or (0.0, 0.0))
        key = ("ne", round(north_m, 3), round(east_m, 3), round(alt_m, 2), round(yaw_deg, 1),
               round(roll_deg, 1), round(pitch_deg, 1))
        t = t if t is not None else time.monotonic()
        if key == self._last_key:
            if self._s:
                self._s[-1].t = t
            return False
        self._last_key = key
        lat, lng = self.to_latlng(north_m, east_m)
        self._s.append(PoseSample(t, lat, lng, north_m, east_m, alt_m, yaw_deg % 360.0,
                                  roll_deg, pitch_deg))
        while self._s and t - self._s[0].t > HISTORY_S:
            self._s.popleft()
        return True

    def clear(self) -> None:
        self._s.clear()
        self._last_key = None
        # The origin is kept: grid cells already placed stay valid.

    # -- query ----------------------------------------------------------------
    def sample_count(self) -> int:
        return len(self._s)

    def latest(self) -> PoseSample | None:
        return self._s[-1] if self._s else None

    def at(self, t: float) -> PoseSample | None:
        """Pose at time t, linearly interpolated between the two samples that
        bracket it (heading along the short way round). Before the history or
        after its end the nearest sample is returned - never extrapolated
        more than one sample's worth, because a wrong guess is worse than a
        slightly old truth."""
        if not self._s:
            return None
        s = self._s
        if t <= s[0].t:
            return s[0]
        if t >= s[-1].t:
            return s[-1]
        ts = [x.t for x in s]
        i = bisect_left(ts, t)
        a, b = s[i - 1], s[i]
        f = (t - a.t) / max(1e-6, b.t - a.t)
        lerp = lambda x, y: x + (y - x) * f  # noqa: E731
        n, e = lerp(a.north_m, b.north_m), lerp(a.east_m, b.east_m)
        lat, lng = self.to_latlng(n, e)
        return PoseSample(
            t=t, lat=lat, lng=lng, north_m=n, east_m=e,
            alt_m=lerp(a.alt_m, b.alt_m),
            yaw_deg=(a.yaw_deg + _wrap(b.yaw_deg - a.yaw_deg) * f) % 360.0,
            roll_deg=lerp(a.roll_deg, b.roll_deg),
            pitch_deg=lerp(a.pitch_deg, b.pitch_deg))

    def velocity_ne(self, window_s: float = 0.6) -> tuple[float, float]:
        """Ground velocity (north, east m/s) from the position history over
        the last window. Works on links that do not stream velocity (the
        fleet profile drops it)."""
        if len(self._s) < 2:
            return 0.0, 0.0
        b = self._s[-1]
        a = next((x for x in reversed(self._s) if b.t - x.t >= window_s), self._s[0])
        dt = b.t - a.t
        if dt < 0.05:
            return 0.0, 0.0
        return (b.north_m - a.north_m) / dt, (b.east_m - a.east_m) / dt

    def rate_hz(self, window_s: float = 3.0) -> float:
        """Measured update rate of the pose - what the stamping is worth."""
        if len(self._s) < 2:
            return 0.0
        end = self._s[-1].t
        n = sum(1 for x in self._s if end - x.t <= window_s)
        span = min(window_s, end - self._s[0].t)
        return (n - 1) / span if span > 0 else 0.0


_by_drone: dict[str, PoseHistory] = {}


def history(drone_id: str) -> PoseHistory:
    h = _by_drone.get(drone_id)
    if h is None:
        h = _by_drone[drone_id] = PoseHistory()
    return h


def reset(drone_id: str | None = None) -> None:
    if drone_id is None:
        _by_drone.clear()
    else:
        _by_drone.pop(drone_id, None)
