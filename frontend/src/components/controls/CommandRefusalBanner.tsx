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
            className="fixed top-16 left-1/2 -translate-x-1/2 z-[3000] flex max-w-[min(560px,calc(100vw-32px))] items-start gap-2.5 px-4 py-2.5 rounded-xl font-mono text-[11px] shadow-2xl"
            style={{
                background: 'rgba(120, 53, 15, .96)', border: '1px solid rgba(251, 191, 36, .55)',
                color: '#fde68a', backdropFilter: 'blur(8px)',
            }}>
            <Ban size={15} className="shrink-0 mt-px" />
            <span className="flex flex-col gap-0.5 min-w-0">
                <span className="font-bold tracking-wider">
                    {refusal.code === 'drone_not_in_workspace' ? 'DRONE IN ANOTHER WORKSPACE' : 'NOT ALLOWED'}
                </span>
                <span className="leading-relaxed" style={{ color: '#fef3c7' }}>{refusal.msg}</span>
            </span>
            <button onClick={() => setRefusal(null)} aria-label="Dismiss"
                className="shrink-0 p-0.5 rounded hover:bg-white/10">
                <X size={13} />
            </button>
        </div>
    )
}
