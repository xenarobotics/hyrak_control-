"""
Per-user auth (app/auth): hashing, tokens, rate limit, role gating, the
legacy shared token, and session resume binding. Runs with no database -
service._db_up is forced False so every store call lands in MemoryStore.
"""
import time
from datetime import timedelta

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.auth import service
from app.auth.passwords import hash_password, verify_password
from app.auth.store import utcnow


@pytest.fixture(autouse=True)
def memory_auth(monkeypatch):
    monkeypatch.setattr(service, "_db_up", lambda: False)
    service.reset_for_tests()
    yield
    service.reset_for_tests()


async def _user(name, role="operator", password="correct-horse-battery"):
    return await service.create_user(name, password, role, memory_only=True)


# ── passwords ─────────────────────────────────────────────────────────────

def test_password_hash_round_trip():
    h = hash_password("correct-horse-battery")
    assert h.startswith("scrypt$") and h.count("$") == 2
    assert verify_password("correct-horse-battery", h)
    assert not verify_password("correct-horse-batterx", h)
    assert hash_password("correct-horse-battery") != h          # fresh salt each time


def test_password_hash_rejects_short_and_bad_stored():
    with pytest.raises(ValueError):
        hash_password("short")
    assert not verify_password("anything", "not-a-hash")
    assert not verify_password("anything", "scrypt$!!!$???")
    assert not verify_password("anything", None)


# ── tokens ────────────────────────────────────────────────────────────────

async def test_token_issue_verify_logout():
    await _user("alice")
    token, user, expires_at = await service.login("alice", "correct-horse-battery", "10.0.0.1")
    assert user.username == "alice" and user.role == "operator"
    assert expires_at > utcnow() + timedelta(days=29)
    assert (await service.verify_token(token)).id == user.id
    assert await service.verify_token("nope") is None
    assert await service.verify_token(None) is None
    await service.logout(token)
    assert await service.verify_token(token) is None


async def test_token_expiry_is_enforced():
    await _user("bob")
    token, _, _ = await service.login("bob", "correct-horse-battery", "10.0.0.1")
    h = service.hash_token(token)
    past = utcnow() - timedelta(seconds=1)
    await service.memory_store().touch_token(h, past, past)
    service._token_cache.clear()                                 # the DB (memory) copy is authoritative
    assert await service.verify_token(token) is None
    assert await service.memory_store().get_token(h) is None     # expired rows are dropped


async def test_token_sliding_expiry_touches_store():
    await _user("carol")
    token, _, first_exp = await service.login("carol", "correct-horse-battery", "10.0.0.1")
    h = service.hash_token(token)
    # Pretend the last write-back was long ago so the next verify slides it.
    cached_at, user, exp, _ = service._token_cache[h]
    service._token_cache[h] = (cached_at, user, exp, time.monotonic() - service.TOUCH_INTERVAL_S - 1)
    await service.verify_token(token)
    rec = await service.memory_store().get_token(h)
    assert rec.expires_at >= first_exp and rec.last_seen_at is not None


async def test_wrong_password_and_disabled_user_refused():
    rec = await _user("dave")
    with pytest.raises(service.AuthError):
        await service.login("dave", "wrong-password-here", "10.0.0.1")
    await service.update_user(rec.id, disabled=True)
    with pytest.raises(service.AuthError):
        await service.login("dave", "correct-horse-battery", "10.0.0.1")


# ── rate limiting ─────────────────────────────────────────────────────────

async def test_login_rate_limit_per_username():
    await _user("erin")
    for _ in range(service.LOGIN_MAX_FAILURES):
        with pytest.raises(service.AuthError):
            await service.login("erin", "wrong-password-here", "10.0.0.2")
    with pytest.raises(service.RateLimited):                     # even with the right password
        await service.login("erin", "correct-horse-battery", "10.0.0.3")


async def test_login_rate_limit_per_ip():
    await _user("frank")
    for i in range(service.LOGIN_MAX_FAILURES):
        with pytest.raises(service.AuthError):
            await service.login(f"ghost{i}", "whatever-password", "10.0.0.9")
    with pytest.raises(service.RateLimited):
        await service.login("frank", "correct-horse-battery", "10.0.0.9")
    # Another IP is unaffected.
    token, _, _ = await service.login("frank", "correct-horse-battery", "10.0.0.10")
    assert token


# ── HTTP role gating ──────────────────────────────────────────────────────

def _app():
    from app.auth.deps import require_admin, require_operator, require_viewer
    from app.auth.routes import router as auth_router
    app = FastAPI()
    app.include_router(auth_router)

    @app.get("/read")
    async def read(_u=Depends(require_viewer)):
        return {"ok": True}

    @app.post("/fly")
    async def fly(_u=Depends(require_operator)):
        return {"ok": True}

    @app.delete("/admin-only")
    async def admin_only(_u=Depends(require_admin)):
        return {"ok": True}

    return TestClient(app)


async def _bearer(name, role):
    await _user(name, role)
    token, _, _ = await service.login(name, "correct-horse-battery", "127.0.0.1")
    return {"Authorization": f"Bearer {token}"}


async def test_role_gating_on_routes():
    cl = _app()
    viewer = await _bearer("v", "viewer")
    operator = await _bearer("o", "operator")
    admin = await _bearer("a", "admin")
    assert cl.get("/read").status_code == 401
    assert cl.post("/fly", headers={"Authorization": "Bearer garbage"}).status_code == 401
    assert cl.get("/read", headers=viewer).status_code == 200
    assert cl.post("/fly", headers=viewer).status_code == 403
    assert cl.post("/fly", headers=operator).status_code == 200
    assert cl.delete("/admin-only", headers=operator).status_code == 403
    assert cl.delete("/admin-only", headers=admin).status_code == 200
    me = cl.get("/api/auth/me", headers=operator).json()["user"]
    assert me["username"] == "o" and me["role"] == "operator"


async def test_login_route_and_user_admin():
    cl = _app()
    await _user("root", "admin")
    r = cl.post("/api/auth/login", json={"username": "root", "password": "correct-horse-battery"})
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["role"] == "admin" and body["token"] and body["expires_at"]
    hdr = {"Authorization": f"Bearer {body['token']}"}
    bad = cl.post("/api/auth/login", json={"username": "root", "password": "wrong-password-here"})
    assert bad.status_code == 401 and "Invalid username or password" in bad.json()["detail"]
    # Users list needs admin; creating one needs the DB (memory-only here -> 503).
    assert cl.get("/api/auth/users", headers=hdr).status_code == 200
    r = cl.post("/api/auth/users", headers=hdr,
                json={"username": "newbie", "password": "another-password", "role": "viewer"})
    assert r.status_code == 503
    assert cl.post("/api/auth/logout", headers=hdr).status_code == 200
    assert cl.get("/api/auth/me", headers=hdr).status_code == 401


# ── legacy shared token ───────────────────────────────────────────────────

async def test_legacy_token_refused_by_default(monkeypatch):
    from app.config import get_settings
    settings = get_settings()
    cl = _app()
    # The published default never works, whatever the flag says.
    monkeypatch.setattr(settings, "secret_token", service.DEFAULT_SECRET_TOKEN)
    monkeypatch.setattr(settings, "legacy_token_enabled", True)
    assert cl.post("/fly", headers={"X-Auth-Token": service.DEFAULT_SECRET_TOKEN}).status_code == 401
    # A real secret, flag off (the default): refused.
    monkeypatch.setattr(settings, "secret_token", "a-real-random-secret-value")
    monkeypatch.setattr(settings, "legacy_token_enabled", False)
    assert cl.post("/fly", headers={"X-Auth-Token": "a-real-random-secret-value"}).status_code == 401
    assert await service.authenticate("a-real-random-secret-value") is None
    # Flag on + real secret: an operator, never an admin.
    monkeypatch.setattr(settings, "legacy_token_enabled", True)
    assert cl.post("/fly", headers={"X-Auth-Token": "a-real-random-secret-value"}).status_code == 200
    assert cl.delete("/admin-only", headers={"X-Auth-Token": "a-real-random-secret-value"}).status_code == 403
    legacy = await service.authenticate("a-real-random-secret-value")
    assert legacy is not None and legacy.role == "operator"


# ── session resume binding ────────────────────────────────────────────────

def test_resume_bound_to_user_and_secret():
    from app.sessions.manager import SessionManager
    sm = SessionManager()
    s = sm.create(socket_id="sock-1")
    s.user_id, s.username, s.role = "u1", "alice", "operator"
    s.resume_secret = "per-session-secret"
    assert sm.resumable(s.session_id, "u1", "per-session-secret") is s
    assert sm.resumable(s.session_id, "u2", "per-session-secret") is None     # other user
    assert sm.resumable(s.session_id, "u1", "guessed") is None                # wrong secret
    assert sm.resumable(s.session_id, "u1", None) is None                     # no secret at all
    assert sm.resumable("no-such-session", "u1", "per-session-secret") is None
    # B8: resumable whether or not the old socket has been noticed as gone.
    assert s.detached_at is None
    assert sm.resumable(s.session_id, "u1", "per-session-secret") is s


# ── socket guard ──────────────────────────────────────────────────────────

async def test_socket_guard_blocks_viewers_and_audits_operators(caplog):
    from app.auth import socket_guard
    from app.sessions.manager import SessionManager

    emitted = []

    class FakeSio:
        async def emit(self, event, payload, to=None):
            emitted.append((event, payload, to))

    sm = SessionManager()
    socket_guard.configure(FakeSio(), sm)
    v = sm.create(socket_id="viewer-sock"); v.username, v.role = "vic", "viewer"
    o = sm.create(socket_id="op-sock"); o.username, o.role = "olga", "operator"

    assert await socket_guard.require_operator("viewer-sock", "drone_action", {"drone_id": 3}) is False
    assert emitted and emitted[-1][0] == "error" and emitted[-1][2] == "viewer-sock"
    assert await socket_guard.require_operator("unknown-sock", "drone_action") is False

    with caplog.at_level("INFO", logger="hyrak.audit"):
        assert await socket_guard.require_operator("op-sock", "drone_action", {"drone_id": 3}) is True
    line = [r.getMessage() for r in caplog.records if r.name == "hyrak.audit"][-1]
    assert line == f"audit user=olga role=operator session={o.session_id[:8]} event=drone_action drone=3"
    assert await socket_guard.require_admin("op-sock", "admin_hello") is False


# ── revocation reaches live sockets ──────────────────────────────────────

async def test_socket_guard_revalidates_and_disconnects_revoked_tokens():
    from app.auth import socket_guard
    from app.sessions.manager import SessionManager

    disconnected = []

    class FakeSio:
        async def emit(self, *a, **k): pass
        async def disconnect(self, sid): disconnected.append(sid)

    sm = SessionManager()
    socket_guard.configure(FakeSio(), sm)
    rec = await _user("gina", "operator")
    token, user, _ = await service.login("gina", "correct-horse-battery", "127.0.0.1")
    s = sm.create(socket_id="gina-sock")
    s.user_id, s.username, s.role = user.id, "gina", "operator"
    s.token_hash = service.hash_token(token)
    s.auth_checked_at = 0.0                                   # force a re-check
    assert await socket_guard.require_operator("gina-sock", "drone_action") is True
    assert s.auth_checked_at > 0

    # Demotion (HYRAK pilot -> HYRAK viewer membership): the next (stale)
    # check refreshes the compatibility role and refuses.
    await service.set_platform_role(rec.id, "viewer", store=service.memory_store())
    await service.membership_changed(rec.id, before_compat="operator", reduced=True)
    s.auth_checked_at = 0.0
    assert await socket_guard.require_operator("gina-sock", "drone_action") is False
    assert s.role == "viewer" and not disconnected

    # Revocation: the socket is dropped.
    await service.set_platform_role(rec.id, "pilot", store=service.memory_store())
    await service.membership_changed(rec.id, before_compat="viewer", reduced=False)
    s.auth_checked_at = 0.0
    assert await socket_guard.require_operator("gina-sock", "drone_action") is True
    await service.revoke_all(rec.id)
    s.auth_checked_at = 0.0
    assert await socket_guard.require_operator("gina-sock", "drone_action") is False
    assert disconnected == ["gina-sock"] and s.role is None


async def test_revocation_listener_fires_on_every_access_change():
    seen = []

    async def listener(user_id): seen.append(user_id)
    service.on_user_revoked(listener)
    rec = await _user("hank", "operator")
    await service.set_platform_role(rec.id, "viewer", store=service.memory_store())
    await service.membership_changed(rec.id, before_compat="operator", reduced=True)   # re-role
    await service.update_user(rec.id, disabled=True)          # disable -> revoke_all
    await service.update_user(rec.id, password="another-password-1")
    await service.delete_user(rec.id)
    assert seen.count(rec.id) >= 4


async def test_update_user_reaches_memory_store_when_db_also_answers(monkeypatch):
    """Finding 4: a user present in both stores must change in both."""
    rec = await _user("iris", "operator")
    calls = []

    class FakeDb:
        async def update_user(self, user_id, **fields):
            calls.append(fields)
            return rec                                        # DB "succeeds"
        async def delete_tokens_for_user(self, user_id, keep_hash=None): return 0
    monkeypatch.setattr(service, "_db_up", lambda: True)
    monkeypatch.setattr(service, "_db", FakeDb())
    await service.update_user(rec.id, display_name="Iris", disabled=True)
    assert calls == [{"display_name": "Iris", "disabled": True}]
    mem = await service.memory_store().get_user_by_id(rec.id)
    assert mem.display_name == "Iris" and mem.disabled is True


async def test_update_user_refuses_role():
    """The role column is gone; a role in update_user is an error, not a no-op."""
    rec = await _user("ivan", "operator")
    with pytest.raises(ValueError, match="memberships"):
        await service.update_user(rec.id, role="admin")
    with pytest.raises(ValueError):
        await service.update_user(rec.id, role="viewer", disabled=True)
    assert (await service.memory_store().get_user_by_id(rec.id)).disabled is False


async def test_patch_user_route_refuses_role():
    cl = _app()
    founder = await _bearer("boss", "admin")
    target = await _user("pat", "operator")
    r = cl.patch(f"/api/auth/users/{target.id}", headers=founder, json={"role": "admin"})
    assert r.status_code == 400 and "membership" in r.json()["detail"]


async def test_disable_revokes_even_when_a_later_step_raises(monkeypatch):
    """Coordinator point 4: the DB commit of a disable / password change is
    followed by revocation in a finally, so an exception afterwards (here:
    the memory store write) cannot leave tokens and sockets alive."""
    seen = []

    async def listener(user_id): seen.append(user_id)
    service.on_user_revoked(listener)
    rec = await _user("jack", "operator")
    token, _, _ = await service.login("jack", "correct-horse-battery", "127.0.0.1")
    committed = []

    class FakeDb:
        async def update_user(self, user_id, **fields):
            committed.append(fields)
            return rec
        async def delete_tokens_for_user(self, user_id, keep_hash=None): return 0

    async def boom(*a, **k):
        raise RuntimeError("memory store write failed after the DB commit")
    monkeypatch.setattr(service, "_db_up", lambda: True)
    monkeypatch.setattr(service, "_db", FakeDb())
    monkeypatch.setattr(service.memory_store(), "update_user", boom)
    with pytest.raises(RuntimeError):
        await service.update_user(rec.id, disabled=True)
    assert committed == [{"disabled": True}]
    assert seen == [rec.id]                                   # sockets told
    assert await service.memory_store().get_token(service.hash_token(token)) is None
    monkeypatch.setattr(service, "_db_up", lambda: False)
    assert await service.verify_token(token) is None

    # Same for a password change.
    rec2 = await _user("jill", "operator")
    token2, _, _ = await service.login("jill", "correct-horse-battery", "127.0.0.1")
    monkeypatch.setattr(service, "_db_up", lambda: True)
    with pytest.raises(RuntimeError):
        await service.update_user(rec2.id, password="a-brand-new-password")
    monkeypatch.setattr(service, "_db_up", lambda: False)
    assert await service.verify_token(token2) is None


async def test_user_lookup_fails_closed_when_db_errors(monkeypatch):
    """Coordinator point 2: with the DB up, a query error must not fall back
    to the memory store's (possibly stale, e.g. not-yet-disabled) copy."""
    await _user("kate", "admin")                              # exists in memory as a founder

    class BrokenDb:
        async def get_user_by_username(self, username): raise ConnectionError("db went away")
        async def get_user_by_email(self, email): raise ConnectionError("db went away")
        async def get_user_by_id(self, user_id): raise ConnectionError("db went away")
        async def get_token(self, h): raise ConnectionError("db went away")
    monkeypatch.setattr(service, "_db_up", lambda: True)
    monkeypatch.setattr(service, "_db", BrokenDb())
    with pytest.raises(service.AuthUnavailable):
        await service.login("kate", "correct-horse-battery", "127.0.0.1")
    with pytest.raises(ConnectionError):
        await service._find_user("kate")
    # The HTTP route answers 503, never a token.
    cl = _app()
    r = cl.post("/api/auth/login", json={"login": "kate", "password": "correct-horse-battery"})
    assert r.status_code == 503 and "token" not in r.json()


async def test_token_verify_fails_closed_on_user_lookup_error(monkeypatch):
    """A token whose user cannot be read is refused, except for a still
    fresh-ish cache entry (which holds what the store said moments ago)."""
    await _user("lena", "operator")
    token, _, _ = await service.login("lena", "correct-horse-battery", "127.0.0.1")
    h = service.hash_token(token)
    service._token_cache.clear()

    class HalfBrokenDb:
        async def get_token(self, th): return await service.memory_store().get_token(th)
        async def get_user_by_id(self, user_id): raise ConnectionError("db went away")
    monkeypatch.setattr(service, "_db_up", lambda: True)
    monkeypatch.setattr(service, "_db", HalfBrokenDb())
    assert await service.verify_token(token) is None          # no cache: closed
    assert h not in service._token_cache


async def test_upsert_never_reenables_a_disabled_account():
    """Coordinator point 3: re-running create-user replaces the password but
    leaves `disabled` alone."""
    rec = await _user("mike", "operator")
    await service.update_user(rec.id, disabled=True)
    again = await service.create_user("mike", "a-fresh-password-1", "operator", memory_only=True)
    assert again.id == rec.id and again.disabled is True
    with pytest.raises(service.AuthError):
        await service.login("mike", "a-fresh-password-1", "127.0.0.1")
    # The store contract itself: disabled is written only when asked.
    from app.auth.store import UserRecord
    mem = service.memory_store()
    out = await mem.upsert_user(UserRecord(id="x", username="mike", password_hash="h", disabled=False))
    assert out.disabled is True
    out = await mem.upsert_user(UserRecord(id="x", username="mike", password_hash="h", disabled=False),
                                set_disabled=True)
    assert out.disabled is False


async def test_bootstrap_keeps_disabled_env_admin_disabled(monkeypatch):
    from app.config import get_settings
    settings = get_settings()
    rec = await _user("root", "admin", password="correct-horse-battery")
    await service.update_user(rec.id, disabled=True)
    monkeypatch.setattr(settings, "hyrak_admin_user", "root")
    monkeypatch.setattr(settings, "hyrak_admin_password_hash", hash_password("new-env-password"))
    await service.bootstrap()
    after = await service.memory_store().get_user_by_username("root")
    assert after.id == rec.id and after.disabled is True
    with pytest.raises(service.AuthError):
        await service.login("root", "new-env-password", "127.0.0.1")


# ── username backoff, trusted proxies ─────────────────────────────────────

async def test_username_backoff_grows_and_does_not_hard_lock(monkeypatch):
    await _user("jo")
    for i in range(service.LOGIN_MAX_FAILURES):
        with pytest.raises(service.AuthError):
            await service.login("jo", "wrong-password-here", f"10.1.0.{i}")
    wait = service.username_backoff_s("jo")
    assert 0 < wait <= service.USERNAME_BACKOFF_BASE_S
    with pytest.raises(service.RateLimited) as e:
        await service.login("jo", "correct-horse-battery", "10.1.0.99")
    assert "seconds" in str(e.value)
    # Once the delay has elapsed the real operator gets in; a success resets.
    clock = {"t": time.monotonic() + service.USERNAME_BACKOFF_MAX_S}
    monkeypatch.setattr(service.time, "monotonic", lambda: clock["t"])
    token, _, _ = await service.login("jo", "correct-horse-battery", "10.1.0.99")
    assert token and service.username_backoff_s("jo") == 0.0


def test_client_ip_honours_proxy_headers_only_from_trusted_peers(monkeypatch):
    from app.auth import clientip
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "trusted_proxies", "127.0.0.1,::1,10.8.0.0/24")
    assert clientip.client_ip_from("127.0.0.1", "203.0.113.9", None) == "203.0.113.9"
    # XFF is read from the right: trusted hops are skipped, the first
    # untrusted address is the client; a spoofed leftmost entry is ignored.
    assert clientip.client_ip_from("127.0.0.1", None, "198.51.100.4, 10.8.0.5") == "198.51.100.4"
    assert clientip.client_ip_from("127.0.0.1", None, "6.6.6.6, 203.0.113.7") == "203.0.113.7"
    assert clientip.client_ip_from("127.0.0.1", None, "6.6.6.6, 203.0.113.7, 10.8.0.5") == "203.0.113.7"
    assert clientip.client_ip_from("127.0.0.1", None, "garbage, 10.8.0.5") == "127.0.0.1"
    assert clientip.client_ip_from("127.0.0.1", None, "10.8.0.5, ::1") == "127.0.0.1"
    assert clientip.client_ip_from("10.8.0.17", "203.0.113.9", None) == "203.0.113.9"
    # An untrusted peer's headers are ignored.
    assert clientip.client_ip_from("192.168.1.50", "203.0.113.9", "1.2.3.4") == "192.168.1.50"
    assert clientip.client_ip_from(None, "203.0.113.9", None) == "-"
    monkeypatch.setattr(get_settings(), "trusted_proxies", "")
    assert clientip.client_ip_from("127.0.0.1", "203.0.113.9", None) == "127.0.0.1"


async def test_concurrent_bad_logins_cannot_bypass_the_limit(monkeypatch):
    """All checks used to pass before any failure was recorded, because the
    user lookup awaits. The reservation is now taken before the first await."""
    import asyncio
    await _user("kim")
    real_find = service._find_user

    async def slow_find(username):
        await asyncio.sleep(0.02)                             # a real suspension point
        return await real_find(username)
    monkeypatch.setattr(service, "_find_user", slow_find)

    async def attempt(i):
        try:
            await service.login("kim", "wrong-password-here", f"10.2.0.{i}")
        except service.RateLimited:
            return "limited"
        except service.AuthError:
            return "checked"
        return "ok"

    results = await asyncio.gather(*(attempt(i) for i in range(20)))
    assert results.count("checked") == service.LOGIN_MAX_FAILURES
    assert results.count("limited") == 20 - service.LOGIN_MAX_FAILURES
    assert not service._inflight                              # every reservation released


async def test_backoff_allows_one_in_flight_attempt_and_hard_cap(monkeypatch):
    import asyncio
    await _user("lee")
    clock = {"t": 1000.0}
    monkeypatch.setattr(service.time, "monotonic", lambda: clock["t"])
    for i in range(service.LOGIN_MAX_FAILURES):
        with pytest.raises(service.AuthError):
            await service.login("lee", "wrong-password-here", f"10.3.0.{i}")
    clock["t"] += service.USERNAME_BACKOFF_MAX_S                # delay elapsed

    gate = asyncio.Event()
    real_find = service._find_user

    async def held_find(username):
        await gate.wait()
        return await real_find(username)
    monkeypatch.setattr(service, "_find_user", held_find)
    first = asyncio.create_task(service.login("lee", "wrong-password-here", "10.3.1.1"))
    await asyncio.sleep(0)
    with pytest.raises(service.RateLimited, match="in progress"):
        await service.login("lee", "correct-horse-battery", "10.3.1.2")
    gate.set()
    with pytest.raises(service.AuthError):
        await first
    monkeypatch.setattr(service, "_find_user", real_find)

    # Hard cap: guesses that each wait out the backoff still stop at the
    # cap. (At the real cap of 20 the backoff alone outlasts the window, so
    # use a small cap to reach it inside one window.)
    monkeypatch.setattr(service, "USERNAME_HARD_CAP", service.LOGIN_MAX_FAILURES + 3)
    n = service.LOGIN_MAX_FAILURES + 1
    while n < service.USERNAME_HARD_CAP:
        clock["t"] += service.username_backoff_s("lee") + 0.01
        with pytest.raises(service.AuthError):
            await service.login("lee", "wrong-password-here", f"10.4.0.{n}")
        n += 1
    clock["t"] += service.username_backoff_s("lee") + 0.01
    with pytest.raises(service.RateLimited, match="this account"):
        await service.login("lee", "correct-horse-battery", "10.4.1.1")


# ── changes made by another process (the CLI) ────────────────────────────

async def test_out_of_process_membership_change_applies_within_cache_window(monkeypatch):
    """The CLI runs in its own process and cannot drop this process's token
    cache or reach its sockets. Simulated here by writing the store directly
    (no membership_changed / revocation in this process): the server must
    pick the change up once the cached entry is older than TOKEN_CACHE_S,
    both for HTTP (verify_token reloads memberships) and for a live socket
    (revalidate refreshes the compat role, and disconnects once the token
    is gone)."""
    from app.auth import socket_guard
    from app.sessions.manager import SessionManager

    disconnected = []

    class FakeSio:
        async def emit(self, *a, **k): pass
        async def disconnect(self, sid): disconnected.append(sid)

    clock = {"t": 5000.0}
    monkeypatch.setattr(service.time, "monotonic", lambda: clock["t"])
    rec = await _user("cleo", "operator")
    token, user, _ = await service.login("cleo", "correct-horse-battery", "127.0.0.1")
    sm = SessionManager()
    socket_guard.configure(FakeSio(), sm)
    s = sm.create(socket_id="cleo-sock")
    s.user_id, s.username, s.role = user.id, "cleo", "operator"
    s.token_hash = service.hash_token(token)
    s.auth_checked_at = clock["t"]

    mem = service.memory_store()
    pilot = (await mem.memberships_for_user(rec.id))[0]
    await mem.update_membership(pilot.id, role="viewer")       # "the CLI" demotes

    # Inside the window the cached answer stands ...
    clock["t"] += service.TOKEN_CACHE_S - 1
    assert (await service.verify_token(token)).role == "operator"
    assert await socket_guard.require_operator("cleo-sock", "drone_action") is True
    # ... and once it is older than TOKEN_CACHE_S both paths see the change.
    clock["t"] += 2
    assert (await service.verify_token(token)).role == "viewer"
    clock["t"] += service.SOCKET_REVALIDATE_S + 1
    assert await socket_guard.require_operator("cleo-sock", "drone_action") is False
    assert s.role == "viewer" and not disconnected

    # Re-running create-user (a new password) revokes the tokens; another
    # process's revocation reaches this one's socket on the next stale check.
    await mem.update_membership(pilot.id, role="pilot")
    await mem.delete_tokens_for_user(rec.id)                   # what the CLI's revoke_all does in the DB
    clock["t"] += service.TOKEN_CACHE_S + 1
    assert await service.verify_token(token) is None
    assert await socket_guard.require_operator("cleo-sock", "drone_action") is False
    assert disconnected == ["cleo-sock"]


async def test_create_user_rerun_signs_out_existing_sessions():
    await _user("dina", "operator")
    token, _, _ = await service.login("dina", "correct-horse-battery", "127.0.0.1")
    await service.create_user("dina", "a-replaced-password", "operator", memory_only=True)
    assert await service.verify_token(token) is None


# ── rate limit keyed on the account, not the login string ────────────────

async def test_alternating_username_and_email_shares_one_budget():
    await service.create_user("eli", "correct-horse-battery", "operator", memory_only=True,
                              email="eli@example.com", email_verified=True)
    for i in range(service.LOGIN_MAX_FAILURES):
        with pytest.raises(service.AuthError):
            await service.login("eli", "wrong-password-here", f"10.9.0.{i}")
    # The email is a fresh login string, but the same account: in backoff,
    # refused even with the right password.
    with pytest.raises(service.RateLimited):
        await service.login("eli@example.com", "correct-horse-battery", "10.9.1.1")
    for i in range(service.LOGIN_MAX_FAILURES):
        with pytest.raises(service.RateLimited):
            await service.login("eli@example.com", "wrong-password-here", f"10.9.2.{i}")


async def test_mixed_username_and_email_failures_reach_backoff(monkeypatch):
    """5 failures by username and 5 by email on one account: the account is
    in backoff (and well before the 10th)."""
    clock = {"t": 9000.0}
    monkeypatch.setattr(service.time, "monotonic", lambda: clock["t"])
    await service.create_user("fay", "correct-horse-battery", "operator", memory_only=True,
                              email="fay@example.com", email_verified=True)
    outcomes = []
    for i in range(service.LOGIN_MAX_FAILURES):
        for login in ("fay", "fay@example.com"):
            try:
                await service.login(login, "wrong-password-here", f"10.8.{len(outcomes)}.1")
            except service.RateLimited:
                outcomes.append("limited")
            except service.AuthError:
                outcomes.append("checked")
    assert outcomes.count("checked") == service.LOGIN_MAX_FAILURES
    assert outcomes[service.LOGIN_MAX_FAILURES:] == ["limited"] * service.LOGIN_MAX_FAILURES
    assert service.username_backoff_s(service.account_key((await service.memory_store()
                                                          .get_user_by_username("fay")).id)) > 0
    # After the delay the right password works and clears both keys.
    clock["t"] += service.USERNAME_BACKOFF_MAX_S
    token, user, _ = await service.login("fay@example.com", "correct-horse-battery", "10.8.99.1")
    assert token and service.username_backoff_s(service.account_key(user.id)) == 0.0
    assert service.username_backoff_s("fay@example.com") == 0.0


async def test_password_change_shares_the_account_budget():
    await _user("gus", "operator")
    token, user, _ = await service.login("gus", "correct-horse-battery", "127.0.0.1")
    for i in range(service.LOGIN_MAX_FAILURES):
        with pytest.raises(service.AuthError):
            await service.login("gus", "wrong-password-here", f"10.7.0.{i}")
    with pytest.raises(service.RateLimited):
        await service.change_password(user, "correct-horse-battery", "a-new-password-1",
                                      "10.7.1.1", keep_hash=None)
