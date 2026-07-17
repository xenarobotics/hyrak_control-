from dataclasses import dataclass, field
from typing import Optional


@dataclass
class AttitudeData:
    roll_deg: float = 0.0
    pitch_deg: float = 0.0
    yaw_deg: float = 0.0
    rollspeed: float = 0.0
    pitchspeed: float = 0.0
    yawspeed: float = 0.0


@dataclass
class PositionData:
    latitude_deg: float = 0.0
    longitude_deg: float = 0.0
    absolute_altitude_m: float = 0.0
    relative_altitude_m: float = 0.0


@dataclass
class VelocityData:
    north_m_s: float = 0.0
    east_m_s: float = 0.0
    down_m_s: float = 0.0


@dataclass
class BatteryData:
    voltage_v: float = 0.0
    remaining_percent: float = 0.0


@dataclass
class GPSData:
    fix_type: int = 0
    satellites_visible: int = 0
    hdop: float = 0.0


@dataclass
class FlightModeData:
    mode: str = "UNKNOWN"
    is_armed: bool = False
    is_in_air: bool = False


@dataclass
class TelemetrySnapshot:
    """
    Complete drone state at a point in time.
    This is what gets emitted to the frontend via Socket.IO.

    All fields come directly from MAVLink messages via MAVSDK — no extra
    hardware required beyond standard PX4 quadrotor sensors (IMU + GPS).

    Wind: estimated by PX4 EKF2 from GPS velocity vs. airspeed delta.
          Available via WIND_COV MAVLink message / MAVSDK telemetry.fixedwing_metrics
          (works on multirotors too when flying — PX4 always runs wind estimation).
    Mission index: from MISSION_CURRENT MAVLink msg (MAVSDK mission.mission_progress).
    Home position: from HOME_POSITION MAVLink msg (MAVSDK telemetry.home).
    """
    attitude: AttitudeData = field(default_factory=AttitudeData)
    position: PositionData = field(default_factory=PositionData)
    velocity: VelocityData = field(default_factory=VelocityData)
    battery: BatteryData = field(default_factory=BatteryData)
    gps: GPSData = field(default_factory=GPSData)
    flight_mode: FlightModeData = field(default_factory=FlightModeData)
    groundspeed_m_s: float = 0.0
    heading_deg: float = 0.0
    home_distance_m: float = 0.0
    # Wind estimation from PX4 EKF2 (no extra sensor — derived from GPS+IMU)
    wind_north_m_s: float = 0.0
    wind_east_m_s: float = 0.0
    # Active mission waypoint index (-1 = no mission active)
    mission_current_index: int = -1
    # True once mission.is_mission_finished() reports the last item was reached.
    # MISSION_CURRENT freezes at the final index and never signals completion on
    # its own, so this is polled separately (see _poll_mission_finished).
    mission_finished: bool = False
    # Home position (from HOME_POSITION MAVLink msg)
    home_lat: float = 0.0
    home_lng: float = 0.0
    home_alt: float = 0.0

    def to_dict(self) -> dict:
        return {
            "attitude": self.attitude.__dict__,
            "position": self.position.__dict__,
            "velocity": self.velocity.__dict__,
            "battery": self.battery.__dict__,
            "gps": self.gps.__dict__,
            "flight_mode": self.flight_mode.__dict__,
            "groundspeed_m_s": self.groundspeed_m_s,
            "heading_deg": self.heading_deg,
            "home_distance_m": self.home_distance_m,
            "wind_north_m_s": self.wind_north_m_s,
            "wind_east_m_s": self.wind_east_m_s,
            "mission_current_index": self.mission_current_index,
            "mission_finished": self.mission_finished,
            "home_lat": self.home_lat,
            "home_lng": self.home_lng,
            "home_alt": self.home_alt,
        }


@dataclass
class DroneCommand:
    """Normalized command values. All axes -1.0 to 1.0, throttle 0.0 to 1.0."""
    roll: float = 0.0
    pitch: float = 0.0
    yaw: float = 0.0
    throttle: float = 0.5

    def __post_init__(self):
        # Hard clamp — never send out-of-range values to a drone
        self.roll = max(-1.0, min(1.0, self.roll))
        self.pitch = max(-1.0, min(1.0, self.pitch))
        self.yaw = max(-1.0, min(1.0, self.yaw))
        self.throttle = max(0.0, min(1.0, self.throttle))