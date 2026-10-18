"""
Where users, tokens, workspaces, memberships, invites and the audit trail
live.

Two backends behind one interface:

  DbStore      the Postgres tables (SQLAlchemy). The production store.
  MemoryStore  dicts. Holds the platform workspace and the
               HYRAK_ADMIN_USER bootstrap founder so the platform stays
               sign-in-able with the database down, and is the full test
               double (no DB needed).

The service (app/auth/service.py) and the workspace service
(app/workspaces/service.py) pick one; records cross the boundary as plain
dataclasses so neither caller knows which backend answered.

Authorization lives only in memberships. A user record carries no role;
the viewer / operator / admin rank the live paths still use is computed
from memberships (app/auth/perms.compat_role).

Multi-step changes that must be all-or-nothing (accepting an invite,
consuming a reset link) are single store methods: one transaction in
DbStore, no await in between in MemoryStore.
"""
from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
from typing import Optional

from app.db.models import PLATFORM_WORKSPACE_ID

# The compatibility ranks (docs/ACCESS_MODEL.md section 8). Still what
# require_user("operator") and the socket guard compare against.
ROLES = ("viewer", "operator", "admin")
ROLE_RANK = {"viewer": 0, "operator": 1, "admin": 2}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


class StoreConflict(ValueError):
    """A uniqueness rule refused the write (username / email taken, already
    a member). The message is safe to show."""


class InviteUnavailable(Exception):
    """The invite is unknown, used, revoked or expired."""


# ── Records ───────────────────────────────────────────────────────────────

@dataclass
class UserRecord:
    id: str
    username: str
    password_hash: str
    disabled: bool = False
    created_at: datetime = field(default_factory=utcnow)
    email: Optional[str] = None
    display_name: str = ""
    last_login_at: Optional[datetime] = None

    def public(self) -> dict:
        return {
            "id": self.id,
            "username": self.username,
            "email": self.email,
            "display_name": self.display_name,
            "disabled": self.disabled,
            "created_at": _iso(self.created_at),
            "last_login_at": _iso(self.last_login_at),
        }

    def brief(self) -> dict:
        return {"id": self.id, "username": self.username, "email": self.email,
                "display_name": self.display_name}


@dataclass
class TokenRecord:
    id: str
    user_id: str
    token_hash: str
    expires_at: datetime
    created_at: datetime = field(default_factory=utcnow)
    last_seen_at: Optional[datetime] = None
    label: str = ""


@dataclass
class WorkspaceRecord:
    id: str
    kind: str
    name: str
    parent_id: Optional[str]
    path: str
    operating_area: Optional[dict] = None
    disabled: bool = False
    created_by: Optional[str] = None
    created_at: datetime = field(default_factory=utcnow)

    def public(self) -> dict:
        return {
            "id": self.id, "kind": self.kind, "name": self.name,
            "parent_id": self.parent_id, "path": self.path,
            "operating_area": self.operating_area, "disabled": self.disabled,
            "created_at": _iso(self.created_at),
        }


@dataclass
class MembershipRecord:
    id: str
    user_id: str
    workspace_id: str
    role: str
    area: Optional[dict] = None
    title: str = ""
    created_by: Optional[str] = None
    created_at: datetime = field(default_factory=utcnow)
    # Joined from the workspace on read, for the permission engine.
    workspace_path: str = ""
    workspace_kind: str = ""
    workspace_name: str = ""
    workspace_disabled: bool = False

    def public(self) -> dict:
        return {
            "id": self.id, "workspace_id": self.workspace_id,
            "workspace_name": self.workspace_name, "workspace_kind": self.workspace_kind,
            "role": self.role, "area": self.area, "title": self.title,
        }


@dataclass
class InviteRecord:
    id: str
    workspace_id: str
    role: str
    token_hash: str
    expires_at: datetime
    area: Optional[dict] = None
    title: str = ""
    email: Optional[str] = None
    created_by: Optional[str] = None
    created_at: datetime = field(default_factory=utcnow)
    accepted_at: Optional[datetime] = None
    accepted_by: Optional[str] = None
    revoked_at: Optional[datetime] = None

    def usable(self, now: datetime) -> bool:
        return self.accepted_at is None and self.revoked_at is None and self.expires_at > now

    def status(self, now: datetime) -> str:
        if self.accepted_at is not None:
            return "accepted"
        if self.revoked_at is not None:
            return "revoked"
        return "pending" if self.expires_at > now else "expired"

    def public(self, now: Optional[datetime] = None) -> dict:
        now = now or utcnow()
        return {
            "id": self.id, "workspace_id": self.workspace_id, "role": self.role,
            "area": self.area, "title": self.title, "email": self.email,
            "created_by": self.created_by, "created_at": _iso(self.created_at),
            "expires_at": _iso(self.expires_at), "accepted_at": _iso(self.accepted_at),
            "accepted_by": self.accepted_by, "revoked_at": _iso(self.revoked_at),
            "status": self.status(now),
        }


@dataclass
class ResetRecord:
    id: str
    user_id: str
    token_hash: str
    expires_at: datetime
    created_by: Optional[str] = None
    created_at: datetime = field(default_factory=utcnow)
    used_at: Optional[datetime] = None


@dataclass
class AuditRecord:
    action: str
    actor_id: Optional[str] = None
    actor_name: str = ""
    workspace_id: Optional[str] = None
    target_type: str = ""
    target_id: str = ""
    detail: Optional[dict] = None
    ip: str = ""
    at: datetime = field(default_factory=utcnow)
    id: Optional[int] = None

    def public(self) -> dict:
        d = asdict(self)
        d["at"] = _iso(self.at)
        return d


@dataclass
class ZoneRecord:
    id: str
    name: str
    zone_class: str
    geometry: dict
    floor_m: float = 0.0
    ceiling_m: Optional[float] = None
    active: bool = True
    created_at: datetime = field(default_factory=utcnow)
    layer: str = "regulatory"
    workspace_id: str = PLATFORM_WORKSPACE_ID
    created_by: Optional[str] = None
    updated_by: Optional[str] = None
    updated_at: Optional[datetime] = None

    def to_feature(self) -> dict:
        return {
            "type": "Feature",
            "geometry": self.geometry,
            "properties": {
                "id": self.id, "name": self.name, "zone_class": self.zone_class,
                "floor_m": self.floor_m, "ceiling_m": self.ceiling_m,
                "active": self.active, "layer": self.layer,
                "workspace_id": self.workspace_id,
            },
        }


def platform_workspace() -> WorkspaceRecord:
    return WorkspaceRecord(id=PLATFORM_WORKSPACE_ID, kind="platform", name="HYRAK",
                           parent_id=None, path=f"/{PLATFORM_WORKSPACE_ID}/")


def new_id() -> str:
    return str(uuid.uuid4())


# ── MemoryStore ───────────────────────────────────────────────────────────

class MemoryStore:
    """Dict-backed store. Also the test double. No method awaits anything
    in the middle of a change, so each one is atomic under asyncio."""

    def __init__(self) -> None:
        self._users: dict[str, UserRecord] = {}
        self._tokens: dict[str, TokenRecord] = {}        # token_hash -> record
        p = platform_workspace()
        self._workspaces: dict[str, WorkspaceRecord] = {p.id: p}
        self._memberships: dict[str, MembershipRecord] = {}
        self._invites: dict[str, InviteRecord] = {}
        self._resets: dict[str, ResetRecord] = {}
        self._audit: list[AuditRecord] = []
        self._drones: dict[str, dict] = {}
        self._zones: dict[str, ZoneRecord] = {}

    # users -----------------------------------------------------------
    async def get_user_by_username(self, username: str) -> UserRecord | None:
        for u in self._users.values():
            if u.username == username:
                return replace(u)
        return None

    async def get_user_by_email(self, email: str) -> UserRecord | None:
        for u in self._users.values():
            if email and u.email == email:
                return replace(u)
        return None

    async def get_user_by_id(self, user_id: str) -> UserRecord | None:
        u = self._users.get(user_id)
        return replace(u) if u else None

    async def list_users(self) -> list[UserRecord]:
        return [replace(u) for u in sorted(self._users.values(), key=lambda u: u.created_at)]

    def _email_taken(self, email: Optional[str], user_id: str) -> bool:
        return bool(email) and any(u.email == email and u.id != user_id for u in self._users.values())

    async def upsert_user(self, user: UserRecord, *, set_disabled: bool = False) -> UserRecord:
        """Create, or replace the password (and a given email / display name)
        of the user with that username. `disabled` is written only for a new
        user or when set_disabled=True: re-running create-user or the env
        bootstrap must never re-enable a disabled account."""
        existing = next((u for u in self._users.values() if u.username == user.username), None)
        if existing is None:
            if self._email_taken(user.email, user.id):
                raise StoreConflict("That email is already used by another account")
            self._users[user.id] = replace(user)
            return replace(user)
        out = replace(existing, password_hash=user.password_hash)
        if user.email:
            if self._email_taken(user.email, existing.id):
                raise StoreConflict("That email is already used by another account")
            out.email = user.email
        if user.display_name:
            out.display_name = user.display_name
        if set_disabled:
            out.disabled = user.disabled
        self._users[existing.id] = out
        return replace(out)

    async def update_user(self, user_id: str, **fields) -> UserRecord | None:
        u = self._users.get(user_id)
        if u is None:
            return None
        if "email" in fields and self._email_taken(fields["email"], user_id):
            raise StoreConflict("That email is already used by another account")
        u = replace(u, **fields)
        self._users[user_id] = u
        return replace(u)

    async def delete_user(self, user_id: str) -> bool:
        if self._users.pop(user_id, None) is None:
            return False
        for h in [h for h, t in self._tokens.items() if t.user_id == user_id]:
            self._tokens.pop(h, None)
        for mid in [k for k, m in self._memberships.items() if m.user_id == user_id]:
            self._memberships.pop(mid, None)
        for rid in [k for k, r in self._resets.items() if r.user_id == user_id]:
            self._resets.pop(rid, None)
        return True

    # tokens ----------------------------------------------------------
    async def add_token(self, token: TokenRecord) -> None:
        self._tokens[token.token_hash] = replace(token)

    async def get_token(self, token_hash: str) -> TokenRecord | None:
        t = self._tokens.get(token_hash)
        return replace(t) if t else None

    async def touch_token(self, token_hash: str, expires_at: datetime, seen_at: datetime) -> None:
        t = self._tokens.get(token_hash)
        if t is not None:
            self._tokens[token_hash] = replace(t, expires_at=expires_at, last_seen_at=seen_at)

    async def delete_token(self, token_hash: str) -> None:
        self._tokens.pop(token_hash, None)

    async def delete_tokens_for_user(self, user_id: str, *, keep_hash: Optional[str] = None) -> int:
        hs = [h for h, t in self._tokens.items() if t.user_id == user_id and h != keep_hash]
        for h in hs:
            self._tokens.pop(h, None)
        return len(hs)

    async def list_tokens(self, user_id: str) -> list[TokenRecord]:
        return sorted((replace(t) for t in self._tokens.values() if t.user_id == user_id),
                      key=lambda t: t.created_at)

    async def delete_token_by_id(self, user_id: str, token_id: str) -> Optional[str]:
        for h, t in list(self._tokens.items()):
            if t.id == token_id and t.user_id == user_id:
                self._tokens.pop(h, None)
                return h
        return None

    # workspaces ------------------------------------------------------
    async def get_workspace(self, workspace_id: str) -> WorkspaceRecord | None:
        w = self._workspaces.get(workspace_id)
        return replace(w) if w else None

    async def list_workspaces(self) -> list[WorkspaceRecord]:
        return [replace(w) for w in sorted(self._workspaces.values(), key=lambda w: w.path)]

    async def create_workspace(self, ws: WorkspaceRecord) -> WorkspaceRecord:
        self._workspaces[ws.id] = replace(ws)
        return replace(ws)

    async def update_workspace(self, workspace_id: str, **fields) -> WorkspaceRecord | None:
        w = self._workspaces.get(workspace_id)
        if w is None:
            return None
        w = replace(w, **fields)
        self._workspaces[workspace_id] = w
        return replace(w)

    async def workspace_usage(self, workspace_id: str) -> dict:
        return {
            "children": sum(1 for w in self._workspaces.values() if w.parent_id == workspace_id),
            "drones": sum(1 for d in self._drones.values() if d.get("workspace_id") == workspace_id),
            "zones": sum(1 for z in self._zones.values() if z.workspace_id == workspace_id),
        }

    async def delete_workspace(self, workspace_id: str) -> bool:
        if self._workspaces.pop(workspace_id, None) is None:
            return False
        for d in (self._memberships, self._invites):
            for k in [k for k, v in d.items() if v.workspace_id == workspace_id]:
                d.pop(k, None)
        return True

    # memberships -----------------------------------------------------
    def _joined(self, m: MembershipRecord) -> MembershipRecord:
        w = self._workspaces.get(m.workspace_id)
        if w is None:
            return replace(m)
        return replace(m, workspace_path=w.path, workspace_kind=w.kind,
                       workspace_name=w.name, workspace_disabled=w.disabled)

    async def memberships_for_user(self, user_id: str) -> list[MembershipRecord]:
        return [self._joined(m) for m in sorted(self._memberships.values(), key=lambda m: m.created_at)
                if m.user_id == user_id]

    async def memberships_for_workspaces(self, workspace_ids: list[str]) -> list[MembershipRecord]:
        ids = set(workspace_ids)
        return [self._joined(m) for m in sorted(self._memberships.values(), key=lambda m: m.created_at)
                if m.workspace_id in ids]

    async def get_membership(self, membership_id: str) -> MembershipRecord | None:
        m = self._memberships.get(membership_id)
        return self._joined(m) if m else None

    async def add_membership(self, m: MembershipRecord) -> MembershipRecord:
        if any(x.user_id == m.user_id and x.workspace_id == m.workspace_id
               for x in self._memberships.values()):
            raise StoreConflict("That account is already a member of this workspace")
        self._memberships[m.id] = replace(m)
        return self._joined(m)

    async def update_membership(self, membership_id: str, **fields) -> MembershipRecord | None:
        m = self._memberships.get(membership_id)
        if m is None:
            return None
        m = replace(m, **fields)
        self._memberships[membership_id] = m
        return self._joined(m)

    async def delete_membership(self, membership_id: str) -> bool:
        return self._memberships.pop(membership_id, None) is not None

    async def count_role(self, workspace_id: str, role: str) -> int:
        return sum(1 for m in self._memberships.values()
                   if m.workspace_id == workspace_id and m.role == role
                   and not getattr(self._users.get(m.user_id), "disabled", True))

    # invites ---------------------------------------------------------
    async def add_invite(self, inv: InviteRecord) -> InviteRecord:
        self._invites[inv.id] = replace(inv)
        return replace(inv)

    async def get_invite(self, invite_id: str) -> InviteRecord | None:
        i = self._invites.get(invite_id)
        return replace(i) if i else None

    async def get_invite_by_hash(self, token_hash: str) -> InviteRecord | None:
        for i in self._invites.values():
            if i.token_hash == token_hash:
                return replace(i)
        return None

    async def list_invites(self, workspace_id: str) -> list[InviteRecord]:
        return [replace(i) for i in sorted(self._invites.values(), key=lambda i: i.created_at)
                if i.workspace_id == workspace_id]

    async def revoke_invite(self, invite_id: str, now: datetime) -> bool:
        i = self._invites.get(invite_id)
        if i is None or i.accepted_at is not None or i.revoked_at is not None:
            return False
        self._invites[invite_id] = replace(i, revoked_at=now)
        return True

    async def accept_invite(self, token_hash: str, now: datetime, *, user_id: str,
                            new_user: Optional[UserRecord], membership: MembershipRecord) -> InviteRecord:
        """Claim the invite, create the account (if new_user) and add the
        membership, all or nothing. Raises InviteUnavailable or StoreConflict."""
        inv = next((i for i in self._invites.values() if i.token_hash == token_hash), None)
        if inv is None or not inv.usable(now):
            raise InviteUnavailable()
        if new_user is not None:
            if any(u.username == new_user.username for u in self._users.values()):
                raise StoreConflict("That username is taken")
            if self._email_taken(new_user.email, new_user.id):
                raise StoreConflict("An account with this email already exists")
        if any(x.user_id == user_id and x.workspace_id == membership.workspace_id
               for x in self._memberships.values()):
            raise StoreConflict("You are already a member of this workspace")
        if new_user is not None:
            self._users[new_user.id] = replace(new_user)
        self._memberships[membership.id] = replace(membership)
        claimed = replace(inv, accepted_at=now, accepted_by=user_id)
        self._invites[inv.id] = claimed
        return replace(claimed)

    # password resets -------------------------------------------------
    async def add_reset(self, r: ResetRecord) -> None:
        self._resets[r.id] = replace(r)

    async def consume_reset(self, token_hash: str, now: datetime, password_hash: str) -> Optional[str]:
        """Mark the reset used and set the password; returns the user id, or
        None if the link is unknown, used or expired."""
        r = next((x for x in self._resets.values() if x.token_hash == token_hash), None)
        if r is None or r.used_at is not None or r.expires_at <= now:
            return None
        u = self._users.get(r.user_id)
        if u is None:
            return None
        self._resets[r.id] = replace(r, used_at=now)
        self._users[u.id] = replace(u, password_hash=password_hash)
        return u.id

    # audit -----------------------------------------------------------
    async def add_audit(self, rec: AuditRecord) -> None:
        rec = replace(rec, id=len(self._audit) + 1)
        self._audit.append(rec)

    async def list_audit(self, workspace_ids: Optional[list[str]], limit: int,
                         before: Optional[int]) -> list[AuditRecord]:
        ids = set(workspace_ids) if workspace_ids is not None else None
        out = []
        for rec in reversed(self._audit):
            if before is not None and rec.id >= before:
                continue
            if ids is not None and rec.workspace_id not in ids:
                continue
            out.append(replace(rec))
            if len(out) >= limit:
                break
        return out

    # drones ----------------------------------------------------------
    async def list_drones(self, workspace_ids: Optional[list[str]] = None) -> list[dict]:
        ids = set(workspace_ids) if workspace_ids is not None else None
        return [dict(d) for d in self._drones.values()
                if ids is None or d.get("workspace_id") in ids]

    async def get_drone(self, drone_id: str) -> dict | None:
        d = self._drones.get(drone_id)
        return dict(d) if d else None

    async def set_drone_workspace(self, drone_id: str, workspace_id: str) -> dict | None:
        d = self._drones.get(drone_id)
        if d is None:
            return None
        d["workspace_id"] = workspace_id
        return dict(d)

    # zones -----------------------------------------------------------
    async def list_zones(self) -> list[ZoneRecord]:
        return [replace(z) for z in sorted(self._zones.values(), key=lambda z: z.created_at)]

    async def get_zone(self, zone_id: str) -> ZoneRecord | None:
        z = self._zones.get(zone_id)
        return replace(z) if z else None

    async def add_zone(self, z: ZoneRecord) -> ZoneRecord:
        self._zones[z.id] = replace(z)
        return replace(z)

    async def update_zone(self, zone_id: str, **fields) -> ZoneRecord | None:
        z = self._zones.get(zone_id)
        if z is None:
            return None
        z = replace(z, **fields)
        self._zones[zone_id] = z
        return replace(z)

    async def delete_zone(self, zone_id: str) -> bool:
        return self._zones.pop(zone_id, None) is not None


# ── DbStore ───────────────────────────────────────────────────────────────

def _is_unique_violation(e: Exception) -> bool:
    text = str(getattr(e, "orig", e)).lower()
    return "unique" in text or "duplicate key" in text


class DbStore:
    """The Postgres tables. Every method assumes db_available() was checked
    by the caller; a failing query propagates so the service can decide
    (it fails closed for anything that grants access)."""

    @staticmethod
    def _session():
        from app.db import get_session
        return get_session()

    # users -----------------------------------------------------------
    async def _user_where(self, clause) -> UserRecord | None:
        from sqlalchemy import select
        from app.db.models import User
        async with self._session() as db:
            row = (await db.execute(select(User).where(clause))).scalar_one_or_none()
        return _user_of(row) if row else None

    async def get_user_by_username(self, username: str) -> UserRecord | None:
        from app.db.models import User
        return await self._user_where(User.username == username)

    async def get_user_by_email(self, email: str) -> UserRecord | None:
        from app.db.models import User
        if not email:
            return None
        return await self._user_where(User.email == email)

    async def get_user_by_id(self, user_id: str) -> UserRecord | None:
        from app.db.models import User
        return await self._user_where(User.id == user_id)

    async def list_users(self) -> list[UserRecord]:
        from sqlalchemy import select
        from app.db.models import User
        async with self._session() as db:
            rows = (await db.execute(select(User).order_by(User.created_at))).scalars().all()
        return [_user_of(r) for r in rows]

    async def upsert_user(self, user: UserRecord, *, set_disabled: bool = False) -> UserRecord:
        """See MemoryStore.upsert_user: `disabled` is written only for a new
        user or when set_disabled=True."""
        from sqlalchemy import select
        from sqlalchemy.exc import IntegrityError
        from app.db.models import User
        async with self._session() as db:
            row = (await db.execute(select(User).where(User.username == user.username))).scalar_one_or_none()
            if row is None:
                row = User(id=user.id or new_id(), username=user.username,
                           password_hash=user.password_hash, disabled=user.disabled,
                           email=user.email, display_name=user.display_name or "")
                db.add(row)
            else:
                row.password_hash = user.password_hash
                if user.email:
                    row.email = user.email
                if user.display_name:
                    row.display_name = user.display_name
                if set_disabled:
                    row.disabled = user.disabled
            try:
                await db.commit()
            except IntegrityError as e:
                await db.rollback()
                if _is_unique_violation(e):
                    raise StoreConflict("That username or email is already used by another account")
                raise
            return _user_of(row)

    async def update_user(self, user_id: str, **fields) -> UserRecord | None:
        from sqlalchemy import select
        from sqlalchemy.exc import IntegrityError
        from app.db.models import User
        async with self._session() as db:
            row = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
            if row is None:
                return None
            for k, v in fields.items():
                setattr(row, k, v)
            try:
                await db.commit()
            except IntegrityError as e:
                await db.rollback()
                if _is_unique_violation(e):
                    raise StoreConflict("That email is already used by another account")
                raise
            return _user_of(row)

    async def delete_user(self, user_id: str) -> bool:
        from sqlalchemy import delete as sa_delete
        from app.db.models import User
        async with self._session() as db:
            res = await db.execute(sa_delete(User).where(User.id == user_id))
            await db.commit()
            return bool(res.rowcount)

    # tokens ----------------------------------------------------------
    async def add_token(self, token: TokenRecord) -> None:
        from app.db.models import AuthToken
        async with self._session() as db:
            db.add(AuthToken(id=token.id, user_id=token.user_id, token_hash=token.token_hash,
                             expires_at=token.expires_at, created_at=token.created_at,
                             last_seen_at=token.last_seen_at, label=token.label))
            await db.commit()

    async def get_token(self, token_hash: str) -> TokenRecord | None:
        from sqlalchemy import select
        from app.db.models import AuthToken
        async with self._session() as db:
            row = (await db.execute(
                select(AuthToken).where(AuthToken.token_hash == token_hash)
            )).scalar_one_or_none()
        return _token_of(row) if row else None

    async def touch_token(self, token_hash: str, expires_at: datetime, seen_at: datetime) -> None:
        from sqlalchemy import update
        from app.db.models import AuthToken
        async with self._session() as db:
            await db.execute(update(AuthToken).where(AuthToken.token_hash == token_hash)
                             .values(expires_at=expires_at, last_seen_at=seen_at))
            await db.commit()

    async def delete_token(self, token_hash: str) -> None:
        from sqlalchemy import delete as sa_delete
        from app.db.models import AuthToken
        async with self._session() as db:
            await db.execute(sa_delete(AuthToken).where(AuthToken.token_hash == token_hash))
            await db.commit()

    async def delete_tokens_for_user(self, user_id: str, *, keep_hash: Optional[str] = None) -> int:
        from sqlalchemy import delete as sa_delete
        from app.db.models import AuthToken
        q = sa_delete(AuthToken).where(AuthToken.user_id == user_id)
        if keep_hash:
            q = q.where(AuthToken.token_hash != keep_hash)
        async with self._session() as db:
            res = await db.execute(q)
            await db.commit()
            return int(res.rowcount or 0)

    async def list_tokens(self, user_id: str) -> list[TokenRecord]:
        from sqlalchemy import select
        from app.db.models import AuthToken
        async with self._session() as db:
            rows = (await db.execute(select(AuthToken).where(AuthToken.user_id == user_id)
                                     .order_by(AuthToken.created_at))).scalars().all()
        return [_token_of(r) for r in rows]

    async def delete_token_by_id(self, user_id: str, token_id: str) -> Optional[str]:
        from sqlalchemy import delete as sa_delete
        from app.db.models import AuthToken
        async with self._session() as db:
            res = await db.execute(
                sa_delete(AuthToken)
                .where(AuthToken.id == token_id, AuthToken.user_id == user_id)
                .returning(AuthToken.token_hash))
            h = res.scalar_one_or_none()
            await db.commit()
            return h

    # workspaces ------------------------------------------------------
    async def get_workspace(self, workspace_id: str) -> WorkspaceRecord | None:
        from sqlalchemy import select
        from app.db.models import Workspace
        async with self._session() as db:
            row = (await db.execute(select(Workspace).where(Workspace.id == workspace_id))).scalar_one_or_none()
        return _workspace_of(row) if row else None

    async def list_workspaces(self) -> list[WorkspaceRecord]:
        from sqlalchemy import select
        from app.db.models import Workspace
        async with self._session() as db:
            rows = (await db.execute(select(Workspace).order_by(Workspace.path))).scalars().all()
        return [_workspace_of(r) for r in rows]

    async def create_workspace(self, ws: WorkspaceRecord) -> WorkspaceRecord:
        from app.db.models import Workspace
        async with self._session() as db:
            row = Workspace(id=ws.id, kind=ws.kind, name=ws.name, parent_id=ws.parent_id,
                            path=ws.path, operating_area=ws.operating_area,
                            disabled=ws.disabled, created_by=ws.created_by,
                            created_at=ws.created_at)
            db.add(row)
            await db.commit()
            return _workspace_of(row)

    async def update_workspace(self, workspace_id: str, **fields) -> WorkspaceRecord | None:
        from sqlalchemy import select
        from app.db.models import Workspace
        async with self._session() as db:
            row = (await db.execute(select(Workspace).where(Workspace.id == workspace_id))).scalar_one_or_none()
            if row is None:
                return None
            for k, v in fields.items():
                setattr(row, k, v)
            await db.commit()
            return _workspace_of(row)

    async def workspace_usage(self, workspace_id: str) -> dict:
        from sqlalchemy import func, select
        from app.db.models import Drone, Workspace, Zone
        async with self._session() as db:
            children = (await db.execute(select(func.count()).select_from(Workspace)
                                         .where(Workspace.parent_id == workspace_id))).scalar_one()
            drones = (await db.execute(select(func.count()).select_from(Drone)
                                       .where(Drone.workspace_id == workspace_id))).scalar_one()
            zones = (await db.execute(select(func.count()).select_from(Zone)
                                      .where(Zone.workspace_id == workspace_id))).scalar_one()
        return {"children": int(children), "drones": int(drones), "zones": int(zones)}

    async def delete_workspace(self, workspace_id: str) -> bool:
        from sqlalchemy import delete as sa_delete
        from app.db.models import Workspace
        async with self._session() as db:
            res = await db.execute(sa_delete(Workspace).where(Workspace.id == workspace_id))
            await db.commit()
            return bool(res.rowcount)

    # memberships -----------------------------------------------------
    async def _memberships_where(self, *clauses) -> list[MembershipRecord]:
        from sqlalchemy import select
        from app.db.models import Membership, Workspace
        async with self._session() as db:
            rows = (await db.execute(
                select(Membership, Workspace)
                .join(Workspace, Workspace.id == Membership.workspace_id)
                .where(*clauses).order_by(Membership.created_at)
            )).all()
        return [_membership_of(m, w) for m, w in rows]

    async def memberships_for_user(self, user_id: str) -> list[MembershipRecord]:
        from app.db.models import Membership
        return await self._memberships_where(Membership.user_id == user_id)

    async def memberships_for_workspaces(self, workspace_ids: list[str]) -> list[MembershipRecord]:
        from app.db.models import Membership
        if not workspace_ids:
            return []
        return await self._memberships_where(Membership.workspace_id.in_(list(workspace_ids)))

    async def get_membership(self, membership_id: str) -> MembershipRecord | None:
        from app.db.models import Membership
        rows = await self._memberships_where(Membership.id == membership_id)
        return rows[0] if rows else None

    async def add_membership(self, m: MembershipRecord) -> MembershipRecord:
        from sqlalchemy.exc import IntegrityError
        from app.db.models import Membership
        async with self._session() as db:
            db.add(Membership(id=m.id, user_id=m.user_id, workspace_id=m.workspace_id,
                              role=m.role, area=m.area, title=m.title or "",
                              created_by=m.created_by, created_at=m.created_at))
            try:
                await db.commit()
            except IntegrityError as e:
                await db.rollback()
                if _is_unique_violation(e):
                    raise StoreConflict("That account is already a member of this workspace")
                raise
        return await self.get_membership(m.id)

    async def update_membership(self, membership_id: str, **fields) -> MembershipRecord | None:
        from sqlalchemy import update
        from app.db.models import Membership
        async with self._session() as db:
            res = await db.execute(update(Membership).where(Membership.id == membership_id)
                                   .values(**fields))
            await db.commit()
            if not res.rowcount:
                return None
        return await self.get_membership(membership_id)

    async def delete_membership(self, membership_id: str) -> bool:
        from sqlalchemy import delete as sa_delete
        from app.db.models import Membership
        async with self._session() as db:
            res = await db.execute(sa_delete(Membership).where(Membership.id == membership_id))
            await db.commit()
            return bool(res.rowcount)

    async def count_role(self, workspace_id: str, role: str) -> int:
        """Members with that role on that workspace whose account is active
        (a disabled last owner does not count as an owner)."""
        from sqlalchemy import func, select
        from app.db.models import Membership, User
        async with self._session() as db:
            n = (await db.execute(
                select(func.count()).select_from(Membership)
                .join(User, User.id == Membership.user_id)
                .where(Membership.workspace_id == workspace_id, Membership.role == role,
                       User.disabled.is_(False))
            )).scalar_one()
        return int(n)

    # invites ---------------------------------------------------------
    async def add_invite(self, inv: InviteRecord) -> InviteRecord:
        from app.db.models import Invite
        async with self._session() as db:
            db.add(Invite(**_invite_cols(inv)))
            await db.commit()
        return inv

    async def _invite_where(self, clause) -> InviteRecord | None:
        from sqlalchemy import select
        from app.db.models import Invite
        async with self._session() as db:
            row = (await db.execute(select(Invite).where(clause))).scalar_one_or_none()
        return _invite_of(row) if row else None

    async def get_invite(self, invite_id: str) -> InviteRecord | None:
        from app.db.models import Invite
        return await self._invite_where(Invite.id == invite_id)

    async def get_invite_by_hash(self, token_hash: str) -> InviteRecord | None:
        from app.db.models import Invite
        return await self._invite_where(Invite.token_hash == token_hash)

    async def list_invites(self, workspace_id: str) -> list[InviteRecord]:
        from sqlalchemy import select
        from app.db.models import Invite
        async with self._session() as db:
            rows = (await db.execute(select(Invite).where(Invite.workspace_id == workspace_id)
                                     .order_by(Invite.created_at))).scalars().all()
        return [_invite_of(r) for r in rows]

    async def revoke_invite(self, invite_id: str, now: datetime) -> bool:
        from sqlalchemy import update
        from app.db.models import Invite
        async with self._session() as db:
            res = await db.execute(
                update(Invite).where(Invite.id == invite_id, Invite.accepted_at.is_(None),
                                     Invite.revoked_at.is_(None))
                .values(revoked_at=now))
            await db.commit()
            return bool(res.rowcount)

    async def accept_invite(self, token_hash: str, now: datetime, *, user_id: str,
                            new_user: Optional[UserRecord], membership: MembershipRecord) -> InviteRecord:
        """One transaction. The conditional UPDATE is the single-use gate:
        a concurrent second accept blocks on the row lock, re-evaluates the
        WHERE after the first commits, and claims nothing."""
        from sqlalchemy import update
        from sqlalchemy.exc import IntegrityError
        from app.db.models import Invite, Membership, User
        async with self._session() as db:
            row = (await db.execute(
                update(Invite)
                .where(Invite.token_hash == token_hash, Invite.accepted_at.is_(None),
                       Invite.revoked_at.is_(None), Invite.expires_at > now)
                .values(accepted_at=now, accepted_by=user_id)
                .returning(Invite)
            )).scalar_one_or_none()
            if row is None:
                await db.rollback()
                raise InviteUnavailable()
            claimed = _invite_of(row)
            if new_user is not None:
                db.add(User(id=new_user.id, username=new_user.username,
                            password_hash=new_user.password_hash, disabled=False,
                            email=new_user.email, display_name=new_user.display_name or "",
                            created_at=new_user.created_at))
                await db.flush()
            db.add(Membership(id=membership.id, user_id=user_id,
                              workspace_id=membership.workspace_id, role=membership.role,
                              area=membership.area, title=membership.title or "",
                              created_by=membership.created_by, created_at=membership.created_at))
            try:
                await db.commit()
            except IntegrityError as e:
                await db.rollback()
                if _is_unique_violation(e):
                    raise StoreConflict("That username or email is taken, or you are already "
                                        "a member of this workspace")
                raise
        return claimed

    # password resets -------------------------------------------------
    async def add_reset(self, r: ResetRecord) -> None:
        from app.db.models import PasswordReset
        async with self._session() as db:
            db.add(PasswordReset(id=r.id, user_id=r.user_id, token_hash=r.token_hash,
                                 created_by=r.created_by, created_at=r.created_at,
                                 expires_at=r.expires_at))
            await db.commit()

    async def consume_reset(self, token_hash: str, now: datetime, password_hash: str) -> Optional[str]:
        from sqlalchemy import update
        from app.db.models import PasswordReset, User
        async with self._session() as db:
            user_id = (await db.execute(
                update(PasswordReset)
                .where(PasswordReset.token_hash == token_hash, PasswordReset.used_at.is_(None),
                       PasswordReset.expires_at > now)
                .values(used_at=now).returning(PasswordReset.user_id)
            )).scalar_one_or_none()
            if user_id is None:
                await db.rollback()
                return None
            await db.execute(update(User).where(User.id == user_id)
                             .values(password_hash=password_hash))
            await db.commit()
            return user_id

    # audit -----------------------------------------------------------
    async def add_audit(self, rec: AuditRecord) -> None:
        from app.db.models import AuditEvent
        async with self._session() as db:
            db.add(AuditEvent(at=rec.at, actor_id=rec.actor_id, actor_name=(rec.actor_name or "")[:64],
                              workspace_id=rec.workspace_id, action=rec.action[:64],
                              target_type=(rec.target_type or "")[:32],
                              target_id=str(rec.target_id or "")[:64],
                              detail=rec.detail, ip=(rec.ip or "")[:64]))
            await db.commit()

    async def list_audit(self, workspace_ids: Optional[list[str]], limit: int,
                         before: Optional[int]) -> list[AuditRecord]:
        from sqlalchemy import select
        from app.db.models import AuditEvent
        q = select(AuditEvent).order_by(AuditEvent.id.desc()).limit(limit)
        if workspace_ids is not None:
            q = q.where(AuditEvent.workspace_id.in_(list(workspace_ids)))
        if before is not None:
            q = q.where(AuditEvent.id < before)
        async with self._session() as db:
            rows = (await db.execute(q)).scalars().all()
        return [AuditRecord(id=r.id, at=r.at, actor_id=r.actor_id, actor_name=r.actor_name,
                            workspace_id=r.workspace_id, action=r.action,
                            target_type=r.target_type, target_id=r.target_id,
                            detail=r.detail, ip=r.ip) for r in rows]

    # drones ----------------------------------------------------------
    async def list_drones(self, workspace_ids: Optional[list[str]] = None) -> list[dict]:
        from sqlalchemy import select
        from app.db.models import Drone
        q = select(Drone).order_by(Drone.last_seen.desc())
        if workspace_ids is not None:
            q = q.where(Drone.workspace_id.in_(list(workspace_ids)))
        async with self._session() as db:
            rows = (await db.execute(q)).scalars().all()
        return [d.to_dict() for d in rows]

    async def get_drone(self, drone_id: str) -> dict | None:
        from sqlalchemy import select
        from app.db.models import Drone
        async with self._session() as db:
            row = (await db.execute(select(Drone).where(Drone.id == drone_id))).scalar_one_or_none()
        return row.to_dict() if row else None

    async def set_drone_workspace(self, drone_id: str, workspace_id: str) -> dict | None:
        from sqlalchemy import select
        from app.db.models import Drone
        async with self._session() as db:
            row = (await db.execute(select(Drone).where(Drone.id == drone_id))).scalar_one_or_none()
            if row is None:
                return None
            row.workspace_id = workspace_id
            await db.commit()
            return row.to_dict()

    # zones -----------------------------------------------------------
    async def list_zones(self) -> list[ZoneRecord]:
        from sqlalchemy import select
        from app.db.models import Zone
        async with self._session() as db:
            rows = (await db.execute(select(Zone).order_by(Zone.created_at))).scalars().all()
        return [_zone_of(z) for z in rows]

    async def get_zone(self, zone_id: str) -> ZoneRecord | None:
        from sqlalchemy import select
        from app.db.models import Zone
        async with self._session() as db:
            row = (await db.execute(select(Zone).where(Zone.id == zone_id))).scalar_one_or_none()
        return _zone_of(row) if row else None

    async def add_zone(self, z: ZoneRecord) -> ZoneRecord:
        from app.db.models import Zone
        async with self._session() as db:
            row = Zone(id=z.id, name=z.name, zone_class=z.zone_class, geometry=z.geometry,
                       floor_m=z.floor_m, ceiling_m=z.ceiling_m, active=z.active,
                       created_at=z.created_at, layer=z.layer, workspace_id=z.workspace_id,
                       created_by=z.created_by, updated_by=z.updated_by, updated_at=z.updated_at)
            db.add(row)
            await db.commit()
            return _zone_of(row)

    async def update_zone(self, zone_id: str, **fields) -> ZoneRecord | None:
        from sqlalchemy import select
        from app.db.models import Zone
        async with self._session() as db:
            row = (await db.execute(select(Zone).where(Zone.id == zone_id))).scalar_one_or_none()
            if row is None:
                return None
            for k, v in fields.items():
                setattr(row, k, v)
            await db.commit()
            return _zone_of(row)

    async def delete_zone(self, zone_id: str) -> bool:
        from sqlalchemy import delete as sa_delete
        from app.db.models import Zone
        async with self._session() as db:
            res = await db.execute(sa_delete(Zone).where(Zone.id == zone_id))
            await db.commit()
            return bool(res.rowcount)


# ── row -> record ─────────────────────────────────────────────────────────

def _user_of(row) -> UserRecord:
    return UserRecord(id=row.id, username=row.username, password_hash=row.password_hash,
                      disabled=bool(row.disabled), created_at=row.created_at,
                      email=row.email, display_name=row.display_name or "",
                      last_login_at=row.last_login_at)


def _token_of(row) -> TokenRecord:
    return TokenRecord(id=row.id, user_id=row.user_id, token_hash=row.token_hash,
                       expires_at=row.expires_at, created_at=row.created_at,
                       last_seen_at=row.last_seen_at, label=row.label or "")


def _workspace_of(row) -> WorkspaceRecord:
    return WorkspaceRecord(id=row.id, kind=row.kind, name=row.name, parent_id=row.parent_id,
                           path=row.path, operating_area=row.operating_area,
                           disabled=bool(row.disabled), created_by=row.created_by,
                           created_at=row.created_at)


def _membership_of(m, w) -> MembershipRecord:
    return MembershipRecord(id=m.id, user_id=m.user_id, workspace_id=m.workspace_id,
                            role=m.role, area=m.area, title=m.title or "",
                            created_by=m.created_by, created_at=m.created_at,
                            workspace_path=w.path, workspace_kind=w.kind,
                            workspace_name=w.name, workspace_disabled=bool(w.disabled))


def _invite_cols(inv: InviteRecord) -> dict:
    return {"id": inv.id, "workspace_id": inv.workspace_id, "role": inv.role, "area": inv.area,
            "title": inv.title or "", "email": inv.email, "token_hash": inv.token_hash,
            "created_by": inv.created_by, "created_at": inv.created_at,
            "expires_at": inv.expires_at, "accepted_at": inv.accepted_at,
            "accepted_by": inv.accepted_by, "revoked_at": inv.revoked_at}


def _invite_of(row) -> InviteRecord:
    return InviteRecord(id=row.id, workspace_id=row.workspace_id, role=row.role,
                        token_hash=row.token_hash, expires_at=row.expires_at, area=row.area,
                        title=row.title or "", email=row.email, created_by=row.created_by,
                        created_at=row.created_at, accepted_at=row.accepted_at,
                        accepted_by=row.accepted_by, revoked_at=row.revoked_at)


def _zone_of(row) -> ZoneRecord:
    return ZoneRecord(id=row.id, name=row.name, zone_class=row.zone_class,
                      geometry=row.geometry, floor_m=row.floor_m, ceiling_m=row.ceiling_m,
                      active=bool(row.active), created_at=row.created_at,
                      layer=row.layer or "regulatory", workspace_id=row.workspace_id,
                      created_by=row.created_by, updated_by=row.updated_by,
                      updated_at=row.updated_at)
