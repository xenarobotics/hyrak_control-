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


@dataclass
class DroneSession:
    """
    One session = one browser tab connected to one drone.
    Everything scoped to this session — telemetry, vision, commands.
    """
    session_id: str           = field(default_factory=lambda: str(uuid.uuid4()))
    socket_id:  str           = ""
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

    # Where the CLIENT roughly is (IP geolocation) — lets the admin map place
    # a drone with no GPS fix near its operator instead of nowhere.
    client_ip: Optional[str]        = None
    approx_location: Optional[dict] = None  # {lat, lng, city, country}

    # True while the red-zone pushback owns the drone — manual-control
    # inputs are dropped until the zone monitor releases it.
    zone_lock: bool = False

    # /admin observer sockets get a session too (same connect path) but are
    # excluded from the client list and never own a drone.
    is_admin: bool            = False

    # Swarm fleet: drone_id → TelemetryManager (populated when swarm mode is used)
    fleet: dict               = field(default_factory=dict)