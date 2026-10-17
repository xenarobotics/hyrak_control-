"""/api/auth/* - login, logout, me, and admin user management."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

from app.auth import service
from app.auth.deps import bearer_of, require_admin, require_viewer
from app.auth.service import AuthError, AuthUser, RateLimited
from app.auth.store import ROLES

logger = logging.getLogger("verocore.auth.routes")
router = APIRouter(prefix="/api/auth", tags=["auth"])


def client_ip(request: Request) -> str:
    h = request.headers
    return (
        h.get("cf-connecting-ip")
        or (h.get("x-forwarded-for") or "").split(",")[0].strip()
        or (request.client.host if request.client else "")
        or "-"
    )


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=1024)
    label: str = Field(default="", max_length=120)


@router.post("/login")
async def login(body: LoginBody, request: Request):
    try:
        token, user, expires_at = await service.login(
            body.username, body.password, client_ip(request),
            label=body.label or (request.headers.get("user-agent") or "")[:120],
        )
    except RateLimited as e:
        raise HTTPException(status_code=429, detail=str(e))
    except AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    return {"token": token, "user": user.public(), "expires_at": expires_at.isoformat()}


@router.post("/logout")
async def logout(authorization: str | None = Header(None)):
    await service.logout(bearer_of(authorization))
    return {"ok": True}


@router.get("/me")
async def me(user: AuthUser = Depends(require_viewer)):
    return {"user": user.public()}


# ── Admin: user management ───────────────────────────────────────────────


class CreateUserBody(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=1024)
    role: str = Field(default="viewer")


class PatchUserBody(BaseModel):
    role: str | None = None
    disabled: bool | None = None
    password: str | None = Field(default=None, max_length=1024)


@router.get("/users")
async def list_users(_: AuthUser = Depends(require_admin)):
    return {"users": await service.list_users()}


@router.post("/users")
async def create_user(body: CreateUserBody, _: AuthUser = Depends(require_admin)):
    if body.role not in ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of {', '.join(ROLES)}")
    try:
        rec = await service.create_user(body.username, body.password, body.role)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError:
        raise HTTPException(status_code=503, detail="Database offline - users cannot be created")
    logger.info(f"auth: user created '{rec.username}' role={rec.role}")
    return {"user": rec.public()}


@router.patch("/users/{user_id}")
async def patch_user(user_id: str, body: PatchUserBody, admin: AuthUser = Depends(require_admin)):
    if user_id == admin.id and (body.disabled or (body.role and body.role != "admin")):
        raise HTTPException(status_code=400, detail="You cannot lock yourself out")
    try:
        rec = await service.update_user(user_id, role=body.role, disabled=body.disabled,
                                        password=body.password)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if rec is None:
        raise HTTPException(status_code=404, detail="User not found")
    return {"user": rec.public()}


@router.delete("/users/{user_id}")
async def delete_user(user_id: str, admin: AuthUser = Depends(require_admin)):
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="You cannot delete yourself")
    if not await service.delete_user(user_id):
        raise HTTPException(status_code=404, detail="User not found")
    return {"ok": True}
