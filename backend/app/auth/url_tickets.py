"""
Short-lived URL tickets for the few GET routes a browser must load without
an Authorization header (an MJPEG stream in an `<img>`).

    POST /api/auth/url-ticket {"path": "/api/recon/stream/depth"}
      -> {"ticket": "...", "expires_at": <unix seconds>}
    GET  /api/recon/stream/depth?ticket=...

Rules (docs/AUTH.md "URL tickets"):

* A ticket is 32 random bytes (urlsafe base64). Only its SHA-256 is kept,
  in a bounded in-memory map: one process only, like the token cache.
* It is bound to the user, to the bearer token that asked for it, and to
  one exact path (no query string). It is valid for TICKET_TTL_S from
  issue and may be presented any number of times in that window, so an
  `<img>` can reconnect; after that the client asks for a new one.
* It is issued only for a path that matches a GET route which opted in
  with `require_user_or_ticket(min_role, template)` (the route's own path
  template, registered here), and only when the caller already passes that
  route's role check. Every other route ignores `?ticket=`
  (they use require_user, which reads headers only), and the dependency
  refuses any method but GET / HEAD.
* On every use the issuing token is verified again (verify_token_hash: a
  logout, a revoked token, a disabled account or a lower role all count
  now), so a ticket never outlives the access it was minted from.
"""
from __future__ import annotations

import hashlib
import secrets
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Optional

from fastapi import Header, HTTPException, Query, Request
from starlette.routing import compile_path

from app.auth.deps import bearer_of
from app.auth.service import AuthUser, authenticate, verify_token_hash
from app.auth.store import ROLE_RANK

TICKET_TTL_S = 60.0
MAX_TICKETS = 4096
_SAFE_METHODS = {"GET", "HEAD"}
# Opted-in GET routes: (path regex, template, min role). Filled when a
# route module builds its dependency.
_routes: list[tuple] = []


@dataclass(frozen=True)
class Ticket:
    user_id: str
    token_hash: str
    path: str
    expires: float          # _now() clock


_tickets: "OrderedDict[str, Ticket]" = OrderedDict()


def _now() -> float:
    return time.monotonic()


def _hash(ticket: str) -> str:
    return hashlib.sha256(ticket.encode("utf-8")).hexdigest()


def _prune(now: float) -> None:
    for h in [h for h, t in _tickets.items() if t.expires <= now]:
        del _tickets[h]
    while len(_tickets) >= MAX_TICKETS:
        _tickets.popitem(last=False)          # oldest first


def issue(user_id: str, token_hash: str, path: str) -> tuple[str, float]:
    """A new ticket and its expiry as unix seconds."""
    now = _now()
    _prune(now)
    ticket = secrets.token_urlsafe(32)
    _tickets[_hash(ticket)] = Ticket(user_id=user_id, token_hash=token_hash,
                                     path=path, expires=now + TICKET_TTL_S)
    return ticket, time.time() + TICKET_TTL_S


def lookup(ticket: str | None, path: str) -> Optional[Ticket]:
    """The live ticket for exactly this path, or None."""
    if not ticket or not isinstance(ticket, str) or len(ticket) > 128:
        return None
    h = _hash(ticket)
    t = _tickets.get(h)
    if t is None:
        return None
    if t.expires <= _now():
        _tickets.pop(h, None)
        return None
    return t if t.path == path else None


def reset_for_tests() -> None:
    _tickets.clear()


def require_user_or_ticket(min_role: str, template: str):
    """require_user(min_role), or a URL ticket for this exact path when the
    request carries no credential header. `template` is the GET route's own
    full path ("/api/recon/stream/{kind}"); building the dependency is what
    opts the route in, and nothing else accepts tickets."""
    if min_role not in ROLE_RANK:
        raise ValueError(f"unknown role {min_role!r}")
    regex = compile_path(template)[0]
    if not any(t == template for _, t, _ in _routes):
        _routes.append((regex, template, min_role))

    async def _dep(
        request: Request,
        authorization: str | None = Header(None),
        x_auth_token: str | None = Header(None, alias="X-Auth-Token"),
        ticket: str | None = Query(None),
    ) -> AuthUser:
        path = request.url.path
        if request.method not in _SAFE_METHODS or not regex.match(path):
            # Never reached through routing (the route is a GET on this
            # template), but a misuse on another route or a POST must not
            # turn a ticket into a credential there.
            ticket = None
        if authorization or x_auth_token or not ticket:
            user = await authenticate(bearer_of(authorization), x_auth_token)
        else:
            t = lookup(ticket, path)
            user = await verify_token_hash(t.token_hash) if t is not None else None
            if user is not None and user.id != t.user_id:
                user = None
        if user is None:
            raise HTTPException(status_code=401, detail="Not signed in")
        if not user.has_role(min_role):
            raise HTTPException(status_code=403, detail=f"Requires the {min_role} role")
        request.state.user = user
        return user

    _dep.__name__ = f"require_{min_role}_or_ticket"
    return _dep


def ticket_role_for(path: str) -> Optional[str]:
    """The min role of the opted-in GET route whose template matches
    `path`, or None when no route accepts tickets there."""
    for regex, _, role in _routes:
        if regex.match(path):
            return role
    return None


def ticket_templates() -> list[str]:
    return [t for _, t, _ in _routes]


def valid_path(path) -> bool:
    return (isinstance(path, str) and path.startswith("/api/") and len(path) <= 512
            and "?" not in path and "#" not in path and "//" not in path
            and "/../" not in path and not path.endswith("/..") and "\\" not in path)
