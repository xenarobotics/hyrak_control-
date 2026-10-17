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

    # Demotion: the next (stale) check refreshes the role and refuses.
    await service.update_user(rec.id, role="viewer")
    s.auth_checked_at = 0.0
    assert await socket_guard.require_operator("gina-sock", "drone_action") is False
    assert s.role == "viewer" and not disconnected

    # Revocation: the socket is dropped.
    await service.update_user(rec.id, role="operator")
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
    await service.update_user(rec.id, role="viewer")          # re-role
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
        async def delete_tokens_for_user(self, user_id): return 0
    monkeypatch.setattr(service, "_db_up", lambda: True)
    monkeypatch.setattr(service, "_db", FakeDb())
    await service.update_user(rec.id, role="viewer", disabled=True)
    assert calls == [{"role": "viewer", "disabled": True}]
    mem = await service.memory_store().get_user_by_id(rec.id)
    assert mem.role == "viewer" and mem.disabled is True


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
    assert clientip.client_ip_from("127.0.0.1", None, "198.51.100.4, 10.0.0.1") == "198.51.100.4"
    assert clientip.client_ip_from("10.8.0.17", "203.0.113.9", None) == "203.0.113.9"
    # An untrusted peer's headers are ignored.
    assert clientip.client_ip_from("192.168.1.50", "203.0.113.9", "1.2.3.4") == "192.168.1.50"
    assert clientip.client_ip_from(None, "203.0.113.9", None) == "-"
    monkeypatch.setattr(get_settings(), "trusted_proxies", "")
    assert clientip.client_ip_from("127.0.0.1", "203.0.113.9", None) == "127.0.0.1"
