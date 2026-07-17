import asyncio
import base64
import logging
import math
from typing import List
from fastapi import APIRouter, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse
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
            snap = tel.snapshot
            live = {
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
    return {"active_sessions": len(sessions), "sessions": sessions}


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