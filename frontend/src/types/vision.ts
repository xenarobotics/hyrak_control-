export interface DetectedObject {
    name: string
    count: number
}

export interface PersonData {
    id: number
    box: [number, number, number, number]
    conf: number
}

export interface Detection {
    name: string
    box: [number, number, number, number]
}

export interface CVResult {
    mode: string
    session_id: string
    analysis_time_ms: number
    timestamp: number
    // Source frame size the box coordinates refer to (for canvas scaling)
    frame_w?: number
    frame_h?: number
    // Object detection
    objects?: Record<string, number>
    detections?: Detection[]
    person_count?: number
    total_count?: number
    // Human tracking
    persons?: PersonData[]
    selected_id?: number | null
    target_id?: number | null
    tracking?: boolean
    searching?: boolean
    face_confirmed?: boolean
    frames_lost?: number
    similarity?: number
    drone_command?: Record<string, number> | null
    // Depth mapping
    min_depth_m?: number
    max_depth_m?: number
    mean_depth_m?: number
}