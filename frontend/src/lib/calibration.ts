// Camera calibration + vision limits, persisted SERVER-side.
//
// Unlike most of the Settings page, these do not live in localStorage. They are
// properties of the airframe and of the mission, they must apply to any session
// on any browser, and they must survive a restart - so the backend owns them
// (backend/app/vision/calibration.py) and this is just a client.
//
// Field metadata (ranges, units, help) comes FROM the server rather than being
// declared here. Declaring "hfov is 1-179" in both languages is how the two
// drift apart and the form starts accepting values the backend rejects.

import { getServerUrl } from './server-url'

export interface CalibrationField {
    key: string
    /** 'follow' is the yaw tuning shared by every tracking mode - see
     *  backend calibration.py for why it is a group of its own rather than
     *  more entries under 'limits'. */
    group: 'camera' | 'limits' | 'follow'
    type: 'float' | 'int' | 'enum'
    label: string
    unit?: string
    min?: number
    max?: number
    step?: number
    options?: string[]
    help: string
    value: number | string
    /** True when an operator has saved a value, vs. inheriting the default. */
    overridden: boolean
}

export interface CalibrationSchema {
    fields: CalibrationField[]
    /** False until something has been measured - the UI warns while it is. */
    calibrated: boolean
}

function authHeaders(): HeadersInit {
    return {
        'X-Auth-Token': process.env.NEXT_PUBLIC_SECRET_TOKEN ?? '',
        'Content-Type': 'application/json',
    }
}

export async function fetchCalibration(): Promise<CalibrationSchema | null> {
    try {
        const r = await fetch(`${getServerUrl()}/api/vision/calibration`)
        if (!r.ok) return null
        return await r.json()
    } catch {
        // Settings must still render with the backend down.
        return null
    }
}

/** The four yaw gains, in the shape the tracking panels and the backend's
 *  `set_pd_params` socket event both already use. */
export interface FollowTuning {
    kp: number
    kd: number
    max_output: number
    deadband: number
}

/**
 * The saved follow tuning, for panels that carry their own live sliders.
 *
 * They need it because their sliders emit all four values at once: a panel
 * showing hardcoded defaults while the backend session had started from the
 * operator's saved numbers would silently revert those numbers the moment any
 * one slider moved. So the panel displays what is actually flying.
 *
 * Returns null if the backend is unreachable - callers keep their own literals
 * as the fallback, which is the same thing the backend falls back to.
 */
export async function fetchFollowTuning(): Promise<FollowTuning | null> {
    const schema = await fetchCalibration()
    if (!schema) return null
    const num = (key: string): number | null => {
        const f = schema.fields.find(x => x.key === key)
        return typeof f?.value === 'number' ? f.value : null
    }
    const kp = num('follow_yaw_kp')
    const kd = num('follow_yaw_kd')
    const max_output = num('follow_yaw_max_deg_s')
    const deadband = num('follow_yaw_deadband')
    // All four or none: a partial merge would mix saved values with literals
    // and produce a combination nobody chose.
    if (kp === null || kd === null || max_output === null || deadband === null) {
        return null
    }
    return { kp, kd, max_output, deadband }
}

/** Save a partial update. Rejects the whole batch if any field is invalid, so
 *  a half-applied calibration can never be flying. */
export async function saveCalibration(
    updates: Record<string, number | string>,
): Promise<CalibrationSchema> {
    const r = await fetch(`${getServerUrl()}/api/vision/calibration`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(updates),
    })
    if (!r.ok) {
        const detail = (await r.json().catch(() => ({}))).detail
        throw new Error(detail ?? `Could not save (${r.status})`)
    }
    return r.json()
}

export async function resetCalibration(): Promise<CalibrationSchema> {
    const r = await fetch(`${getServerUrl()}/api/vision/calibration`, {
        method: 'DELETE',
        headers: authHeaders(),
    })
    if (!r.ok) throw new Error(`Could not reset (${r.status})`)
    return r.json()
}

/** Vertical FOV implied by a horizontal one at 16:9 - shown next to the HFOV
 *  input because the vertical span is what decides whether one fixed mount
 *  angle can cover both a shallow ID view and a steep ground-projection view. */
export function derivedVfov(hfovDeg: number, aspect = 16 / 9): number {
    const h = (hfovDeg * Math.PI) / 180
    return (2 * Math.atan(Math.tan(h / 2) / aspect) * 180) / Math.PI
}

/** Ground sample distance at nadir, metres per pixel - the single number that
 *  says whether a target will have enough pixels to analyse at a given height. */
export function gsdAtNadir(hfovDeg: number, altitudeM: number, widthPx = 1920): number {
    return (2 * altitudeM * Math.tan((hfovDeg * Math.PI) / 360)) / widthPx
}
