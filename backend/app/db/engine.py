"""
Async database engine + session factory.

The database is deliberately OPTIONAL at runtime: if Postgres is down or
not yet provisioned, the platform still flies — persistent features
(drone registry, and later zones/permissions) just degrade to no-ops.
A drone must never be unflyable because a database is unreachable.
"""
import logging

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import get_settings

logger = logging.getLogger("verocore.db")

_engine = None
_session_factory: async_sessionmaker[AsyncSession] | None = None
_available = False


async def init_db() -> bool:
    """Connect and verify at startup. Returns True if the DB is usable."""
    global _engine, _session_factory, _available
    settings = get_settings()
    try:
        _engine = create_async_engine(settings.database_url, pool_size=5, pool_pre_ping=True)
        async with _engine.connect():
            pass  # connectivity check only — schema is managed by alembic
        _session_factory = async_sessionmaker(_engine, expire_on_commit=False)
        _available = True
        logger.info("✅ Database connected")
    except Exception as e:
        _available = False
        logger.warning(f"Database unavailable — persistent features disabled: {e}")
    return _available


def db_available() -> bool:
    return _available


def get_session() -> AsyncSession:
    """Caller must check db_available() first (or catch the RuntimeError)."""
    if _session_factory is None:
        raise RuntimeError("Database not initialised")
    return _session_factory()


async def close_db():
    global _available
    if _engine is not None:
        await _engine.dispose()
    _available = False
