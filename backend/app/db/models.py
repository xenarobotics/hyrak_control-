"""
SQLAlchemy models — the persistent side of the platform.

Sessions stay in-memory (they live and die with a socket connection);
anything that must survive a reconnect or a server restart lives here.
"""
from datetime import datetime, timezone
from typing import Optional
import uuid

from sqlalchemy import (
    JSON, BigInteger, Boolean, DateTime, Float, ForeignKey, Integer, LargeBinary, String,
)
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
    # Set if the flight ever entered an orange/red zone — shown as colored
    # dots in the admin flight history.
    crossed_orange: Mapped[bool] = mapped_column(Boolean, default=False)
    crossed_red: Mapped[bool] = mapped_column(Boolean, default=False)

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
            "crossed_orange": self.crossed_orange,
            "crossed_red": self.crossed_red,
        }


class Permit(Base):
    """
    A request to fly one specific mission through red zone(s). The exact
    waypoint list is frozen into the permit — after admin approval, only a
    mission matching those waypoints (within GPS-noise tolerance) uploads;
    any edit invalidates it.
    """
    __tablename__ = "permits"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    drone_id: Mapped[str] = mapped_column(String(36), ForeignKey("drones.id"), index=True)
    description: Mapped[str] = mapped_column(String(500))
    waypoints: Mapped[list] = mapped_column(JSON)
    mission_hash: Mapped[str] = mapped_column(String(64), index=True)
    zones: Mapped[list] = mapped_column(JSON)  # red zones the mission crosses
    status: Mapped[str] = mapped_column(String(12), default="pending")
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    decided_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    def to_dict(self, include_waypoints: bool = False) -> dict:
        d = {
            "id": self.id,
            "drone_id": self.drone_id,
            "description": self.description,
            "waypoint_count": len(self.waypoints or []),
            "zones": self.zones,
            "status": self.status,
            "requested_at": self.requested_at.isoformat() if self.requested_at else None,
            "decided_at": self.decided_at.isoformat() if self.decided_at else None,
        }
        if include_waypoints:
            d["waypoints"] = self.waypoints
        return d


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


class CrowdSnapshot(Base):
    """
    A sampled crowd-density reading (~every 2s while crowd-management mode
    is active) — a live table for the session, purged at session end (see
    app/vision/persistence.py). session_id is a plain indexed string, not a
    FK: sessions are ephemeral/in-memory (same pattern as Flight.session_id).
    """
    __tablename__ = "crowd_snapshots"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(String(36), index=True)
    t: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    current_count: Mapped[int] = mapped_column(Integer, default=0)
    peak_count: Mapped[int] = mapped_column(Integer, default=0)
    density_level: Mapped[str] = mapped_column(String(10), default="green")
    section_counts: Mapped[dict] = mapped_column(JSON, default=dict)

    def to_dict(self) -> dict:
        return {
            "t": self.t.isoformat() if self.t else None,
            "current_count": self.current_count,
            "peak_count": self.peak_count,
            "density_level": self.density_level,
            "section_counts": self.section_counts,
        }


class CrowdAlert(Base):
    """A sustained-density alert raised for one grid section (see
    crowd_manager.py's alert_sustain/cooldown logic)."""
    __tablename__ = "crowd_alerts"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(String(36), index=True)
    t: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    level: Mapped[str] = mapped_column(String(10), default="orange")
    section_idx: Mapped[int] = mapped_column(Integer, default=-1)
    count: Mapped[int] = mapped_column(Integer, default=0)
    message: Mapped[str] = mapped_column(String(300), default="")

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "t": self.t.isoformat() if self.t else None,
            "level": self.level,
            "section_idx": self.section_idx,
            "count": self.count,
            "message": self.message,
        }


class PlateEvent(Base):
    """
    One row per vehicle (best-confidence plate reading, logged once when its
    track finalizes — not per frame, and not per fragment if the same plate
    is re-read within a cooldown window). Retained until an operator
    explicitly downloads/clears the history — see app/vision/persistence.py.
    """
    __tablename__ = "plate_events"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    session_id: Mapped[str] = mapped_column(String(36), index=True)
    track_id: Mapped[int] = mapped_column(Integer, default=0)
    # This module's own persistent identity for the vehicle (e.g. "VH-000042"),
    # distinct from track_id: ByteTrack ids reset on occlusion, this survives —
    # a re-read plate re-attaches the SAME vehicle_id rather than minting a new
    # one. Nullable because older rows predate the feature.
    vehicle_id: Mapped[Optional[str]] = mapped_column(String(20), nullable=True, index=True)
    plate_text: Mapped[str] = mapped_column(String(20), index=True)
    ocr_confidence: Mapped[float] = mapped_column(Float, default=0.0)
    vehicle_type: Mapped[str] = mapped_column(String(20), default="")
    # Dominant body colour plus how sure the classifier was. The confidence
    # travels with it because a distant or shaded vehicle genuinely cannot be
    # coloured reliably, and a bare "red" hides that.
    vehicle_color: Mapped[str] = mapped_column(String(20), default="")
    vehicle_color_conf: Mapped[float] = mapped_column(Float, default=0.0)
    vehicle_box: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    plate_box: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    # How many pixels across the plate actually was. The single most useful
    # quality indicator for a reading, and the reason it is stored rather than
    # used as a hard reject filter: on real footage from this rig plates arrive
    # 31-79px wide, so a width gate strict enough to guarantee a good read
    # rejects nearly every genuine plate. Recording it instead lets a reading
    # be judged after the fact without throwing the data away first.
    plate_px_w: Mapped[int] = mapped_column(Integer, default=0)
    # The other two evidence fields. Both were computed per frame and shown
    # live, then discarded when the row was written — so a report could be
    # filtered on width but not on whether independent frames ever agreed,
    # which is the difference between a settled plate and a single guess.
    #
    # votes = how many frames independently produced these exact characters.
    # grammar_ok = the text matches a known plate pattern. A signal, never a
    # filter: the genuine plate "719257C" fails the Indian grammar and is
    # still a perfectly valid reading.
    plate_votes: Mapped[int] = mapped_column(Integer, default=0)
    plate_grammar_ok: Mapped[bool] = mapped_column(Boolean, default=False)
    # Compass bearing of travel, degrees, 0=North. Null when the vehicle was
    # too slow for a heading to mean anything, or the ground projection had no
    # altitude to work from.
    heading_deg: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    # Sustained travel against the traffic around it. Relative to the observed
    # local flow, NOT to any map or declared road direction — there is neither
    # available here. See traffic_manager._update_flow.
    against_flow: Mapped[bool] = mapped_column(Boolean, default=False)
    image_path: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    # The whole-vehicle shot beside the plate crop. A 40x18px plate crop on its
    # own is unreviewable — you cannot tell a plate from a badge from an
    # overlay — so the car photo is what makes a row checkable by a human.
    vehicle_image_path: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    lat: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    lng: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    alt_m: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    # Ground-sample-distance estimate from drone altitude/FOV — NOT a
    # calibrated/certified reading. Always paired with is_estimate=True on
    # the wire; never present this as enforcement-grade evidence.
    speed_est_kmh: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "session_id": self.session_id,
            "track_id": self.track_id,
            "vehicle_id": self.vehicle_id,
            "plate_text": self.plate_text,
            "ocr_confidence": self.ocr_confidence,
            "vehicle_type": self.vehicle_type,
            "vehicle_color": self.vehicle_color,
            "vehicle_color_conf": round(self.vehicle_color_conf, 3),
            "vehicle_box": self.vehicle_box,
            "plate_box": self.plate_box,
            "plate_px_w": self.plate_px_w,
            "plate_votes": self.plate_votes,
            "plate_grammar_ok": self.plate_grammar_ok,
            "heading_deg": self.heading_deg,
            "against_flow": self.against_flow,
            "image_path": self.image_path,
            "vehicle_image_path": self.vehicle_image_path,
            "lat": self.lat,
            "lng": self.lng,
            "alt_m": self.alt_m,
            "speed_est_kmh": self.speed_est_kmh,
            "first_seen": self.first_seen.isoformat() if self.first_seen else None,
            "last_seen": self.last_seen.isoformat() if self.last_seen else None,
        }


# ── Face gallery ─────────────────────────────────────────────────────────────
#
# THIS IS A DIFFERENT CATEGORY OF DATA FROM EVERYTHING ABOVE.
#
# crowd_snapshots and crowd_alerts are purged at session end; plate_events are
# kept only until an operator clears them. Both describe a moment. `persons`
# and `person_faces` instead hold durable biometric identity — a face template
# that names a specific human being across sessions and flights.
#
# That difference is deliberate and load-bearing, so it is written down here
# rather than left to be inferred: this data has no automatic expiry, so it
# needs an explicit deletion path (delete_person / clear_face_gallery in
# app/vision/persistence.py) and a real retention decision before any
# deployment. A demo gallery of three colleagues is not a reason to let the
# default become "keep faces forever".


class Person(Base):
    """
    One enrolled identity. Deliberately thin: a name and a switch.

    Deleting a Person cascades to their faces and unlinks the image files —
    see persistence.delete_person(). A plain SQL DELETE would orphan the
    images, the same trap plate_events.image_path carries.
    """
    __tablename__ = "persons"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    name: Mapped[str] = mapped_column(String(120), index=True)
    notes: Mapped[str] = mapped_column(String(500), default="")
    # Soft disable so a face can be taken out of matching without destroying
    # the enrolment — useful when a match keeps misfiring and you want to
    # investigate rather than delete the evidence.
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    def to_dict(self, face_count: int | None = None) -> dict:
        d = {
            "id": self.id,
            "name": self.name,
            "notes": self.notes,
            "active": self.active,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
        if face_count is not None:
            d["face_count"] = face_count
        return d


class PersonFace(Base):
    """
    One enrolled photo: the embedding in Postgres, the image on disk.

    WHY THE VECTOR IS RAW BYTES, NOT JSON
        A 512-dim float32 ArcFace embedding is exactly 2048 bytes packed, but
        roughly 10 KB as a JSON array of decimal strings — and the round trip
        through text loses bits. Packed float32 is compact and exact.
        np.frombuffer on the way out is free.

    WHY THE IMAGE STAYS ON DISK
        Same reasoning as plate_events.image_path: image bytes in Postgres
        bloat the table and every backup of it. More importantly the original
        is the RE-ENROLMENT path — see model_name below.

    WHY model_name AND dim ARE STORED
        Embeddings from different face models are not comparable. buffalo_sc
        and buffalo_l are both 512-dim, so a mismatch does not raise or even
        look wrong — it silently produces meaningless cosine similarities and
        therefore confident misidentifications. Recording which model produced
        each vector lets the matcher refuse cross-model comparison and lets an
        upgrade re-extract from the stored originals instead of guessing.
    """
    __tablename__ = "person_faces"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    person_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("persons.id", ondelete="CASCADE"), index=True
    )
    image_path: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    # Packed float32. Read back with np.frombuffer(blob, dtype=np.float32).
    embedding: Mapped[bytes] = mapped_column(LargeBinary)
    embedding_dim: Mapped[int] = mapped_column(Integer, default=512)
    model_name: Mapped[str] = mapped_column(String(60), default="buffalo_sc")
    # InsightFace's own detection score for the enrolled crop. A blurry or
    # sharply-angled enrolment photo poisons matching quietly, so the score is
    # kept to let low-quality enrolments be found and re-shot later.
    det_score: Mapped[float] = mapped_column(Float, default=0.0)
    source_filename: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    def to_dict(self) -> dict:
        """Metadata only — the embedding itself is never serialised to a
        client. It is biometric material, and it is not needed browser-side."""
        return {
            "id": self.id,
            "person_id": self.person_id,
            "image_path": self.image_path,
            "model_name": self.model_name,
            "embedding_dim": self.embedding_dim,
            "det_score": round(self.det_score, 3),
            "source_filename": self.source_filename,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class PersonSighting(Base):
    """
    A gallery match during a session — the audit trail for "the drone said
    this was Madhu at 14:32".

    Session-scoped like crowd_snapshots, NOT durable like persons: the
    identities are the asset, the sightings are operational log. person_id is
    SET NULL on delete rather than cascading, so removing someone from the
    gallery does not silently rewrite the history of what the system did.
    """
    __tablename__ = "person_sightings"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    session_id: Mapped[str] = mapped_column(String(36), index=True)
    person_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("persons.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Denormalised so the log still reads correctly after a person is deleted.
    person_name: Mapped[str] = mapped_column(String(120), default="")
    t: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    similarity: Mapped[float] = mapped_column(Float, default=0.0)
    track_id: Mapped[int] = mapped_column(Integer, default=0)
    # Where the drone was, not where the person was — the same honest
    # distinction plate_events draws.
    lat: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    lng: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    alt_m: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    image_path: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "session_id": self.session_id,
            "person_id": self.person_id,
            "person_name": self.person_name,
            "t": self.t.isoformat() if self.t else None,
            "similarity": round(self.similarity, 4),
            "track_id": self.track_id,
            "lat": self.lat,
            "lng": self.lng,
            "alt_m": self.alt_m,
            "image_path": self.image_path,
        }
