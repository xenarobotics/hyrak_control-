// Camera calibration + vision limits, persisted SERVER-side.
//
// Unlike most of the Settings page, these do not live in localStorage. They are
// properties of the airframe and of the mission, they must apply to any session
// on any browser, and they must survive a restart — so the backend owns them
// (backend/app/vision/calibration.py) and this is just a client.
//
// Field metadata (ranges, units, help) comes FROM the server rather than being
// declared here. Declaring "hfov is 1-179" in both languages is how the two
// drift apart and the form starts accepting values the backend rejects.

import { getServerUrl } from './server-url'

export interface CalibrationField {
    key: string
    group: 'camera' | 'limits'
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
    /** False until something has been measured — the UI warns while it is. */
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

/** Vertical FOV implied by a horizontal one at 16:9 — shown next to the HFOV
 *  input because the vertical span is what decides whether one fixed mount
 *  angle can cover both a shallow ID view and a steep ground-projection view. */
export function derivedVfov(hfovDeg: number, aspect = 16 / 9): number {
    const h = (hfovDeg * Math.PI) / 180
    return (2 * Math.atan(Math.tan(h / 2) / aspect) * 180) / Math.PI
}

/** Ground sample distance at nadir, metres per pixel — the single number that
 *  says whether a target will have enough pixels to analyse at a given height. */
export function gsdAtNadir(hfovDeg: number, altitudeM: number, widthPx = 1920): number {
    return (2 * altitudeM * Math.tan((hfovDeg * Math.PI) / 360)) / widthPx
}
