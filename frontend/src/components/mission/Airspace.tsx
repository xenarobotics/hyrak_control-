'use client'

// Airspace on the Mission tab (docs/ACCESS_MODEL.md 8b):
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

const CLASS_COLOR: Record<string, string> = { red: '#f87171', orange: '#fbbf24', green: '#4ade80' }

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

    let tone = '#9ca3af', icon = <Loader2 size={12} className="animate-spin" />, text = 'Checking airspace…', detail = ''
    if (fresh && result?.error) {
        tone = '#fca5a5'; icon = <AlertTriangle size={12} />; text = 'Airspace check unavailable'
        detail = `${result.error}. The server checks again at upload.`
    } else if (check) {
        if (check.needs === 'prohibited') {
            tone = '#f87171'; icon = <Ban size={12} />
            text = `Prohibited: ${names(prohibited)}`
            detail = 'No permit can be issued for this zone. Re-route around it.'
        } else if (red.length && check.permit) {
            tone = '#4ade80'; icon = <FileCheck size={12} />
            text = `Red zone under permit: ${names(red)}`
            detail = `Approved until ${fmtWhen(check.permit.valid_until)}. Upload this exact plan; any edit needs a new permit.`
        } else if (red.length) {
            tone = '#f87171'; icon = <ShieldAlert size={12} />
            text = `No-fly (red): ${names(red)}${orange.length ? ` · orange: ${names(orange)}` : ''}`
            detail = 'Upload is refused unless an approved permit covers this plan for this drone.'
        } else if (orange.length && check.needs === 'none') {
            tone = '#4ade80'; icon = <FileCheck size={12} />
            text = `Restricted (orange) under permit: ${names(orange)}`
            detail = `Approved until ${fmtWhen(check.permit?.valid_until ?? null)}.`
        } else if (orange.length) {
            tone = '#fbbf24'; icon = <AlertTriangle size={12} />
            text = `Restricted (orange): ${names(orange)}`
            detail = 'You confirm the crossing at upload and get warnings inside it, or ask for a permit.'
        } else {
            tone = '#4ade80'; icon = <Check size={12} />; text = 'Airspace clear'
            detail = 'The plan crosses no restricted zone.'
        }
    }
    const canAsk = canPlan && check && check.needs !== 'prohibited' && check.needs !== 'none'

    return (
        <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl border font-mono max-w-[640px]"
            style={{ background: 'rgba(17,19,24,.94)', borderColor: `${tone}55` }}
            title={detail}>
            <span style={{ color: tone }} className="shrink-0">{icon}</span>
            <div className="min-w-0">
                <div className="text-[10px] font-bold truncate" style={{ color: tone }}>{text}</div>
                {detail && <div className="text-[9px] text-gray-400 truncate">{detail}</div>}
            </div>
            {canAsk && (
                <button onClick={onRequest}
                    className="shrink-0 px-2 py-1 rounded-md text-[10px] font-bold"
                    style={{ background: 'rgba(59,130,246,.2)', color: '#93c5fd', border: '1px solid rgba(59,130,246,.35)' }}>
                    Request permit
                </button>
            )}
            <button onClick={onShowPermits} title="Permits for this workspace"
                className="shrink-0 px-2 py-1 rounded-md text-[10px] text-gray-300"
                style={{ background: 'rgba(255,255,255,.06)' }}>
                Permits
            </button>
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

    const field = 'w-full text-[11px] rounded px-2 py-1.5 outline-none'
    const fieldStyle = { background: 'rgba(255,255,255,.06)', color: '#fff', border: '1px solid rgba(255,255,255,.12)', colorScheme: 'dark' as const }

    return (
        <div className="absolute inset-0 z-[3500] flex items-center justify-center"
            style={{ background: 'rgba(0,0,0,.6)' }} onMouseDown={onClose}>
            <div role="dialog" aria-modal="true" aria-labelledby="permit-req-title"
                className="w-[22rem] max-w-[calc(100%-32px)] rounded-2xl border shadow-2xl overflow-hidden font-mono"
                style={{ background: 'rgba(17,19,24,.98)', borderColor: 'rgba(59,130,246,.35)' }}
                onMouseDown={e => e.stopPropagation()}
                onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
                <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'rgba(59,130,246,.2)' }}>
                    <span id="permit-req-title" className="text-[12px] font-bold text-blue-200">REQUEST A FLIGHT PERMIT</span>
                    <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-200"><X size={14} /></button>
                </div>
                <div className="px-4 py-3 space-y-3">
                    {reason && <p className="text-[10px] text-red-200/90">{reason}</p>}
                    <p className="text-[10px] text-gray-400">
                        For this exact plan ({path.length} waypoints). The reviewer for this airspace decides;
                        once approved, upload the same plan inside the window. Any edit needs a new permit.
                    </p>
                    <div>
                        <label htmlFor="permit-desc" className="block text-[9px] tracking-wider text-gray-500 mb-1">PURPOSE OF THE FLIGHT</label>
                        <textarea id="permit-desc" autoFocus rows={3} maxLength={500} value={description}
                            onChange={e => setDescription(e.target.value)} onBlur={() => setTouched(true)}
                            className={field} style={fieldStyle} />
                        {descError && <p className="text-[9px] text-red-300 mt-0.5">{descError}</p>}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label htmlFor="permit-from" className="block text-[9px] tracking-wider text-gray-500 mb-1">FROM</label>
                            <input id="permit-from" type="datetime-local" value={from} onChange={e => setFrom(e.target.value)}
                                className={field} style={fieldStyle} />
                        </div>
                        <div>
                            <label htmlFor="permit-until" className="block text-[9px] tracking-wider text-gray-500 mb-1">UNTIL</label>
                            <input id="permit-until" type="datetime-local" value={until} onChange={e => setUntil(e.target.value)}
                                className={field} style={fieldStyle} />
                        </div>
                    </div>
                    {windowError && <p className="text-[9px] text-red-300">{windowError}</p>}
                    <fieldset>
                        <legend className="text-[9px] tracking-wider text-gray-500 mb-1">DRONE</legend>
                        {droneId && (
                            <label className="flex items-center gap-2 text-[10px] text-gray-200">
                                <input type="radio" checked={!anyDrone} onChange={() => setAnyDrone(false)} />
                                {droneName ?? 'The connected drone'}
                            </label>
                        )}
                        <label className="flex items-center gap-2 text-[10px] text-gray-200">
                            <input type="radio" checked={anyDrone} onChange={() => setAnyDrone(true)} />
                            Any drone of this workspace
                        </label>
                    </fieldset>
                    {error && <p className="text-[10px] text-red-300">{error}</p>}
                </div>
                <div className="flex gap-2 px-4 pb-4">
                    <button onClick={onClose} className="flex-1 py-2 rounded-lg text-[11px] font-bold text-gray-400"
                        style={{ background: 'rgba(255,255,255,.06)' }}>Cancel</button>
                    <button onClick={() => void submit()} disabled={busy}
                        className="flex-1 py-2 rounded-lg text-[11px] font-bold flex items-center justify-center gap-1.5 disabled:opacity-60"
                        style={{ background: 'rgba(59,130,246,.3)', color: '#bfdbfe', border: '1px solid rgba(59,130,246,.45)' }}>
                        {busy && <Loader2 size={12} className="animate-spin" />} Send request
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
        <div className="w-[22rem] max-w-[calc(100vw-32px)] rounded-xl border shadow-2xl overflow-hidden font-mono"
            style={{ background: 'rgba(17,19,24,.97)', borderColor: 'rgba(255,255,255,.1)' }}
            onMouseDown={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: 'rgba(255,255,255,.08)' }}>
                <span className="text-[10px] tracking-widest font-bold text-gray-400">PERMITS</span>
                <span className="flex items-center gap-1">
                    <button onClick={() => setTick(t => t + 1)} title="Refresh" aria-label="Refresh" className="p-1 text-gray-500 hover:text-gray-200"><RefreshCw size={11} /></button>
                    <button onClick={onClose} title="Close" aria-label="Close" className="p-1 text-gray-500 hover:text-gray-200"><X size={12} /></button>
                </span>
            </div>
            {error && <div className="px-3 py-1.5 text-[10px] text-red-300">{error}</div>}
            <div className="max-h-80 overflow-y-auto">
                {permits === null ? (
                    <div className="px-3 py-3 text-[10px] text-gray-500 flex items-center gap-2"><Loader2 size={11} className="animate-spin" /> Loading</div>
                ) : permits.length === 0 ? (
                    <div className="px-3 py-4 text-[10px] text-gray-500">
                        No permits yet. When a plan crosses an orange or red zone, use &ldquo;Request permit&rdquo; on the airspace bar.
                    </div>
                ) : permits.map(p => {
                    const st = PERMIT_TONE[p.status_effective] ?? PERMIT_TONE.pending
                    const usable = p.status_effective === 'approved' && p.in_window
                    return (
                        <div key={p.id} className="px-3 py-2 border-b space-y-1" style={{ borderColor: 'rgba(255,255,255,.04)' }}>
                            <div className="flex items-center gap-2">
                                <span className="text-[8px] font-bold px-1.5 py-0.5 rounded" style={{ color: st.fg, border: `1px solid ${st.fg}66` }}>{st.label}</span>
                                <span className="text-[10px] text-gray-200 truncate flex-1">&ldquo;{p.description}&rdquo;</span>
                            </div>
                            <div className="text-[9px] text-gray-500">
                                {p.kind === 'area' ? 'Area' : `${p.waypoint_count} wp`} · {p.drone_name ?? 'any drone'} · {fmtWhen(p.valid_from)} to {fmtWhen(p.valid_until)}
                            </div>
                            <div className="text-[9px] flex flex-wrap gap-x-2">
                                {p.zones.map(z => <span key={z.id} style={{ color: CLASS_COLOR[z.zone_class] ?? '#9ca3af' }}>{z.name}</span>)}
                            </div>
                            {p.decision_note && <div className="text-[9px] text-gray-400 border-l-2 pl-1.5" style={{ borderColor: 'rgba(255,255,255,.12)' }}>
                                {p.decided_by_name ? `${p.decided_by_name}: ` : ''}{p.decision_note}</div>}
                            <div className="flex gap-1.5 pt-0.5">
                                {p.kind === 'mission' && (p.waypoints?.length ?? 0) > 0 && (
                                    <button onClick={() => onLoad(p)} className="text-[9px] px-2 py-0.5 rounded"
                                        style={{ background: usable ? 'rgba(34,197,94,.18)' : 'rgba(255,255,255,.06)', color: usable ? '#86efac' : '#d1d5db' }}
                                        title="Load the permitted plan into the planner (edits invalidate the permit)">
                                        Load plan
                                    </button>
                                )}
                                {canPlan && (p.status === 'pending' || p.status === 'approved') && p.status_effective !== 'expired' && (
                                    <button onClick={() => void withdraw(p)} disabled={busy === p.id}
                                        className="text-[9px] px-2 py-0.5 rounded text-gray-300 disabled:opacity-40"
                                        style={{ background: 'rgba(255,255,255,.06)' }}>
                                        {busy === p.id ? 'Withdrawing…' : 'Withdraw request'}
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
