'use client'

// Live avoidance status for the Command window (1 Hz).
//
// Which drone: lib/droneId.ts - the session's bound drone first (what the
// backend loop itself binds to), else the fleet's single connected drone -
// shared with the avoidance panel and backed off while nothing resolves. A
// 404 on the id invalidates it so a swapped drone or a stale id never leaves
// the strip on the wrong aircraft.
// Staleness: a failing poll used to keep showing the last status as live;
// now `stale` / `stale_s` are set after 3 s without an answer.

import { useEffect, useState } from 'react'
import { getStatus, type AvoidanceStatus } from '@/lib/avoidance'
import { invalidateDroneId, useResolvedDroneId } from '@/lib/droneId'

const STALE_AFTER_MS = 3000

export function useAvoidanceLive(): AvoidanceStatus | null {
    const [status, setStatus] = useState<AvoidanceStatus | null>(null)
    const droneId = useResolvedDroneId()
    useEffect(() => {
        if (!droneId) {
            // Nothing to poll: an empty strip, not a frozen one.
            const t = setTimeout(() => setStatus(null), 0)
            return () => clearTimeout(t)
        }
        let alive = true
        let lastOkAt = 0
        let last: AvoidanceStatus | null = null
        const tick = async () => {
            const now = Date.now()
            try {
                const st = await getStatus(droneId)
                if ((st as unknown as { detail?: string }).detail && !st.drone_id) {
                    invalidateDroneId()     // 404: the id is gone, re-resolve
                    throw new Error('no controller')
                }
                last = st
                lastOkAt = now
                if (alive) setStatus(st)
                return
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
        void tick()
        const id = setInterval(() => { if (document.visibilityState === 'visible') void tick() }, 1000)
        return () => { alive = false; clearInterval(id) }
    }, [droneId])
    return status
}
