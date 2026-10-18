// Crowd-management / vehicle-plate-tracking data lives in Postgres and is
// retained by default (no auto-purge - reversed from the first version of
// this feature, which force-downloaded + deleted on every stop). These
// helpers back the "previous sessions" history panel plus the optional
// manual export/clear actions.

import { apiFetch } from '@/lib/api'
import { authHeaders, isCustomer } from '@/lib/auth'
import { useDroneStore } from '@/store/drone'
import { getServerUrl } from './server-url'

export interface CrowdSessionSummary {
    session_id: string
    started: string | null
    last_seen: string | null
    peak_count: number
}

export interface CrowdAlertRow {
    session_id: string
    t: string | null
    level: string
    section_idx: number
    count: number
    message: string
}

export interface PlateHistoryRow {
    id: string
    session_id: string
    track_id: number
    // This module's own persistent identity for the vehicle (e.g.
    // "VH-000042"), distinct from track_id - survives a ByteTrack id change.
    // Nullable: rows written before the feature existed have none.
    vehicle_id: string | null
    /** "" when no plate was ever read - the row still describes a vehicle. */
    plate_text: string
    ocr_confidence: number
    /** Pixels across the plate. The honest quality indicator for a reading. */
    plate_px_w: number
    vehicle_type: string
    vehicle_color: string
    lat: number | null
    lng: number | null
    alt_m: number | null
    speed_est_kmh: number | null
    first_seen: string | null
    last_seen: string | null
    /** The plate crop. */
    image_path: string | null
    /** The whole-vehicle shot - what makes a row checkable by a human. */
    vehicle_image_path: string | null
}

// History is per workspace (docs/ACCESS_MODEL.md 8b). A customer's panels
// show the workspace their live session is in; staff see every workspace
// they can view (the server decides which).
function workspaceParam(): string {
    if (!isCustomer()) return ''
    const ws = useDroneStore.getState().session?.workspace_id
    return ws ? `&workspace_id=${encodeURIComponent(ws)}` : ''
}

/** Clearing history is a staff action; customers do not get the button. */
export function canClearHistory(): boolean {
    return !isCustomer()
}

export async function fetchCrowdHistory(limit = 10): Promise<{ sessions: CrowdSessionSummary[]; alerts: CrowdAlertRow[] }> {
    try {
        const res = await apiFetch(`${getServerUrl()}/api/vision/crowd-history?limit=${limit}${workspaceParam()}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return await res.json()
    } catch (e) {
        console.warn('Crowd history fetch failed:', e)
        return { sessions: [], alerts: [] }
    }
}

export async function fetchPlateHistory(limit = 50): Promise<PlateHistoryRow[]> {
    try {
        const res = await apiFetch(`${getServerUrl()}/api/vision/plate-history?limit=${limit}${workspaceParam()}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        return data.events ?? []
    } catch (e) {
        console.warn('Plate history fetch failed:', e)
        return []
    }
}

/** API path of a plate crop; needs the bearer (see useApiObjectUrl). */
export function plateImagePath(eventId: string): string {
    return `/api/vision/plate-history/${encodeURIComponent(eventId)}/image`
}

// Human-readable stamp for filenames/labels - "when this happened", not a
// raw session id or epoch number, per the "names like time or location"
// ask.
export function toFileStamp(iso?: string | null): string {
    const d = iso ? new Date(iso) : new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`
}

export function shortLocation(lat: number | null, lng: number | null): string | null {
    if (lat == null || lng == null) return null
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`
}

// Read-only - does not delete anything. Downloads a zip of the GIVEN
// session's rows (CSV + images for plates). Works for any past session,
// not just the currently active one - every entry in the history list can
// be pulled individually.
export async function downloadSessionReport(sessionId: string, kind: 'crowd-report' | 'plate-report', label?: string) {
    try {
        // Fixed name (time-stamped), not the server's session-id name.
        const name = `${kind.replace('-', '_')}_${label ?? toFileStamp()}.zip`
        const res = await apiFetch(`${getServerUrl()}/api/sessions/${sessionId}/${kind}/download`)
        if (!res.ok) return
        const url = URL.createObjectURL(await res.blob())
        const a = document.createElement('a')
        a.href = url
        a.download = name
        document.body.appendChild(a)
        a.click()
        a.remove()
        // Revoking in the same tick can cancel the save in some browsers.
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (e) {
        console.warn(`${kind} download failed:`, e)
    }
}

// Explicit, operator-triggered - wipes ALL crowd/plate history (not just
// the current session). Needs a signed-in operator like every other
// mutating call.
export async function clearHistory(kind: 'crowd-history' | 'plate-history'): Promise<boolean> {
    try {
        const res = await apiFetch(`${getServerUrl()}/api/vision/${kind}`, {
            method: 'DELETE',
            headers: authHeaders(),
        })
        return res.ok
    } catch (e) {
        console.warn(`${kind} clear failed:`, e)
        return false
    }
}
