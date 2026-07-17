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
    groundspeed_m_s: number
    heading_deg: number
    home_distance_m: number
    // Wind from PX4 EKF2 — no extra sensor needed
    wind_north_m_s: number
    wind_east_m_s: number
    // Active mission waypoint (-1 = no mission / not in mission mode)
    mission_current_index: number
    // True once the drone has actually reached the final mission item —
    // mission_current_index freezes at the last index and never signals this itself
    mission_finished: boolean
    // Home position from PX4 HOME_POSITION message
    home_lat: number
    home_lng: number
    home_alt: number
}