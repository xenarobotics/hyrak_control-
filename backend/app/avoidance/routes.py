"""/api/avoidance/* - control + telemetry for the obstacle-avoidance layer.

Mutating routes are token-guarded like the rest of the platform. `observe` is
how any sensor (and the SITL test harness) pushes a body-frame reading;
`decide` runs one decision tick against an explicit pose/goal - used by the
SITL harness and the frontend until the live telemetry loop is wired.
"""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException

from app.config import get_settings
from app.avoidance.core import controller as avoidance
from app.avoidance.sensing import registry as sensor_registry
from app.avoidance.planning.geometry import Pose
from app.avoidance.sensing.observations import ObstacleObservation

settings = get_settings()
router = APIRouter(prefix="/api/avoidance", tags=["avoidance"])


def _auth(token: str | None) -> None:
    if token != settings.secret_token:
        raise HTTPException(status_code=403, detail="Invalid token")


@router.get("/status")
async def all_status():
    return {"drones": avoidance.all_status()}


@router.get("/{drone_id}/status")
async def drone_status(drone_id: str):
    return avoidance.controller(drone_id).status()


@router.post("/{drone_id}/enable")
async def set_enabled(drone_id: str, body: dict,
                      x_auth_token: str = Header(None, alias="X-Auth-Token")):
    _auth(x_auth_token)
    c = avoidance.controller(drone_id)
    params = body.get("params") or {}
    for k, v in params.items():
        if hasattr(c.params, k):
            try:
                setattr(c.params, k, float(v))
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail=f"Bad param {k}")
    if "enabled" in body:
        c.set_enabled(bool(body["enabled"]))
        if c.enabled:
            from app.avoidance.sensing import camera as sensing
            sensing.warm()
    avoidance.persist_state()
    return c.status()


@router.post("/{drone_id}/arm")
async def set_armed(drone_id: str, body: dict,
                    x_auth_token: str = Header(None, alias="X-Auth-Token")):
    """Allow (or forbid) avoidance to COMMAND this drone. Arming requires
    detection already enabled - the deliberate second step of the trust
    ladder, separate from turning detection on."""
    _auth(x_auth_token)
    c = avoidance.controller(drone_id)
    c.set_armed(bool(body.get("armed")))
    avoidance.persist_state()
    return c.status()


@router.get("/{drone_id}/events")
async def drone_events(drone_id: str, limit: int = 100):
    from app.avoidance import events
    return {"events": await events.list_for(drone_id, limit=min(limit, 500))}


@router.post("/{drone_id}/observe")
async def observe(drone_id: str, body: dict,
                  x_auth_token: str = Header(None, alias="X-Auth-Token")):
    """Push one body-frame obstacle reading. Any sensor source uses this; the
    SITL harness uses it to inject a virtual obstacle."""
    _auth(x_auth_token)
    try:
        obs = ObstacleObservation(
            bearing_deg=float(body["bearing_deg"]),
            distance_m=float(body["distance_m"]),
            half_width_deg=float(body.get("half_width_deg", 5.0)),
            confidence=float(body.get("confidence", 0.5)),
            source=str(body.get("source", "injected")),
        )
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=400,
                            detail="need numeric bearing_deg + distance_m")
    avoidance.controller(drone_id).observe(obs)
    return {"ok": True}


def _resolve_drone(drone_id: str):
    """'auto' = the sole drone with avoidance enabled (the sim bridge does not
    know the fleet's drone id)."""
    if drone_id != "auto":
        return avoidance.controller(drone_id)
    on = [c for c in avoidance._controllers.values() if c.enabled]
    if len(on) != 1:
        raise HTTPException(status_code=409,
                            detail=f"'auto' needs exactly one drone with avoidance on ({len(on)} are)")
    return on[0]


@router.post("/{drone_id}/depth_scan")
async def depth_scan(drone_id: str, body: dict,
                     x_auth_token: str = Header(None, alias="X-Auth-Token")):
    """A pooled depth image from a range sensor (the sim's depth camera via
    simulation/gz_depth_sensor.py, or a real stereo/ToF camera).
    body: {captured_wall: unix time of capture, hfov_deg, vfov_deg, rows, cols,
           depth: [rows*cols floats, row-major, metres along the optical axis;
                   <= 0 = no data, >= max_range_m = nothing within range],
           max_range_m, cam_pitch_deg?, source?: "depth"}
    The scan is placed with the aircraft's pose AT captured_wall."""
    _auth(x_auth_token)
    import time as _time
    import numpy as np
    from app.avoidance.mapping import pose_history
    from app.avoidance.sensing.depth_scan import scan_from_depth
    c = _resolve_drone(drone_id)
    if not c.enabled:
        return {"ok": False, "reason": "avoidance off"}
    try:
        rows, cols = int(body["rows"]), int(body["cols"])
        z = np.asarray(body["depth"], dtype=np.float32).reshape(rows, cols)
        max_r = float(body.get("max_range_m", 20.0))
        hfov, vfov = float(body["hfov_deg"]), float(body["vfov_deg"])
        wall = float(body.get("captured_wall") or _time.time())
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"bad depth_scan body: {e}")
    captured_at = _time.monotonic() - max(0.0, _time.time() - wall)
    pose = pose_history.history(c.drone_id).at(captured_at)
    if pose is None:
        return {"ok": False, "reason": "no pose history yet (is the aircraft linked?)"}
    z = np.where(z <= 0, np.nan, np.where(z >= max_r, np.inf, z))
    scan = scan_from_depth(z, hfov, vfov, alt_m=pose.alt_m, roll_deg=pose.roll_deg,
                           pitch_deg=pose.pitch_deg,
                           cam_pitch_deg=float(body.get("cam_pitch_deg", 0.0)),
                           max_range_m=max_r)
    used = c.integrate_scan(scan, captured_at, str(body.get("source", "depth")))
    return {"ok": used, "hits": sum(1 for b in scan if b.hit_m is not None),
            "age_ms": round((_time.monotonic() - captured_at) * 1000.0, 1)}


@router.post("/{drone_id}/decide")
async def decide(drone_id: str, body: dict,
                 x_auth_token: str = Header(None, alias="X-Auth-Token")):
    """Run one decision tick against an explicit pose (and optional goal).
    body: {pose:{lat,lng,heading_deg,alt_m}, goal?:{lat,lng},
           cruise_alt_m?, speed_m_s?}"""
    _auth(x_auth_token)
    p = body.get("pose") or {}
    try:
        pose = Pose(lat=float(p["lat"]), lng=float(p["lng"]),
                    heading_deg=float(p.get("heading_deg", 0.0)),
                    alt_m=float(p.get("alt_m", 0.0)))
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="pose needs lat + lng")
    goal = None
    g = body.get("goal")
    if g:
        try:
            goal = (float(g["lat"]), float(g["lng"]))
        except (KeyError, TypeError, ValueError):
            raise HTTPException(status_code=400, detail="goal needs lat + lng")
    d = await avoidance.controller(drone_id).decide(
        pose, goal,
        cruise_alt_m=float(body.get("cruise_alt_m", 10.0)),
        speed_m_s=float(body.get("speed_m_s", 4.0)))
    return {
        "action": d.action, "state": d.state.value, "reason": d.reason,
        "obstacle": d.obstacle, "waypoints": d.waypoints,
        "fused_distance_m": d.fused_distance_m,
    }


@router.get("/{drone_id}/obstacles")
async def drone_obstacles(drone_id: str):
    """The drone's live obstacle map + the active reroute path - for the
    Mission-tab overlay, so the operator watches the plan update in real time."""
    c = avoidance.controller(drone_id)
    path = None
    if c._committed_path:
        path = [{"lat": float(w["lat"]), "lng": float(w["lng"])}
                for w in c._committed_path]
    goal = None
    if c._last_goal:
        goal = {"lat": c._last_goal[0], "lng": c._last_goal[1]}
    return {"obstacles": c.obstacles(), "reroute_path": path, "goal": goal}


@router.get("/hazards")
async def known_hazards():
    """The persistent shared hazard map (all known static obstacles)."""
    from app.avoidance.mapping import hazards as hazard_db
    return {"hazards": await hazard_db.all_hazards()}


@router.post("/hazards")
async def add_hazard(body: dict,
                     x_auth_token: str = Header(None, alias="X-Auth-Token")):
    """Operator-marked hazard - manually pin a known obstacle on the map."""
    _auth(x_auth_token)
    from app.avoidance.mapping import hazards as hazard_db
    try:
        lat, lng = float(body["lat"]), float(body["lng"])
        radius_m = max(1.0, float(body.get("radius_m", 5.0)))
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="need lat, lng")
    await hazard_db.save(lat, lng, radius_m,
                         top_m=float(body.get("top_m", 0.0)),
                         confidence=1.0, source="operator")
    return {"ok": True}


@router.post("/hazards/clear")
async def clear_hazards(x_auth_token: str = Header(None, alias="X-Auth-Token")):
    _auth(x_auth_token)
    from app.avoidance.mapping import hazards as hazard_db
    return {"removed": await hazard_db.clear()}


@router.get("/{drone_id}/sensors")
async def get_sensors(drone_id: str):
    return {"sensors": sensor_registry.inventory(drone_id)}


@router.post("/{drone_id}/sensors")
async def set_sensors(drone_id: str, body: dict,
                      x_auth_token: str = Header(None, alias="X-Auth-Token")):
    _auth(x_auth_token)
    specs = body.get("sensors")
    if not isinstance(specs, list):
        raise HTTPException(status_code=400, detail="sensors must be a list")
    return {"sensors": sensor_registry.set_inventory(drone_id, specs)}


# -- person-ruler depth calibration (sensing/person_ruler.py) ---------------
@router.post("/{drone_id}/calibrate_person")
async def calibrate_person(drone_id: str, body: dict,
                           x_auth_token: str = Header(None, alias="X-Auth-Token")):
    """Start (or {cancel: true}) a person-ruler run for the camera feeding
    this drone's avoidance. Body: {height_m?: 1.70}. Needs avoidance
    Detection on and the video streaming."""
    _auth(x_auth_token)
    from app.avoidance.sensing import person_ruler
    c = _resolve_drone(drone_id)
    if body.get("cancel"):
        person_ruler.cancel(c.drone_id)
        return person_ruler.status(c.drone_id)
    if not c.enabled:
        raise HTTPException(status_code=409, detail="turn avoidance Detection on first - the camera path feeds the calibration")
    try:
        return person_ruler.start(c.drone_id, float(body.get("height_m") or 1.70))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{drone_id}/calibrate_person")
async def calibrate_person_status(drone_id: str):
    from app.avoidance.sensing import person_ruler
    c = _resolve_drone(drone_id)
    person_ruler.pending(c.drone_id)          # applies the timeout
    return {**person_ruler.status(c.drone_id), "profiles": person_ruler._load()}
