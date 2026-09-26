// Obstacle-avoidance API client. Detection (enable) and control (arm) are
// separate calls on purpose - the trust ladder runs detection advisory-only
// before it ever commands the aircraft.
import { getServerUrl } from '@/lib/server-url'

const TOKEN = process.env.NEXT_PUBLIC_SECRET_TOKEN || ''
const AUTH = { 'X-Auth-Token': TOKEN, 'Content-Type': 'application/json' }
const api = (p: string) => `${getServerUrl()}/api/avoidance${p}`

export interface AvoidanceParams {
    reaction_distance_m: number
    clearance_m: number
    forward_cone_deg: number
    min_confidence: number
    speed_cap_m_s: number
    hold_to_return_s: number
    allow_reroute?: number
    allow_return?: number
    // Redesign (docs/avoidance/ARCHITECTURE_REVIEW.md section 5)
    local_planner?: number          // 1 = grid + Offboard local planner, 0 = legacy mission upload
    local_clearance_m?: number
    ttc_engage_s?: number
    mono_min_alt_m?: number
    mono_speed_cap_m_s?: number
}

export interface SensorInfo {
    kind: 'monocular' | 'depth' | 'tof' | 'rangefinder' | 'lidar'
    mount: string
    max_range_m: number
    fov_deg: number
    enabled: boolean
    confidence: number
    status: 'ok' | 'no_data'
}

export interface AvoidanceStatus {
    drone_id: string
    enabled: boolean
    armed: boolean
    state: 'nominal' | 'holding' | 'rerouted' | 'climbing' | 'avoiding' | 'returning' | 'disabled'
    reason: string
    params: AvoidanceParams
    sensors: SensorInfo[]
    obstacle_count?: number
    recommended_speed_m_s?: number
    committed_path?: boolean
    obstacle_distance_cm: number[]
    sensor_mode?: 'range' | 'mono' | 'none'
    pose_rate_hz?: number
    planner?: { reason: string; speed_m_s: number; free_m: number | null; ttc_s: number | null; heading_deg: number | null } | null
    mono_calibration?: { scale: number | null; fits: number; rejected: number; error_pct_p50: number | null; error_pct_p90: number | null } | null
}

export interface AvoidanceEvent {
    id: number
    drone_id: string
    t: string | null
    action: 'clear' | 'hold' | 'reroute' | 'return'
    state: string
    reason: string
    armed: boolean
    obstacle: { lat: number; lng: number; radius_m: number } | null
    fused_distance_m: number | null
}

async function j<T>(r: Response): Promise<T> { return r.json() as Promise<T> }

export async function getStatus(droneId: string): Promise<AvoidanceStatus> {
    return j(await fetch(api(`/${droneId}/status`)))
}

export async function setEnabled(droneId: string, enabled: boolean,
                                 params?: Partial<AvoidanceParams>): Promise<AvoidanceStatus> {
    return j(await fetch(api(`/${droneId}/enable`), {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({ enabled, params }),
    }))
}

export async function setArmed(droneId: string, armed: boolean): Promise<AvoidanceStatus> {
    return j(await fetch(api(`/${droneId}/arm`), {
        method: 'POST', headers: AUTH, body: JSON.stringify({ armed }),
    }))
}

export async function getSensors(droneId: string): Promise<SensorInfo[]> {
    const d = await j<{ sensors: SensorInfo[] }>(await fetch(api(`/${droneId}/sensors`)))
    return d.sensors
}

export async function setSensors(droneId: string,
                                 sensors: Partial<SensorInfo>[]): Promise<SensorInfo[]> {
    const d = await j<{ sensors: SensorInfo[] }>(await fetch(api(`/${droneId}/sensors`), {
        method: 'POST', headers: AUTH, body: JSON.stringify({ sensors }),
    }))
    return d.sensors
}

export async function getEvents(droneId: string, limit = 50): Promise<AvoidanceEvent[]> {
    const d = await j<{ events: AvoidanceEvent[] }>(
        await fetch(api(`/${droneId}/events?limit=${limit}`)))
    return d.events
}

// --- obstacle / hazard-map overlay data ---
export interface LiveObstacle {
    lat: number; lng: number; radius_m: number; top_m: number
    speed_mps: number; is_static: boolean; hits: number
}
export interface KnownHazard {
    id: string; lat: number; lng: number; radius_m: number
    top_m: number; confidence: number; hits: number; source: string
    last_seen: string | null
}

export interface LatLng { lat: number; lng: number }

// The drone's LIVE obstacle map (what it's sensing/planning around now).
export async function getObstacles(droneId: string): Promise<LiveObstacle[]> {
    const d = await j<{ obstacles: LiveObstacle[] }>(await fetch(api(`/${droneId}/obstacles`)))
    return d.obstacles
}

// Live obstacles PLUS the active reroute path and the mission goal, so the
// Mission map can show the planned route, the destination, and the plan
// updating in real time.
export async function getObstaclesAndPath(
    droneId: string): Promise<{ obstacles: LiveObstacle[]; reroutePath: LatLng[] | null; goal: LatLng | null }> {
    const d = await j<{ obstacles: LiveObstacle[]; reroute_path: LatLng[] | null; goal: LatLng | null }>(
        await fetch(api(`/${droneId}/obstacles`)))
    return { obstacles: d.obstacles, reroutePath: d.reroute_path ?? null, goal: d.goal ?? null }
}

// The persistent SHARED hazard map (known static obstacles across all flights).
export async function getHazards(): Promise<KnownHazard[]> {
    const d = await j<{ hazards: KnownHazard[] }>(await fetch(api('/hazards')))
    return d.hazards
}

export async function addHazard(lat: number, lng: number, radius_m = 5,
                                top_m = 0): Promise<void> {
    await fetch(api('/hazards'), {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({ lat, lng, radius_m, top_m }),
    })
}

export async function clearHazards(): Promise<number> {
    const d = await j<{ removed: number }>(await fetch(api('/hazards/clear'), {
        method: 'POST', headers: AUTH,
    }))
    return d.removed
}

// The nearest obstacle straight ahead (sectors around 0 deg), in metres, or
// null if the forward arc is clear. obstacle_distance_cm is the 72-sector
// MAVLink-shaped array (65535 = no reading).
export function nearestAheadM(cm: number[], coneDeg = 30): number | null {
    if (!cm || cm.length !== 72) return null
    const sectors = Math.round(coneDeg / 5)
    let best: number | null = null
    for (let k = -sectors; k <= sectors; k++) {
        const idx = (k + 72) % 72
        const v = cm[idx]
        if (v > 0 && v < 65535) {
            const m = v / 100
            if (best === null || m < best) best = m
        }
    }
    return best
}
