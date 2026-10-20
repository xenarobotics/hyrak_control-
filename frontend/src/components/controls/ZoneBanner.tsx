'use client'

// Pilot-facing zone status banner. The backend zone monitor emits
// `zone_status` on zone transitions (and repeats while inside); this shows
// it on every platform tab. Orange = warning, red = danger, locked = the
// red-zone pushback owns the drone and stick input is being dropped.

import { useEffect, useState } from 'react'
import { AlertTriangle, ShieldAlert, ShieldCheck } from 'lucide-react'
import { getSocket } from '@/lib/socket'
import { toastStyle, toneColor, TOAST_IN } from '@/components/notifications/toast'
import { cn } from '@/lib/utils'

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

    const tone = status.zone_class === 'red' ? 'danger' : status.zone_class === 'orange' ? 'warn' : 'ok'

    const Icon = status.locked ? ShieldAlert
        : status.zone_class === 'green' ? ShieldCheck : AlertTriangle

    return (
        <div
            className={cn(
                'fixed top-[60px] left-1/2 -translate-x-1/2 z-[3000] flex w-max max-w-[calc(100vw-32px)] items-center gap-2.5',
                'px-4 py-2.5 rounded-[10px] text-[14px] font-bold', TOAST_IN,
                // A live alarm is the one thing allowed to pulse.
                status.zone_class === 'red' && 'motion-safe:animate-pulse',
            )}
            role={status.zone_class === 'green' ? 'status' : 'alert'}
            style={toastStyle(tone, status.zone_class === 'red' ? 20 : 14)}
        >
            <Icon size={18} className="shrink-0" style={{ color: toneColor(tone) }} aria-hidden />
            {status.message}
        </div>
    )
}
