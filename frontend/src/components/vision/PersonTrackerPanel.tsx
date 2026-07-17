'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useDroneStore } from '@/store/drone'
import { getSocket } from '@/lib/socket'
import { getServerUrl } from '@/lib/server-url'
import {
    Users, Crosshair, Square, Timer, Info, ChevronDown, ChevronUp,
    Upload, CheckCircle, AlertCircle, Loader2, UserX, ScanFace,
    Mountain, MoveVertical,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const PD_DEFAULTS = { kp: 0.8, kd: 0.4, max_output: 300, deadband: 0.05 }

const PD_PARAMS = [
    {
        key: 'max_output' as const,
        label: 'Max Speed', min: 50, max: 500, step: 10, unit: '',
        format: (v: number) => v.toFixed(0),
        tooltip: 'Maximum drone speed while tracking.',
    },
    {
        key: 'kp' as const,
        label: 'Responsiveness', min: 0.1, max: 2.0, step: 0.05, unit: '',
        format: (v: number) => v.toFixed(2),
        tooltip: 'How strongly the drone reacts when the target moves off-centre (Kp). Higher = snappier but may oscillate.',
    },
    {
        key: 'kd' as const,
        label: 'Smoothing', min: 0.0, max: 0.8, step: 0.02, unit: '',
        format: (v: number) => v.toFixed(2),
        tooltip: 'Dampens sudden corrections (Kd). Should be ~half the Responsiveness value.',
    },
    {
        key: 'deadband' as const,
        label: 'Dead Zone', min: 0.01, max: 0.15, step: 0.01, unit: '',
        format: (v: number) => v.toFixed(2),
        tooltip: 'Minimum error before a correction is sent. Increase if the drone never fully settles.',
    },
]

type UploadState = 'idle' | 'uploading' | 'face_found' | 'no_face' | 'error'

function distanceLabel(ratio: number): string {
    if (ratio >= 0.50) return 'Very close'
    if (ratio >= 0.38) return 'Close'
    if (ratio >= 0.26) return 'Medium'
    if (ratio >= 0.18) return 'Far'
    return 'Very far'
}

function PillToggle({ active, onClick, children }: {
    active: boolean; onClick: () => void; children: React.ReactNode
}) {
    return (
        <button
            onClick={onClick}
            style={{
                padding: '3px 10px', borderRadius: 20, fontSize: 10,
                fontFamily: 'monospace', fontWeight: 600, cursor: 'pointer',
                border: active ? '1px solid #22d3ee' : '1px solid hsl(var(--app-border))',
                background: active ? '#22d3ee18' : 'hsl(var(--app-surface-2))',
                color: active ? '#22d3ee' : 'hsl(var(--app-text-muted))',
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
                type="range" min={min} max={max} step={step} value={value}
                disabled={disabled}
                onChange={e => onChange(parseFloat(e.target.value))}
                style={{
                    width: '100%', accentColor: '#22d3ee',
                    opacity: disabled ? 0.4 : 1, cursor: disabled ? 'not-allowed' : 'pointer',
                }}
            />
        </div>
    )
}

export function PersonTrackerPanel() {
    const cvResults = useDroneStore(s => s.cvResults)
    const session = useDroneStore(s => s.session)
    const sessionId = session?.session_id ?? null

    const [uploadState, setUploadState] = useState<UploadState>('idle')
    const [uploadError, setUploadError] = useState<string>('')
    const [faceThumbnail, setFaceThumbnail] = useState<string | null>(null)
    const [isTracking, setIsTracking] = useState(false)
    const [pdOpen, setPdOpen] = useState(false)
    const [pd, setPd] = useState(PD_DEFAULTS)

    // Flight control state
    const [altitudeMode, setAltitudeModeState] = useState<'fixed' | 'auto'>('fixed')
    const [distanceRatio, setDistanceRatioState] = useState(0.25)

    const fileInputRef = useRef<HTMLInputElement>(null)

    const persons = (cvResults as any)?.persons ?? []
    const personCount = (cvResults as any)?.person_count ?? 0
    const inferenceMs = cvResults?.analysis_time_ms ?? 0
    const targetId = (cvResults as any)?.target_id ?? null
    const similarity = (cvResults as any)?.similarity ?? 0
    const faceConfirmed = (cvResults as any)?.face_confirmed ?? false
    const searching = (cvResults as any)?.searching ?? false
    const cmd = (cvResults as any)?.drone_command

    // Sync tracking / clear state from server
    useEffect(() => {
        const socket = getSocket()
        socket.on('tracking_status', (d: { active: boolean }) => setIsTracking(d.active))
        socket.on('reference_cleared', () => {
            setUploadState('idle')
            setFaceThumbnail(null)
            setUploadError('')
            setIsTracking(false)
        })
        return () => {
            socket.off('tracking_status')
            socket.off('reference_cleared')
        }
    }, [])

    const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file || !sessionId) return

        setUploadState('uploading')
        setUploadError('')
        setFaceThumbnail(null)

        const secretToken = process.env.NEXT_PUBLIC_SECRET_TOKEN ?? ''
        const form = new FormData()
        form.append('file', file)

        try {
            const res = await fetch(
                `${getServerUrl()}/api/reference-photo?session_id=${encodeURIComponent(sessionId)}`,
                {
                    method: 'POST',
                    headers: { 'X-Auth-Token': secretToken },
                    body: form,
                }
            )
            const data = await res.json()

            if (res.status === 422) {
                setUploadState('no_face')
                setUploadError(data.detail ?? 'No face detected')
            } else if (!res.ok) {
                setUploadState('error')
                setUploadError(data.detail ?? `Server error ${res.status}`)
            } else {
                setFaceThumbnail(data.face_thumbnail)
                setUploadState('face_found')
            }
        } catch (err: any) {
            setUploadState('error')
            setUploadError(err.message ?? 'Network error')
        }

        // Reset file input so the same file can be re-uploaded
        if (fileInputRef.current) fileInputRef.current.value = ''
    }, [sessionId])

    const emitPdParams = useCallback((params: typeof PD_DEFAULTS) => {
        getSocket().emit('set_pd_params', params)
    }, [])

    const handlePdChange = (key: keyof typeof PD_DEFAULTS, value: number) => {
        const next = { ...pd, [key]: value }
        setPd(next)
        emitPdParams(next)
    }

    const handleStartTracking = () => {
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

    const handleReset = () => {
        // Stop tracking and clear on backend (resets embedding + target lock)
        getSocket().emit('clear_reference')
        // Local state cleared via 'reference_cleared' server ack,
        // but also clear immediately for instant feedback
        setUploadState('idle')
        setFaceThumbnail(null)
        setUploadError('')
        setIsTracking(false)
    }

    // ── Upload section ──────────────────────────────────────────────────────
    const uploadSection = () => {
        if (uploadState === 'uploading') {
            return (
                <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    gap: 8, padding: '14px 12px', borderRadius: 10,
                    background: 'hsl(var(--app-surface-2))',
                    border: '1px solid hsl(var(--app-border))',
                    fontSize: 12, fontFamily: 'monospace',
                    color: 'hsl(var(--app-text-muted))',
                }}>
                    <Loader2 size={14} className="animate-spin" />
                    Detecting face…
                </div>
            )
        }

        if (uploadState === 'face_found' && faceThumbnail) {
            return (
                <div style={{
                    borderRadius: 10, overflow: 'hidden',
                    border: '1px solid #22d3ee60',
                    background: '#22d3ee08',
                }}>
                    {/* Thumbnail + info row */}
                    <div style={{ display: 'flex', gap: 10, padding: '10px 12px', alignItems: 'center' }}>
                        <div style={{
                            width: 52, height: 52, borderRadius: 8, overflow: 'hidden',
                            border: '2px solid #22d3ee', flexShrink: 0,
                        }}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={faceThumbnail} alt="Reference face" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        </div>
                        <div style={{ flex: 1 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                                <CheckCircle size={12} style={{ color: '#22d3ee' }} />
                                <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#22d3ee' }}>
                                    Face registered
                                </span>
                            </div>
                            <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>
                                {isTracking
                                    ? faceConfirmed
                                        ? `Match confirmed — ${(similarity * 100).toFixed(0)}% similarity`
                                        : searching ? 'Searching for target…' : 'Waiting for face lock…'
                                    : 'Ready to track'}
                            </div>
                        </div>
                    </div>
                    {/* Re-upload link */}
                    <div style={{
                        borderTop: '1px solid hsl(var(--app-border))',
                        padding: '6px 12px', display: 'flex', justifyContent: 'space-between',
                        alignItems: 'center',
                    }}>
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={isTracking}
                            style={{
                                fontSize: 10, fontFamily: 'monospace', background: 'none',
                                border: 'none', cursor: isTracking ? 'not-allowed' : 'pointer',
                                color: 'hsl(var(--app-text-muted))', opacity: isTracking ? 0.4 : 1,
                                padding: 0, display: 'flex', alignItems: 'center', gap: 4,
                            }}
                        >
                            <Upload size={10} /> Upload different photo
                        </button>
                        <button
                            onClick={handleReset}
                            disabled={isTracking}
                            style={{
                                fontSize: 10, fontFamily: 'monospace', background: 'none',
                                border: 'none', cursor: isTracking ? 'not-allowed' : 'pointer',
                                color: '#f87171', opacity: isTracking ? 0.4 : 1,
                                padding: 0,
                            }}
                        >
                            Clear
                        </button>
                    </div>
                </div>
            )
        }

        if (uploadState === 'no_face' || uploadState === 'error') {
            return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{
                        display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px',
                        borderRadius: 10, background: '#f8717118',
                        border: '1px solid #f8717160',
                    }}>
                        {uploadState === 'no_face'
                            ? <UserX size={14} style={{ color: '#f87171', flexShrink: 0, marginTop: 1 }} />
                            : <AlertCircle size={14} style={{ color: '#f87171', flexShrink: 0, marginTop: 1 }} />}
                        <div>
                            <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#f87171', marginBottom: 2 }}>
                                {uploadState === 'no_face' ? 'No face detected' : 'Upload failed'}
                            </div>
                            <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>
                                {uploadError || 'Use a clear front-facing photo'}
                            </div>
                        </div>
                    </div>
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                            padding: '8px 12px', borderRadius: 8,
                            background: 'hsl(var(--app-surface-2))',
                            border: '1px dashed hsl(var(--app-border))',
                            cursor: 'pointer', fontSize: 11, fontFamily: 'monospace',
                            color: 'hsl(var(--app-text-muted))',
                        }}
                    >
                        <Upload size={12} /> Try again
                    </button>
                </div>
            )
        }

        // idle
        return (
            <button
                onClick={() => fileInputRef.current?.click()}
                style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                    justifyContent: 'center', gap: 6, padding: '16px 12px',
                    borderRadius: 10, width: '100%',
                    background: 'hsl(var(--app-surface-2))',
                    border: '2px dashed hsl(var(--app-border))',
                    cursor: 'pointer', transition: 'border-color 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = '#22d3ee60')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'hsl(var(--app-border))')}
            >
                <ScanFace size={24} style={{ color: '#22d3ee', opacity: 0.7 }} />
                <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text))' }}>
                    Upload reference photo
                </span>
                <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>
                    JPEG or PNG — clear front-facing face
                </span>
            </button>
        )
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* Hidden file input */}
            <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                style={{ display: 'none' }}
                onChange={handleFileSelect}
            />

            {/* Stats bar */}
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
                    <Users size={12} /> {personCount} in frame
                </div>
                {isTracking && (
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px',
                        background: faceConfirmed ? '#22d3ee18' : '#E6F1FB18',
                        border: `1px solid ${faceConfirmed ? '#22d3ee' : '#85B7EB'}`,
                        borderRadius: 8, fontSize: 11, fontFamily: 'monospace',
                        color: faceConfirmed ? '#22d3ee' : '#60a5fa',
                    }}>
                        <Crosshair size={12} />
                        {faceConfirmed ? `LOCKED #${targetId}` : 'SCANNING'}
                    </div>
                )}
            </div>

            {/* Photo upload section */}
            {uploadSection()}

            {/* Track / Stop */}
            <div style={{ display: 'flex', gap: 8 }}>
                {!isTracking ? (
                    <Button
                        size="sm"
                        className="flex-1 gap-2 font-mono text-xs"
                        disabled={uploadState !== 'face_found'}
                        onClick={handleStartTracking}
                        style={{
                            background: uploadState === 'face_found' ? '#0e6b6b' : undefined,
                            opacity: uploadState !== 'face_found' ? 0.5 : 1,
                        }}
                    >
                        <Crosshair size={13} />
                        {uploadState === 'face_found' ? 'Start Tracking' : 'Upload photo first'}
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

            {/* ── Flight Controls ─────────────────────────────────────────── */}
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
                                    Frame height = 100%. The drone moves forward or backward to keep the target filling {Math.round(distanceRatio * 100)}% of the frame.
                                    Drag the slider or press − / + to step. Each + press moves 6% closer.
                                </TooltipContent>
                            </Tooltip>
                            <span style={{ marginLeft: 'auto', fontSize: 10, fontFamily: 'monospace', color: '#22d3ee' }}>
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
                                style={{ flex: 1, accentColor: '#22d3ee', cursor: 'pointer' }}
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
                                        Auto: altitude PD follows the target vertically (experimental).
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

            {/* Live similarity badge */}
            {isTracking && faceConfirmed && similarity > 0 && (
                <div style={{
                    padding: '8px 12px', borderRadius: 8,
                    background: '#22d3ee10', border: '1px solid #22d3ee40',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                    <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>
                        Face similarity
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {/* Mini bar */}
                        <div style={{
                            width: 60, height: 4, borderRadius: 2,
                            background: 'hsl(var(--app-border))', overflow: 'hidden',
                        }}>
                            <div style={{
                                height: '100%', borderRadius: 2,
                                width: `${Math.min(100, similarity * 100 / 0.7)}%`,
                                background: similarity >= 0.55 ? '#22d3ee' : '#f59e0b',
                                transition: 'width 0.3s',
                            }} />
                        </div>
                        <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#22d3ee', fontWeight: 500 }}>
                            {(similarity * 100).toFixed(0)}%
                        </span>
                    </div>
                </div>
            )}

            {/* Live PD command */}
            {isTracking && cmd && (
                <div style={{
                    padding: '10px 12px', borderRadius: 8,
                    background: 'hsl(var(--app-surface-2))',
                    border: '1px solid hsl(var(--app-border))',
                }}>
                    <div style={{ fontSize: 10, color: 'hsl(var(--app-text-muted))', fontFamily: 'monospace', marginBottom: 6 }}>
                        PD COMMAND OUTPUT
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontFamily: 'monospace', fontSize: 11 }}>
                        {Object.entries(cmd).filter(([k]) => k !== 'type').map(([k, v]) => (
                            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                <span style={{ color: 'hsl(var(--app-text-muted))' }}>{k}</span>
                                <span style={{ color: (v as number) !== 0 ? '#22d3ee' : 'hsl(var(--app-text-muted))', fontWeight: 500 }}>
                                    {v as number}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* PD tuning — collapsible */}
            <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid hsl(var(--app-border))' }}>
                <button
                    onClick={() => setPdOpen(o => !o)}
                    style={{
                        width: '100%', display: 'flex', alignItems: 'center',
                        justifyContent: 'space-between', padding: '8px 12px',
                        background: 'hsl(var(--app-surface-2))', border: 'none', cursor: 'pointer',
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
                                label={p.label} value={pd[p.key]}
                                min={p.min} max={p.max} step={p.step}
                                unit={p.unit} format={p.format} tooltip={p.tooltip}
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

        </div>
    )
}
