"""
Where users and tokens live.

Two backends behind one small interface:

  DbStore      the users / auth_tokens tables (Postgres via SQLAlchemy).
  MemoryStore  a dict. Holds the HYRAK_ADMIN_USER bootstrap admin so the
               platform stays sign-in-able with the database down, and is
               what the tests use (no DB needed).

The service (app/auth/service.py) consults the DB when it is available and
falls back to memory otherwise. Records cross the boundary as plain
dataclasses so neither caller knows which backend answered.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Optional

ROLES = ("viewer", "operator", "admin")
ROLE_RANK = {"viewer": 0, "operator": 1, "admin": 2}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class UserRecord:
    id: str
    username: str
    password_hash: str
    role: str
    disabled: bool = False
    created_at: datetime = field(default_factory=utcnow)

    def public(self) -> dict:
        return {
            "id": self.id,
            "username": self.username,
            "role": self.role,
            "disabled": self.disabled,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


@dataclass
class TokenRecord:
    id: str
    user_id: str
    token_hash: str
    expires_at: datetime
    created_at: datetime = field(default_factory=utcnow)
    last_seen_at: Optional[datetime] = None
    label: str = ""


class MemoryStore:
    """Dict-backed store. Also the test double."""

    def __init__(self) -> None:
        self._users: dict[str, UserRecord] = {}
        self._tokens: dict[str, TokenRecord] = {}   # token_hash -> record

    # users -----------------------------------------------------------
    async def get_user_by_username(self, username: str) -> UserRecord | None:
        for u in self._users.values():
            if u.username == username:
                return replace(u)
        return None

    async def get_user_by_id(self, user_id: str) -> UserRecord | None:
        u = self._users.get(user_id)
        return replace(u) if u else None

    async def list_users(self) -> list[UserRecord]:
        return [replace(u) for u in sorted(self._users.values(), key=lambda u: u.created_at)]

    async def upsert_user(self, user: UserRecord) -> UserRecord:
        existing = await self.get_user_by_username(user.username)
        if existing is not None:
            user = replace(user, id=existing.id, created_at=existing.created_at)
        self._users[user.id] = replace(user)
        return replace(user)

    async def update_user(self, user_id: str, **fields) -> UserRecord | None:
        u = self._users.get(user_id)
        if u is None:
            return None
        u = replace(u, **fields)
        self._users[user_id] = u
        return replace(u)

    async def delete_user(self, user_id: str) -> bool:
        if self._users.pop(user_id, None) is None:
            return False
        for h in [h for h, t in self._tokens.items() if t.user_id == user_id]:
            self._tokens.pop(h, None)
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

    async def delete_tokens_for_user(self, user_id: str) -> int:
        hs = [h for h, t in self._tokens.items() if t.user_id == user_id]
        for h in hs:
            self._tokens.pop(h, None)
        return len(hs)


class DbStore:
    """The users / auth_tokens tables. Every method assumes db_available()
    was checked by the caller; a failing query propagates so the service can
    fall back to its cache or the memory store."""

    async def get_user_by_username(self, username: str) -> UserRecord | None:
        from sqlalchemy import select
        from app.db import get_session
        from app.db.models import User
        async with get_session() as db:
            row = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
        return _user_of(row) if row else None

    async def get_user_by_id(self, user_id: str) -> UserRecord | None:
        from sqlalchemy import select
        from app.db import get_session
        from app.db.models import User
        async with get_session() as db:
            row = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
        return _user_of(row) if row else None

    async def list_users(self) -> list[UserRecord]:
        from sqlalchemy import select
        from app.db import get_session
        from app.db.models import User
        async with get_session() as db:
            rows = (await db.execute(select(User).order_by(User.created_at))).scalars().all()
        return [_user_of(r) for r in rows]

    async def upsert_user(self, user: UserRecord) -> UserRecord:
        from sqlalchemy import select
        from app.db import get_session
        from app.db.models import User
        async with get_session() as db:
            row = (await db.execute(select(User).where(User.username == user.username))).scalar_one_or_none()
            if row is None:
                row = User(id=user.id or str(uuid.uuid4()), username=user.username,
                           password_hash=user.password_hash, role=user.role,
                           disabled=user.disabled)
                db.add(row)
            else:
                row.password_hash = user.password_hash
                row.role = user.role
                row.disabled = user.disabled
            await db.commit()
            return _user_of(row)

    async def update_user(self, user_id: str, **fields) -> UserRecord | None:
        from sqlalchemy import select
        from app.db import get_session
        from app.db.models import User
        async with get_session() as db:
            row = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
            if row is None:
                return None
            for k, v in fields.items():
                setattr(row, k, v)
            await db.commit()
            return _user_of(row)

    async def delete_user(self, user_id: str) -> bool:
        from sqlalchemy import delete as sa_delete
        from app.db import get_session
        from app.db.models import User
        async with get_session() as db:
            res = await db.execute(sa_delete(User).where(User.id == user_id))
            await db.commit()
            return bool(res.rowcount)

    async def add_token(self, token: TokenRecord) -> None:
        from app.db import get_session
        from app.db.models import AuthToken
        async with get_session() as db:
            db.add(AuthToken(id=token.id, user_id=token.user_id, token_hash=token.token_hash,
                             expires_at=token.expires_at, created_at=token.created_at,
                             last_seen_at=token.last_seen_at, label=token.label))
            await db.commit()

    async def get_token(self, token_hash: str) -> TokenRecord | None:
        from sqlalchemy import select
        from app.db import get_session
        from app.db.models import AuthToken
        async with get_session() as db:
            row = (await db.execute(
                select(AuthToken).where(AuthToken.token_hash == token_hash)
            )).scalar_one_or_none()
        if row is None:
            return None
        return TokenRecord(id=row.id, user_id=row.user_id, token_hash=row.token_hash,
                           expires_at=row.expires_at, created_at=row.created_at,
                           last_seen_at=row.last_seen_at, label=row.label or "")

    async def touch_token(self, token_hash: str, expires_at: datetime, seen_at: datetime) -> None:
        from sqlalchemy import update
        from app.db import get_session
        from app.db.models import AuthToken
        async with get_session() as db:
            await db.execute(update(AuthToken).where(AuthToken.token_hash == token_hash)
                             .values(expires_at=expires_at, last_seen_at=seen_at))
            await db.commit()

    async def delete_token(self, token_hash: str) -> None:
        from sqlalchemy import delete as sa_delete
        from app.db import get_session
        from app.db.models import AuthToken
        async with get_session() as db:
            await db.execute(sa_delete(AuthToken).where(AuthToken.token_hash == token_hash))
            await db.commit()

    async def delete_tokens_for_user(self, user_id: str) -> int:
        from sqlalchemy import delete as sa_delete
        from app.db import get_session
        from app.db.models import AuthToken
        async with get_session() as db:
            res = await db.execute(sa_delete(AuthToken).where(AuthToken.user_id == user_id))
            await db.commit()
            return int(res.rowcount or 0)


def _user_of(row) -> UserRecord:
    return UserRecord(id=row.id, username=row.username, password_hash=row.password_hash,
                      role=row.role, disabled=bool(row.disabled), created_at=row.created_at)
