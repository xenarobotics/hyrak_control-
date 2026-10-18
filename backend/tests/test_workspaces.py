"""
Workspaces, members, invites, reset links, zone layers, drone assignment,
audit and the account routes, end to end over HTTP against the memory
store (service._db_up forced False, memory writes allowed). The pure rules
are unit-tested in test_perms.py; this file checks the wiring: 404 for
invisible workspaces, grant rules on the real routes, single-use invites,
revocation reaching live sockets, audit rows.
"""
import asyncio
from datetime import timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import service
from app.auth.store import PLATFORM_WORKSPACE_ID, utcnow

PW = "correct-horse-battery"


def box(x0, y0, x1, y1):
    return {"type": "Polygon",
            "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}


IITH_AREA = box(78.0, 17.0, 79.0, 18.0)
INSIDE = box(78.2, 17.2, 78.3, 17.3)
OUTSIDE = box(10, 10, 11, 11)


@pytest.fixture
def cl(monkeypatch):
    from app.api.routes import router as api_router
    from app.auth.routes import router as auth_router
    from app.workspaces.routes import router as ws_router
    from app.zones import engine as zone_engine

    monkeypatch.setattr(service, "_db_up", lambda: False)
    service.reset_for_tests()
    service.allow_memory_writes(True)

    async def no_reload():
        return 0
    monkeypatch.setattr(zone_engine, "reload", no_reload)
    app = FastAPI()
    app.include_router(auth_router)
    app.include_router(ws_router)
    app.include_router(api_router)
    yield TestClient(app)
    service.reset_for_tests()


async def user(name, role=None, email=None, verified=True):
    """A memory account; `role` is the compat alias (admin = founder). The
    email is verified by default, as if a founder had set it."""
    rec = await service.create_user(name, PW, role, memory_only=True,
                                    email=email or f"{name}@example.com", email_verified=verified)
    token, _, _ = await service.login(name, PW, "127.0.0.1")
    return rec, {"Authorization": f"Bearer {token}"}


def ok(r, code=200):
    assert r.status_code == code, (r.status_code, r.text)
    return r.json()


async def world(cl):
    """Founder + IITH (with operating area) + a client under it."""
    founder, fh = await user("founder", "admin")
    iith = ok(cl.post("/api/workspaces", headers=fh, json={
        "name": "IITH", "kind": "organization", "operating_area": IITH_AREA}))["workspace"]
    civil = ok(cl.post("/api/workspaces", headers=fh, json={
        "name": "Civil Engineering", "kind": "client", "parent_id": iith["id"],
        "operating_area": box(78.1, 17.1, 78.5, 17.5)}))["workspace"]
    return founder, fh, iith, civil


async def member(cl, fh, ws_id, name, role, **extra):
    rec, h = await user(name, extra.pop("compat", None))
    body = {"login": name, "role": role, **extra}
    m = ok(cl.post(f"/api/workspaces/{ws_id}/members", headers=fh, json=body))["member"]
    return rec, h, m


# ── /auth/me, login by email ─────────────────────────────────────────────

async def test_me_shape_and_login_by_email(cl):
    founder, fh, iith, civil = await world(cl)
    me = ok(cl.get("/api/auth/me", headers=fh))
    assert set(me) == {"user", "memberships", "workspaces"}
    assert set(me["user"]) == {"id", "username", "email", "email_verified", "display_name",
                               "is_founder", "is_staff", "role"}
    assert me["user"]["email_verified"] is True
    assert me["user"]["is_founder"] and me["user"]["is_staff"] and me["user"]["role"] == "admin"
    assert me["memberships"][0]["workspace_id"] == PLATFORM_WORKSPACE_ID
    assert set(me["memberships"][0]) == {"id", "workspace_id", "workspace_name",
                                         "workspace_kind", "role", "area", "title"}
    names = {w["name"]: w for w in me["workspaces"]}
    assert set(names) == {"HYRAK", "IITH", "Civil Engineering"}
    w = names["Civil Engineering"]
    assert w["my_role"] == "founder" and w["inherited"] is True and "zones.regulatory" in w["perms"]
    for k in ("id", "name", "kind", "parent_id", "path", "operating_area", "my_role", "perms", "inherited"):
        assert k in w
    # Sign in with the email (and the old `username` alias still works).
    r = ok(cl.post("/api/auth/login", json={"login": "FOUNDER@example.com", "password": PW}))
    assert r["user"]["username"] == "founder"
    ok(cl.post("/api/auth/login", json={"username": "founder", "password": PW}))
    assert cl.post("/api/auth/login", json={"password": PW}).status_code == 422


# ── visibility and inheritance ───────────────────────────────────────────

async def test_inheritance_and_404_for_invisible(cl):
    founder, fh, iith, civil = await world(cl)
    sky = ok(cl.post("/api/workspaces", headers=fh, json={"name": "SkyServe", "kind": "organization"}))["workspace"]
    _, oh, _ = await member(cl, fh, iith["id"], "olga", "owner")
    seen = {w["name"]: w for w in ok(cl.get("/api/workspaces", headers=oh))["workspaces"]}
    assert set(seen) == {"IITH", "Civil Engineering"}
    assert seen["Civil Engineering"]["inherited"] is True and seen["IITH"]["inherited"] is False
    assert cl.get(f"/api/workspaces/{sky['id']}", headers=oh).status_code == 404
    assert cl.get(f"/api/workspaces/{PLATFORM_WORKSPACE_ID}", headers=oh).status_code == 404
    assert cl.get("/api/workspaces/no-such-id", headers=oh).status_code == 404
    assert cl.get(f"/api/workspaces/{sky['id']}/members", headers=oh).status_code == 404
    # A HYRAK pilot does not inherit into customers.
    _, ph = await user("hpilot", "operator")
    seen = {w["name"] for w in ok(cl.get("/api/workspaces", headers=ph))["workspaces"]}
    assert seen == {"HYRAK"}
    assert cl.get(f"/api/workspaces/{iith['id']}", headers=ph).status_code == 404
    me = ok(cl.get("/api/auth/me", headers=ph))["user"]
    assert me["role"] == "operator" and me["is_staff"] and not me["is_founder"]


async def test_customer_compat_role_is_member(cl):
    """Customer-only accounts rank below viewer in phase 1: their own account
    and workspace routes work, the unscoped live/viewer routes do not."""
    founder, fh, iith, civil = await world(cl)
    _, oh, _ = await member(cl, fh, iith["id"], "olga", "owner")
    assert ok(cl.get("/api/auth/me", headers=oh))["user"]["role"] == "member"
    ok(cl.get("/api/workspaces", headers=oh))
    ok(cl.get(f"/api/workspaces/{iith['id']}/members", headers=oh))
    ok(cl.get("/api/auth/sessions", headers=oh))
    assert cl.get("/api/sessions", headers=oh).status_code == 403


async def test_workspace_creation_rules(cl):
    founder, fh, iith, civil = await world(cl)
    _, oh, _ = await member(cl, fh, iith["id"], "olga", "owner")
    # Owner adds a client, but cannot set its operating area or a top-level org.
    ok(cl.post("/api/workspaces", headers=oh, json={"name": "Security", "kind": "client",
                                                    "parent_id": iith["id"]}))
    r = cl.post("/api/workspaces", headers=oh, json={"name": "X", "kind": "client",
                                                     "parent_id": iith["id"], "operating_area": INSIDE})
    assert r.status_code == 403
    assert cl.post("/api/workspaces", headers=oh, json={"name": "Y", "kind": "organization"}).status_code == 403
    assert cl.post("/api/workspaces", headers=fh, json={"name": "Z", "kind": "client"}).status_code == 400
    assert cl.post("/api/workspaces", headers=fh, json={"name": "P", "kind": "platform"}).status_code == 400
    bad = cl.post("/api/workspaces", headers=fh, json={"name": "Q", "kind": "organization",
                                                       "operating_area": box(170, 80, 190, 85)})
    assert bad.status_code == 400
    # Operating area is staff-only on PATCH too; rename is fine for owners.
    assert cl.patch(f"/api/workspaces/{iith['id']}", headers=oh,
                    json={"operating_area": OUTSIDE}).status_code == 403
    assert ok(cl.patch(f"/api/workspaces/{iith['id']}", headers=oh,
                       json={"name": "IIT Hyderabad"}))["workspace"]["name"] == "IIT Hyderabad"
    cleared = ok(cl.patch(f"/api/workspaces/{civil['id']}", headers=fh, json={"operating_area": None}))
    assert cleared["workspace"]["operating_area"] is None


async def test_workspace_delete_rules(cl):
    founder, fh, iith, civil = await world(cl)
    _, oh, _ = await member(cl, fh, iith["id"], "olga", "owner")
    _, ah, _ = await member(cl, fh, iith["id"], "adam", "admin")
    assert cl.delete(f"/api/workspaces/{iith['id']}", headers=ah).status_code == 403
    r = cl.delete(f"/api/workspaces/{iith['id']}", headers=oh)
    assert r.status_code == 409 and "children" in r.json()["detail"]
    ok(cl.delete(f"/api/workspaces/{civil['id']}", headers=oh))
    ok(cl.delete(f"/api/workspaces/{iith['id']}", headers=oh))
    assert cl.delete(f"/api/workspaces/{PLATFORM_WORKSPACE_ID}", headers=fh).status_code == 409


async def test_disabled_workspace_hides_from_customers(cl):
    founder, fh, iith, civil = await world(cl)
    _, oh, _ = await member(cl, fh, iith["id"], "olga", "owner")
    assert cl.patch(f"/api/workspaces/{iith['id']}", headers=oh, json={"disabled": True}).status_code == 403
    ok(cl.patch(f"/api/workspaces/{iith['id']}", headers=fh, json={"disabled": True}))
    assert cl.get(f"/api/workspaces/{iith['id']}", headers=oh).status_code == 404
    assert cl.get(f"/api/workspaces/{civil['id']}", headers=oh).status_code == 404   # subtree too
    assert cl.patch(f"/api/workspaces/{PLATFORM_WORKSPACE_ID}", headers=fh,
                    json={"disabled": True}).status_code == 409


# ── grant rules on the routes ────────────────────────────────────────────

async def test_grant_rules(cl):
    founder, fh, iith, civil = await world(cl)
    olga, oh, om = await member(cl, fh, iith["id"], "olga", "owner")
    adam, ah, am = await member(cl, fh, iith["id"], "adam", "admin")
    # Admin cannot grant owner, edit or remove an owner; can add a pilot.
    await user("pete")
    assert cl.post(f"/api/workspaces/{iith['id']}/members", headers=ah,
                   json={"login": "pete", "role": "owner"}).status_code == 403
    assert cl.patch(f"/api/workspaces/{iith['id']}/members/{om['id']}", headers=ah,
                    json={"title": "x"}).status_code == 403
    assert cl.delete(f"/api/workspaces/{iith['id']}/members/{om['id']}", headers=ah).status_code == 403
    pm = ok(cl.post(f"/api/workspaces/{iith['id']}/members", headers=ah,
                    json={"login": "pete@example.com", "role": "pilot"}))["member"]
    # Already a member: 409. Unknown account: 404. Bad role for kind: 400.
    assert cl.post(f"/api/workspaces/{iith['id']}/members", headers=ah,
                   json={"login": "pete", "role": "viewer"}).status_code == 409
    assert cl.post(f"/api/workspaces/{iith['id']}/members", headers=ah,
                   json={"login": "ghost", "role": "viewer"}).status_code == 404
    assert cl.post(f"/api/workspaces/{iith['id']}/members", headers=fh,
                   json={"login": "pete", "role": "founder"}).status_code == 400
    # Nobody edits their own membership, not even an owner.
    assert cl.patch(f"/api/workspaces/{iith['id']}/members/{om['id']}", headers=oh,
                    json={"role": "admin"}).status_code == 403
    # Owner promotes the pilot to owner; owners can then remove each other.
    ok(cl.patch(f"/api/workspaces/{iith['id']}/members/{pm['id']}", headers=oh, json={"role": "owner"}))
    pete_h = {"Authorization": f"Bearer {(await service.login('pete', PW, '127.0.0.1'))[0]}"}
    ok(cl.delete(f"/api/workspaces/{iith['id']}/members/{om['id']}", headers=pete_h))
    # Pete is now the last owner: the admin cannot demote him (admins never
    # touch owners), and a founder may remove a last owner.
    r = cl.patch(f"/api/workspaces/{iith['id']}/members/{pm['id']}", headers=ah, json={"role": "admin"})
    assert r.status_code == 403
    ok(cl.delete(f"/api/workspaces/{iith['id']}/members/{pm['id']}", headers=fh))


async def test_last_owner_refused_for_non_founders(cl):
    founder, fh, iith, civil = await world(cl)
    _, oh, om = await member(cl, fh, iith["id"], "olga", "owner")
    _, mh, mm = await member(cl, fh, iith["id"], "mgr", "manager", compat="operator")
    r = cl.delete(f"/api/workspaces/{iith['id']}/members/{om['id']}", headers=mh)
    assert r.status_code == 409 and "last owner" in r.json()["detail"]
    r = cl.patch(f"/api/workspaces/{iith['id']}/members/{om['id']}", headers=mh, json={"role": "admin"})
    assert r.status_code == 409


async def test_manager_rules(cl):
    founder, fh, iith, civil = await world(cl)
    _, oh, _ = await member(cl, fh, iith["id"], "olga", "owner")
    await user("cust")
    r = cl.post(f"/api/workspaces/{iith['id']}/members", headers=fh, json={"login": "cust", "role": "manager"})
    assert r.status_code == 409 and "staff" in r.json()["detail"]
    staff, sh = await user("staffer", "viewer")
    assert cl.post(f"/api/workspaces/{iith['id']}/members", headers=oh,
                   json={"login": "staffer", "role": "manager"}).status_code == 403
    ok(cl.post(f"/api/workspaces/{iith['id']}/members", headers=fh,
               json={"login": "staffer", "role": "manager", "title": "Service operator, IITH"}))
    me = ok(cl.get("/api/auth/me", headers=sh))
    assert me["user"]["role"] == "operator"                      # compat: manager anywhere
    assert {w["name"] for w in me["workspaces"]} == {"HYRAK", "IITH", "Civil Engineering"}
    # The manager onboards a customer owner but never grants manager.
    await user("newowner")
    ok(cl.post(f"/api/workspaces/{civil['id']}/members", headers=sh, json={"login": "newowner", "role": "owner"}))
    await user("staff2", "viewer")
    assert cl.post(f"/api/workspaces/{civil['id']}/members", headers=sh,
                   json={"login": "staff2", "role": "manager"}).status_code == 403


async def test_airspace_membership_needs_area_and_is_founder_only(cl):
    founder, fh, iith, civil = await world(cl)
    await user("air")
    r = cl.post(f"/api/workspaces/{PLATFORM_WORKSPACE_ID}/members", headers=fh,
                json={"login": "air", "role": "airspace"})
    assert r.status_code == 400
    ok(cl.post(f"/api/workspaces/{PLATFORM_WORKSPACE_ID}/members", headers=fh,
               json={"login": "air", "role": "airspace", "area": INSIDE}))
    _, ph = await user("hp", "operator")
    await user("air2")
    assert cl.post(f"/api/workspaces/{PLATFORM_WORKSPACE_ID}/members", headers=ph,
                   json={"login": "air2", "role": "airspace", "area": INSIDE}).status_code == 403
    bad = cl.post(f"/api/workspaces/{PLATFORM_WORKSPACE_ID}/members", headers=fh,
                  json={"login": "air2", "role": "airspace", "area": {"type": "Point", "coordinates": [1, 2]}})
    assert bad.status_code == 400


async def test_last_founder_cannot_be_removed(cl):
    founder, fh = await user("founder", "admin")
    f2, f2h = await user("founder2", "admin")
    ms = await service.memberships_of(f2.id)
    # founder removes founder2 (founder remains): fine.
    ok(cl.delete(f"/api/workspaces/{PLATFORM_WORKSPACE_ID}/members/{ms[0].id}", headers=fh))
    # Nobody can remove the last founder (and nobody edits their own).
    mine = (await service.memberships_of(founder.id))[0]
    assert cl.delete(f"/api/workspaces/{PLATFORM_WORKSPACE_ID}/members/{mine.id}", headers=fh).status_code == 403
    assert cl.delete(f"/api/auth/users/{founder.id}", headers=fh).status_code == 400


async def test_members_list_marks_inherited_and_hides_emails_from_viewers(cl):
    founder, fh, iith, civil = await world(cl)
    _, oh, _ = await member(cl, fh, iith["id"], "olga", "owner")
    _, vh, _ = await member(cl, fh, civil["id"], "vic", "viewer")
    rows = ok(cl.get(f"/api/workspaces/{civil['id']}/members", headers=oh))["members"]
    by = {r["user"]["username"]: r for r in rows}
    assert by["olga"]["inherited_from"]["id"] == iith["id"]
    assert "inherited_from" not in by["vic"]
    assert by["vic"]["user"]["email"] == "vic@example.com"
    assert "founder" not in by                                   # platform memberships not listed
    rows = ok(cl.get(f"/api/workspaces/{civil['id']}/members", headers=vh))["members"]
    assert all(r["user"]["email"] is None for r in rows)
    # Viewers cannot manage.
    assert cl.get(f"/api/workspaces/{civil['id']}/invites", headers=vh).status_code == 403


# ── revocation on membership change ──────────────────────────────────────

async def test_membership_change_reaches_live_sockets(cl):
    founder, fh, iith, civil = await world(cl)
    seen = []

    async def listener(user_id):
        seen.append(user_id)
    service.on_user_revoked(listener)
    staff, sh = await user("staffer", "viewer")
    # A title-only change does not disturb live sockets ...
    r = ok(cl.post(f"/api/workspaces/{iith['id']}/members", headers=fh,
                   json={"login": "staffer", "role": "manager"}))["member"]
    assert seen == [staff.id]                                    # viewer -> operator: notified
    ok(cl.patch(f"/api/workspaces/{iith['id']}/members/{r['id']}", headers=fh, json={"title": "Ops"}))
    assert seen == [staff.id]
    # ... and the cached token picks up the new memberships at once.
    assert ok(cl.get("/api/auth/me", headers=sh))["memberships"][-1]["title"] == "Ops"
    # Removing it (access reduced, operator -> viewer) notifies again.
    ok(cl.delete(f"/api/workspaces/{iith['id']}/members/{r['id']}", headers=fh))
    assert seen == [staff.id, staff.id]
    assert ok(cl.get("/api/auth/me", headers=sh))["user"]["role"] == "viewer"


async def test_socket_guard_sees_compat_role_from_memberships(cl):
    from app.auth import socket_guard
    from app.sessions.manager import SessionManager

    class FakeSio:
        async def emit(self, *a, **k): pass
        async def disconnect(self, sid): pass

    founder, fh, iith, civil = await world(cl)
    staff, sh = await user("staffer", "viewer")
    sm = SessionManager()
    socket_guard.configure(FakeSio(), sm)
    token = sh["Authorization"].split()[1]
    s = sm.create(socket_id="s1")
    s.user_id, s.username, s.role = staff.id, "staffer", "viewer"
    s.token_hash = service.hash_token(token)
    s.auth_checked_at = 0.0
    assert await socket_guard.require_operator("s1", "drone_action") is False
    ok(cl.post(f"/api/workspaces/{iith['id']}/members", headers=fh,
               json={"login": "staffer", "role": "manager"}))
    s.auth_checked_at = 0.0
    assert await socket_guard.require_operator("s1", "drone_action") is True
    assert s.role == "operator"


async def test_customer_only_account_loses_live_socket(cl):
    """Phase 1: a customer-only account ranks "member", below viewer, and an
    open socket of an account demoted to that is disconnected."""
    from app.auth import socket_guard
    from app.sessions.manager import SessionManager

    dropped = []

    class FakeSio:
        async def emit(self, *a, **k): pass
        async def disconnect(self, sid): dropped.append(sid)

    founder, fh, iith, civil = await world(cl)
    staff, sh = await user("demoted", "viewer")
    ok(cl.post(f"/api/workspaces/{iith['id']}/members", headers=fh,
               json={"login": "demoted", "role": "pilot"}))
    sm = SessionManager()
    socket_guard.configure(FakeSio(), sm)
    s = sm.create(socket_id="s9")
    s.user_id, s.username, s.role = staff.id, "demoted", "viewer"
    s.token_hash = service.hash_token(sh["Authorization"].split()[1])
    s.auth_checked_at = 0.0
    assert await socket_guard.revalidate(s) is True and s.role == "viewer"
    members = ok(cl.get(f"/api/workspaces/{PLATFORM_WORKSPACE_ID}/members", headers=fh))["members"]
    mid = next(m["id"] for m in members if m["user"]["username"] == "demoted")
    ok(cl.delete(f"/api/workspaces/{PLATFORM_WORKSPACE_ID}/members/{mid}", headers=fh))
    assert ok(cl.get("/api/auth/me", headers=sh))["user"]["role"] == "member"
    assert cl.get("/api/sessions", headers=sh).status_code == 403
    s.auth_checked_at = 0.0
    assert await socket_guard.revalidate(s) is False
    assert dropped == ["s9"]


# ── invites ──────────────────────────────────────────────────────────────

def _token_of(url: str) -> str:
    return url.rsplit("/", 1)[1]


async def test_invite_signed_out_creates_account(cl):
    founder, fh, iith, civil = await world(cl)
    _, oh, _ = await member(cl, fh, iith["id"], "olga", "owner")
    out = ok(cl.post(f"/api/workspaces/{iith['id']}/invites", headers=oh,
                     json={"role": "admin", "title": "Ops lead"}))
    assert out["url"].startswith("/invite/") and out["invite"]["status"] == "pending"
    token = _token_of(out["url"])
    pv = ok(cl.get(f"/api/auth/invites/{token}"))
    assert pv == {"workspace_name": "IITH", "workspace_kind": "organization", "role": "admin",
                  "title": "Ops lead", "email_locked": False,
                  "expires_at": pv["expires_at"], "invited_by": "olga"}
    r = ok(cl.post(f"/api/auth/invites/{token}/accept", json={
        "display_name": "Asha", "email": "Asha@IITH.ac.in", "password": "a-long-password"}))
    assert r["token"] and r["user"]["email"] == "asha@iith.ac.in" and r["user"]["username"] == "asha"
    h = {"Authorization": f"Bearer {r['token']}"}
    me = ok(cl.get("/api/auth/me", headers=h))
    assert me["memberships"][0]["role"] == "admin" and me["memberships"][0]["title"] == "Ops lead"
    # Single use.
    assert cl.post(f"/api/auth/invites/{token}/accept", json={
        "display_name": "B", "email": "b@x.com", "password": "a-long-password"}).status_code == 404
    assert cl.get(f"/api/auth/invites/{token}").status_code == 404
    invites = ok(cl.get(f"/api/workspaces/{iith['id']}/invites", headers=oh))["invites"]
    assert invites[0]["status"] == "accepted"


async def test_invite_rules_and_validation(cl):
    founder, fh, iith, civil = await world(cl)
    _, ah, _ = await member(cl, fh, iith["id"], "adam", "admin")
    assert cl.post(f"/api/workspaces/{iith['id']}/invites", headers=ah, json={"role": "owner"}).status_code == 403
    assert cl.post(f"/api/workspaces/{iith['id']}/invites", headers=fh, json={"role": "manager"}).status_code == 409
    assert cl.post(f"/api/workspaces/{iith['id']}/invites", headers=ah,
                   json={"role": "pilot", "expires_days": 31}).status_code == 400
    assert cl.post(f"/api/workspaces/{iith['id']}/invites", headers=ah,
                   json={"role": "pilot", "email": "not-an-email"}).status_code == 400
    token = _token_of(ok(cl.post(f"/api/workspaces/{iith['id']}/invites", headers=ah,
                                 json={"role": "pilot"}))["url"])
    for bad in ({"email": "x@y.com", "password": "a-long-password"},           # no name
                {"display_name": "X", "password": "a-long-password"},          # no email
                {"display_name": "X", "email": "x@y.com", "password": "short"}):
        assert cl.post(f"/api/auth/invites/{token}/accept", json=bad).status_code == 400
    # Existing account by email while signed out: sign in first.
    r = cl.post(f"/api/auth/invites/{token}/accept",
                json={"display_name": "Adam", "email": "adam@example.com", "password": "a-long-password"})
    assert r.status_code == 409 and "Sign in first" in r.json()["detail"]
    # Username taken.
    r = cl.post(f"/api/auth/invites/{token}/accept", json={
        "display_name": "X", "email": "x@y.com", "password": "a-long-password", "username": "adam"})
    assert r.status_code == 409
    # Revoked invites are dead.
    iid = ok(cl.get(f"/api/workspaces/{iith['id']}/invites", headers=ah))["invites"][0]["id"]
    ok(cl.delete(f"/api/workspaces/{iith['id']}/invites/{iid}", headers=ah))
    assert cl.get(f"/api/auth/invites/{token}").status_code == 404
    assert cl.delete(f"/api/workspaces/{iith['id']}/invites/{iid}", headers=ah).status_code == 409


async def test_invite_expiry_and_email_lock(cl):
    founder, fh, iith, civil = await world(cl)
    out = ok(cl.post(f"/api/workspaces/{iith['id']}/invites", headers=fh,
                     json={"role": "viewer", "email": "Lock@X.com"}))
    token = _token_of(out["url"])
    assert ok(cl.get(f"/api/auth/invites/{token}"))["email_locked"] is True
    r = cl.post(f"/api/auth/invites/{token}/accept",
                json={"display_name": "W", "email": "wrong@x.com", "password": "a-long-password"})
    assert r.status_code == 403
    # Signed in with a different email: refused too.
    _, oh = await user("other", email="other@x.com")
    assert cl.post(f"/api/auth/invites/{token}/accept", headers=oh).status_code == 403
    # Signed in with the right email: membership added, no new account.
    lock, lh = await user("locky", email="lock@x.com")
    r = ok(cl.post(f"/api/auth/invites/{token}/accept", headers=lh))
    assert r["membership"]["workspace_id"] == iith["id"] and r["membership"]["role"] == "viewer"
    assert any(m.workspace_id == iith["id"] for m in await service.memberships_of(lock.id))
    # Expiry.
    out = ok(cl.post(f"/api/workspaces/{iith['id']}/invites", headers=fh, json={"role": "viewer"}))
    inv = service.memory_store()._invites[out["invite"]["id"]]
    inv.expires_at = utcnow() - timedelta(seconds=1)
    assert cl.get(f"/api/auth/invites/{_token_of(out['url'])}").status_code == 404
    assert cl.post(f"/api/auth/invites/{_token_of(out['url'])}/accept", headers=oh).status_code == 404


async def test_signed_in_accept_already_member_and_stale_token(cl):
    founder, fh, iith, civil = await world(cl)
    _, oh, _ = await member(cl, fh, iith["id"], "olga", "owner")
    token = _token_of(ok(cl.post(f"/api/workspaces/{iith['id']}/invites", headers=fh,
                                 json={"role": "viewer"}))["url"])
    assert cl.post(f"/api/auth/invites/{token}/accept", headers=oh).status_code == 409
    # The invite was not consumed by the refused attempt.
    assert ok(cl.get(f"/api/auth/invites/{token}"))["role"] == "viewer"
    # A stale bearer is a 401, not a silent signed-out accept.
    assert cl.post(f"/api/auth/invites/{token}/accept",
                   headers={"Authorization": "Bearer garbage"}).status_code == 401


async def test_invite_concurrent_accept_is_single_use(cl):
    from app.workspaces import service as ws
    founder, fh, iith, civil = await world(cl)
    token = _token_of(ok(cl.post(f"/api/workspaces/{iith['id']}/invites", headers=fh,
                                 json={"role": "pilot"}))["url"])
    a, _ = await user("racer-a")
    b, _ = await user("racer-b")
    ua = await service.verify_token((await service.login("racer-a", PW, "1.1.1.1"))[0])
    ub = await service.verify_token((await service.login("racer-b", PW, "1.1.1.2"))[0])

    async def attempt(u, ip):
        try:
            await ws.accept_invite(token, u, ip=ip)
            return "ok"
        except ws.Refused as e:
            return e.status
    results = await asyncio.gather(attempt(ua, "2.2.2.1"), attempt(ub, "2.2.2.2"),
                                   attempt(None, "2.2.2.3"))
    assert results.count("ok") == 1, results
    winners = [u for u in (a, b) if any(m.workspace_id == iith["id"]
                                        for m in await service.memberships_of(u.id))]
    assert len(winners) == 1


async def test_invite_bad_tokens_are_rate_limited_per_ip(cl):
    for i in range(service.LOGIN_MAX_FAILURES):
        assert cl.get(f"/api/auth/invites/nope-{i}").status_code == 404
    assert cl.get("/api/auth/invites/nope-x").status_code == 429
    assert cl.post("/api/auth/invites/nope-x/accept", json={}).status_code == 429
    # Its own bucket: sign-in from the same address still works.
    await user("free")
    ok(cl.post("/api/auth/login", json={"login": "free", "password": PW}))


# ── reset links, password change, sessions ───────────────────────────────

async def test_reset_link_flow(cl):
    founder, fh, iith, civil = await world(cl)
    victim, vh = await user("vera", "operator")
    _, ph = await user("pilot2", "operator")
    assert cl.post(f"/api/auth/users/{victim.id}/reset-link", headers=ph).status_code == 403
    out = ok(cl.post(f"/api/auth/users/{victim.id}/reset-link", headers=fh))
    assert out["url"].startswith("/reset/") and out["expires_at"]
    token = _token_of(out["url"])
    assert cl.post(f"/api/auth/reset/{token}", json={"password": "short"}).status_code == 400
    ok(cl.post(f"/api/auth/reset/{token}", json={"password": "the-new-password"}))
    assert cl.get("/api/auth/me", headers=vh).status_code == 401          # old sessions gone
    ok(cl.post("/api/auth/login", json={"login": "vera", "password": "the-new-password"}))
    assert cl.post(f"/api/auth/reset/{token}", json={"password": "another-password"}).status_code == 404
    # Expired link.
    out = ok(cl.post(f"/api/auth/users/{victim.id}/reset-link", headers=fh))
    for r in service.memory_store()._resets.values():
        r.expires_at = utcnow() - timedelta(seconds=1)
    assert cl.post(f"/api/auth/reset/{_token_of(out['url'])}",
                   json={"password": "another-password"}).status_code == 404


async def test_password_change_and_sessions(cl):
    rec, h1 = await user("sam", "operator")
    t2, _, _ = await service.login("sam", PW, "127.0.0.2", label="laptop")
    h2 = {"Authorization": f"Bearer {t2}"}
    sessions = ok(cl.get("/api/auth/sessions", headers=h1))
    assert len(sessions) == 2 and sum(s["current"] for s in sessions) == 1
    r = cl.post("/api/auth/me/password", headers=h1,
                json={"current_password": "wrong-password-xx", "new_password": "a-long-new-password"})
    assert r.status_code == 403                                   # never 401 (would log out)
    r = cl.post("/api/auth/me/password", headers=h1,
                json={"current_password": PW, "new_password": "short"})
    assert r.status_code == 400
    ok(cl.post("/api/auth/me/password", headers=h1,
               json={"current_password": PW, "new_password": "a-long-new-password"}))
    assert cl.get("/api/auth/me", headers=h1).status_code == 200    # this device kept
    assert cl.get("/api/auth/me", headers=h2).status_code == 401    # others signed out
    # Sessions: revoke one by id.
    t3, _, _ = await service.login("sam", "a-long-new-password", "127.0.0.3")
    sid = [s for s in ok(cl.get("/api/auth/sessions", headers=h1)) if not s["current"]][0]["id"]
    ok(cl.delete(f"/api/auth/sessions/{sid}", headers=h1))
    assert cl.get("/api/auth/me", headers={"Authorization": f"Bearer {t3}"}).status_code == 401
    assert cl.delete(f"/api/auth/sessions/{sid}", headers=h1).status_code == 404
    ok(cl.post("/api/auth/sessions/revoke-others", headers=h1))


async def test_profile_patch_cannot_change_own_email(cl):
    rec, h = await user("pia")
    out = ok(cl.patch("/api/auth/me", headers=h, json={"display_name": "Pia K"}))
    assert out["user"]["display_name"] == "Pia K" and out["user"]["email"] == "pia@example.com"
    r = cl.patch("/api/auth/me", headers=h, json={"email": "victim@x.com"})
    assert r.status_code == 400 and "founder" in r.json()["detail"]
    assert (await service.get_user(rec.id)).email == "pia@example.com"


async def test_founder_sets_email_verified(cl):
    founder, fh = await user("founder", "admin")
    rec, h = await user("nina", email="old@x.com", verified=False)
    out = ok(cl.patch(f"/api/auth/users/{rec.id}", headers=fh, json={"email": "Nina@New.com"}))
    assert out["user"]["email"] == "nina@new.com" and out["user"]["email_verified"] is True
    await user("taken", email="taken@x.com")
    assert cl.patch(f"/api/auth/users/{rec.id}", headers=fh, json={"email": "taken@x.com"}).status_code == 409
    cleared = ok(cl.patch(f"/api/auth/users/{rec.id}", headers=fh, json={"email": ""}))["user"]
    assert cleared["email"] is None and cleared["email_verified"] is False
    # A founder-created account's email is verified too.
    made = ok(cl.post("/api/auth/users", headers=fh, json={
        "username": "olaf", "password": "a-long-password", "role": "viewer", "email": "olaf@x.com"}))
    assert made["user"]["email_verified"] is True


async def test_unverified_email_resolves_nothing(cl):
    founder, fh, iith, civil = await world(cl)
    rec, h = await user("uma", email="uma@x.com", verified=False)
    # Not addable by email ...
    r = cl.post(f"/api/workspaces/{iith['id']}/members", headers=fh, json={"login": "uma@x.com", "role": "viewer"})
    assert r.status_code == 404 and "username" in r.json()["detail"]
    # ... but by username.
    m = ok(cl.post(f"/api/workspaces/{iith['id']}/members", headers=fh, json={"login": "uma", "role": "viewer"}))
    assert m["member"]["user"]["email_verified"] is False
    # No sign-in by an unverified email; the username works.
    assert cl.post("/api/auth/login", json={"login": "uma@x.com", "password": PW}).status_code == 401
    ok(cl.post("/api/auth/login", json={"login": "uma", "password": PW}))
    # Exposed on /auth/me and the founder's user rows.
    assert ok(cl.get("/api/auth/me", headers=h))["user"]["email_verified"] is False
    rows = {u["username"]: u for u in ok(cl.get("/api/auth/users", headers=fh))["users"]}
    assert rows["uma"]["email_verified"] is False and rows["founder"]["email_verified"] is True


async def test_invite_signup_verifies_only_through_a_locked_invite(cl):
    founder, fh, iith, civil = await world(cl)
    open_inv = _token_of(ok(cl.post(f"/api/workspaces/{iith['id']}/invites", headers=fh,
                                    json={"role": "viewer"}))["url"])
    r = ok(cl.post(f"/api/auth/invites/{open_inv}/accept", json={
        "display_name": "Free", "email": "free@x.com", "password": "a-long-password"}))
    assert r["user"]["email_verified"] is False
    locked = _token_of(ok(cl.post(f"/api/workspaces/{iith['id']}/invites", headers=fh,
                                  json={"role": "viewer", "email": "lockd@x.com"}))["url"])
    r = ok(cl.post(f"/api/auth/invites/{locked}/accept", json={
        "display_name": "Lock", "email": "LOCKD@x.com", "password": "a-long-password"}))
    assert r["user"]["email_verified"] is True


async def test_locked_invite_refuses_an_unverified_matching_email(cl):
    """The squatting attack: someone typed the victim's address on an
    unlocked invite (unverified). A locked invite for that address must not
    go to them."""
    founder, fh, iith, civil = await world(cl)
    _, sh = await user("squatter", email="victim@x.com", verified=False)
    token = _token_of(ok(cl.post(f"/api/workspaces/{iith['id']}/invites", headers=fh,
                                 json={"role": "admin", "email": "victim@x.com"}))["url"])
    r = cl.post(f"/api/auth/invites/{token}/accept", headers=sh)
    assert r.status_code == 403 and "verified" in r.json()["detail"]
    # Signed out, the locked address must be used (and here it is taken).
    r = cl.post(f"/api/auth/invites/{token}/accept", json={
        "display_name": "V", "email": "other@x.com", "password": "a-long-password"})
    assert r.status_code == 403
    r = cl.post(f"/api/auth/invites/{token}/accept", json={
        "display_name": "V", "email": "victim@x.com", "password": "a-long-password"})
    assert r.status_code == 409
    # The invite is still unused.
    assert ok(cl.get(f"/api/auth/invites/{token}"))["role"] == "admin"


async def test_founder_user_admin(cl):
    founder, fh = await user("founder", "admin")
    rec, h = await user("ulla", "operator")
    _, ph = await user("pilot", "operator")
    assert cl.get("/api/auth/users", headers=ph).status_code == 403
    users = {u["username"]: u for u in ok(cl.get("/api/auth/users", headers=fh))["users"]}
    assert users["ulla"]["role"] == "operator" and users["ulla"]["memberships"][0]["role"] == "pilot"
    ok(cl.patch(f"/api/auth/users/{rec.id}", headers=fh, json={"disabled": True}))
    assert cl.get("/api/auth/me", headers=h).status_code == 401
    assert cl.patch(f"/api/auth/users/{founder.id}", headers=fh, json={"disabled": True}).status_code == 400
    ok(cl.delete(f"/api/auth/users/{rec.id}", headers=fh))
    assert cl.delete(f"/api/auth/users/{rec.id}", headers=fh).status_code == 404


# ── zones ────────────────────────────────────────────────────────────────

def zone(cl, h, layer, ws_id, geom, **kw):
    return cl.post("/api/zones", headers=h, json={
        "name": kw.get("name", "z"), "zone_class": kw.get("zone_class", "red"),
        "geometry": geom, "layer": layer, "workspace_id": ws_id})


async def test_zone_layers(cl):
    founder, fh, iith, civil = await world(cl)
    _, oh, _ = await member(cl, fh, civil["id"], "olga", "owner")
    _, ph, _ = await member(cl, fh, civil["id"], "pat", "pilot")
    # Regulatory: founders only, and only on HYRAK. Default layer is regulatory.
    assert zone(cl, oh, "regulatory", PLATFORM_WORKSPACE_ID, INSIDE).status_code == 403
    assert zone(cl, fh, "regulatory", iith["id"], INSIDE).status_code == 400
    z = ok(zone(cl, fh, None, None, OUTSIDE))["zone"]["properties"]
    assert z["layer"] == "regulatory" and z["workspace_id"] == PLATFORM_WORKSPACE_ID
    # Site: owners inside the operating area.
    site = ok(zone(cl, oh, "site", civil["id"], INSIDE))["zone"]["properties"]
    assert site["layer"] == "site" and site["workspace_id"] == civil["id"]
    r = zone(cl, oh, "site", civil["id"], box(78.7, 17.7, 78.8, 17.8))
    assert r.status_code == 409 and "outside" in r.json()["detail"]
    assert zone(cl, ph, "site", civil["id"], INSIDE).status_code == 403
    assert zone(cl, oh, "area", civil["id"], INSIDE).status_code == 403
    # Invisible workspace: 404, not 403.
    sky = ok(cl.post("/api/workspaces", headers=fh, json={"name": "Sky", "kind": "organization"}))["workspace"]
    assert zone(cl, oh, "site", sky["id"], INSIDE).status_code == 404
    # Edits need rights on the zone; the owner cannot touch the regulatory one.
    assert cl.patch(f"/api/zones/{z['id']}", headers=oh, json={"zone_class": "green"}).status_code == 403
    assert cl.delete(f"/api/zones/{z['id']}", headers=oh).status_code == 403
    out = ok(cl.patch(f"/api/zones/{site['id']}", headers=oh, json={"name": "Lab", "zone_class": "orange"}))
    assert out["zone"]["properties"]["zone_class"] == "orange"
    # Moving a site zone to the regulatory layer is refused for the owner.
    assert cl.patch(f"/api/zones/{site['id']}", headers=oh, json={"layer": "regulatory"}).status_code in (400, 403)
    ok(cl.delete(f"/api/zones/{site['id']}", headers=oh))
    assert cl.delete(f"/api/zones/{site['id']}", headers=oh).status_code == 404
    # GET lists layer + workspace_id.
    feats = service.memory_store()._zones
    assert all(f.layer for f in feats.values())


async def test_zone_area_layer_airspace_and_manager(cl):
    founder, fh, iith, civil = await world(cl)
    await user("air")
    ok(cl.post(f"/api/workspaces/{PLATFORM_WORKSPACE_ID}/members", headers=fh,
               json={"login": "air", "role": "airspace", "area": box(78.0, 17.0, 78.5, 17.5)}))
    air_h = {"Authorization": f"Bearer {(await service.login('air', PW, '127.0.0.1'))[0]}"}
    ok(zone(cl, air_h, "area", PLATFORM_WORKSPACE_ID, INSIDE))
    ok(zone(cl, air_h, "area", iith["id"], INSIDE))                  # across workspaces
    assert zone(cl, air_h, "area", iith["id"], box(78.7, 17.7, 78.8, 17.8)).status_code == 409
    assert zone(cl, air_h, "site", iith["id"], INSIDE).status_code == 404   # not visible, no site rights
    # A manager on a workspace without an operating area gets a clear 409.
    sky = ok(cl.post("/api/workspaces", headers=fh, json={"name": "Sky", "kind": "organization"}))["workspace"]
    _, mh, _ = await member(cl, fh, sky["id"], "mgr", "manager", compat="viewer")
    r = zone(cl, mh, "area", sky["id"], INSIDE)
    assert r.status_code == 409 and "No area applies" in r.json()["detail"]
    _, m2h, _ = await member(cl, fh, iith["id"], "mgr2", "manager", compat="viewer")
    ok(zone(cl, m2h, "area", iith["id"], box(78.7, 17.7, 78.8, 17.8)))   # operating area fallback


async def test_zone_geometry_validation(cl):
    founder, fh = await user("founder", "admin")
    assert zone(cl, fh, "regulatory", None, {"type": "Point", "coordinates": [1, 2]}).status_code == 400
    assert zone(cl, fh, "regulatory", None, box(170, 80, 190, 85)).status_code == 400
    assert cl.post("/api/zones", headers=fh, json={"zone_class": "purple", "geometry": INSIDE}).status_code == 400
    assert zone(cl, fh, "nope", None, INSIDE).status_code == 400


# ── drones, staff, audit ─────────────────────────────────────────────────

async def test_drone_assignment(cl):
    founder, fh, iith, civil = await world(cl)
    mem = service.memory_store()
    mem._drones["d1"] = {"id": "d1", "name": "Drone-1", "workspace_id": PLATFORM_WORKSPACE_ID}
    _, oh, _ = await member(cl, fh, iith["id"], "olga", "owner")
    # The owner cannot see the HYRAK drone at all.
    assert cl.post("/api/drones/d1/workspace", headers=oh, json={"workspace_id": iith["id"]}).status_code == 404
    ok(cl.post("/api/drones/d1/workspace", headers=fh, json={"workspace_id": iith["id"]}))
    assert [d["id"] for d in ok(cl.get(f"/api/workspaces/{iith['id']}/drones", headers=oh))["drones"]] == ["d1"]
    # Owner moves it between their own workspaces; a pilot cannot.
    ok(cl.post("/api/drones/d1/workspace", headers=oh, json={"workspace_id": civil["id"]}))
    _, ph, _ = await member(cl, fh, civil["id"], "pat", "pilot")
    # IITH is invisible to a client-only pilot: 404. Once they can see it
    # (viewer there), the refusal is the permission: 403.
    assert cl.post("/api/drones/d1/workspace", headers=ph, json={"workspace_id": iith["id"]}).status_code == 404
    ok(cl.post(f"/api/workspaces/{iith['id']}/members", headers=fh, json={"login": "pat", "role": "viewer"}))
    assert cl.post("/api/drones/d1/workspace", headers=ph, json={"workspace_id": iith["id"]}).status_code == 403
    # Owner cannot push it back to HYRAK (no drones.manage there; not visible -> 404).
    assert cl.post("/api/drones/d1/workspace", headers=oh,
                   json={"workspace_id": PLATFORM_WORKSPACE_ID}).status_code == 404
    assert cl.post("/api/drones/nope/workspace", headers=fh, json={"workspace_id": iith["id"]}).status_code == 404
    # A workspace holding a drone cannot be deleted.
    r = cl.delete(f"/api/workspaces/{civil['id']}", headers=fh)
    assert r.status_code == 409 and "drones" in r.json()["detail"]


async def test_staff_and_audit(cl):
    founder, fh, iith, civil = await world(cl)
    _, oh, om = await member(cl, fh, iith["id"], "olga", "owner")
    _, vh, _ = await member(cl, fh, iith["id"], "vic", "viewer")
    await user("hp", "operator")
    assert cl.get("/api/staff", headers=oh).status_code == 403
    staff = {s["username"] for s in ok(cl.get("/api/staff", headers=fh))["staff"]}
    assert staff == {"founder", "hp"}
    ok(zone(cl, oh, "site", civil["id"], INSIDE))
    # Founder: everything, with actor and ip.
    events = ok(cl.get("/api/audit", headers=fh))["events"]
    actions = [e["action"] for e in events]
    for a in ("workspace.create", "membership.add", "zone.create"):
        assert a in actions
    assert all(e["ip"] for e in events)
    # Owner: own subtree only, and must name the workspace.
    assert cl.get("/api/audit", headers=oh).status_code == 400
    mine = ok(cl.get(f"/api/audit?workspace_id={iith['id']}", headers=oh))["events"]
    assert {e["workspace_id"] for e in mine} <= {iith["id"], civil["id"]}
    assert any(e["action"] == "zone.create" and e["actor_name"] == "olga" for e in mine)
    assert cl.get(f"/api/audit?workspace_id={iith['id']}", headers=vh).status_code == 403
    assert cl.get(f"/api/audit?workspace_id={PLATFORM_WORKSPACE_ID}", headers=oh).status_code == 404
    # Paging.
    page = ok(cl.get("/api/audit?limit=2", headers=fh))["events"]
    older = ok(cl.get(f"/api/audit?limit=2&before={page[-1]['id']}", headers=fh))["events"]
    assert len(page) == 2 and all(e["id"] < page[-1]["id"] for e in older)


async def test_writes_refused_with_db_down_in_production(cl):
    """Without the test switch, a DB-down write is a 503, not a memory-only
    change that would vanish on restart."""
    founder, fh = await user("founder", "admin")
    service.allow_memory_writes(False)
    r = cl.post("/api/workspaces", headers=fh, json={"name": "IITH", "kind": "organization"})
    assert r.status_code == 503
    # Reads still work (the platform workspace lives in memory).
    assert [w["name"] for w in ok(cl.get("/api/workspaces", headers=fh))["workspaces"]] == ["HYRAK"]
