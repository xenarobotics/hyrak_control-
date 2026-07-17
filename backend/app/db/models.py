"""
SQLAlchemy models — the persistent side of the platform.

Sessions stay in-memory (they live and die with a socket connection);
anything that must survive a reconnect or a server restart lives here.
"""
from datetime import datetime, timezone
import uuid

from sqlalchemy import Boolean, DateTime, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Drone(Base):
    """
    One physical (or simulated) vehicle, keyed by the flight controller's
    factory-burned hardware UID (MAVLink AUTOPILOT_VERSION, read via the
    MAVSDK Info plugin). A browser refresh or radio reconnect maps back to
    the same row — a drone's identity is never the session's identity.
    """
    __tablename__ = "drones"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    hardware_uid: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    # SITL instances can share a dummy UID — tagged so real fleet views can
    # filter them out.
    is_simulated: Mapped[bool] = mapped_column(Boolean, default=False)
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "hardware_uid": self.hardware_uid,
            "name": self.name,
            "is_simulated": self.is_simulated,
            "first_seen": self.first_seen.isoformat() if self.first_seen else None,
            "last_seen": self.last_seen.isoformat() if self.last_seen else None,
        }
