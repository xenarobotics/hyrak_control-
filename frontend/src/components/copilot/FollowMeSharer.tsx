'use client'

// Follow me: while the server's active task is follow me, share this
// browser's position (high accuracy) every 2 s as copilot_pilot_position.
// The server stops the task when positions stop for 5 s, so Stop here both
// ends the watch and asks the server to hold.

import { useEffect, useRef } from 'react'
import { LocateFixed, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUS } from '@/components/controls/flightStyles'
import { useCopilotStore, isFollowMe, sendPilotPosition, cancelCopilot, type GeoShare } from '@/lib/copilot'

const SEND_EVERY_MS = 2000

function setGeo(state: GeoShare, accuracy: number | null = null): void {
    useCopilotStore.setState({ geo: { state, accuracy } })
}

/** Runs the watch while follow me is active. Mounted once on the page (in
 *  CopilotHost), so switching dock tabs never stops it. */
export function FollowMeSharer() {
    const active = useCopilotStore(s => s.enabled && isFollowMe(s.task))
    const last = useRef<GeolocationPosition | null>(null)

    useEffect(() => {
        if (!active) return
        if (!('geolocation' in navigator)) {
            setGeo('unavailable')
            useCopilotStore.getState().addLocal('system', 'This browser cannot share its position, so follow me cannot work here.', 'error')
            return () => setGeo('off')
        }
        setGeo('waiting')
        let warned = false
        const id = navigator.geolocation.watchPosition(
            p => { last.current = p; setGeo('sharing', p.coords.accuracy) },
            err => {
                if (err.code === err.PERMISSION_DENIED) {
                    setGeo('denied')
                    if (!warned) useCopilotStore.getState().addLocal('system',
                        'Location is blocked for this page, so the drone cannot follow you. Allow location in the site settings, then ask again.', 'error')
                    warned = true
                } else if (!last.current) {
                    setGeo('unavailable')
                }
            },
            { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 },
        )
        const tick = setInterval(() => {
            const p = last.current
            // A fix older than 5 s is not where the pilot is now; the server
            // stops follow me when samples stop, which is the safe outcome.
            if (!p || Date.now() - p.timestamp > 5000) return
            sendPilotPosition(p.coords.latitude, p.coords.longitude, p.coords.accuracy)
        }, SEND_EVERY_MS)
        return () => {
            navigator.geolocation.clearWatch(id)
            clearInterval(tick)
            last.current = null
            setGeo('off')
        }
    }, [active])
    return null
}

/** "Sharing your position" chip with Stop. */
export function FollowMeChip() {
    const { state, accuracy } = useCopilotStore(s => s.geo)
    if (state === 'off') return null
    const text = state === 'sharing' ? 'Sharing your position'
        : state === 'waiting' ? 'Finding your position'
        : state === 'denied' ? 'Location blocked'
        : 'Position unavailable'
    const bad = state === 'denied' || state === 'unavailable'
    return (
        <div className={cn('flex items-center gap-2 min-h-10 pl-3 pr-1 rounded-[10px] border text-[13px] font-semibold',
            bad ? 'border-app-danger bg-app-danger-soft text-app-text' : 'border-app-magenta bg-app-magenta-soft text-app-text')}>
            <LocateFixed size={15} className={cn('shrink-0', bad ? 'text-app-danger' : 'text-app-magenta')} />
            <span className="truncate">{text}</span>
            {state === 'sharing' && accuracy != null && (
                <span className="text-app-text-muted font-normal tabular-nums whitespace-nowrap">within {Math.round(accuracy)} m</span>
            )}
            <button onClick={cancelCopilot} title="Stop follow me (the drone holds)"
                className={cn('ml-auto shrink-0 h-8 px-2.5 rounded-md flex items-center gap-1 text-[13px] font-bold text-app-text hover:bg-app-surface-2', FOCUS)}>
                <X size={14} /> Stop</button>
        </div>
    )
}
