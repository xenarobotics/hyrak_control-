"""
API keys for the public /v1 surface.

A key is "hyk_" + 32 url-safe random characters. Only its SHA-256 lands in
the database, so verification is a single indexed lookup of the hash - no
per-key comparison loop, no plaintext at rest, and a database dump leaks
nothing usable.
"""
import hashlib
import logging
import secrets
from datetime import datetime, timezone

from sqlalchemy import select

from app.db import db_available, get_session
from app.db.models import ApiKey

logger = logging.getLogger("verocore.tasks.auth")

KEY_PREFIX = "hyk_"


def hash_key(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode()).hexdigest()


async def mint(name: str) -> dict | None:
    """Create a key. Returns {key: <plaintext>, record: {...}} - the ONLY
    time the plaintext exists outside the client's own configuration."""
    if not db_available():
        return None
    plaintext = KEY_PREFIX + secrets.token_urlsafe(24)
    record = ApiKey(
        name=name.strip()[:120] or "unnamed client",
        prefix=plaintext[:10],
        key_hash=hash_key(plaintext),
    )
    async with get_session() as db:
        db.add(record)
        await db.commit()
        d = record.to_dict()
    logger.info(f"API key minted for '{d['name']}' ({d['prefix']}...)")
    return {"key": plaintext, "record": d}


async def verify(plaintext: str | None) -> dict | None:
    """The key's record if valid and active, else None. Touches
    last_used_at as a side effect - 'is this client still alive' is a
    question the keys page must be able to answer."""
    if not plaintext or not plaintext.startswith(KEY_PREFIX) or not db_available():
        return None
    h = hash_key(plaintext)
    try:
        async with get_session() as db:
            row = (
                await db.execute(
                    select(ApiKey).where(ApiKey.key_hash == h,
                                         ApiKey.active == True)  # noqa: E712
                )
            ).scalar_one_or_none()
            if row is None:
                return None
            row.last_used_at = datetime.now(timezone.utc)
            await db.commit()
            return row.to_dict()
    except Exception as e:
        logger.warning(f"API key verification failed: {e}")
        return None


async def list_keys() -> list[dict]:
    if not db_available():
        return []
    async with get_session() as db:
        rows = (
            await db.execute(select(ApiKey).order_by(ApiKey.created_at.desc()))
        ).scalars().all()
    return [k.to_dict() for k in rows]


async def set_active(key_id: str, active: bool) -> dict | None:
    if not db_available():
        return None
    async with get_session() as db:
        row = (
            await db.execute(select(ApiKey).where(ApiKey.id == key_id))
        ).scalar_one_or_none()
        if row is None:
            return None
        row.active = active
        await db.commit()
        return row.to_dict()
