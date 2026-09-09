"""
The public /v1 API - what a client application (a delivery storefront, a
partner's ordering site) integrates against. Authenticated per-request by
X-API-Key; a key sees only its own orders.

Deliberately narrow: pads by name, create an order, read an order. No
waypoints, no zones, no drones - the client's vocabulary is delivery, not
flight. Everything flight-shaped stays behind the operator surfaces.
"""
import logging
from datetime import datetime

from fastapi import APIRouter, Header, HTTPException, Query

logger = logging.getLogger("verocore.api.public")
router = APIRouter(prefix="/v1")


async def _require_key(x_api_key: str | None) -> dict:
    from app.tasks import auth as key_auth
    key = await key_auth.verify(x_api_key)
    if key is None:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")
    return key


@router.get("/pads")
async def v1_pads(x_api_key: str = Header(None, alias="X-API-Key")):
    """Active pads a client may order between - names and positions only."""
    await _require_key(x_api_key)
    from sqlalchemy import select
    from app.db import db_available, get_session
    from app.db.models import Pad
    if not db_available():
        return {"pads": []}
    async with get_session() as db:
        rows = (
            await db.execute(
                # Stations are drone infrastructure, not delivery addresses -
                # clients never see them.
                select(Pad).where(Pad.active == True, Pad.kind == "pad")  # noqa: E712
                .order_by(Pad.name)
            )
        ).scalars().all()
    return {"pads": [{"id": p.id, "name": p.name, "lat": p.lat, "lng": p.lng}
                     for p in rows]}


@router.post("/tasks")
async def v1_create_task(
    body: dict,
    x_api_key: str = Header(None, alias="X-API-Key"),
):
    """
    Create a delivery order.

    body: {
      pickup: "<pad id or name>", dropoff: "<pad id or name>",
      payload?: {description?, kg?},
      window?: {start?: ISO8601, end?: ISO8601},
      profile?: "<route profile name>"     # optional, HYRAK picks otherwise
    }

    Returns the order with its order_no. The order is accepted even when
    route planning needs operator attention - poll GET /v1/tasks/{order_no}
    for the status timeline.
    """
    key = await _require_key(x_api_key)
    from app.tasks import service as task_service

    pickup = str(body.get("pickup") or "").strip()
    dropoff = str(body.get("dropoff") or "").strip()
    if not pickup or not dropoff:
        raise HTTPException(status_code=400, detail="pickup and dropoff pads are required")

    payload = body.get("payload") or {}
    window = body.get("window") or {}

    def _dt(v):
        if not v:
            return None
        try:
            return datetime.fromisoformat(str(v))
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Bad timestamp: {v}")

    task, err = await task_service.create_task(
        pickup_ref=pickup, dropoff_ref=dropoff,
        payload_desc=str(payload.get("description") or ""),
        payload_kg=float(payload.get("kg") or 0.0),
        window_start=_dt(window.get("start")),
        window_end=_dt(window.get("end")),
        profile=str(body.get("profile") or "") or None,
        api_key=key, actor="client",
    )
    if task is None:
        raise HTTPException(status_code=400, detail=err)
    return {"task": _client_view(task)}


@router.get("/tasks")
async def v1_list_tasks(
    status: str = Query(None),
    x_api_key: str = Header(None, alias="X-API-Key"),
):
    key = await _require_key(x_api_key)
    from app.tasks import service as task_service
    tasks = await task_service.list_tasks(status=status, api_key_id=key["id"], include_archived=True)
    return {"tasks": [_client_view(t) for t in tasks]}


@router.get("/tasks/{ref}")
async def v1_get_task(
    ref: str,
    x_api_key: str = Header(None, alias="X-API-Key"),
):
    """Order by id or order number, with its status timeline."""
    key = await _require_key(x_api_key)
    from app.tasks import service as task_service
    task = await task_service.get_task(ref, api_key_id=key["id"])
    if task is None:
        raise HTTPException(status_code=404, detail="Order not found")
    return {"task": _client_view(task)}


def _client_view(task: dict) -> dict:
    """The tenant-safe projection of a task: no internal mission detail, no
    drone identity, no operator notes beyond the event log."""
    out = {
        "order_no": task["order_no"],
        "status": task["status"],
        "pickup": {"name": task["pickup"]["name"],
                   "lat": task["pickup"]["lat"], "lng": task["pickup"]["lng"]},
        "dropoff": {"name": task["dropoff"]["name"],
                    "lat": task["dropoff"]["lat"], "lng": task["dropoff"]["lng"]},
        "payload": task["payload"],
        "window_start": task["window_start"],
        "window_end": task["window_end"],
        "created_at": task["created_at"],
        "updated_at": task["updated_at"],
    }
    if task.get("mission"):
        out["route"] = {
            "distance_m": task["mission"]["distance_m"],
            "est_duration_s": task["mission"]["est_duration_s"],
        }
    if task.get("events"):
        out["events"] = task["events"]
    return out
