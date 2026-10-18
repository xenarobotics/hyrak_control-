"""
/api/map-sightings: detections on the map (app/mapdetect).

    GET    /api/map-sightings?session_id=|flight_id=
           {sightings: [...], live: bool, ...live state when live}
    GET    /api/map-sightings/export?format=geojson|csv&session_id=|flight_id=
           a file (Content-Disposition names it)
    DELETE /api/map-sightings?session_id=   empty that session's LIVE map
    DELETE /api/map-sightings?flight_id=    delete a flight's recorded sightings

Scoping is the phase 2b history rule (docs/ACCESS_MODEL.md 8b,
app/auth/data_scope.py): reading needs `view` on the workspace the session
or flight belongs to (founders: all), clearing or deleting needs `fly`
there, so viewers see but cannot clear (403 for someone who can see it).
Anything outside the caller's view answers 404, so ids cannot be probed.
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response

from app.auth import perms
from app.auth.deps import require_signed_in
from app.auth.service import AuthUser
from app.mapdetect import export, live, store

router = APIRouter(prefix="/api/map-sightings", tags=["map-sightings"])

NOT_FOUND = "No detections found for that session or flight"


def _one_target(session_id: Optional[str], flight_id: Optional[str]) -> None:
    if bool(session_id) == bool(flight_id):
        raise HTTPException(status_code=400, detail="Name one session_id or one flight_id")


async def _session_workspace(request: Request, session_id: str) -> Optional[str]:
    sm = getattr(request.app.state, "session_manager", None)
    s = sm.get(session_id) if sm is not None else None
    if s is not None and not getattr(s, "is_admin", False):
        return getattr(s, "workspace_id", None) or None
    return await store.workspace_of_session(session_id)


def _refuse(scope, ws, perm) -> None:
    # Someone who can SEE the detections learns nothing new from a 403, and
    # deserves the real reason; everyone else gets the probe-proof 404.
    if perm != perms.VIEW and scope.can(ws, perms.VIEW):
        raise HTTPException(status_code=403,
                            detail="Clearing detections needs fly access on this workspace")
    raise HTTPException(status_code=404, detail=NOT_FOUND)


async def _scope(user: AuthUser):
    from app.auth import data_scope
    return await data_scope.scope_for(user)


async def resolve(request: Request, user: AuthUser, session_id: Optional[str],
                  flight_id: Optional[str], perm: str = perms.VIEW) -> dict:
    """{workspace_id, flight} for the target if the caller holds `perm` on
    it, else 404. A live session with no recorded rows yet resolves from the
    session manager."""
    _one_target(session_id, flight_id)
    scope = await _scope(user)
    if flight_id:
        from app.api.routes import _flight_in_scope
        flight = await _flight_in_scope(flight_id, user)   # 404 / 503 itself
        if not scope.can(flight.workspace_id, perm):
            _refuse(scope, flight.workspace_id, perm)
        return {"workspace_id": flight.workspace_id, "flight": flight}
    ws = await _session_workspace(request, session_id)
    if ws is None and live.get(session_id) is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    if not scope.can(ws, perm):
        _refuse(scope, ws, perm)
    return {"workspace_id": ws, "flight": None}


async def _sightings(session_id: Optional[str], flight_id: Optional[str], ws) -> tuple[list, dict]:
    if session_id and live.get(session_id) is not None:
        state = live.snapshot(session_id)
        return state["upserts"], state
    rows = await store.list_rows(session_id=session_id, flight_id=flight_id,
                                 workspace_ids=None if ws is None else [ws])
    return rows, {}


@router.get("")
async def list_sightings(request: Request, session_id: Optional[str] = Query(None),
                         flight_id: Optional[str] = Query(None),
                         user: AuthUser = Depends(require_signed_in)):
    t = await resolve(request, user, session_id, flight_id)
    rows, state = await _sightings(session_id, flight_id, t["workspace_id"])
    scope = await _scope(user)
    out = {"sightings": rows, "live": bool(state),
           "can_clear": scope.can(t["workspace_id"], perms.FLY)}
    if state:
        out.update({k: v for k, v in state.items() if k not in ("upserts", "cleared")})
    return out


@router.get("/export")
async def export_sightings(request: Request, format: str = Query("geojson"),
                           session_id: Optional[str] = Query(None),
                           flight_id: Optional[str] = Query(None),
                           user: AuthUser = Depends(require_signed_in)):
    if format not in ("geojson", "csv"):
        raise HTTPException(status_code=400, detail="format is geojson or csv")
    t = await resolve(request, user, session_id, flight_id)
    rows, _ = await _sightings(session_id, flight_id, t["workspace_id"])
    flight = t["flight"]
    stamp = (flight.started_at.strftime("%Y%m%d_%H%M") if flight is not None and flight.started_at
             else datetime.now().strftime("%Y%m%d_%H%M"))
    name = f"detections_{stamp}"
    if format == "csv":
        return Response(export.to_csv(rows), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="{name}.csv"'})
    body = export.to_geojson(rows, session_id=session_id, flight_id=flight_id)
    return Response(json.dumps(body), media_type="application/geo+json",
                    headers={"Content-Disposition": f'attachment; filename="{name}.geojson"'})


@router.delete("")
async def clear_sightings(request: Request, session_id: Optional[str] = Query(None),
                          flight_id: Optional[str] = Query(None),
                          user: AuthUser = Depends(require_signed_in)):
    t = await resolve(request, user, session_id, flight_id, perms.FLY)
    if session_id:
        await live.clear(session_id)
        return {"cleared": True, "session_id": session_id}
    try:
        n = await store.delete_rows(flight_id=flight_id, workspace_ids=[t["workspace_id"]])
    except Exception:
        raise HTTPException(status_code=503,
                            detail="The recorded detections could not be deleted right now")
    return {"cleared": True, "flight_id": flight_id, "deleted": n}
