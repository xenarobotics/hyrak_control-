"""
/api/permits: request, list, decide and withdraw flight permits
(docs/ACCESS_MODEL.md 8d; the rules are app/permits/service.py).

  * Request: `plan` on the workspace (HYRAK: the compatibility operator
    rank, as before). Customers pilots, admins and owners, managers.
  * List a workspace's permits (`?workspace_id=`): read access to its plans
    (scope.can_read). Without a workspace: the caller's decision queue,
    every permit they may decide (founders: all).
  * Decide (approve, deny, revoke): permits.approve covering the restricted
    airspace the flight uses, never on your own request (founders excepted).
  * Withdraw: `plan` on the permit's workspace, or the requester.
  * Superseded (not a route): a zone edit that changes what the permit
    approved (app/workspaces/service.patch_zone).

Every request, decision and withdrawal writes an audit_events row.
"""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.auth import audit
from app.auth import perms
from app.auth import service as auth
from app.auth.clientip import client_ip
from app.auth.deps import require_signed_in
from app.auth.routes import _http
from app.auth.service import AuthUser
from app.permits import service
from app.planner import scope as plan_scope
from app.workspaces.service import Refused

logger = logging.getLogger("verocore.permits.routes")

router = APIRouter(prefix="/api", tags=["permits"])

NOT_FOUND = "Permit not found"


async def _run(coro):
    try:
        return await coro
    except HTTPException:
        raise
    except Exception as e:
        raise _http(e)


def _require_db() -> None:
    from app.db import db_available
    if not db_available():
        raise Refused(503, "Database offline")


async def _drone_names(ids) -> dict:
    out = {}
    store = auth.read_store()
    for i in {i for i in ids if i}:
        try:
            d = await store.get_drone(i)
        except Exception:
            d = None
        if d:
            out[i] = d.get("name") or i[:8]
    return out


def _decorate(sc: plan_scope.Scope, p: dict, names: dict) -> dict:
    ws = sc.tree.get(p["workspace_id"])
    d = dict(p)
    d["status_effective"] = service.effective_status(p)
    d["in_window"] = service.in_window(p)
    d["workspace_name"] = ws.name if ws is not None else ""
    d["drone_name"] = names.get(p.get("drone_id")) if p.get("drone_id") else None
    d["can_decide"] = bool(p["status"] in (service.PENDING, service.APPROVED) and service.can_decide(
        sc.ms, ws, p, actor_id=sc.user.id))
    return d


def _may_see(sc: plan_scope.Scope, p: dict) -> bool:
    if sc.can_read(p["workspace_id"]) and sc.visible(p["workspace_id"]):
        return True
    return bool(service.can_decide(sc.ms, sc.tree.get(p["workspace_id"]), p))


async def _load(sc: plan_scope.Scope, permit_id: str) -> dict:
    _require_db()
    p = await service.get(permit_id)
    if p is None or not _may_see(sc, p):
        raise Refused(404, NOT_FOUND)
    return p


# ── List ──────────────────────────────────────────────────────────────────

async def _list(user: AuthUser, workspace_id: Optional[str], status: Optional[str]) -> list[dict]:
    sc = await plan_scope.scope_for(user)
    if status and status not in service.STATUSES:
        raise Refused(400, f"status must be one of: {', '.join(service.STATUSES)}")
    if workspace_id:
        ws_id = sc.resolve(workspace_id, write=False)
        rows = await service.list_permits(status=status, workspace_id=ws_id, include_waypoints=True)
    else:
        rows = await service.list_permits(status=status, include_waypoints=True, limit=500)
        if not user.is_founder:
            rows = [p for p in rows if service.can_decide(sc.ms, sc.tree.get(p["workspace_id"]), p)]
    names = await _drone_names(p.get("drone_id") for p in rows)
    return [_decorate(sc, p, names) for p in rows]


@router.get("/permits")
async def list_permits(workspace_id: str = Query(None), status: str = Query(None),
                       user: AuthUser = Depends(require_signed_in)):
    """`?workspace_id=` that workspace's permits (read access); without it,
    the permits the caller may decide."""
    return {"permits": await _run(_list(user, workspace_id, status))}


@router.get("/permits/{permit_id}")
async def get_permit(permit_id: str, user: AuthUser = Depends(require_signed_in)):
    async def go():
        sc = await plan_scope.scope_for(user)
        p = await _load(sc, permit_id)
        return _decorate(sc, p, await _drone_names([p.get("drone_id")]))
    return {"permit": await _run(go())}


# ── Request ───────────────────────────────────────────────────────────────

def _when(v, field: str):
    if v in (None, ""):
        return None
    t = service._ts(v)
    if t is None:
        raise Refused(400, f"{field} must be an ISO 8601 time")
    return t


async def _request(user: AuthUser, body: dict, ip: str) -> dict:
    from app.planner import service as mission_service
    from app.zones import engine as zone_engine
    _require_db()
    if not isinstance(body, dict):
        raise Refused(400, "body must be an object")
    sc = await plan_scope.scope_for(user)
    store = auth.read_store()

    drone = None
    drone_id = body.get("drone_id") or None
    if drone_id is not None:
        drone = await store.get_drone(str(drone_id))
        if drone is None:
            raise Refused(404, "Drone not found")
    requested_ws = body.get("workspace_id") or (drone or {}).get("workspace_id")
    ws_id = sc.resolve(requested_ws, write=True)
    if drone is not None and (drone.get("workspace_id") or plan_scope.HYRAK) != ws_id:
        raise Refused(409, "That drone is not in this workspace; ask its owner to move it here first")

    description = str(body.get("description") or "").strip()
    if len(description) < 3:
        raise Refused(400, "Describe the purpose of the flight for the reviewer")

    now = service.now_utc()
    valid_from = _when(body.get("valid_from"), "valid_from") or now
    valid_from = max(valid_from, now)
    valid_until = _when(body.get("valid_until"), "valid_until")
    if valid_until is None:
        raise Refused(400, "valid_until is required: when may the flight end at the latest?")
    if valid_until <= valid_from:
        raise Refused(400, "valid_until must be after valid_from")
    if valid_until - valid_from > timedelta(days=service.MAX_WINDOW_DAYS):
        raise Refused(400, f"A permit window is at most {service.MAX_WINDOW_DAYS} days")

    mission_id = body.get("mission_id") or None
    area = body.get("area")
    waypoints = None
    if mission_id:
        m = await mission_service.get(str(mission_id))
        if m is None or m.get("workspace_id") != ws_id:
            raise Refused(404, "Mission not found in this workspace")
        waypoints = m.get("waypoints") or []
    if body.get("waypoints"):
        # The exact list that will be uploaded (the Mission tab expands
        # turn radii before upload), so the frozen permit matches it.
        try:
            waypoints = mission_service.clean_waypoints(body.get("waypoints"))
        except ValueError as e:
            raise Refused(400, str(e))
    if area is not None:
        if waypoints:
            raise Refused(400, "Ask for either a mission (waypoints / mission_id) or an area, not both")
        reason = perms.validate_area(area, field="area")
        if reason:
            raise Refused(400, reason)
        check = zone_engine.check_area(area)
    elif waypoints:
        check = zone_engine.check_path([(w["lat"], w["lng"]) for w in waypoints])
    else:
        raise Refused(400, "Name the flight: waypoints, a saved mission_id, or an area")

    red, orange, prohibited = service.split_zones(check["zones"])
    if prohibited:
        raise Refused(409, "Crosses a prohibited zone, where no permit can be issued: "
                           + ", ".join(z["name"] for z in prohibited))
    if not red and not orange:
        raise Refused(400, "This flight crosses no restricted zone - no permit needed")

    p = await service.create(
        workspace_id=ws_id, description=description, waypoints=waypoints or [],
        zones=red + orange, drone_id=drone["id"] if drone else None, mission_id=mission_id,
        area=area, valid_from=valid_from, valid_until=valid_until,
        requested_by=user.id, requested_by_name=user.username)
    if p is None:
        raise Refused(503, "Database offline")
    await audit.record(auth.write_store(), user, "permit.request", workspace_id=ws_id,
                       target_type="permit", target_id=p["id"],
                       detail={"kind": "area" if area else "mission",
                               "drone_id": p["drone_id"], "mission_id": p["mission_id"],
                               "zones": [z["name"] for z in red + orange],
                               "valid_from": p["valid_from"], "valid_until": p["valid_until"]},
                       ip=ip)
    return _decorate(sc, p, await _drone_names([p.get("drone_id")]))


@router.post("/permits")
async def request_permit(body: dict, request: Request, user: AuthUser = Depends(require_signed_in)):
    """body: {workspace_id?, description, valid_from?, valid_until, drone_id?,
    and one of: waypoints, mission_id (+ optional waypoints), area}.
    workspace_id defaults to the drone's workspace, else the caller's."""
    return {"permit": await _run(_request(user, body, client_ip(request)))}


# ── Decide / withdraw ─────────────────────────────────────────────────────

async def _decide(user: AuthUser, permit_id: str, body: dict, ip: str) -> dict:
    if not isinstance(body, dict) or not isinstance(body.get("approve"), bool):
        raise Refused(400, "approve must be true or false")
    sc = await plan_scope.scope_for(user)
    p = await _load(sc, permit_id)
    ws = sc.tree.get(p["workspace_id"])
    decision = service.can_decide(sc.ms, ws, p, actor_id=user.id)
    if not decision.ok:
        raise Refused(decision.status, decision.reason)
    if p["status"] == service.PENDING:
        new = service.APPROVED if body["approve"] else service.DENIED
    elif p["status"] == service.APPROVED and not body["approve"]:
        new = service.REVOKED
    else:
        raise Refused(409, f"This permit is {p['status']}; there is nothing to decide")
    note = str(body.get("note") or "")
    zones = None
    if new == service.APPROVED:
        # Approve the zones as they are NOW: their current class is what the
        # permit records, and the evaluation never exempts a zone that later
        # becomes stricter than that (service.honoured_zone_ids).
        zones, prohibited = service.record_live_zones(p["zones"] or [])
        if prohibited:
            raise Refused(409, "Since the request, a zone it crosses became prohibited (no permits): "
                               + ", ".join(z.get("name", "") for z in prohibited))
    out, err = await service.set_status(permit_id, new, actor_id=user.id,
                                        actor_name=user.username, note=note, expect=p["status"],
                                        zones=zones)
    if out is None:
        raise Refused(409, err)
    action = {service.APPROVED: "permit.approve", service.DENIED: "permit.deny",
              service.REVOKED: "permit.revoke"}[new]
    await audit.record(auth.write_store(), user, action, workspace_id=out["workspace_id"],
                       target_type="permit", target_id=permit_id,
                       detail={"note": out["decision_note"],
                               "zones": [z.get("name") for z in out["zones"] or []],
                               "valid_from": out["valid_from"], "valid_until": out["valid_until"]},
                       ip=ip)
    return _decorate(sc, out, await _drone_names([out.get("drone_id")]))


@router.post("/permits/{permit_id}/decision")
async def decide_permit(permit_id: str, body: dict, request: Request,
                        user: AuthUser = Depends(require_signed_in)):
    """body: {approve: bool, note?}. Pending: approve or deny. Approved:
    approve=false revokes it."""
    return {"permit": await _run(_decide(user, permit_id, body, client_ip(request)))}


async def _withdraw(user: AuthUser, permit_id: str, ip: str) -> dict:
    sc = await plan_scope.scope_for(user)
    p = await _load(sc, permit_id)
    if not (sc.can_write(p["workspace_id"]) or p.get("requested_by") == user.id):
        raise Refused(403, "You cannot withdraw this workspace's permits")
    out, err = await service.set_status(permit_id, service.WITHDRAWN, expect=p["status"])
    if out is None:
        raise Refused(409, err)
    await audit.record(auth.write_store(), user, "permit.withdraw", workspace_id=out["workspace_id"],
                       target_type="permit", target_id=permit_id,
                       detail={"was": p["status"]}, ip=ip)
    return _decorate(sc, out, await _drone_names([out.get("drone_id")]))


@router.post("/permits/{permit_id}/withdraw")
async def withdraw_permit(permit_id: str, request: Request,
                          user: AuthUser = Depends(require_signed_in)):
    return {"permit": await _run(_withdraw(user, permit_id, client_ip(request)))}
