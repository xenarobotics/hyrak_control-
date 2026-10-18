"""
Login, tokens, accounts - the one place that decides who a request is.

Model (docs/AUTH.md, docs/ACCESS_MODEL.md):
  * A user has a username, optionally an email (unique, lower-case), a
    scrypt password hash and memberships: one role per workspace. There is
    no per-user role any more. The live control paths still compare a
    viewer < operator < admin rank; that "compatibility role" is computed
    from memberships (perms.compat_role) and carried on AuthUser.role, so
    every require_operator / has_role call keeps working unchanged.
  * Logging in (by username or email) mints a 32-byte urlsafe bearer
    token. Only its SHA-256 is stored; it expires 30 days after last use
    (sliding) and is cached here for 60 s together with the user's
    memberships, so a database blip does not log everyone out mid-flight.
  * The database is optional (app/db/engine.py). The HYRAK_ADMIN_USER /
    HYRAK_ADMIN_PASSWORD_HASH bootstrap founder lives in a memory store as
    well as the DB, so an operator can still sign in when Postgres was
    unreachable at startup.
  * Anything that grants access fails CLOSED: if the DB is up but a user
    or membership query raises, the answer is "no" (or the still-fresh
    cache entry), never the memory store's possibly stale copy of an
    account the DB knows about.
  * The legacy shared SECRET_TOKEN is accepted only when
    AUTH_LEGACY_TOKEN_ENABLED=true AND it is not the published default -
    the default string shipped in the public JS bundle, so it is refused
    unconditionally.

Everything here is importable without a database and without the FastAPI
app; the HTTP dependency and the socket guard are thin wrappers in
deps.py / socket_guard.py, the workspace rules live in app/workspaces.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import re
import secrets
import time
import uuid
from collections import deque
from dataclasses import dataclass
from datetime import timedelta
from typing import Optional

from app.auth import perms
from app.auth.passwords import hash_password, looks_like_hash, verify_password
from app.auth.store import (
    PLATFORM_WORKSPACE_ID, ROLE_RANK, ROLES, DbStore, MembershipRecord, MemoryStore,
    ResetRecord, TokenRecord, UserRecord, new_id, utcnow,
)
from app.config import get_settings

logger = logging.getLogger("verocore.auth")

DEFAULT_SECRET_TOKEN = "dev_token_change_in_production"
TOKEN_BYTES = 32
TOKEN_CACHE_S = 60.0
# Sliding expiry is written back at most this often per token - a 10 Hz
# telemetry page must not turn into 10 UPDATEs a second.
TOUCH_INTERVAL_S = 300.0
LOGIN_MAX_FAILURES = 5
LOGIN_WINDOW_S = 15 * 60
# Per-USERNAME failures do not hard-lock the account (an attacker spraying
# a known operator name from many addresses would lock the operator out of
# their own aircraft). After LOGIN_MAX_FAILURES the next attempt must wait
# an exponentially growing delay, capped, that resets on success or after
# LOGIN_WINDOW_S of quiet. The per-IP limit stays a hard lock: that is the
# attacker's side of the connection.
USERNAME_BACKOFF_BASE_S = 2.0
USERNAME_BACKOFF_MAX_S = 120.0
# Absolute ceiling per username per window, whatever the spacing: backoff
# alone would still allow ~10 guesses an hour forever.
USERNAME_HARD_CAP = 20
# How often a live socket's token is re-checked against the store.
SOCKET_REVALIDATE_S = TOKEN_CACHE_S
LEGACY_USER_ID = "legacy-token"
RESET_TTL = timedelta(hours=1)

# The old --role / {role} vocabulary, as memberships on the platform
# workspace (docs/ACCESS_MODEL.md section 6 migration mapping).
COMPAT_TO_PLATFORM_ROLE = {"admin": perms.FOUNDER, "operator": perms.PILOT, "viewer": perms.VIEWER}

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class AuthError(Exception):
    """Login refused. The message is deliberately generic."""


class RateLimited(AuthError):
    pass


class AuthUnavailable(Exception):
    """The user store could not answer; refuse rather than guess (503)."""


class DbOffline(RuntimeError):
    """A write that must be durable was asked for with the database down (503)."""


@dataclass(frozen=True)
class AuthUser:
    id: str
    username: str
    role: str                                  # compatibility role, from memberships
    memberships: tuple = ()
    email: Optional[str] = None
    display_name: str = ""

    def has_role(self, min_role: str) -> bool:
        return ROLE_RANK.get(self.role, -1) >= ROLE_RANK[min_role]

    @property
    def is_founder(self) -> bool:
        return perms.is_founder(self.memberships)

    @property
    def is_staff(self) -> bool:
        return perms.is_staff(self.memberships)

    def public(self) -> dict:
        return {"id": self.id, "username": self.username, "email": self.email,
                "display_name": self.display_name, "is_founder": self.is_founder,
                "is_staff": self.is_staff, "role": self.role}


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def role_at_least(role: str, min_role: str) -> bool:
    return ROLE_RANK.get(role, -1) >= ROLE_RANK[min_role]


# ── Store selection ───────────────────────────────────────────────────────

_memory = MemoryStore()
_db = DbStore()
# Test switch: with the DB down, durable writes (workspaces, invites,
# accounts) are refused with 503 in production, because a memory-only copy
# would vanish on restart and never reconcile with the DB. Tests turn this
# on to use the memory store as the full double.
_memory_writes = False


def _db_up() -> bool:
    try:
        from app.db import db_available
        return db_available()
    except Exception:
        return False


def memory_store() -> MemoryStore:
    """The in-memory backend. Tests monkeypatch service._db_up to False and
    populate this directly; production holds only the platform workspace
    and the env founder here."""
    return _memory


def allow_memory_writes(flag: bool = True) -> None:
    global _memory_writes
    _memory_writes = flag


def read_store():
    return _db if _db_up() else _memory


def write_store():
    if _db_up():
        return _db
    if _memory_writes:
        return _memory
    raise DbOffline("database offline")


def reset_for_tests() -> None:
    global _memory, _memory_writes
    _memory = MemoryStore()
    _memory_writes = False
    _token_cache.clear()
    _failures.clear()
    _inflight.clear()
    _revocation_listeners.clear()


# ── Token cache ───────────────────────────────────────────────────────────

# token_hash -> (cached_at monotonic, AuthUser, expires_at, last_touch monotonic)
_token_cache: dict[str, tuple[float, AuthUser, object, float]] = {}


def _cache_get(h: str) -> AuthUser | None:
    entry = _token_cache.get(h)
    if entry is None:
        return None
    cached_at, user, expires_at, _ = entry
    if time.monotonic() - cached_at > TOKEN_CACHE_S:
        return None
    if expires_at is not None and expires_at <= utcnow():
        _token_cache.pop(h, None)
        return None
    return user


def _cache_put(h: str, user: AuthUser, expires_at, touched: float | None = None) -> None:
    prev = _token_cache.get(h)
    last_touch = touched if touched is not None else (prev[3] if prev else 0.0)
    _token_cache[h] = (time.monotonic(), user, expires_at, last_touch)


def _cache_drop(h: str) -> None:
    _token_cache.pop(h, None)


def drop_cached_user(user_id: str) -> None:
    for h in [h for h, e in _token_cache.items() if e[1].id == user_id]:
        _token_cache.pop(h, None)


# Called with a user id whenever that user's access changes (tokens
# revoked, compatibility role changed, membership removed, disabled,
# deleted). server.py registers one that disconnects every live socket of
# that user, so a revocation takes effect on the next packet, not on the
# next page load; a still-valid token resumes with the fresh role.
_revocation_listeners: list = []


def on_user_revoked(callback) -> None:
    _revocation_listeners.append(callback)


async def _notify_revoked(user_id: str) -> None:
    for cb in list(_revocation_listeners):
        try:
            await cb(user_id)
        except Exception as e:
            logger.warning(f"auth: revocation listener failed: {e}")


# ── Rate limits ───────────────────────────────────────────────────────────

_failures: dict[str, deque] = {}


def _prune(key: str, now: float) -> deque:
    q = _failures.setdefault(key, deque())
    while q and now - q[0] > LOGIN_WINDOW_S:
        q.popleft()
    return q


def username_backoff_s(username: str, now: float | None = None) -> float:
    """Seconds this username must still wait before another attempt."""
    now = time.monotonic() if now is None else now
    q = _prune(f"u:{username}", now)
    n = len(q)
    if n < LOGIN_MAX_FAILURES:
        return 0.0
    delay = min(USERNAME_BACKOFF_BASE_S * (2 ** (n - LOGIN_MAX_FAILURES)), USERNAME_BACKOFF_MAX_S)
    return max(0.0, q[-1] + delay - now)


# Attempts currently between reservation and verdict, per username.
_inflight: dict[str, int] = {}


def _reserve_attempt(username: str, ip: str) -> None:
    """Check the limits AND count this attempt, with no await in between.

    The attempt is recorded as a failure up front (a success clears it), so
    twenty concurrent requests cannot all pass the check before the first
    verdict lands: the sixth already sees five. Raises RateLimited."""
    now = time.monotonic()
    ipq = _prune(f"ip:{ip}", now)
    uq = _prune(f"u:{username}", now)
    if len(ipq) >= LOGIN_MAX_FAILURES:
        raise RateLimited("Too many attempts from this address. Try again in 15 minutes.")
    if len(uq) >= USERNAME_HARD_CAP:
        raise RateLimited("Too many attempts for this account. Try again in 15 minutes.")
    if len(uq) >= LOGIN_MAX_FAILURES:
        # In backoff: one attempt at a time, and only after the delay.
        if _inflight.get(username, 0) > 0:
            raise RateLimited("Another sign-in for this account is in progress. Try again shortly.")
        wait = username_backoff_s(username, now)
        if wait > 0:
            raise RateLimited(f"Too many attempts. Try again in {int(wait) + 1} seconds.")
    ipq.append(now)
    uq.append(now)
    _inflight[username] = _inflight.get(username, 0) + 1


def _release_attempt(username: str) -> None:
    n = _inflight.get(username, 0) - 1
    if n > 0:
        _inflight[username] = n
    else:
        _inflight.pop(username, None)


def _record_failure(username: str, ip: str) -> None:
    """A failure that took no reservation (malformed request)."""
    now = time.monotonic()
    _prune(f"u:{username}", now).append(now)
    _prune(f"ip:{ip}", now).append(now)


def _clear_failures(username: str, ip: str) -> None:
    _failures.pop(f"u:{username}", None)
    _failures.pop(f"ip:{ip}", None)


def ip_gate(bucket: str, ip: str) -> None:
    """Per-IP hard limit for unauthenticated token endpoints (invite
    preview / accept, reset links): LOGIN_MAX_FAILURES bad tokens per
    LOGIN_WINDOW_S, in a bucket of their own so a mistyped invite link does
    not also lock the address out of signing in. Raises RateLimited."""
    if len(_prune(f"{bucket}:{ip or '-'}", time.monotonic())) >= LOGIN_MAX_FAILURES:
        raise RateLimited("Too many attempts from this address. Try again in 15 minutes.")


def ip_fail(bucket: str, ip: str) -> None:
    now = time.monotonic()
    _prune(f"{bucket}:{ip or '-'}", now).append(now)


# ── Users ─────────────────────────────────────────────────────────────────

def _normalise_username(username) -> str:
    u = str(username or "").strip().lower()
    if not (1 <= len(u) <= 64) or any(c.isspace() for c in u):
        raise ValueError("username must be 1-64 characters with no spaces")
    return u


def normalise_new_username(username) -> str:
    """Stricter than sign-in: '@' is reserved so a login string with '@' is
    always an email."""
    u = _normalise_username(username)
    if "@" in u:
        raise ValueError("username cannot contain '@'")
    return u


def normalise_email(email) -> Optional[str]:
    """Lower-cased and loosely checked; None for empty."""
    e = str(email or "").strip().lower()
    if not e:
        return None
    if len(e) > 254 or not _EMAIL_RE.match(e):
        raise ValueError("email address is not valid")
    return e


async def _find_user(login: str) -> UserRecord | None:
    """The account for a username or (when it contains '@') an email.

    Fails closed: when the DB is up, a query error propagates instead of
    falling back to the memory store, whose copy of an account the DB
    knows about may be stale (a disable or demotion made in the DB). Only
    an account the DB does NOT have is looked for in memory."""
    by = "email" if "@" in login else "username"
    if _db_up():
        u = await getattr(_db, f"get_user_by_{by}")(login)
        if u is not None:
            return u
    return await getattr(_memory, f"get_user_by_{by}")(login)


async def _find_user_by_id(user_id: str) -> tuple[UserRecord | None, object]:
    """(user, the store that holds it). Fails closed like _find_user."""
    if _db_up():
        u = await _db.get_user_by_id(user_id)
        if u is not None:
            return u, _db
    u = await _memory.get_user_by_id(user_id)
    return (u, _memory) if u is not None else (None, None)


async def get_user(user_id: str) -> UserRecord | None:
    return (await _find_user_by_id(user_id))[0]


async def find_account(login: str) -> UserRecord | None:
    """Look up an existing account by username or email (for adding a
    member). None when there is none."""
    s = str(login or "").strip().lower()
    if not s:
        return None
    return await _find_user(s)


async def memberships_of(user_id: str) -> list[MembershipRecord]:
    """From the same store that holds the user. Raises on a DB error."""
    user, store = await _find_user_by_id(user_id)
    if user is None:
        return []
    return await store.memberships_for_user(user_id)


async def _auth_user_for(user: UserRecord, store=None) -> AuthUser:
    if store is None:
        _, store = await _find_user_by_id(user.id)
        store = store or _memory
    ms = tuple(await store.memberships_for_user(user.id))
    return AuthUser(id=user.id, username=user.username, role=perms.compat_role(ms),
                    memberships=ms, email=user.email, display_name=user.display_name)


async def compat_role_of(user_id: str) -> str:
    return perms.compat_role(await memberships_of(user_id))


async def create_user(username: str, password: str, role: str | None = None, *,
                      memory_only: bool = False, email: str | None = None,
                      display_name: str = "", founder: bool = False) -> UserRecord:
    """Create a user, or replace the password of an existing one (an
    existing account's disabled flag is never touched).

    `role` is the old viewer / operator / admin vocabulary, kept for the
    CLI and the old admin form: it sets the user's membership on the
    platform workspace (admin -> founder, operator -> pilot, viewer ->
    viewer). `founder=True` is the same as role="admin". Requires the DB
    unless memory_only."""
    username = normalise_new_username(username)
    if role is not None and role not in ROLES:
        raise ValueError(f"role must be one of {', '.join(ROLES)}")
    platform_role = perms.FOUNDER if founder else COMPAT_TO_PLATFORM_ROLE.get(role) if role else None
    rec = UserRecord(id=str(uuid.uuid4()), username=username,
                     password_hash=hash_password(password),
                     email=normalise_email(email), display_name=(display_name or "").strip()[:120])
    if memory_only:
        store = _memory
    elif _db_up():
        store = _db
    else:
        raise RuntimeError("database offline")
    before = await compat_role_of_in(store, username)
    out = await store.upsert_user(rec)
    if platform_role is not None:
        await set_platform_role(out.id, platform_role, store=store)
    drop_cached_user(out.id)
    after = perms.compat_role(await store.memberships_for_user(out.id))
    if before is not None and before != after:
        await _notify_revoked(out.id)
    return out


async def compat_role_of_in(store, username: str) -> str | None:
    existing = await store.get_user_by_username(username)
    if existing is None:
        return None
    return perms.compat_role(await store.memberships_for_user(existing.id))


async def set_platform_role(user_id: str, role: str | None, *, store=None,
                            created_by: str | None = None) -> None:
    """Unchecked: give the user `role` on the platform workspace (None
    removes it). For the CLI, the env bootstrap and the compatibility
    create-user; API callers go through app/workspaces with the grant rules."""
    store = store or write_store()
    current = next((m for m in await store.memberships_for_user(user_id)
                    if m.workspace_id == PLATFORM_WORKSPACE_ID), None)
    if role is None:
        if current is not None:
            await store.delete_membership(current.id)
        return
    if role not in perms.STAFF_ROLES:
        raise ValueError(f"{role} is not a platform role")
    if current is None:
        await store.add_membership(MembershipRecord(
            id=new_id(), user_id=user_id, workspace_id=PLATFORM_WORKSPACE_ID,
            role=role, created_by=created_by))
    elif current.role != role:
        await store.update_membership(current.id, role=role)


async def membership_changed(user_id: str, *, before_compat: str | None, reduced: bool) -> None:
    """Call after any change to a user's memberships. Always drops their
    cached token entries (memberships ride the 60 s cache); when the change
    took something away or moved their compatibility role, also fires the
    revocation listeners so live sockets re-authenticate now."""
    drop_cached_user(user_id)
    try:
        after = await compat_role_of(user_id)
    except Exception:
        after = None
    if reduced or after != before_compat:
        await _notify_revoked(user_id)


async def list_users() -> list[UserRecord]:
    users: dict[str, UserRecord] = {}
    for u in await _memory.list_users():
        users[u.username] = u
    if _db_up():
        for u in await _db.list_users():
            users[u.username] = u
    return sorted(users.values(), key=lambda u: (u.created_at, u.username))


async def update_user(user_id: str, *, disabled: bool | None = None,
                      password: str | None = None, display_name: str | None = None,
                      email: str | None = None, role: str | None = None) -> UserRecord | None:
    """Account fields only. Authorization is in memberships; `role` is
    refused (ValueError -> 400) rather than silently ignored."""
    if role is not None:
        raise ValueError("role is no longer an account field; change the user's "
                         "workspace memberships instead")
    fields: dict = {}
    if disabled is not None:
        fields["disabled"] = bool(disabled)
    if password is not None:
        fields["password_hash"] = hash_password(password)
    if display_name is not None:
        fields["display_name"] = str(display_name).strip()[:120]
    if email is not None:
        fields["email"] = normalise_email(email)
    if not fields:
        return await get_user(user_id)
    revoke = fields.get("disabled") is True or "password_hash" in fields
    out = None
    try:
        # Both stores, always: the env founder lives in memory AND in the
        # DB, and a disable that only reached one of them would still let
        # the other answer after a DB flap.
        if _db_up():
            out = await _db.update_user(user_id, **fields)
        mem = await _memory.update_user(user_id, **fields)
        out = out or mem
    finally:
        # Even if something above raised after the DB commit: a disable or
        # password change must never leave the old tokens and sockets alive.
        drop_cached_user(user_id)
        if revoke:
            await revoke_all(user_id)
    return out


async def delete_user(user_id: str) -> bool:
    ok = False
    try:
        if _db_up():
            ok = await _db.delete_user(user_id)
        ok = (await _memory.delete_user(user_id)) or ok
    finally:
        drop_cached_user(user_id)
        await _notify_revoked(user_id)
    return ok


async def count_users() -> int:
    n = len(await _memory.list_users())
    if _db_up():
        try:
            n += len(await _db.list_users())
        except Exception:
            pass
    return n


# ── Login / logout / verify ───────────────────────────────────────────────

def _ttl() -> timedelta:
    return timedelta(days=max(1, int(get_settings().auth_token_ttl_days)))


async def _mint(user: UserRecord, label: str = "", store=None) -> tuple[str, AuthUser, object]:
    token = secrets.token_urlsafe(TOKEN_BYTES)
    h = hash_token(token)
    expires_at = utcnow() + _ttl()
    rec = TokenRecord(id=str(uuid.uuid4()), user_id=user.id, token_hash=h,
                      expires_at=expires_at, last_seen_at=utcnow(), label=(label or "")[:120])
    if store is None:
        _, store = await _find_user_by_id(user.id)
        store = store or _memory
    stored_in_db = False
    if store is _db:
        try:
            await _db.add_token(rec)
            stored_in_db = True
        except Exception as e:
            logger.warning(f"auth: could not persist token, keeping it in memory: {e}")
    if not stored_in_db:
        await _memory.add_token(rec)
    auth_user = await _auth_user_for(user, store)
    _cache_put(h, auth_user, expires_at, touched=time.monotonic())
    try:
        now = utcnow()
        await store.update_user(user.id, last_login_at=now)
    except Exception as e:
        logger.debug(f"auth: last_login_at not recorded: {e}")
    return token, auth_user, expires_at


async def login(login: str, password: str, ip: str, label: str = "") -> tuple[str, AuthUser, object]:
    """Sign in by username or email. Returns (token, user, expires_at) or
    raises AuthError (or AuthUnavailable when the user store cannot answer).
    The error text never says which of login / password was wrong."""
    ip = ip or "-"
    key = str(login or "").strip().lower()
    if not (1 <= len(key) <= 254) or any(c.isspace() for c in key):
        key = ""
    if not key or not isinstance(password, str):
        _record_failure(key or "-", ip)
        logger.warning(f"auth: login failed (malformed) ip={ip}")
        raise AuthError("Invalid username or password")
    try:
        _reserve_attempt(key, ip)           # synchronous: no await before this
    except RateLimited as e:
        logger.warning(f"auth: login rate-limited login={key} ip={ip}: {e}")
        raise
    try:
        try:
            user = await _find_user(key)
        except Exception as e:
            logger.error(f"auth: user lookup failed, refusing sign-in: {e}")
            raise AuthUnavailable("Sign-in is temporarily unavailable. Try again shortly.")
        # Always run the hash, even for an unknown user, so the response
        # time does not say whether the account exists.
        stored = user.password_hash if user else _DUMMY_HASH
        ok = verify_password(password, stored) and user is not None and not user.disabled
    finally:
        _release_attempt(key)
    if not ok:
        # Already counted by the reservation.
        logger.warning(f"auth: login failed login={key} ip={ip}")
        raise AuthError("Invalid username or password")
    try:
        token, auth_user, expires_at = await _mint(user, label)
    except Exception as e:
        logger.error(f"auth: could not load memberships for {user.username}: {e}")
        raise AuthUnavailable("Sign-in is temporarily unavailable. Try again shortly.")
    _clear_failures(key, ip)
    logger.info(f"auth: login ok user={user.username} role={auth_user.role} ip={ip}")
    return token, auth_user, expires_at


async def logout(token: str | None) -> None:
    if not token:
        return
    h = hash_token(token)
    _cache_drop(h)
    if _db_up():
        try:
            await _db.delete_token(h)
        except Exception as e:
            logger.warning(f"auth: logout could not delete token row: {e}")
    await _memory.delete_token(h)


async def revoke_all(user_id: str, *, keep_hash: str | None = None) -> int:
    """Delete the user's tokens (all, or all but `keep_hash`) and drop live
    sockets. A kept token's socket reconnects and resumes on its own."""
    drop_cached_user(user_id)
    n = 0
    try:
        n = await _memory.delete_tokens_for_user(user_id, keep_hash=keep_hash)
        if _db_up():
            try:
                n += await _db.delete_tokens_for_user(user_id, keep_hash=keep_hash)
            except Exception as e:
                logger.warning(f"auth: revoke_all failed: {e}")
    finally:
        await _notify_revoked(user_id)
    return n


async def verify_token(token: str | None) -> AuthUser | None:
    """The user behind a bearer token, or None. Cache first, then the DB,
    then the memory store (env founder tokens, or tokens minted while the
    DB was down)."""
    if not token or not isinstance(token, str) or len(token) > 512:
        return None
    return await verify_token_hash(hash_token(token))


def _stale_cache(h: str) -> AuthUser | None:
    """A cache entry past its 60 s but before its token expiry: served only
    when the DB errors, so a blip does not log the operator out mid-flight.
    It holds what the DB itself said at most a few minutes ago."""
    entry = _token_cache.get(h)
    if entry is not None and (entry[2] is None or entry[2] > utcnow()):
        return entry[1]
    return None


async def verify_token_hash(h: str | None) -> AuthUser | None:
    """verify_token for callers that hold only the SHA-256 (live sockets):
    same cache, same stores, same answer."""
    if not h:
        return None
    cached = _cache_get(h)
    if cached is not None:
        await _maybe_touch(h)
        return cached

    rec: TokenRecord | None = None
    if _db_up():
        try:
            rec = await _db.get_token(h)
        except Exception as e:
            logger.warning(f"auth: token lookup failed: {e}")
            return _stale_cache(h)
    if rec is None:
        rec = await _memory.get_token(h)
    if rec is None:
        return None
    if rec.expires_at <= utcnow():
        await _memory.delete_token(h)
        if _db_up():
            try:
                await _db.delete_token(h)
            except Exception:
                pass
        return None
    try:
        user, store = await _find_user_by_id(rec.user_id)
        if user is None or user.disabled:
            _cache_drop(h)
            return None
        auth_user = await _auth_user_for(user, store)
    except Exception as e:
        logger.warning(f"auth: user lookup failed: {e}")
        return _stale_cache(h)
    _cache_put(h, auth_user, rec.expires_at)
    await _maybe_touch(h)
    return auth_user


async def _maybe_touch(h: str) -> None:
    entry = _token_cache.get(h)
    if entry is None:
        return
    now = time.monotonic()
    if now - entry[3] < TOUCH_INTERVAL_S:
        return
    expires_at = utcnow() + _ttl()
    _token_cache[h] = (entry[0], entry[1], expires_at, now)
    seen = utcnow()
    try:
        if _db_up():
            await _db.touch_token(h, expires_at, seen)
    except Exception as e:
        logger.debug(f"auth: touch failed: {e}")
    await _memory.touch_token(h, expires_at, seen)


# ── Account self-service ──────────────────────────────────────────────────

async def _user_stores(user_id: str) -> list:
    """Every store holding this user (the env founder is in both)."""
    out = []
    if _db_up() and await _db.get_user_by_id(user_id) is not None:
        out.append(_db)
    if await _memory.get_user_by_id(user_id) is not None:
        out.append(_memory)
    return out


async def update_profile(user_id: str, *, display_name: str | None = None,
                         email: str | None = None) -> UserRecord | None:
    fields: dict = {}
    if display_name is not None:
        fields["display_name"] = str(display_name).strip()[:120]
    if email is not None:
        fields["email"] = normalise_email(email)
    out = None
    for store in await _user_stores(user_id):
        out = (await store.update_user(user_id, **fields)) if fields else await store.get_user_by_id(user_id)
    drop_cached_user(user_id)
    return out


async def change_password(user: AuthUser, current_password: str, new_password: str,
                          ip: str, keep_hash: str | None) -> int:
    """Needs the current password (counted against the same per-account
    limit as sign-in, so a stolen token cannot brute-force it) and signs
    out every other device. Returns how many tokens were revoked."""
    ip = ip or "-"
    _reserve_attempt(user.username, ip)
    try:
        rec = await get_user(user.id)
        ok = rec is not None and verify_password(current_password or "", rec.password_hash)
    finally:
        _release_attempt(user.username)
    if not ok:
        logger.warning(f"auth: password change refused (wrong current) user={user.username} ip={ip}")
        raise AuthError("Current password is wrong")
    new_hash = hash_password(new_password)          # ValueError on a short one
    try:
        for store in await _user_stores(user.id):
            await store.update_user(user.id, password_hash=new_hash)
    finally:
        n = await revoke_all(user.id, keep_hash=keep_hash)
    _clear_failures(user.username, ip)
    logger.info(f"auth: password changed user={user.username} ip={ip}, {n} other session(s) ended")
    return n


async def list_sessions(user_id: str, current_hash: str | None) -> list[dict]:
    tokens = []
    if _db_up():
        tokens += await _db.list_tokens(user_id)
    tokens += await _memory.list_tokens(user_id)
    now = utcnow()
    return [{"id": t.id, "label": t.label, "created_at": t.created_at.isoformat(),
             "last_seen_at": t.last_seen_at.isoformat() if t.last_seen_at else None,
             "expires_at": t.expires_at.isoformat(), "current": t.token_hash == current_hash}
            for t in tokens if t.expires_at > now]


async def revoke_session(user_id: str, token_id: str) -> bool:
    h = None
    try:
        if _db_up():
            h = await _db.delete_token_by_id(user_id, token_id)
        h = (await _memory.delete_token_by_id(user_id, token_id)) or h
    finally:
        if h:
            _cache_drop(h)
            await _notify_revoked(user_id)
    return h is not None


# ── Password reset links ──────────────────────────────────────────────────

async def issue_reset(user_id: str, created_by: str | None) -> tuple[str, object]:
    """Founder-only (the route checks). One hour, single use, hash stored."""
    store = write_store()
    if await store.get_user_by_id(user_id) is None:
        raise LookupError("user not found")
    token = secrets.token_urlsafe(TOKEN_BYTES)
    expires_at = utcnow() + RESET_TTL
    await store.add_reset(ResetRecord(id=new_id(), user_id=user_id, token_hash=hash_token(token),
                                      expires_at=expires_at, created_by=created_by))
    return token, expires_at


async def use_reset(token: str, new_password: str, ip: str) -> str:
    """Set a new password from a reset link and sign the account out
    everywhere. Returns the user id. Raises RateLimited, AuthError (bad
    link) or ValueError (short password)."""
    ip_gate("reset", ip)
    new_hash = hash_password(new_password)
    store = write_store()
    user_id = None
    if isinstance(token, str) and 0 < len(token) <= 512:
        user_id = await store.consume_reset(hash_token(token), utcnow(), new_hash)
    if user_id is None:
        ip_fail("reset", ip)
        raise AuthError("This reset link is invalid, used or expired")
    if store is _db:
        # Keep the env founder's memory copy in step.
        await _memory.update_user(user_id, password_hash=new_hash)
    await revoke_all(user_id)
    logger.info(f"auth: password reset used for user {user_id} ip={ip}")
    return user_id


# ── Legacy shared token ───────────────────────────────────────────────────

_legacy_refused_logged = 0.0


def legacy_user_for(token: str | None) -> AuthUser | None:
    """The pseudo-user the old shared SECRET_TOKEN maps to, if that path is
    enabled and the token is both set and not the published default."""
    global _legacy_refused_logged
    if not token:
        return None
    settings = get_settings()
    expected = settings.secret_token or ""
    if not expected or not hmac.compare_digest(str(token), expected):
        return None
    # The token matched the configured secret. Now decide whether that is
    # allowed to mean anything.
    now = time.monotonic()
    if expected == DEFAULT_SECRET_TOKEN:
        if now - _legacy_refused_logged > 60:
            _legacy_refused_logged = now
            logger.error("auth: a client presented the DEFAULT secret token - refused. "
                         "Create a user (python -m app.auth.cli create-user) and sign in.")
        return None
    if not settings.legacy_token_enabled:
        if now - _legacy_refused_logged > 60:
            _legacy_refused_logged = now
            logger.warning("auth: legacy SECRET_TOKEN presented but AUTH_LEGACY_TOKEN_ENABLED "
                           "is off - refused.")
        return None
    # No memberships: the legacy token flies (compat operator) but owns no
    # workspace and can change no access.
    return AuthUser(id=LEGACY_USER_ID, username="legacy-token", role="operator")


async def authenticate(bearer: str | None, legacy: str | None = None) -> AuthUser | None:
    """One entry point for HTTP and sockets: a user bearer token first, then
    the legacy shared token (only if enabled)."""
    user = await verify_token(bearer)
    if user is not None:
        return user
    # Some clients only know how to send one credential; a bearer value
    # that happens to be the legacy secret is accepted on the same terms.
    return legacy_user_for(legacy) or legacy_user_for(bearer)


# ── Startup bootstrap ─────────────────────────────────────────────────────

_DUMMY_HASH = hash_password("dummy-password-for-timing-equalisation")


async def bootstrap() -> None:
    """Install the env founder (memory always, DB when up) and say loudly
    if nobody can log in."""
    settings = get_settings()
    username = (settings.hyrak_admin_user or "").strip().lower()
    pw_hash = (settings.hyrak_admin_password_hash or "").strip()
    env_admin = False
    if username or pw_hash:
        if not username or not looks_like_hash(pw_hash):
            logger.error("auth: HYRAK_ADMIN_USER / HYRAK_ADMIN_PASSWORD_HASH are incomplete or the "
                         "hash is not a scrypt string from `python -m app.auth.cli hash-password` - "
                         "env admin NOT installed.")
        else:
            rec = UserRecord(id=str(uuid.uuid4()), username=username, password_hash=pw_hash)
            # A founder who was disabled through the API stays disabled: the
            # env entry refreshes the password and the founder membership,
            # it is not a reset. (upsert_user never writes `disabled` for an
            # existing account; the copy below keeps memory in step.)
            try:
                existing = await _find_user(username)
            except Exception as e:
                logger.error(f"auth: could not look up env admin, not installing it: {e}")
                existing, rec = None, None
            if rec is not None:
                if existing is not None:
                    rec.id = existing.id
                    rec.disabled = existing.disabled
                    rec.email = existing.email
                    rec.display_name = existing.display_name
                    if existing.disabled:
                        logger.warning(f"auth: env admin '{username}' is disabled in the user store "
                                       "and stays disabled")
                try:
                    if _db_up():
                        rec = await _db.upsert_user(rec)
                        await set_platform_role(rec.id, perms.FOUNDER, store=_db)
                    # Same id in both stores so a token minted against one
                    # verifies against the other after a DB flap.
                    await _memory.upsert_user(rec)
                    await set_platform_role(rec.id, perms.FOUNDER, store=_memory)
                    env_admin = True
                    logger.info(f"auth: env founder '{username}' ready "
                                f"({'db' if _db_up() else 'memory only'})")
                except Exception as e:
                    logger.error(f"auth: could not install env admin in the DB: {e}")
                    await _memory.upsert_user(rec)
                    await set_platform_role(rec.id, perms.FOUNDER, store=_memory)
                    env_admin = True

    if settings.legacy_token_enabled:
        if settings.secret_token == DEFAULT_SECRET_TOKEN:
            logger.error("auth: AUTH_LEGACY_TOKEN_ENABLED is on but SECRET_TOKEN is still the "
                         "published default - the legacy path stays closed.")
        else:
            logger.warning("auth: legacy shared SECRET_TOKEN accepted as operator "
                           "(AUTH_LEGACY_TOKEN_ENABLED=true). Turn this off once scripts carry "
                           "user tokens.")

    if not env_admin:
        n = 0
        if _db_up():
            try:
                n = len(await _db.list_users())
            except Exception as e:
                logger.warning(f"auth: could not count users: {e}")
        if n == 0:
            if _db_up():
                logger.error("auth: NO USERS EXIST - nobody can log in. Run "
                             "`python -m app.auth.cli create-user <name> --founder` "
                             "or set HYRAK_ADMIN_USER + HYRAK_ADMIN_PASSWORD_HASH in .env.")
            else:
                logger.error("auth: DATABASE IS DOWN and no HYRAK_ADMIN_USER is set - nobody "
                             "can log in. Set HYRAK_ADMIN_USER + HYRAK_ADMIN_PASSWORD_HASH in "
                             ".env (python -m app.auth.cli hash-password) or bring Postgres up.")
