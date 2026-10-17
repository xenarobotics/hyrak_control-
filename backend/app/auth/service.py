"""
Login, tokens, roles - the one place that decides who a request is.

Model (docs/AUTH.md):
  * A user has a username, a scrypt password hash and a role:
    viewer < operator < admin. Roles are compared by rank.
  * Logging in mints a 32-byte urlsafe bearer token. Only its SHA-256 is
    stored; it expires 30 days after last use (sliding) and is cached here
    for 60 s so a database blip does not log everyone out mid-flight.
  * The database is optional (app/db/engine.py). The HYRAK_ADMIN_USER /
    HYRAK_ADMIN_PASSWORD_HASH bootstrap admin lives in a memory store as
    well as the DB, so an operator can still sign in with Postgres down.
  * The legacy shared SECRET_TOKEN is accepted only when
    AUTH_LEGACY_TOKEN_ENABLED=true AND it is not the published default -
    the default string shipped in the public JS bundle, so it is refused
    unconditionally.

Everything here is importable without a database and without the FastAPI
app; the HTTP dependency and the socket guard are thin wrappers in
deps.py / socket_guard.py.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import time
import uuid
from collections import deque
from dataclasses import dataclass
from datetime import timedelta

from app.auth.passwords import hash_password, looks_like_hash, verify_password
from app.auth.store import (
    ROLE_RANK, ROLES, DbStore, MemoryStore, TokenRecord, UserRecord, utcnow,
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
# How often a live socket's token is re-checked against the store.
SOCKET_REVALIDATE_S = TOKEN_CACHE_S
LEGACY_USER_ID = "legacy-token"


class AuthError(Exception):
    """Login refused. The message is deliberately generic."""


class RateLimited(AuthError):
    pass


@dataclass(frozen=True)
class AuthUser:
    id: str
    username: str
    role: str

    def has_role(self, min_role: str) -> bool:
        return ROLE_RANK.get(self.role, -1) >= ROLE_RANK[min_role]

    def public(self) -> dict:
        return {"id": self.id, "username": self.username, "role": self.role}


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def role_at_least(role: str, min_role: str) -> bool:
    return ROLE_RANK.get(role, -1) >= ROLE_RANK[min_role]


# ── Store selection ───────────────────────────────────────────────────────

_memory = MemoryStore()
_db = DbStore()


def _db_up() -> bool:
    try:
        from app.db import db_available
        return db_available()
    except Exception:
        return False


def memory_store() -> MemoryStore:
    """The in-memory backend. Tests monkeypatch service._db_up to False and
    populate this directly; production only ever holds the env admin here."""
    return _memory


def reset_for_tests() -> None:
    global _memory
    _memory = MemoryStore()
    _token_cache.clear()
    _failures.clear()
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
# revoked, role changed, disabled, deleted). server.py registers one that
# disconnects every live socket of that user, so a revocation takes effect
# on the next packet, not on the next page load.
_revocation_listeners: list = []


def on_user_revoked(callback) -> None:
    _revocation_listeners.append(callback)


async def _notify_revoked(user_id: str) -> None:
    for cb in list(_revocation_listeners):
        try:
            await cb(user_id)
        except Exception as e:
            logger.warning(f"auth: revocation listener failed: {e}")


# ── Login rate limit ──────────────────────────────────────────────────────

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


def _limited(username: str, ip: str) -> float | None:
    """None when the attempt may proceed, else the seconds to wait (0 means
    the per-IP hard lock, i.e. the rest of the window)."""
    now = time.monotonic()
    if len(_prune(f"ip:{ip}", now)) >= LOGIN_MAX_FAILURES:
        return 0.0
    wait = username_backoff_s(username, now)
    return wait if wait > 0 else None


def _record_failure(username: str, ip: str) -> None:
    now = time.monotonic()
    _prune(f"u:{username}", now).append(now)
    _prune(f"ip:{ip}", now).append(now)


def _clear_failures(username: str, ip: str) -> None:
    _failures.pop(f"u:{username}", None)
    _failures.pop(f"ip:{ip}", None)


# ── Users ─────────────────────────────────────────────────────────────────

async def _find_user(username: str) -> UserRecord | None:
    if _db_up():
        try:
            u = await _db.get_user_by_username(username)
            if u is not None:
                return u
        except Exception as e:
            logger.warning(f"auth: user lookup failed, using memory store: {e}")
    return await _memory.get_user_by_username(username)


async def _find_user_by_id(user_id: str) -> UserRecord | None:
    if _db_up():
        try:
            u = await _db.get_user_by_id(user_id)
            if u is not None:
                return u
        except Exception as e:
            logger.warning(f"auth: user lookup failed, using memory store: {e}")
    return await _memory.get_user_by_id(user_id)


def _normalise_username(username) -> str:
    u = str(username or "").strip().lower()
    if not (1 <= len(u) <= 64) or any(c.isspace() for c in u):
        raise ValueError("username must be 1-64 characters with no spaces")
    return u


async def create_user(username: str, password: str, role: str, *, memory_only: bool = False) -> UserRecord:
    """Create or replace a user. Requires the DB unless memory_only."""
    username = _normalise_username(username)
    if role not in ROLES:
        raise ValueError(f"role must be one of {', '.join(ROLES)}")
    rec = UserRecord(id=str(uuid.uuid4()), username=username, password_hash=hash_password(password), role=role)
    return await upsert_user_record(rec, memory_only=memory_only)


async def upsert_user_record(rec: UserRecord, *, memory_only: bool = False) -> UserRecord:
    if not memory_only:
        if not _db_up():
            raise RuntimeError("database offline")
        out = await _db.upsert_user(rec)
        drop_cached_user(out.id)
        return out
    return await _memory.upsert_user(rec)


async def list_users() -> list[dict]:
    users: dict[str, UserRecord] = {}
    for u in await _memory.list_users():
        users[u.username] = u
    if _db_up():
        for u in await _db.list_users():
            users[u.username] = u
    return [u.public() for u in sorted(users.values(), key=lambda u: (u.created_at, u.username))]


async def update_user(user_id: str, *, role: str | None = None, disabled: bool | None = None,
                      password: str | None = None) -> UserRecord | None:
    fields: dict = {}
    if role is not None:
        if role not in ROLES:
            raise ValueError(f"role must be one of {', '.join(ROLES)}")
        fields["role"] = role
    if disabled is not None:
        fields["disabled"] = bool(disabled)
    if password is not None:
        fields["password_hash"] = hash_password(password)
    if not fields:
        return await _find_user_by_id(user_id)
    # Both stores, always: the env admin lives in memory AND in the DB, and
    # a demotion or disable that only reached one of them would still let
    # the other answer with the old role after a DB flap.
    out = None
    if _db_up():
        out = await _db.update_user(user_id, **fields)
    mem = await _memory.update_user(user_id, **fields)
    out = out or mem
    if out is not None:
        drop_cached_user(user_id)
        if fields.get("disabled") or "password_hash" in fields:
            await revoke_all(user_id)
        else:
            # Role change: live sockets must pick the new role up now.
            await _notify_revoked(user_id)
    return out


async def delete_user(user_id: str) -> bool:
    ok = False
    if _db_up():
        ok = await _db.delete_user(user_id)
    ok = (await _memory.delete_user(user_id)) or ok
    drop_cached_user(user_id)
    if ok:
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


async def login(username: str, password: str, ip: str, label: str = "") -> tuple[str, AuthUser, object]:
    """Returns (token, user, expires_at) or raises AuthError. The error text
    never says which of username / password was wrong."""
    ip = ip or "-"
    try:
        username = _normalise_username(username)
    except ValueError:
        username = ""
    if not username or not isinstance(password, str):
        _record_failure(username or "-", ip)
        logger.warning(f"auth: login failed (malformed) ip={ip}")
        raise AuthError("Invalid username or password")
    wait = _limited(username, ip)
    if wait is not None:
        logger.warning(f"auth: login rate-limited user={username} ip={ip} wait={wait:.0f}s")
        if wait > 0:
            raise RateLimited(f"Too many attempts. Try again in {int(wait) + 1} seconds.")
        raise RateLimited("Too many attempts from this address. Try again in 15 minutes.")

    user = await _find_user(username)
    # Always run the hash, even for an unknown user, so the response time
    # does not say whether the username exists.
    stored = user.password_hash if user else _DUMMY_HASH
    ok = verify_password(password, stored) and user is not None and not user.disabled
    if not ok:
        _record_failure(username, ip)
        logger.warning(f"auth: login failed user={username} ip={ip}")
        raise AuthError("Invalid username or password")

    token = secrets.token_urlsafe(TOKEN_BYTES)
    h = hash_token(token)
    expires_at = utcnow() + _ttl()
    rec = TokenRecord(id=str(uuid.uuid4()), user_id=user.id, token_hash=h,
                      expires_at=expires_at, last_seen_at=utcnow(), label=label[:120])
    stored_in_db = False
    if _db_up():
        try:
            await _db.add_token(rec)
            stored_in_db = True
        except Exception as e:
            logger.warning(f"auth: could not persist token, keeping it in memory: {e}")
    if not stored_in_db:
        await _memory.add_token(rec)
    auth_user = AuthUser(id=user.id, username=user.username, role=user.role)
    _cache_put(h, auth_user, expires_at, touched=time.monotonic())
    _clear_failures(username, ip)
    logger.info(f"auth: login ok user={user.username} role={user.role} ip={ip}")
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


async def revoke_all(user_id: str) -> int:
    drop_cached_user(user_id)
    n = await _memory.delete_tokens_for_user(user_id)
    if _db_up():
        try:
            n += await _db.delete_tokens_for_user(user_id)
        except Exception as e:
            logger.warning(f"auth: revoke_all failed: {e}")
    await _notify_revoked(user_id)
    return n


async def verify_token(token: str | None) -> AuthUser | None:
    """The user behind a bearer token, or None. Cache first, then the DB,
    then the memory store (env admin tokens, or tokens minted while the DB
    was down)."""
    if not token or not isinstance(token, str) or len(token) > 512:
        return None
    return await verify_token_hash(hash_token(token))


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
            # DB blip: keep serving a stale cache entry rather than logging
            # the operator out mid-flight.
            entry = _token_cache.get(h)
            if entry is not None and (entry[2] is None or entry[2] > utcnow()):
                return entry[1]
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
    user = await _find_user_by_id(rec.user_id)
    if user is None or user.disabled:
        return None
    auth_user = AuthUser(id=user.id, username=user.username, role=user.role)
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
    """Install the env admin (memory always, DB when up) and say loudly if
    nobody can log in."""
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
            rec = UserRecord(id=str(uuid.uuid4()), username=username,
                             password_hash=pw_hash, role="admin")
            # An admin who was disabled through the API stays disabled: the
            # env entry refreshes the password and role, it is not a reset.
            existing = await _find_user(username)
            if existing is not None:
                rec.id = existing.id
                rec.disabled = existing.disabled
                if existing.disabled:
                    logger.warning(f"auth: env admin '{username}' is disabled in the user store "
                                   "and stays disabled")
            try:
                rec = await upsert_user_record(rec, memory_only=not _db_up())
                if _db_up():
                    # Same id in both stores so a token minted against one
                    # verifies against the other after a DB flap.
                    await _memory.upsert_user(rec)
                env_admin = True
                logger.info(f"auth: env admin '{username}' ready ({'db' if _db_up() else 'memory only'})")
            except Exception as e:
                logger.error(f"auth: could not install env admin: {e}")
                await _memory.upsert_user(rec)
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
                             "`python -m app.auth.cli create-user <name> --role admin` "
                             "or set HYRAK_ADMIN_USER + HYRAK_ADMIN_PASSWORD_HASH in .env.")
            else:
                logger.error("auth: DATABASE IS DOWN and no HYRAK_ADMIN_USER is set - nobody "
                             "can log in. Set HYRAK_ADMIN_USER + HYRAK_ADMIN_PASSWORD_HASH in "
                             ".env (python -m app.auth.cli hash-password) or bring Postgres up.")
