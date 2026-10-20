'use client'

import { apiFetch } from '@/lib/api'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useDroneStore } from '@/store/drone'
import { getSocket } from '@/lib/socket'
import { getServerUrl } from '@/lib/server-url'
import { authHeaders } from '@/lib/auth'
import {
    Users, Crosshair, Square, Info, ChevronDown, ChevronUp,
    Upload, CheckCircle, AlertCircle, Loader2, UserX, ScanFace,
    Mountain, MoveVertical, UserPlus,
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FaceGalleryPanel } from './FaceGalleryPanel'
import { fetchFollowTuning } from '@/lib/calibration'
import {
    TONE, LABEL, SECONDARY, NUM, TILE, TEXT, MUTED, SUBTLE, SURFACE_2, BORDER, BORDER_STRONG,
    chip, btn, DISABLED, FOCUS,
} from './panelStyle'

// Kept in sync with backend defaults (person_tracker.py _make_state: yaw_pd
// kp=30/kd=4/max_output=55) - yaw-axis units (deg/s output). A prior 0-2
// range here meant any slider touch sent values 15-300x weaker than the
// real default and silently crushed tracking responsiveness.
const PD_DEFAULTS = { kp: 30.0, kd: 4.0, max_output: 55, deadband: 0.05 }

const PD_PARAMS = [
    {
        key: 'max_output' as const,
        label: 'Max turn speed', min: 15, max: 55, step: 1, unit: '',
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
        label: 'Dead zone', min: 0.01, max: 0.15, step: 0.01, unit: '',
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
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={FOCUS}
            style={{
                minHeight: 28, padding: '0 12px', borderRadius: 999, fontSize: 12,
                fontWeight: 700, cursor: 'pointer',
                border: `1px solid ${active ? TONE.accent.fg : BORDER_STRONG}`,
                background: active ? TONE.accent.bg : SURFACE_2,
                color: active ? TONE.accent.fg : MUTED,
                transition: 'color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
            }}
        >
            {children}
        </button>
    )
}

const DISTANCE_STEP = 0.06
const DISTANCE_MIN  = 0.10
const DISTANCE_MAX  = 0.60

/** Small round "i" that opens a tooltip. */
function InfoTip({ children, width = 220 }: { children: React.ReactNode; width?: number }) {
    return (
        <Tooltip>
            <TooltipTrigger className={FOCUS} aria-label="More info" style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', padding: 2, borderRadius: 999, cursor: 'help' }}>
                <Info size={13} style={{ color: MUTED }} />
            </TooltipTrigger>
            <TooltipContent style={{ maxWidth: width, fontSize: 13, lineHeight: 1.5 }}>
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
                    <span style={SECONDARY}>{label}</span>
                    <InfoTip>{tooltip}</InfoTip>
                </div>
                <span style={{ ...NUM, fontSize: 13, fontWeight: 700, color: disabled ? SUBTLE : TEXT }}>
                    {format(value)}{unit}
                </span>
            </div>
            <input
                type="range" min={min} max={max} step={step} value={value}
                disabled={disabled}
                title={disabled ? 'Stop tracking to change this' : undefined}
                className={FOCUS}
                onChange={e => onChange(parseFloat(e.target.value))}
                style={{
                    width: '100%', minHeight: 24, accentColor: disabled ? 'hsl(var(--app-text-subtle))' : 'var(--app-accent)',
                    cursor: disabled ? 'not-allowed' : 'pointer',
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

    const persons = cvResults?.persons ?? []
    const personCount = cvResults?.person_count ?? 0
    const targetId = cvResults?.target_id ?? null
    const similarity = cvResults?.similarity ?? 0
    const faceConfirmed = cvResults?.face_confirmed ?? false
    const searching = cvResults?.searching ?? false
    const cmd = cvResults?.drone_command
    // Gallery mode + pursuit state, from the backend's meta.
    const personName = cvResults?.person_name ?? null
    const personId = cvResults?.person_id ?? null
    const galleryMargin = cvResults?.gallery_margin ?? null
    // EVERY identified person in frame, not only the followed one.
    const identities = cvResults?.identities ?? []
    const lockManual = cvResults?.lock_manual ?? false
    const lockState = cvResults?.lock_state ?? 'idle'
    const lockMessage = cvResults?.lock_message ?? ''
    const elevate = cvResults?.elevate ?? null
    const capture = cvResults?.capture ?? null

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
        // Named handlers: a bare socket.off('tracking_status') would also
        // remove every other listener for the event (useDrone's included).
        const onTracking = (d: { active: boolean }) => setIsTracking(d.active)
        const onEnrol = (d: { ok: boolean; msg?: string }) => {
            setEnrolMsg(d.msg ?? null)
            if (d.ok) setEnrolName('')
        }
        const onCleared = () => {
            setUploadState('idle')
            setFaceThumbnail(null)
            setUploadError('')
            setIsTracking(false)
        }
        socket.on('tracking_status', onTracking)
        socket.on('enrolment_started', onEnrol)
        socket.on('reference_cleared', onCleared)
        return () => {
            socket.off('tracking_status', onTracking)
            socket.off('enrolment_started', onEnrol)
            socket.off('reference_cleared', onCleared)
        }
    }, [])

    const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file || !sessionId) return

        setUploadState('uploading')
        setUploadError('')
        setFaceThumbnail(null)

        const form = new FormData()
        form.append('file', file)

        try {
            const res = await apiFetch(
                `${getServerUrl()}/api/reference-photo?session_id=${encodeURIComponent(sessionId)}`,
                {
                    method: 'POST',
                    headers: authHeaders(),
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
        } catch (err) {
            setUploadState('error')
            setUploadError(err instanceof Error ? err.message : 'Network error')
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
    const lockedOut = isTracking ? 'Stop tracking first' : undefined
    const uploadSection = () => {
        if (uploadState === 'uploading') {
            return (
                <div role="status" style={{
                    ...TILE, ...SECONDARY,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    gap: 8, padding: '14px 12px',
                }}>
                    <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
                    Looking for a face…
                </div>
            )
        }

        if (uploadState === 'face_found' && faceThumbnail) {
            return (
                <div style={{
                    borderRadius: 10, overflow: 'hidden',
                    border: `1px solid ${TONE.accent.border}`,
                    background: TONE.accent.bg,
                }}>
                    {/* Thumbnail + info row */}
                    <div style={{ display: 'flex', gap: 12, padding: '12px', alignItems: 'center' }}>
                        <div style={{
                            width: 52, height: 52, borderRadius: 6, overflow: 'hidden',
                            border: `2px solid ${TONE.accent.fg}`, flexShrink: 0,
                        }}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={faceThumbnail} alt="Reference face" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                                <CheckCircle size={14} style={{ color: TONE.accent.fg }} aria-hidden />
                                <span style={{ fontSize: 14, fontWeight: 700, color: TEXT }}>
                                    Face saved
                                </span>
                            </div>
                            <div style={{ ...SECONDARY, ...NUM }}>
                                {isTracking
                                    ? faceConfirmed
                                        ? `Matched, ${(similarity * 100).toFixed(0)}% alike`
                                        : searching ? 'Searching…' : 'Waiting for a face…'
                                    : 'Ready to track'}
                            </div>
                        </div>
                    </div>
                    {/* Re-upload link */}
                    <div style={{
                        borderTop: `1px solid ${TONE.accent.border}`,
                        padding: '4px 8px', display: 'flex', justifyContent: 'space-between',
                        alignItems: 'center',
                    }}>
                        <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={isTracking}
                            title={lockedOut}
                            className={FOCUS}
                            style={{
                                fontSize: 13, fontWeight: 600, background: 'none', minHeight: 32,
                                border: 'none', cursor: isTracking ? 'not-allowed' : 'pointer',
                                color: isTracking ? SUBTLE : MUTED, borderRadius: 6,
                                padding: '0 4px', display: 'flex', alignItems: 'center', gap: 6,
                            }}
                        >
                            <Upload size={13} aria-hidden /> Another photo
                        </button>
                        <button
                            type="button"
                            onClick={handleReset}
                            disabled={isTracking}
                            title={lockedOut}
                            className={FOCUS}
                            style={{
                                fontSize: 13, fontWeight: 600, background: 'none', minHeight: 32,
                                border: 'none', cursor: isTracking ? 'not-allowed' : 'pointer',
                                color: isTracking ? SUBTLE : TONE.danger.fg, borderRadius: 6,
                                padding: '0 4px',
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
                    <div role="alert" style={{
                        display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px',
                        borderRadius: 10, background: TONE.danger.bg,
                        border: `1px solid ${TONE.danger.border}`,
                    }}>
                        {uploadState === 'no_face'
                            ? <UserX size={15} style={{ color: TONE.danger.fg, flexShrink: 0, marginTop: 1 }} aria-hidden />
                            : <AlertCircle size={15} style={{ color: TONE.danger.fg, flexShrink: 0, marginTop: 1 }} aria-hidden />}
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 700, color: TONE.danger.fg, marginBottom: 2 }}>
                                {uploadState === 'no_face' ? 'No face found' : 'Upload failed'}
                            </div>
                            <div style={{ ...SECONDARY, overflowWrap: 'anywhere' }}>
                                {uploadError || 'Use a clear photo of the face, looking at the camera'}
                            </div>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className={FOCUS}
                        style={{ ...btn(), borderStyle: 'dashed' }}
                    >
                        <Upload size={13} aria-hidden /> Try another photo
                    </button>
                </div>
            )
        }

        // idle
        return (
            <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className={FOCUS}
                style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                    justifyContent: 'center', gap: 4, padding: '16px 12px',
                    borderRadius: 10, width: '100%',
                    background: SURFACE_2,
                    border: `2px dashed ${BORDER_STRONG}`,
                    cursor: 'pointer', transition: 'border-color var(--dur-fast) var(--ease-out)',
                }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--app-accent)')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = BORDER_STRONG)}
            >
                <ScanFace size={24} style={{ color: TONE.accent.fg }} aria-hidden />
                <span style={{ fontSize: 14, fontWeight: 600, color: TEXT }}>
                    Upload a face photo
                </span>
                <span style={SECONDARY}>
                    JPEG or PNG, face to camera
                </span>
            </button>
        )
    }

    const lockTone = lockState === 'lost' ? 'danger' : 'warn'
    const canCapture = !!enrolName.trim() && enrolTarget != null

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
                <div role="status" style={{
                    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                    padding: '8px 12px', borderRadius: 10, fontSize: 13,
                    background: TONE[lockTone].bg,
                    border: `1px solid ${TONE[lockTone].border}`,
                    color: TONE[lockTone].fg,
                }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>
                        {lockState.charAt(0).toUpperCase() + lockState.slice(1)}
                    </span>
                    <span style={{ color: TEXT, minWidth: 0 }}>{lockMessage}</span>
                </div>
            )}

            {/* ── Auto-elevate ────────────────────────────────────────────
                Shown whenever it fires OR is blocked. A climb the pilot
                cannot explain is a climb they will fight, and being blocked by
                the legal ceiling is different from being blocked because the
                view has become too steep to recognise anything. Amber: it
                moves the drone. */}
            {elevate && (elevate.elevating || elevate.blocked_by) && (
                <div role="status" style={{
                    display: 'flex', alignItems: 'flex-start', gap: 8,
                    padding: '8px 12px', borderRadius: 10, fontSize: 13, lineHeight: '18px',
                    background: elevate.elevating ? TONE.warn.bg : TONE.danger.bg,
                    border: `1px solid ${elevate.elevating ? TONE.warn.border : TONE.danger.border}`,
                    color: TEXT,
                }}>
                    <MoveVertical size={14} aria-hidden style={{ marginTop: 2, flexShrink: 0, color: elevate.elevating ? TONE.warn.fg : TONE.danger.fg }} />
                    <span>
                        <b style={{ fontWeight: 700, color: elevate.elevating ? TONE.warn.fg : TONE.danger.fg }}>
                            {elevate.elevating ? 'Climbing' : 'Cannot climb'}
                        </b>
                        {': '}{elevate.reason}
                    </span>
                </div>
            )}

            {/* Stats bar */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span style={chip('muted')}>
                    <Users size={13} aria-hidden /> {personCount} in view
                </span>
                {isTracking && (
                    <span style={chip(faceConfirmed ? 'ok' : 'accent')}>
                        <Crosshair size={13} aria-hidden />
                        {faceConfirmed ? `Locked #${targetId}` : 'Scanning'}
                    </span>
                )}
            </div>

            {/* ── Enrol from the live feed ────────────────────────────
                Faster and more accurate than uploading a photo: the gallery
                ends up holding this camera, lens, angle and lighting, which
                is what the recogniser is later asked to match. Several shots
                across ~2s, not one - a single pose matches that pose and
                little else, and pose variation is the main way recognition
                fails at drone standoff. */}
            {capture ? (
                <div role="status" style={{
                    display: 'flex', flexDirection: 'column', gap: 8,
                    padding: '10px 12px', borderRadius: 10,
                    background: TONE.accent.bg,
                    border: `1px solid ${TONE.accent.border}`,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                        <UserPlus size={14} style={{ color: TONE.accent.fg }} aria-hidden />
                        <span style={{ fontWeight: 700, color: TEXT, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            Saving {capture.name}
                        </span>
                        <span style={{ ...NUM, marginLeft: 'auto', fontSize: 13, fontWeight: 700, color: TONE.accent.fg }}>
                            {capture.shots}/{capture.needed}
                        </span>
                    </div>
                    <div style={{ height: 4, borderRadius: 999, background: BORDER, overflow: 'hidden' }}>
                        <div style={{
                            width: '100%', height: '100%', borderRadius: 999, background: TONE.accent.fg,
                            transformOrigin: 'left', transform: `scaleX(${capture.shots / capture.needed})`,
                            transition: 'transform var(--dur) var(--ease-out)',
                        }} />
                    </div>
                    <div style={SECONDARY}>
                        Keep them in view for a couple of seconds.
                    </div>
                    <button
                        type="button"
                        onClick={() => getSocket().emit('enrol_person_live', { cancel: true })}
                        className={FOCUS}
                        style={btn()}
                    >Cancel</button>
                </div>
            ) : personCount > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ ...LABEL, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <UserPlus size={13} aria-hidden />
                        Add to database
                        {enrolTarget != null && (
                            <span style={{ ...NUM, marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, fontWeight: 600 }}>
                                #{enrolTarget}{targetId === enrolTarget ? ' (followed)' : ''}
                            </span>
                        )}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <input
                            value={enrolName}
                            onChange={e => setEnrolName(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') startEnrol() }}
                            placeholder={enrolTarget != null ? `Name for #${enrolTarget}` : 'No one in view'}
                            disabled={enrolTarget == null}
                            aria-label="Name"
                            className={FOCUS}
                            style={{
                                flex: 1, minWidth: 0, minHeight: 32, padding: '0 10px', borderRadius: 6,
                                fontSize: 14, border: `1px solid ${BORDER_STRONG}`,
                                background: SURFACE_2, color: TEXT,
                            }}
                        />
                        <button
                            type="button"
                            onClick={startEnrol}
                            disabled={!canCapture}
                            title={canCapture ? undefined : enrolTarget == null ? 'No one in view' : 'Type a name first'}
                            className={FOCUS}
                            style={canCapture ? btn('primary') : { ...btn(), ...DISABLED }}
                        >Capture</button>
                    </div>
                    <div style={SECONDARY}>
                        Tap someone on the video, then name them.
                    </div>
                    {enrolMsg && (
                        <div role="status" style={{ fontSize: 13, color: TONE.accent.fg }}>{enrolMsg}</div>
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

            {/* Track / Stop. Amber: starting moves the drone. */}
            <div style={{ display: 'flex', gap: 8 }}>
                {!isTracking ? (
                    <button
                        type="button"
                        disabled={!canTrack}
                        onClick={handleStartTracking}
                        title={canTrack ? 'The drone turns and moves to follow' : 'Tap someone on the video or upload a photo first'}
                        className={FOCUS}
                        style={{
                            ...(canTrack ? btn('warn') : { ...btn(), ...DISABLED }),
                            flex: 1, minHeight: 36, fontSize: 14, fontWeight: 700,
                        }}
                    >
                        <Crosshair size={14} aria-hidden />
                        {canTrack ? 'Start tracking' : 'Pick someone first'}
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={handleStopTracking}
                        className={FOCUS}
                        style={{ ...btn('danger'), flex: 1, minHeight: 36, fontSize: 14, fontWeight: 700 }}
                    >
                        <Square size={14} aria-hidden />
                        Stop tracking
                    </button>
                )}
            </div>

            {/* ── Flight Controls ─────────────────────────────────────────── */}
            <div style={{ borderRadius: 10, border: `1px solid ${BORDER}`, overflow: 'hidden' }}>
                <div style={{
                    ...LABEL,
                    padding: '8px 12px', background: SURFACE_2,
                    borderBottom: `1px solid ${BORDER}`,
                }}>
                    Flight controls
                </div>
                <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: 12 }}>

                    {/* ── Distance ── */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <MoveVertical size={13} style={{ color: MUTED, transform: 'rotate(90deg)' }} aria-hidden />
                            <span style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>Distance</span>
                            <InfoTip width={240}>
                                The drone moves in or out to keep the person {Math.round(distanceRatio * 100)}% of the frame height. Each + is 6% closer.
                            </InfoTip>
                            <span style={{ ...NUM, marginLeft: 'auto', fontSize: 13, fontWeight: 700, color: TONE.accent.fg }}>
                                {distanceLabel(distanceRatio)} ({Math.round(distanceRatio * 100)}%)
                            </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <button
                                type="button"
                                onClick={handleFurther}
                                title="Step further"
                                aria-label="Step further"
                                className={FOCUS}
                                style={{ ...btn(), width: 32, padding: 0, fontSize: 18, flexShrink: 0 }}
                            >−</button>
                            <input
                                type="range"
                                min={DISTANCE_MIN * 100} max={DISTANCE_MAX * 100} step={1}
                                value={Math.round(distanceRatio * 100)}
                                onChange={e => handleDistanceChange(parseFloat(e.target.value) / 100)}
                                aria-label="Distance"
                                className={FOCUS}
                                style={{ flex: 1, minWidth: 0, minHeight: 24, accentColor: 'var(--app-accent)', cursor: 'pointer' }}
                            />
                            <button
                                type="button"
                                onClick={handleCloser}
                                title="Step closer"
                                aria-label="Step closer"
                                className={FOCUS}
                                style={{ ...btn(), width: 32, padding: 0, fontSize: 18, flexShrink: 0 }}
                            >+</button>
                        </div>
                        <div style={{ ...SECONDARY, fontSize: 12, display: 'flex', justifyContent: 'space-between', padding: '0 40px' }}>
                            <span>Far</span>
                            <span>Close</span>
                        </div>
                    </div>

                    <div style={{ height: 1, background: BORDER, margin: '0 -12px' }} />

                    {/* ── Altitude ── */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <Mountain size={13} style={{ color: MUTED }} aria-hidden />
                                <span style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>Height</span>
                                <InfoTip>
                                    Fixed: holds the current height; hold Up or Down to nudge while tracking.
                                    Auto: follows the person up and down (experimental).
                                </InfoTip>
                            </div>
                            <div style={{ display: 'flex', gap: 4 }} role="group" aria-label="Altitude mode">
                                <PillToggle active={altitudeMode === 'fixed'} onClick={() => handleAltitudeMode('fixed')}>Fixed</PillToggle>
                                <PillToggle active={altitudeMode === 'auto'} onClick={() => handleAltitudeMode('auto')}>Auto</PillToggle>
                            </div>
                        </div>
                        {altitudeMode === 'fixed' && (
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <button
                                    type="button"
                                    onPointerDown={() => { if (isTracking) getSocket().emit('set_altitude_nudge', { velocity: -0.4 }) }}
                                    onPointerUp={() => getSocket().emit('set_altitude_nudge', { velocity: 0 })}
                                    onPointerLeave={() => getSocket().emit('set_altitude_nudge', { velocity: 0 })}
                                    disabled={!isTracking}
                                    title={isTracking ? 'Hold to climb' : 'Start tracking first'}
                                    className={FOCUS}
                                    style={{ ...(isTracking ? btn() : { ...btn(), ...DISABLED }), flex: 1, userSelect: 'none' }}
                                >▲ Up</button>
                                <span style={{ ...SECONDARY, flex: '1 1 0', fontSize: 12, textAlign: 'center' }}>
                                    {isTracking ? 'Hold to move' : 'Track first'}
                                </span>
                                <button
                                    type="button"
                                    onPointerDown={() => { if (isTracking) getSocket().emit('set_altitude_nudge', { velocity: 0.4 }) }}
                                    onPointerUp={() => getSocket().emit('set_altitude_nudge', { velocity: 0 })}
                                    onPointerLeave={() => getSocket().emit('set_altitude_nudge', { velocity: 0 })}
                                    disabled={!isTracking}
                                    title={isTracking ? 'Hold to descend' : 'Start tracking first'}
                                    className={FOCUS}
                                    style={{ ...(isTracking ? btn() : { ...btn(), ...DISABLED }), flex: 1, userSelect: 'none' }}
                                >▼ Down</button>
                            </div>
                        )}
                    </div>

                </div>
            </div>

            {/* Live similarity badge */}
            {isTracking && faceConfirmed && similarity > 0 && (
                <div style={{
                    padding: '8px 12px', borderRadius: 10,
                    background: TONE.accent.bg, border: `1px solid ${TONE.accent.border}`,
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
                }}>
                    <span style={{ fontSize: 13, color: TEXT }}>
                        Face match
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {/* Mini bar */}
                        <div style={{
                            width: 60, height: 4, borderRadius: 999,
                            background: BORDER, overflow: 'hidden',
                        }}>
                            <div style={{
                                height: '100%', width: '100%', borderRadius: 999,
                                transformOrigin: 'left',
                                transform: `scaleX(${Math.min(1, similarity / 0.7)})`,
                                background: similarity >= 0.55 ? TONE.ok.fg : TONE.warn.fg,
                                transition: 'transform var(--dur-slow) var(--ease-out)',
                            }} />
                        </div>
                        <span style={{ ...NUM, fontSize: 16, fontWeight: 700, color: TEXT }}>
                            {(similarity * 100).toFixed(0)}<span style={{ fontSize: 12, color: MUTED, marginLeft: 1 }}>%</span>
                        </span>
                    </div>
                </div>
            )}

            {/* Live PD command */}
            {isTracking && cmd && (
                <div style={{ ...TILE, padding: '10px 12px' }}>
                    <div style={{ ...LABEL, marginBottom: 6 }}>
                        Steering output
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: 13 }}>
                        {Object.entries(cmd).filter(([k]) => k !== 'type').map(([k, v]) => (
                            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, minWidth: 0 }}>
                                <span className="font-code" style={{ color: MUTED, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}>{k}</span>
                                <span style={{ ...NUM, color: (v as number) !== 0 ? TONE.accent.fg : MUTED, fontWeight: 700 }}>
                                    {v as number}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* PD tuning - collapsible */}
            <div style={{ borderRadius: 10, overflow: 'hidden', border: `1px solid ${BORDER}` }}>
                <button
                    type="button"
                    onClick={() => setPdOpen(o => !o)}
                    aria-expanded={pdOpen}
                    className={FOCUS}
                    style={{
                        ...LABEL,
                        width: '100%', display: 'flex', alignItems: 'center',
                        justifyContent: 'space-between', minHeight: 36, padding: '0 12px',
                        background: SURFACE_2, border: 'none', cursor: 'pointer',
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
                                label={p.label} value={pd[p.key]}
                                min={p.min} max={p.max} step={p.step}
                                unit={p.unit} format={p.format} tooltip={p.tooltip}
                                disabled={isTracking}
                                onChange={v => handlePdChange(p.key, v)}
                            />
                        ))}
                        {isTracking && (
                            <p style={{ ...SECONDARY, margin: 0 }}>
                                Stop tracking to change these.
                            </p>
                        )}
                        <button
                            type="button"
                            onClick={() => { setPd(savedPd); emitPdParams(savedPd) }}
                            disabled={isTracking}
                            title={lockedOut}
                            className={FOCUS}
                            style={{ ...(isTracking ? { ...btn(), ...DISABLED } : btn()), alignSelf: 'flex-end' }}
                        >
                            Reset to saved
                        </button>
                    </div>
                )}
            </div>

        </div>
    )
}
