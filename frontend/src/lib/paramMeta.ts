'use client'

// PX4 parameter metadata for Config > Parameters: firmware default, units,
// range, enum values and bitmask bits for every parameter.
//
// Two sources, best first:
//   drone    the aircraft's own parameters.json (COMP_METADATA over MAVLink
//            FTP, fetched by the backend: socket `param_metadata`). Matches
//            the firmware that is flying, so "reset to default" is offered.
//   bundled  public/px4/param-meta.json, built from one PX4 build. Used
//            with no drone, or when the drone cannot send its own; defaults
//            are labelled with that version, since firmware may differ.
// Shape: backend app/telemetry/param_meta.py compact().

import { create } from 'zustand'
import { useEffect } from 'react'
import { getSocket } from '@/lib/socket'
import { useDroneStore } from '@/store/drone'

export interface PMeta {
    g: string; s: string; l?: string; t: 'i' | 'f'; d?: number; u?: string
    min?: number; max?: number; inc?: number; dec?: number
    v?: [number, string][]; b?: [number, string][]; r?: 1
}
export interface MetaFile { version: string; params: Record<string, PMeta> }
export type MetaSource = 'drone' | 'bundled'

interface MetaState {
    bundled: MetaFile | null
    drone: MetaFile | null
    droneLoading: boolean
    droneError: string | null
}

export const useMetaStore = create<MetaState>(() => ({ bundled: null, drone: null, droneLoading: false, droneError: null }))

let wired = false
let bundledLoading = false

function wire() {
    if (wired || typeof window === 'undefined') return
    wired = true
    getSocket().on('param_metadata_result', (d: { ok: boolean; meta?: MetaFile; error?: string }) => {
        if (d.ok && d.meta?.params) useMetaStore.setState({ drone: d.meta, droneLoading: false, droneError: null })
        else useMetaStore.setState({ droneLoading: false, droneError: d.error ?? 'The drone did not send its parameter metadata' })
    })
    // A new link may be another aircraft or another firmware.
    let prev = useDroneStore.getState().telemetryStatus
    useDroneStore.subscribe(s => {
        if (s.telemetryStatus === prev) return
        prev = s.telemetryStatus
        if (s.telemetryStatus !== 'connected') useMetaStore.setState({ drone: null, droneLoading: false, droneError: null })
    })
}

async function loadBundled() {
    if (bundledLoading || useMetaStore.getState().bundled) return
    bundledLoading = true
    try {
        const r = await fetch('/px4/param-meta.json')
        if (r.ok) useMetaStore.setState({ bundled: await r.json() as MetaFile })
    } catch { /* no reference metadata; the page still lists the drone's values */ }
    bundledLoading = false
}

export function requestDroneMeta() {
    wire()
    useMetaStore.setState({ droneLoading: true, droneError: null })
    getSocket().emit('param_metadata')
}

/** Metadata for the Parameters page: the drone's own when it has sent it,
 *  else the bundled copy. Asks the drone once per link. */
export function useParamMeta() {
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const { bundled, drone, droneLoading, droneError } = useMetaStore()
    useEffect(() => { wire(); void loadBundled() }, [])
    useEffect(() => {
        if (!connected) return
        const s = useMetaStore.getState()
        if (!s.drone && !s.droneLoading && !s.droneError) requestDroneMeta()
    }, [connected])
    const file = drone ?? bundled
    const source: MetaSource | null = drone ? 'drone' : bundled ? 'bundled' : null
    return { meta: file?.params ?? null, version: file?.version ?? '', source, droneLoading, droneError, connected }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Same value for a float32 parameter: the aircraft stores 32-bit floats,
 *  the metadata writes them as decimals. */
export function sameValue(a: number, b: number, isFloat: boolean): boolean {
    if (!isFloat) return Math.round(a) === Math.round(b)
    return Math.abs(a - b) <= 1e-6 + 1e-5 * Math.max(Math.abs(a), Math.abs(b))
}

export function fmtValue(v: number, m?: PMeta | null, isFloat?: boolean): string {
    const float = isFloat ?? m?.t === 'f'
    if (!float) return String(Math.round(v))
    if (m?.dec != null) return v.toFixed(m.dec)
    return String(Number(v.toPrecision(7)))
}

/** The label of an enum value, or of each set bit. */
export function describeValue(v: number, m?: PMeta | null): string | null {
    if (!m) return null
    if (m.v) return m.v.find(([x]) => x === Math.round(v))?.[1] ?? null
    if (m.b) {
        const on = m.b.filter(([bit]) => (Math.round(v) >>> 0) & (1 << bit)).map(([, l]) => l)
        return on.length ? on.join(', ') : 'None'
    }
    return null
}

/** Why `v` is not a valid value for this parameter, or null. */
export function validate(v: number, m?: PMeta | null, isFloat?: boolean): string | null {
    if (!Number.isFinite(v)) return 'Enter a number'
    const float = isFloat ?? m?.t === 'f'
    if (!float && !Number.isInteger(v)) return 'Whole numbers only'
    if (m?.min != null && v < m.min) return `At least ${m.min}${m.u ? ` ${m.u}` : ''}`
    if (m?.max != null && v > m.max) return `At most ${m.max}${m.u ? ` ${m.u}` : ''}`
    return null
}
