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