'use client'

// Pilot-facing zone status banner. The backend zone monitor emits
// `zone_status` on zone transitions (and repeats while inside); this shows
// it on every platform tab. Orange = warning, red = danger, locked = the
// red-zone pushback owns the drone and stick input is being dropped.

import { useEffect, useState } from 'react'
import { AlertTriangle, ShieldAlert, ShieldCheck } from 'lucide-react'
import { getSocket } from '@/lib/socket'

type ZoneStatus = {
    zone_class: 'green' | 'orange' | 'red'
    zones: { id: string; name: string; zone_class: string }[]
    locked: boolean
    message: string
}

export function ZoneBanner() {
    const [status, setStatus] = useState<ZoneStatus | null>(null)

    useEffect(() => {
        const socket = getSocket()
        let clearTimer: ReturnType<typeof setTimeout> | null = null
        const onStatus = (s: ZoneStatus) => {
            setStatus(s)
            if (clearTimer) clearTimeout(clearTimer)
            if (s.zone_class === 'green' && !s.locked) {
                clearTimer = setTimeout(() => setStatus(null), 4000)
            }
        }
        socket.on('zone_status', onStatus)
        const onDisconnect = () => setStatus(null)
        socket.on('telemetry_status', onDisconnect)
        return () => {
            socket.off('zone_status', onStatus)
            socket.off('telemetry_status', onDisconnect)
            if (clearTimer) clearTimeout(clearTimer)
        }
    }, [])

    if (!status) return null

    const styles = {
        green: {
            background: 'rgba(21, 128, 61, .95)',
            border: '1px solid rgba(34, 197, 94, .5)',
            color: '#dcfce7',
        },
        orange: {
            background: 'rgba(120, 53, 15, .95)',
            border: '1px solid rgba(251, 191, 36, .5)',
            color: '#fde68a',
        },
        red: {
            background: 'rgba(153, 27, 27, .97)',
            border: '1px solid rgba(248, 113, 113, .6)',
            color: '#fecaca',
        },
    }[status.zone_class]

    const Icon = status.locked ? ShieldAlert
        : status.zone_class === 'green' ? ShieldCheck : AlertTriangle

    return (
        <div
            className={
                'fixed top-3 left-1/2 -translate-x-1/2 z-[3000] flex items-center gap-2.5 ' +
                'px-4 py-2.5 rounded-xl font-mono text-[11px] font-bold shadow-2xl ' +
                (status.zone_class === 'red' ? 'animate-pulse' : '')
            }
            style={{ ...styles, backdropFilter: 'blur(8px)' }}
        >
            <Icon size={15} />
            {status.message}
        </div>
    )
}
