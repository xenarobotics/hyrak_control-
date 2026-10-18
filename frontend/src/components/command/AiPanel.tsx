'use client'

// The Command dock's AI tab: the running module's own panel - the same
// components the AI tab renders per mode (its ResultsPanel), so the controls
// (lock a person, follow, thresholds...) behave identically here.

import { useDroneStore } from '@/store/drone'
import { panelFor } from '@/components/vision/ModeSelector'
import { useLibraryEntry } from '@/components/models/useModelLibrary'
import { CustomResultsPanel } from '@/components/models/CustomResultsPanel'
import { css as cmCss } from '@/components/models/ui'
import { ModulePerformance } from '@/components/vision/ModulePerformance'

function Body({ mode }: { mode: string }) {
    if (mode.startsWith('custom:')) return <div className={cmCss.cm}><CustomResultsPanel mode={mode} /></div>
    return panelFor(mode)
}

export function AiPanel({ onStop }: { onStop: () => void }) {
    const mode = useDroneStore(s => s.mode)
    const m = useLibraryEntry(mode)
    if (!m) {
        return <p className="text-xs font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>
            Start a module from the AI drawer (the AI tab on the left edge of the view).</p>
    }
    const Icon = m.icon
    return (
        <>
            <div className="flex items-center gap-2">
                <Icon size={16} style={{ color: m.color }} />
                <span className="text-sm font-mono font-semibold" style={{ color: m.color }}>{m.name}</span>
                <span className="text-[10px] font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>{m.blurb}</span>
                <button onClick={onStop}
                    className="ml-auto h-7 px-2.5 rounded-md border text-[10px] font-mono tracking-widest text-red-300 border-red-400/40 hover:bg-red-500/10">
                    STOP</button>
            </div>
            <Body mode={mode} />
            <ModulePerformance />
        </>
    )
}
