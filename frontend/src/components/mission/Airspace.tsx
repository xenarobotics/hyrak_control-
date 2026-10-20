'use client'

// Airspace on the Mission tab (docs/ACCESS_MODEL.md 8d):
//
//   AirspaceStrip        the plan's zone check, kept current as it is
//                        edited: clear / orange (acknowledge at upload, or
//                        a permit) / red (needs an approved permit) /
//                        prohibited (no permit possible), with the permit
//                        that covers it when there is one.
//   PermitRequestDialog  ask for a permit for this exact plan, with a
//                        purpose, a time window and the drone.
//   PermitsPanel         the workspace's permits and where each stands;
//                        load a permitted plan, withdraw a request.
//
// The server decides everything; these only show and ask.

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, FileCheck, Loader2, Ban, ShieldAlert, X, RefreshCw } from 'lucide-react'
import {
    checkPath, fmtWhen, listPermits, PERMIT_TONE, requestPermit, withdrawPermit,
    type PathCheck, type Permit,
} from '@/lib/planning'
import type { UploadWp } from '@/lib/uploadPath'
import { cn } from '@/lib/utils'
import { BACKDROP, BTN, BTN_ACCENT, BTN_DANGER, BTN_PRIMARY, DIALOG, FOCUS, INPUT, LABEL, POPOVER } from './ui'

type Tone = 'muted' | 'ok' | 'warn' | 'danger'
const TONE_TEXT: Record<Tone, string> = {
    muted: 'text-app-text-muted', ok: 'text-app-ok', warn: 'text-app-warn', danger: 'text-app-danger',
}
const TONE_BORDER: Record<Tone, string> = {
    muted: 'border-app-border', ok: 'border-app-ok/50', warn: 'border-app-warn/50', danger: 'border-app-danger/50',
}
const CLASS_TONE: Record<string, Tone> = { red: 'danger', orange: 'warn', green: 'ok' }
/** PERMIT_TONE carries dark-theme hex; map it to theme tones. */
function permitTone(fg: string): Tone {
    if (fg === '#4ade80') return 'ok'
    if (fg === '#f87171') return 'danger'
    if (fg === '#fbbf24' || fg === '#fb923c') return 'warn'
    return 'muted'
}
const sentence = (s: string) => s.charAt(0) + s.slice(1).toLowerCase()
const ICON_BTN = cn('w-8 h-8 rounded-[6px] flex items-center justify-center text-app-text-muted hover:text-app-text hover:bg-app-surface-2 transition-colors duration-[120ms]', FOCUS)

function names(zs: { name: string }[]): string {
    return zs.map(z => z.name).join(', ')
}

// ── Strip ────────────────────────────────────────────────────────────────

export function AirspaceStrip({ workspaceId, droneId, path, canPlan, nonce, onRequest, onShowPermits }: {
    workspaceId: string | null
    droneId: string | null
    /** The waypoints exactly as they would be uploaded. */
    path: UploadWp[]
    canPlan: boolean
    /** Bump to re-check (after a permit request or decision). */
    nonce: number
    onRequest: () => void
    onShowPermits: () => void
}) {
    const [result, setResult] = useState<{ key: string; check: PathCheck | null; error: string | null } | null>(null)
    const key = useMemo(() => JSON.stringify([workspaceId, droneId, nonce,
        path.map(w => [w.lat, w.lng, w.altitude])]), [workspaceId, droneId, nonce, path])

    // Debounced: the plan changes on every drag.
    useEffect(() => {
        if (path.length === 0) return
        let alive = true
        const t = setTimeout(() => {
            checkPath(workspaceId, path, droneId)
                .then(check => { if (alive) setResult({ key, check, error: null }) })
                .catch(e => { if (alive) setResult({ key, check: null, error: (e as Error).message }) })
        }, 500)
        return () => { alive = false; clearTimeout(t) }
    }, [key, path, workspaceId, droneId])

    if (path.length === 0) return null
    const fresh = result?.key === key
    const check = fresh ? result?.check : null
    const restricted = check?.zones.filter(z => z.zone_class !== 'green') ?? []
    const red = restricted.filter(z => z.zone_class === 'red')
    const orange = restricted.filter(z => z.zone_class === 'orange')
    const prohibited = red.filter(z => z.permission_required === false)

    let tone: Tone = 'muted', icon = <Loader2 size={14} className="animate-spin" />, text = 'Checking airspace…', detail = ''
    if (fresh && result?.error) {
        tone = 'danger'; icon = <AlertTriangle size={14} />; text = 'Airspace check unavailable'
        detail = `${result.error}. The server checks again at upload.`
    } else if (check) {
        if (check.needs === 'prohibited') {
            tone = 'danger'; icon = <Ban size={14} />
            text = `Prohibited: ${names(prohibited)}`
            detail = 'No permit can be issued for this zone. Re-route around it.'
        } else if (red.length && check.permit) {
            tone = 'ok'; icon = <FileCheck size={14} />
            text = `Red zone under permit: ${names(red)}`
            detail = `Approved until ${fmtWhen(check.permit.valid_until)}. Upload this exact plan; any edit needs a new permit.`
        } else if (red.length) {
            tone = 'danger'; icon = <ShieldAlert size={14} />
            text = `No-fly (red): ${names(red)}${orange.length ? `; orange: ${names(orange)}` : ''}`
            detail = 'Upload is refused unless an approved permit covers this plan for this drone.'
        } else if (orange.length && check.needs === 'none') {
            tone = 'ok'; icon = <FileCheck size={14} />
            text = `Restricted (orange) under permit: ${names(orange)}`
            detail = `Approved until ${fmtWhen(check.permit?.valid_until ?? null)}.`
        } else if (orange.length) {
            tone = 'warn'; icon = <AlertTriangle size={14} />
            text = `Restricted (orange): ${names(orange)}`
            detail = 'You confirm the crossing at upload and get warnings inside it, or ask for a permit.'
        } else {
            tone = 'ok'; icon = <Check size={14} />; text = 'Airspace clear'
            detail = 'The plan crosses no restricted zone.'
        }
    }
    const canAsk = canPlan && check && check.needs !== 'prohibited' && check.needs !== 'none'

    return (
        <div className={cn('rounded-[8px] border bg-app-surface-2 pl-3 pr-1.5 py-1.5 flex flex-col gap-1.5 w-full', TONE_BORDER[tone])}
            title={detail} role="status">
            <div className="flex items-center gap-2 min-w-0 min-h-8">
                <span className={cn('shrink-0', TONE_TEXT[tone])}>{icon}</span>
                <span className={cn('flex-1 min-w-0 text-[14px] font-bold leading-5 line-clamp-2', TONE_TEXT[tone])}>{text}</span>
                <button onClick={onShowPermits} title="Permits for this workspace"
                    className={cn(BTN, 'shrink-0 h-7 px-2 bg-transparent border-transparent text-app-text-muted hover:text-app-text')}>
                    Permits
                </button>
            </div>
            {detail && (tone === 'warn' || tone === 'danger' || red.length > 0) && (
                <p className="pr-1.5 text-[13px] leading-[18px] text-app-text-muted">{detail}</p>
            )}
            {canAsk && (
                <button onClick={onRequest} className={cn(BTN_ACCENT, 'mr-1.5 mb-0.5')}>
                    Request permit
                </button>
            )}
        </div>
    )
}

// ── Request dialog ───────────────────────────────────────────────────────

function localInput(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function PermitRequestDialog({ workspaceId, droneId, droneName, path, missionId, reason, onClose, onSent }: {
    workspaceId: string | null
    droneId: string | null
    droneName: string | null
    path: UploadWp[]
    missionId: string | null
    /** Why it opened (the upload refusal), shown on top. */
    reason: string | null
    onClose: () => void
    onSent: (p: Permit) => void
}) {
    const [description, setDescription] = useState('')
    const [from, setFrom] = useState(() => localInput(new Date()))
    const [until, setUntil] = useState(() => localInput(new Date(Date.now() + 4 * 3600_000)))
    const [anyDrone, setAnyDrone] = useState(!droneId)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [touched, setTouched] = useState(false)

    const descError = touched && description.trim().length < 3 ? 'Describe the purpose of the flight.' : null
    const windowError = new Date(until) <= new Date(from) ? 'The window must end after it starts.' : null

    const submit = async () => {
        setTouched(true)
        if (description.trim().length < 3 || windowError) return
        setBusy(true); setError(null)
        try {
            const p = await requestPermit({
                workspace_id: workspaceId, description: description.trim(),
                valid_from: new Date(from).toISOString(), valid_until: new Date(until).toISOString(),
                drone_id: anyDrone ? null : droneId, mission_id: missionId, waypoints: path,
            })
            onSent(p)
        } catch (e) { setError((e as Error).message) }
        finally { setBusy(false) }
    }

    const field = cn(INPUT, 'w-full h-auto min-h-8 py-1.5')

    return (
        <div className={cn('absolute inset-0 z-[3500] flex items-center justify-center', BACKDROP)}
            onMouseDown={onClose}>
            <div role="dialog" aria-modal="true" aria-labelledby="permit-req-title"
                className={cn(DIALOG, 'w-[24rem] max-w-[calc(100%-32px)] overflow-hidden')}
                onMouseDown={e => e.stopPropagation()}
                onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
                <div className="flex items-center justify-between pl-4 pr-2 py-2.5 border-b border-app-border">
                    <span id="permit-req-title" className="text-[18px] font-bold text-app-text">Request a flight permit</span>
                    <button onClick={onClose} aria-label="Close" title="Close" className={ICON_BTN}><X size={16} /></button>
                </div>
                <div className="px-4 py-3 space-y-3">
                    {reason && <p className="text-[13px] text-app-danger bg-app-danger-soft rounded-[6px] px-2.5 py-1.5" role="alert">{reason}</p>}
                    <p className="text-[13px] text-app-text-muted">
                        For this exact plan ({path.length} waypoints). Any edit needs a new permit.
                    </p>
                    <div>
                        <label htmlFor="permit-desc" className={cn(LABEL, 'block mb-1')}>Purpose of the flight</label>
                        <textarea id="permit-desc" autoFocus rows={3} maxLength={500} value={description}
                            onChange={e => setDescription(e.target.value)} onBlur={() => setTouched(true)}
                            className={field} />
                        {descError && <p className="text-[13px] text-app-danger mt-1">{descError}</p>}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label htmlFor="permit-from" className={cn(LABEL, 'block mb-1')}>From</label>
                            <input id="permit-from" type="datetime-local" value={from} onChange={e => setFrom(e.target.value)}
                                className={field} />
                        </div>
                        <div>
                            <label htmlFor="permit-until" className={cn(LABEL, 'block mb-1')}>Until</label>
                            <input id="permit-until" type="datetime-local" value={until} onChange={e => setUntil(e.target.value)}
                                className={field} />
                        </div>
                    </div>
                    {windowError && <p className="text-[13px] text-app-danger">{windowError}</p>}
                    <fieldset className="space-y-1">
                        <legend className={cn(LABEL, 'mb-1')}>Drone</legend>
                        {droneId && (
                            <label className="flex items-center gap-2 min-h-8 text-[14px] text-app-text cursor-pointer">
                                <input type="radio" checked={!anyDrone} onChange={() => setAnyDrone(false)}
                                    className={cn('w-4 h-4 accent-[var(--app-accent)]', FOCUS)} />
                                {droneName ?? 'The connected drone'}
                            </label>
                        )}
                        <label className="flex items-center gap-2 min-h-8 text-[14px] text-app-text cursor-pointer">
                            <input type="radio" checked={anyDrone} onChange={() => setAnyDrone(true)}
                                className={cn('w-4 h-4 accent-[var(--app-accent)]', FOCUS)} />
                            Any drone of this workspace
                        </label>
                    </fieldset>
                    {error && <p className="text-[13px] text-app-danger" role="alert">{error}</p>}
                </div>
                <div className="flex gap-2 px-4 pb-4">
                    <button onClick={onClose} className={cn(BTN, 'flex-1')}>Cancel</button>
                    <button onClick={() => void submit()} disabled={busy} title={busy ? 'Sending' : undefined}
                        className={cn(BTN_PRIMARY, 'flex-1')}>
                        {busy && <Loader2 size={14} className="animate-spin" />} Send request
                    </button>
                </div>
            </div>
        </div>
    )
}

// ── Permits list ─────────────────────────────────────────────────────────

export function PermitsPanel({ workspaceId, canPlan, nonce, onLoad, onChanged, onClose }: {
    workspaceId: string | null
    canPlan: boolean
    nonce: number
    onLoad: (p: Permit) => void
    onChanged: () => void
    onClose: () => void
}) {
    const [permits, setPermits] = useState<Permit[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const [tick, setTick] = useState(0)

    useEffect(() => {
        let alive = true
        listPermits(workspaceId)
            .then(p => { if (alive) { setPermits(p); setError(null) } })
            .catch(e => { if (alive) { setError((e as Error).message); setPermits(prev => prev ?? []) } })
        return () => { alive = false }
    }, [workspaceId, nonce, tick])

    const withdraw = async (p: Permit) => {
        setBusy(p.id)
        try { await withdrawPermit(p.id); setTick(t => t + 1); onChanged() }
        catch (e) { setError((e as Error).message) }
        finally { setBusy(null) }
    }

    return (
        <div className={cn(POPOVER, 'w-[22rem] max-w-[calc(100vw-32px)] overflow-hidden')}
            onMouseDown={e => e.stopPropagation()}>
            <div className="flex items-center justify-between pl-4 pr-2 py-2 border-b border-app-border">
                <span className="text-base font-bold text-app-text">Permits</span>
                <span className="flex items-center gap-1">
                    <button onClick={() => setTick(t => t + 1)} title="Refresh" aria-label="Refresh" className={ICON_BTN}><RefreshCw size={14} /></button>
                    <button onClick={onClose} title="Close" aria-label="Close" className={ICON_BTN}><X size={14} /></button>
                </span>
            </div>
            {error && <div className="px-4 py-2 text-[13px] text-app-danger bg-app-danger-soft" role="alert">{error}</div>}
            <div className="max-h-80 overflow-y-auto">
                {permits === null ? (
                    <div className="px-4 py-3 text-[13px] text-app-text-muted flex items-center gap-2" role="status"><Loader2 size={13} className="animate-spin" /> Loading</div>
                ) : permits.length === 0 ? (
                    <div className="px-4 py-5 flex flex-col items-center gap-1.5 text-center">
                        <FileCheck size={18} className="text-app-text-muted" />
                        <p className="text-[13px] text-app-text-muted">No permits yet. Request one from the airspace bar.</p>
                    </div>
                ) : permits.map(p => {
                    const st = PERMIT_TONE[p.status_effective] ?? PERMIT_TONE.pending
                    const tone = permitTone(st.fg)
                    const usable = p.status_effective === 'approved' && p.in_window
                    return (
                        <div key={p.id} className="px-4 py-2.5 border-b border-app-border last:border-b-0 space-y-1">
                            <div className="flex items-center gap-2">
                                <span className={cn('shrink-0 text-xs font-bold px-2 h-6 inline-flex items-center rounded-full border', TONE_TEXT[tone], TONE_BORDER[tone])}>{sentence(st.label)}</span>
                                <span className="text-[14px] font-semibold text-app-text truncate flex-1">&ldquo;{p.description}&rdquo;</span>
                            </div>
                            <div className="text-[13px] text-app-text-muted tabular-nums">
                                {p.kind === 'area' ? 'Area' : `${p.waypoint_count} wp`} · {p.drone_name ?? 'any drone'} · {fmtWhen(p.valid_from)} to {fmtWhen(p.valid_until)}
                            </div>
                            {p.zones.length > 0 && <div className="text-[13px] font-semibold flex flex-wrap gap-x-2">
                                {p.zones.map(z => <span key={z.id} className={TONE_TEXT[CLASS_TONE[z.zone_class] ?? 'muted']}>{z.name}</span>)}
                            </div>}
                            {p.decision_note && <div className="text-[13px] text-app-text-muted border-l-2 border-app-border pl-2">
                                {p.decided_by_name ? `${p.decided_by_name}: ` : ''}{p.decision_note}</div>}
                            <div className="flex gap-2 pt-1">
                                {p.kind === 'mission' && (p.waypoints?.length ?? 0) > 0 && (
                                    <button onClick={() => onLoad(p)} className={usable ? BTN_PRIMARY : BTN}
                                        title="Load the permitted plan into the planner (edits invalidate the permit)">
                                        Load plan
                                    </button>
                                )}
                                {canPlan && (p.status === 'pending' || p.status === 'approved') && p.status_effective !== 'expired' && (
                                    <button onClick={() => void withdraw(p)} disabled={busy === p.id}
                                        title={busy === p.id ? 'Withdrawing now' : undefined}
                                        className={BTN_DANGER}>
                                        {busy === p.id ? 'Withdrawing…' : 'Withdraw'}
                                    </button>
                                )}
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
