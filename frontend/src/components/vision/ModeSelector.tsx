'use client'

import { createElement, type ComponentType, type ReactElement } from 'react'
import { useDrone } from '@/hooks/useDrone'
import { useDroneStore } from '@/store/drone'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { ObjectDetectionPanel } from '@/components/vision/ObjectDetectionPanel'
import { HumanTrackingPanel } from '@/components/vision/HumanTrackingPanel'
import { DepthMappingPanel } from '@/components/vision/DepthMappingPanel'
import { PersonTrackerPanel } from '@/components/vision/PersonTrackerPanel'
import { EnhancePanel } from '@/components/vision/EnhancePanel'
import { CrowdManagementPanel } from '@/components/vision/CrowdManagementPanel'
import { TrafficManagementPanel } from '@/components/vision/TrafficManagementPanel'
import { VehiclePlateTrackingPanel } from '@/components/vision/VehiclePlateTrackingPanel'
import { Reconstruction3DPanel } from '@/components/vision/Reconstruction3DPanel'
import {
    ScanSearch, Users, Layers,
    ShieldAlert, Brain, ScanFace, Sparkles,
    UsersRound, ScanLine, TrafficCone, Box,
} from 'lucide-react'
import { TEXT, MUTED, SUBTLE, SURFACE_2, BORDER, BORDER_STRONG, TONE, FOCUS } from './panelStyle'

// Exported: the Command window's AI drawer offers exactly this catalogue.
export const MODES = [
    {
        value: 'enhance',
        label: 'Enhance',
        icon: Sparkles,
        color: '#fbbf24',
        desc: 'Denoise, sharpen, color'
    },
    {
        value: 'object-detection',
        label: 'Objects',
        icon: ScanSearch,
        color: '#60a5fa',
        desc: 'YOLO detection'
    },
    {
        value: 'human-tracking',
        label: 'Human',
        icon: Users,
        color: '#4ade80',
        desc: 'Person tracking'
    },
    {
        value: 'depth-mapping',
        label: 'Depth',
        icon: Layers,
        color: '#f59e0b',
        desc: 'Depth Anything 3 metric'
    },
    {
        value: 'person-tracking',
        label: 'Person ID',
        icon: ScanFace,
        color: '#22d3ee',
        desc: 'Track specific person'
    },
    {
        value: 'crowd-management',
        label: 'Crowd',
        icon: UsersRound,
        color: '#38bdf8',
        desc: 'Count, density, alerts'
    },
    {
        value: 'vehicle-plate-tracking',
        label: 'Plates',
        icon: ScanLine,
        color: '#a3e635',
        desc: 'Vehicle + plate ANPR'
    },
    {
        value: 'traffic-management',
        label: 'Traffic',
        icon: TrafficCone,
        color: '#38bdf8',
        desc: 'Count + plate + colour + speed + follow'
    },
    {
        value: '3d-reconstruction',
        label: '3D Scan',
        icon: Box,
        color: '#34d399',
        desc: 'Live 3D reconstruction'
    },
    {
        value: 'obstacle-avoidance',
        label: 'Avoid',
        icon: ShieldAlert,
        color: '#f87171',
        desc: 'Collision prevention'
    },
    {
        value: 'scenario-assessment',
        label: 'Scene',
        icon: Brain,
        color: '#c084fc',
        desc: 'Situational AI'
    },
] as const

/** Each implemented mode's results panel. ONE table: the AI tab's results
 *  column and the Command dock's AI tab both render from it, so a new mode
 *  is added here once instead of in two switch statements. */
const MODE_PANELS: Record<string, ComponentType> = {
    'object-detection': ObjectDetectionPanel,
    'human-tracking': HumanTrackingPanel,
    'depth-mapping': DepthMappingPanel,
    'person-tracking': PersonTrackerPanel,
    'enhance': EnhancePanel,
    'crowd-management': CrowdManagementPanel,
    'vehicle-plate-tracking': VehiclePlateTrackingPanel,
    'traffic-management': TrafficManagementPanel,
    '3d-reconstruction': Reconstruction3DPanel,
}

/** The results panel element for `mode`, or null when it has none. Returns
 *  an element rather than the component, so callers never bind a component
 *  type to a render-time variable (which remounts it on every render). */
export function panelFor(mode: string): ReactElement | null {
    const Panel = MODE_PANELS[mode]
    return Panel ? createElement(Panel) : null
}

// Modes that are implemented; the rest render as "coming soon".
export const AVAILABLE_MODES: readonly string[] = ['manual-control', ...Object.keys(MODE_PANELS)]

export function ModeSelector() {
    const { setMode } = useDrone()
    const currentMode = useDroneStore(s => s.mode)
    const { isStreaming } = useWebRTCContext()

    return (
        <div className="grid grid-cols-2 gap-2">
            {MODES.map(m => {
                const active = currentMode === m.value
                const Icon = m.icon
                const available = AVAILABLE_MODES.includes(m.value)

                return (
                    <button
                        key={m.value}
                        type="button"
                        onClick={() => available && !isStreaming && setMode(m.value)}
                        disabled={!available || isStreaming}
                        aria-pressed={active}
                        aria-label={`${m.label} - ${available ? m.desc : 'coming soon'}`}
                        title={!available ? 'Coming soon' : isStreaming ? 'Stop the video to switch mode' : undefined}
                        className={FOCUS}
                        style={{
                            display: 'flex', alignItems: 'center', gap: 8, minHeight: 44,
                            padding: '8px 12px', borderRadius: 10, cursor: available && !isStreaming ? 'pointer' : 'not-allowed',
                            background: active ? TONE.accent.bg : SURFACE_2,
                            border: `1px solid ${active ? 'var(--app-accent)' : BORDER}`,
                            transition: 'background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
                        }}
                    >
                        <Icon size={16} aria-hidden style={{ color: !available ? SUBTLE : m.color, flexShrink: 0 }} />
                        <div style={{ textAlign: 'left', minWidth: 0 }}>
                            <div style={{
                                fontSize: 14, fontWeight: active ? 700 : 600,
                                color: available ? TEXT : SUBTLE,
                            }}>
                                {m.label}
                            </div>
                            <div style={{ fontSize: 12, color: available ? MUTED : SUBTLE, marginTop: 1 }}>
                                {available ? m.desc : 'Coming soon'}
                            </div>
                        </div>
                        {active && (
                            <div aria-hidden style={{
                                marginLeft: 'auto', width: 8, height: 8,
                                borderRadius: '50%', background: 'var(--app-accent)',
                                flexShrink: 0,
                            }} />
                        )}
                    </button>
                )
            })}
        </div>
    )
}