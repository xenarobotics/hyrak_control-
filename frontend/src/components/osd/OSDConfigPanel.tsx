'use client'

import { useState } from 'react'
import { Settings2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUS_OVERLAY, OVERLAY_BTN } from '@/components/controls/flightStyles'

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

function Toggle({ value, onChange, label, disabled }: { value: boolean; onChange: () => void; label: string; disabled?: boolean }) {
    return (
        <button type="button" role="switch" aria-checked={value} aria-label={label} onClick={onChange} disabled={disabled}
            className={cn('relative w-9 h-5 rounded-full shrink-0 border after:absolute after:-inset-1.5 transition-colors duration-[var(--dur)] disabled:cursor-not-allowed', FOCUS_OVERLAY,
                value ? 'bg-[var(--overlay-accent)] border-[var(--overlay-accent)]' : 'bg-white/15 border-overlay-border')}
        >
            <span className={cn('absolute top-1/2 -translate-y-1/2 left-0 w-3.5 h-3.5 rounded-full transition-transform duration-[var(--dur)]',
                value ? 'translate-x-[17px] bg-[#04161b]' : 'translate-x-[2px] bg-overlay-text')} />
        </button>
    )
}

export function OSDConfigPanel({ config, onUpdate, onPreset }: Props) {
    const [open, setOpen] = useState(false)

    const widgetKeys = (Object.keys(config) as (keyof OSDWidgetConfig)[])
        .filter(k => k !== 'enabled')

    return (
        <div className="relative">
            {/* Toggle button */}
            <button
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
                title="Choose what the video overlay shows"
                className={cn(OVERLAY_BTN, FOCUS_OVERLAY, open && 'bg-[rgba(8,12,18,0.92)] border-white/30',
                    config.enabled ? 'text-overlay-text' : 'text-overlay-muted')}
            >
                <Settings2 size={14} />
                OSD
                {/* Master enabled indicator */}
                <span className={cn('w-2 h-2 rounded-full', config.enabled ? 'bg-[var(--overlay-ok)]' : 'bg-overlay-muted')} />
            </button>

            {open && (
                <div className="absolute top-full right-0 mt-1 w-[232px] rounded-[10px] overflow-hidden z-[100] border border-overlay-border text-overlay-text"
                    style={{ background: 'rgba(8,12,18,0.92)', backdropFilter: 'blur(6px)' }}>
                    {/* Header */}
                    <div className="flex items-center justify-between px-3 py-1.5 border-b border-overlay-border">
                        <span className="text-[13px] font-bold">Overlay widgets</span>
                        <button onClick={() => setOpen(false)} aria-label="Close" title="Close"
                            className={cn('h-8 w-8 -mr-2 flex items-center justify-center rounded-md text-overlay-muted hover:text-overlay-text', FOCUS_OVERLAY)}>
                            <X size={15} />
                        </button>
                    </div>

                    {/* Master toggle */}
                    <div className={cn('flex items-center justify-between px-3 py-2.5 border-b border-overlay-border', config.enabled && 'bg-[rgba(34,211,238,0.10)]')}>
                        <span className={cn('text-[13px] font-bold', config.enabled ? 'text-[var(--overlay-accent)]' : 'text-overlay-muted')}>
                            {config.enabled ? 'Overlay on' : 'Overlay off'}
                        </span>
                        <Toggle label="Video overlay" value={config.enabled} onChange={() => onUpdate('enabled', !config.enabled)} />
                    </div>

                    {/* Presets */}
                    <div className="flex gap-1.5 px-3 py-2 border-b border-overlay-border">
                        {(['minimal', 'standard', 'full'] as const).map(p => (
                            <button
                                key={p}
                                onClick={() => onPreset(p)}
                                className={cn('flex-1 h-8 rounded-md border border-overlay-border bg-white/5 text-[12px] font-bold capitalize text-overlay-muted hover:text-overlay-text', FOCUS_OVERLAY)}
                            >
                                {p}
                            </button>
                        ))}
                    </div>

                    {/* Individual toggles */}
                    <div className="pt-1 pb-2 max-h-60 overflow-y-auto">
                        {widgetKeys.map(key => (
                            <div key={key} className="flex items-center justify-between px-3 py-1.5">
                                <span className={cn('text-[13px]', config.enabled ? 'text-overlay-text' : 'text-overlay-muted')}>
                                    {WIDGET_LABELS[key]}
                                </span>
                                <Toggle
                                    label={WIDGET_LABELS[key]}
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
