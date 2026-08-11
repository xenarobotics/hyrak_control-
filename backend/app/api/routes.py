import contextlib
import asyncio
import base64
import csv
import io
import logging
import math
import os
import zipfile
from datetime import datetime
from typing import List
from fastapi import APIRouter, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
import cv2
import numpy as np
from app.config import get_settings

logger = logging.getLogger("verocore.api")
router = APIRouter(prefix="/api")
settings = get_settings()

# ── In-memory terrain elevation cache ────────────────────────────────────────
# Key: "lat5_lng5" (5 decimal places ≈ 1.1m precision)
# Value: elevation in metres above WGS84 ellipsoid
_terrain_cache: dict[str, float] = {}


@router.get("/health")
async def health():
    return {
        "status": "ok",
        "version": "0.1.0",
        "device": settings.device,
        "gpu_count": settings.gpu_count,
        "gpus": settings.gpu_info,
    }


@router.get("/webrtc/ice-servers")
async def ice_servers():
    """STUN + TURN list for RTCPeerConnection. TURN credentials are minted
    short-lived from the Cloudflare key in .env — needed on networks that
    block UDP (campus WiFi), where STUN-only ICE can never connect."""
    from app.webrtc.turn import get_ice_servers
    return {"iceServers": await get_ice_servers()}


@router.get("/sessions")
async def get_sessions(request: Request):
    """Live client sessions for the /admin observer page (admin sockets
    themselves are excluded)."""
    sm = request.app.state.session_manager
    sessions = []
    for s in sm.all_sessions():
        if s.is_admin:
            continue
        # Compact live-state summary so the admin map can plot every drone
        # without opening a full telemetry mirror per session.
        live = None
        tel = sm.get_telemetry(s.session_id)
        if tel and tel.is_connected:
            from app.zones import monitor as zone_monitor
            snap = tel.snapshot
            live = {
                "zone_class": zone_monitor.current_class(s.session_id),
                "lat": snap.position.latitude_deg,
                "lng": snap.position.longitude_deg,
                "alt": snap.position.relative_altitude_m,
                "heading": snap.heading_deg,
                "armed": snap.flight_mode.is_armed,
                "in_air": snap.flight_mode.is_in_air,
                "mode": snap.flight_mode.mode,
                "battery": snap.battery.remaining_percent,
            }
        sessions.append({
            "session_id": s.session_id,
            "mode": s.mode.value,
            "is_streaming": s.is_streaming,
            "telemetry_connected": s.telemetry_connected,
            "drone_address": s.drone_address,
            "hardware_uid": s.hardware_uid,
            "drone": s.drone,
            "live": live,
            "approx_location": s.approx_location,
        })

    # Swarm fleet drones connect server-side (UDP SITL) rather than through a
    # client session, so they're reported separately with the same live shape.
    fleet = []
    try:
        from app.events.swarm_events import _fleet_state, _fleet_db_ids
        from app.zones import engine as zone_engine
        for did, mgr in sorted(sm.get_fleet("").items()):
            if not mgr.is_connected:
                continue
            snap = _fleet_state.get(did) or {}
            pos = snap.get("position", {})
            fm = snap.get("flight_mode", {})
            lat = pos.get("latitude_deg", 0.0)
            lng = pos.get("longitude_deg", 0.0)
            alt = pos.get("relative_altitude_m", 0.0)
            fleet.append({
                "drone_id": did,
                "db_id": _fleet_db_ids.get(did),
                "hardware_uid": f"sitl-instance-{did}",
                "is_simulated": True,
                "live": {
                    "zone_class": (zone_engine.check_point(lat, lng, alt)["zone_class"]
                                   if (lat or lng) else "green"),
                    "lat": lat,
                    "lng": lng,
                    "alt": alt,
                    "heading": snap.get("heading_deg", 0.0),
                    "armed": bool(fm.get("is_armed")),
                    "in_air": bool(fm.get("is_in_air")),
                    "mode": fm.get("mode", "UNKNOWN"),
                    "battery": snap.get("battery", {}).get("remaining_percent", 0.0),
                } if snap else None,
            })
    except Exception:
        pass

    return {"active_sessions": len(sessions), "sessions": sessions, "fleet_drones": fleet}


@router.get("/drones")
async def get_drones():
    """Every drone ever seen by the platform (persistent registry)."""
    from app.registry import drones as drone_registry
    return {"drones": await drone_registry.list_drones()}


# ── Zones ────────────────────────────────────────────────────────────────

@router.get("/zones")
async def get_zones():
    """All zones as a GeoJSON FeatureCollection (inactive included)."""
    from sqlalchemy import select
    from app.db import db_available, get_session
    from app.db.models import Zone
    if not db_available():
        return {"type": "FeatureCollection", "features": []}
    async with get_session() as db:
        rows = (await db.execute(select(Zone).order_by(Zone.created_at))).scalars().all()
    return {"type": "FeatureCollection", "features": [z.to_feature() for z in rows]}


@router.post("/zones")
async def create_zone(
    body: dict,
    x_auth_token: str = Header(None, alias="X-Auth-Token"),
):
    """Create a zone. body: {name, zone_class, geometry, floor_m?, ceiling_m?}"""
    if x_auth_token != settings.secret_token:
        raise HTTPException(status_code=403, detail="Invalid token")
    zone_class = body.get("zone_class")
    if zone_class not in ("green", "orange", "red"):
        raise HTTPException(status_code=400, detail="zone_class must be green/orange/red")
    geometry = body.get("geometry")
    if not geometry or geometry.get("type") not in ("Polygon", "MultiPolygon"):
        raise HTTPException(status_code=400, detail="geometry must be a GeoJSON (Multi)Polygon")
    from shapely.geometry import shape
    try:
        geom = shape(geometry)
        if not geom.is_valid or geom.is_empty:
            raise ValueError("invalid polygon")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Bad geometry: {e}")

    from app.db import db_available, get_session
    from app.db.models import Zone
    from app.zones import engine as zone_engine
    if not db_available():
        raise HTTPException(status_code=503, detail="Database offline")
    zone = Zone(
        name=(body.get("name") or f"{zone_class} zone").strip()[:120],
        zone_class=zone_class,
        geometry=geometry,
        floor_m=float(body.get("floor_m") or 0.0),
        ceiling_m=float(body["ceiling_m"]) if body.get("ceiling_m") not in (None, "") else None,
    )
    async with get_session() as db:
        db.add(zone)
        await db.commit()
        feature = zone.to_feature()
    await zone_engine.reload()
    logger.info(f"Zone created: {zone.name} ({zone_class})")
    return {"zone": feature}


@router.patch("/zones/{zone_id}")
async def patch_zone(
    zone_id: str,
    body: dict,
    x_auth_token: str = Header(None, alias="X-Auth-Token"),
):
    """Edit zone properties: name, zone_class, floor_m, ceiling_m, active.
    (Geometry changes = delete + redraw.)"""
    if x_auth_token != settings.secret_token:
        raise HTTPException(status_code=403, detail="Invalid token")
    from sqlalchemy import select
    from app.db import db_available, get_session
    from app.db.models import Zone
    from app.zones import engine as zone_engine
    if not db_available():
        raise HTTPException(status_code=503, detail="Database offline")
    async with get_session() as db:
        zone = (
            await db.execute(select(Zone).where(Zone.id == zone_id))
        ).scalar_one_or_none()
        if zone is None:
            raise HTTPException(status_code=404, detail="Zone not found")
        if "name" in body and str(body["name"]).strip():
            zone.name = str(body["name"]).strip()[:120]
        if "zone_class" in body:
            if body["zone_class"] not in ("green", "orange", "red"):
                raise HTTPException(status_code=400, detail="bad zone_class")
            zone.zone_class = body["zone_class"]
        if "floor_m" in body:
            zone.floor_m = float(body["floor_m"] or 0.0)
        if "ceiling_m" in body:
            zone.ceiling_m = (
                float(body["ceiling_m"]) if body["ceiling_m"] not in (None, "") else None
            )
        if "active" in body:
            zone.active = bool(body["active"])
        await db.commit()
        feature = zone.to_feature()
    await zone_engine.reload()
    return {"zone": feature}


@router.delete("/zones/{zone_id}")
async def delete_zone(
    zone_id: str,
    x_auth_token: str = Header(None, alias="X-Auth-Token"),
):
    if x_auth_token != settings.secret_token:
        raise HTTPException(status_code=403, detail="Invalid token")
    from sqlalchemy import delete as sa_delete
    from app.db import db_available, get_session
    from app.db.models import Zone
    from app.zones import engine as zone_engine
    if not db_available():
        raise HTTPException(status_code=503, detail="Database offline")
    async with get_session() as db:
        await db.execute(sa_delete(Zone).where(Zone.id == zone_id))
        await db.commit()
    await zone_engine.reload()
    return {"ok": True}


@router.get("/zones/check")
async def zones_check(
    lat: float = Query(...),
    lng: float = Query(...),
    alt: float = Query(None),
):
    """Zone class at a point — used by clients and for quick testing."""
    from app.zones import engine as zone_engine
    return zone_engine.check_point(lat, lng, alt)


# ── Flights ──────────────────────────────────────────────────────────────

@router.get("/drones/{drone_id}/flights")
async def get_drone_flights(drone_id: str, limit: int = Query(30, le=200)):
    from sqlalchemy import select
    from app.db import db_available, get_session
    from app.db.models import Flight
    if not db_available():
        return {"flights": []}
    async with get_session() as db:
        rows = (
            await db.execute(
                select(Flight).where(Flight.drone_id == drone_id)
                .order_by(Flight.started_at.desc()).limit(limit)
            )
        ).scalars().all()
    return {"flights": [f.to_dict() for f in rows]}


@router.get("/flights/{flight_id}/download")
async def download_flight(flight_id: str):
    """Full 1 Hz flight track as CSV."""
    from fastapi.responses import PlainTextResponse
    from sqlalchemy import select
    from app.db import db_available, get_session
    from app.db.models import Flight, FlightSample
    if not db_available():
        raise HTTPException(status_code=503, detail="Database offline")
    async with get_session() as db:
        flight = (
            await db.execute(select(Flight).where(Flight.id == flight_id))
        ).scalar_one_or_none()
        if flight is None:
            raise HTTPException(status_code=404, detail="Flight not found")
        samples = (
            await db.execute(
                select(FlightSample).where(FlightSample.flight_id == flight_id)
                .order_by(FlightSample.t)
            )
        ).scalars().all()
    lines = ["time_utc,lat,lng,alt_m,heading_deg,groundspeed_m_s,battery_pct,mode"]
    for s in samples:
        lines.append(
            f"{s.t.isoformat()},{s.lat:.7f},{s.lng:.7f},{s.alt_m:.1f},"
            f"{s.heading_deg:.1f},{s.groundspeed_m_s:.2f},{s.battery_pct:.1f},{s.mode}"
        )
    stamp = flight.started_at.strftime("%Y%m%d_%H%M") if flight.started_at else flight_id[:8]
    return PlainTextResponse(
        "\n".join(lines),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="flight_{stamp}.csv"'},
    )


# ── Crowd management / vehicle-plate tracking ───────────────────────────────
#
# Data is retained by default (see app/vision/persistence.py) — no auto
# purge. The two /download endpoints below are read-only exports for a
# single session (manual "Download report" button); the /history endpoints
# back the "previous sessions" sidebar across ALL sessions; /clear wipes
# everything on explicit operator request. Nothing is ever deleted as a
# side effect of viewing or downloading it.

@router.get("/sessions/{session_id}/crowd-report/download")
async def download_crowd_report(session_id: str):
    from app.vision.persistence import export_crowd_report
    report = await export_crowd_report(session_id)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        snap_csv = io.StringIO()
        w = csv.DictWriter(snap_csv, fieldnames=[
            "t", "current_count", "peak_count", "density_level", "section_counts",
        ])
        w.writeheader()
        w.writerows(report["snapshots"])
        zf.writestr("crowd_snapshots.csv", snap_csv.getvalue())

        alert_csv = io.StringIO()
        w = csv.DictWriter(alert_csv, fieldnames=["t", "level", "section_idx", "count", "message"])
        w.writeheader()
        w.writerows(report["alerts"])
        zf.writestr("crowd_alerts.csv", alert_csv.getvalue())
    buf.seek(0)

    stamp = datetime.now().strftime("%Y%m%d_%H%M")
    return StreamingResponse(
        buf, media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="crowd_report_{stamp}.zip"'},
    )


def _plate_grade(ev: dict) -> str:
    """
    One sortable word for how much a plate reading is worth.

    The three raw fields answer different questions — how many pixels were
    there, how many independent frames agreed, does it match a plate pattern —
    and a reviewer with a few hundred rows needs one column to filter on, not
    three to cross-reference by eye.

    Thresholds match the live module's own (_PLATE_GOOD_PX, _OCR_GOOD_ENOUGH,
    _PLATE_MIN_AGREEING_READS), so what the CSV calls "strong" is exactly what
    the panel showed as settled during the flight.
    """
    text = (ev.get("plate_text") or "").strip()
    if not text:
        return ""
    px = int(ev.get("plate_px_w") or 0)
    conf = float(ev.get("ocr_confidence") or 0.0)
    votes = int(ev.get("plate_votes") or 0)
    if px >= 110 and conf >= 0.80 and votes >= 2:
        return "strong"
    if px >= 70 and votes >= 2:
        return "good"
    # Everything else is reported and kept — it is often the only look a
    # passing vehicle ever gave — but it is one frame's opinion of a small
    # crop, and the column says so.
    return "weak"


@router.get("/sessions/{session_id}/plate-report/download")
async def download_plate_report(session_id: str):
    from app.vision.persistence import export_plate_report
    events = await export_plate_report(session_id)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        rows_csv = io.StringIO()
        # One row per VEHICLE, with the plate filled in where one was read.
        #
        # THE EVIDENCE TRAVELS WITH THE READING. A 40px single-frame guess and
        # a 300px plate three frames agreed on are both legitimate rows, and
        # they are not equally trustworthy — so width, agreement count and
        # grammar all come along, and `plate_grade` collapses them into the one
        # column a reviewer can actually sort and filter a session on. Deriving
        # the grade HERE rather than storing it keeps the raw numbers
        # authoritative: the thresholds can be argued with afterwards, which
        # they could not be if only the verdict had been kept.
        fieldnames = [
            "vehicle_id", "track_id", "plate_text", "plate_grade",
            "ocr_confidence", "plate_px_w", "plate_votes", "plate_grammar_ok",
            "vehicle_type", "vehicle_color", "vehicle_color_conf",
            "speed_est_kmh", "heading_deg", "against_flow",
            "lat", "lng", "alt_m",
            "first_seen", "last_seen", "image_path", "vehicle_image_path",
        ]
        w = csv.DictWriter(rows_csv, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        for ev in events:
            row = dict(ev)
            row["plate_grade"] = _plate_grade(ev)
            # Both images, in separate folders so a reviewer can flip through
            # the car photos without the plate crops interleaved.
            for field, folder in (("image_path", "plates"),
                                  ("vehicle_image_path", "vehicles")):
                path = ev.get(field)
                if path and os.path.exists(path):
                    row[field] = f"{folder}/{os.path.basename(path)}"
                    zf.write(path, arcname=row[field])
                else:
                    row[field] = ""
            w.writerow(row)
        zf.writestr("vehicle_log.csv", rows_csv.getvalue())
    buf.seek(0)

    stamp = datetime.now().strftime("%Y%m%d_%H%M")
    return StreamingResponse(
        buf, media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="plate_report_{stamp}.zip"'},
    )


@router.get("/vision/crowd-history")
async def crowd_history(limit: int = Query(10, le=50)):
    from app.vision.persistence import list_crowd_history
    return await list_crowd_history(limit=limit)


@router.get("/vision/plate-history")
async def plate_history(limit: int = Query(50, le=200)):
    from app.vision.persistence import list_plate_history
    return {"events": await list_plate_history(limit=limit)}


@router.get("/vision/plate-history/{event_id}/image")
async def plate_history_image(event_id: str):
    from fastapi.responses import FileResponse
    from app.vision.persistence import get_plate_image_path
    path = await get_plate_image_path(event_id)
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(path, media_type="image/jpeg")


@router.delete("/vision/crowd-history")
async def clear_crowd_history_route(x_auth_token: str = Header(None, alias="X-Auth-Token")):
    if x_auth_token != settings.secret_token:
        raise HTTPException(status_code=403, detail="Invalid token")
    from app.vision.persistence import clear_crowd_history
    await clear_crowd_history()
    return {"cleared": True}


@router.delete("/vision/plate-history")
async def clear_plate_history_route(x_auth_token: str = Header(None, alias="X-Auth-Token")):
    if x_auth_token != settings.secret_token:
        raise HTTPException(status_code=403, detail="Invalid token")
    from app.vision.persistence import clear_plate_history
    await clear_plate_history()
    return {"cleared": True}


# ── Camera calibration ───────────────────────────────────────────────────
#
# The field TABLE is served alongside the values so the UI renders inputs from
# it. Declaring "hfov is 1-179 degrees" in Python and again in TypeScript is
# how the two drift apart and the form starts accepting values the backend then
# rejects — see app/vision/calibration.py.


@router.get("/vision/calibration")
async def get_calibration():
    """Field definitions plus current effective values."""
    from app.vision import calibration
    return calibration.schema()


@router.put("/vision/calibration")
async def put_calibration(
    updates: dict,
    x_auth_token: str = Header(None, alias="X-Auth-Token"),
):
    """
    Save a partial calibration update.

    All-or-nothing: one invalid field rejects the whole request rather than
    saving half of it, because a half-applied calibration would be flying.

    WHEN A CHANGE TAKES EFFECT depends on the group, and the difference matters
    to whoever is standing under the aircraft:

      camera / limits   the next frame. They are read on the frame path.
      follow            the next time a tracking mode STARTS. The yaw PD is
                        built once per session, deliberately — re-reading it
                        per frame would put a settings lookup on the control
                        loop, and swapping gains under a live PD changes the
                        aircraft's behaviour mid-manoeuvre with nobody having
                        touched a control.
    """
    settings = get_settings()
    if x_auth_token != settings.secret_token:
        raise HTTPException(status_code=403, detail="Invalid token")
    from app.vision import calibration
    try:
        calibration.save(updates)
    except ValueError as e:
        # The operator's own message, not a stack trace.
        raise HTTPException(status_code=400, detail=str(e))
    return {"saved": True, **calibration.schema()}


@router.delete("/vision/calibration")
async def reset_calibration(x_auth_token: str = Header(None, alias="X-Auth-Token")):
    """Drop every override and fall back to the deploy-time defaults."""
    settings = get_settings()
    if x_auth_token != settings.secret_token:
        raise HTTPException(status_code=403, detail="Invalid token")
    from app.vision import calibration
    calibration.reset()
    return {"reset": True, **calibration.schema()}


# ── Face gallery ─────────────────────────────────────────────────────────
#
# The enrolled-identity side of face recognition. The /reference-photo route
# above is untouched and still works exactly as before: upload a photo, follow
# that person. This adds the other way in — a persistent database of known
# people that the tracker can match against with nobody selecting a target.
#
# Every mutating route is token-gated. This is durable biometric data, and it
# is the one dataset in this system with no automatic expiry.


@router.get("/vision/face-gallery")
async def face_gallery_list():
    """Enrolled people with photo counts."""
    from app.vision.persistence import list_persons
    return {"persons": await list_persons()}


@router.post("/vision/face-gallery/enrol")
async def face_gallery_enrol(
    name:  str = Query(..., min_length=1, max_length=120),
    notes: str = Query(""),
    files: list[UploadFile] = File(...),
    x_auth_token: str = Header(None, alias="X-Auth-Token"),
):
    """
    Enrol one person from uploaded photos.

    Adding photos to an existing name extends that person rather than creating
    a duplicate, so this is safe to call repeatedly.

    Results are per image: a photo with no detectable face is reported rather
    than silently dropped, because a thin enrolment is the difference between
    recognition working and not, and the operator needs to know which file to
    re-shoot.
    """
    settings = get_settings()
    if x_auth_token != settings.secret_token:
        raise HTTPException(status_code=403, detail="Invalid token")

    import os
    import tempfile
    from app.vision.persistence import enrol_person_images

    tmp_paths = []
    try:
        for f in files:
            suffix = os.path.splitext(f.filename or "")[1].lower() or ".jpg"
            fd, path = tempfile.mkstemp(suffix=suffix)
            with os.fdopen(fd, "wb") as fh:
                fh.write(await f.read())
            # The original filename is what the operator recognises in the
            # results, so it is preserved rather than the temp name.
            tmp_paths.append((path, f.filename or os.path.basename(path)))

        results = await enrol_person_images(name, [p for p, _ in tmp_paths], notes)
        by_index = {i: orig for i, (_, orig) in enumerate(tmp_paths)}
        out = []
        for i, r in enumerate(results):
            out.append({
                "filename": by_index.get(i, r.filename),
                "ok": r.ok,
                "reason": r.reason,
                "det_score": round(r.det_score, 3),
            })
        return {
            "person": name,
            "enrolled": sum(1 for r in results if r.ok),
            "total": len(results),
            "results": out,
        }
    finally:
        for path, _ in tmp_paths:
            with contextlib.suppress(OSError):
                os.remove(path)


@router.post("/vision/face-gallery/enrol-folder")
async def face_gallery_enrol_folder(
    path: str = Query(..., description="Folder laid out as <root>/<person name>/<images>"),
    x_auth_token: str = Header(None, alias="X-Auth-Token"),
):
    """
    Enrol a whole `<root>/<person name>/<image>` tree in one call — the layout
    of the provided sample set, so it needs no reshuffling.

    Server-side path, so it is token-gated like every other mutation here.
    """
    settings = get_settings()
    if x_auth_token != settings.secret_token:
        raise HTTPException(status_code=403, detail="Invalid token")

    import os
    if not os.path.isdir(path):
        raise HTTPException(status_code=400, detail=f"Not a directory: {path}")

    from app.vision.persistence import enrol_from_folder
    results = await enrol_from_folder(path)
    if not results:
        raise HTTPException(
            status_code=400,
            detail="No <name>/<image> subfolders found — expected "
                   "photos/<person name>/*.jpg",
        )
    people: dict[str, dict] = {}
    for r in results:
        entry = people.setdefault(r.person_name, {"enrolled": 0, "failed": [], "total": 0})
        entry["total"] += 1
        if r.ok:
            entry["enrolled"] += 1
        else:
            entry["failed"].append({"filename": r.filename, "reason": r.reason})
    return {
        "enrolled": sum(1 for r in results if r.ok),
        "total": len(results),
        "persons": people,
    }


@router.patch("/vision/face-gallery/{person_id}")
async def face_gallery_set_active(
    person_id: str,
    active: bool = Query(...),
    x_auth_token: str = Header(None, alias="X-Auth-Token"),
):
    """Take someone out of matching without destroying the enrolment — for
    investigating a match that keeps misfiring."""
    settings = get_settings()
    if x_auth_token != settings.secret_token:
        raise HTTPException(status_code=403, detail="Invalid token")
    from app.vision.persistence import set_person_active
    if not await set_person_active(person_id, active):
        raise HTTPException(status_code=404, detail="Person not found")
    return {"person_id": person_id, "active": active}


@router.delete("/vision/face-gallery/{person_id}")
async def face_gallery_delete_person(
    person_id: str,
    x_auth_token: str = Header(None, alias="X-Auth-Token"),
):
    """Erase a person, their embeddings, and their stored photos."""
    settings = get_settings()
    if x_auth_token != settings.secret_token:
        raise HTTPException(status_code=403, detail="Invalid token")
    from app.vision.persistence import delete_person
    if not await delete_person(person_id):
        raise HTTPException(status_code=404, detail="Person not found")
    return {"deleted": person_id}


@router.delete("/vision/face-gallery")
async def face_gallery_clear(x_auth_token: str = Header(None, alias="X-Auth-Token")):
    """
    Erase the entire gallery — every identity and every stored photo.

    The explicit deletion path this data category requires, since nothing here
    is ever purged automatically.
    """
    settings = get_settings()
    if x_auth_token != settings.secret_token:
        raise HTTPException(status_code=403, detail="Invalid token")
    from app.vision.persistence import clear_face_gallery
    await clear_face_gallery()
    return {"cleared": True}


@router.get("/vision/sightings")
async def face_gallery_sightings(
    session_id: str | None = Query(None),
    limit: int = Query(200, le=1000),
):
    """Gallery-match audit trail — what the system claimed, when."""
    from app.vision.persistence import list_sightings
    return {"sightings": await list_sightings(session_id=session_id, limit=limit)}


@router.delete("/vision/sightings")
async def face_gallery_clear_sightings(
    session_id: str | None = Query(None),
    x_auth_token: str = Header(None, alias="X-Auth-Token"),
):
    settings = get_settings()
    if x_auth_token != settings.secret_token:
        raise HTTPException(status_code=403, detail="Invalid token")
    from app.vision.persistence import clear_sightings
    await clear_sightings(session_id=session_id)
    return {"cleared": True, "session_id": session_id}


# ── Permits ──────────────────────────────────────────────────────────────

@router.get("/permits")
async def get_permits(status: str = Query(None)):
    """Permit list for the admin console."""
    from app.permits import service
    return {"permits": await service.list_permits(status=status)}


@router.post("/permits/{permit_id}/decision")
async def decide_permit(
    permit_id: str,
    body: dict,
    x_auth_token: str = Header(None, alias="X-Auth-Token"),
):
    if x_auth_token != settings.secret_token:
        raise HTTPException(status_code=403, detail="Invalid token")
    from app.permits import service
    decided = await service.decide(permit_id, bool(body.get("approve")))
    if decided is None:
        raise HTTPException(status_code=404, detail="Permit not found (or DB offline)")
    return {"permit": decided}


@router.get("/flights/{flight_id}")
async def get_flight(flight_id: str):
    """Flight summary + full 1 Hz track."""
    from sqlalchemy import select
    from app.db import db_available, get_session
    from app.db.models import Flight, FlightSample
    if not db_available():
        raise HTTPException(status_code=503, detail="Database offline")
    async with get_session() as db:
        flight = (
            await db.execute(select(Flight).where(Flight.id == flight_id))
        ).scalar_one_or_none()
        if flight is None:
            raise HTTPException(status_code=404, detail="Flight not found")
        samples = (
            await db.execute(
                select(FlightSample).where(FlightSample.flight_id == flight_id)
                .order_by(FlightSample.t)
            )
        ).scalars().all()
    return {
        "flight": flight.to_dict(),
        "track": [
            {
                "t": s.t.isoformat(), "lat": s.lat, "lng": s.lng, "alt": s.alt_m,
                "speed": s.groundspeed_m_s, "battery": s.battery_pct, "mode": s.mode,
            }
            for s in samples
        ],
    }


@router.patch("/drones/{drone_id}")
async def patch_drone(
    drone_id: str,
    body: dict,
    x_auth_token: str = Header(None, alias="X-Auth-Token"),
):
    """Rename a drone. Auth: same X-Auth-Token as other write endpoints."""
    if x_auth_token != settings.secret_token:
        raise HTTPException(status_code=403, detail="Invalid token")
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    from app.registry import drones as drone_registry
    updated = await drone_registry.rename_drone(drone_id, name)
    if updated is None:
        raise HTTPException(status_code=404, detail="Drone not found (or DB offline)")
    return {"drone": updated}


@router.post("/reference-photo")
async def upload_reference_photo(
    request:    Request,
    file:       UploadFile = File(...),
    session_id: str        = Query(..., description="Session ID from session_ready event"),
    x_auth_token: str      = Header(None, alias="X-Auth-Token"),
):
    """
    Accept a reference photo, extract the face embedding via InsightFace,
    and store it in the PersonTracker for the given session.

    Returns a base64 JPEG thumbnail of the detected face so the frontend
    can show a preview confirming which face was registered.

    Auth: pass the same NEXT_PUBLIC_SECRET_TOKEN as X-Auth-Token header.
    """
    settings = get_settings()
    if x_auth_token != settings.secret_token:
        raise HTTPException(status_code=403, detail="Invalid token")

    # ── Decode image ──────────────────────────────────────────────────────
    data = await file.read()
    img_array = np.frombuffer(data, np.uint8)
    img_bgr   = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
    if img_bgr is None:
        raise HTTPException(status_code=400, detail="Could not decode image — use JPEG or PNG")

    # ── Get PersonTracker for this session ────────────────────────────────
    # The model may still be loading (switch_mode is async).
    # Wait up to 20 s for it to finish before giving up.
    vision_pool = request.app.state.vision_pool
    from app.vision.modules.person_tracker import PersonTracker

    analyzer = vision_pool.get_for_session(session_id)
    if analyzer is None:
        for _ in range(40):
            if not vision_pool.is_loading(session_id):
                break
            await asyncio.sleep(0.5)
        analyzer = vision_pool.get_for_session(session_id)

    if analyzer is None:
        if vision_pool.is_loading(session_id):
            raise HTTPException(
                status_code=503,
                detail="Model is still loading — please wait a moment and try again",
            )
        raise HTTPException(
            status_code=400,
            detail=(
                "Person-tracking model not loaded. "
                "Select Person ID mode first, then upload — "
                "or check backend logs (insightface may not be installed: "
                "pip install insightface onnxruntime)"
            ),
        )

    if not isinstance(analyzer, PersonTracker):
        raise HTTPException(
            status_code=400,
            detail="Session is not in person-tracking mode — select Person ID mode first",
        )

    # ── Extract face embedding (blocking, run in thread) ─────────────────
    embedding, face_crop = await asyncio.to_thread(
        analyzer.extract_reference_embedding, img_bgr
    )

    if embedding is None:
        raise HTTPException(
            status_code=422,
            detail="No face detected in the uploaded photo — use a clear front-facing photo",
        )

    # ── Store embedding ───────────────────────────────────────────────────
    analyzer.set_reference_embedding(session_id, embedding)

    # ── Encode face thumbnail as base64 for preview ───────────────────────
    face_resized = cv2.resize(face_crop, (120, 120), interpolation=cv2.INTER_AREA)
    _, buf       = cv2.imencode(".jpg", face_resized, [cv2.IMWRITE_JPEG_QUALITY, 85])
    face_b64     = base64.b64encode(buf.tobytes()).decode()

    logger.info(f"Reference photo set for session {session_id[:8]}")
    return {
        "ok":            True,
        "face_thumbnail": f"data:image/jpeg;base64,{face_b64}",
        "message":       "Reference face registered successfully",
    }


@router.get("/terrain/elevation")
async def get_terrain_elevation(
    lats: str = Query(..., description="Comma-separated latitudes"),
    lngs: str = Query(..., description="Comma-separated longitudes"),
):
    """
    Returns terrain elevation (metres MSL) for a list of lat/lng points.

    Uses the Open-Elevation API backed by SRTM data (~30m resolution).
    Results are cached in-memory to avoid redundant requests.

    For production, replace with a self-hosted SRTM tile server
    (e.g. via PostGIS raster, gdal, or the 'elevation' Python package).

    Terrain Data Flow (MAVLink protocol):
    ┌─────────────────────────────────────────────────────────────────┐
    │  Drone ──TERRAIN_REQUEST──▶ GCS (Verocore backend)             │
    │  GCS queries SRTM tiles / this endpoint                        │
    │  GCS ──TERRAIN_DATA──▶ Drone  (4×4 grid of elevations)        │
    │  Drone interpolates to maintain constant AGL above surface     │
    └─────────────────────────────────────────────────────────────────┘

    Database options for self-hosted terrain:
    - SRTM HGT files: ~23 GB global, 30m resolution, binary tile format
    - Copernicus DEM: 30m/90m, newer, freely available
    - PostgreSQL + PostGIS raster: spatial queries, efficient tile serving
    - Redis cache: sub-millisecond lookups for hot tiles
    """
    import httpx

    try:
        lat_list = [float(v) for v in lats.split(",")]
        lng_list = [float(v) for v in lngs.split(",")]
    except ValueError:
        return JSONResponse({"error": "Invalid lat/lng values"}, status_code=400)

    if len(lat_list) != len(lng_list):
        return JSONResponse({"error": "lat and lng lists must have equal length"}, status_code=400)

    results: list[dict] = []
    uncached_indices: list[int] = []
    uncached_points: list[dict] = []

    for i, (lat, lng) in enumerate(zip(lat_list, lng_list)):
        key = f"{lat:.5f}_{lng:.5f}"
        if key in _terrain_cache:
            results.append({"lat": lat, "lng": lng, "elevation": _terrain_cache[key]})
        else:
            results.append({"lat": lat, "lng": lng, "elevation": None})
            uncached_indices.append(i)
            uncached_points.append({"latitude": lat, "longitude": lng})

    # Batch-fetch uncached points from Open-Elevation API
    if uncached_points:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    "https://api.open-elevation.com/api/v1/lookup",
                    json={"locations": uncached_points},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    for j, item in enumerate(data.get("results", [])):
                        elev = item.get("elevation", 0) or 0
                        idx = uncached_indices[j]
                        lat, lng = lat_list[idx], lng_list[idx]
                        key = f"{lat:.5f}_{lng:.5f}"
                        _terrain_cache[key] = elev
                        results[idx]["elevation"] = elev
        except Exception as e:
            logger.warning(f"Terrain elevation fetch failed: {e}")
            # Return 0 for failed lookups — drone should fallback to home altitude
            for idx in uncached_indices:
                if results[idx]["elevation"] is None:
                    results[idx]["elevation"] = 0

    return {"points": results, "source": "SRTM via open-elevation"}