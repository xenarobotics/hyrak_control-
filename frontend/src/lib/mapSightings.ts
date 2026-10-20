'use client'

// Detections on the map (backend app/mapdetect).
//
// Every detection an AI model reports gets a ground position estimated from
// the drone's GPS, height and camera angle at the moment the frame was
// captured. Repeats of one object fold into one "sighting". The live
// session's sightings arrive as `map_sightings` socket deltas; this module
// keeps them in a small store that every map reads.
//
//   show       "Show detections on map": null = the default (on while a
//              model runs or anything has been placed), else the choice
//   recording  "Record to map": the server keeps the sightings with the
//              flight (Settings > Flights). Off by default.
//   camera     the per-device camera angle and lens (Settings > Video),
//              sent to the server at every session start and on change

import { create } from 'zustand'
import { apiFetch, apiJson } from '@/lib/api'
import { getSocket } from '@/lib/socket'
import { useDroneStore } from '@/store/drone'

export interface Sighting {
    id: string
    label: string
    source: string
    model_name: string
    task: 'detect' | 'classify'
    lat: number
    lon: number
    accuracy_m: number
    count: number
    first_seen: number | null
    last_seen: number | null
    best_score: number | null
    thumb?: string | null
    agl_m?: number | null
    angle_source?: string
    /** Placed by a model rule's "Pin it on the map": kept with the flight
     *  even when Record to map is off. */
    pinned?: boolean
    /** The rule's class name, for pinned sightings. */
    rule?: string | null
}

export interface MapCameraState {
    hfov_deg: number
    pitch_deg: number
    stabilised: boolean
    source: 'setting' | 'default' | string
    gimbal: boolean
}

export type PlaceReason = 'no_gps' | 'no_altitude' | 'above_horizon' | 'too_shallow' | 'no_frame'

interface Delta {
    session_id: string
    upserts: Sighting[]
    cleared: boolean
    recording: boolean
    camera: MapCameraState
    counts: Record<string, number>
    total: number
    capped: boolean
    can_record?: boolean
    status: { reason: PlaceReason | null; nominal_accuracy_m: number | null }
}

interface MapSightingsState {
    sessionId: string | null
    sightings: Record<string, Sighting>
    recording: boolean
    camera: MapCameraState | null
    capped: boolean
    canRecord: boolean
    reason: PlaceReason | null
    nominalAccuracy: number | null
    show: boolean | null
    setShow: (v: boolean) => void
    apply: (d: Delta) => void
    reset: (sessionId: string | null) => void
}

export const useMapSightingsStore = create<MapSightingsState>((set) => ({
    sessionId: null,
    sightings: {},
    recording: false,
    camera: null,
    capped: false,
    canRecord: true,
    reason: null,
    nominalAccuracy: null,
    show: null,
    setShow: (v) => set({ show: v }),
    apply: (d) => set(s => {
        if (s.sessionId && d.session_id && d.session_id !== s.sessionId) return s
        const base = d.cleared ? {} : { ...s.sightings }
        for (const u of d.upserts ?? []) {
            const prev = base[u.id]
            // Thumbs only travel when they change; keep the one we have.
            base[u.id] = { ...u, thumb: u.thumb !== undefined ? u.thumb : prev?.thumb ?? null }
        }
        return {
            sessionId: d.session_id ?? s.sessionId,
            sightings: base,
            recording: !!d.recording,
            camera: d.camera ?? s.camera,
            capped: !!d.capped,
            canRecord: d.can_record ?? true,
            reason: d.status?.reason ?? null,
            nominalAccuracy: d.status?.nominal_accuracy_m ?? null,
        }
    }),
    reset: (sessionId) => set({
        sessionId, sightings: {}, recording: false, capped: false, reason: null,
        nominalAccuracy: null,
    }),
}))

// ── camera setting (this device) ─────────────────────────────────────────

export interface CameraPref {
    /** Camera pitch: -90 straight down, 0 level. */
    pitch_deg: number
    hfov_deg: number
    stabilised: boolean
    /** The operator has saved a setting (otherwise the defaults are a guess). */
    set: boolean
}

const CAMERA_KEY = 'hyrak-map-camera'
const FIRST_USE_KEY = 'hyrak-map-detections-explained'
export const CAMERA_PREF_EVENT = 'hyrak-map-camera-change'
export const DEFAULT_CAMERA: CameraPref = { pitch_deg: -90, hfov_deg: 80, stabilised: false, set: false }

let cachedRaw: string | null = null
let cachedPref: CameraPref = DEFAULT_CAMERA

/** Stable reference while the stored value is unchanged (useSyncExternalStore). */
export function readCameraPref(): CameraPref {
    try {
        const raw = localStorage.getItem(CAMERA_KEY)
        if (!raw) return DEFAULT_CAMERA
        if (raw === cachedRaw) return cachedPref
        const v = JSON.parse(raw) as Partial<CameraPref>
        cachedRaw = raw
        cachedPref = {
            pitch_deg: clamp(Number(v.pitch_deg ?? -90), -90, 0),
            hfov_deg: clamp(Number(v.hfov_deg ?? 80), 10, 170),
            stabilised: !!v.stabilised,
            set: !!v.set,
        }
        return cachedPref
    } catch { return DEFAULT_CAMERA }
}

export function saveCameraPref(p: Omit<CameraPref, 'set'>): void {
    const v: CameraPref = { ...p, set: true }
    try { localStorage.setItem(CAMERA_KEY, JSON.stringify(v)) } catch { /* private window: this session only */ }
    window.dispatchEvent(new Event(CAMERA_PREF_EVENT))
    sendCamera(v)
}

function clamp(v: number, lo: number, hi: number): number {
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo
}

function sendCamera(p: CameraPref = readCameraPref()): void {
    const s = getSocket()
    if (s.connected) s.emit('set_map_camera', p)
}

export function firstUseSeen(): boolean {
    try { return localStorage.getItem(FIRST_USE_KEY) === '1' } catch { return true }
}
export function markFirstUseSeen(): void {
    try { localStorage.setItem(FIRST_USE_KEY, '1') } catch { /* fine */ }
}

// ── socket feed ──────────────────────────────────────────────────────────

let attached = false

/** Wire the store to the socket once per page. Safe to call from every
 *  component that reads the store. */
export function ensureMapSightingsFeed(): void {
    if (attached || typeof window === 'undefined') return
    attached = true
    const socket = getSocket()
    socket.on('map_sightings', (d: Delta) => useMapSightingsStore.getState().apply(d))
    const onReady = (d: { session_id?: string }) => {
        const st = useMapSightingsStore.getState()
        if (!d?.session_id) return
        if (st.sessionId !== d.session_id) st.reset(d.session_id)
        sendCamera()
        // A reload or a resumed session: catch up with what is already placed.
        void loadLive(d.session_id)
    }
    socket.on('session_ready', onReady)
    // The session may have started before the first map mounted.
    const current = useDroneStore.getState().session?.session_id
    if (current) onReady({ session_id: current })
}

async function loadLive(sessionId: string): Promise<void> {
    try {
        const { ok, data } = await apiJson<{ sightings: Sighting[]; live: boolean } & Partial<Delta>>(
            `/api/map-sightings?session_id=${encodeURIComponent(sessionId)}`)
        if (!ok || !data.live) return
        useMapSightingsStore.getState().apply({
            session_id: sessionId, upserts: data.sightings ?? [], cleared: true,
            recording: !!data.recording, camera: data.camera as MapCameraState,
            counts: data.counts ?? {}, total: data.total ?? 0, capped: !!data.capped,
            can_record: data.can_record, status: data.status ?? { reason: null, nominal_accuracy_m: null },
        })
    } catch { /* the next delta brings the map up to date */ }
}

export function setRecording(on: boolean): void {
    getSocket().emit('set_map_recording', { on })
}

/** Empty the live map. Recorded detections stay with their flight. */
export async function clearLive(sessionId: string): Promise<boolean> {
    try {
        const r = await apiFetch(`/api/map-sightings?session_id=${encodeURIComponent(sessionId)}`,
            { method: 'DELETE' })
        if (r.ok) useMapSightingsStore.getState().apply({
            ...emptyDelta(sessionId), recording: useMapSightingsStore.getState().recording,
        })
        return r.ok
    } catch { return false }
}

function emptyDelta(sessionId: string): Delta {
    const s = useMapSightingsStore.getState()
    return {
        session_id: sessionId, upserts: [], cleared: true, recording: s.recording,
        camera: s.camera ?? { ...DEFAULT_CAMERA, source: 'default', gimbal: false },
        counts: {}, total: 0, capped: false, can_record: s.canRecord,
        status: { reason: s.reason, nominal_accuracy_m: s.nominalAccuracy },
    }
}

// ── recorded (a flight) ──────────────────────────────────────────────────

export async function loadFlightSightings(flightId: string): Promise<{ sightings: Sighting[]; canClear: boolean } | null> {
    try {
        const { ok, data } = await apiJson<{ sightings: Sighting[]; can_clear: boolean }>(
            `/api/map-sightings?flight_id=${encodeURIComponent(flightId)}`)
        return ok ? { sightings: data.sightings ?? [], canClear: !!data.can_clear } : null
    } catch { return null }
}

export async function deleteFlightSightings(flightId: string): Promise<boolean> {
    try {
        const r = await apiFetch(`/api/map-sightings?flight_id=${encodeURIComponent(flightId)}`, { method: 'DELETE' })
        return r.ok
    } catch { return false }
}

export function exportPath(kind: 'geojson' | 'csv', q: { flightId?: string; sessionId?: string }): string {
    const id = q.flightId ? `flight_id=${encodeURIComponent(q.flightId)}` : `session_id=${encodeURIComponent(q.sessionId ?? '')}`
    return `/api/map-sightings/export?format=${kind}&${id}`
}

// ── presentation helpers ─────────────────────────────────────────────────

// Distinct, readable on both satellite and street tiles. A class keeps its
// colour for the page's life (first come, first served), then the palette
// repeats.
const PALETTE = ['#f97316', '#22d3ee', '#a3e635', '#f472b6', '#facc15', '#818cf8', '#34d399', '#fb7185', '#c084fc', '#2dd4bf']
const FIXED: Record<string, string> = { person: '#f97316', car: '#22d3ee', truck: '#818cf8', bus: '#facc15' }
const assigned: Record<string, string> = {}

export function classColor(label: string): string {
    if (FIXED[label]) return FIXED[label]
    if (!assigned[label]) {
        const used = new Set(Object.values(assigned))
        assigned[label] = PALETTE.find(c => !used.has(c) && !Object.values(FIXED).includes(c))
            ?? PALETTE[Object.keys(assigned).length % PALETTE.length]
    }
    return assigned[label]
}

export function countsByLabel(list: Sighting[]): [string, number][] {
    const m: Record<string, number> = {}
    for (const s of list) m[s.label] = (m[s.label] ?? 0) + 1
    return Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

export const REASON_TEXT: Record<PlaceReason, string> = {
    no_gps: 'Detections can\'t be placed yet: waiting for a GPS fix.',
    no_altitude: 'Detections can\'t be placed yet: the drone\'s height is unknown or on the ground.',
    above_horizon: 'Detections are above the horizon, so they can\'t be placed on the ground.',
    too_shallow: 'The camera looks too flat to place detections reliably. Tilt it further down.',
    no_frame: 'Detections can\'t be placed: the video size is unknown.',
}

export function fmtTime(t: number | null | undefined): string {
    if (!t) return '-'
    return new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
