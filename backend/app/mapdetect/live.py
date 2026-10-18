"""
Detections on the map, live: one SessionMap per session.

stream_track hands every analysed frame's result here (ingest) with the
telemetry snapshotted when that frame was captured (vision/base.py puts it
on the result as `_capture`). Each detection is projected to the ground
(geo.py), folded into the session's sightings (track.py), and the changes
go to the session's own socket as `map_sightings` deltas, at most once a
second:

    map_sightings {session_id, upserts: [sighting], cleared: bool,
                   recording: bool, camera: {hfov_deg, pitch_deg, stabilised,
                   source, gimbal}, counts: {label: n}, total, capped,
                   status: {reason, nominal_accuracy_m}}

`upserts` carry a sighting's `thumb` only when it changed; the client keeps
the one it has. `cleared` means drop everything held before applying the
upserts. `status.reason` says why the latest frame's detections could not be
placed (no_gps, no_altitude, above_horizon, too_shallow) or is null.

Recording ("Record to map", off by default) writes the session's sightings
to map_sightings every FLUSH_S seconds and once more when the session ends,
under the flight that is armed at the time. Turning it on also saves what is
already on the map, so what the operator sees is what gets kept.

Clearing empties the LIVE map only. Recorded rows stay with their flight and
are deleted from Settings > Flights, never as a side effect of tidying the
live view.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from app.mapdetect import geo
from app.mapdetect.extract import detections_from, source_of
from app.mapdetect.track import Observation, SightingTracker

logger = logging.getLogger("verocore.mapdetect.live")

MIN_INGEST_S = 0.2       # 5 Hz is plenty for a map; the video runs at 30
PUSH_S = 1.0
FLUSH_S = 5.0
THUMB_PX = 96
THUMBS_PER_FRAME = 4
THUMB_MIN_GAIN = 0.05    # a new best must beat the old by this to re-crop

_sio = None
_session_manager = None
_terrain_enabled = False
_sessions: Dict[str, "SessionMap"] = {}


def configure(sio, session_manager, *, terrain: bool = True) -> None:
    global _sio, _session_manager, _terrain_enabled
    _sio, _session_manager, _terrain_enabled = sio, session_manager, terrain


@dataclass
class SessionMap:
    session_id: str
    tracker: SightingTracker = field(default_factory=SightingTracker)
    camera: geo.CameraSetup = field(default_factory=geo.CameraSetup)
    recording: bool = False
    dirty: set = field(default_factory=set)          # to push
    thumb_dirty: set = field(default_factory=set)    # push with thumb
    unsaved: set = field(default_factory=set)        # to persist
    flight_of: dict = field(default_factory=dict)    # sighting id -> flight id
    cleared: bool = False
    reason: Optional[str] = None
    gimbal: bool = False
    agl_m: Optional[float] = None
    last_ingest: float = 0.0
    last_push: float = 0.0
    last_flush: float = 0.0

    def state(self, *, full: bool = False) -> dict:
        if full:
            ups = [s.to_dict() for s in self.tracker.all()]
        else:
            ups = []
            for sid in self.dirty:
                s = self.tracker.sightings.get(sid)
                if s is None:
                    continue
                d = s.to_dict()
                if sid not in self.thumb_dirty:
                    d.pop("thumb", None)
                ups.append(d)
        nominal = geo.nominal_accuracy_m(self.agl_m, self.camera) if self.agl_m else None
        return {
            "session_id": self.session_id, "upserts": ups,
            "cleared": bool(full or self.cleared), "recording": self.recording,
            "camera": {"hfov_deg": self.camera.hfov_deg, "pitch_deg": self.camera.pitch_deg,
                       "stabilised": self.camera.stabilised, "source": self.camera.source,
                       "gimbal": self.gimbal},
            "counts": self.tracker.counts_by_label(), "total": len(self.tracker),
            "capped": self.tracker.capped, "can_record": _db_up(),
            "status": {"reason": self.reason, "nominal_accuracy_m": nominal},
        }


def _db_up() -> bool:
    try:
        from app.db import db_available
        return bool(db_available())
    except Exception:
        return False


def get(session_id: str) -> Optional[SessionMap]:
    return _sessions.get(session_id)


def ensure(session_id: str) -> SessionMap:
    m = _sessions.get(session_id)
    if m is None:
        m = _sessions[session_id] = SessionMap(session_id)
    return m


# ── terrain (cache-only on the frame path) ───────────────────────────────

_TERRAIN_GRID = 0.0005          # ~55 m: finer than SRTM's 30 m buys nothing
_terrain: Dict[str, Optional[float]] = {}
_terrain_pending: set = set()


def _tkey(lat: float, lon: float) -> str:
    g = _TERRAIN_GRID
    return f"{round(lat / g) * g:.4f}_{round(lon / g) * g:.4f}"


async def _fetch_terrain(keys: list[str]) -> None:
    import httpx
    pts = [{"latitude": float(k.split("_")[0]), "longitude": float(k.split("_")[1])} for k in keys]
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post("https://api.open-elevation.com/api/v1/lookup",
                                  json={"locations": pts})
        if r.status_code == 200:
            for k, item in zip(keys, r.json().get("results", [])):
                e = item.get("elevation")
                _terrain[k] = float(e) if isinstance(e, (int, float)) else None
    except Exception as e:
        logger.debug(f"terrain lookup failed: {e}")
    finally:
        for k in keys:
            _terrain_pending.discard(k)
            _terrain.setdefault(k, None)


def terrain_offset(telemetry: Dict[str, Any]) -> Optional[float]:
    """Ground under the drone minus ground at home, from the cache. Missing
    points are fetched in the background (the frame path never waits); the
    first frames of a flight use relative altitude as is."""
    if not _terrain_enabled:
        return None
    pos = telemetry.get("position") or {}
    hl, hn = telemetry.get("home_lat") or 0.0, telemetry.get("home_lng") or 0.0
    la, lo = pos.get("latitude_deg") or 0.0, pos.get("longitude_deg") or 0.0
    if not (hl or hn) or not (la or lo):
        return None
    keys = [_tkey(hl, hn), _tkey(la, lo)]
    missing = [k for k in keys if k not in _terrain and k not in _terrain_pending]
    if missing:
        try:
            loop = asyncio.get_running_loop()
            _terrain_pending.update(missing)
            loop.create_task(_fetch_terrain(missing))
        except RuntimeError:
            pass
    home, here = _terrain.get(keys[0]), _terrain.get(keys[1])
    if home is None or here is None:
        return None
    return here - home


# ── the frame path ───────────────────────────────────────────────────────

def _thumb(frame, box) -> Optional[str]:
    if frame is None or not box:
        return None
    try:
        import cv2
        h, w = frame.shape[:2]
        x1, y1, x2, y2 = (int(round(v)) for v in box[:4])
        bw, bh = x2 - x1, y2 - y1
        if bw < 8 or bh < 8:
            return None
        pad = int(0.15 * max(bw, bh))
        x1, y1 = max(0, x1 - pad), max(0, y1 - pad)
        x2, y2 = min(w, x2 + pad), min(h, y2 + pad)
        crop = frame[y1:y2, x1:x2]
        if crop.size == 0:
            return None
        s = THUMB_PX / max(crop.shape[:2])
        if s < 1.0:
            crop = cv2.resize(crop, (max(1, int(crop.shape[1] * s)), max(1, int(crop.shape[0] * s))),
                              interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if not ok:
            return None
        return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()
    except Exception:
        return None


def ingest(session_id: str, mode: str, meta: Dict[str, Any], capture: Optional[Dict[str, Any]],
           frame=None, *, now: Optional[float] = None) -> Optional[SessionMap]:
    """Fold one analysed frame in. Cheap and synchronous: projection is a
    3x3 rotation per box, thumbnails at most THUMBS_PER_FRAME small crops."""
    dets = detections_from(mode, meta)
    if not dets:
        return _sessions.get(session_id)
    m = ensure(session_id)
    now = time.time() if now is None else now
    if now - m.last_ingest < MIN_INGEST_S:
        return m
    m.last_ingest = now
    capture = capture or {}
    tel = capture.get("telemetry")
    w, h = int(capture.get("width") or 0), int(capture.get("height") or 0)
    if tel:
        agl, _ = geo.height_above_ground(tel, None)
        m.agl_m = agl
        m.gimbal = geo.gimbal_pitch(tel) is not None
    t_capture = float(capture.get("wall_time") or now)
    source, model_name = source_of(mode, meta)
    offset = terrain_offset(tel) if tel else None
    reason = None
    placed = 0
    thumbs = 0
    for d in dets:
        u, v = geo.box_anchor(d.box, d.task, w, h)
        res = geo.project_pixel(tel, u, v, w, h, m.camera, offset)
        if not res.ok:
            reason = res.reason
            continue
        f = res.fix
        s, created, improved = m.tracker.observe(Observation(
            label=d.label, lat=f.lat, lon=f.lon, accuracy_m=f.accuracy_m, t=t_capture,
            score=d.score, source=source, model_name=model_name, task=d.task,
            track_id=d.track_id, agl_m=f.agl_m, angle_source=f.angle_source))
        if s is None:
            continue
        placed += 1
        m.dirty.add(s.id)
        if m.recording:
            m.unsaved.add(s.id)
        want_thumb = (d.task == "detect" and thumbs < THUMBS_PER_FRAME and (
            s.thumb is None or (improved and not created and d.score is not None
                                and d.score - s._thumb_score >= THUMB_MIN_GAIN)))
        if want_thumb:
            t = _thumb(frame, d.box)
            if t:
                s.thumb = t
                s._thumb_score = d.score or 0.0
                m.thumb_dirty.add(s.id)
                thumbs += 1
    # Why nothing could be placed, for the panel; any placement clears it.
    m.reason = None if placed else reason
    _schedule(m, now)
    return m


def _schedule(m: SessionMap, now: float) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    if (m.dirty or m.cleared) and now - m.last_push >= PUSH_S:
        m.last_push = now
        loop.create_task(push(m.session_id))
    if m.recording and m.unsaved and now - m.last_flush >= FLUSH_S:
        m.last_flush = now
        loop.create_task(flush(m.session_id))


async def push(session_id: str, *, full: bool = False, payload: Optional[dict] = None) -> Optional[dict]:
    m = _sessions.get(session_id)
    if m is None:
        return None
    payload = payload or m.state(full=full)
    m.dirty.clear()
    m.thumb_dirty.clear()
    m.cleared = False
    if _sio is None or _session_manager is None:
        return payload
    s = _session_manager.get(session_id)
    if s is None or not s.socket_id:
        return payload
    try:
        await _sio.emit("map_sightings", payload, to=s.socket_id)
    except Exception as e:
        logger.debug(f"map_sightings to {session_id[:8]} failed: {e}")
    return payload


def _session_ids(session_id: str) -> tuple[Optional[str], Optional[str]]:
    """(workspace_id, drone_id) of a live session."""
    if _session_manager is None:
        return None, None
    s = _session_manager.get(session_id)
    if s is None:
        return None, None
    return getattr(s, "workspace_id", None), ((getattr(s, "drone", None) or {}).get("id"))


def _current_flight(session_id: str) -> Optional[str]:
    try:
        from app.flights import recorder
        return (recorder._active.get(session_id) or {}).get("flight_id")
    except Exception:
        return None


async def flush(session_id: str) -> int:
    """Write the session's changed sightings to map_sightings."""
    m = _sessions.get(session_id)
    if m is None or not m.unsaved:
        return 0
    from app.mapdetect import store
    ids, m.unsaved = m.unsaved, set()
    ws, drone = _session_ids(session_id)
    fid = _current_flight(session_id)
    rows = []
    for sid in ids:
        s = m.tracker.sightings.get(sid)
        if s is None:
            continue
        if fid and not m.flight_of.get(sid):
            m.flight_of[sid] = fid
        rows.append({**s.to_dict(), "session_id": session_id, "workspace_id": ws,
                     "drone_id": drone, "flight_id": m.flight_of.get(sid)})
    n = await store.upsert(rows)
    if rows and n == 0:
        # Not written (database away): keep them for the next flush.
        m.unsaved |= {r["id"] for r in rows}
    return n


# ── controls (socket handlers and REST call these) ───────────────────────

async def set_camera(session_id: str, data: Optional[dict]) -> dict:
    m = ensure(session_id)
    m.camera = geo.CameraSetup.from_dict(data)
    return await push(session_id, payload=m.state()) or m.state()


async def set_recording(session_id: str, on: bool) -> dict:
    m = ensure(session_id)
    m.recording = bool(on)
    if m.recording:
        m.unsaved |= set(m.tracker.sightings)
        await flush(session_id)
    else:
        # Off: what was already seen while on is saved, nothing after.
        await flush(session_id)
        m.unsaved.clear()
    return await push(session_id, payload=m.state()) or m.state()


async def clear(session_id: str) -> dict:
    """Empty the live map (recorded rows stay with their flight)."""
    m = ensure(session_id)
    if m.recording and m.unsaved:
        await flush(session_id)
    m.tracker.clear()
    m.dirty.clear()
    m.thumb_dirty.clear()
    m.unsaved.clear()
    m.flight_of.clear()
    m.cleared = True
    return await push(session_id, payload=m.state()) or m.state()


def snapshot(session_id: str) -> dict:
    """Everything on the session's live map (REST and resume)."""
    m = _sessions.get(session_id)
    if m is None:
        return SessionMap(session_id).state(full=True)
    return m.state(full=True)


async def end_session(session_id: str) -> None:
    """Session torn down: save what recording has not saved yet, drop the rest."""
    m = _sessions.get(session_id)
    if m is None:
        return
    if m.recording and m.unsaved:
        await flush(session_id)
    _sessions.pop(session_id, None)
