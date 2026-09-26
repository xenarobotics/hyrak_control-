export interface AttitudeData {
    roll_deg: number
    pitch_deg: number
    yaw_deg: number
    rollspeed: number
    pitchspeed: number
    yawspeed: number
}

export interface PositionData {
    latitude_deg: number
    longitude_deg: number
    absolute_altitude_m: number
    relative_altitude_m: number
}

export interface VelocityData {
    north_m_s: number
    east_m_s: number
    down_m_s: number
}

export interface BatteryData {
    voltage_v: number
    remaining_percent: number
}

export interface GPSData {
    fix_type: number
    satellites_visible: number
}

/** The autopilot's own per-sensor verdict - the same flags QGC shows.
 *  `received` separates "PX4 says not calibrated" from "no health message
 *  yet", so a freshly connected aircraft doesn't flash every sensor red. */
export interface SensorHealthData {
    received: boolean
    gyro_cal_ok: boolean
    accel_cal_ok: boolean
    mag_cal_ok: boolean
    local_position_ok: boolean
    global_position_ok: boolean
    home_position_ok: boolean
    armable: boolean
}

/** The RC receiver as the autopilot sees it. */
export interface RcStatusData {
    was_available: boolean
    available: boolean
    signal_pct: number
}

export interface FlightModeData {
    mode: string
    is_armed: boolean
    is_in_air: boolean
}

export interface TelemetrySnapshot {
    attitude: AttitudeData
    position: PositionData
    velocity: VelocityData
    battery: BatteryData
    gps: GPSData
    flight_mode: FlightModeData
    /** Optional so an older backend that doesn't send it can't crash the UI. */
    health?: SensorHealthData
    rc?: RcStatusData
    groundspeed_m_s: number
    heading_deg: number
    home_distance_m: number
    // Wind from PX4 EKF2 - no extra sensor needed
    wind_north_m_s: number
    wind_east_m_s: number
    // Active mission waypoint (-1 = no mission / not in mission mode)
    mission_current_index: number
    // True once the drone has actually reached the final mission item -
    // mission_current_index freezes at the last index and never signals this itself
    mission_finished: boolean
    // Home position from PX4 HOME_POSITION message
    home_lat: number
    home_lng: number
    home_alt: number
    /** MEASURED stream rates in Hz, keyed by stream name - what the link
     *  actually delivered, not what was requested. A 3DR radio's ceiling is set
     *  by AIR_SPEED and ECC on the radio itself, which nothing here can read,
     *  so the only honest answer to "how fast can this link go" is to raise the
     *  request and watch whether these follow. */
    measured_rates?: Record<string, number>
    /** The altitude that was ASKED for, kept beside the one the drone reports.
     *  Commanding 2 m and levelling at 5 m is undetectable from the altitude
     *  readout alone - it shows 5 and looks like a correct 5. */
    commanded_altitude_m?: number | null
    /** Set once a climb has settled more than the tolerance away from what was
     *  commanded. The cause is on the vehicle (parameter, barometer, ground
     *  effect), so this reports rather than corrects. */
    altitude_warning?: string | null
    /** True while THIS APP is the one flying - i.e. it started Offboard and
     *  believes it still holds it. Not the same question as the flight mode:
     *  after a pilot takes over, the mode line and this disagree, which is the
     *  only time the difference matters. */
    offboard_active?: boolean
    /** The mode PX4 moved to when the aircraft left Offboard WITHOUT the app
     *  asking - the pilot took it, on the mode switch or on the sticks. Null
     *  while the app still holds it. Latched: it stays set until control is
     *  taken back deliberately, so a stray tap cannot snatch the aircraft out
     *  of a pilot's hands mid-recovery. */
    pilot_override?: string | null
    // Backend link watchdog: false after ~2 s with nothing from the aircraft
    link_ok?: boolean
    link_lost_s?: number
}