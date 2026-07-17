"""
SQLAlchemy models — the persistent side of the platform.

Sessions stay in-memory (they live and die with a socket connection);
anything that must survive a reconnect or a server restart lives here.
"""
from datetime import datetime, timezone
from typing import Optional
import uuid

from sqlalchemy import JSON, BigInteger, Boolean, DateTime, Float, ForeignKey, Integer, String
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


class Zone(Base):
    """
    A flight zone: green (free), orange (warning), red (restricted).
    Geometry is a GeoJSON Polygon/MultiPolygon — the industry-standard
    format (converts cleanly to/from ED-269 / Digital Sky data). Zones are
    3D-aware via floor/ceiling (metres above ground at the zone).
    """
    __tablename__ = "zones"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    name: Mapped[str] = mapped_column(String(120))
    zone_class: Mapped[str] = mapped_column(String(10))  # green | orange | red
    geometry: Mapped[dict] = mapped_column(JSON)          # GeoJSON geometry
    floor_m: Mapped[float] = mapped_column(Float, default=0.0)
    ceiling_m: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    def to_feature(self) -> dict:
        return {
            "type": "Feature",
            "geometry": self.geometry,
            "properties": {
                "id": self.id,
                "name": self.name,
                "zone_class": self.zone_class,
                "floor_m": self.floor_m,
                "ceiling_m": self.ceiling_m,
                "active": self.active,
            },
        }


class Flight(Base):
    """One flight = armed → disarmed. Summary row; 1 Hz track in samples."""
    __tablename__ = "flights"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    drone_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("drones.id"), index=True
    )
    session_id: Mapped[str] = mapped_column(String(36))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    ended_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_s: Mapped[float] = mapped_column(Float, default=0.0)
    max_alt_m: Mapped[float] = mapped_column(Float, default=0.0)
    distance_m: Mapped[float] = mapped_column(Float, default=0.0)
    samples_count: Mapped[int] = mapped_column(Integer, default=0)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "drone_id": self.drone_id,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "ended_at": self.ended_at.isoformat() if self.ended_at else None,
            "duration_s": self.duration_s,
            "max_alt_m": self.max_alt_m,
            "distance_m": self.distance_m,
            "samples_count": self.samples_count,
            "in_progress": self.ended_at is None,
        }


class FlightSample(Base):
    """1 Hz telemetry sample inside a flight — the full flight track."""
    __tablename__ = "flight_samples"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    flight_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("flights.id"), index=True
    )
    t: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    lat: Mapped[float] = mapped_column(Float, default=0.0)
    lng: Mapped[float] = mapped_column(Float, default=0.0)
    alt_m: Mapped[float] = mapped_column(Float, default=0.0)
    heading_deg: Mapped[float] = mapped_column(Float, default=0.0)
    groundspeed_m_s: Mapped[float] = mapped_column(Float, default=0.0)
    battery_pct: Mapped[float] = mapped_column(Float, default=0.0)
    mode: Mapped[str] = mapped_column(String(24), default="")
