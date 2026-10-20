'use client'

// A command the server refused on access grounds (docs/ACCESS_MODEL.md
// section 8a): `forbidden` (the role in this workspace does not allow it) or
// `drone_not_in_workspace` (the drone belongs to another workspace; the
// message names the fix). Pinned top-centre below the zone banner, on every
// platform page, since a refusal can answer a button pressed anywhere. Stays
// 12 s or until dismissed; a newer refusal replaces it.
//
// The server's own text is written for logs ("start_rc_monitor requires the
// viewer role"). A pilot gets plain words; the raw text stays in the tooltip
// for whoever is debugging.

import { useEffect } from 'react'
import { Ban, X } from 'lucide-react'
import { useDroneStore } from '@/store/drone'
import { toastStyle, toneColor, usePresence, TOAST_IN, TOAST_OUT } from '@/components/notifications/toast'
import { cn } from '@/lib/utils'

const SHOW_MS = 12000

// Commands whose refusal a pilot is likely to see, in words.
const WHAT: Record<string, string> = {
    arm: 'arm the drone', disarm: 'disarm the drone', takeoff: 'take off', land: 'land the drone',
    hold: 'hold the drone', return: 'bring the drone home', set_mode: 'change the flight mode',
    set_altitude: 'change the altitude', emergency_stop: 'kill the motors',
    start_mission: 'start the mission', upload_mission: 'upload a mission',
    start_rc_monitor: 'read the radio channels', connect_telemetry: 'connect the drone',
}
const ROLE: Record<string, string> = { viewer: 'view', operator: 'fly', admin: 'admin' }

/** Plain-words body for a refusal; null keeps the server's text. */
export function plainRefusal(code: string | undefined, msg: string | undefined): string {
    const m = (msg ?? '').trim()
    const req = /^([a-z][a-z0-9_]*) requires (?:the )?([a-z]+) role/i.exec(m)
    if (req) {
        const what = WHAT[req[1]] ?? 'do that'
        const role = ROLE[req[2].toLowerCase()]
        return `Your role in this workspace cannot ${what}.${role ? ` It needs ${role} access; ask the workspace owner.` : ''}`
    }
    // Anything that still reads like code (snake_case words, braces) gets the
    // generic line instead of the developer text.
    if (!m || /\b[a-z]+_[a-z_]+\b|[{}[\]]/.test(m)) {
        return code === 'drone_not_in_workspace'
            ? 'This drone belongs to another workspace. Switch workspace to fly it.'
            : 'Your role in this workspace cannot do that. Ask the workspace owner for access.'
    }
    return m
}

export function CommandRefusalBanner() {
    const refusal = useDroneStore(s => s.commandRefusal)
    const setRefusal = useDroneStore(s => s.setCommandRefusal)
    const { shown, leaving } = usePresence(refusal)

    useEffect(() => {
        if (!refusal) return
        const id = setTimeout(() => {
            if (useDroneStore.getState().commandRefusal === refusal) setRefusal(null)
        }, SHOW_MS)
        return () => clearTimeout(id)
    }, [refusal, setRefusal])

    if (!shown) return null
    return (
        <div role="alert" title={shown.msg}
            className={cn('fixed top-[116px] left-1/2 -translate-x-1/2 z-[3000] flex w-max max-w-[min(520px,calc(100vw-32px))] items-start gap-2.5 pl-4 pr-2 py-2.5 rounded-[10px] text-[13px]',
                leaving ? TOAST_OUT : TOAST_IN)}
            style={toastStyle('warn')}>
            <Ban size={18} className="shrink-0 mt-0.5" style={{ color: toneColor('warn') }} aria-hidden />
            <span className="flex flex-col gap-0.5 min-w-0">
                <span className="text-[14px] font-bold">
                    {shown.code === 'drone_not_in_workspace' ? 'Drone is in another workspace' : 'Not allowed'}
                </span>
                <span className="leading-relaxed text-app-text-muted">{plainRefusal(shown.code, shown.msg)}</span>
            </span>
            <button type="button" onClick={() => setRefusal(null)} aria-label="Dismiss" title="Dismiss"
                className="-my-1 flex size-8 shrink-0 items-center justify-center rounded-md text-app-text-muted transition-colors duration-[140ms] hover:bg-app-surface-2 hover:text-app-text">
                <X size={16} />
            </button>
        </div>
    )
}
