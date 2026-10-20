'use client'

// A command the server refused on access grounds (docs/ACCESS_MODEL.md
// section 8a), shown to the pilot in the server's own words: `forbidden`
// (the role in this workspace does not allow it) or `drone_not_in_workspace`
// (the drone belongs to another workspace; the message names the fix).
// Pinned top-centre like the zone banner, but below it, on every platform
// page, since a refusal can answer a button pressed anywhere. Stays 12 s or
// until dismissed; a newer refusal replaces it.

import { useEffect } from 'react'
import { Ban, X } from 'lucide-react'
import { useDroneStore } from '@/store/drone'

const SHOW_MS = 12000

export function CommandRefusalBanner() {
    const refusal = useDroneStore(s => s.commandRefusal)
    const setRefusal = useDroneStore(s => s.setCommandRefusal)

    useEffect(() => {
        if (!refusal) return
        const id = setTimeout(() => {
            if (useDroneStore.getState().commandRefusal === refusal) setRefusal(null)
        }, SHOW_MS)
        return () => clearTimeout(id)
    }, [refusal, setRefusal])

    if (!refusal) return null
    return (
        <div role="alert"
            className="fixed top-16 left-1/2 -translate-x-1/2 z-[3000] flex max-w-[min(560px,calc(100vw-32px))] items-start gap-2.5 px-4 py-2.5 rounded-[10px] text-[13px] shadow-2xl"
            style={{
                background: 'rgba(120, 53, 15, .97)', border: '1px solid rgba(251, 191, 36, .55)',
                color: '#fde68a',
            }}>
            <Ban size={18} className="shrink-0 mt-0.5" aria-hidden />
            <span className="flex flex-col gap-0.5 min-w-0">
                <span className="text-[14px] font-bold">
                    {refusal.code === 'drone_not_in_workspace' ? 'Drone is in another workspace' : 'Not allowed'}
                </span>
                <span className="leading-relaxed" style={{ color: '#fef3c7' }}>{refusal.msg}</span>
            </span>
            <button type="button" onClick={() => setRefusal(null)} aria-label="Dismiss" title="Dismiss"
                className="-my-1 -mr-2 flex size-8 shrink-0 items-center justify-center rounded-md transition-colors duration-[120ms] hover:bg-white/10">
                <X size={16} />
            </button>
        </div>
    )
}
