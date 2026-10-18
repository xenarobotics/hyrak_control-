from dataclasses import dataclass, field
from typing import Optional
from enum import Enum
import uuid


class AnalysisMode(str, Enum):
    MANUAL_CONTROL  = "manual-control"
    OBJECT_DETECT   = "object-detection"
    HUMAN_TRACKING  = "human-tracking"
    DEPTH_MAPPING   = "depth-mapping"
    OBSTACLE_AVOID  = "obstacle-avoidance"
    SCENARIO        = "scenario-assessment"
    TARGET_ID       = "target-identification"
    PERSON_TRACK    = "person-tracking"
    ENHANCE         = "enhance"
    CROWD_MANAGEMENT = "crowd-management"
    VEHICLE_PLATE    = "vehicle-plate-tracking"
    # The composed vehicle module: count + type + colour + plate + speed +
    # follow in one pass. See vision/modules/traffic_manager.py on why this
    # merges the vehicle analytics but deliberately not crowd or face -
    # those need incompatible altitudes.
    TRAFFIC          = "traffic-management"
    # Bridges session frames into the reconstruction sidecar (dronemap) -
    # the frames come from whatever video source the session uses, exactly
    # like every other mode; the 3D map is the output.
    RECONSTRUCTION_3D = "3d-reconstruction"


@dataclass
class DroneSession:
    """
    One session = one browser tab connected to one drone.
    Everything scoped to this session - telemetry, vision, commands.
    """
    session_id: str           = field(default_factory=lambda: str(uuid.uuid4()))
    socket_id:  str           = ""
    # Session survival across a socket drop: every socket id this session has
    # had (callbacks captured the one current when they were made; a returning
    # socket joins all of their rooms), and when it lost its socket.
    sid_aliases: list = field(default_factory=list)
    detached_at: Optional[float] = None
    last_mission: Optional[list] = None   # waypoints last uploaded by this session
    mode:       AnalysisMode  = AnalysisMode.MANUAL_CONTROL
    is_streaming: bool        = False
    telemetry_connected: bool = False
    drone_address: str        = ""

    # These get set after connection
    pc_id: Optional[str]      = None   # WebRTC peer connection id

    # Persistent drone identity, resolved after telemetry connect:
    # hardware_uid comes from the FC (MAVLink AUTOPILOT_VERSION); drone is
    # the registry record (None when the DB is offline or UID unreadable).
    hardware_uid: Optional[str] = None
    drone: Optional[dict]       = None

    # Where the CLIENT roughly is (IP geolocation) - lets the admin map place
    # a drone with no GPS fix near its operator instead of nowhere.
    client_ip: Optional[str]        = None
    approx_location: Optional[dict] = None  # {lat, lng, city, country}

    # True while the red-zone pushback owns the drone - manual-control
    # inputs are dropped until the zone monitor releases it.
    zone_lock: bool = False

    # /admin observer sockets get a session too (same connect path) but are
    # excluded from the client list and never own a drone.
    is_admin: bool            = False

    # Who is behind this socket (stamped at connect from the bearer token,
    # app/auth). role is the whole permission check for command events:
    # viewer < operator < admin. resume_secret is handed to the client in
    # session_ready and must come back with resume_session - a session id
    # alone never reclaims a drone. superseded_sids: sockets this session
    # left behind when the client reconnected before their timeout.
    # For customer sessions the check is on `perms` below, not `role`.
    user_id: Optional[str]    = None
    username: Optional[str]   = None
    role: Optional[str]       = None
    resume_secret: Optional[str] = None
    superseded_sids: list     = field(default_factory=list)
    # SHA-256 of the bearer token this socket connected with (None for the
    # legacy shared token), and when the guard last re-checked it: a token
    # revoked or a role changed mid-session is enforced on the next command,
    # not on the next page load.
    token_hash: Optional[str] = None
    auth_checked_at: float    = 0.0

    # The workspace this session belongs to (docs/ACCESS_MODEL.md 8a) and
    # what the user may do there. A session belongs to exactly one
    # workspace for its whole life, resume included; switching workspace in
    # the UI opens a new socket. is_staff picks the guard: staff sessions
    # are checked against the compatibility `role`, customer sessions
    # against `perms`. memberships are the user's, refreshed with the role,
    # for the drone check (a drone can sit in another workspace).
    workspace_id: Optional[str] = None
    perms: frozenset          = field(default_factory=frozenset)
    is_staff: bool            = False
    memberships: tuple        = ()
    # May this session command the drone on its link: True / False once
    # the drone's identity and workspace are known, None before that (or
    # when it cannot be known: no UID, registry offline). See
    # app/auth/live_scope.py.
    drone_fly: Optional[bool] = None
    # Whether the CURRENT link is simulator-type (live_scope.SIM_LINK: a
    # direct udp address a staff connect_telemetry opened), set with the
    # identity. Drone ownership is skipped only when this AND the registry
    # record's stored is_simulated are both true.
    link_simulated: bool      = False

    # Swarm fleet: drone_id → TelemetryManager (populated when swarm mode is used)
    fleet: dict               = field(default_factory=dict)