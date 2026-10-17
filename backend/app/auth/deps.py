"""
FastAPI side of auth: `Depends(require_user("operator"))`.

Reads `Authorization: Bearer <token>`. The old `X-Auth-Token` header is
honoured only through service.authenticate's legacy path, i.e. only when
AUTH_LEGACY_TOKEN_ENABLED=true and SECRET_TOKEN is not the default.

401 = no usable credential, 403 = signed in but the role is too low. Every
accepted mutating request writes one line to the hyrak.audit logger.
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


require_viewer = require_user("viewer")
require_operator = require_user("operator")
require_admin = require_user("admin")
