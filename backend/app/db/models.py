"""
SQLAlchemy models - the persistent side of the platform.

Sessions stay in-memory (they live and die with a socket connection);
anything that must survive a reconnect or a server restart lives here.
"""
from datetime import datetime, timezone
from typing import Optional
import uuid

from sqlalchemy import (
    JSON, BigInteger, Boolean, CheckConstraint, DateTime, Float, ForeignKey,
    Index, Integer, LargeBinary, Sequence, String, UniqueConstraint, text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# Every JSON column is JSONB on Postgres (the only production dialect): binary
# storage, real containment/indexing, no reparse on read. The generic JSON
# fallback keeps the models portable for the mock-engine schema generator and
# any SQLite-backed tooling. Defined once, shared by every column below.
JSONB_COL = JSON().with_variant(JSONB, "postgresql")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# The one platform workspace (HYRAK, the root of the workspace tree). Its id
# is a fixed constant so drones / zones can default to it at the storage
# layer (a server_default cannot run a subquery) and so the in-memory auth
# store and the database agree on it across a DB flap. A partial unique
# index on workspaces.kind keeps it the only platform row.
PLATFORM_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001"


class Base(DeclarativeBase):
    pass


class Drone(Base):
    """
    One physical (or simulated) vehicle, keyed by the flight controller's
    factory-burned hardware UID (MAVLink AUTOPILOT_VERSION, read via the
    MAVSDK Info plugin). A browser refresh or radio reconnect maps back to
    the same row - a drone's identity is never the session's identity.
    """
    __tablename__ = "drones"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    hardware_uid: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    # SITL instances can share a dummy UID - tagged so real fleet views can
    # filter them out.
    is_simulated: Mapped[bool] = mapped_column(Boolean, default=False)
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    # The workspace that owns the vehicle (docs/ACCESS_MODEL.md). A newly
    # seen drone belongs to the platform until someone with drones.manage
    # assigns it.
    workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="RESTRICT"), index=True,
        default=PLATFORM_WORKSPACE_ID, server_default=PLATFORM_WORKSPACE_ID,
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "hardware_uid": self.hardware_uid,
            "name": self.name,
            "is_simulated": self.is_simulated,
            "first_seen": self.first_seen.isoformat() if self.first_seen else None,
            "last_seen": self.last_seen.isoformat() if self.last_seen else None,
            "workspace_id": self.workspace_id,
        }


class Zone(Base):
    """
    A flight zone: green (free), orange (warning), red (restricted).
    Geometry is a GeoJSON Polygon/MultiPolygon - the industry-standard
    format (converts cleanly to/from ED-269 / Digital Sky data). Zones are
    3D-aware via floor/ceiling (metres above ground at the zone).

    Every active zone applies to every drone. The layer (regulatory / area /
    site) and workspace decide only who may edit it (docs/ACCESS_MODEL.md
    section 3).
    """
    __tablename__ = "zones"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    name: Mapped[str] = mapped_column(String(120))
    zone_class: Mapped[str] = mapped_column(String(10))  # green | orange | red
    geometry: Mapped[dict] = mapped_column(JSONB_COL)          # GeoJSON geometry
    floor_m: Mapped[float] = mapped_column(Float, default=0.0)
    ceiling_m: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    layer: Mapped[str] = mapped_column(String(16), default="regulatory",
                                       server_default="regulatory")
    workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="RESTRICT"), index=True,
        default=PLATFORM_WORKSPACE_ID, server_default=PLATFORM_WORKSPACE_ID,
    )
    created_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    updated_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    # Red zones only: True = flyable under an approved permit (docs/
    # ACCESS_MODEL.md 8d), False = prohibited, no permit can be requested.
    # Orange zones always admit a permit; green ones never need one.
    permission_required: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default=text("true"))

    __table_args__ = (
        CheckConstraint("layer IN ('regulatory', 'area', 'site')", name="ck_zones_layer"),
    )

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
                "layer": self.layer,
                "workspace_id": self.workspace_id,
                "permission_required": self.permission_required,
            },
        }


class MapFeature(Base):
    """
    Land-use overlay for the mission planner: what is UNDER the drone.

    Deliberately separate from Zone. Zones answer "is flying here legal"
    (green/orange/red, enforced); map features answer "what would the drone
    be over" (a road, a forest, a hostel) - pure preference data that route
    profiles weight. A feature never overrides a zone: red stays blocked no
    matter what category sits beneath it.
    """
    __tablename__ = "map_features"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    name: Mapped[str] = mapped_column(String(120))
    # One of planner.CATEGORIES (road, forest, water, open_field, farmland,
    # residential, hostel, school, campus, industrial).
    category: Mapped[str] = mapped_column(String(30), index=True)
    geometry: Mapped[dict] = mapped_column(JSONB_COL)  # GeoJSON (Multi)Polygon
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    def to_feature(self) -> dict:
        return {
            "type": "Feature",
            "geometry": self.geometry,
            "properties": {
                "id": self.id,
                "name": self.name,
                "category": self.category,
                "active": self.active,
            },
        }


class RouteProfile(Base):
    """
    A named preference set for the mission planner - "over roads",
    "unmanned areas", "hybrid". The rules JSON holds per-category behavior:

        {"categories": {"road":       {"mode": "prefer", "weight": 0.45},
                        "residential":{"mode": "avoid",  "weight": 6.0},
                        "hostel":     {"mode": "block"}},
         "orange": {"policy": "penalize", "weight": 4.0},
         "turn_radius_m": 8.0}

    Weights are cost-per-metre multipliers over a base of 1.0, so "prefer"
    (< 1) makes flying extra metres to stay over that category worth it and
    "avoid" (> 1) makes crossing it expensive; "block" is impassable to the
    planner (softer than a red zone: it only shapes the route, nothing
    enforces it in flight). Built-in profiles are seeded at startup and can
    be tuned by an admin but not deleted.
    """
    __tablename__ = "route_profiles"
    # Names are unique per workspace (docs/ACCESS_MODEL.md 8d): HYRAK's
    # profiles (the builtins included) are global and readable by everyone
    # who plans; a customer's own profiles are theirs alone.
    __table_args__ = (
        UniqueConstraint("workspace_id", "name", name="uq_route_profiles_workspace_name"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    name: Mapped[str] = mapped_column(String(120), index=True)
    workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True,
        default=PLATFORM_WORKSPACE_ID, server_default=PLATFORM_WORKSPACE_ID,
    )
    description: Mapped[str] = mapped_column(String(500), default="")
    rules: Mapped[dict] = mapped_column(JSONB_COL, default=dict)
    default_alt_m: Mapped[float] = mapped_column(Float, default=60.0)
    default_speed_m_s: Mapped[float] = mapped_column(Float, default=8.0)
    builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "rules": self.rules or {},
            "default_alt_m": self.default_alt_m,
            "default_speed_m_s": self.default_speed_m_s,
            "builtin": self.builtin,
            "active": self.active,
            "workspace_id": self.workspace_id,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class Mission(Base):
    """
    One generated mission path - the planner's persistent output, answering
    who asked, when, for which drone, under which profile, and exactly what
    the path was. mission_hash uses the SAME canonicalisation as permits, so
    a planned mission, its permit (if it needs one), and the eventual upload
    all tie together through one hash.

    Status is a lifecycle, not a flag: planned -> uploaded -> flying ->
    completed, with aborted/failed as exits. scheduled_at is the future
    dispatch hook ("time of launch") - null means fly whenever the operator
    uploads it.
    """
    __tablename__ = "missions"
    __table_args__ = (
        # Status validity is enforced in app code (planner/service.ALLOWED_NEXT);
        # this makes a bad write from anywhere - a stray script, a manual psql -
        # impossible at the storage layer too.
        CheckConstraint(
            "status IN ('planned','uploaded','flying','completed',"
            "'aborted','failed')",
            name="ck_missions_status",
        ),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    # The workspace that owns the plan (docs/ACCESS_MODEL.md 8d). HYRAK's
    # delivery legs sit on the platform workspace.
    workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True,
        default=PLATFORM_WORKSPACE_ID, server_default=PLATFORM_WORKSPACE_ID,
    )
    # A human label for saved plans; planner legs leave it empty.
    name: Mapped[str] = mapped_column(String(120), default="", server_default="")
    # Nullable on purpose: a path can be planned before a drone is assigned.
    drone_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("drones.id"), nullable=True, index=True
    )
    # Session id / operator label today; becomes a users FK in the identity
    # phase without changing this table's shape.
    requested_by: Mapped[str] = mapped_column(String(120), default="")
    profile_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("route_profiles.id"), nullable=True
    )
    # Denormalised so the record still reads correctly if the profile is
    # later renamed or deleted (same pattern as person_sightings.person_name).
    profile_name: Mapped[str] = mapped_column(String(120), default="")
    status: Mapped[str] = mapped_column(String(12), default="planned", index=True)
    # A takeoff deferred for overhead traffic sets this so the hold survives a
    # server restart: the fleet monitor re-arms it when the column is clear
    # instead of leaving the aircraft with an uploaded mission nothing starts.
    # Cleared the moment the mission is released, abandoned, or returned.
    held_takeoff: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    start_lat: Mapped[float] = mapped_column(Float)
    start_lng: Mapped[float] = mapped_column(Float)
    goal_lat: Mapped[float] = mapped_column(Float)
    goal_lng: Mapped[float] = mapped_column(Float)
    cruise_alt_m: Mapped[float] = mapped_column(Float, default=60.0)
    speed_m_s: Mapped[float] = mapped_column(Float, default=8.0)
    waypoints: Mapped[list] = mapped_column(JSONB_COL)
    mission_hash: Mapped[str] = mapped_column(String(64), index=True)
    distance_m: Mapped[float] = mapped_column(Float, default=0.0)
    est_duration_s: Mapped[float] = mapped_column(Float, default=0.0)
    zones: Mapped[list] = mapped_column(JSONB_COL, default=list)      # zones crossed
    coverage: Mapped[dict] = mapped_column(JSONB_COL, default=dict)   # metres per category
    report: Mapped[dict] = mapped_column(JSONB_COL, default=dict)     # planner diagnostics
    scheduled_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    def to_dict(self, include_waypoints: bool = True) -> dict:
        d = {
            "id": self.id,
            "workspace_id": self.workspace_id,
            "name": self.name,
            "drone_id": self.drone_id,
            "requested_by": self.requested_by,
            "profile_id": self.profile_id,
            "profile_name": self.profile_name,
            "status": self.status,
            "start": {"lat": self.start_lat, "lng": self.start_lng},
            "goal": {"lat": self.goal_lat, "lng": self.goal_lng},
            "cruise_alt_m": self.cruise_alt_m,
            "speed_m_s": self.speed_m_s,
            "waypoint_count": len(self.waypoints or []),
            "mission_hash": self.mission_hash,
            "distance_m": self.distance_m,
            "est_duration_s": self.est_duration_s,
            "zones": self.zones or [],
            "coverage": self.coverage or {},
            "report": self.report or {},
            "scheduled_at": self.scheduled_at.isoformat() if self.scheduled_at else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
        if include_waypoints:
            d["waypoints"] = self.waypoints
        return d


class Pad(Base):
    """
    A named take-off / landing location - the vocabulary a delivery client
    speaks in. A client app never sends coordinates; it says "pickup at
    Mess-A pad", and the pad row is where that name becomes a lat/lng the
    planner can use.
    """
    __tablename__ = "pads"
    # Unique per workspace (docs/ACCESS_MODEL.md 8d). HYRAK's pads and
    # stations serve the delivery fleet and the /v1 API; a customer's pads
    # are named take-off / landing spots for their own plans.
    __table_args__ = (
        UniqueConstraint("workspace_id", "name", name="uq_pads_workspace_name"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    name: Mapped[str] = mapped_column(String(120), index=True)
    workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True,
        default=PLATFORM_WORKSPACE_ID, server_default=PLATFORM_WORKSPACE_ID,
    )
    # 'pad': a client-facing pickup/drop location. 'station': a home base
    # drones return to between missions - clients can't order to a station.
    kind: Mapped[str] = mapped_column(String(16), default="pad", server_default="pad")
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    notes: Mapped[str] = mapped_column(String(500), default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "lat": self.lat,
            "lng": self.lng,
            "notes": self.notes,
            "active": self.active,
            "workspace_id": self.workspace_id,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class ApiKey(Base):
    """
    One client application's credential for the public /v1 API - the thin
    end of the tenancy wedge (organizations arrive with the identity phase;
    for the pilot, the key IS the tenant).

    Only the SHA-256 of the key is stored. The plaintext is shown exactly
    once at creation; a leaked database dump therefore leaks no credentials.
    The prefix (first characters of the plaintext) is kept so an operator
    can tell keys apart without ever seeing them whole.
    """
    __tablename__ = "api_keys"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    name: Mapped[str] = mapped_column(String(120))
    prefix: Mapped[str] = mapped_column(String(12))
    key_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    last_used_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "prefix": self.prefix,
            "active": self.active,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "last_used_at": self.last_used_at.isoformat() if self.last_used_at else None,
        }


# Order numbers (HYK-00042) come from this sequence - registered on the
# metadata so schema.sql generation and create_all both know it exists,
# not just the migration that first added it.
task_order_seq = Sequence("task_order_seq", metadata=Base.metadata, start=1)


class Task(Base):
    """
    One delivery order - the unit a client application creates and tracks.
    The order number is the public identity (what a customer sees); the
    uuid id stays internal. Pad names and coordinates are denormalised into
    the row so the order still reads correctly after a pad is renamed or
    retired.

    Lifecycle (see app/tasks/service.py for the transition map):
        received -> planned -> assigned -> to_pickup -> loading
                 -> to_dropoff -> delivered
    with returned / failed / cancelled as exits.
    """
    __tablename__ = "tasks"
    __table_args__ = (
        # The dispatcher's hot query is "planned orders" and "this drone's
        # active order"; the composite serves both prefixes where the two
        # single-column indexes could not. archived is filtered on every
        # board list. permits.status has its own index below.
        Index("ix_tasks_status_drone_id", "status", "drone_id"),
        Index("ix_tasks_archived", "archived"),
        # Storage-layer guard on the lifecycle - see tasks/service.ALLOWED_NEXT.
        CheckConstraint(
            "status IN ('received','planned','assigned','to_pickup','loading',"
            "'to_dropoff','delivered','returned','failed','cancelled')",
            name="ck_tasks_status",
        ),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    order_no: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    api_key_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("api_keys.id"), nullable=True, index=True
    )
    # Denormalised key name, "operator" for board-created orders.
    client_name: Mapped[str] = mapped_column(String(120), default="operator")
    status: Mapped[str] = mapped_column(String(12), default="received", index=True)
    pickup_pad_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("pads.id"), nullable=True
    )
    dropoff_pad_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("pads.id"), nullable=True
    )
    pickup_name: Mapped[str] = mapped_column(String(120), default="")
    pickup_lat: Mapped[float] = mapped_column(Float, default=0.0)
    pickup_lng: Mapped[float] = mapped_column(Float, default=0.0)
    dropoff_name: Mapped[str] = mapped_column(String(120), default="")
    dropoff_lat: Mapped[float] = mapped_column(Float, default=0.0)
    dropoff_lng: Mapped[float] = mapped_column(Float, default=0.0)
    payload_desc: Mapped[str] = mapped_column(String(300), default="")
    payload_kg: Mapped[float] = mapped_column(Float, default=0.0)
    window_start: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    window_end: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    profile_name: Mapped[str] = mapped_column(String(120), default="")
    # The delivery leg (pickup -> dropoff), planned at order time - this is
    # the "quote" a client's distance/ETA comes from.
    mission_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("missions.id"), nullable=True
    )
    # The positioning leg (drone's location -> pickup), planned at assign
    # time once we know WHICH drone is coming.
    mission_to_pickup_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("missions.id"), nullable=True
    )
    drone_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("drones.id"), nullable=True, index=True
    )
    fail_reason: Mapped[str] = mapped_column(String(500), default="")
    # Operator-side shelving: an archived order leaves the board but stays
    # in the database (and in the client's /v1 history) forever.
    archived: Mapped[bool] = mapped_column(Boolean, default=False,
                                           server_default="false")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "order_no": self.order_no,
            "client_name": self.client_name,
            "status": self.status,
            "pickup": {"pad_id": self.pickup_pad_id, "name": self.pickup_name,
                       "lat": self.pickup_lat, "lng": self.pickup_lng},
            "dropoff": {"pad_id": self.dropoff_pad_id, "name": self.dropoff_name,
                        "lat": self.dropoff_lat, "lng": self.dropoff_lng},
            "payload": {"description": self.payload_desc, "kg": self.payload_kg},
            "window_start": self.window_start.isoformat() if self.window_start else None,
            "window_end": self.window_end.isoformat() if self.window_end else None,
            "profile_name": self.profile_name,
            "mission_id": self.mission_id,
            "mission_to_pickup_id": self.mission_to_pickup_id,
            "drone_id": self.drone_id,
            "fail_reason": self.fail_reason,
            "archived": self.archived,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class TaskEvent(Base):
    """Append-only history of a task - every status change with who caused
    it. The task row says where the order IS; this table says how it got
    there, and it is what a client's status timeline renders."""
    __tablename__ = "task_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    task_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("tasks.id", ondelete="CASCADE"), index=True
    )
    t: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    status: Mapped[str] = mapped_column(String(12))
    note: Mapped[str] = mapped_column(String(500), default="")
    actor: Mapped[str] = mapped_column(String(20), default="system")  # client|operator|system

    def to_dict(self) -> dict:
        return {
            "t": self.t.isoformat() if self.t else None,
            "status": self.status,
            "note": self.note,
            "actor": self.actor,
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
    # The workspace this row belongs to (docs/ACCESS_MODEL.md 8b), stamped
    # at record time from the drone's workspace (the session's when the drone is unknown). A plain indexed string, not a FK:
    # history must never fail to write, and a deleted workspace's rows stay
    # readable by founders. Rows from before phase 2b are HYRAK's.
    workspace_id: Mapped[str] = mapped_column(
        String(36), index=True,
        default=PLATFORM_WORKSPACE_ID, server_default=PLATFORM_WORKSPACE_ID,
    )
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    ended_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_s: Mapped[float] = mapped_column(Float, default=0.0)
    max_alt_m: Mapped[float] = mapped_column(Float, default=0.0)
    distance_m: Mapped[float] = mapped_column(Float, default=0.0)
    samples_count: Mapped[int] = mapped_column(Integer, default=0)
    # Set if the flight ever entered an orange/red zone - shown as colored
    # dots in the admin flight history.
    crossed_orange: Mapped[bool] = mapped_column(Boolean, default=False)
    crossed_red: Mapped[bool] = mapped_column(Boolean, default=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "drone_id": self.drone_id,
            "session_id": self.session_id,
            "workspace_id": self.workspace_id,
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
    A request to fly through restricted airspace: orange zones, and red
    zones that admit a permit (Zone.permission_required). Two kinds:

      mission  the exact waypoint list is frozen into the permit; only a
               mission matching it (within GPS-noise tolerance) uploads
               under it, and any edit invalidates it.
      area     a GeoJSON polygon; any mission that stays inside it may use
               the zones the permit names.

    A permit belongs to a workspace and optionally to one drone (null = any
    drone of that workspace). It is honoured only while approved and inside
    its time window [valid_from, valid_until) (docs/ACCESS_MODEL.md 8d).
    Rows from before 8b have no window and no requester: they stay valid
    as they were (approved = flyable) until decided otherwise.

    Status: pending -> approved | denied; approved -> revoked; pending or
    approved -> withdrawn (by the requesting workspace). "expired" is not
    stored: it is an approved permit whose window has ended.
    """
    __tablename__ = "permits"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True,
        default=PLATFORM_WORKSPACE_ID, server_default=PLATFORM_WORKSPACE_ID,
    )
    # Null = any drone of the workspace.
    drone_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("drones.id"), index=True, nullable=True)
    mission_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("missions.id", ondelete="SET NULL"), nullable=True)
    description: Mapped[str] = mapped_column(String(500))
    waypoints: Mapped[list] = mapped_column(JSONB_COL)   # [] for an area permit
    mission_hash: Mapped[str] = mapped_column(String(64), index=True)
    area: Mapped[Optional[dict]] = mapped_column(JSONB_COL, nullable=True)
    zones: Mapped[list] = mapped_column(JSONB_COL)  # restricted zones the flight uses
    # Indexed: the approval queue and the upload gate both filter permits by
    # status (pending for the queue, approved for the gate).
    status: Mapped[str] = mapped_column(String(12), default="pending", index=True)
    valid_from: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    valid_until: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    requested_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    requested_by_name: Mapped[str] = mapped_column(String(120), default="", server_default="")
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    decided_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    decided_by_name: Mapped[str] = mapped_column(String(120), default="", server_default="")
    decision_note: Mapped[str] = mapped_column(String(500), default="", server_default="")
    decided_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    def to_dict(self, include_waypoints: bool = False) -> dict:
        def iso(t):
            return t.isoformat() if t else None
        d = {
            "id": self.id,
            "workspace_id": self.workspace_id,
            "drone_id": self.drone_id,
            "mission_id": self.mission_id,
            "kind": "area" if self.area else "mission",
            "description": self.description,
            "waypoint_count": len(self.waypoints or []),
            "mission_hash": self.mission_hash,
            "area": self.area,
            "zones": self.zones,
            "status": self.status,
            "valid_from": iso(self.valid_from),
            "valid_until": iso(self.valid_until),
            "requested_by": self.requested_by,
            "requested_by_name": self.requested_by_name,
            "requested_at": iso(self.requested_at),
            "decided_by": self.decided_by,
            "decided_by_name": self.decided_by_name,
            "decision_note": self.decision_note,
            "decided_at": iso(self.decided_at),
        }
        if include_waypoints:
            d["waypoints"] = self.waypoints
        return d


class FlightSample(Base):
    """1 Hz telemetry sample inside a flight - the full flight track."""
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


class AvoidanceEvent(Base):
    """One obstacle-avoidance state change - what the layer saw and did, for
    the Mission-tab timeline and post-flight review. drone_id is a plain
    indexed string (not a FK): the log must never fail to write because a
    session drone is not yet persisted."""
    __tablename__ = "avoidance_events"
    __table_args__ = (
        Index("ix_avoidance_events_drone_t", "drone_id", "t"),
        CheckConstraint(
            "action IN ('clear','hold','reroute','climb','return','avoid','resume','track')",
            name="ck_avoidance_events_action"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    drone_id: Mapped[str] = mapped_column(String(36), default="")
    t: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    action: Mapped[str] = mapped_column(String(12))
    state: Mapped[str] = mapped_column(String(12), default="")
    reason: Mapped[str] = mapped_column(String(500), default="")
    armed: Mapped[bool] = mapped_column(Boolean, default=False)
    obstacle_lat: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    obstacle_lng: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    obstacle_radius_m: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    fused_distance_m: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "drone_id": self.drone_id,
            "t": self.t.isoformat() if self.t else None,
            "action": self.action,
            "state": self.state,
            "reason": self.reason,
            "armed": self.armed,
            "obstacle": (
                {"lat": self.obstacle_lat, "lng": self.obstacle_lng,
                 "radius_m": self.obstacle_radius_m}
                if self.obstacle_lat is not None else None),
            "fused_distance_m": self.fused_distance_m,
        }


class KnownObstacle(Base):
    """The persistent, shared hazard map: static obstacles (trees, poles,
    buildings, wires) confirmed by any drone, remembered across flights and
    seeded back into a drone's live map before it re-encounters them. Only
    obstacles observed as STATIONARY are written here - a moving person is
    never a permanent hazard. Position is a plain lat/lng with an index so a
    bounding-box 'what's near me' query is cheap."""
    __tablename__ = "known_obstacles"
    __table_args__ = (
        Index("ix_known_obstacles_lat_lng", "lat", "lng"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    radius_m: Mapped[float] = mapped_column(Float, default=2.0)
    top_m: Mapped[float] = mapped_column(Float, default=0.0)  # AGL, 0 = unknown
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    hits: Mapped[int] = mapped_column(Integer, default=1)
    source: Mapped[str] = mapped_column(String(20), default="")  # sensor kind
    first_seen: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow)
    last_seen: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id, "lat": self.lat, "lng": self.lng,
            "radius_m": self.radius_m, "top_m": self.top_m,
            "confidence": self.confidence, "hits": self.hits,
            "source": self.source,
            "last_seen": self.last_seen.isoformat() if self.last_seen else None,
        }


class CrowdSnapshot(Base):
    """
    A sampled crowd-density reading (~every 2s while crowd-management mode
    is active) - a live table for the session, purged at session end (see
    app/vision/persistence.py). session_id is a plain indexed string, not a
    FK: sessions are ephemeral/in-memory (same pattern as Flight.session_id).
    """
    __tablename__ = "crowd_snapshots"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(String(36), index=True)
    # The workspace this row belongs to (docs/ACCESS_MODEL.md 8b), stamped
    # at record time from the session's workspace. A plain indexed string, not a FK:
    # history must never fail to write, and a deleted workspace's rows stay
    # readable by founders. Rows from before phase 2b are HYRAK's.
    workspace_id: Mapped[str] = mapped_column(
        String(36), index=True,
        default=PLATFORM_WORKSPACE_ID, server_default=PLATFORM_WORKSPACE_ID,
    )
    t: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    current_count: Mapped[int] = mapped_column(Integer, default=0)
    peak_count: Mapped[int] = mapped_column(Integer, default=0)
    density_level: Mapped[str] = mapped_column(String(10), default="green")
    section_counts: Mapped[dict] = mapped_column(JSONB_COL, default=dict)

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
    # The workspace this row belongs to (docs/ACCESS_MODEL.md 8b), stamped
    # at record time from the session's workspace. A plain indexed string, not a FK:
    # history must never fail to write, and a deleted workspace's rows stay
    # readable by founders. Rows from before phase 2b are HYRAK's.
    workspace_id: Mapped[str] = mapped_column(
        String(36), index=True,
        default=PLATFORM_WORKSPACE_ID, server_default=PLATFORM_WORKSPACE_ID,
    )
    t: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    level: Mapped[str] = mapped_column(String(10), default="orange")
    section_idx: Mapped[int] = mapped_column(Integer, default=-1)
    count: Mapped[int] = mapped_column(Integer, default=0)
    message: Mapped[str] = mapped_column(String(300), default="")

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "workspace_id": self.workspace_id,
            "t": self.t.isoformat() if self.t else None,
            "level": self.level,
            "section_idx": self.section_idx,
            "count": self.count,
            "message": self.message,
        }


class PlateEvent(Base):
    """
    One row per vehicle (best-confidence plate reading, logged once when its
    track finalizes - not per frame, and not per fragment if the same plate
    is re-read within a cooldown window). Retained until an operator
    explicitly downloads/clears the history - see app/vision/persistence.py.
    """
    __tablename__ = "plate_events"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    session_id: Mapped[str] = mapped_column(String(36), index=True)
    # The workspace this row belongs to (docs/ACCESS_MODEL.md 8b), stamped
    # at record time from the session's workspace. A plain indexed string, not a FK:
    # history must never fail to write, and a deleted workspace's rows stay
    # readable by founders. Rows from before phase 2b are HYRAK's.
    workspace_id: Mapped[str] = mapped_column(
        String(36), index=True,
        default=PLATFORM_WORKSPACE_ID, server_default=PLATFORM_WORKSPACE_ID,
    )
    track_id: Mapped[int] = mapped_column(Integer, default=0)
    # This module's own persistent identity for the vehicle (e.g. "VH-000042"),
    # distinct from track_id: ByteTrack ids reset on occlusion, this survives -
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
    vehicle_box: Mapped[Optional[list]] = mapped_column(JSONB_COL, nullable=True)
    plate_box: Mapped[Optional[list]] = mapped_column(JSONB_COL, nullable=True)
    # How many pixels across the plate actually was. The single most useful
    # quality indicator for a reading, and the reason it is stored rather than
    # used as a hard reject filter: on real footage from this rig plates arrive
    # 31-79px wide, so a width gate strict enough to guarantee a good read
    # rejects nearly every genuine plate. Recording it instead lets a reading
    # be judged after the fact without throwing the data away first.
    plate_px_w: Mapped[int] = mapped_column(Integer, default=0)
    # The other two evidence fields. Both were computed per frame and shown
    # live, then discarded when the row was written - so a report could be
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
    # local flow, NOT to any map or declared road direction - there is neither
    # available here. See traffic_manager._update_flow.
    against_flow: Mapped[bool] = mapped_column(Boolean, default=False)
    image_path: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    # The whole-vehicle shot beside the plate crop. A 40x18px plate crop on its
    # own is unreviewable - you cannot tell a plate from a badge from an
    # overlay - so the car photo is what makes a row checkable by a human.
    vehicle_image_path: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    lat: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    lng: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    alt_m: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    # Ground-sample-distance estimate from drone altitude/FOV - NOT a
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
            "workspace_id": self.workspace_id,
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
# and `person_faces` instead hold durable biometric identity - a face template
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

    Deleting a Person cascades to their faces and unlinks the image files -
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
    # the enrolment - useful when a match keeps misfiring and you want to
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
        roughly 10 KB as a JSON array of decimal strings - and the round trip
        through text loses bits. Packed float32 is compact and exact.
        np.frombuffer on the way out is free.

    WHY THE IMAGE STAYS ON DISK
        Same reasoning as plate_events.image_path: image bytes in Postgres
        bloat the table and every backup of it. More importantly the original
        is the RE-ENROLMENT path - see model_name below.

    WHY model_name AND dim ARE STORED
        Embeddings from different face models are not comparable. buffalo_sc
        and buffalo_l are both 512-dim, so a mismatch does not raise or even
        look wrong - it silently produces meaningless cosine similarities and
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
        """Metadata only - the embedding itself is never serialised to a
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
    A gallery match during a session - the audit trail for "the drone said
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
    # The workspace this row belongs to (docs/ACCESS_MODEL.md 8b), stamped
    # at record time from the session's workspace. A plain indexed string, not a FK:
    # history must never fail to write, and a deleted workspace's rows stay
    # readable by founders. Rows from before phase 2b are HYRAK's.
    workspace_id: Mapped[str] = mapped_column(
        String(36), index=True,
        default=PLATFORM_WORKSPACE_ID, server_default=PLATFORM_WORKSPACE_ID,
    )
    person_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("persons.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Denormalised so the log still reads correctly after a person is deleted.
    person_name: Mapped[str] = mapped_column(String(120), default="")
    t: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    similarity: Mapped[float] = mapped_column(Float, default=0.0)
    track_id: Mapped[int] = mapped_column(Integer, default=0)
    # Where the drone was, not where the person was - the same honest
    # distinction plate_events draws.
    lat: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    lng: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    alt_m: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    image_path: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "session_id": self.session_id,
            "workspace_id": self.workspace_id,
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


# ── Users and bearer tokens (app/auth) ───────────────────────────────────


class User(Base):
    """
    One person who can sign in. The password is a scrypt hash (see
    app/auth/passwords.py). What they may do lives in memberships, one per
    workspace (docs/ACCESS_MODEL.md); the old single role column is gone.
    Email is unique and stored lower-case; accounts from before workspaces
    have none. An email is an unverified claim unless email_verified.
    """
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    email: Mapped[Optional[str]] = mapped_column(String(254), nullable=True, unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(120), default="", server_default="")
    last_login_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    # True only when an email-locked invite to exactly this address was
    # accepted, or a founder set the address. Lookups by email and
    # email-locked invites trust verified addresses only.
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))

    __table_args__ = (
        CheckConstraint("email = lower(email)", name="ck_users_email_lower"),
    )


class AuthToken(Base):
    """
    A signed-in browser or script. Only the SHA-256 of the bearer token is
    stored, exactly like api_keys: a database dump cannot be replayed.
    expires_at slides forward on use; last_seen_at is for the admin's
    "is this still in use" question.
    """
    __tablename__ = "auth_tokens"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    label: Mapped[str] = mapped_column(String(120), default="")


# ── Workspaces, memberships, invites (docs/ACCESS_MODEL.md) ──────────────


class Workspace(Base):
    """
    A node in the customer tree: the one platform row (HYRAK) at the root,
    organizations and individuals under it, clients under organizations.
    `path` is the materialized chain of ids, "/<root>/<org>/<client>/", so
    "everything below X" is a prefix match on an indexed column and never a
    recursive query.
    """
    __tablename__ = "workspaces"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    kind: Mapped[str] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(120))
    parent_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    path: Mapped[str] = mapped_column(String(400))
    operating_area: Mapped[Optional[dict]] = mapped_column(JSONB_COL, nullable=True)
    disabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    # Paid extras switched on per workspace by a founder, e.g.
    # {"cloud_sim": true} (docs/ACCESS_MODEL.md 8c). Absent key = off.
    features: Mapped[dict] = mapped_column(JSONB_COL, nullable=False, default=dict,
                                           server_default=text("'{}'"))
    created_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    __table_args__ = (
        CheckConstraint("kind IN ('platform', 'organization', 'individual', 'client')",
                        name="ck_workspaces_kind"),
        CheckConstraint("(kind = 'platform') = (parent_id IS NULL)",
                        name="ck_workspaces_platform_root"),
        Index("ux_workspaces_single_platform", "kind", unique=True,
              postgresql_where=text("kind = 'platform'")),
        Index("ix_workspaces_path", "path", postgresql_ops={"path": "varchar_pattern_ops"}),
    )


class Membership(Base):
    """
    One role a user holds on one workspace, optionally limited to a GeoJSON
    area. A membership covers the workspace and everything below it, except
    on the platform workspace where only founders inherit downward.
    """
    __tablename__ = "memberships"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(16))
    area: Mapped[Optional[dict]] = mapped_column(JSONB_COL, nullable=True)
    title: Mapped[str] = mapped_column(String(120), default="", server_default="")
    created_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    __table_args__ = (
        UniqueConstraint("user_id", "workspace_id", name="uq_memberships_user_workspace"),
        CheckConstraint(
            "role IN ('founder', 'airspace', 'manager', 'owner', 'admin', 'pilot', 'viewer')",
            name="ck_memberships_role",
        ),
    )


class Invite(Base):
    """
    A single-use link that grants a membership (and, for someone without an
    account, creates one). Only the SHA-256 of the token is stored.
    """
    __tablename__ = "invites"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(16))
    area: Mapped[Optional[dict]] = mapped_column(JSONB_COL, nullable=True)
    title: Mapped[str] = mapped_column(String(120), default="", server_default="")
    email: Mapped[Optional[str]] = mapped_column(String(254), nullable=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    accepted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    accepted_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class PasswordReset(Base):
    """A founder-issued one-hour, single-use password reset link (hash only)."""
    __tablename__ = "password_resets"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class AuditEvent(Base):
    """
    Who changed access or airspace, when, from where. Deliberately no
    foreign keys: the trail must outlive the user, workspace or zone it
    talks about.
    """
    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, index=True)
    actor_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    actor_name: Mapped[str] = mapped_column(String(64), default="", server_default="")
    workspace_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(64))
    target_type: Mapped[str] = mapped_column(String(32), default="", server_default="")
    target_id: Mapped[str] = mapped_column(String(64), default="", server_default="")
    detail: Mapped[Optional[dict]] = mapped_column(JSONB_COL, nullable=True)
    ip: Mapped[str] = mapped_column(String(64), default="", server_default="")


class CustomModel(Base):
    """
    A model in a workspace's library (docs/custom_models/DESIGN.md section 0):
    an uploaded ONNX file or one from a public Hugging Face repo. Its files
    and checks live in model_versions; `current_version` is the newest
    version that passed its check (the one that runs), while `status`,
    `error` and `error_hint` describe the newest version, so a failed
    re-upload says what is wrong while the previous version keeps running.
    `published` puts it in the HYRAK catalogue (founders only), visible to
    every workspace, pinned to `published_version` (see below). `settings` holds the run options: score threshold and
    the optional alert rule.
    """
    __tablename__ = "models"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(String(500), default="", server_default="")
    task: Mapped[str] = mapped_column(String(16), default="", server_default="")
    source: Mapped[str] = mapped_column(String(16))
    hf_repo: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    hf_revision: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    hf_file: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)
    status: Mapped[str] = mapped_column(String(12), default="checking")
    error: Mapped[str] = mapped_column(String(500), default="", server_default="")
    error_hint: Mapped[str] = mapped_column(String(500), default="", server_default="")
    current_version: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    published: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"),
                                            index=True)
    # The catalogue is pinned: a founder publishes ONE version, and what
    # other workspaces see and run (name, labels, task, threshold, the
    # inspect spec) is the snapshot taken then, in `catalogue`. The owning
    # workspace keeps editing its own copy; only a founder moves the pin.
    published_version: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    catalogue: Mapped[Optional[dict]] = mapped_column(JSONB_COL, nullable=True)
    settings: Mapped[dict] = mapped_column(JSONB_COL, nullable=False, default=dict,
                                           server_default=text("'{}'"))
    created_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    __table_args__ = (
        CheckConstraint("source IN ('upload', 'huggingface')", name="ck_models_source"),
        CheckConstraint("status IN ('checking', 'ready', 'failed')", name="ck_models_status"),
    )


class CustomModelVersion(Base):
    """
    One received file of a model: v1 from the first upload or import, v2
    from the next, and so on. What the check found (task, input shape,
    labels, the inspection details) and measured (latency on our GPU, GPU
    memory) is kept per version, as is the version's own check status.
    """
    __tablename__ = "model_versions"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    model_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("models.id", ondelete="CASCADE"), index=True)
    n: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64), default="", server_default="")
    size_bytes: Mapped[int] = mapped_column(BigInteger, default=0, server_default=text("0"))
    file_name: Mapped[str] = mapped_column(String(300), default="", server_default="")
    hf_revision: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(12), default="checking")
    error: Mapped[str] = mapped_column(String(500), default="", server_default="")
    error_hint: Mapped[str] = mapped_column(String(500), default="", server_default="")
    task: Mapped[str] = mapped_column(String(16), default="", server_default="")
    input_shape: Mapped[Optional[list]] = mapped_column(JSONB_COL, nullable=True)
    labels: Mapped[list] = mapped_column(JSONB_COL, nullable=False, default=list,
                                         server_default=text("'[]'"))
    details: Mapped[dict] = mapped_column(JSONB_COL, nullable=False, default=dict,
                                          server_default=text("'{}'"))
    latency_ms: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    gpu_mem_mb: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    preview_path: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    __table_args__ = (
        UniqueConstraint("model_id", "n", name="uq_model_versions_model_n"),
        CheckConstraint("status IN ('checking', 'ready', 'failed')",
                        name="ck_model_versions_status"),
    )


class MapSighting(Base):
    """
    One object a model saw, placed on the map (app/mapdetect): many frames of
    the same thing folded into one row with a count, first/last seen and the
    best score. Written only while the operator has "Record to map" on; the
    live map works from memory without it.

    Positions are ESTIMATES projected from the drone's GPS, height and camera
    angle (app/mapdetect/geo.py has the assumptions); accuracy_m is the
    typical error. flight_id is the flight that was armed at the time (None
    when recorded on the ground). workspace_id is the session's, stamped at
    record time, a plain indexed string like the other history tables
    (docs/ACCESS_MODEL.md 8b).
    """
    __tablename__ = "map_sightings"
    __table_args__ = (
        CheckConstraint("task IN ('detect', 'classify')", name="ck_map_sightings_task"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True,
                                    default=lambda: str(uuid.uuid4()))
    session_id: Mapped[str] = mapped_column(String(36), index=True)
    flight_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True, index=True)
    workspace_id: Mapped[str] = mapped_column(
        String(36), index=True,
        default=PLATFORM_WORKSPACE_ID, server_default=PLATFORM_WORKSPACE_ID,
    )
    drone_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    source: Mapped[str] = mapped_column(String(80), default="")
    model_name: Mapped[str] = mapped_column(String(120), default="")
    label: Mapped[str] = mapped_column(String(80))
    task: Mapped[str] = mapped_column(String(16), default="detect")
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    accuracy_m: Mapped[float] = mapped_column(Float)
    count: Mapped[int] = mapped_column(Integer, default=1)
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    best_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    agl_m: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    angle_source: Mapped[str] = mapped_column(String(16), default="")
    # A small JPEG of the best frame's box, as a data URL (a few kB).
    thumb: Mapped[Optional[str]] = mapped_column(String(60000), nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id, "session_id": self.session_id, "flight_id": self.flight_id,
            "workspace_id": self.workspace_id, "drone_id": self.drone_id,
            "source": self.source, "model_name": self.model_name, "label": self.label,
            "task": self.task, "lat": self.lat, "lon": self.lng,
            "accuracy_m": self.accuracy_m, "count": self.count,
            "first_seen": self.first_seen.timestamp() if self.first_seen else None,
            "last_seen": self.last_seen.timestamp() if self.last_seen else None,
            "best_score": self.best_score, "agl_m": self.agl_m,
            "angle_source": self.angle_source, "thumb": self.thumb,
        }
