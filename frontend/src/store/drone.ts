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
    // Zone validation results from the backend
    needs_ack?: boolean          // crosses orange - pilot must confirm
    blocked?: 'red'              // crosses red - hard rejection
    can_request?: boolean        // a permit can be requested for this mission
    zones?: { id: string; name: string; zone_class: string }[]
}

/** One line the autopilot said. PX4 emits these for preflight results, EKF
 *  and GPS transitions, failsafes, calibration - everything QGroundControl
 *  shows in its vehicle-messages panel. */
export interface FcMessage {
    severity: string
    text: string
    /** 0 DEBUG … 7 EMERGENCY, MAVSDK's ordering. Ascending, unlike MAVLink's
     *  own SEVERITY enum, which descends. */
    rank: number
    ts: number
    /** Assigned here, not by the sender: identical text repeats constantly
     *  and React needs a stable distinct key. */
    id: number
}

export interface ActionResult {
    action: string
    ok: boolean
    msg?: string
    /** The AUTOPILOT's reason for a refusal, when it gave one - its own
     *  STATUSTEXT ("Arming denied: ...", "Preflight Fail: ..."), which is the
     *  only thing that distinguishes "the drone said no" from "the command
     *  never got there". Without it both look like a dead radio. */
    error?: string
    /** rc_takeover_check only - the aircraft's own answer to "can the pilot
     *  take this back?", read from its parameters. */
    report?: RcTakeoverReport
}

/** Whether the transmitter can take the aircraft back, answered from the
 *  aircraft's parameters before takeoff rather than discovered in the air. */
export interface RcTakeoverReport {
    ok: boolean
    findings: { param: string; value: number; verdict: 'ok' | 'warn' | 'blocked'; detail: string }[]
    unreadable: string[]
    error?: string
}

interface DroneStore {
    // Connection
    connectionStatus: ConnectionStatus
    telemetryStatus: TelemetryStatus
    // Why the last connect attempt failed - shown under the Connect button
    // so a failed connect never ends as a silent spinner-stop.
    telemetryError: string | null
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

    /** The command that has been sent and not yet answered, so a button can
     *  say ARMING… the instant it is pressed. Without this the UI shows
     *  nothing at all for the whole round trip - on a 3DR radio about a
     *  second - which reads as a click that did not register, and the
     *  operator presses it again. */
    pendingAction: { action: string; at: number } | null

    /** The autopilot's message log, newest last. Bounded - this is a live
     *  console for the flight in progress, not a flight recorder. */
    fcMessages: FcMessage[]
    /** How many have arrived since the panel was last read, so the icon can
     *  carry a badge without the panel having to be open. */
    fcUnread: number

    // UI
    isEmergencyConfirm: boolean

    // Actions
    setPendingAction: (action: string | null) => void
    addFcMessage: (m: Omit<FcMessage, 'id'>) => void
    clearFcMessages: () => void
    markFcRead: () => void
    setConnectionStatus: (s: ConnectionStatus) => void
    setTelemetryStatus: (s: TelemetryStatus) => void
    setTelemetryError: (msg: string | null) => void
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

/** Enough to cover a whole flight's worth of interesting lines without
 *  letting a failsafe loop grow the array without bound. */
const FC_MESSAGE_LIMIT = 300
let nextFcId = 1

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
    telemetryError: null,
    session: null,
    telemetry: null,
    mode: 'manual-control',
    cvResults: null,
    modelLoading: false,
    missionUploadResult: null,
    lastActionResult: null,
    droneMissionOffer: null,
    pendingAction: null,
    fcMessages: [],
    fcUnread: 0,
    isEmergencyConfirm: false,

    setConnectionStatus: (s) => set({ connectionStatus: s }),
    // Starting a new attempt or connecting successfully clears the stale error.
    setTelemetryStatus: (s) => set(state => ({
        telemetryStatus: s,
        telemetryError: (s === 'connecting' || s === 'connected') ? null : state.telemetryError,
    })),
    setTelemetryError: (msg) => set({ telemetryError: msg }),
    setSession: (s) => set({ session: s }),
    setTelemetry: (t) => set({ telemetry: t }),
    setMode: (m) => set({ mode: m }),
    setModelLoading: (v) => set({ modelLoading: v }),
    setEmergencyConfirm: (v) => set({ isEmergencyConfirm: v }),
    setCvResults: (r) => set({ cvResults: r }),
    setMissionUploadResult: (r) => set({ missionUploadResult: r }),
    setPendingAction: (action) => set({
        pendingAction: action ? { action, at: Date.now() } : null,
    }),
    // THE ACK IS THE FIRST NEWS, AND IT WAS BEING THROWN AWAY.
    //
    // Arming used to take two visible seconds: about one for the command to
    // reach the drone and be acknowledged, then up to another whole second
    // before the button changed - because the button watched
    // telemetry.flight_mode.is_armed, which is decoded from HEARTBEAT, and
    // PX4 sends HEARTBEAT at 1 Hz. So the UI sat on a stale `false` waiting
    // for a periodic message to repeat something it had already been told.
    //
    // A successful action_result for arm IS the vehicle's acknowledgement:
    // MAVSDK only resolves arm() on MAV_RESULT_ACCEPTED. Folding it into the
    // snapshot is not optimism - it is using the earlier of two reports of
    // the same fact. The heartbeat still arrives and still overwrites this;
    // if the two ever disagreed, the stream wins within the second.
    setLastActionResult: (r) => set(state => {
        const next: Partial<DroneStore> = { lastActionResult: r, pendingAction: null }
        const armState = r?.ok
            ? (r.action === 'arm' ? true : r.action === 'disarm' ? false : null)
            : null
        if (armState !== null && state.telemetry) {
            next.telemetry = {
                ...state.telemetry,
                flight_mode: { ...state.telemetry.flight_mode, is_armed: armState },
            }
        }
        return next
    }),
    setDroneMissionOffer: (wps) => set({ droneMissionOffer: wps }),
    addFcMessage: (m) => set(state => {
        // Trim from the FRONT. A failsafe loop or a chatty boot can emit
        // hundreds of lines, and an unbounded array behind a live socket is
        // how a long flight ends in a dead tab.
        const next = [...state.fcMessages, { ...m, id: nextFcId++ }]
        if (next.length > FC_MESSAGE_LIMIT) next.splice(0, next.length - FC_MESSAGE_LIMIT)
        return { fcMessages: next, fcUnread: state.fcUnread + 1 }
    }),
    clearFcMessages: () => set({ fcMessages: [], fcUnread: 0 }),
    markFcRead: () => set({ fcUnread: 0 }),
    reset: () => set({
        connectionStatus: 'disconnected',
        telemetryStatus: 'disconnected',
        telemetryError: null,
        session: null,
        telemetry: null,
        mode: 'manual-control',
        cvResults: null,
        modelLoading: false,
        missionUploadResult: null,
        lastActionResult: null,
        droneMissionOffer: null,
        pendingAction: null,
        fcMessages: [],
        fcUnread: 0,
        isEmergencyConfirm: false,
    }),
}))