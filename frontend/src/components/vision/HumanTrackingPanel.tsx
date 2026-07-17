'use client'

import { useState, useEffect, useCallback } from 'react'
import { useDroneStore } from '@/store/drone'
import { getSocket } from '@/lib/socket'
import {
    Users, Target, Timer, Crosshair, Square, Info,
    ChevronDown, ChevronUp, Mountain, MoveVertical,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// Default PD values — kept in sync with backend defaults
const PD_DEFAULTS = { kp: 0.8, kd: 0.4, max_output: 300, deadband: 0.05 }

const PD_PARAMS = [
    {
        key: 'max_output' as const,
        label: 'Max Speed',
        min: 50, max: 500, step: 10,
        unit: '',
        format: (v: number) => v.toFixed(0),
        tooltip: 'Maximum drone speed while tracking. Higher = catches fast-moving subjects, but can overshoot and oscillate. Start low (100–200) and increase gradually.',
    },
    {
        key: 'kp' as const,
        label: 'Responsiveness',
        min: 0.1, max: 2.0, step: 0.05,
        unit: '',
        format: (v: number) => v.toFixed(2),
        tooltip: 'How strongly the drone reacts when the subject moves off-centre (proportional gain Kp). Higher = snappier tracking. Too high causes oscillation — the drone will overshoot and correct repeatedly.',
    },
    {
        key: 'kd' as const,
        label: 'Smoothing',
        min: 0.0, max: 0.8, step: 0.02,
        unit: '',
        format: (v: number) => v.toFixed(2),
        tooltip: 'Dampens sudden corrections to avoid oscillation (derivative gain Kd). Higher = smoother but slower to catch up. Should be around half the Responsiveness value.',
    },
    {
        key: 'deadband' as const,
        label: 'Dead Zone',
        min: 0.01, max: 0.15, step: 0.01,
        unit: '',
        format: (v: number) => v.toFixed(2),
        tooltip: 'Minimum error (as a fraction of frame width) before a correction is sent. Higher = less twitchy hovering but less centred tracking. Increase if the drone never fully settles.',
    },
]

// Maps distance ratio to a human-readable label
function distanceLabel(ratio: number): string {
    if (ratio >= 0.50) return 'Very close'
    if (ratio >= 0.38) return 'Close'
    if (ratio >= 0.26) return 'Medium'
    if (ratio >= 0.18) return 'Far'
    return 'Very far'
}

function ParamSlider({
    label, value, min, max, step, unit, format, tooltip, onChange, disabled,
}: {
    label: string; value: number; min: number; max: number
    step: number; unit: string; format: (v: number) => string
    tooltip: string; onChange: (v: number) => void; disabled: boolean
}) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>
                        {label}
                    </span>
                    <Tooltip>
                        <TooltipTrigger style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', padding: 0, cursor: 'help' }}>
                            <Info size={11} style={{ color: 'hsl(var(--app-text-muted))' }} />
                        </TooltipTrigger>
                        <TooltipContent style={{ maxWidth: 220, fontSize: 11, lineHeight: 1.5 }}>
                            {tooltip}
                        </TooltipContent>
                    </Tooltip>
                </div>
                <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text))' }}>
                    {format(value)}{unit}
                </span>
            </div>
            <input
                type="range"
                min={min} max={max} step={step}
                value={value}
                disabled={disabled}
                onChange={e => onChange(parseFloat(e.target.value))}
                style={{
                    width: '100%', accentColor: '#4ade80',
                    opacity: disabled ? 0.4 : 1, cursor: disabled ? 'not-allowed' : 'pointer',
                }}
            />
        </div>
    )
}

// ── Pill toggle button ────────────────────────────────────────────────────────
function PillToggle({ active, onClick, children }: {
    active: boolean; onClick: () => void; children: React.ReactNode
}) {
    return (
        <button
            onClick={onClick}
            style={{
                padding: '3px 10px', borderRadius: 20, fontSize: 10,
                fontFamily: 'monospace', fontWeight: 600, cursor: 'pointer',
                border: active ? '1px solid #4ade80' : '1px solid hsl(var(--app-border))',
                background: active ? '#4ade8018' : 'hsl(var(--app-surface-2))',
                color: active ? '#4ade80' : 'hsl(var(--app-text-muted))',
                transition: 'all 0.15s',
            }}
        >
            {children}
        </button>
    )
}

const DISTANCE_STEP = 0.06
const DISTANCE_MIN  = 0.10
const DISTANCE_MAX  = 0.60

export function HumanTrackingPanel() {
    const cvResults = useDroneStore(s => s.cvResults)
    const [selectedId, setSelectedId] = useState<number | null>(null)
    const [isTracking, setIsTracking] = useState(false)
    const [pdOpen, setPdOpen] = useState(false)
    const [pd, setPd] = useState(PD_DEFAULTS)

    // Flight control state
    const [altitudeMode, setAltitudeModeState] = useState<'fixed' | 'auto'>('fixed')
    const [distanceRatio, setDistanceRatioState] = useState(0.25)

    const persons = cvResults?.persons ?? []
    const inferenceMs = cvResults?.analysis_time_ms ?? 0

    useEffect(() => {
        const socket = getSocket()
        socket.on('tracking_status', (d: { active: boolean }) => setIsTracking(d.active))
        socket.on('person_selected', () => {})
        return () => {
            socket.off('tracking_status')
            socket.off('person_selected')
        }
    }, [])

    const emitPdParams = useCallback((params: typeof PD_DEFAULTS) => {
        getSocket().emit('set_pd_params', params)
    }, [])

    const handlePdChange = (key: keyof typeof PD_DEFAULTS, value: number) => {
        const next = { ...pd, [key]: value }
        setPd(next)
        emitPdParams(next)
    }

    const handleSelectPerson = (id: number) => {
        if (isTracking) return
        setSelectedId(id)
        getSocket().emit('select_person', { person_id: id })
    }

    const handleStartTracking = () => {
        if (selectedId === null) return
        getSocket().emit('set_tracking', { active: true })
        setIsTracking(true)
    }

    const handleStopTracking = () => {
        getSocket().emit('set_tracking', { active: false })
        setIsTracking(false)
    }

    const handleAltitudeMode = (mode: 'fixed' | 'auto') => {
        setAltitudeModeState(mode)
        getSocket().emit('set_altitude_mode', { mode })
    }

    const handleDistanceChange = (ratio: number) => {
        const clamped = Math.max(DISTANCE_MIN, Math.min(DISTANCE_MAX, ratio))
        const rounded = parseFloat(clamped.toFixed(2))
        setDistanceRatioState(rounded)
        getSocket().emit('set_tracking_params', { target_distance_ratio: rounded })
    }

    const handleCloser = () => handleDistanceChange(distanceRatio + DISTANCE_STEP)
    const handleFurther = () => handleDistanceChange(distanceRatio - DISTANCE_STEP)

    const cmd = (cvResults as any)?.drone_command

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* Stats */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <div style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px',
                    background: 'hsl(var(--app-surface-2))',
                    border: '1px solid hsl(var(--app-border))',
                    borderRadius: 8, fontSize: 11, fontFamily: 'monospace',
                    color: 'hsl(var(--app-text-muted))',
                }}>
                    <Timer size={12} /> {inferenceMs.toFixed(0)}ms
                </div>
                <div style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px',
                    background: 'hsl(var(--app-surface-2))',
                    border: '1px solid hsl(var(--app-border))',
                    borderRadius: 8, fontSize: 11, fontFamily: 'monospace',
                    color: 'hsl(var(--app-text-muted))',
                }}>
                    <Users size={12} /> {persons.length} detected
                </div>
                {isTracking && (
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px',
                        background: '#E1F5EE18', border: '1px solid #5DCAA5',
                        borderRadius: 8, fontSize: 11, fontFamily: 'monospace', color: '#5DCAA5',
                    }}>
                        <Crosshair size={12} /> TRACKING #{selectedId}
                    </div>
                )}
            </div>

            {/* Track / Stop buttons */}
            <div style={{ display: 'flex', gap: 8 }}>
                {!isTracking ? (
                    <Button
                        size="sm"
                        className="flex-1 gap-2 font-mono text-xs"
                        disabled={selectedId === null}
                        onClick={handleStartTracking}
                        style={{
                            background: selectedId !== null ? '#0F6E56' : undefined,
                            opacity: selectedId === null ? 0.5 : 1,
                        }}
                    >
                        <Crosshair size={13} />
                        {selectedId !== null ? `Track Person #${selectedId}` : 'Select a person first'}
                    </Button>
                ) : (
                    <Button
                        size="sm"
                        variant="destructive"
                        className="flex-1 gap-2 font-mono text-xs"
                        onClick={handleStopTracking}
                    >
                        <Square size={13} />
                        Stop Tracking
                    </Button>
                )}
            </div>

            {/* ── Flight Controls ───────────────────────────────────────────── */}
            <div style={{ borderRadius: 8, border: '1px solid hsl(var(--app-border))' }}>
                <div style={{
                    padding: '7px 12px', background: 'hsl(var(--app-surface-2))',
                    borderBottom: '1px solid hsl(var(--app-border))',
                    fontSize: 10, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))',
                }}>
                    FLIGHT CONTROLS
                </div>

                <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>

                    {/* ── Distance ── */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <MoveVertical size={12} style={{ color: 'hsl(var(--app-text-muted))', transform: 'rotate(90deg)' }} />
                            <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>Distance</span>
                            <Tooltip>
                                <TooltipTrigger style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', padding: 0, cursor: 'help' }}>
                                    <Info size={10} style={{ color: 'hsl(var(--app-text-muted))' }} />
                                </TooltipTrigger>
                                <TooltipContent style={{ maxWidth: 240, fontSize: 11, lineHeight: 1.5 }}>
                                    Frame height = 100%. The drone moves forward or backward to keep the person filling {Math.round(distanceRatio * 100)}% of the frame.
                                    Drag the slider or press − / + to step. Each + press moves 6% closer.
                                </TooltipContent>
                            </Tooltip>
                            <span style={{ marginLeft: 'auto', fontSize: 10, fontFamily: 'monospace', color: '#4ade80' }}>
                                {distanceLabel(distanceRatio)} · {Math.round(distanceRatio * 100)}%
                            </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <button
                                onClick={handleFurther}
                                title="Step further"
                                style={{
                                    width: 28, height: 28, borderRadius: 6, flexShrink: 0,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    border: '1px solid hsl(var(--app-border))',
                                    background: 'hsl(var(--app-surface-2))',
                                    cursor: 'pointer', fontSize: 18, lineHeight: 1,
                                    color: 'hsl(var(--app-text))',
                                }}
                            >−</button>
                            <input
                                type="range"
                                min={DISTANCE_MIN * 100} max={DISTANCE_MAX * 100} step={1}
                                value={Math.round(distanceRatio * 100)}
                                onChange={e => handleDistanceChange(parseFloat(e.target.value) / 100)}
                                style={{ flex: 1, accentColor: '#4ade80', cursor: 'pointer' }}
                            />
                            <button
                                onClick={handleCloser}
                                title="Step closer"
                                style={{
                                    width: 28, height: 28, borderRadius: 6, flexShrink: 0,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    border: '1px solid hsl(var(--app-border))',
                                    background: 'hsl(var(--app-surface-2))',
                                    cursor: 'pointer', fontSize: 18, lineHeight: 1,
                                    color: 'hsl(var(--app-text))',
                                }}
                            >+</button>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 36px' }}>
                            <span style={{ fontSize: 9, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>Far</span>
                            <span style={{ fontSize: 9, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>Close</span>
                        </div>
                    </div>

                    <div style={{ height: 1, background: 'hsl(var(--app-border))', margin: '0 -12px' }} />

                    {/* ── Altitude ── */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <Mountain size={12} style={{ color: 'hsl(var(--app-text-muted))' }} />
                                <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>Altitude</span>
                                <Tooltip>
                                    <TooltipTrigger style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', padding: 0, cursor: 'help' }}>
                                        <Info size={10} style={{ color: 'hsl(var(--app-text-muted))' }} />
                                    </TooltipTrigger>
                                    <TooltipContent style={{ maxWidth: 220, fontSize: 11, lineHeight: 1.5 }}>
                                        Fixed: drone holds current altitude. Hold ▲/▼ to nudge up or down while tracking.
                                        Auto: altitude PD follows the person vertically (experimental).
                                    </TooltipContent>
                                </Tooltip>
                            </div>
                            <div style={{ display: 'flex', gap: 4 }}>
                                <PillToggle active={altitudeMode === 'fixed'} onClick={() => handleAltitudeMode('fixed')}>FIXED</PillToggle>
                                <PillToggle active={altitudeMode === 'auto'} onClick={() => handleAltitudeMode('auto')}>AUTO</PillToggle>
                            </div>
                        </div>
                        {altitudeMode === 'fixed' && (
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <button
                                    onPointerDown={() => { if (isTracking) getSocket().emit('set_altitude_nudge', { velocity: -0.4 }) }}
                                    onPointerUp={() => getSocket().emit('set_altitude_nudge', { velocity: 0 })}
                                    onPointerLeave={() => getSocket().emit('set_altitude_nudge', { velocity: 0 })}
                                    disabled={!isTracking}
                                    style={{
                                        flex: 1, padding: '5px 0', borderRadius: 6, fontSize: 10,
                                        fontFamily: 'monospace', fontWeight: 600,
                                        cursor: isTracking ? 'pointer' : 'not-allowed',
                                        border: '1px solid hsl(var(--app-border))',
                                        background: 'hsl(var(--app-surface-2))',
                                        color: 'hsl(var(--app-text))',
                                        opacity: isTracking ? 1 : 0.4,
                                        userSelect: 'none',
                                    }}
                                >▲ Up</button>
                                <span style={{
                                    flex: '1 1 0', fontSize: 9, fontFamily: 'monospace',
                                    color: 'hsl(var(--app-text-muted))', textAlign: 'center',
                                }}>
                                    {isTracking ? 'Hold to move' : 'Start tracking first'}
                                </span>
                                <button
                                    onPointerDown={() => { if (isTracking) getSocket().emit('set_altitude_nudge', { velocity: 0.4 }) }}
                                    onPointerUp={() => getSocket().emit('set_altitude_nudge', { velocity: 0 })}
                                    onPointerLeave={() => getSocket().emit('set_altitude_nudge', { velocity: 0 })}
                                    disabled={!isTracking}
                                    style={{
                                        flex: 1, padding: '5px 0', borderRadius: 6, fontSize: 10,
                                        fontFamily: 'monospace', fontWeight: 600,
                                        cursor: isTracking ? 'pointer' : 'not-allowed',
                                        border: '1px solid hsl(var(--app-border))',
                                        background: 'hsl(var(--app-surface-2))',
                                        color: 'hsl(var(--app-text))',
                                        opacity: isTracking ? 1 : 0.4,
                                        userSelect: 'none',
                                    }}
                                >▼ Down</button>
                            </div>
                        )}
                    </div>

                </div>
            </div>

            {/* Live command readout */}
            {isTracking && cmd && (
                <div style={{
                    padding: '10px 12px', borderRadius: 8,
                    background: 'hsl(var(--app-surface-2))',
                    border: '1px solid hsl(var(--app-border))',
                }}>
                    <div style={{ fontSize: 10, color: 'hsl(var(--app-text-muted))', fontFamily: 'monospace', marginBottom: 6 }}>
                        COMMAND OUTPUT
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontFamily: 'monospace', fontSize: 11 }}>
                        {Object.entries(cmd).filter(([k]) => k !== 'type').map(([k, v]) => (
                            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                <span style={{ color: 'hsl(var(--app-text-muted))' }}>{k}</span>
                                <span style={{ color: (v as number) !== 0 ? '#60a5fa' : 'hsl(var(--app-text-muted))', fontWeight: 500 }}>
                                    {v as number}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* PD Parameters — collapsible */}
            <div style={{
                borderRadius: 8, overflow: 'hidden',
                border: '1px solid hsl(var(--app-border))',
            }}>
                <button
                    onClick={() => setPdOpen(o => !o)}
                    style={{
                        width: '100%', display: 'flex', alignItems: 'center',
                        justifyContent: 'space-between', padding: '8px 12px',
                        background: 'hsl(var(--app-surface-2))',
                        border: 'none', cursor: 'pointer',
                        color: 'hsl(var(--app-text-muted))', fontSize: 10, fontFamily: 'monospace',
                        borderBottom: pdOpen ? '1px solid hsl(var(--app-border))' : 'none',
                    }}
                >
                    <span>PD CONTROLLER TUNING</span>
                    {pdOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>

                {pdOpen && (
                    <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {PD_PARAMS.map(p => (
                            <ParamSlider
                                key={p.key}
                                label={p.label}
                                value={pd[p.key]}
                                min={p.min} max={p.max} step={p.step}
                                unit={p.unit}
                                format={p.format}
                                tooltip={p.tooltip}
                                disabled={isTracking}
                                onChange={v => handlePdChange(p.key, v)}
                            />
                        ))}
                        {isTracking && (
                            <p style={{ fontSize: 10, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', margin: 0 }}>
                                Stop tracking to adjust parameters
                            </p>
                        )}
                        <button
                            onClick={() => { setPd(PD_DEFAULTS); emitPdParams(PD_DEFAULTS) }}
                            disabled={isTracking}
                            style={{
                                fontSize: 10, fontFamily: 'monospace', padding: '4px 8px',
                                borderRadius: 6, border: '1px solid hsl(var(--app-border))',
                                background: 'none', cursor: isTracking ? 'not-allowed' : 'pointer',
                                color: 'hsl(var(--app-text-muted))', opacity: isTracking ? 0.4 : 1,
                                alignSelf: 'flex-end',
                            }}
                        >
                            Reset to defaults
                        </button>
                    </div>
                )}
            </div>

            {/* Person list */}
            {!isTracking && persons.length > 0 && selectedId === null && (
                <div style={{
                    padding: '8px 12px', borderRadius: 8,
                    background: '#E6F1FB18', border: '1px solid #85B7EB',
                    fontSize: 11, fontFamily: 'monospace', color: '#60a5fa',
                }}>
                    ↓ Click a person to select them — IDs are stable across frames
                </div>
            )}

            {persons.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {persons.map((p: any) => {
                        const isSelected = p.id === selectedId
                        return (
                            <div
                                key={p.id}
                                onClick={() => handleSelectPerson(p.id)}
                                style={{
                                    display: 'flex', alignItems: 'center',
                                    justifyContent: 'space-between',
                                    padding: '10px 12px', borderRadius: 8,
                                    cursor: isTracking ? 'default' : 'pointer',
                                    background: isSelected
                                        ? (isTracking ? '#E1F5EE18' : '#E6F1FB18')
                                        : 'hsl(var(--app-surface-2))',
                                    border: `1px solid ${isSelected
                                        ? (isTracking ? '#5DCAA5' : '#85B7EB')
                                        : 'hsl(var(--app-border))'}`,
                                    transition: 'all 0.15s',
                                    opacity: isTracking && !isSelected ? 0.4 : 1,
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <span style={{ fontSize: 18 }}>
                                        {isTracking && isSelected ? '🎯' : isSelected ? '👆' : '🧍'}
                                    </span>
                                    <div>
                                        <div style={{
                                            fontSize: 12, fontWeight: 500, fontFamily: 'monospace',
                                            color: isSelected ? (isTracking ? '#5DCAA5' : '#60a5fa') : 'hsl(var(--app-text))',
                                        }}>
                                            Person #{p.id}
                                            {isSelected && !isTracking && (
                                                <span style={{ marginLeft: 8, fontSize: 10, color: '#60a5fa' }}>SELECTED</span>
                                            )}
                                            {isTracking && isSelected && (
                                                <span style={{ marginLeft: 8, fontSize: 10, color: '#5DCAA5' }}>TRACKING</span>
                                            )}
                                        </div>
                                        <div style={{ fontSize: 10, color: 'hsl(var(--app-text-muted))', marginTop: 1 }}>
                                            confidence: {(p.conf * 100).toFixed(0)}%
                                        </div>
                                    </div>
                                </div>
                                {isSelected && !isTracking && (
                                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#60a5fa' }} />
                                )}
                            </div>
                        )
                    })}
                </div>
            ) : (
                <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    height: 80, color: 'hsl(var(--app-text-muted))',
                    fontSize: 12, fontFamily: 'monospace',
                }}>
                    {cvResults ? 'No persons in frame' : 'Start stream to detect people'}
                </div>
            )}

        </div>
    )
}
