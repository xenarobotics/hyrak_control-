'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useDroneStore } from '@/store/drone'
import { getSocket } from '@/lib/socket'
import { getServerUrl } from '@/lib/server-url'
import {
    Users, Crosshair, Square, Info, ChevronDown, ChevronUp,
    Upload, CheckCircle, AlertCircle, Loader2, UserX, ScanFace,
    Mountain, MoveVertical, UserPlus,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FaceGalleryPanel } from './FaceGalleryPanel'
import { fetchFollowTuning } from '@/lib/calibration'

// Kept in sync with backend defaults (person_tracker.py _make_state: yaw_pd
// kp=30/kd=4/max_output=55) - yaw-axis units (deg/s output). A prior 0-2
// range here meant any slider touch sent values 15-300x weaker than the
// real default and silently crushed tracking responsiveness.
const PD_DEFAULTS = { kp: 30.0, kd: 4.0, max_output: 55, deadband: 0.05 }

const PD_PARAMS = [
    {
        key: 'max_output' as const,
        label: 'Max Speed', min: 15, max: 55, step: 1, unit: '',
        format: (v: number) => v.toFixed(0),
        tooltip: 'Maximum yaw rate (deg/s) while tracking. Backend hard-caps this at 55 to stay under the flight controller\'s auto-yaw rate limit.',
    },
    {
        key: 'kp' as const,
        label: 'Responsiveness', min: 10, max: 50, step: 1, unit: '',
        format: (v: number) => v.toFixed(0),
        tooltip: 'How strongly the drone reacts when the target moves off-centre (Kp). Higher = snappier but may oscillate.',
    },
    {
        key: 'kd' as const,
        label: 'Smoothing', min: 0, max: 10, step: 0.2, unit: '',
        format: (v: number) => v.toFixed(1),
        tooltip: 'Dampens sudden corrections (Kd). Should be ~1/7th of the Responsiveness value.',
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
    // What Settings -> AI Modules -> FOLLOW TUNING holds. The sliders below
    // emit all four gains at once, so showing hardcoded defaults while the
    // session had actually started from the operator's saved numbers would
    // silently revert them the moment any one slider moved.
    const [savedPd, setSavedPd] = useState(PD_DEFAULTS)

    // Flight control state
    const [altitudeMode, setAltitudeModeState] = useState<'fixed' | 'auto'>('fixed')
    const [distanceRatio, setDistanceRatioState] = useState(0.25)

    const fileInputRef = useRef<HTMLInputElement>(null)

    const persons = (cvResults as any)?.persons ?? []
    const personCount = (cvResults as any)?.person_count ?? 0
    const targetId = (cvResults as any)?.target_id ?? null
    const similarity = (cvResults as any)?.similarity ?? 0
    const faceConfirmed = (cvResults as any)?.face_confirmed ?? false
    const searching = (cvResults as any)?.searching ?? false
    const cmd = (cvResults as any)?.drone_command
    // Gallery mode + pursuit state, from the backend's meta.
    const personName = (cvResults as any)?.person_name ?? null
    const personId = (cvResults as any)?.person_id ?? null
    const galleryMargin = (cvResults as any)?.gallery_margin ?? null
    // EVERY identified person in frame, not only the followed one.
    const identities = (cvResults as any)?.identities ?? []
    const lockManual = (cvResults as any)?.lock_manual ?? false
    const lockState = (cvResults as any)?.lock_state ?? 'idle'
    const lockMessage = (cvResults as any)?.lock_message ?? ''
    const elevate = (cvResults as any)?.elevate ?? null
    const capture = (cvResults as any)?.capture ?? null

    // Tracking used to be gated on an uploaded reference photo alone, which
    // meant tapping somebody on the video could never actually start a
    // follow - the button stayed disabled saying "upload photo first". There
    // are three legitimate ways to have a target now, and any of them should
    // arm it: an uploaded photo, a face matched from the database, or the
    // operator simply pointing at someone.
    const canTrack = uploadState === 'face_found'
        || targetId !== null
        || identities.length > 0

    // ── Enrol from the live feed ─────────────────────────────────────────
    // The gallery then holds this camera, this lens, this angle and this
    // light - which is what the recogniser is actually asked to match later.
    // An uploaded photo is a different imaging problem and matches less well.
    const [enrolName, setEnrolName] = useState('')
    const [enrolMsg, setEnrolMsg] = useState<string | null>(null)
    const unknownInFrame = persons.filter(
        (p: { id: number }) => !identities.some((i: { track_id: number }) => i.track_id === p.id),
    )
    const enrolTarget = targetId ?? unknownInFrame[0]?.id ?? persons[0]?.id ?? null
    const startEnrol = () => {
        if (!enrolName.trim() || enrolTarget == null) return
        getSocket().emit('enrol_person_live', { track_id: enrolTarget, name: enrolName.trim() })
    }

    // Sync tracking / clear state from server

    // Seeded, not pushed: the backend session already built its yaw PD from
    // these same values, so emitting them here would be a no-op round trip.
    useEffect(() => {
        let live = true
        fetchFollowTuning().then(t => {
            if (live && t) { setPd(t); setSavedPd(t) }
        })
        return () => { live = false }
    }, [])

    useEffect(() => {
        const socket = getSocket()
        socket.on('tracking_status', (d: { active: boolean }) => setIsTracking(d.active))
        socket.on('enrolment_started', (d: { ok: boolean; msg?: string }) => {
            setEnrolMsg(d.msg ?? null)
            if (d.ok) setEnrolName('')
        })
        socket.on('reference_cleared', () => {
            setUploadState('idle')
            setFaceThumbnail(null)
            setUploadError('')
            setIsTracking(false)
        })
        return () => {
            socket.off('tracking_status')
            socket.off('enrolment_started')
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
                                        ? `Match confirmed - ${(similarity * 100).toFixed(0)}% similarity`
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
                    JPEG or PNG - clear front-facing face
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

            {/* ── Lock state ──────────────────────────────────────────────
                COASTING vs SEARCHING is the distinction that matters: the
                first means the drone still believes it knows where the target
                is, the second means it is guessing. A single "tracking" light
                hides that, and an operator who cannot tell them apart cannot
                judge whether to take over. */}
            {lockState !== 'idle' && lockState !== 'locked' && (
                <div style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 10px', borderRadius: 8, fontSize: 11,
                    background: lockState === 'lost' ? 'rgba(248,113,113,0.12)'
                              : lockState === 'coasting' ? 'rgba(251,191,36,0.10)'
                              : 'rgba(251,191,36,0.16)',
                    border: `1px solid ${lockState === 'lost' ? 'rgba(248,113,113,0.4)' : 'rgba(251,191,36,0.4)'}`,
                    color: lockState === 'lost' ? '#f87171' : '#fbbf24',
                }}>
                    <span style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                        {lockState}
                    </span>
                    <span style={{ fontFamily: 'monospace', opacity: 0.85 }}>{lockMessage}</span>
                </div>
            )}

            {/* ── Auto-elevate ────────────────────────────────────────────
                Shown whenever it fires OR is blocked. A climb the pilot
                cannot explain is a climb they will fight, and being blocked by
                the legal ceiling is different from being blocked because the
                view has become too steep to recognise anything. */}
            {elevate && (elevate.elevating || elevate.blocked_by) && (
                <div style={{
                    display: 'flex', alignItems: 'flex-start', gap: 8,
                    padding: '6px 10px', borderRadius: 8, fontSize: 11, lineHeight: 1.5,
                    background: elevate.elevating ? 'rgba(34,211,238,0.12)' : 'rgba(248,113,113,0.10)',
                    border: `1px solid ${elevate.elevating ? 'rgba(34,211,238,0.4)' : 'rgba(248,113,113,0.35)'}`,
                    color: elevate.elevating ? '#22d3ee' : '#f87171',
                }}>
                    <MoveVertical size={13} style={{ marginTop: 1, flexShrink: 0 }} />
                    <span>
                        <b>{elevate.elevating ? 'Auto-elevating' : 'Cannot climb'}</b>
                        {' - '}{elevate.reason}
                    </span>
                </div>
            )}

            {/* Stats bar */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
            {/* ── Enrol from the live feed ────────────────────────────
                Faster and more accurate than uploading a photo: the gallery
                ends up holding this camera, lens, angle and lighting, which
                is what the recogniser is later asked to match. Several shots
                across ~2s, not one - a single pose matches that pose and
                little else, and pose variation is the main way recognition
                fails at drone standoff. */}
            {capture ? (
                <div style={{
                    display: 'flex', flexDirection: 'column', gap: 5,
                    padding: '9px 10px', borderRadius: 10,
                    background: 'rgba(56,160,255,0.10)',
                    border: '1px solid rgba(56,160,255,0.35)',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 }}>
                        <UserPlus size={13} style={{ color: '#38a0ff' }} />
                        <span style={{ fontWeight: 700, color: '#38a0ff' }}>
                            Enrolling {capture.name}
                        </span>
                        <span style={{ marginLeft: 'auto', fontSize: 11, fontFamily: 'monospace', color: '#38a0ff' }}>
                            {capture.shots}/{capture.needed}
                        </span>
                    </div>
                    <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.10)' }}>
                        <div style={{
                            width: `${(capture.shots / capture.needed) * 100}%`, height: '100%',
                            borderRadius: 2, background: '#38a0ff', transition: 'width .2s',
                        }} />
                    </div>
                    <div style={{ fontSize: 9.5, color: 'hsl(var(--app-text-muted))', lineHeight: 1.4 }}>
                        Keep them in frame. Shots are spread over a couple of seconds so
                        the gallery gets more than one pose.
                    </div>
                    <button
                        onClick={() => getSocket().emit('enrol_person_live', { cancel: true })}
                        style={{
                            padding: '4px 0', borderRadius: 6, fontSize: 10, cursor: 'pointer',
                            border: '1px solid hsl(var(--app-border))', background: 'transparent',
                            color: 'hsl(var(--app-text-muted))',
                        }}
                    >Cancel</button>
                </div>
            ) : personCount > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: 6, fontSize: 10,
                        textTransform: 'uppercase', letterSpacing: 0.6,
                        color: 'hsl(var(--app-text-muted))',
                    }}>
                        <UserPlus size={11} />
                        Add to database
                        {enrolTarget != null && (
                            <span style={{ marginLeft: 'auto', textTransform: 'none', fontFamily: 'monospace' }}>
                                #{enrolTarget}{targetId === enrolTarget ? ' (followed)' : ''}
                            </span>
                        )}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                        <input
                            value={enrolName}
                            onChange={e => setEnrolName(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') startEnrol() }}
                            placeholder={enrolTarget != null ? `Name for #${enrolTarget}` : 'No one in frame'}
                            disabled={enrolTarget == null}
                            style={{
                                flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 7,
                                fontSize: 12, border: '1px solid hsl(var(--app-border))',
                                background: 'hsl(var(--app-surface-2))', color: 'hsl(var(--app-text))',
                            }}
                        />
                        <button
                            onClick={startEnrol}
                            disabled={!enrolName.trim() || enrolTarget == null}
                            style={{
                                padding: '6px 12px', borderRadius: 7, fontSize: 11, fontWeight: 600,
                                cursor: enrolName.trim() && enrolTarget != null ? 'pointer' : 'not-allowed',
                                border: '1px solid #38a0ff',
                                background: enrolName.trim() && enrolTarget != null
                                    ? 'rgba(56,160,255,0.15)' : 'transparent',
                                color: enrolName.trim() && enrolTarget != null
                                    ? '#38a0ff' : 'hsl(var(--app-text-muted))',
                            }}
                        >Capture</button>
                    </div>
                    <div style={{ fontSize: 9.5, color: 'hsl(var(--app-text-muted))' }}>
                        Tap someone on the video to pick who, then name them here.
                    </div>
                    {enrolMsg && (
                        <div style={{ fontSize: 10, color: '#38a0ff' }}>{enrolMsg}</div>
                    )}
                </div>
            )}

            {uploadSection()}

            {/* Second way to acquire a target: match against the enrolled
                database instead of one uploaded photo. */}
            <FaceGalleryPanel
                matchedPersonId={personId}
                matchedName={personName}
                similarity={similarity}
                margin={galleryMargin}
            />

            {/* Track / Stop */}
            <div style={{ display: 'flex', gap: 8 }}>
                {!isTracking ? (
                    <Button
                        size="sm"
                        className="flex-1 gap-2 font-mono text-xs"
                        disabled={!canTrack}
                        onClick={handleStartTracking}
                        style={{
                            background: canTrack ? '#0e6b6b' : undefined,
                            opacity: canTrack ? 1 : 0.5,
                        }}
                    >
                        <Crosshair size={13} />
                        {canTrack ? 'Start Tracking' : 'Select someone or upload a photo'}
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

            {/* PD tuning - collapsible */}
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
                            onClick={() => { setPd(savedPd); emitPdParams(savedPd) }}
                            disabled={isTracking}
                            style={{
                                fontSize: 10, fontFamily: 'monospace', padding: '4px 8px',
                                borderRadius: 6, border: '1px solid hsl(var(--app-border))',
                                background: 'none', cursor: isTracking ? 'not-allowed' : 'pointer',
                                color: 'hsl(var(--app-text-muted))', opacity: isTracking ? 0.4 : 1,
                                alignSelf: 'flex-end',
                            }}
                        >
                            Reset to saved
                        </button>
                    </div>
                )}
            </div>

        </div>
    )
}
