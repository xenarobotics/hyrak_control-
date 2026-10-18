import type { Perm } from '@/lib/access'

export type AnalysisMode =
    | 'manual-control'
    | 'object-detection'
    | 'human-tracking'
    | 'depth-mapping'
    | 'obstacle-avoidance'
    | 'scenario-assessment'
    | 'target-identification'
    | 'person-tracking'
    | 'enhance'
    | 'crowd-management'
    | 'vehicle-plate-tracking'
    // The composed vehicle module: count + type + colour + plate + speed +
    // follow in one pass. Merges the analytics that share an altitude band;
    // crowd and face stay separate because they do not.
    | 'traffic-management'
    // Frontend-only mode: drives the reconstruction sidecar via /api/recon,
    // never sent to the session's vision pipeline as an analysis mode.
    | '3d-reconstruction'

export type ConnectionStatus =
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'reconnecting'   // socket dropped; the cloud session (and drone link) is being held for us
    | 'error'

/** The WebRTC video stream's own state, kept apart from the cloud socket. */
export type StreamStatus =
    | 'idle'
    | 'connecting'
    | 'connected'
    | 'error'

export type TelemetryStatus =
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'error'

/** The registry's record for the aircraft this session is flying, as the
 *  backend's drone_identity event carries it. */
export interface BoundDrone {
    id: string
    name?: string
    hardware_uid?: string
    is_simulated?: boolean
}

export interface SessionInfo {
    session_id: string
    device: string
    gpu_count: number
    max_sessions: number
    resumed?: boolean              // true: the server kept our session through a socket drop
    away_s?: number
    telemetry_connected?: boolean
    /** Filled from drone_identity a few seconds after telemetry connects;
     *  cleared when the link drops. Null while no drone is bound. */
    drone?: BoundDrone | null
    hardware_uid?: string | null
    /** Phase 2a (docs/ACCESS_MODEL.md section 8a): the workspace the
     *  session belongs to, the account's perms on it, and whether the
     *  account is staff. Absent from an older server. */
    workspace_id?: string | null
    perms?: Perm[]
    staff?: boolean
    /** Phase 2b: HYRAK operations hold this session's drone (null: no). */
    takeover?: { by: string; since: number } | null
}