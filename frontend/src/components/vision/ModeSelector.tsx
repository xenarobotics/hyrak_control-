'use client'

import { useDrone } from '@/hooks/useDrone'
import { useDroneStore } from '@/store/drone'
import { getSocket } from '@/lib/socket'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { cn } from '@/lib/utils'
import {
    ScanSearch, Users, Layers,
    ShieldAlert, Brain, Target, ScanFace, Sparkles
} from 'lucide-react'

const MODES = [
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
        desc: 'ZoeDepth metric'
    },
    {
        value: 'person-tracking',
        label: 'Person ID',
        icon: ScanFace,
        color: '#22d3ee',
        desc: 'Track specific person'
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

export function ModeSelector() {
    const { setMode } = useDrone()
    const currentMode = useDroneStore(s => s.mode)
    const { isStreaming } = useWebRTCContext()

    return (
        <div className="grid grid-cols-2 gap-2">
            {MODES.map(m => {
                const active = currentMode === m.value
                const Icon = m.icon
                const available = ['manual-control', 'object-detection', 'human-tracking', 'depth-mapping', 'person-tracking', 'enhance'].includes(m.value)

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