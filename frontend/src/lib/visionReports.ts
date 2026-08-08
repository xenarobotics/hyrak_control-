// Crowd-management / vehicle-plate-tracking data lives in Postgres and is
// retained by default (no auto-purge — reversed from the first version of
// this feature, which force-downloaded + deleted on every stop). These
// helpers back the "previous sessions" history panel plus the optional
// manual export/clear actions.

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
    // "VH-000042"), distinct from track_id — survives a ByteTrack id change.
    // Nullable: rows written before the feature existed have none.
    vehicle_id: string | null
    /** "" when no plate was ever read — the row still describes a vehicle. */
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
    /** The whole-vehicle shot — what makes a row checkable by a human. */
    vehicle_image_path: string | null
}

export async function fetchCrowdHistory(limit = 10): Promise<{ sessions: CrowdSessionSummary[]; alerts: CrowdAlertRow[] }> {
    try {
        const res = await fetch(`${getServerUrl()}/api/vision/crowd-history?limit=${limit}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return await res.json()
    } catch (e) {
        console.warn('Crowd history fetch failed:', e)
        return { sessions: [], alerts: [] }
    }
}

export async function fetchPlateHistory(limit = 50): Promise<PlateHistoryRow[]> {
    try {
        const res = await fetch(`${getServerUrl()}/api/vision/plate-history?limit=${limit}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        return data.events ?? []
    } catch (e) {
        console.warn('Plate history fetch failed:', e)
        return []
    }
}

export function plateImageUrl(eventId: string): string {
    return `${getServerUrl()}/api/vision/plate-history/${eventId}/image`
}

// Human-readable stamp for filenames/labels — "when this happened", not a
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

// Read-only — does not delete anything. Downloads a zip of the GIVEN
// session's rows (CSV + images for plates). Works for any past session,
// not just the currently active one — every entry in the history list can
// be pulled individually.
export async function downloadSessionReport(sessionId: string, kind: 'crowd-report' | 'plate-report', label?: string) {
    try {
        const res = await fetch(`${getServerUrl()}/api/sessions/${sessionId}/${kind}/download`)
        if (!res.ok) return
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${kind.replace('-', '_')}_${label ?? toFileStamp()}.zip`
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
    } catch (e) {
        console.warn(`${kind} download failed:`, e)
    }
}

// Explicit, operator-triggered — wipes ALL crowd/plate history (not just
// the current session). Requires the same token other mutating admin
// actions use (see PersonTrackerPanel.tsx's clear_reference call).
export async function clearHistory(kind: 'crowd-history' | 'plate-history'): Promise<boolean> {
    try {
        const token = process.env.NEXT_PUBLIC_SECRET_TOKEN ?? ''
        const res = await fetch(`${getServerUrl()}/api/vision/${kind}`, {
            method: 'DELETE',
            headers: { 'X-Auth-Token': token },
        })
        return res.ok
    } catch (e) {
        console.warn(`${kind} clear failed:`, e)
        return false
    }
}
