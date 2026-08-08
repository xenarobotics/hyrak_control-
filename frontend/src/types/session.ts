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

export type ConnectionStatus =
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'error'

export type TelemetryStatus =
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'error'

export interface SessionInfo {
    session_id: string
    device: string
    gpu_count: number
    max_sessions: number
}