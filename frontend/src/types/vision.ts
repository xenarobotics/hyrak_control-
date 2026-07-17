export interface DetectedObject {
    name: string
    count: number
}

export interface PersonData {
    id: number
    box: [number, number, number, number]
    conf: number
}

export interface CVResult {
    mode: string
    session_id: string
    analysis_time_ms: number
    timestamp: number
    // Object detection
    objects?: Record<string, number>
    person_count?: number
    total_count?: number
    // Human tracking
    persons?: PersonData[]
    target_id?: number | null
    drone_command?: Record<string, number> | null
    // Depth mapping
    min_depth_m?: number
    max_depth_m?: number
    mean_depth_m?: number
}