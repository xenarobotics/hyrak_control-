'use client'

// The Command dock's AI tab: the running module's own panel - the same
// components the AI tab renders per mode (its ResultsPanel), so the controls
// (lock a person, follow, thresholds...) behave identically here.

import { useDroneStore } from '@/store/drone'
import { cn } from '@/lib/utils'
import { FOCUS } from '@/components/controls/flightStyles'
import { panelFor } from '@/components/vision/ModeSelector'
import { useLibraryEntry } from '@/components/models/useModelLibrary'
import { CustomResultsPanel } from '@/components/models/CustomResultsPanel'
import { css as cmCss } from '@/components/models/ui'
import { ModulePerformance } from '@/components/vision/ModulePerformance'
import { MapDetectionsControls } from '@/components/mapdetect/MapDetectionsUi'

function Body({ mode }: { mode: string }) {
    if (mode.startsWith('custom:')) return <div className={cmCss.cm}><CustomResultsPanel mode={mode} /></div>
    return panelFor(mode)
}

export function AiPanel({ onStop }: { onStop: () => void }) {
    const mode = useDroneStore(s => s.mode)
    const m = useLibraryEntry(mode)
    if (!m) {
        return <p className="text-[13px] text-app-text-muted">
            Start a module from the AI drawer (the AI tab on the left edge of the view).</p>
    }
    const Icon = m.icon
    return (
        <>
            <div className="flex items-center gap-2">
                <Icon size={16} style={{ color: m.color }} />
                <span className="text-[16px] font-bold text-app-text">{m.name}</span>
                <span className="text-[13px] text-app-text-muted truncate">{m.blurb}</span>
                <button onClick={onStop}
                    className={cn('ml-auto shrink-0 h-8 px-3 rounded-md border border-app-danger text-[13px] font-bold text-app-danger hover:bg-app-danger-soft', FOCUS)}>
                    Stop</button>
            </div>
            <Body mode={mode} />
            <MapDetectionsControls />
            <ModulePerformance />
        </>
    )
}
