'use client'

import { useState, useEffect, useCallback } from 'react'
import { useDroneStore } from '@/store/drone'
import { useStableById } from '@/lib/panelSmoothing'
import { getSocket } from '@/lib/socket'
import {
    Crosshair, Square, Info, User,
    ChevronDown, ChevronUp, Mountain, MoveVertical,
} from 'lucide-react'
import {
    TONE, LABEL, READOUT, UNIT, SECONDARY, NUM, TILE, TEXT, MUTED, SUBTLE,
    BORDER, BORDER_STRONG, SURFACE, SURFACE_2, chip, btn, DISABLED, FOCUS,
} from './panelStyle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fetchFollowTuning } from '@/lib/calibration'

// Default PD values - kept in sync with backend defaults (human_tracker.py
// _make_state: yaw_pd kp=30/kd=4/max_output=55). These are yaw-axis units
// (deg/s output), not the 0-2 range this used to show - that mismatch meant
// touching any slider sent values 15-300x weaker than the real default and
// silently crushed tracking responsiveness.
const PD_DEFAULTS = { kp: 30.0, kd: 4.0, max_output: 55, deadband: 0.05 }

const PD_PARAMS = [
    {
        key: 'max_output' as const,
        label: 'Max turn speed',
        min: 15, max: 55, step: 1,
        unit: '',
        format: (v: number) => v.toFixed(0),
        tooltip: 'Maximum yaw rate (deg/s) while tracking. Backend hard-caps this at 55 to stay under the flight controller\'s auto-yaw rate limit. Higher = catches fast-moving subjects, but can overshoot and oscillate.',
    },
    {
        key: 'kp' as const,
        label: 'Responsiveness',
        min: 10, max: 50, step: 1,
        unit: '',
        format: (v: number) => v.toFixed(0),
        tooltip: 'How strongly the drone reacts when the subject moves off-centre (proportional gain Kp). Higher = snappier tracking. Too high causes oscillation - the drone will overshoot and correct repeatedly.',
    },
    {
        key: 'kd' as const,
        label: 'Smoothing',
        min: 0, max: 10, step: 0.2,
        unit: '',
        format: (v: number) => v.toFixed(1),
        tooltip: 'Dampens sudden corrections to avoid oscillation (derivative gain Kd). Higher = smoother but slower to catch up. Should be around 1/7th of the Responsiveness value.',
    },
    {
        key: 'deadband' as const,
        label: 'Dead zone',
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

function InfoTip({ children, width = 240 }: { children: React.ReactNode; width?: number }) {
    return (
        <Tooltip>
            <TooltipTrigger className={FOCUS} aria-label="More info"
                style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', padding: 2, borderRadius: 6, cursor: 'help' }}>
                <Info size={13} style={{ color: MUTED }} aria-hidden />
            </TooltipTrigger>
            <TooltipContent style={{ maxWidth: width, fontSize: 13, lineHeight: 1.45 }}>
                {children}
            </TooltipContent>
        </Tooltip>
    )
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 13, color: disabled ? SUBTLE : MUTED }}>
                        {label}
                    </span>
                    <InfoTip width={220}>{tooltip}</InfoTip>
                </div>
                <span style={{ fontSize: 13, fontWeight: 700, color: disabled ? SUBTLE : TEXT, ...NUM }}>
                    {format(value)}{unit}
                </span>
            </div>
            <input
                className={FOCUS}
                type="range"
                min={min} max={max} step={step}
                value={value}
                disabled={disabled}
                title={disabled ? 'Stop tracking to adjust' : undefined}
                aria-label={label}
                onChange={e => onChange(parseFloat(e.target.value))}
                style={{
                    width: '100%', minHeight: 24,
                    accentColor: disabled ? 'hsl(var(--app-border-strong))' : 'var(--app-accent)',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                }}
            />
        </div>
    )
}

// ── Segmented toggle button ───────────────────────────────────────────────────
function PillToggle({ active, onClick, children }: {
    active: boolean; onClick: () => void; children: React.ReactNode
}) {
    return (
        <button
            className={FOCUS}
            onClick={onClick}
            aria-pressed={active}
            style={{
                minHeight: 28, padding: '0 10px', borderRadius: 6, fontSize: 13,
                fontWeight: 600, cursor: 'pointer',
                border: `1px solid ${active ? TONE.accent.fg : BORDER_STRONG}`,
                background: active ? TONE.accent.bg : SURFACE_2,
                color: active ? TONE.accent.fg : MUTED,
                transition: 'color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out)',
            }}
        >
            {children}
        </button>
    )
}

const stepBtn: React.CSSProperties = {
    width: 32, height: 32, borderRadius: 6, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: `1px solid ${BORDER_STRONG}`,
    background: SURFACE_2,
    cursor: 'pointer', fontSize: 18, fontWeight: 700, lineHeight: 1,
    color: TEXT,
}

function nudgeBtn(on: boolean): React.CSSProperties {
    return on
        ? {
            flex: 1, minHeight: 32, borderRadius: 6, fontSize: 13, fontWeight: 700,
            cursor: 'pointer', userSelect: 'none',
            border: `1px solid ${TONE.warn.border}`, background: TONE.warn.bg, color: TONE.warn.fg,
        }
        : { flex: 1, minHeight: 32, borderRadius: 6, fontSize: 13, fontWeight: 600, userSelect: 'none', ...DISABLED }
}

const DISTANCE_STEP = 0.06
const DISTANCE_MIN  = 0.10
const DISTANCE_MAX  = 0.60

export function HumanTrackingPanel() {
    const cvResults = useDroneStore(s => s.cvResults)
    // Selection and tracking are the SERVER's state, read back from
    // cv_results (selected_id / tracking) the way CrowdManagementPanel does.
    // Local copies went stale: a click on the video (CvOverlayCanvas emits
    // select_person) never enabled Track here, and a remount of this panel
    // showed "not tracking" while the backend was still flying the follow.
    const selectedId: number | null = (cvResults as { selected_id?: number | null } | null)?.selected_id ?? null
    const isTracking: boolean = Boolean((cvResults as { tracking?: boolean } | null)?.tracking)
    const [pdOpen, setPdOpen] = useState(false)
    const [pd, setPd] = useState(PD_DEFAULTS)
    // What Settings -> AI Modules -> FOLLOW TUNING holds. The sliders below
    // emit all four gains at once, so showing hardcoded defaults while the
    // session had actually started from the operator's saved numbers would
    // silently revert them the moment any one slider moved.
    const [savedPd, setSavedPd] = useState(PD_DEFAULTS)

    // Flight control state
    const [altitudeMode, setAltitudeModeState] = useState<'fixed' | 'auto'>('fixed')
    const [distanceRatio, setDistanceRatioState] = useState(0.25)

    // Held briefly past their last sighting so the selectable list does not
    // reflow under the operator's cursor every time the detector blinks.
    const persons = useStableById(cvResults?.persons)


    // Seeded, not pushed: the backend session already built its yaw PD from
    // these same values, so emitting them here would be a no-op round trip.
    useEffect(() => {
        let live = true
        fetchFollowTuning().then(t => {
            if (live && t) { setPd(t); setSavedPd(t) }
        })
        return () => { live = false }
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
        getSocket().emit('select_person', { person_id: id })
    }

    const handleStartTracking = () => {
        if (selectedId === null) return
        getSocket().emit('set_tracking', { active: true })
    }

    const handleStopTracking = () => {
        getSocket().emit('set_tracking', { active: false })
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

    const cmd = cvResults?.drone_command

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* Stats */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <span style={READOUT}>{persons.length}</span>
                    <span style={{ ...UNIT, marginLeft: 0 }}>{persons.length === 1 ? 'person' : 'people'}</span>
                </div>
                {isTracking && (
                    <span style={{ ...chip('warn'), marginLeft: 'auto' }}>
                        <Crosshair size={13} aria-hidden /> Following #{selectedId}
                    </span>
                )}
            </div>

            {/* Track / Stop: amber, it moves the drone */}
            <div style={{ display: 'flex', gap: 8 }}>
                {!isTracking ? (
                    <button
                        type="button"
                        className={FOCUS}
                        disabled={selectedId === null}
                        onClick={handleStartTracking}
                        title={selectedId === null ? 'Pick a person below or on the video first' : 'Fly after this person'}
                        style={{
                            ...btn('warn'), flex: 1, fontWeight: 700,
                            ...(selectedId === null ? DISABLED : {}),
                        }}
                    >
                        <Crosshair size={14} aria-hidden />
                        {selectedId !== null ? `Follow person #${selectedId}` : 'Select a person first'}
                    </button>
                ) : (
                    <button
                        type="button"
                        className={FOCUS}
                        onClick={handleStopTracking}
                        style={{ ...btn('danger'), flex: 1, fontWeight: 700, background: TONE.danger.bg }}
                    >
                        <Square size={14} aria-hidden />
                        Stop following
                    </button>
                )}
            </div>

            {/* ── Flight Controls ───────────────────────────────────────────── */}
            <div style={{ borderRadius: 10, border: `1px solid ${BORDER}`, overflow: 'hidden' }}>
                <div style={{
                    padding: '8px 12px', background: SURFACE_2,
                    borderBottom: `1px solid ${BORDER}`, ...LABEL,
                }}>
                    Flight controls
                </div>

                <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: 12 }}>

                    {/* ── Distance ── */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <MoveVertical size={13} style={{ color: MUTED, transform: 'rotate(90deg)' }} aria-hidden />
                            <span style={{ fontSize: 13, color: MUTED }}>Distance</span>
                            <InfoTip>
                                The drone moves in or back so the person fills {Math.round(distanceRatio * 100)}% of the frame height. Each + is 6% closer.
                            </InfoTip>
                            <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 700, color: TEXT, ...NUM }}>
                                {distanceLabel(distanceRatio)} ({Math.round(distanceRatio * 100)}%)
                            </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <button className={FOCUS} onClick={handleFurther} title="Step further" aria-label="Step further" style={stepBtn}>−</button>
                            <input
                                className={FOCUS}
                                type="range"
                                min={DISTANCE_MIN * 100} max={DISTANCE_MAX * 100} step={1}
                                value={Math.round(distanceRatio * 100)}
                                onChange={e => handleDistanceChange(parseFloat(e.target.value) / 100)}
                                aria-label="Follow distance"
                                style={{ flex: 1, minHeight: 24, accentColor: 'var(--app-accent)', cursor: 'pointer' }}
                            />
                            <button className={FOCUS} onClick={handleCloser} title="Step closer" aria-label="Step closer" style={stepBtn}>+</button>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 40px', fontSize: 12, color: MUTED }}>
                            <span>Far</span>
                            <span>Close</span>
                        </div>
                    </div>

                    <div style={{ height: 1, background: BORDER, margin: '0 -12px' }} />

                    {/* ── Altitude ── */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <Mountain size={13} style={{ color: MUTED }} aria-hidden />
                                <span style={{ fontSize: 13, color: MUTED }}>Altitude</span>
                                <InfoTip width={220}>
                                    Fixed: holds the current height; hold Up or Down to nudge. Auto: follows the person up and down (experimental).
                                </InfoTip>
                            </div>
                            <div style={{ display: 'flex', gap: 4 }}>
                                <PillToggle active={altitudeMode === 'fixed'} onClick={() => handleAltitudeMode('fixed')}>Fixed</PillToggle>
                                <PillToggle active={altitudeMode === 'auto'} onClick={() => handleAltitudeMode('auto')}>Auto</PillToggle>
                            </div>
                        </div>
                        {altitudeMode === 'fixed' && (
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <button
                                    className={FOCUS}
                                    onPointerDown={() => { if (isTracking) getSocket().emit('set_altitude_nudge', { velocity: -0.4 }) }}
                                    onPointerUp={() => getSocket().emit('set_altitude_nudge', { velocity: 0 })}
                                    onPointerLeave={() => getSocket().emit('set_altitude_nudge', { velocity: 0 })}
                                    disabled={!isTracking}
                                    title={isTracking ? 'Hold to climb' : 'Start following first'}
                                    style={nudgeBtn(isTracking)}
                                >▲ Up</button>
                                <span style={{ flex: '1 1 0', fontSize: 13, color: MUTED, textAlign: 'center' }}>
                                    {isTracking ? 'Hold to move' : 'Follow first'}
                                </span>
                                <button
                                    className={FOCUS}
                                    onPointerDown={() => { if (isTracking) getSocket().emit('set_altitude_nudge', { velocity: 0.4 }) }}
                                    onPointerUp={() => getSocket().emit('set_altitude_nudge', { velocity: 0 })}
                                    onPointerLeave={() => getSocket().emit('set_altitude_nudge', { velocity: 0 })}
                                    disabled={!isTracking}
                                    title={isTracking ? 'Hold to descend' : 'Start following first'}
                                    style={nudgeBtn(isTracking)}
                                >▼ Down</button>
                            </div>
                        )}
                    </div>

                </div>
            </div>

            {/* Live command readout */}
            {isTracking && cmd && (
                <div style={{ padding: '10px 12px', ...TILE }}>
                    <div style={{ ...LABEL, marginBottom: 6 }}>
                        Command output
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 13, ...NUM }}>
                        {Object.entries(cmd).filter(([k]) => k !== 'type').map(([k, v]) => (
                            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                <span className="font-code" style={{ color: MUTED, fontSize: 12 }}>{k}</span>
                                <span style={{ color: (v as number) !== 0 ? TONE.accent.fg : MUTED, fontWeight: 700 }}>
                                    {v as number}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* PD Parameters - collapsible */}
            <div style={{ borderRadius: 10, overflow: 'hidden', border: `1px solid ${BORDER}` }}>
                <button
                    className={FOCUS}
                    onClick={() => setPdOpen(o => !o)}
                    aria-expanded={pdOpen}
                    style={{
                        width: '100%', display: 'flex', alignItems: 'center',
                        justifyContent: 'space-between', minHeight: 36, padding: '0 12px',
                        background: SURFACE_2,
                        border: 'none', cursor: 'pointer', ...LABEL,
                        borderBottom: pdOpen ? `1px solid ${BORDER}` : 'none',
                    }}
                >
                    <span>Follow tuning</span>
                    {pdOpen ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
                </button>

                {pdOpen && (
                    <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
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
                            <p style={{ ...SECONDARY, margin: 0 }}>
                                Stop following to adjust these.
                            </p>
                        )}
                        <button
                            className={FOCUS}
                            onClick={() => { setPd(savedPd); emitPdParams(savedPd) }}
                            disabled={isTracking}
                            title={isTracking ? 'Stop following to reset' : 'Back to the values saved in Settings'}
                            style={{ ...btn(), alignSelf: 'flex-end', ...(isTracking ? DISABLED : {}) }}
                        >
                            Reset to saved
                        </button>
                    </div>
                )}
            </div>

            {/* Person list */}
            {!isTracking && persons.length > 0 && selectedId === null && (
                <div style={{
                    padding: '8px 12px', borderRadius: 10,
                    background: TONE.accent.bg, border: `1px solid ${TONE.accent.border}`,
                    fontSize: 13, color: TEXT,
                }}>
                    Pick a person below or tap one on the video.
                </div>
            )}

            {persons.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {persons.map((p) => {
                        const isSelected = p.id === selectedId
                        const t = isTracking ? TONE.warn : TONE.accent
                        return (
                            <button
                                type="button"
                                key={p.id}
                                className={FOCUS}
                                onClick={() => handleSelectPerson(p.id)}
                                aria-pressed={isSelected}
                                aria-disabled={isTracking || undefined}
                                title={isTracking && !isSelected ? 'Stop following to pick someone else' : undefined}
                                style={{
                                    display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left',
                                    justifyContent: 'space-between', gap: 10,
                                    padding: '10px 12px', borderRadius: 10,
                                    cursor: isTracking ? 'default' : 'pointer',
                                    background: isSelected ? t.bg : SURFACE_2,
                                    border: `1px solid ${isSelected ? t.fg : BORDER}`,
                                    color: TEXT,
                                    transition: 'opacity var(--dur) var(--ease-out), background-color var(--dur-fast) var(--ease-out)',
                                    // Dimmed when held past its last sighting,
                                    // so a row that is about to age out reads
                                    // as fading rather than vanishing.
                                    opacity: isTracking && !isSelected ? 0.6 : p.stale ? 0.6 : 1,
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                                    <span style={{
                                        width: 32, height: 32, borderRadius: 6, flexShrink: 0,
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        background: isSelected ? t.bg : SURFACE, color: isSelected ? t.fg : MUTED,
                                        border: `1px solid ${isSelected ? t.border : BORDER}`,
                                    }} aria-hidden>
                                        {isSelected ? <Crosshair size={16} /> : <User size={16} />}
                                    </span>
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ fontSize: 14, fontWeight: 700, color: TEXT, ...NUM }}>
                                            Person #{p.id}
                                        </div>
                                        <div style={{ ...SECONDARY, ...NUM }}>
                                            {(p.conf * 100).toFixed(0)}% sure
                                        </div>
                                    </div>
                                </div>
                                {isSelected && (
                                    <span style={chip(isTracking ? 'warn' : 'accent')}>
                                        {isTracking ? 'Following' : 'Selected'}
                                    </span>
                                )}
                            </button>
                        )
                    })}
                </div>
            ) : (
                <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    height: 80, ...SECONDARY,
                }}>
                    {cvResults ? 'No one in frame' : 'Start the video to find people'}
                </div>
            )}

        </div>
    )
}
