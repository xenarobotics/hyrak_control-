"""/api/avoidance/* - control + telemetry for the obstacle-avoidance layer.

Mutating routes are token-guarded like the rest of the platform. `observe` is
how any sensor (and the SITL test harness) pushes a body-frame reading;
`decide` runs one decision tick against an explicit pose/goal - used by the
SITL harness and the frontend until the live telemetry loop is wired.
"""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException

from app.config import get_settings
from app.avoidance import service as avoidance
from app.avoidance import sensors as sensor_registry
from app.avoidance.geometry import Pose
from app.avoidance.observations import ObstacleObservation

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
    """The drone's live obstacle map - for the Mission-tab overlay."""
    return {"obstacles": avoidance.controller(drone_id).obstacles()}


@router.get("/hazards")
async def known_hazards():
    """The persistent shared hazard map (all known static obstacles)."""
    from app.avoidance import hazard_db
    return {"hazards": await hazard_db.all_hazards()}


@router.post("/hazards")
async def add_hazard(body: dict,
                     x_auth_token: str = Header(None, alias="X-Auth-Token")):
    """Operator-marked hazard - manually pin a known obstacle on the map."""
    _auth(x_auth_token)
    from app.avoidance import hazard_db
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
    from app.avoidance import hazard_db
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
