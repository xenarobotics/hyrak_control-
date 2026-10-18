"""
Workspaces, members, invites, drone assignment, zone layers - the rules.

Every function takes the acting AuthUser and enforces docs/ACCESS_MODEL.md
through the pure engine in app/auth/perms.py, then writes through the store
the auth service picks (Postgres, or the memory double in tests). Routes
(app/workspaces/routes.py, app/auth/routes.py, the zone routes) only parse
and map `Refused` to an HTTP status.

Conventions:
  * A workspace the caller cannot see is reported as 404, never 403, so
    its existence does not leak.
  * Writes re-read the actor's memberships from the store instead of
    trusting the 60 s token cache: a just-demoted admin must not keep
    granting for up to a minute.
  * Every membership / invite / workspace / zone / drone-assignment change
    writes an audit_events row with actor and client IP.
  * The workspace tree is read whole per request (list_workspaces). Fine
    for phase 1 sizes; the materialized path is there for prefix queries
    when it is not.
"""
from __future__ import annotations

import logging
import re
import secrets
from dataclasses import replace
from datetime import timedelta
from typing import Optional

from app.auth import audit, perms
from app.auth import service as auth
from app.auth.service import AuthUser
from app.auth.store import (
    PLATFORM_WORKSPACE_ID, InviteRecord, InviteUnavailable, MembershipRecord,
    StoreConflict, UserRecord, WorkspaceRecord, ZoneRecord, new_id, utcnow,
)
from app.config import get_settings

logger = logging.getLogger("verocore.workspaces")

INVITE_DEFAULT_DAYS = 7
INVITE_MAX_DAYS = 30
NOT_FOUND = "Workspace not found"


class Refused(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _check(decision: perms.Decision) -> None:
    if not decision.ok:
        raise Refused(decision.status, decision.reason)


def _bad_area(geojson, field: str) -> None:
    reason = perms.validate_area(geojson, field=field)
    if reason:
        raise Refused(400, reason)


def link(path: str) -> str:
    base = (get_settings().public_app_url or "").rstrip("/")
    return f"{base}{path}"


# ── Tree helpers ──────────────────────────────────────────────────────────

class Tree:
    """All workspaces, with `disabled` resolved down the chain (a client
    of a disabled organization is disabled too)."""

    def __init__(self, rows: list[WorkspaceRecord]):
        raw = {w.id: w for w in rows}
        self.by_id: dict[str, WorkspaceRecord] = {}
        for w in rows:
            off = any(raw[a].disabled for a in self.ancestor_ids(w) if a in raw) or w.disabled
            self.by_id[w.id] = replace(w, disabled=off)

    @staticmethod
    def ancestor_ids(ws: WorkspaceRecord) -> list[str]:
        """Ids above `ws`, root first."""
        parts = [p for p in (ws.path or "").split("/") if p]
        return parts[:-1]

    def get(self, workspace_id: str) -> WorkspaceRecord | None:
        return self.by_id.get(workspace_id)

    def subtree_ids(self, ws: WorkspaceRecord) -> list[str]:
        return [w.id for w in self.by_id.values() if w.path.startswith(ws.path)]

    def all(self) -> list[WorkspaceRecord]:
        return sorted(self.by_id.values(), key=lambda w: w.path)


async def _tree(store=None) -> Tree:
    store = store or auth.read_store()
    return Tree(await store.list_workspaces())


async def _fresh_memberships(actor: AuthUser) -> list[MembershipRecord]:
    if actor.id == auth.LEGACY_USER_ID:
        return []
    return await auth.memberships_of(actor.id)


def _visible_or_404(ms, ws: WorkspaceRecord | None) -> WorkspaceRecord:
    if ws is None or not perms.visible(ms, ws):
        raise Refused(404, NOT_FOUND)
    return ws


def _describe(ms, ws: WorkspaceRecord) -> dict:
    role, inherited = perms.my_role(ms, ws)
    d = ws.public()
    d.update({"my_role": role, "perms": sorted(perms.effective_perms(ms, ws)),
              "inherited": inherited})
    return d


# ── /auth/me and GET /workspaces ──────────────────────────────────────────

async def describe_me(actor: AuthUser) -> dict:
    """The GET /api/auth/me body (docs/ACCESS_MODEL.md section 7)."""
    ms = list(actor.memberships)
    try:
        tree = await _tree()
        workspaces = [_describe(ms, w) for w in tree.all() if perms.visible(ms, w)]
    except Exception as e:
        logger.warning(f"/auth/me: workspace tree unavailable: {e}")
        workspaces = []
    return {"user": actor.public(),
            "memberships": [m.public() for m in ms],
            "workspaces": workspaces}


async def list_visible(actor: AuthUser) -> list[dict]:
    ms = await _fresh_memberships(actor)
    tree = await _tree()
    return [_describe(ms, w) for w in tree.all() if perms.visible(ms, w)]


async def get_workspace(actor: AuthUser, workspace_id: str) -> dict:
    ms = await _fresh_memberships(actor)
    tree = await _tree()
    ws = _visible_or_404(ms, tree.get(workspace_id))
    return _describe(ms, ws)


def _clean_name(name) -> str:
    n = re.sub(r"\s+", " ", str(name or "")).strip()
    if not (1 <= len(n) <= 120):
        raise Refused(400, "name must be 1-120 characters")
    return n


async def create_workspace(actor: AuthUser, *, name: str, kind: str, parent_id: str | None,
                           operating_area: dict | None, ip: str) -> dict:
    store = auth.write_store()
    ms = await _fresh_memberships(actor)
    tree = await _tree(store)
    parent = tree.get(parent_id or PLATFORM_WORKSPACE_ID)
    if parent is None or (parent.kind != perms.PLATFORM and not perms.visible(ms, parent)):
        raise Refused(404, NOT_FOUND)
    _check(perms.check_create_workspace(ms, parent, kind))
    name = _clean_name(name)
    wid = new_id()
    ws = WorkspaceRecord(id=wid, kind=kind, name=name, parent_id=parent.id,
                         path=f"{parent.path}{wid}/", created_by=actor.id)
    if operating_area is not None:
        _bad_area(operating_area, "operating_area")
        # Who may set it is decided as if the workspace already existed
        # under its parent: founders, or a manager inherited from above.
        if not perms.can(ms, ws, perms.WORKSPACE_OPERATING_AREA):
            raise Refused(403, "Only HYRAK staff (a founder or the manager) set an operating area")
        ws.operating_area = operating_area
    out = await store.create_workspace(ws)
    await audit.record(store, actor, "workspace.create", workspace_id=out.id,
                       target_type="workspace", target_id=out.id,
                       detail={"name": name, "kind": kind, "parent_id": parent.id,
                               "operating_area": operating_area is not None}, ip=ip)
    logger.info(f"workspace created: {name} ({kind}) under {parent.name} by {actor.username}")
    return _describe(ms, out)


_UNSET = object()


async def patch_workspace(actor: AuthUser, workspace_id: str, *, name=None,
                          operating_area=_UNSET, disabled=None, ip: str) -> dict:
    store = auth.write_store()
    ms = await _fresh_memberships(actor)
    tree = await _tree(store)
    ws = _visible_or_404(ms, tree.get(workspace_id))
    fields: dict = {}
    if name is not None:
        if not perms.can(ms, ws, perms.MEMBERS_MANAGE):
            raise Refused(403, "Renaming needs the owner, admin or manager role")
        fields["name"] = _clean_name(name)
    if operating_area is not _UNSET:
        if not perms.can(ms, ws, perms.WORKSPACE_OPERATING_AREA):
            raise Refused(403, "Only HYRAK staff (a founder or the manager) set an operating area")
        if operating_area is not None:
            _bad_area(operating_area, "operating_area")
        fields["operating_area"] = operating_area
    if disabled is not None:
        if ws.kind == perms.PLATFORM:
            raise Refused(409, "The HYRAK workspace cannot be disabled")
        if not perms.can(ms, ws, perms.WORKSPACE_OPERATING_AREA):
            raise Refused(403, "Only HYRAK staff (a founder or the manager) disable a workspace")
        fields["disabled"] = bool(disabled)
    if not fields:
        return _describe(ms, ws)
    out = await store.update_workspace(workspace_id, **fields)
    detail = {k: (v if k != "operating_area" else (v is not None)) for k, v in fields.items()}
    await audit.record(store, actor, "workspace.update", workspace_id=workspace_id,
                       target_type="workspace", target_id=workspace_id, detail=detail, ip=ip)
    if "disabled" in fields:
        # Access to the whole subtree just changed for everyone in it.
        await _drop_subtree_caches(store, tree, ws)
    tree = await _tree(store)
    return _describe(ms, tree.get(out.id) or out)


async def _drop_subtree_caches(store, tree: Tree, ws: WorkspaceRecord) -> None:
    for m in await store.memberships_for_workspaces(tree.subtree_ids(ws)):
        auth.drop_cached_user(m.user_id)


async def delete_workspace(actor: AuthUser, workspace_id: str, *, ip: str) -> None:
    store = auth.write_store()
    ms = await _fresh_memberships(actor)
    tree = await _tree(store)
    ws = _visible_or_404(ms, tree.get(workspace_id))
    if ws.kind == perms.PLATFORM:
        raise Refused(409, "The HYRAK workspace cannot be deleted")
    if not perms.can(ms, ws, perms.WORKSPACE_DELETE):
        raise Refused(403, "Deleting a workspace needs the owner role")
    usage = await store.workspace_usage(workspace_id)
    blockers = [f"{n} {what}" for what, n in usage.items() if n]
    if blockers:
        raise Refused(409, "Workspace still has " + ", ".join(blockers)
                      + ". Move or delete them first.")
    members = await store.memberships_for_workspaces([workspace_id])
    await store.delete_workspace(workspace_id)
    await audit.record(store, actor, "workspace.delete", workspace_id=workspace_id,
                       target_type="workspace", target_id=workspace_id,
                       detail={"name": ws.name, "kind": ws.kind}, ip=ip)
    for m in members:
        await auth.membership_changed(m.user_id, before_compat=None, reduced=True)


# ── Members ───────────────────────────────────────────────────────────────

async def _users_by_id(ids) -> dict[str, UserRecord]:
    out = {}
    for uid in set(ids):
        u = await auth.get_user(uid)
        if u is not None:
            out[uid] = u
    return out


async def list_members(actor: AuthUser, workspace_id: str) -> list[dict]:
    store = auth.read_store()
    ms = await _fresh_memberships(actor)
    tree = await _tree(store)
    ws = _visible_or_404(ms, tree.get(workspace_id))
    show_email = perms.can(ms, ws, perms.MEMBERS_MANAGE)
    # Direct members plus those inherited from ancestors. Platform
    # memberships do not inherit (founders reach everything, but listing
    # every founder on every customer would only leak the staff roster).
    ancestors = [a for a in Tree.ancestor_ids(ws) if a != PLATFORM_WORKSPACE_ID]
    rows = await store.memberships_for_workspaces([ws.id] + ancestors)
    users = await _users_by_id(m.user_id for m in rows)
    out = []
    for m in rows:
        u = users.get(m.user_id)
        if u is None:
            continue
        brief = u.brief()
        if not show_email:
            brief["email"] = None
        d = {"id": m.id, "user": brief, "role": m.role, "area": m.area, "title": m.title,
             "workspace_id": m.workspace_id, "disabled": u.disabled}
        if m.workspace_id != ws.id:
            d["inherited_from"] = {"id": m.workspace_id, "name": m.workspace_name}
        out.append(d)
    return out


def _clean_title(title) -> str:
    return str(title or "").strip()[:120]


async def _count_after_removing(store, workspace_id: str, role: str, user_id: str) -> int:
    """Active holders of `role` left on the workspace once `user_id`'s
    membership is gone. count_role skips disabled accounts, so a disabled
    holder does not count before or after."""
    n = await store.count_role(workspace_id, role)
    u = await auth.get_user(user_id)
    return n - 1 if (u is not None and not u.disabled) else n


async def add_member(actor: AuthUser, workspace_id: str, *, login: str, role: str,
                     area=None, title: str = "", ip: str) -> dict:
    store = auth.write_store()
    ms = await _fresh_memberships(actor)
    tree = await _tree(store)
    ws = _visible_or_404(ms, tree.get(workspace_id))
    target = await auth.find_account(login)
    if target is None:
        raise Refused(404, "No account with that username or verified email. Use the "
                           "username, or send an invite.")
    if area is not None:
        _bad_area(area, "area")
    target_ms = await auth.memberships_of(target.id)
    _check(perms.check_membership_change(
        ms, ws, actor_id=actor.id, target_user_id=target.id, new_role=role, area=area,
        grantee_is_staff=perms.is_staff(target_ms)))
    if any(m.workspace_id == ws.id for m in target_ms):
        raise Refused(409, "That account is already a member of this workspace; change its role instead")
    before = perms.compat_role(target_ms)
    try:
        m = await store.add_membership(MembershipRecord(
            id=new_id(), user_id=target.id, workspace_id=ws.id, role=role, area=area,
            title=_clean_title(title), created_by=actor.id))
    except StoreConflict as e:
        raise Refused(409, str(e))
    await audit.record(store, actor, "membership.add", workspace_id=ws.id,
                       target_type="user", target_id=target.id,
                       detail={"role": role, "username": target.username, "membership_id": m.id,
                               "area": area is not None}, ip=ip)
    await auth.membership_changed(target.id, before_compat=before, reduced=False)
    return {"id": m.id, "user": target.brief(), "role": m.role, "area": m.area,
            "title": m.title, "workspace_id": m.workspace_id}


async def _direct_membership(store, ws: WorkspaceRecord, membership_id: str) -> MembershipRecord:
    m = await store.get_membership(membership_id)
    if m is None or m.workspace_id != ws.id:
        raise Refused(404, "Membership not found on this workspace")
    return m


async def patch_member(actor: AuthUser, workspace_id: str, membership_id: str, *,
                       role=None, area=_UNSET, title=None, ip: str) -> dict:
    store = auth.write_store()
    ms = await _fresh_memberships(actor)
    tree = await _tree(store)
    ws = _visible_or_404(ms, tree.get(workspace_id))
    m = await _direct_membership(store, ws, membership_id)
    new_role = role or m.role
    new_area = m.area if area is _UNSET else area
    if area is not _UNSET and area is not None:
        _bad_area(area, "area")
    target_ms = await auth.memberships_of(m.user_id)
    owners_after = founders_after = None
    if m.role == perms.OWNER and new_role != perms.OWNER:
        owners_after = await _count_after_removing(store, ws.id, perms.OWNER, m.user_id)
    if m.role == perms.FOUNDER and new_role != perms.FOUNDER:
        founders_after = await _count_after_removing(store, ws.id, perms.FOUNDER, m.user_id)
    # A role edit is checked as "may touch the old role AND grant the new
    # one", so an admin cannot edit an owner even to leave it unchanged.
    _check(perms.check_membership_change(
        ms, ws, actor_id=actor.id, target_user_id=m.user_id, new_role=new_role,
        old_role=m.role, area=new_area if new_role in perms.AREA_ROLES else (
            None if area is _UNSET else area),
        grantee_is_staff=perms.is_staff(target_ms),
        owners_after=owners_after, founders_after=founders_after))
    fields: dict = {}
    if role is not None and role != m.role:
        fields["role"] = role
    if area is not _UNSET:
        fields["area"] = area
    if new_role not in perms.AREA_ROLES and m.area is not None:
        fields["area"] = None            # area only means something on area roles
    if title is not None:
        fields["title"] = _clean_title(title)
    if not fields:
        return {"id": m.id, "role": m.role, "area": m.area, "title": m.title,
                "workspace_id": m.workspace_id}
    before = perms.compat_role(target_ms)
    out = await store.update_membership(m.id, **fields)
    await audit.record(store, actor, "membership.update", workspace_id=ws.id,
                       target_type="user", target_id=m.user_id,
                       detail={"membership_id": m.id, "from_role": m.role,
                               "to_role": out.role, "area_changed": "area" in fields,
                               "title": out.title}, ip=ip)
    reduced = "role" in fields or "area" in fields
    await auth.membership_changed(m.user_id, before_compat=before, reduced=reduced)
    return {"id": out.id, "role": out.role, "area": out.area, "title": out.title,
            "workspace_id": out.workspace_id}


async def remove_member(actor: AuthUser, workspace_id: str, membership_id: str, *, ip: str) -> None:
    store = auth.write_store()
    ms = await _fresh_memberships(actor)
    tree = await _tree(store)
    ws = _visible_or_404(ms, tree.get(workspace_id))
    m = await _direct_membership(store, ws, membership_id)
    owners_after = founders_after = None
    if m.role == perms.OWNER:
        owners_after = await _count_after_removing(store, ws.id, perms.OWNER, m.user_id)
    if m.role == perms.FOUNDER:
        founders_after = await _count_after_removing(store, ws.id, perms.FOUNDER, m.user_id)
    _check(perms.check_membership_change(
        ms, ws, actor_id=actor.id, target_user_id=m.user_id, old_role=m.role,
        owners_after=owners_after, founders_after=founders_after))
    before = await auth.compat_role_of(m.user_id)
    await store.delete_membership(m.id)
    await audit.record(store, actor, "membership.remove", workspace_id=ws.id,
                       target_type="user", target_id=m.user_id,
                       detail={"membership_id": m.id, "role": m.role}, ip=ip)
    await auth.membership_changed(m.user_id, before_compat=before, reduced=True)


# ── Invites ───────────────────────────────────────────────────────────────

async def list_invites(actor: AuthUser, workspace_id: str) -> list[dict]:
    store = auth.read_store()
    ms = await _fresh_memberships(actor)
    tree = await _tree(store)
    ws = _visible_or_404(ms, tree.get(workspace_id))
    if not perms.can(ms, ws, perms.MEMBERS_MANAGE):
        raise Refused(403, "Invites are managed by owners, admins and managers")
    now = utcnow()
    return [i.public(now) for i in await store.list_invites(ws.id)]


async def create_invite(actor: AuthUser, workspace_id: str, *, role: str, email=None,
                        area=None, title: str = "", expires_days: int | None = None,
                        ip: str) -> dict:
    store = auth.write_store()
    ms = await _fresh_memberships(actor)
    tree = await _tree(store)
    ws = _visible_or_404(ms, tree.get(workspace_id))
    if area is not None:
        _bad_area(area, "area")
    _check(perms.check_invite(ms, ws, role, area))
    days = INVITE_DEFAULT_DAYS if expires_days is None else int(expires_days)
    if not (1 <= days <= INVITE_MAX_DAYS):
        raise Refused(400, f"expires_days must be 1-{INVITE_MAX_DAYS}")
    try:
        email = auth.normalise_email(email)
    except ValueError as e:
        raise Refused(400, str(e))
    token = secrets.token_urlsafe(auth.TOKEN_BYTES)
    inv = InviteRecord(id=new_id(), workspace_id=ws.id, role=role, area=area,
                       title=_clean_title(title), email=email,
                       token_hash=auth.hash_token(token), created_by=actor.id,
                       expires_at=utcnow() + timedelta(days=days))
    await store.add_invite(inv)
    await audit.record(store, actor, "invite.create", workspace_id=ws.id,
                       target_type="invite", target_id=inv.id,
                       detail={"role": role, "email_locked": email is not None,
                               "expires_days": days}, ip=ip)
    return {"invite": inv.public(), "url": link(f"/invite/{token}")}


async def revoke_invite(actor: AuthUser, workspace_id: str, invite_id: str, *, ip: str) -> None:
    store = auth.write_store()
    ms = await _fresh_memberships(actor)
    tree = await _tree(store)
    ws = _visible_or_404(ms, tree.get(workspace_id))
    if not perms.can(ms, ws, perms.MEMBERS_MANAGE):
        raise Refused(403, "Invites are managed by owners, admins and managers")
    inv = await store.get_invite(invite_id)
    if inv is None or inv.workspace_id != ws.id:
        raise Refused(404, "Invite not found")
    # Revoking is subject to the same grant rule as creating: an admin
    # cannot cancel an owner invite made by an owner.
    if inv.role not in perms.grantable_roles(ms, ws) and not perms.is_founder(ms):
        raise Refused(403, f"You cannot revoke a {inv.role} invite")
    if not await store.revoke_invite(invite_id, utcnow()):
        raise Refused(409, "That invite was already used or revoked")
    await audit.record(store, actor, "invite.revoke", workspace_id=ws.id,
                       target_type="invite", target_id=invite_id,
                       detail={"role": inv.role}, ip=ip)


INVALID_INVITE = "This invite link is invalid, used or expired"


async def _usable_invite(store, token: str, ip: str):
    """(invite, workspace) or Refused 404, counting a bad token against the
    per-IP limit. Raises auth.RateLimited when the address is locked."""
    auth.ip_gate("invite", ip)
    inv = None
    if isinstance(token, str) and 0 < len(token) <= 512:
        inv = await store.get_invite_by_hash(auth.hash_token(token))
    if inv is None or not inv.usable(utcnow()):
        auth.ip_fail("invite", ip)
        raise Refused(404, INVALID_INVITE)
    tree = await _tree(store)
    ws = tree.get(inv.workspace_id)
    if ws is None or ws.disabled or inv.role not in perms.roles_for_kind(ws.kind):
        raise Refused(404, INVALID_INVITE)
    return inv, ws


async def preview_invite(token: str, ip: str) -> dict:
    store = auth.read_store()
    inv, ws = await _usable_invite(store, token, ip)
    inviter = await auth.get_user(inv.created_by) if inv.created_by else None
    return {"workspace_name": ws.name, "workspace_kind": ws.kind, "role": inv.role,
            "title": inv.title, "email_locked": inv.email is not None,
            "expires_at": inv.expires_at.isoformat(),
            "invited_by": (inviter.display_name or inviter.username) if inviter else None}


async def _free_username(base: str) -> str:
    stem = re.sub(r"[^a-z0-9._-]", "", base.lower())[:48] or "user"
    for i in range(0, 100):
        cand = stem if i == 0 else f"{stem}-{i + 1}"
        if await auth.find_account(cand) is None:
            return cand
    return f"{stem}-{secrets.token_hex(3)}"


async def accept_invite(token: str, actor: Optional[AuthUser], *, ip: str, label: str = "",
                        display_name=None, email=None, password=None, username=None) -> dict:
    """Signed in: add the membership to the caller's account. Signed out:
    create the account (the invite is the only way in, no self sign-up)
    and sign it in. Single use is enforced in the store's transaction."""
    store = auth.write_store()
    inv, ws = await _usable_invite(store, token, ip)
    now = utcnow()
    membership = MembershipRecord(id=new_id(), user_id="", workspace_id=ws.id, role=inv.role,
                                  area=inv.area, title=inv.title, created_by=inv.created_by)
    if actor is not None:
        if actor.id == auth.LEGACY_USER_ID:
            raise Refused(403, "Sign in with your own account to accept an invite")
        # The inviter vouched for the locked address; only an account that
        # holds it AND had it verified may take the invite (an unverified
        # email is just a claim).
        if inv.email and not (actor.email == inv.email and actor.email_verified):
            raise Refused(403, "This invite is for a different (verified) email address")
        before = await auth.compat_role_of(actor.id)
        membership.user_id = actor.id
        try:
            await store.accept_invite(inv.token_hash, now, user_id=actor.id, new_user=None,
                                      membership=membership)
        except InviteUnavailable:
            raise Refused(404, INVALID_INVITE)
        except StoreConflict:
            raise Refused(409, "You are already a member of this workspace")
        await audit.record(store, actor, "invite.accept", workspace_id=ws.id,
                           target_type="invite", target_id=inv.id,
                           detail={"role": inv.role, "membership_id": membership.id}, ip=ip)
        await auth.membership_changed(actor.id, before_compat=before, reduced=False)
        return {"membership": {"id": membership.id, "workspace_id": ws.id,
                               "workspace_name": ws.name, "workspace_kind": ws.kind,
                               "role": inv.role, "area": inv.area, "title": inv.title}}

    # Signed out: a new account.
    try:
        email_n = auth.normalise_email(email)
    except ValueError as e:
        raise Refused(400, str(e))
    if not email_n:
        raise Refused(400, "email is required")
    if inv.email and email_n != inv.email:
        raise Refused(403, "This invite is for a different email address")
    if await auth.email_in_use(email_n):
        raise Refused(409, "An account with this email already exists. Sign in first, "
                           "then open the invite link again.")
    name = str(display_name or "").strip()[:120]
    if not name:
        raise Refused(400, "display_name is required")
    try:
        pw_hash = auth.hash_password(password or "")
    except ValueError as e:
        raise Refused(400, str(e))
    if username:
        try:
            uname = auth.normalise_new_username(username)
        except ValueError as e:
            raise Refused(400, str(e))
        if await auth.find_account(uname) is not None:
            raise Refused(409, "That username is taken")
    else:
        uname = await _free_username(email_n.split("@", 1)[0])
    # Verified only through an email-locked invite: the inviter sent the
    # link to exactly this address. An unlocked invite proves nothing.
    user = UserRecord(id=new_id(), username=uname, password_hash=pw_hash,
                      email=email_n, display_name=name,
                      email_verified=inv.email is not None and email_n == inv.email)
    membership.user_id = user.id
    try:
        await store.accept_invite(inv.token_hash, now, user_id=user.id, new_user=user,
                                  membership=membership)
    except InviteUnavailable:
        raise Refused(404, INVALID_INVITE)
    except StoreConflict as e:
        raise Refused(409, str(e))
    await audit.record(store, user, "account.create", workspace_id=ws.id,
                       target_type="user", target_id=user.id,
                       detail={"via": "invite", "invite_id": inv.id, "role": inv.role,
                               "username": uname}, ip=ip)
    await audit.record(store, user, "invite.accept", workspace_id=ws.id,
                       target_type="invite", target_id=inv.id,
                       detail={"role": inv.role, "membership_id": membership.id}, ip=ip)
    token_out, auth_user, expires_at = await auth._mint(user, label or "invite", store)
    logger.info(f"account '{uname}' created from an invite to {ws.name} ({inv.role}) ip={ip}")
    return {"token": token_out, "user": auth_user.public(), "expires_at": expires_at.isoformat()}


# ── Drones ────────────────────────────────────────────────────────────────

async def list_workspace_drones(actor: AuthUser, workspace_id: str) -> list[dict]:
    store = auth.read_store()
    ms = await _fresh_memberships(actor)
    tree = await _tree(store)
    ws = _visible_or_404(ms, tree.get(workspace_id))
    return await store.list_drones([ws.id])


async def assign_drone(actor: AuthUser, drone_id: str, workspace_id: str, *, ip: str) -> dict:
    store = auth.write_store()
    ms = await _fresh_memberships(actor)
    tree = await _tree(store)
    drone = await store.get_drone(drone_id)
    current = tree.get(drone["workspace_id"]) if drone else None
    if drone is None or current is None or not perms.visible(ms, current):
        raise Refused(404, "Drone not found")
    target = _visible_or_404(ms, tree.get(workspace_id))
    if not (perms.can(ms, current, perms.DRONES_MANAGE) and perms.can(ms, target, perms.DRONES_MANAGE)):
        raise Refused(403, "Moving a drone needs drones.manage on both workspaces")
    if current.id == target.id:
        return drone
    out = await store.set_drone_workspace(drone_id, target.id)
    detail = {"drone_name": drone.get("name"), "from": current.id, "to": target.id}
    await audit.record(store, actor, "drone.assign", workspace_id=target.id,
                       target_type="drone", target_id=drone_id, detail=detail, ip=ip)
    await audit.record(store, actor, "drone.unassign", workspace_id=current.id,
                       target_type="drone", target_id=drone_id, detail=detail, ip=ip)
    return out


# ── Staff and audit ───────────────────────────────────────────────────────

async def list_staff(actor: AuthUser) -> list[dict]:
    if not perms.is_founder(await _fresh_memberships(actor)):
        raise Refused(403, "Founders only")
    store = auth.read_store()
    staff_ids = {m.user_id for m in await store.memberships_for_workspaces([PLATFORM_WORKSPACE_ID])}
    out = []
    for uid, u in sorted((await _users_by_id(staff_ids)).items(), key=lambda kv: kv[1].username):
        ms = await auth.memberships_of(uid)
        d = u.public()
        d["memberships"] = [m.public() for m in ms]
        d["role"] = perms.compat_role(ms)
        out.append(d)
    return out


async def list_audit(actor: AuthUser, *, workspace_id: str | None, limit: int,
                     before: int | None) -> list[dict]:
    store = auth.read_store()
    ms = await _fresh_memberships(actor)
    limit = max(1, min(int(limit or 100), 500))
    if workspace_id is None:
        if not perms.is_founder(ms):
            raise Refused(400, "workspace_id is required")
        ids = None
    else:
        tree = await _tree(store)
        ws = _visible_or_404(ms, tree.get(workspace_id))
        if not perms.can(ms, ws, perms.AUDIT_VIEW):
            raise Refused(403, "The audit log needs the owner, admin or manager role")
        ids = tree.subtree_ids(ws)
    return [r.public() for r in await store.list_audit(ids, limit, before)]


# ── Zones (docs/ACCESS_MODEL.md section 3) ───────────────────────────────

ZONE_CLASSES = ("green", "orange", "red")
LAYERS = ("regulatory", "area", "site")


async def _zone_rights(ms, tree: Tree, layer: str, workspace_id: str, geometry) -> WorkspaceRecord:
    if layer not in LAYERS:
        raise Refused(400, "layer must be regulatory, area or site")
    ws = tree.get(workspace_id)
    if ws is None:
        raise Refused(404, NOT_FOUND)
    if layer == "regulatory" and ws.kind != perms.PLATFORM:
        raise Refused(400, "Regulatory zones belong to the HYRAK workspace")
    decision = perms.check_zone_layer(ms, ws, layer, geometry)
    # 404 for a customer workspace the caller cannot see; HYRAK's existence
    # is no secret, so a refusal there says why.
    if (not decision.ok and decision.status == 403 and ws.kind != perms.PLATFORM
            and not perms.visible(ms, ws)):
        raise Refused(404, NOT_FOUND)
    _check(decision)
    return ws


async def list_zones() -> list[dict]:
    try:
        store = auth.read_store()
        return [z.to_feature() for z in await store.list_zones()]
    except Exception as e:
        logger.warning(f"zones: list failed: {e}")
        return []


async def create_zone(actor: AuthUser, *, name: str, zone_class: str, geometry: dict,
                      floor_m: float, ceiling_m, layer: str | None, workspace_id: str | None,
                      ip: str, permission_required: bool = True) -> dict:
    store = auth.write_store()
    if zone_class not in ZONE_CLASSES:
        raise Refused(400, "zone_class must be green/orange/red")
    _bad_area(geometry, "geometry")
    ms = await _fresh_memberships(actor)
    tree = await _tree(store)
    layer = layer or "regulatory"
    ws = await _zone_rights(ms, tree, layer, workspace_id or PLATFORM_WORKSPACE_ID, geometry)
    now = utcnow()
    z = ZoneRecord(id=new_id(), name=(name or f"{zone_class} zone").strip()[:120],
                   zone_class=zone_class, geometry=geometry, floor_m=floor_m,
                   ceiling_m=ceiling_m, layer=layer, workspace_id=ws.id,
                   created_by=actor.id, updated_by=actor.id, updated_at=now, created_at=now,
                   permission_required=bool(permission_required))
    out = await store.add_zone(z)
    await audit.record(store, actor, "zone.create", workspace_id=ws.id, target_type="zone",
                       target_id=out.id, detail={"name": out.name, "zone_class": zone_class,
                                                 "layer": layer}, ip=ip)
    return out.to_feature()


async def patch_zone(actor: AuthUser, zone_id: str, fields: dict, *, ip: str) -> dict:
    """fields may hold name, zone_class, floor_m, ceiling_m, active, layer,
    workspace_id, permission_required (geometry changes are delete + redraw)."""
    store = auth.write_store()
    z = await store.get_zone(zone_id)
    if z is None:
        raise Refused(404, "Zone not found")
    ms = await _fresh_memberships(actor)
    tree = await _tree(store)
    # Rights on the zone as it is ...
    await _zone_rights(ms, tree, z.layer, z.workspace_id, z.geometry)
    # ... and as it would become.
    new_layer = fields.get("layer", z.layer)
    new_ws = fields.get("workspace_id", z.workspace_id)
    if (new_layer, new_ws) != (z.layer, z.workspace_id):
        await _zone_rights(ms, tree, new_layer, new_ws, z.geometry)
    if "zone_class" in fields and fields["zone_class"] not in ZONE_CLASSES:
        raise Refused(400, "bad zone_class")
    changes = {k: v for k, v in fields.items()
               if k in ("name", "zone_class", "floor_m", "ceiling_m", "active", "layer", "workspace_id",
                        "permission_required")}
    if not changes:
        return z.to_feature()
    out = await store.update_zone(zone_id, **changes, updated_by=actor.id, updated_at=utcnow())
    await audit.record(store, actor, "zone.update", workspace_id=out.workspace_id,
                       target_type="zone", target_id=zone_id,
                       detail={k: v for k, v in changes.items()}, ip=ip)
    return out.to_feature()


async def delete_zone(actor: AuthUser, zone_id: str, *, ip: str) -> None:
    store = auth.write_store()
    z = await store.get_zone(zone_id)
    if z is None:
        raise Refused(404, "Zone not found")
    ms = await _fresh_memberships(actor)
    tree = await _tree(store)
    await _zone_rights(ms, tree, z.layer, z.workspace_id, z.geometry)
    await store.delete_zone(zone_id)
    await audit.record(store, actor, "zone.delete", workspace_id=z.workspace_id,
                       target_type="zone", target_id=zone_id,
                       detail={"name": z.name, "zone_class": z.zone_class, "layer": z.layer}, ip=ip)
