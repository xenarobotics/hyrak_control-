'use client'

// Live avoidance status for the Command window (1 Hz). Resolves the drone the
// same way the Avoidance card does: the fleet's single connected drone, else
// the one drone avoidance knows.

import { useEffect, useState } from 'react'
import { getServerUrl } from '@/lib/server-url'
import { getStatus, type AvoidanceStatus } from '@/lib/avoidance'

export function useAvoidanceLive(): AvoidanceStatus | null {
    const [status, setStatus] = useState<AvoidanceStatus | null>(null)
    useEffect(() => {
        let alive = true
        let droneId: string | null = null
        const tick = async () => {
            try {
                if (!droneId) {
                    const f = await fetch(`${getServerUrl()}/api/fleet`).then(r => r.json())
                    const fleet = (f.fleet ?? []).filter((d: { connected?: boolean }) => d.connected)
                    if (fleet.length === 1) droneId = fleet[0].db_id
                    if (!droneId) {
                        const a = await fetch(`${getServerUrl()}/api/avoidance/status`).then(r => r.json())
                        const ds = (a.drones ?? []) as { drone_id: string }[]
                        if (ds.length === 1) droneId = ds[0].drone_id
                    }
                }
                if (droneId) {
                    const st = await getStatus(droneId)
                    if (alive) setStatus(st)
                }
            } catch { /* backend away: keep the last status */ }
        }
        tick()
        const id = setInterval(() => { if (document.visibilityState === 'visible') tick() }, 1000)
        return () => { alive = false; clearInterval(id) }
    }, [])
    return status
}
