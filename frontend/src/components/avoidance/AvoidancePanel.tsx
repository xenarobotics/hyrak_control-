'use client'

// The Fly-tab obstacle-avoidance control. Detection and control are two
// deliberate steps: DETECTION turns on sensing (advisory - it detects and
// shows, commands nothing), ARM then allows the cloud to actually take
// control. Arm is a two-tap confirm because it hands an aircraft to the
// avoidance loop. Below the switches: what the loop can see and knows
// (camera feeding? destination known?), the tuning that decides how early
// and how wide it dodges, and the last things it did.
import { useCallback, useEffect, useState } from 'react'
import { useResolvedDroneId } from '@/lib/droneId'
import { useAccess } from '@/hooks/useAccess'
import { visibleInterval } from '@/lib/poll'
import { ShieldCheck, ShieldAlert, Shield, TriangleAlert, ChevronDown, ChevronRight, Plug } from 'lucide-react'
import { FOCUS_LINK_EVENT } from '@/components/layout/StatusBar'
import {
    getStatus, setEnabled, setArmed, getEvents, clearHazards, nearestAheadM,
    type AvoidanceStatus, type AvoidanceEvent, type AvoidanceParams,
} from '@/lib/avoidance'
import { cn } from '@/lib/utils'
import { FOCUS, DISABLED } from '@/components/controls/flightStyles'
import { WhyDisabled } from '@/components/controls/WhyDisabled'
import { SimpleSelect } from '@/components/ui/select'

type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'muted'
const STATE_TONE: Record<string, Tone> = {
    nominal: 'ok', holding: 'warn', rerouted: 'accent',
    climbing: 'accent', avoiding: 'accent', returning: 'danger', disabled: 'muted',
}
const TEXT: Record<Tone, string> = {
    ok: 'text-app-ok', warn: 'text-app-warn', danger: 'text-app-danger', accent: 'text-app-accent', muted: 'text-app-text-muted',
}
const SOFT: Record<Tone, string> = {
    ok: 'bg-app-ok-soft', warn: 'bg-app-warn-soft', danger: 'bg-app-danger-soft', accent: 'bg-app-accent-soft', muted: 'bg-app-surface-2',
}
const DOT: Record<Tone, string> = {
    ok: 'bg-app-ok', warn: 'bg-app-warn', danger: 'bg-app-danger', accent: 'bg-app-accent', muted: 'bg-app-text-subtle',
}

// The knobs worth exposing, with what each one means to the pilot.
const TUNING: { key: keyof AvoidanceParams; label: string; unit: string; step: number; min: number; max: number; hint: string }[] = [
    { key: 'reaction_distance_m', label: 'React at', unit: 'm', step: 1, min: 4, max: 40,
      hint: 'Obstacle closer than this -> act. A mono camera judges ~25 m; keep this below it.' },
    { key: 'clearance_m', label: 'Clearance', unit: 'm', step: 1, min: 1, max: 20,
      hint: 'Extra keep-out around every obstacle. Depth underestimates range, so err wide.' },
    { key: 'speed_cap_m_s', label: 'Speed cap', unit: 'm/s', step: 0.5, min: 1, max: 12,
      hint: 'Cruise while avoidance is on. Slower buys the camera reaction time.' },
    { key: 'hold_to_return_s', label: 'Hold, then RTL', unit: 's', step: 5, min: 5, max: 120,
      hint: 'Holding with no path this long -> return to launch.' },
    { key: 'local_clearance_m', label: 'Steer gap', unit: 'm', step: 0.05, min: 0.3, max: 8,
      hint: 'Distance the local planner keeps from every obstacle while it steers (body + margin).' },
    { key: 'ttc_engage_s', label: 'Take over at', unit: 's TTC', step: 0.5, min: 2, max: 10,
      hint: 'Take control when closing on something faster than this, whatever its distance.' },
    { key: 'mono_speed_cap_m_s', label: 'Camera speed', unit: 'm/s', step: 0.5, min: 0.5, max: 5,
      hint: 'Speed cap while the camera is the only sensor (its range is estimated, not measured).' },
]

// What the loop may do on its own. The ladder is always reroute -> hold ->
// return; the choice is how far down it may go.
const RESPONSES: { value: string; label: string; flags: Partial<AvoidanceParams> }[] = [
    { value: 'reroute-hold-rtl', label: 'Reroute, else hold, then RTL', flags: { allow_reroute: 1, allow_return: 1 } },
    { value: 'reroute-hold',     label: 'Reroute, else hold (never RTL)', flags: { allow_reroute: 1, allow_return: 0 } },
    { value: 'hold-rtl',         label: 'Hold, then RTL (never reroute)', flags: { allow_reroute: 0, allow_return: 1 } },
    { value: 'hold',             label: 'Hold only', flags: { allow_reroute: 0, allow_return: 0 } },
]
function responseOf(p?: AvoidanceParams): string {
    if (!p) return 'reroute-hold-rtl'
    const r = (p.allow_reroute ?? 1) ? 1 : 0, t = (p.allow_return ?? 1) ? 1 : 0
    return r && t ? 'reroute-hold-rtl' : r ? 'reroute-hold' : t ? 'hold-rtl' : 'hold'
}

type Toggle = { on: boolean; onClick: () => void; disabled?: boolean; title: string; why?: string | null; onTone?: 'accent' | 'warn' | 'danger' }
const ON_BG = { accent: 'bg-app-accent border-app-accent', warn: 'bg-app-warn border-app-warn', danger: 'bg-app-danger border-app-danger' }

function Switch({ on, onClick, disabled, title, why, onTone = 'accent' }: Toggle) {
    return (
        <WhyDisabled reason={disabled ? (why ?? 'Busy') : null} className="shrink-0">
            <button onClick={onClick} disabled={disabled} role="switch" aria-checked={on} title={disabled ? undefined : title} aria-label={title}
                className={cn('relative w-11 h-6 rounded-full transition-colors duration-[var(--dur)] shrink-0 border after:absolute after:-inset-1.5',
                    'disabled:cursor-not-allowed disabled:opacity-60', FOCUS,
                    on ? ON_BG[onTone] : 'bg-app-surface-2 border-app-border-strong')}>
                <span className={cn('absolute left-0 top-1/2 -translate-y-1/2 w-[18px] h-[18px] rounded-full shadow-md transition-transform duration-[var(--dur)]',
                    on ? 'translate-x-[21px] bg-[hsl(var(--app-raised))]' : 'translate-x-[2px] bg-app-text-muted')} />
            </button>
        </WhyDisabled>
    )
}

function Row({ label, value, tone, hint }: { label: string; value: string; tone?: Tone; hint?: string }) {
    return (
        <div className="flex items-center justify-between gap-3 min-h-8 text-[13px] px-2.5 py-1 rounded-md bg-app-surface-2" title={hint}>
            <span className="text-[13px] font-semibold text-app-text-muted shrink-0">{label}</span>
            <span className={cn('font-semibold text-right min-w-0 break-words', tone ? TEXT[tone] : 'text-app-text')}>{value}</span>
        </div>
    )
}

export function AvoidancePanel() {
    // Resolved by the shared, backed-off resolver (lib/droneId.ts) - this
    // panel and the Command strip used to each poll three endpoints every
    // 1.5 s for as long as no drone was attached.
    const droneId = useResolvedDroneId()
    // The learned hazard map is shared by every drone: staff clear it.
    const { isCustomer } = useAccess()
    const [status, setStatus] = useState<AvoidanceStatus | null>(null)
    const [events, setEvents] = useState<AvoidanceEvent[]>([])
    const [confirmArm, setConfirmArm] = useState(false)
    const [busy, setBusy] = useState(false)
    const [showTuning, setShowTuning] = useState(false)
    const [draft, setDraft] = useState<Partial<AvoidanceParams>>({})
    const [note, setNote] = useState<string | null>(null)

    const refresh = useCallback(async () => {
        if (!droneId) return
        try {
            const st = await getStatus(droneId)
            setStatus(st)
            setEvents(await getEvents(droneId, 4))
        } catch { /* backend away */ }
    }, [droneId])

    useEffect(() => {
        if (!droneId) return
        refresh()
        return visibleInterval(refresh, 1500)
    }, [droneId, refresh])

    const toggleDetection = useCallback(async () => {
        if (!droneId || busy) return
        setBusy(true)
        try { setStatus(await setEnabled(droneId, !status?.enabled)) }
        finally { setBusy(false); setConfirmArm(false) }
    }, [droneId, busy, status?.enabled])

    const arm = useCallback(async () => {
        if (!droneId || busy) return
        if (status?.armed) { setBusy(true); try { setStatus(await setArmed(droneId, false)) } finally { setBusy(false) }; return }
        if (!confirmArm) { setConfirmArm(true); setTimeout(() => setConfirmArm(false), 4000); return }
        setBusy(true)
        try { setStatus(await setArmed(droneId, true)) }
        finally { setBusy(false); setConfirmArm(false) }
    }, [droneId, busy, status?.armed, confirmArm])

    const applyTuning = useCallback(async () => {
        if (!droneId || !status || Object.keys(draft).length === 0) return
        setBusy(true)
        try { setStatus(await setEnabled(droneId, status.enabled, draft)); setDraft({}); setNote('tuning applied') }
        finally { setBusy(false); setTimeout(() => setNote(null), 2500) }
    }, [droneId, status, draft])

    const forget = useCallback(async () => {
        setBusy(true)
        try { const n = await clearHazards(); setNote(`forgot ${n} learned hazard(s)`) }
        finally { setBusy(false); setTimeout(() => setNote(null), 2500) }
    }, [])

    if (!droneId) {
        // A real empty state, said once for the whole area.
        return (
            <div className="flex flex-col items-center justify-center gap-2 py-8 px-4 text-center">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-app-surface-2 text-app-text-muted">
                    <Shield size={18} />
                </span>
                <p className="text-[14px] font-semibold text-app-text">Avoidance needs a drone</p>
                <p className="max-w-[260px] text-[13px] text-app-text-muted">
                    Link a drone to turn on detection and let it steer around obstacles.
                </p>
                <button type="button" onClick={() => window.dispatchEvent(new CustomEvent(FOCUS_LINK_EVENT))}
                    className={cn('mt-1 inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-app-border-strong text-[13px] font-bold text-app-text hover:bg-app-surface-2', FOCUS)}>
                    <Plug size={15} /> Connect a drone
                </button>
            </div>
        )
    }

    const state = status?.state ?? 'disabled'
    const tone: Tone = STATE_TONE[state] ?? 'muted'
    const nearest = status ? nearestAheadM(status.obstacle_distance_cm) : null
    // Any sensor streaming counts, exactly like the takeoff interlock: with the
    // sim's depth camera running, the mono path is switched off on purpose.
    const camOk = !!status?.sensors?.some(s => s.status === 'ok')
    const goal = status?.goal ?? null
    const p = status?.params

    return (
        <div className="flex flex-col gap-2.5">
            {/* header + state pill */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    {status?.armed
                        ? <ShieldAlert size={18} className={TEXT[tone]} />
                        : status?.enabled ? <ShieldCheck size={18} className={TEXT[tone]} />
                            : <Shield size={18} className={TEXT[tone]} />}
                    <span className="text-[14px] font-bold text-app-text">Obstacle avoidance</span>
                </div>
                <div className={cn('flex items-center gap-1.5 h-7 px-2.5 rounded-full', SOFT[tone])}>
                    <span className={cn('w-2 h-2 rounded-full', DOT[tone])} />
                    <span className={cn('text-[12px] font-bold', TEXT[tone])}>{state.charAt(0).toUpperCase() + state.slice(1)}</span>
                </div>
            </div>

            {/* the two switches */}
            <div className="flex items-center justify-between">
                <div className="flex flex-col">
                    <span className="text-[14px] font-semibold text-app-text">Detection</span>
                    <span className="text-[13px] text-app-text-muted">
                        Senses in the background, any tab
                    </span>
                </div>
                <Switch on={!!status?.enabled} onClick={toggleDetection} disabled={busy} why="Saving"
                    title={status?.enabled ? 'Turn detection off' : 'Turn detection on'} />
            </div>
            <div className="flex items-center justify-between">
                <div className="flex flex-col">
                    <span className={cn('text-[14px] font-semibold', confirmArm ? 'text-app-warn' : 'text-app-text')}>
                        {confirmArm ? 'Tap again to confirm' : 'Steer the aircraft'}
                    </span>
                    <span className="text-[13px] text-app-text-muted">
                        Reroute, hold or return on its own
                    </span>
                </div>
                <Switch on={!!status?.armed} onClick={arm} disabled={busy || !status?.enabled}
                    why={busy ? 'Saving' : 'Turn detection on first'}
                    onTone={confirmArm ? 'warn' : 'danger'}
                    title={status?.armed ? 'Stop steering (detection stays on)' : 'Allow avoidance to steer'} />
            </div>

            <div className="flex items-center justify-between gap-2">
                <label htmlFor="avoid-response" className="text-[14px] font-semibold text-app-text shrink-0">Response</label>
                <SimpleSelect id="avoid-response" value={responseOf(p)} disabled={busy || !status}
                    onValueChange={async v => {
                        const r = RESPONSES.find(x => x.value === v)
                        if (!r || !droneId || !status) return
                        setBusy(true)
                        try { setStatus(await setEnabled(droneId, status.enabled, r.flags)) }
                        finally { setBusy(false) }
                    }}
                    ariaLabel="Response"
                    title="What it may do on its own when the path is blocked. Order is always reroute, then hold, then return; this is how far it may go."
                    className="data-[size=default]:h-9 max-w-[62%] text-[13px]"
                    options={RESPONSES.map(r => ({ value: r.value, label: r.label }))} />
            </div>

            {status?.armed && !camOk && (
                <div role="alert" className="flex items-start gap-2 text-[13px] px-2.5 py-2 rounded-md border border-app-warn bg-app-warn-soft text-app-text">
                    <TriangleAlert size={15} className="mt-0.5 shrink-0 text-app-warn" />
                    <span><b className="text-app-warn">No video.</b> Steering is on but the camera is not feeding. Start the video: arming and takeoff are refused until it is.</span>
                </div>
            )}
            {status?.armed && camOk && (
                <div className="flex items-start gap-2 text-[13px] px-2.5 py-2 rounded-md border border-app-danger bg-app-danger-soft text-app-text">
                    <TriangleAlert size={15} className="mt-0.5 shrink-0 text-app-danger" />
                    <span><b className="text-app-danger">Steering on.</b> Avoidance may steer, hold or return this drone. A mode switch on the RC hands it back at once.</span>
                </div>
            )}

            {/* what it sees and knows */}
            <div className="flex flex-col gap-1">
                <Row label="Camera" value={camOk ? 'feeding' : status?.enabled ? 'No video' : 'Off'}
                    tone={camOk ? 'ok' : status?.enabled ? 'warn' : undefined}
                    hint="Depth observations arriving from this session's video. Connect the camera before takeoff." />
                <Row label="Destination" value={goal ? `${goal[0].toFixed(5)}, ${goal[1].toFixed(5)}` : 'unknown - upload a mission'}
                    tone={goal ? undefined : 'warn'}
                    hint="Without a destination it can only hold, never route around." />
                <Row label="Nearest ahead"
                    value={`${nearest !== null ? `${nearest.toFixed(1)} m` : 'clear'}${status?.obstacle_count ? `  (${status.obstacle_count} tracked)` : ''}`}
                    tone={nearest !== null && nearest < (p?.reaction_distance_m ?? 12) ? 'warn' : undefined} />
                {status?.enabled && (
                    <Row label="Sensor"
                        value={status.sensor_mode === 'range' ? 'depth camera (measured range)'
                            : status.sensor_mode === 'mono'
                                ? `camera (estimated${status.mono_calibration?.error_pct_p50 != null ? `, ground-fit err ${status.mono_calibration.error_pct_p50}%` : ', not calibrated yet'})`
                                : 'none'}
                        tone={status.sensor_mode === 'range' ? 'ok' : status.sensor_mode === 'mono' ? 'warn' : undefined}
                        hint={`What the map is built from. Camera-only: senses above ${p?.mono_min_alt_m ?? 8} m, capped at ${p?.mono_speed_cap_m_s ?? 1.5} m/s. Pose ${status.pose_rate_hz ?? 0} Hz.`} />
                )}
                {status?.state === 'avoiding' && status.planner && (
                    <Row label="Steering"
                        value={`${status.planner.reason}${status.planner.ttc_s != null ? `  TTC ${status.planner.ttc_s}s` : ''}  ${status.planner.speed_m_s.toFixed(1)} m/s`}
                        tone="accent" hint="The local planner has the aircraft in Offboard; it hands back to the mission once the way to the waypoint is clear." />
                )}
                {!!status?.recommended_speed_m_s && status.enabled && (
                    <Row label="Speed" value={`${status.recommended_speed_m_s.toFixed(1)} m/s`}
                        hint="What the governor is asking of the aircraft right now." />
                )}
            </div>

            {/* tuning */}
            <button onClick={() => setShowTuning(v => !v)} aria-expanded={showTuning}
                className={cn('self-start flex items-center gap-1 h-8 pr-2 rounded-md text-[13px] font-bold text-app-text-muted hover:text-app-text', FOCUS)}>
                {showTuning ? <ChevronDown size={15} /> : <ChevronRight size={15} />} Tuning
            </button>
            {showTuning && p && (
                <div className="flex flex-col gap-1.5">
                    {TUNING.map(t => (
                        <div key={t.key} className="flex items-center gap-2" title={t.hint}>
                            <label htmlFor={`avoid-${t.key}`} className="text-[13px] font-semibold w-24 shrink-0 text-app-text-muted">{t.label}</label>
                            <input id={`avoid-${t.key}`} type="number" step={t.step} min={t.min} max={t.max}
                                value={draft[t.key] ?? p[t.key]}
                                onChange={e => setDraft(d => ({ ...d, [t.key]: Number(e.target.value) }))}
                                className={cn('h-8 w-full rounded-md px-2 text-[14px] font-semibold tabular-nums bg-app-surface border border-app-border-strong text-app-text', FOCUS)} />
                            <span className="text-[12px] w-10 shrink-0 text-app-text-muted">{t.unit}</span>
                        </div>
                    ))}
                    <div className="flex gap-2">
                        <WhyDisabled reason={busy ? 'Saving' : Object.keys(draft).length === 0 ? 'Change a value first' : null} className="flex-1">
                            <button onClick={applyTuning} disabled={busy || Object.keys(draft).length === 0}
                                className={cn('w-full h-9 text-[13px] font-bold rounded-md border border-app-accent bg-app-accent text-[var(--app-accent-ink)] hover:brightness-110', FOCUS, DISABLED)}>
                                Apply
                            </button>
                        </WhyDisabled>
                        {!isCustomer && <button onClick={forget} disabled={busy}
                            className={cn('flex-1 h-9 text-[13px] font-bold rounded-md border border-app-danger text-app-danger hover:bg-app-danger-soft', FOCUS, DISABLED)}
                            title="Clear every obstacle it has learned and stored. Do this before an honest re-run.">
                            Forget hazards
                        </button>}
                    </div>
                </div>
            )}

            {/* last actions */}
            {events.length > 0 && (
                <div className="flex flex-col gap-0.5">
                    {events.slice(0, 3).map(e => (
                        <div key={e.id} className={cn('text-[13px] truncate', TEXT[STATE_TONE[e.state] ?? 'muted'])} title={e.reason}>
                            {e.t ? new Date(e.t).toLocaleTimeString([], { hour12: false }) : ''} {e.action.replace(/_/g, ' ')} - {e.reason}
                        </div>
                    ))}
                </div>
            )}
            {(note || status?.reason) && (
                <span role="status" className={cn('text-[13px]', note ? 'text-app-ok font-semibold' : 'text-app-text-muted')}>
                    {note ?? status?.reason}
                </span>
            )}
        </div>
    )
}
