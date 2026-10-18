"""
URL tickets (app/auth/url_tickets.py, docs/AUTH.md "URL tickets"): the
60 s, path-bound credential an <img> uses for the recon MJPEG streams.

The real app for the issue endpoint and the recon stream route; a tiny
FastAPI app with one opted-in route that echoes the caller, for "whose
access does a ticket carry".
"""
import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.auth import service, url_tickets
from app.auth.url_tickets import require_user_or_ticket

PW = "correct-horse-battery"
DEPTH = "/api/recon/stream/depth"
VIDEO = "/api/recon/stream/video"


@pytest.fixture
def cl(monkeypatch):
    from app.reconstruction import service as recon
    from app.server import create_app
    monkeypatch.setattr(service, "_db_up", lambda: False)
    # Port 9 (discard) refuses: the stream proxy ends at once, empty.
    monkeypatch.setattr(recon, "BASE", "http://127.0.0.1:9")
    service.reset_for_tests()
    service.allow_memory_writes(True)
    url_tickets.reset_for_tests()
    yield TestClient(create_app().other_asgi_app)
    url_tickets.reset_for_tests()
    service.reset_for_tests()


async def account(name, role=None):
    rec = await service.create_user(name, PW, role, memory_only=True,
                                    email=f"{name}@example.com", email_verified=True)
    token, _, _ = await service.login(name, PW, "127.0.0.1")
    return rec, token


def hdr(token):
    return {"Authorization": f"Bearer {token}"}


def ticket_for(cl, token, path, code=200):
    r = cl.post("/api/auth/url-ticket", headers=hdr(token), json={"path": path})
    assert r.status_code == code, (r.status_code, r.text)
    return r.json().get("ticket")


async def test_ticket_opens_its_own_stream_only(cl):
    _, t = await account("hv", "viewer")
    r = cl.post("/api/auth/url-ticket", headers=hdr(t), json={"path": DEPTH})
    body = r.json()
    assert r.status_code == 200 and len(body["ticket"]) >= 43 and body["expires_at"] > 0
    tk = body["ticket"]
    assert cl.get(DEPTH).status_code == 401
    assert cl.get(f"{DEPTH}?ticket={tk}").status_code == 200
    assert cl.get(f"{DEPTH}?ticket={tk}").status_code == 200          # reusable in its window
    assert cl.get(f"{VIDEO}?ticket={tk}").status_code == 401           # path A is not path B
    assert cl.get(f"{DEPTH}?ticket=not-a-ticket").status_code == 401


async def test_expired_ticket_is_refused(cl, monkeypatch):
    _, t = await account("hv", "viewer")
    tk = ticket_for(cl, t, DEPTH)
    now = url_tickets._now()
    monkeypatch.setattr(url_tickets, "_now", lambda: now + url_tickets.TICKET_TTL_S + 1)
    assert cl.get(f"{DEPTH}?ticket={tk}").status_code == 401


async def test_revoked_user_and_logged_out_token_kill_the_ticket(cl):
    f, ft = await account("founder", "admin")
    hv, t = await account("hv", "viewer")
    tk = ticket_for(cl, t, DEPTH)
    assert cl.patch(f"/api/auth/users/{hv.id}", headers=hdr(ft), json={"disabled": True}).status_code == 200
    assert cl.get(f"{DEPTH}?ticket={tk}").status_code == 401
    # A logout ends the tickets minted from that token too.
    tk2 = ticket_for(cl, ft, DEPTH)
    assert cl.get(f"{DEPTH}?ticket={tk2}").status_code == 200
    cl.post("/api/auth/logout", headers=hdr(ft))
    assert cl.get(f"{DEPTH}?ticket={tk2}").status_code == 401


async def test_issue_needs_an_opted_in_get_the_caller_may_read(cl):
    _, t = await account("hv", "viewer")
    _, ct = await account("cust")                        # customer-only: member rank
    assert ticket_for(cl, ct, DEPTH, 403) is None         # recon is staff only
    assert ticket_for(cl, t, "/api/recon/engine", 404) is None
    assert ticket_for(cl, t, "/api/fleet", 404) is None
    assert ticket_for(cl, t, "/api/recon/session/stop", 404) is None   # POST only
    for bad in (f"{DEPTH}?x=1", "/releases/x", "//api/recon/stream/depth",
                "/api/recon/../recon/stream/depth"):
        assert ticket_for(cl, t, bad, 400) is None, bad
    assert cl.post("/api/auth/url-ticket", json={"path": DEPTH}).status_code == 401


async def test_routes_that_did_not_opt_in_ignore_tickets(cl):
    _, t = await account("hv", "viewer")
    tk = ticket_for(cl, t, DEPTH)
    for path in ("/api/recon/engine", "/api/fleet", "/api/vision/plate-history", "/api/zones"):
        assert cl.get(f"{path}?ticket={tk}").status_code == 401, path
    # Not even a ticket minted for that very path would be honoured there:
    # url-ticket refuses to issue one (404 above), and a forged entry is
    # still ignored by require_user.
    url_tickets._tickets[url_tickets._hash("forged")] = url_tickets.Ticket(
        user_id="x", token_hash=service.hash_token(t), path="/api/fleet",
        expires=url_tickets._now() + 60)
    assert cl.get("/api/fleet?ticket=forged").status_code == 401


async def test_a_ticket_carries_its_owners_access_not_the_presenters(cl, monkeypatch):
    monkeypatch.setattr(url_tickets, "_routes", list(url_tickets._routes))
    app = FastAPI()
    dep = require_user_or_ticket("viewer", "/api/echo")

    @app.get("/api/echo")
    async def echo(user=Depends(dep)):
        return {"user": user.username}

    @app.post("/api/echo")
    async def echo_post(user=Depends(dep)):
        return {"user": user.username}

    @app.get("/api/other")
    async def other(user=Depends(dep)):          # misuse: template is /api/echo
        return {"user": user.username}

    c = TestClient(app)
    assert url_tickets.ticket_role_for("/api/echo") == "viewer"
    hv, t = await account("hv", "viewer")
    _, ct = await account("cust")
    tk, _ = url_tickets.issue(hv.id, service.hash_token(t), "/api/echo")
    # Alone, the ticket is hv's access.
    assert c.get(f"/api/echo?ticket={tk}").json() == {"user": "hv"}
    # A presenter's own header wins: the customer gets the customer's
    # answer (403), not hv's.
    assert c.get(f"/api/echo?ticket={tk}", headers=hdr(ct)).status_code == 403
    # Never on a mutating method.
    assert c.post(f"/api/echo?ticket={tk}").status_code == 401
    # Nor on a path the dependency was not built for.
    tk_other, _ = url_tickets.issue(hv.id, service.hash_token(t), "/api/other")
    assert c.get(f"/api/other?ticket={tk_other}").status_code == 401
    # A ticket whose recorded user does not match the token's user is void.
    bad, _ = url_tickets.issue("someone-else", service.hash_token(t), "/api/echo")
    assert c.get(f"/api/echo?ticket={bad}").status_code == 401


async def test_ticket_follows_a_role_drop(cl, monkeypatch):
    """Access is re-checked on use: a viewer demoted to customer-only loses
    what their ticket opened."""
    f, ft = await account("founder", "admin")
    hv, t = await account("hv", "viewer")
    tk = ticket_for(cl, t, DEPTH)
    await service.set_platform_role(hv.id, None)
    await service.membership_changed(hv.id, before_compat="viewer", reduced=True)
    assert cl.get(f"{DEPTH}?ticket={tk}").status_code == 403


def test_only_the_streams_opted_in():
    import app.reconstruction.routes  # noqa: F401  (registers its template)
    import app.webrtc.mesh_units  # noqa: F401
    import app.models_custom.routes  # noqa: F401  (a model's preview image, signed in)
    assert sorted(url_tickets.ticket_templates()) == [
        "/api/models/{model_id}/preview",
        "/api/recon/stream/{kind}", "/api/video/feeds/{port}/h264", "/api/video/feeds/{port}/hevc"]


async def test_feed_tickets_need_the_feeds_role(cl):
    """The server feeds start readers and transcoders: operator, like their
    bearer check. The ticket lets the frontend reach the same backend on
    localhost without sending it the bearer."""
    _, vt = await account("hv", "viewer")
    _, ot = await account("hp", "operator")
    assert ticket_for(cl, vt, "/api/video/feeds/5600/hevc", 403) is None
    assert ticket_for(cl, ot, "/api/video/feeds/5600/hevc")
    assert ticket_for(cl, ot, "/api/video/feeds/5600/h264")
    assert ticket_for(cl, ot, "/api/video/feeds", 404) is None


def test_health_names_the_process(cl):
    a, b = cl.get("/api/health").json(), cl.get("/api/health").json()
    assert isinstance(a["instance"], str) and len(a["instance"]) == 16 and a["instance"] == b["instance"]


def test_the_map_is_bounded(monkeypatch):
    url_tickets.reset_for_tests()
    monkeypatch.setattr(url_tickets, "MAX_TICKETS", 10)
    for i in range(25):
        url_tickets.issue("u", "h", f"/api/p{i}")
    assert len(url_tickets._tickets) <= 10
    url_tickets.reset_for_tests()


async def test_local_ticket_only_on_direct_loopback(cl):
    """A ticket minted for the localhost feed shortcut works on a direct
    loopback connection only: not from another host, and not through a
    proxy on this machine (cloudflared adds CF-Connecting-IP)."""
    from app.server import create_app
    _, t = await account("lv", "viewer")
    r = cl.post("/api/auth/url-ticket", headers=hdr(t), json={"path": DEPTH, "local": True})
    tk = r.json()["ticket"]
    assert cl.get(f"{DEPTH}?ticket={tk}").status_code == 401             # peer "testclient"
    lo = TestClient(create_app().other_asgi_app, client=("127.0.0.1", 50000))
    assert lo.get(f"{DEPTH}?ticket={tk}").status_code == 200
    assert lo.get(f"{DEPTH}?ticket={tk}", headers={"CF-Connecting-IP": "203.0.113.9"}).status_code == 401
    assert lo.get(f"{DEPTH}?ticket={tk}", headers={"X-Forwarded-For": "203.0.113.9"}).status_code == 401
    # An ordinary ticket still works from anywhere.
    plain = ticket_for(cl, t, DEPTH)
    assert cl.get(f"{DEPTH}?ticket={plain}").status_code == 200
