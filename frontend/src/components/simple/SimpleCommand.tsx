'use client'

// NORMAL MODE - the flight screen for anyone.
//
//   top     one sentence saying what is happening, coloured by what it means,
//           with height and battery
//   centre  the camera (or the map) big, the other small in the corner
//   right   "What to do now": only the buttons that make sense right now
//   bottom  how far along the planned route the drone is
//
// No jargon, no codes, no tiny readouts. The full engineering screen is one
// press away (Dev view) and in Settings.

import { useEffect } from 'react'
import { getSocket } from '@/lib/socket'
import { useDroneStore } from '@/store/drone'
import { useAvoidanceLive } from '@/components/command/useAvoidanceLive'
import { setUiMode } from '@/lib/uiPrefs'
import { useFlightState } from './useFlightState'
import { StatusBand } from './StatusBand'
import { ViewStage } from './ViewStage'
import { ActionPanel } from './ActionPanel'
import { RouteBar } from './RouteBar'

export function SimpleCommand() {
    const avoid = useAvoidanceLive()
    const s = useFlightState(avoid)
    const mode = useDroneStore(st => st.mode)

    // A plain camera picture unless the operator chose a smart mode in Dev.
    useEffect(() => {
        if (mode === 'manual-control') getSocket().emit('set_analysis_mode', { mode: 'manual-control' })
    }, [mode])

    const steering = avoid?.state === 'avoiding' || avoid?.state === 'climbing' || avoid?.guarding
    const alert = steering ? (
        <p className="rounded-xl px-4 py-2.5 text-[18px] font-bold"
            style={{ background: 'var(--s-amber)', color: 'var(--s-amber-ink)', boxShadow: '0 4px 16px rgba(15,30,51,.25)' }}>
            Avoiding an obstacle
        </p>
    ) : undefined

    return (
        <div className="hy-simple h-full min-h-0 flex flex-col gap-3 p-3 rounded-2xl">
            <StatusBand s={s} onSwitchMode={() => setUiMode('dev')} />
            <div className="flex-1 min-h-0 flex gap-3 max-lg:flex-col">
                <ViewStage alert={alert} />
                <aside className="lg:w-[360px] shrink-0 flex flex-col rounded-[var(--s-radius)] p-5 overflow-y-auto"
                    style={{ background: 'var(--s-panel)', border: '1px solid var(--s-line)' }} aria-label="What to do now">
                    <h1 className="text-[22px] font-bold mb-4">What to do now</h1>
                    <ActionPanel s={s} avoid={avoid} />
                </aside>
            </div>
            <RouteBar s={s} />
        </div>
    )
}
