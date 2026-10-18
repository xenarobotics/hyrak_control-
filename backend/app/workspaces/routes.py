"""
/api/workspaces, /api/drones/{id}/workspace, /api/staff, /api/audit.

Thin: parse, call app/workspaces/service.py, map its `Refused` (and the
store / auth exceptions) to HTTP. Every route needs a signed-in user; what
that user may do is decided in the service by the permission engine.
Contract: docs/ACCESS_MODEL.md section 7.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.auth.clientip import client_ip
from app.auth.deps import require_viewer
from app.auth.routes import _http
from app.auth.service import AuthUser
from app.workspaces import service

router = APIRouter(prefix="/api", tags=["workspaces"])


async def _run(coro):
    try:
        return await coro
    except HTTPException:
        raise
    except Exception as e:
        raise _http(e)


# ── Workspaces ────────────────────────────────────────────────────────────


@router.get("/workspaces")
async def list_workspaces(user: AuthUser = Depends(require_viewer)):
    return {"workspaces": await _run(service.list_visible(user))}


class CreateWorkspaceBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: str
    parent_id: Optional[str] = None
    operating_area: Optional[dict] = None


@router.post("/workspaces")
async def create_workspace(body: CreateWorkspaceBody, request: Request,
                           user: AuthUser = Depends(require_viewer)):
    ws = await _run(service.create_workspace(
        user, name=body.name, kind=body.kind, parent_id=body.parent_id,
        operating_area=body.operating_area, ip=client_ip(request)))
    return {"workspace": ws}


@router.get("/workspaces/{workspace_id}")
async def get_workspace(workspace_id: str, user: AuthUser = Depends(require_viewer)):
    return {"workspace": await _run(service.get_workspace(user, workspace_id))}


class PatchWorkspaceBody(BaseModel):
    name: Optional[str] = Field(default=None, max_length=120)
    operating_area: Optional[dict] = None      # explicit null clears it
    disabled: Optional[bool] = None


@router.patch("/workspaces/{workspace_id}")
async def patch_workspace(workspace_id: str, body: PatchWorkspaceBody, request: Request,
                          user: AuthUser = Depends(require_viewer)):
    kw = {}
    if "operating_area" in body.model_fields_set:
        kw["operating_area"] = body.operating_area
    ws = await _run(service.patch_workspace(user, workspace_id, name=body.name,
                                            disabled=body.disabled, ip=client_ip(request), **kw))
    return {"workspace": ws}


@router.delete("/workspaces/{workspace_id}")
async def delete_workspace(workspace_id: str, request: Request,
                           user: AuthUser = Depends(require_viewer)):
    await _run(service.delete_workspace(user, workspace_id, ip=client_ip(request)))
    return {"ok": True}


# ── Members ───────────────────────────────────────────────────────────────


@router.get("/workspaces/{workspace_id}/members")
async def list_members(workspace_id: str, user: AuthUser = Depends(require_viewer)):
    return {"members": await _run(service.list_members(user, workspace_id))}


class AddMemberBody(BaseModel):
    login: str = Field(min_length=1, max_length=254)
    role: str
    area: Optional[dict] = None
    title: str = Field(default="", max_length=120)


@router.post("/workspaces/{workspace_id}/members")
async def add_member(workspace_id: str, body: AddMemberBody, request: Request,
                     user: AuthUser = Depends(require_viewer)):
    m = await _run(service.add_member(user, workspace_id, login=body.login, role=body.role,
                                      area=body.area, title=body.title, ip=client_ip(request)))
    return {"member": m}


class PatchMemberBody(BaseModel):
    role: Optional[str] = None
    area: Optional[dict] = None                # explicit null clears it
    title: Optional[str] = Field(default=None, max_length=120)


@router.patch("/workspaces/{workspace_id}/members/{membership_id}")
async def patch_member(workspace_id: str, membership_id: str, body: PatchMemberBody,
                       request: Request, user: AuthUser = Depends(require_viewer)):
    kw = {}
    if "area" in body.model_fields_set:
        kw["area"] = body.area
    m = await _run(service.patch_member(user, workspace_id, membership_id, role=body.role,
                                        title=body.title, ip=client_ip(request), **kw))
    return {"member": m}


@router.delete("/workspaces/{workspace_id}/members/{membership_id}")
async def remove_member(workspace_id: str, membership_id: str, request: Request,
                        user: AuthUser = Depends(require_viewer)):
    await _run(service.remove_member(user, workspace_id, membership_id, ip=client_ip(request)))
    return {"ok": True}


# ── Invites ───────────────────────────────────────────────────────────────


@router.get("/workspaces/{workspace_id}/invites")
async def list_invites(workspace_id: str, user: AuthUser = Depends(require_viewer)):
    return {"invites": await _run(service.list_invites(user, workspace_id))}


class InviteBody(BaseModel):
    role: str
    email: Optional[str] = Field(default=None, max_length=254)
    area: Optional[dict] = None
    title: str = Field(default="", max_length=120)
    expires_days: Optional[int] = None


@router.post("/workspaces/{workspace_id}/invites")
async def create_invite(workspace_id: str, body: InviteBody, request: Request,
                        user: AuthUser = Depends(require_viewer)):
    return await _run(service.create_invite(
        user, workspace_id, role=body.role, email=body.email, area=body.area,
        title=body.title, expires_days=body.expires_days, ip=client_ip(request)))


@router.delete("/workspaces/{workspace_id}/invites/{invite_id}")
async def revoke_invite(workspace_id: str, invite_id: str, request: Request,
                        user: AuthUser = Depends(require_viewer)):
    await _run(service.revoke_invite(user, workspace_id, invite_id, ip=client_ip(request)))
    return {"ok": True}


# ── Drones ────────────────────────────────────────────────────────────────


@router.get("/workspaces/{workspace_id}/drones")
async def workspace_drones(workspace_id: str, user: AuthUser = Depends(require_viewer)):
    return {"drones": await _run(service.list_workspace_drones(user, workspace_id))}


class AssignDroneBody(BaseModel):
    workspace_id: str


@router.post("/drones/{drone_id}/workspace")
async def assign_drone(drone_id: str, body: AssignDroneBody, request: Request,
                       user: AuthUser = Depends(require_viewer)):
    d = await _run(service.assign_drone(user, drone_id, body.workspace_id, ip=client_ip(request)))
    return {"drone": d}


# ── Staff, audit ──────────────────────────────────────────────────────────


@router.get("/staff")
async def staff(user: AuthUser = Depends(require_viewer)):
    return {"staff": await _run(service.list_staff(user))}


@router.get("/audit")
async def audit_log(user: AuthUser = Depends(require_viewer),
                    workspace_id: Optional[str] = Query(None),
                    limit: int = Query(100, ge=1, le=500),
                    before: Optional[int] = Query(None)):
    return {"events": await _run(service.list_audit(user, workspace_id=workspace_id,
                                                    limit=limit, before=before))}
