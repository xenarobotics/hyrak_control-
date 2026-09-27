'use client'

import { useDrone } from '@/hooks/useDrone'
import { useDroneStore } from '@/store/drone'
import { getSocket } from '@/lib/socket'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { cn } from '@/lib/utils'
import {
    ScanSearch, Users, Layers,
    ShieldAlert, Brain, Target, ScanFace, Sparkles,
    UsersRound, ScanLine, TrafficCone, Box,
} from 'lucide-react'

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

// Modes that are implemented; the rest render as "coming soon".
export const AVAILABLE_MODES: readonly string[] = [
    'manual-control', 'object-detection', 'human-tracking', 'depth-mapping', 'person-tracking',
    'enhance', 'crowd-management', 'vehicle-plate-tracking', 'traffic-management', '3d-reconstruction',
]

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
                        onClick={() => available && !isStreaming && setMode(m.value)}
                        disabled={!available || isStreaming}
                        style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '8px 10px', borderRadius: 10, cursor: available ? 'pointer' : 'not-allowed',
                            background: active ? `${m.color}18` : 'hsl(var(--app-surface-2))',
                            border: `1px solid ${active ? m.color + '60' : 'hsl(var(--app-border))'}`,
                            opacity: !available ? 0.4 : 1,
                            transition: 'all 0.15s',
                        }}
                    >
                        <Icon size={16} style={{ color: active ? m.color : 'hsl(var(--app-text-muted))', flexShrink: 0 }} />
                        <div style={{ textAlign: 'left', minWidth: 0 }}>
                            <div style={{
                                fontSize: 12, fontWeight: 500,
                                color: active ? m.color : 'hsl(var(--app-text))',
                                fontFamily: 'var(--font-geist-mono)',
                            }}>
                                {m.label}
                            </div>
                            <div style={{ fontSize: 10, color: 'hsl(var(--app-text-muted))', marginTop: 1 }}>
                                {available ? m.desc : 'coming soon'}
                            </div>
                        </div>
                        {active && (
                            <div style={{
                                marginLeft: 'auto', width: 6, height: 6,
                                borderRadius: '50%', background: m.color,
                                flexShrink: 0,
                            }} />
                        )}
                    </button>
                )
            })}
        </div>
    )
}