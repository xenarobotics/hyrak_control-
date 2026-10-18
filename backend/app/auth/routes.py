"""/api/auth/* - sign-in, the caller's own account, invites, reset links, and
founders' account administration. Contract: docs/ACCESS_MODEL.md section 7
(deviations are listed in docs/AUTH.md).

Status codes: 401 only for "not signed in / bad credentials at login" (the
frontend treats any 401 as "go to /login"), so a wrong current password on
a password change is 403, not 401. 429 rate limited, 503 store offline.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field, model_validator

from app.auth import audit, service
from app.auth import perms
from app.auth.clientip import client_ip
from app.auth.deps import bearer_of, optional_user, require_founder, require_signed_in
from app.auth.service import AuthError, AuthUnavailable, AuthUser, DbOffline, RateLimited
from app.auth.store import ROLES, PLATFORM_WORKSPACE_ID, StoreConflict

logger = logging.getLogger("verocore.auth.routes")
router = APIRouter(prefix="/api/auth", tags=["auth"])

__all__ = ["router", "client_ip"]


def _http(e: Exception) -> HTTPException:
    """One mapping for every service exception."""
    from app.workspaces.service import Refused
    if isinstance(e, Refused):
        return HTTPException(status_code=e.status, detail=e.detail)
    if isinstance(e, RateLimited):
        return HTTPException(status_code=429, detail=str(e))
    if isinstance(e, (AuthUnavailable, DbOffline)):
        return HTTPException(status_code=503, detail=str(e) or "Database offline")
    if isinstance(e, StoreConflict):
        return HTTPException(status_code=409, detail=str(e))
    if isinstance(e, ValueError):
        return HTTPException(status_code=400, detail=str(e))
    if isinstance(e, LookupError):
        return HTTPException(status_code=404, detail=str(e) or "Not found")
    raise e


async def _audit(actor, action: str, **kw) -> None:
    await audit.record(service.read_store(), actor, action, **kw)


# ── Sign in / out ─────────────────────────────────────────────────────────


class LoginBody(BaseModel):
    login: str | None = Field(default=None, min_length=1, max_length=254)
    username: str | None = Field(default=None, min_length=1, max_length=254)   # alias of login
    password: str = Field(min_length=1, max_length=1024)
    label: str = Field(default="", max_length=120)

    @model_validator(mode="after")
    def _one_login(self):
        if not (self.login or self.username):
            raise ValueError("login is required")
        return self


@router.post("/login")
async def login(body: LoginBody, request: Request):
    try:
        token, user, expires_at = await service.login(
            body.login or body.username, body.password, client_ip(request),
            label=body.label or (request.headers.get("user-agent") or "")[:120],
        )
    except RateLimited as e:
        raise HTTPException(status_code=429, detail=str(e))
    except AuthUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
    except AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    return {"token": token, "user": user.public(), "expires_at": expires_at.isoformat()}


@router.post("/logout")
async def logout(authorization: str | None = Header(None)):
    await service.logout(bearer_of(authorization))
    return {"ok": True}


# ── My account ────────────────────────────────────────────────────────────


@router.get("/me")
async def me(user: AuthUser = Depends(require_signed_in)):
    from app.workspaces import service as ws_service
    return await ws_service.describe_me(user)


class ProfileBody(BaseModel):
    display_name: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=254)


def _real_account(user: AuthUser) -> None:
    if user.id == service.LEGACY_USER_ID:
        raise HTTPException(status_code=403, detail="The legacy shared token has no account")


@router.patch("/me")
async def patch_me(body: ProfileBody, request: Request, user: AuthUser = Depends(require_signed_in)):
    _real_account(user)
    try:
        rec = await service.update_profile(user.id, display_name=body.display_name,
                                           email=body.email)
    except Exception as e:
        raise _http(e)
    if rec is None:
        raise HTTPException(status_code=404, detail="User not found")
    await _audit(user, "account.update", target_type="user", target_id=user.id,
                 detail={k: v for k, v in body.model_dump(exclude_none=True).items()},
                 ip=client_ip(request))
    return {"user": rec.public()}


class PasswordBody(BaseModel):
    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=1, max_length=1024)


@router.post("/me/password")
async def change_password(body: PasswordBody, request: Request,
                          authorization: str | None = Header(None),
                          user: AuthUser = Depends(require_signed_in)):
    _real_account(user)
    token = bearer_of(authorization)
    try:
        n = await service.change_password(user, body.current_password, body.new_password,
                                          client_ip(request),
                                          keep_hash=service.hash_token(token) if token else None)
    except RateLimited as e:
        raise HTTPException(status_code=429, detail=str(e))
    except AuthError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        raise _http(e)
    await _audit(user, "account.password_change", target_type="user", target_id=user.id,
                 detail={"other_sessions_ended": n}, ip=client_ip(request))
    return {"ok": True, "other_sessions_ended": n}


@router.get("/sessions")
async def my_sessions(authorization: str | None = Header(None),
                      user: AuthUser = Depends(require_signed_in)):
    token = bearer_of(authorization)
    return await service.list_sessions(user.id, service.hash_token(token) if token else None)


@router.delete("/sessions/{token_id}")
async def revoke_my_session(token_id: str, user: AuthUser = Depends(require_signed_in)):
    if not await service.revoke_session(user.id, token_id):
        raise HTTPException(status_code=404, detail="Session not found")
    return {"ok": True}


@router.post("/sessions/revoke-others")
async def revoke_my_other_sessions(authorization: str | None = Header(None),
                                   user: AuthUser = Depends(require_signed_in)):
    _real_account(user)
    token = bearer_of(authorization)
    n = await service.revoke_all(user.id, keep_hash=service.hash_token(token) if token else None)
    return {"ok": True, "ended": n}


# ── Invites (public) ──────────────────────────────────────────────────────


@router.get("/invites/{token}")
async def preview_invite(token: str, request: Request):
    from app.workspaces import service as ws_service
    try:
        return await ws_service.preview_invite(token, client_ip(request))
    except Exception as e:
        raise _http(e)


class AcceptBody(BaseModel):
    display_name: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=254)
    password: str | None = Field(default=None, max_length=1024)
    username: str | None = Field(default=None, max_length=64)


@router.post("/invites/{token}/accept")
async def accept_invite(token: str, request: Request, body: AcceptBody | None = None,
                        user: AuthUser | None = Depends(optional_user)):
    from app.workspaces import service as ws_service
    body = body or AcceptBody()
    try:
        return await ws_service.accept_invite(
            token, user, ip=client_ip(request),
            label=(request.headers.get("user-agent") or "")[:120],
            display_name=body.display_name, email=body.email, password=body.password,
            username=body.username)
    except Exception as e:
        raise _http(e)


# ── Reset links (public use, founder issue) ───────────────────────────────


class ResetBody(BaseModel):
    password: str = Field(min_length=1, max_length=1024)


@router.post("/reset/{token}")
async def use_reset(token: str, body: ResetBody, request: Request):
    ip = client_ip(request)
    try:
        user_id = await service.use_reset(token, body.password, ip)
    except RateLimited as e:
        raise HTTPException(status_code=429, detail=str(e))
    except AuthError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise _http(e)
    await _audit(None, "account.password_reset", target_type="user", target_id=user_id, ip=ip)
    return {"ok": True}


# ── Founders: accounts ────────────────────────────────────────────────────


async def _user_view(u) -> dict:
    d = u.public()
    try:
        ms = await service.memberships_of(u.id)
    except Exception:
        ms = []
    d["memberships"] = [m.public() for m in ms]
    d["role"] = perms.compat_role(ms)
    return d


@router.get("/users")
async def list_users(_: AuthUser = Depends(require_founder)):
    return {"users": [await _user_view(u) for u in await service.list_users()]}


class CreateUserBody(BaseModel):
    """Compatibility form of the old admin console: `role` sets the HYRAK
    membership (admin -> founder, operator -> pilot, viewer -> viewer)."""
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=1024)
    role: str = Field(default="viewer")
    email: str | None = Field(default=None, max_length=254)
    display_name: str = Field(default="", max_length=120)


@router.post("/users")
async def create_user(body: CreateUserBody, request: Request,
                      founder: AuthUser = Depends(require_founder)):
    if body.role not in ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of {', '.join(ROLES)}")
    try:
        if await service.find_account(body.username) is not None:
            raise HTTPException(status_code=409, detail="That username is taken")
        # A founder typing the address vouches for it.
        rec = await service.create_user(body.username, body.password, body.role,
                                        email=body.email, display_name=body.display_name,
                                        email_verified=True)
    except HTTPException:
        raise
    except RuntimeError:
        raise HTTPException(status_code=503, detail="Database offline - users cannot be created")
    except Exception as e:
        raise _http(e)
    await _audit(founder, "account.create", workspace_id=PLATFORM_WORKSPACE_ID,
                 target_type="user", target_id=rec.id,
                 detail={"username": rec.username, "compat_role": body.role},
                 ip=client_ip(request))
    logger.info(f"auth: user created '{rec.username}' compat role={body.role}")
    return {"user": await _user_view(rec)}


class PatchUserBody(BaseModel):
    disabled: bool | None = None
    display_name: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=254)   # founder-set = verified; "" clears
    password: str | None = Field(default=None, max_length=1024)
    role: str | None = None           # refused with 400: roles live in memberships


@router.patch("/users/{user_id}")
async def patch_user(user_id: str, body: PatchUserBody, request: Request,
                     founder: AuthUser = Depends(require_founder)):
    if body.role is not None:
        raise HTTPException(status_code=400, detail="role is no longer an account field; "
                                                    "change the user's workspace memberships")
    if user_id == founder.id and body.disabled:
        raise HTTPException(status_code=400, detail="You cannot lock yourself out")
    try:
        rec = await service.update_user(user_id, disabled=body.disabled,
                                        display_name=body.display_name, password=body.password,
                                        email=body.email, email_verified=True)
    except Exception as e:
        raise _http(e)
    if rec is None:
        raise HTTPException(status_code=404, detail="User not found")
    detail = body.model_dump(exclude_none=True)
    if "password" in detail:
        detail["password"] = "set"
    await _audit(founder, "account.update", target_type="user", target_id=user_id,
                 detail=detail, ip=client_ip(request))
    return {"user": await _user_view(rec)}


@router.delete("/users/{user_id}")
async def delete_user(user_id: str, request: Request, founder: AuthUser = Depends(require_founder)):
    if user_id == founder.id:
        raise HTTPException(status_code=400, detail="You cannot delete yourself")
    target = await service.get_user(user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="User not found")
    ms = await service.memberships_of(user_id)
    if perms.is_founder(ms) and not target.disabled:
        n = await service.read_store().count_role(PLATFORM_WORKSPACE_ID, perms.FOUNDER)
        if n <= 1:
            raise HTTPException(status_code=409, detail="This is the last founder")
    # Memberships go with the account (cascade). That may leave a workspace
    # without an owner, which is allowed here for the same reason a founder
    # may remove a last owner: only founders reach this route.
    if not await service.delete_user(user_id):
        raise HTTPException(status_code=404, detail="User not found")
    await _audit(founder, "account.delete", target_type="user", target_id=user_id,
                 detail={"username": target.username,
                         "memberships": [{"workspace_id": m.workspace_id, "role": m.role}
                                         for m in ms]},
                 ip=client_ip(request))
    return {"ok": True}


@router.post("/users/{user_id}/reset-link")
async def reset_link(user_id: str, request: Request, founder: AuthUser = Depends(require_founder)):
    from app.workspaces.service import link
    try:
        token, expires_at = await service.issue_reset(user_id, founder.id)
    except LookupError:
        raise HTTPException(status_code=404, detail="User not found")
    except Exception as e:
        raise _http(e)
    await _audit(founder, "account.reset_link", target_type="user", target_id=user_id,
                 ip=client_ip(request))
    return {"url": link(f"/reset/{token}"), "expires_at": expires_at.isoformat()}
