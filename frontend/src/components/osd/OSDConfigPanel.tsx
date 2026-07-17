'use client'

import { useState } from 'react'
import { Settings2, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface OSDWidgetConfig {
    enabled: boolean
    artificialHorizon: boolean
    altitudeTape: boolean
    speedTape: boolean
    headingTape: boolean
    batteryWidget: boolean
    gpsWidget: boolean
    flightTimer: boolean
    armedMode: boolean
    homeDistance: boolean
    climbRate: boolean
    networkStats: boolean
    visionOverlay: boolean
    coordinates: boolean
    verticalSpeed: boolean
}

const DEFAULT_CONFIG: OSDWidgetConfig = {
    enabled: true,
    artificialHorizon: true,
    altitudeTape: true,
    speedTape: true,
    headingTape: true,
    batteryWidget: true,
    gpsWidget: true,
    flightTimer: true,
    armedMode: true,
    homeDistance: true,
    climbRate: true,
    networkStats: true,
    visionOverlay: false,
    coordinates: false,
    verticalSpeed: false,
}

const WIDGET_LABELS: Record<keyof OSDWidgetConfig, string> = {
    enabled: 'OSD Overlay',
    artificialHorizon: 'Artificial Horizon',
    altitudeTape: 'Altitude Tape',
    speedTape: 'Speed Tape',
    headingTape: 'Heading Tape',
    batteryWidget: 'Battery',
    gpsWidget: 'GPS Info',
    flightTimer: 'Flight Timer',
    armedMode: 'Armed / Mode',
    homeDistance: 'Home Distance',
    climbRate: 'Climb Rate',
    networkStats: 'Network Stats',
    visionOverlay: 'Vision / AI Data',
    coordinates: 'GPS Coordinates',
    verticalSpeed: 'Abs Altitude',
}

const STORAGE_KEY = 'verocore-osd-config'

export function useOSDConfig() {
    const [config, setConfig] = useState<OSDWidgetConfig>(() => {
        if (typeof window === 'undefined') return DEFAULT_CONFIG
        try {
            const saved = localStorage.getItem(STORAGE_KEY)
            return saved ? { ...DEFAULT_CONFIG, ...JSON.parse(saved) } : DEFAULT_CONFIG
        } catch { return DEFAULT_CONFIG }
    })

    const updateWidget = (key: keyof OSDWidgetConfig, value: boolean) => {
        setConfig(prev => {
            const next = { ...prev, [key]: value }
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
            return next
        })
    }

    const setPreset = (preset: 'minimal' | 'standard' | 'full') => {
        let next: OSDWidgetConfig
        if (preset === 'minimal') {
            next = {
                ...DEFAULT_CONFIG,
                artificialHorizon: false, altitudeTape: false, speedTape: false,
                headingTape: false, climbRate: false, networkStats: false,
                coordinates: false, verticalSpeed: false, visionOverlay: false,
            }
        } else if (preset === 'full') {
            next = Object.fromEntries(
                Object.keys(DEFAULT_CONFIG).map(k => [k, true])
            ) as unknown as OSDWidgetConfig
        } else {
            next = { ...DEFAULT_CONFIG }
        }
        setConfig(next)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    }

    return { config, updateWidget, setPreset }
}

interface Props {
    config: OSDWidgetConfig
    onUpdate: (key: keyof OSDWidgetConfig, value: boolean) => void
    onPreset: (p: 'minimal' | 'standard' | 'full') => void
}

function Toggle({ value, onChange }: { value: boolean; onChange: () => void }) {
    return (
        <div
            onClick={onChange}
            style={{
                width: 32, height: 16, borderRadius: 8, cursor: 'pointer',
                background: value ? '#06b6d4' : 'rgba(255,255,255,0.2)',
                position: 'relative', transition: 'background 0.2s', flexShrink: 0,
            }}
        >
            <div style={{
                position: 'absolute', top: 2, width: 12, height: 12,
                borderRadius: '50%', background: 'white',
                left: value ? 18 : 2,
                transition: 'left 0.2s',
            }} />
        </div>
    )
}

export function OSDConfigPanel({ config, onUpdate, onPreset }: Props) {
    const [open, setOpen] = useState(false)

    const widgetKeys = (Object.keys(config) as (keyof OSDWidgetConfig)[])
        .filter(k => k !== 'enabled')

    return (
        <div style={{ position: 'relative' }}>
            {/* Toggle button */}
            <button
                onClick={() => setOpen(o => !o)}
                style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '6px 10px', borderRadius: 8,
                    background: open ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.5)',
                    backdropFilter: 'blur(8px)',
                    border: `1px solid ${open ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.12)'}`,
                    color: config.enabled ? 'white' : 'rgba(255,255,255,0.4)',
                    fontFamily: 'monospace', fontSize: 11, cursor: 'pointer',
                    transition: 'all 0.15s',
                }}
            >
                <Settings2 size={13} />
                OSD
                {/* Master enabled indicator */}
                <div style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: config.enabled ? '#4ade80' : 'rgba(255,255,255,0.3)',
                }} />
            </button>

            {open && (
                <div style={{
                    position: 'absolute', top: '100%', right: 0, marginTop: 4,
                    width: 220, borderRadius: 12, overflow: 'hidden', zIndex: 100,
                    background: 'rgba(0,0,0,0.82)',
                    backdropFilter: 'blur(16px)',
                    border: '1px solid rgba(255,255,255,0.15)',
                }}>
                    {/* Header */}
                    <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '8px 12px',
                        borderBottom: '1px solid rgba(255,255,255,0.1)',
                    }}>
                        <span style={{ color: 'white', fontSize: 11, fontFamily: 'monospace', fontWeight: 600 }}>
                            OSD WIDGETS
                        </span>
                        <button onClick={() => setOpen(false)}
                            style={{ color: 'rgba(255,255,255,0.5)', background: 'none', border: 'none', cursor: 'pointer' }}>
                            <X size={13} />
                        </button>
                    </div>

                    {/* Master toggle */}
                    <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '10px 12px',
                        borderBottom: '1px solid rgba(255,255,255,0.1)',
                        background: config.enabled ? 'rgba(6,182,212,0.1)' : 'transparent',
                    }}>
                        <span style={{ color: config.enabled ? '#67e8f9' : 'rgba(255,255,255,0.5)', fontSize: 12, fontFamily: 'monospace', fontWeight: 600 }}>
                            {config.enabled ? 'OVERLAY ON' : 'OVERLAY OFF'}
                        </span>
                        <Toggle value={config.enabled} onChange={() => onUpdate('enabled', !config.enabled)} />
                    </div>

                    {/* Presets */}
                    <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                        {(['minimal', 'standard', 'full'] as const).map(p => (
                            <button
                                key={p}
                                onClick={() => onPreset(p)}
                                style={{
                                    flex: 1, padding: '4px 0', borderRadius: 6, cursor: 'pointer',
                                    background: 'rgba(255,255,255,0.07)',
                                    border: '1px solid rgba(255,255,255,0.1)',
                                    color: 'rgba(255,255,255,0.65)',
                                    fontSize: 10, fontFamily: 'monospace', textTransform: 'capitalize',
                                }}
                            >
                                {p}
                            </button>
                        ))}
                    </div>

                    {/* Individual toggles */}
                    <div style={{ padding: '4px 0 8px', maxHeight: 240, overflowY: 'auto' }}>
                        {widgetKeys.map(key => (
                            <div
                                key={key}
                                style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                    padding: '6px 12px',
                                    opacity: config.enabled ? 1 : 0.4,
                                }}
                            >
                                <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11, fontFamily: 'monospace' }}>
                                    {WIDGET_LABELS[key]}
                                </span>
                                <Toggle
                                    value={config[key] as boolean}
                                    onChange={() => onUpdate(key, !(config[key] as boolean))}
                                />
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}