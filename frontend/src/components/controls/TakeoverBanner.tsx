'use client'

// HYRAK operations hold this session's drone (docs/ACCESS_MODEL.md 8b
// "Takeover"). While they do, every command from this session is refused by
// the server, hold, return and land included, so the banner says who has
// control and offers nothing to fight it with. It comes down when they
// release (or their console drops for longer than the grace period).
//
// Below it, briefly: a quick hold / return / land HYRAK operations sent to
// this drone without taking control.

import { useEffect } from 'react'
import { ShieldAlert, Info } from 'lucide-react'
import { useDroneStore } from '@/store/drone'
import { toastStyle, toneColor, TOAST_IN } from '@/components/notifications/toast'
import { cn } from '@/lib/utils'

const INTERVENTION_MS = 12000
const ACTION_LABELS: Record<string, string> = {
    hold: 'Hold', return: 'Return to launch', land: 'Land', pause_mission: 'Pause mission', set_mode: 'a mode change',
}

export function TakeoverBanner() {
    const takeover = useDroneStore(s => s.takeover)
    const intervention = useDroneStore(s => s.staffIntervention)
    const setIntervention = useDroneStore(s => s.setStaffIntervention)

    useEffect(() => {
        if (!intervention) return
        const id = setTimeout(() => {
            if (useDroneStore.getState().staffIntervention === intervention) setIntervention(null)
        }, INTERVENTION_MS)
        return () => clearTimeout(id)
    }, [intervention, setIntervention])

    if (takeover) {
        return (
            <div role="alert" aria-live="assertive"
                className={cn('fixed top-[60px] left-1/2 -translate-x-1/2 z-[3100] flex w-max max-w-[min(640px,calc(100vw-32px))] items-start gap-3 px-4 py-3 rounded-[10px]', TOAST_IN)}
                style={toastStyle('danger', 16)}>
                <ShieldAlert size={20} className="shrink-0 mt-0.5" style={{ color: toneColor('danger') }} aria-hidden />
                <span className="flex flex-col gap-1 min-w-0">
                    <span className="text-[14px] font-bold">
                        HYRAK operations has control ({takeover.by})
                    </span>
                    <span className="text-[13px] leading-relaxed text-app-text-muted">
                        Your commands, including hold, return and land, are held until they hand
                        control back. Video and telemetry keep running.
                    </span>
                </span>
            </div>
        )
    }
    if (!intervention) return null
    return (
        <div role="status"
            className={cn('fixed top-[60px] left-1/2 -translate-x-1/2 z-[3100] flex w-max max-w-[min(560px,calc(100vw-32px))] items-center gap-2.5 px-4 py-2.5 rounded-[10px] text-[13px]', TOAST_IN)}
            style={toastStyle('info')}>
            <Info size={18} className="shrink-0" style={{ color: toneColor('info') }} aria-hidden />
            <span>
                HYRAK operations ({intervention.by}) sent {ACTION_LABELS[intervention.action] ?? intervention.action} to your drone.
            </span>
        </div>
    )
}
