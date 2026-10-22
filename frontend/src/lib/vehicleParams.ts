'use client'

// The aircraft's parameters, loaded once per link and shared by every Config
// page - the way QGroundControl works: it downloads the whole set on connect
// and every setup page reads from that one copy.
//
// Reads go through the existing `fetch_params` socket event (one download of
// everything, 5 s on SITL, up to 30 s over a serial radio). Writes go through
// `set_param`, the same guarded event the Advanced page uses, and the copy
// here is updated from the aircraft's acknowledgement, never optimistically:
// a value shown on a setup page is a value the aircraft confirmed.

import { create } from 'zustand'
import { useEffect } from 'react'
import { getSocket } from '@/lib/socket'
import { useDroneStore } from '@/store/drone'

export type ParamType = 'int' | 'float'
export interface VParam { value: number; type: ParamType }

interface ParamState {
    params: Record<string, VParam> | null
    loading: boolean
    error: string | null
    /** key -> true while a write is waiting for its acknowledgement */
    pending: Record<string, boolean>
    /** key -> the reason the last write failed */
    failed: Record<string, string>
    /** key -> time of the last confirmed write, for a brief "saved" mark */
    saved: Record<string, number>
    loadedAt: number
    /** The values as downloaded, for "changed since loading". */
    loaded: Record<string, number> | null
}

export const useParamStore = create<ParamState>(() => ({
    params: null, loading: false, error: null, pending: {}, failed: {}, saved: {}, loadedAt: 0, loaded: null,
}))

let wired = false
let loadTimer: ReturnType<typeof setTimeout> | null = null

function wire() {
    if (wired || typeof window === 'undefined') return
    wired = true
    const socket = getSocket()
    socket.on('params_result', (d: { ok: boolean | null; loading?: boolean; params?: Record<string, { value: number; type: string }>; error?: string }) => {
        if (d.loading) { useParamStore.setState({ loading: true, error: null }); return }
        if (loadTimer) { clearTimeout(loadTimer); loadTimer = null }
        if (d.ok === true && d.params) {
            const params: Record<string, VParam> = {}
            for (const [k, p] of Object.entries(d.params)) params[k] = { value: p.value, type: p.type === 'int' ? 'int' : 'float' }
            const loaded: Record<string, number> = {}
            for (const [k, p] of Object.entries(params)) loaded[k] = p.value
            useParamStore.setState({ params, loaded, loading: false, error: null, loadedAt: Date.now() })
        } else if (d.ok === false) {
            useParamStore.setState({ loading: false, error: d.error ?? 'The parameter download failed' })
        }
    })
    socket.on('param_set_ack', (d: { key: string; ok: boolean; value: number; error?: string | null }) => {
        useParamStore.setState(s => {
            const pending = { ...s.pending }; delete pending[d.key]
            const failed = { ...s.failed }
            const saved = { ...s.saved }
            let params = s.params
            if (d.ok) {
                delete failed[d.key]
                saved[d.key] = Date.now()
                if (params) params = { ...params, [d.key]: { value: Number(d.value), type: params[d.key]?.type ?? 'float' } }
            } else {
                failed[d.key] = d.error || `The aircraft did not accept ${d.key}`
            }
            return { pending, failed, saved, params }
        })
    })
    socket.on('param_get_ack', (d: { key: string; ok: boolean; value: number | null }) => {
        if (!d.ok || d.value == null) return
        useParamStore.setState(s => s.params && s.params[d.key]
            ? { params: { ...s.params, [d.key]: { ...s.params[d.key], value: Number(d.value) } } }
            : {})
    })
    socket.on('disconnect', () => {
        if (useParamStore.getState().loading) useParamStore.setState({ loading: false, error: 'Connection to HYRAK dropped during the download' })
    })
    // Forget the aircraft's values the moment its link drops, so a reconnect
    // to a different aircraft never shows the previous one's setup.
    let prev = useDroneStore.getState().telemetryStatus
    useDroneStore.subscribe(s => {
        if (s.telemetryStatus === prev) return
        prev = s.telemetryStatus
        if (s.telemetryStatus !== 'connected') {
            useParamStore.setState({ params: null, loading: false, error: null, pending: {}, failed: {}, saved: {}, loadedAt: 0, loaded: null })
        }
    })
}

/** Download every parameter again. */
export function reloadParams() {
    wire()
    useParamStore.setState({ loading: true, error: null })
    if (loadTimer) clearTimeout(loadTimer)
    // Backstop for a download that goes quiet (backend restart, dead link).
    loadTimer = setTimeout(() => {
        if (useParamStore.getState().loading) useParamStore.setState({ loading: false, error: 'The parameter download timed out after 2 minutes' })
    }, 125_000)
    getSocket().emit('fetch_params')
}

/** Write one parameter. The type comes from the aircraft's own copy. */
export function writeParam(key: string, value: number) {
    wire()
    const s = useParamStore.getState()
    const type: ParamType = s.params?.[key]?.type ?? (Number.isInteger(value) ? 'int' : 'float')
    const v = type === 'int' ? Math.round(value) : value
    useParamStore.setState(st => {
        const failed = { ...st.failed }; delete failed[key]
        return { pending: { ...st.pending, [key]: true }, failed }
    })
    getSocket().emit('set_param', { key, value: v, param_type: type })
}

/** Several writes, paced so a serial radio is not flooded. */
export async function writeParams(entries: [string, number][], gapMs = 120) {
    for (const [k, v] of entries) {
        writeParam(k, v)
        await new Promise(r => setTimeout(r, gapMs))
    }
}

/** The shared parameter copy for a Config page. Starts the download the
 *  first time a page needs it on this link. */
export function useVehicleParams() {
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const params = useParamStore(s => s.params)
    const loading = useParamStore(s => s.loading)
    const error = useParamStore(s => s.error)
    const pending = useParamStore(s => s.pending)
    const failed = useParamStore(s => s.failed)
    const saved = useParamStore(s => s.saved)

    useEffect(() => { wire() }, [])
    useEffect(() => {
        if (!connected) return
        const s = useParamStore.getState()
        if (!s.params && !s.loading && !s.error) reloadParams()
    }, [connected])

    const has = (k: string) => !!params && k in params
    const get = (k: string): number | null => params?.[k]?.value ?? null
    return { connected, params, loading, error, pending, failed, saved, has, get, ready: connected && !!params }
}

/** Keys matching a pattern with one numbered group, sorted by that number. */
export function numberedKeys(params: Record<string, VParam> | null, re: RegExp): number[] {
    if (!params) return []
    const out: number[] = []
    for (const k of Object.keys(params)) {
        const m = re.exec(k)
        if (m) out.push(Number(m[1]))
    }
    return out.sort((a, b) => a - b)
}
