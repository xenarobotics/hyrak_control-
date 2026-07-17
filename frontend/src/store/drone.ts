import { create } from 'zustand'
import type { TelemetrySnapshot } from '@/types/telemetry'
import type {
    AnalysisMode,
    ConnectionStatus,
    TelemetryStatus,
    SessionInfo,
} from '@/types/session'
import type { CVResult } from '@/types/vision'

export interface MissionUploadResult {
    ok: boolean
    count?: number
    terrain_follow?: boolean
    msg: string
}

export interface ActionResult {
    action: string
    ok: boolean
}

interface DroneStore {
    // Connection
    connectionStatus: ConnectionStatus
    telemetryStatus: TelemetryStatus
    session: SessionInfo | null

    // Drone state
    telemetry: TelemetrySnapshot | null
    mode: AnalysisMode
    cvResults: CVResult | null
    modelLoading: boolean

    // Mission feedback
    missionUploadResult: MissionUploadResult | null
    lastActionResult: ActionResult | null
    droneMissionOffer: any[] | null   // waypoints downloaded from drone on connect

    // UI
    isEmergencyConfirm: boolean

    // Actions
    setConnectionStatus: (s: ConnectionStatus) => void
    setTelemetryStatus: (s: TelemetryStatus) => void
    setSession: (s: SessionInfo | null) => void
    setTelemetry: (t: TelemetrySnapshot) => void
    setMode: (m: AnalysisMode) => void
    setModelLoading: (v: boolean) => void
    setEmergencyConfirm: (v: boolean) => void
    setCvResults: (r: CVResult | null) => void
    setMissionUploadResult: (r: MissionUploadResult | null) => void
    setLastActionResult: (r: ActionResult | null) => void
    setDroneMissionOffer: (wps: any[] | null) => void
    reset: () => void
}

const defaultTelemetry: TelemetrySnapshot = {
    attitude: { roll_deg: 0, pitch_deg: 0, yaw_deg: 0, rollspeed: 0, pitchspeed: 0, yawspeed: 0 },
    position: { latitude_deg: 0, longitude_deg: 0, absolute_altitude_m: 0, relative_altitude_m: 0 },
    velocity: { north_m_s: 0, east_m_s: 0, down_m_s: 0 },
    battery: { voltage_v: 0, remaining_percent: 0 },
    gps: { fix_type: 0, satellites_visible: 0 },
    flight_mode: { mode: 'UNKNOWN', is_armed: false, is_in_air: false },
    groundspeed_m_s: 0,
    heading_deg: 0,
    home_distance_m: 0,
    wind_north_m_s: 0,
    wind_east_m_s: 0,
    mission_current_index: -1,
    mission_finished: false,
    home_lat: 0,
    home_lng: 0,
    home_alt: 0,
}

export const useDroneStore = create<DroneStore>((set) => ({
    connectionStatus: 'disconnected',
    telemetryStatus: 'disconnected',
    session: null,
    telemetry: null,
    mode: 'manual-control',
    cvResults: null,
    modelLoading: false,
    missionUploadResult: null,
    lastActionResult: null,
    droneMissionOffer: null,
    isEmergencyConfirm: false,

    setConnectionStatus: (s) => set({ connectionStatus: s }),
    setTelemetryStatus: (s) => set({ telemetryStatus: s }),
    setSession: (s) => set({ session: s }),
    setTelemetry: (t) => set({ telemetry: t }),
    setMode: (m) => set({ mode: m }),
    setModelLoading: (v) => set({ modelLoading: v }),
    setEmergencyConfirm: (v) => set({ isEmergencyConfirm: v }),
    setCvResults: (r) => set({ cvResults: r }),
    setMissionUploadResult: (r) => set({ missionUploadResult: r }),
    setLastActionResult: (r) => set({ lastActionResult: r }),
    setDroneMissionOffer: (wps) => set({ droneMissionOffer: wps }),
    reset: () => set({
        connectionStatus: 'disconnected',
        telemetryStatus: 'disconnected',
        session: null,
        telemetry: null,
        mode: 'manual-control',
        cvResults: null,
        modelLoading: false,
        missionUploadResult: null,
        lastActionResult: null,
        droneMissionOffer: null,
        isEmergencyConfirm: false,
    }),
}))