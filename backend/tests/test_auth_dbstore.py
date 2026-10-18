"""
DbStore against a real Postgres - opt in.

Skipped unless HYRAK_TEST_DATABASE_URL names a DISPOSABLE database already
migrated to head (`DATABASE_URL=<that url> alembic upgrade head`). Never
point it at the live `hyrak` database: it writes rows.

Covers what the memory double cannot prove: the SQL of the single-use
invite claim under real concurrency, the reset transaction, the joined
membership read, `disabled` surviving an upsert, the count that ignores
disabled accounts, and the platform-workspace defaults on drones / zones.
"""
import asyncio
import os
import uuid
from datetime import timedelta

import pytest

URL = os.environ.get("HYRAK_TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="HYRAK_TEST_DATABASE_URL not set")


@pytest.fixture
async def db(monkeypatch):
    from app.config import get_settings
    from app.db import engine
    dbname = URL.split("?", 1)[0].rsplit("/", 1)[-1]
    assert dbname != "hyrak", "refusing to run against the live database"
    monkeypatch.setattr(get_settings(), "database_url", URL)
    assert await engine.init_db()
    from app.auth.store import DbStore
    yield DbStore()
    await engine.close_db()


def uid(prefix):
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


async def test_users_memberships_and_upsert_keep_disabled(db):
    from app.auth.store import (PLATFORM_WORKSPACE_ID, MembershipRecord, StoreConflict,
                                UserRecord, WorkspaceRecord, new_id)
    name = uid("u")
    u = await db.upsert_user(UserRecord(id=new_id(), username=name, password_hash="h1",
                                        email=f"{name}@x.com", display_name="U"))
    await db.update_user(u.id, disabled=True)
    again = await db.upsert_user(UserRecord(id=new_id(), username=name, password_hash="h2"))
    assert again.id == u.id and again.disabled is True and again.password_hash == "h2"
    assert again.email == f"{name}@x.com"
    other = uid("o")
    with pytest.raises(StoreConflict):
        await db.upsert_user(UserRecord(id=new_id(), username=other, password_hash="h",
                                        email=f"{name}@x.com"))
    assert (await db.get_user_by_email(f"{name}@x.com")).id == u.id

    plat = await db.get_workspace(PLATFORM_WORKSPACE_ID)
    assert plat.kind == "platform"
    wid = new_id()
    org = await db.create_workspace(WorkspaceRecord(id=wid, kind="organization", name=uid("org"),
                                                    parent_id=plat.id, path=f"{plat.path}{wid}/"))
    m = await db.add_membership(MembershipRecord(id=new_id(), user_id=u.id, workspace_id=org.id,
                                                 role="owner"))
    assert m.workspace_kind == "organization" and m.workspace_path == org.path
    with pytest.raises(StoreConflict):
        await db.add_membership(MembershipRecord(id=new_id(), user_id=u.id, workspace_id=org.id,
                                                 role="viewer"))
    # A disabled owner is not counted as an owner.
    assert await db.count_role(org.id, "owner") == 0
    await db.update_user(u.id, disabled=False)
    assert await db.count_role(org.id, "owner") == 1
    assert (await db.update_membership(m.id, role="admin")).role == "admin"
    assert [x.id for x in await db.memberships_for_workspaces([org.id])] == [m.id]
    usage = await db.workspace_usage(org.id)
    assert usage == {"children": 0, "drones": 0, "zones": 0}
    assert await db.delete_workspace(org.id)
    assert await db.memberships_for_user(u.id) == []            # cascade
    await db.delete_user(u.id)


async def test_invite_claim_is_single_use_under_concurrency(db):
    from app.auth.store import (PLATFORM_WORKSPACE_ID, InviteRecord, InviteUnavailable,
                                MembershipRecord, StoreConflict, UserRecord, WorkspaceRecord,
                                new_id, utcnow)
    plat = await db.get_workspace(PLATFORM_WORKSPACE_ID)
    wid = new_id()
    org = await db.create_workspace(WorkspaceRecord(id=wid, kind="organization", name=uid("org"),
                                                    parent_id=plat.id, path=f"{plat.path}{wid}/"))
    h = uuid.uuid4().hex + uuid.uuid4().hex
    await db.add_invite(InviteRecord(id=new_id(), workspace_id=org.id, role="pilot", token_hash=h,
                                     expires_at=utcnow() + timedelta(days=1)))

    async def attempt(i):
        user = UserRecord(id=new_id(), username=uid(f"r{i}"), password_hash="h",
                          email=f"{uid('e')}@x.com")
        m = MembershipRecord(id=new_id(), user_id=user.id, workspace_id=org.id, role="pilot")
        try:
            await db.accept_invite(h, utcnow(), user_id=user.id, new_user=user, membership=m)
            return user.id
        except InviteUnavailable:
            return None
    results = await asyncio.gather(*(attempt(i) for i in range(8)))
    winners = [r for r in results if r]
    assert len(winners) == 1
    # Losers left nothing behind: one membership, one new account.
    ms = await db.memberships_for_workspaces([org.id])
    assert [m.user_id for m in ms] == winners
    inv = await db.get_invite_by_hash(h)
    assert inv.accepted_by == winners[0]

    # A conflicting accept rolls the claim back (the invite stays usable).
    h2 = uuid.uuid4().hex + uuid.uuid4().hex
    await db.add_invite(InviteRecord(id=new_id(), workspace_id=org.id, role="viewer", token_hash=h2,
                                     expires_at=utcnow() + timedelta(days=1)))
    with pytest.raises(StoreConflict):
        await db.accept_invite(h2, utcnow(), user_id=winners[0], new_user=None,
                               membership=MembershipRecord(id=new_id(), user_id=winners[0],
                                                           workspace_id=org.id, role="viewer"))
    assert (await db.get_invite_by_hash(h2)).accepted_at is None
    # Expired: unavailable.
    h3 = uuid.uuid4().hex + uuid.uuid4().hex
    await db.add_invite(InviteRecord(id=new_id(), workspace_id=org.id, role="viewer", token_hash=h3,
                                     expires_at=utcnow() - timedelta(seconds=1)))
    with pytest.raises(InviteUnavailable):
        await db.accept_invite(h3, utcnow(), user_id=winners[0], new_user=None,
                               membership=MembershipRecord(id=new_id(), user_id=winners[0],
                                                           workspace_id=org.id, role="viewer"))
    for m in ms:
        await db.delete_user(m.user_id)
    await db.delete_workspace(org.id)


async def test_reset_tokens_audit_drones_zones(db):
    from app.auth.store import (PLATFORM_WORKSPACE_ID, AuditRecord, ResetRecord, TokenRecord,
                                UserRecord, ZoneRecord, new_id, utcnow)
    u = await db.upsert_user(UserRecord(id=new_id(), username=uid("r"), password_hash="old"))
    h = uuid.uuid4().hex
    await db.add_reset(ResetRecord(id=new_id(), user_id=u.id, token_hash=h,
                                   expires_at=utcnow() + timedelta(hours=1)))
    assert await db.consume_reset(h, utcnow(), "new") == u.id
    assert (await db.get_user_by_id(u.id)).password_hash == "new"
    assert await db.consume_reset(h, utcnow(), "again") is None

    keep, drop = uuid.uuid4().hex, uuid.uuid4().hex
    for th in (keep, drop):
        await db.add_token(TokenRecord(id=new_id(), user_id=u.id, token_hash=th,
                                       expires_at=utcnow() + timedelta(days=1)))
    assert await db.delete_tokens_for_user(u.id, keep_hash=keep) == 1
    toks = await db.list_tokens(u.id)
    assert [t.token_hash for t in toks] == [keep]
    assert await db.delete_token_by_id(u.id, toks[0].id) == keep

    ws = uid("ws")
    for i in range(3):
        await db.add_audit(AuditRecord(action=f"t.{i}", actor_id=u.id, workspace_id=ws, ip="1.2.3.4"))
    rows = await db.list_audit([ws], 2, None)
    assert [r.action for r in rows] == ["t.2", "t.1"]
    assert [r.action for r in await db.list_audit([ws], 5, rows[-1].id)] == ["t.0"]

    # Drones and zones default to the platform workspace at the storage layer.
    from sqlalchemy import text
    from app.db import get_session
    did = new_id()
    async with get_session() as s:
        await s.execute(text("INSERT INTO drones (id, hardware_uid, name) VALUES (:i, :h, 'x')"),
                        {"i": did, "h": uid("hw")})
        await s.commit()
    assert (await db.get_drone(did))["workspace_id"] == PLATFORM_WORKSPACE_ID
    z = await db.add_zone(ZoneRecord(id=new_id(), name="z", zone_class="red",
                                     geometry={"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}))
    assert z.layer == "regulatory" and z.workspace_id == PLATFORM_WORKSPACE_ID
    assert (await db.update_zone(z.id, name="z2")).name == "z2"
    assert await db.delete_zone(z.id)
    async with get_session() as s:
        await s.execute(text("DELETE FROM drones WHERE id = :i"), {"i": did})
        await s.commit()
    await db.delete_user(u.id)


async def test_routes_end_to_end_on_postgres(db, monkeypatch):
    """The service and routes with the DB as the store (no memory double):
    founder, workspace, member, invite accepted signed-out, site zone,
    /auth/me, audit."""
    import httpx
    from fastapi import FastAPI
    from app.auth import service
    from app.auth.routes import router as auth_router
    from app.api.routes import router as api_router
    from app.workspaces.routes import router as ws_router
    from app.zones import engine as zone_engine

    service.reset_for_tests()
    monkeypatch.setattr(service, "_db_up", lambda: True)

    async def no_reload():
        return 0
    monkeypatch.setattr(zone_engine, "reload", no_reload)
    app = FastAPI()
    for r in (auth_router, ws_router, api_router):
        app.include_router(r)
    founder_name = uid("f")
    await service.create_user(founder_name, "founder-password", founder=True,
                              email=f"{founder_name}@x.com")
    area = {"type": "Polygon", "coordinates": [[[78, 17], [79, 17], [79, 18], [78, 18], [78, 17]]]}
    inside = {"type": "Polygon", "coordinates": [[[78.2, 17.2], [78.3, 17.2], [78.3, 17.3], [78.2, 17.3], [78.2, 17.2]]]}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/api/auth/login", json={"login": f"{founder_name}@x.com", "password": "founder-password"})
        assert r.status_code == 200, r.text
        fh = {"Authorization": f"Bearer {r.json()['token']}"}
        r = await c.post("/api/workspaces", headers=fh,
                         json={"name": uid("IITH"), "kind": "organization", "operating_area": area})
        assert r.status_code == 200, r.text
        ws = r.json()["workspace"]
        r = await c.post(f"/api/workspaces/{ws['id']}/invites", headers=fh, json={"role": "owner"})
        token = r.json()["url"].rsplit("/", 1)[1]
        email = f"{uid('owner')}@x.com"
        r = await c.post(f"/api/auth/invites/{token}/accept",
                         json={"display_name": "Owner", "email": email, "password": "owner-password"})
        assert r.status_code == 200, r.text
        oh = {"Authorization": f"Bearer {r.json()['token']}"}
        r = await c.post(f"/api/auth/invites/{token}/accept",
                         json={"display_name": "X", "email": f"{uid('x')}@x.com", "password": "owner-password"})
        assert r.status_code == 404
        me = (await c.get("/api/auth/me", headers=oh)).json()
        assert me["memberships"][0]["role"] == "owner" and me["user"]["role"] == "viewer"
        assert [w["id"] for w in me["workspaces"]] == [ws["id"]]
        r = await c.post("/api/zones", headers=oh, json={"name": "lab", "zone_class": "red",
                                                         "geometry": inside, "layer": "site",
                                                         "workspace_id": ws["id"]})
        assert r.status_code == 200, r.text
        zid = r.json()["zone"]["properties"]["id"]
        members = (await c.get(f"/api/workspaces/{ws['id']}/members", headers=oh)).json()["members"]
        mid = members[0]["id"]
        r = await c.delete(f"/api/workspaces/{ws['id']}/members/{mid}", headers=oh)
        assert r.status_code == 403                               # own membership
        events = (await c.get(f"/api/audit?workspace_id={ws['id']}", headers=oh)).json()["events"]
        assert {"workspace.create", "invite.create", "invite.accept", "zone.create"} <= {e["action"] for e in events}
        assert (await c.delete(f"/api/workspaces/{ws['id']}", headers=oh)).status_code == 409   # has a zone
        assert (await c.delete(f"/api/zones/{zid}", headers=oh)).status_code == 200
        assert (await c.delete(f"/api/workspaces/{ws['id']}", headers=oh)).status_code == 200
    service.reset_for_tests()
