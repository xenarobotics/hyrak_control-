"""
One object seen in many frames is one sighting on the map.

A model running at 10-30 fps reports the same parked car hundreds of times.
Each report becomes an Observation (label, position, accuracy, score); the
tracker folds it into an existing Sighting when one matches, else opens a
new one. A match is:

    same source (model) and same label,
    last seen within WINDOW_S seconds,
    and either within the match radius of the sighting, where
        radius = clamp(RADIUS_K * max(accuracy of both), RADIUS_MIN_M, RADIUS_MAX_M)
    or carrying the same tracker id (ByteTrack modes) within 3x that radius.

The nearest match wins. A sighting keeps a count, first/last seen, the best
score (and the frame that scored it, for the thumbnail), and a position that
is the accuracy-weighted mean of its observations (1/accuracy^2 weights).
Its accuracy is the best single observation's, not the shrunk figure a mean
of independent errors would earn: the dominant errors (heading, camera
angle, terrain) are biases shared by consecutive frames, so averaging them
does not remove them and claiming it would be dishonest.

Pure: no clock, no I/O. Callers pass `t` (epoch seconds).
"""
from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from app.utils.geo import haversine_m

WINDOW_S = 30.0
RADIUS_K = 1.5
RADIUS_MIN_M = 3.0
RADIUS_MAX_M = 60.0
MAX_SIGHTINGS = 5000


@dataclass
class Observation:
    label: str
    lat: float
    lon: float
    accuracy_m: float
    t: float
    score: Optional[float] = None
    source: str = ""
    model_name: str = ""
    task: str = "detect"
    track_id: Optional[int] = None
    agl_m: Optional[float] = None
    angle_source: str = ""


@dataclass
class Sighting:
    id: str
    label: str
    source: str
    model_name: str
    task: str
    lat: float
    lon: float
    accuracy_m: float
    first_seen: float
    last_seen: float
    count: int = 1
    best_score: Optional[float] = None
    best_t: Optional[float] = None
    thumb: Optional[str] = None          # data:image/jpeg;base64,...
    agl_m: Optional[float] = None
    angle_source: str = ""
    track_id: Optional[int] = None
    # Running weighted sums for the position mean.
    _w: float = field(default=0.0, repr=False)
    _wlat: float = field(default=0.0, repr=False)
    _wlon: float = field(default=0.0, repr=False)
    _thumb_score: float = field(default=0.0, repr=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id, "label": self.label, "source": self.source,
            "model_name": self.model_name, "task": self.task,
            "lat": round(self.lat, 7), "lon": round(self.lon, 7),
            "accuracy_m": self.accuracy_m, "count": self.count,
            "first_seen": self.first_seen, "last_seen": self.last_seen,
            "best_score": self.best_score, "thumb": self.thumb,
            "agl_m": self.agl_m, "angle_source": self.angle_source,
        }


def match_radius(a: float, b: float) -> float:
    return min(RADIUS_MAX_M, max(RADIUS_MIN_M, RADIUS_K * max(a, b)))


def _weight(acc: float) -> float:
    return 1.0 / max(0.25, acc) ** 2


class SightingTracker:
    def __init__(self, *, window_s: float = WINDOW_S, max_sightings: int = MAX_SIGHTINGS):
        self.window_s = window_s
        self.max_sightings = max_sightings
        self.sightings: Dict[str, Sighting] = {}
        self.capped = False

    def __len__(self) -> int:
        return len(self.sightings)

    def clear(self) -> None:
        self.sightings.clear()
        self.capped = False

    def _candidates(self, ob: Observation):
        for s in self.sightings.values():
            if s.source != ob.source or s.label != ob.label:
                continue
            if ob.t - s.last_seen > self.window_s:
                continue
            yield s

    def match(self, ob: Observation) -> Optional[Sighting]:
        best: Optional[Tuple[float, Sighting]] = None
        for s in self._candidates(ob):
            d = haversine_m(s.lat, s.lon, ob.lat, ob.lon)
            r = match_radius(s.accuracy_m, ob.accuracy_m)
            same_track = ob.track_id is not None and ob.track_id == s.track_id
            if d <= r or (same_track and d <= 3.0 * r):
                key = d - (1e6 if same_track else 0.0)   # a track id beats distance
                if best is None or key < best[0]:
                    best = (key, s)
        return best[1] if best else None

    def observe(self, ob: Observation) -> Tuple[Optional[Sighting], bool, bool]:
        """Fold one observation in. Returns (sighting, created, best_improved);
        sighting is None when the session is full (MAX_SIGHTINGS)."""
        if not (math.isfinite(ob.lat) and math.isfinite(ob.lon)):
            return None, False, False
        s = self.match(ob)
        if s is None:
            if len(self.sightings) >= self.max_sightings:
                self.capped = True
                return None, False, False
            w = _weight(ob.accuracy_m)
            s = Sighting(id=str(uuid.uuid4()), label=ob.label, source=ob.source,
                         model_name=ob.model_name, task=ob.task, lat=ob.lat, lon=ob.lon,
                         accuracy_m=ob.accuracy_m, first_seen=ob.t, last_seen=ob.t,
                         best_score=ob.score, best_t=ob.t, agl_m=ob.agl_m,
                         angle_source=ob.angle_source, track_id=ob.track_id,
                         _w=w, _wlat=w * ob.lat, _wlon=w * ob.lon)
            self.sightings[s.id] = s
            return s, True, True
        w = _weight(ob.accuracy_m)
        s._w += w
        s._wlat += w * ob.lat
        s._wlon += w * ob.lon
        s.lat, s.lon = s._wlat / s._w, s._wlon / s._w
        s.accuracy_m = min(s.accuracy_m, ob.accuracy_m)
        s.count += 1
        s.first_seen = min(s.first_seen, ob.t)
        s.last_seen = max(s.last_seen, ob.t)
        if ob.track_id is not None:
            s.track_id = ob.track_id
        improved = ob.score is not None and (s.best_score is None or ob.score > s.best_score)
        if improved:
            s.best_score, s.best_t = ob.score, ob.t
            s.agl_m, s.angle_source = ob.agl_m, ob.angle_source
        return s, False, improved

    def counts_by_label(self) -> Dict[str, int]:
        out: Dict[str, int] = {}
        for s in self.sightings.values():
            out[s.label] = out.get(s.label, 0) + 1
        return out

    def all(self) -> List[Sighting]:
        return sorted(self.sightings.values(), key=lambda s: s.first_seen)
