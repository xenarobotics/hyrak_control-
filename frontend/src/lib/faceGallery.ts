// Face gallery - the enrolled-identity side of face recognition.
//
// Distinct from the reference-photo flow in PersonTrackerPanel, which is
// unchanged: upload a photo, follow that person. This is a persistent
// database of known people the tracker matches against on its own, so a
// target gets named and locked without anyone selecting one first.
//
// Every mutation is token-gated server-side. This is durable biometric data
// and the only dataset in the system with no automatic expiry, so deletion is
// always explicit and always the operator's decision.

import { getServerUrl } from './server-url'

export interface GalleryPerson {
    id: string
    name: string
    notes: string
    active: boolean
    created_at: string | null
    face_count: number
}

/** One image's outcome. Reported per file because a photo silently skipped
 *  for having no detectable face is the difference between recognition
 *  working and not - the operator needs to know which one to re-shoot. */
export interface EnrolResult {
    filename: string
    ok: boolean
    reason: string
    det_score: number
}

function authHeaders(): HeadersInit {
    return { 'X-Auth-Token': process.env.NEXT_PUBLIC_SECRET_TOKEN ?? '' }
}

export async function fetchGallery(): Promise<GalleryPerson[]> {
    try {
        const r = await fetch(`${getServerUrl()}/api/vision/face-gallery`)
        if (!r.ok) return []
        return (await r.json()).persons ?? []
    } catch {
        // The gallery is an enhancement, never a prerequisite - a backend
        // that cannot answer must not break the tracking panel.
        return []
    }
}

export async function enrolPhotos(
    name: string, files: File[], notes = '',
): Promise<{ enrolled: number; total: number; results: EnrolResult[] }> {
    const form = new FormData()
    for (const f of files) form.append('files', f)
    const qs = new URLSearchParams({ name, notes })
    const r = await fetch(
        `${getServerUrl()}/api/vision/face-gallery/enrol?${qs}`,
        { method: 'POST', headers: authHeaders(), body: form },
    )
    if (!r.ok) {
        throw new Error((await r.json().catch(() => ({}))).detail ?? `Enrolment failed (${r.status})`)
    }
    return r.json()
}

/** Enrol a server-side `<root>/<person name>/<images>` tree in one call -
 *  the layout of the provided sample set, so it needs no reshuffling. */
export async function enrolFolder(path: string): Promise<{
    enrolled: number
    total: number
    persons: Record<string, { enrolled: number; total: number; failed: { filename: string; reason: string }[] }>
}> {
    const r = await fetch(
        `${getServerUrl()}/api/vision/face-gallery/enrol-folder?path=${encodeURIComponent(path)}`,
        { method: 'POST', headers: authHeaders() },
    )
    if (!r.ok) {
        throw new Error((await r.json().catch(() => ({}))).detail ?? `Enrolment failed (${r.status})`)
    }
    return r.json()
}

export async function setPersonActive(personId: string, active: boolean): Promise<void> {
    const r = await fetch(
        `${getServerUrl()}/api/vision/face-gallery/${personId}?active=${active}`,
        { method: 'PATCH', headers: authHeaders() },
    )
    if (!r.ok) throw new Error(`Could not update (${r.status})`)
}

export async function deletePerson(personId: string): Promise<void> {
    const r = await fetch(
        `${getServerUrl()}/api/vision/face-gallery/${personId}`,
        { method: 'DELETE', headers: authHeaders() },
    )
    if (!r.ok) throw new Error(`Could not delete (${r.status})`)
}

export async function clearGallery(): Promise<void> {
    const r = await fetch(`${getServerUrl()}/api/vision/face-gallery`, {
        method: 'DELETE', headers: authHeaders(),
    })
    if (!r.ok) throw new Error(`Could not clear gallery (${r.status})`)
}

export interface Sighting {
    id: string
    person_id: string | null
    person_name: string
    t: string | null
    similarity: number
    track_id: number
    lat: number | null
    lng: number | null
    alt_m: number | null
}

/** Audit trail: what the system claimed, and when. */
export async function fetchSightings(sessionId?: string, limit = 100): Promise<Sighting[]> {
    try {
        const qs = new URLSearchParams({ limit: String(limit) })
        if (sessionId) qs.set('session_id', sessionId)
        const r = await fetch(`${getServerUrl()}/api/vision/sightings?${qs}`)
        if (!r.ok) return []
        return (await r.json()).sightings ?? []
    } catch {
        return []
    }
}

/** Where the provided sample set lives, as the default for folder enrolment
 *  so the demo path is one click rather than a remembered filesystem path. */
export const SAMPLE_FACES_PATH = '/home/japesh/hyrak_control/sample human faces/photos'
