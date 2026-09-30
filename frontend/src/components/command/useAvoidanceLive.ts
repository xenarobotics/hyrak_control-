'use client'

// Live avoidance status for the Command window (1 Hz).
//
// Which drone: the session's bound drone first (what the backend loop
// itself binds to), else the fleet's single connected drone, else the one
// controller that is enabled. Re-resolved every 10 s and on a 404, so a
// swapped drone or a stale id never leaves the strip on the wrong aircraft.
// Staleness: a failing poll used to keep showing the last status as live;
// now `stale` / `stale_s` are set after 3 s without an answer.

import { useEffect, useState } from 'react'
import { getServerUrl } from '@/lib/server-url'
import { getStatus, type AvoidanceStatus } from '@/lib/avoidance'
import { useDroneStore } from '@/store/drone'

const STALE_AFTER_MS = 3000
const RERESOLVE_MS = 10000

async function resolveDrone(sessionId: string | undefined): Promise<string | null> {
    const base = getServerUrl()
    if (sessionId) {
        try {
            const s = await fetch(`${base}/api/sessions`).then(r => r.json())
            const mine = (s.sessions ?? []).find((x: { session_id: string }) => x.session_id === sessionId)
            const id = mine?.drone?.id
            if (id) return id
        } catch { /* fall through */ }
    }
    try {
        const f = await fetch(`${base}/api/fleet`).then(r => r.json())
        const fleet = (f.fleet ?? []).filter((d: { connected?: boolean }) => d.connected)
        if (fleet.length === 1) return fleet[0].db_id
    } catch { /* fall through */ }
    try {
        const a = await fetch(`${base}/api/avoidance/status`).then(r => r.json())
        const on = ((a.drones ?? []) as { drone_id: string; enabled: boolean }[]).filter(d => d.enabled)
        if (on.length === 1) return on[0].drone_id
    } catch { /* backend away */ }
    return null
}

export function useAvoidanceLive(): AvoidanceStatus | null {
    const [status, setStatus] = useState<AvoidanceStatus | null>(null)
    const sessionId = useDroneStore(s => s.session?.session_id)
    useEffect(() => {
        let alive = true
        let droneId: string | null = null
        let resolvedAt = 0
        let lastOkAt = 0
        let last: AvoidanceStatus | null = null
        const tick = async () => {
            const now = Date.now()
            try {
                if (!droneId || now - resolvedAt > RERESOLVE_MS) {
                    const id = await resolveDrone(sessionId)
                    resolvedAt = now
                    if (id !== droneId) { droneId = id; last = null }
                }
                if (droneId) {
                    const st = await getStatus(droneId)
                    if ((st as unknown as { detail?: string }).detail && !st.drone_id) {
                        droneId = null          // 404: the id is gone, re-resolve next tick
                        throw new Error('no controller')
                    }
                    last = st
                    lastOkAt = now
                    if (alive) setStatus(st)
                    return
                }
            } catch { /* backend away or wrong id: fall through to staleness */ }
            if (alive) {
                const age = lastOkAt ? (now - lastOkAt) / 1000 : 0
                if (last && lastOkAt && now - lastOkAt > STALE_AFTER_MS) {
                    setStatus({ ...last, stale: true, stale_s: Math.round(age) })
                } else if (!last) {
                    setStatus(null)
                }
            }
        }
        tick()
        const id = setInterval(() => { if (document.visibilityState === 'visible') tick() }, 1000)
        return () => { alive = false; clearInterval(id) }
    }, [sessionId])
    return status
}
