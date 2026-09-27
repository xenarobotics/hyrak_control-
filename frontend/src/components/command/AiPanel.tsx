'use client'

// The Command dock's AI tab: the running module's own panel - the same
// components the AI tab renders per mode (its ResultsPanel), so the controls
// (lock a person, follow, thresholds...) behave identically here.

import { useDroneStore } from '@/store/drone'
import { MODES } from '@/components/vision/ModeSelector'
import { ObjectDetectionPanel } from '@/components/vision/ObjectDetectionPanel'
import { HumanTrackingPanel } from '@/components/vision/HumanTrackingPanel'
import { DepthMappingPanel } from '@/components/vision/DepthMappingPanel'
import { PersonTrackerPanel } from '@/components/vision/PersonTrackerPanel'
import { EnhancePanel } from '@/components/vision/EnhancePanel'
import { CrowdManagementPanel } from '@/components/vision/CrowdManagementPanel'
import { TrafficManagementPanel } from '@/components/vision/TrafficManagementPanel'
import { VehiclePlateTrackingPanel } from '@/components/vision/VehiclePlateTrackingPanel'
import { Reconstruction3DPanel } from '@/components/vision/Reconstruction3DPanel'
import { ModulePerformance } from '@/components/vision/ModulePerformance'

function Body({ mode }: { mode: string }) {
    switch (mode) {
        case 'object-detection': return <ObjectDetectionPanel />
        case 'human-tracking': return <HumanTrackingPanel />
        case 'depth-mapping': return <DepthMappingPanel />
        case 'person-tracking': return <PersonTrackerPanel />
        case 'enhance': return <EnhancePanel />
        case 'crowd-management': return <CrowdManagementPanel />
        case 'vehicle-plate-tracking': return <VehiclePlateTrackingPanel />
        case 'traffic-management': return <TrafficManagementPanel />
        case '3d-reconstruction': return <Reconstruction3DPanel />
        default: return null
    }
}

export function AiPanel({ onStop }: { onStop: () => void }) {
    const mode = useDroneStore(s => s.mode)
    const m = MODES.find(x => x.value === mode)
    if (!m) {
        return <p className="text-xs font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>
            Start a module from the AI drawer (the AI tab on the left edge of the view).</p>
    }
    const Icon = m.icon
    return (
        <>
            <div className="flex items-center gap-2">
                <Icon size={16} style={{ color: m.color }} />
                <span className="text-sm font-mono font-semibold" style={{ color: m.color }}>{m.label}</span>
                <span className="text-[10px] font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>{m.desc}</span>
                <button onClick={onStop}
                    className="ml-auto h-7 px-2.5 rounded-md border text-[10px] font-mono tracking-widest text-red-300 border-red-400/40 hover:bg-red-500/10">
                    STOP</button>
            </div>
            <Body mode={mode} />
            <ModulePerformance />
        </>
    )
}
