"""
FastAPI side of auth: `Depends(require_user("operator"))`.

Reads `Authorization: Bearer <token>`. The old `X-Auth-Token` header is
honoured only through service.authenticate's legacy path, i.e. only when
AUTH_LEGACY_TOKEN_ENABLED=true and SECRET_TOKEN is not the default.

401 = no usable credential, 403 = signed in but the role is too low. Every
accepted mutating request writes one line to the hyrak.audit logger.

The role compared here is the compatibility role computed from memberships
(docs/ACCESS_MODEL.md section 8); require_founder checks the membership
itself. Workspace-scoped checks happen in app/workspaces with the
permission engine, not here.
"""
from __future__ import annotations

from fastapi import Header, HTTPException, Request

from app.auth import audit
from app.auth.service import AuthUser, authenticate
from app.auth.store import ROLE_RANK

_MUTATING = {"POST", "PUT", "PATCH", "DELETE"}


def bearer_of(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        return None
    return value.strip()


def require_user(min_role: str = "viewer"):
    if min_role not in ROLE_RANK:
        raise ValueError(f"unknown role {min_role!r}")

    async def _dep(
        request: Request,
        authorization: str | None = Header(None),
        x_auth_token: str | None = Header(None, alias="X-Auth-Token"),
    ) -> AuthUser:
        user = await authenticate(bearer_of(authorization), x_auth_token)
        if user is None:
            raise HTTPException(status_code=401, detail="Not signed in")
        if not user.has_role(min_role):
            raise HTTPException(status_code=403, detail=f"Requires the {min_role} role")
        request.state.user = user
        if request.method in _MUTATING:
            audit.log(user, f"{request.method} {request.url.path}",
                      drone=request.path_params.get("drone_id") or request.path_params.get("drone_db_id"))
        return user

    _dep.__name__ = f"require_{min_role}"
    return _dep


# Any signed-in account, customers included ("member" rank, phase 1). For
# routes whose real check is a workspace permission (workspaces, account,
# zone writes); never for the live paths.
require_signed_in = require_user("member")
require_viewer = require_user("viewer")
require_operator = require_user("operator")
require_admin = require_user("admin")


async def require_founder(
    request: Request,
    authorization: str | None = Header(None),
    x_auth_token: str | None = Header(None, alias="X-Auth-Token"),
) -> AuthUser:
    user = await authenticate(bearer_of(authorization), x_auth_token)
    if user is None:
        raise HTTPException(status_code=401, detail="Not signed in")
    if not user.is_founder:
        raise HTTPException(status_code=403, detail="Founders only")
    request.state.user = user
    if request.method in _MUTATING:
        audit.log(user, f"{request.method} {request.url.path}")
    return user


async def optional_user(
    authorization: str | None = Header(None),
) -> AuthUser | None:
    """The signed-in user, None when no bearer was sent, 401 when one was
    sent but no longer verifies (a stale token must not silently turn a
    signed-in action into a signed-out one)."""
    token = bearer_of(authorization)
    if token is None:
        return None
    user = await authenticate(token)
    if user is None:
        raise HTTPException(status_code=401, detail="Not signed in")
    return user
