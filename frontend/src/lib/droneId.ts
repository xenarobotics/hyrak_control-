'use client'

// WHICH DRONE IS THIS SESSION FLYING - resolved once, for everyone.
//
// Two panels used to run their own 1-1.5 s polls of /api/sessions, /api/fleet
// and /api/avoidance/status for as long as no id resolved, which on a
// session with no drone attached is forever: 2-5 requests a second through
// the tunnel for nothing. This module keeps ONE resolver with exponential
// back-off, shared by every subscriber, and it only runs while telemetry is
// up - with no link there is no drone to find.
//
// Order: the session's own bound drone (the backend emits drone_identity the
// moment it has read the FC's UID; useDrone stores it on the session), then
// the fleet's single connected drone (sim, station drone). /api/sessions is
// not consulted: it is becoming admin-only.

import { apiFetch } from '@/lib/api'
import { useEffect, useState } from 'react'
import { getServerUrl } from '@/lib/server-url'
import { useDroneStore } from '@/store/drone'
import { isCustomer } from '@/lib/auth'

const BACKOFF_MIN_MS = 1500
const BACKOFF_MAX_MS = 15000
/** Once resolved, re-check occasionally so a swapped drone is noticed. */
const RECHECK_MS = 10000

type Listener = (id: string | null) => void

let current: string | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let backoff = BACKOFF_MIN_MS
let running = false
const listeners = new Set<Listener>()
let storeSub: (() => void) | null = null

function publish(id: string | null) {
    if (id === current) return
    current = id
    for (const l of listeners) l(id)
}

async function lookup(): Promise<string | null> {
    const bound = useDroneStore.getState().session?.drone?.id
    if (bound) return bound
    // The fleet is staff-only: a customer's only drone is the bound one.
    if (isCustomer()) return null
    try {
        const f = await apiFetch(`${getServerUrl()}/api/fleet`, { signal: AbortSignal.timeout(5000) })
        if (f.ok) {
            const j = await f.json() as { fleet?: { db_id?: string; connected?: boolean }[] }
            const fleet = (j.fleet ?? []).filter(d => d.connected && d.db_id)
            if (fleet.length === 1) return fleet[0].db_id ?? null
        }
    } catch { /* backend away */ }
    return null
}

function schedule(ms: number) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; void tick() }, ms)
}

async function tick() {
    if (!running) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        schedule(BACKOFF_MAX_MS)
        return
    }
    const id = await lookup()
    if (!running) return
    publish(id)
    if (id) {
        backoff = BACKOFF_MIN_MS
        schedule(RECHECK_MS)
    } else {
        schedule(backoff)
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    }
}

function start() {
    if (running) return
    running = true
    backoff = BACKOFF_MIN_MS
    void tick()
}

function stop() {
    running = false
    if (timer) { clearTimeout(timer); timer = null }
    publish(null)
}

/** The gate: telemetry up -> resolve; telemetry down -> nothing to resolve.
 *  A bound drone arriving on the session short-circuits the back-off. */
function ensureStoreSubscription() {
    if (storeSub) return
    const apply = () => {
        const st = useDroneStore.getState()
        if (listeners.size === 0) { stop(); return }
        if (st.telemetryStatus !== 'connected') { stop(); return }
        const bound = st.session?.drone?.id
        if (bound && bound !== current) { backoff = BACKOFF_MIN_MS; start(); schedule(0); return }
        start()
    }
    storeSub = useDroneStore.subscribe((s, prev) => {
        if (s.telemetryStatus !== prev.telemetryStatus || s.session?.drone?.id !== prev.session?.drone?.id) apply()
    })
    apply()
}

/** Ask for a fresh lookup now (after a 404 on the id, say). */
export function invalidateDroneId() {
    if (!running) return
    backoff = BACKOFF_MIN_MS
    current = null
    schedule(0)
}

export function subscribeDroneId(fn: Listener): () => void {
    listeners.add(fn)
    ensureStoreSubscription()
    fn(current)
    return () => {
        listeners.delete(fn)
        if (listeners.size === 0) stop()
    }
}

export function useResolvedDroneId(): string | null {
    const [id, setId] = useState<string | null>(() => current)
    useEffect(() => subscribeDroneId(setId), [])
    return id
}
