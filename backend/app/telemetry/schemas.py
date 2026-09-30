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
class LocalPositionData:
    """PX4's LOCAL position (EKF2, metres from its origin, NED). Exists
    without GPS - optical flow, a rangefinder, visual odometry or motion
    capture feed it - which is what indoor navigation runs on. `valid` is
    set once PX4 reports it; `t` is the monotonic arrival time."""
    north_m: float = 0.0
    east_m: float = 0.0
    down_m: float = 0.0
    valid: bool = False
    t: float = 0.0


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
    seen: bool = False          # a GPS message has arrived (fix 0 then = NO_GPS, not unknown)
    satellites_visible: int = 0
    hdop: float = 0.0


@dataclass
class RcStatusData:
    """The RC receiver as the AUTOPILOT sees it - the only view that
    matters for "will the sticks work": a transmitter that is on but not
    bound shows here as unavailable."""

    was_available: bool = False
    available: bool = False
    signal_pct: float = 0.0


@dataclass
class SensorHealthData:
    """The autopilot's own verdict on each sensor, from the MAVSDK health
    stream (SYS_STATUS / heartbeat health bits on the wire).

    THIS IS WHAT "CALIBRATED" MEANS ON THE SENSORS PAGE. The UI used to infer
    sensor health from the data itself - heading != 0 meant the compass was
    fine - which reports a healthy compass as broken whenever the aircraft
    happens to face magnetic north. PX4 already computes the real answer and
    QGC displays exactly these flags; now so do we.

    `received` separates "the autopilot says not calibrated" from "no health
    message has arrived yet" - without it a freshly connected aircraft would
    flash every sensor red for the first second.
    """
    received: bool = False
    gyro_cal_ok: bool = False
    accel_cal_ok: bool = False
    mag_cal_ok: bool = False
    local_position_ok: bool = False
    global_position_ok: bool = False
    home_position_ok: bool = False
    armable: bool = False


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

    All fields come directly from MAVLink messages via MAVSDK - no extra
    hardware required beyond standard PX4 quadrotor sensors (IMU + GPS).

    Wind: estimated by PX4 EKF2 from GPS velocity vs. airspeed delta.
          Available via WIND_COV MAVLink message / MAVSDK telemetry.fixedwing_metrics
          (works on multirotors too when flying - PX4 always runs wind estimation).
    Mission index: from MISSION_CURRENT MAVLink msg (MAVSDK mission.mission_progress).
    Home position: from HOME_POSITION MAVLink msg (MAVSDK telemetry.home).
    """
    attitude: AttitudeData = field(default_factory=AttitudeData)
    position: PositionData = field(default_factory=PositionData)
    velocity: VelocityData = field(default_factory=VelocityData)
    local_position: LocalPositionData = field(default_factory=LocalPositionData)
    # Downward rangefinder (m), None = no reading. Indoors this is the height.
    rangefinder_m: float | None = None
    battery: BatteryData = field(default_factory=BatteryData)
    gps: GPSData = field(default_factory=GPSData)
    flight_mode: FlightModeData = field(default_factory=FlightModeData)
    health: SensorHealthData = field(default_factory=SensorHealthData)
    rc: RcStatusData = field(default_factory=RcStatusData)
    groundspeed_m_s: float = 0.0
    heading_deg: float = 0.0
    home_distance_m: float = 0.0
    # Wind estimation from PX4 EKF2 (no extra sensor - derived from GPS+IMU)
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
    # ── Altitude accountability ──────────────────────────────────────────
    # What WAS ASKED FOR, kept beside what the drone reports, because those
    # are two different numbers and only one of them was ever visible.
    #
    # Commanding 2 m and levelling at 5 m is not detectable from the altitude
    # readout alone - it reads 5 and looks like a correct 5. The operator has
    # to remember what they typed and notice the difference, which is exactly
    # what does not happen on a busy flight line. Carrying the target on the
    # snapshot lets the UI put them side by side and say so.
    # MEASURED stream rates, Hz, keyed by stream name - what the link actually
    # delivered, not what was requested. On a 3DR radio the ceiling is set by
    # AIR_SPEED and ECC on the radio itself, which nothing here can read, so
    # the only honest answer to "how fast can this link go" is to turn the
    # request up and watch whether these follow.
    measured_rates: dict = field(default_factory=dict)
    commanded_altitude_m: Optional[float] = None
    # Filled once the climb has settled and the two disagree by more than the
    # tolerance. Plain text, because the cause is on the VEHICLE (parameter,
    # barometer, ground effect) and no code here can fix it - only report it
    # while the operator can still act.
    altitude_warning: Optional[str] = None
    # ── Who is flying ────────────────────────────────────────────────────
    # WHETHER THE APP IS COMMANDING IS NOT THE SAME QUESTION AS WHICH MODE
    # THE AIRCRAFT IS IN, and until now only the second was on the wire. The
    # operator could see "OFFBOARD" and infer the app was flying, but not the
    # reverse: an app that BELIEVES it is flying while PX4 has already handed
    # the aircraft to the pilot looked identical to one that is.
    offboard_active: bool = False
    # Set to the mode PX4 moved to when the aircraft left Offboard WITHOUT
    # this app asking - i.e. the pilot took it, on the mode switch or on the
    # sticks. None means the app still holds it (or never did). This is a
    # LATCH, not a live comparison: it stays set until somebody deliberately
    # takes control back, so that a stray tap cannot snatch the aircraft out
    # of a pilot's hands mid-recovery.
    pilot_override: Optional[str] = None
    # ── Link health ──────────────────────────────────────────────────────
    # False while this link has delivered nothing for LINK_STALE_S; the
    # operator sees LINK LOST within ~2 s instead of when MAVSDK's 3 s
    # heartbeat timeout fires (and that one never says which link it was).
    link_ok: bool = True
    link_lost_s: float = 0.0

    def to_dict(self) -> dict:
        return {
            "attitude": self.attitude.__dict__,
            "position": self.position.__dict__,
            "velocity": self.velocity.__dict__,
            "local_position": self.local_position.__dict__,
            "rangefinder_m": self.rangefinder_m,
            "battery": self.battery.__dict__,
            "gps": self.gps.__dict__,
            "flight_mode": self.flight_mode.__dict__,
            "health": self.health.__dict__,
            "rc": self.rc.__dict__,
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
            "measured_rates": dict(self.measured_rates),
            "commanded_altitude_m": self.commanded_altitude_m,
            "altitude_warning": self.altitude_warning,
            "offboard_active": self.offboard_active,
            "pilot_override": self.pilot_override,
            "link_ok": self.link_ok,
            "link_lost_s": round(self.link_lost_s, 1),
        }


@dataclass
class DroneCommand:
    """Normalized command values. All axes -1.0 to 1.0, throttle 0.0 to 1.0."""
    roll: float = 0.0
    pitch: float = 0.0
    yaw: float = 0.0
    throttle: float = 0.5

    def __post_init__(self):
        # Hard clamp - never send out-of-range values to a drone
        self.roll = max(-1.0, min(1.0, self.roll))
        self.pitch = max(-1.0, min(1.0, self.pitch))
        self.yaw = max(-1.0, min(1.0, self.yaw))
        self.throttle = max(0.0, min(1.0, self.throttle))