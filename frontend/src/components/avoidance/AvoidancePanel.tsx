'use client'

// The Fly-tab obstacle-avoidance control. Detection and control are two
// deliberate steps: DETECTION turns on sensing (advisory - it detects and
// shows, commands nothing), ARM then allows the cloud to actually take
// control. Arm is a two-tap confirm because it hands an aircraft to the
// avoidance loop. Below the switches: what the loop can see and knows
// (camera feeding? destination known?), the tuning that decides how early
// and how wide it dodges, and the last things it did.
import { useCallback, useEffect, useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { getServerUrl } from '@/lib/server-url'
import { visibleInterval } from '@/lib/poll'
import { ShieldCheck, ShieldAlert, Shield, TriangleAlert, ChevronDown, ChevronRight } from 'lucide-react'
import {
    getStatus, setEnabled, setArmed, getEvents, clearHazards, nearestAheadM,
    type AvoidanceStatus, type AvoidanceEvent, type AvoidanceParams,
} from '@/lib/avoidance'

const STATE_COLOR: Record<string, string> = {
    nominal: '#4ade80', holding: '#fbbf24', rerouted: '#22d3ee',
    climbing: '#a78bfa', avoiding: '#22d3ee', returning: '#f87171', disabled: '#8a94a8',
}

// The knobs worth exposing, with what each one means to the pilot.
const TUNING: { key: keyof AvoidanceParams; label: string; unit: string; step: number; min: number; max: number; hint: string }[] = [
    { key: 'reaction_distance_m', label: 'REACT AT', unit: 'm', step: 1, min: 4, max: 40,
      hint: 'Obstacle closer than this -> act. A mono camera judges ~25 m; keep this below it.' },
    { key: 'clearance_m', label: 'CLEARANCE', unit: 'm', step: 1, min: 1, max: 20,
      hint: 'Extra keep-out around every obstacle. Depth underestimates range, so err wide.' },
    { key: 'speed_cap_m_s', label: 'SPEED CAP', unit: 'm/s', step: 0.5, min: 1, max: 12,
      hint: 'Cruise while avoidance is on. Slower buys the camera reaction time.' },
    { key: 'hold_to_return_s', label: 'HOLD -> RTL', unit: 's', step: 5, min: 5, max: 120,
      hint: 'Holding with no path this long -> return to launch.' },
    { key: 'local_clearance_m', label: 'STEER GAP', unit: 'm', step: 0.05, min: 0.3, max: 8,
      hint: 'Distance the local planner keeps from every obstacle while it steers (body + margin).' },
    { key: 'ttc_engage_s', label: 'TAKE OVER AT', unit: 's TTC', step: 0.5, min: 2, max: 10,
      hint: 'Take control when closing on something faster than this, whatever its distance.' },
    { key: 'mono_speed_cap_m_s', label: 'MONO SPEED', unit: 'm/s', step: 0.5, min: 0.5, max: 5,
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

type Toggle = { on: boolean; onClick: () => void; disabled?: boolean; title: string; onColor?: string }

function Switch({ on, onClick, disabled, title, onColor = '#22d3ee' }: Toggle) {
    return (
        <button onClick={onClick} disabled={disabled} role="switch" aria-checked={on} title={title}
            className="relative w-10 h-[22px] rounded-full transition-colors duration-200 shrink-0 border focus:outline-none disabled:opacity-40"
            style={{
                background: on ? onColor : 'hsl(var(--app-surface-2))',
                borderColor: on ? onColor : 'hsl(var(--app-border))',
            }}>
            <span className={`absolute left-0 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-white shadow-md transition-transform duration-200 ${on ? 'translate-x-[21px]' : 'translate-x-[3px]'}`} />
        </button>
    )
}

function Row({ label, value, color, hint }: { label: string; value: string; color?: string; hint?: string }) {
    return (
        <div className="flex items-center justify-between text-[11px] font-mono px-2 py-1 rounded"
            style={{ background: 'hsl(var(--app-surface-2))' }} title={hint}>
            <span style={{ color: 'hsl(var(--app-text-muted))' }}>{label}</span>
            <span style={{ color: color ?? 'hsl(var(--app-text))' }}>{value}</span>
        </div>
    )
}

export function AvoidancePanel() {
    const sessionId = useDroneStore(s => s.session?.session_id)
    const telemetryStatus = useDroneStore(s => s.telemetryStatus)
    const [droneId, setDroneId] = useState<string | null>(null)
    const [status, setStatus] = useState<AvoidanceStatus | null>(null)
    const [events, setEvents] = useState<AvoidanceEvent[]>([])
    const [confirmArm, setConfirmArm] = useState(false)
    const [busy, setBusy] = useState(false)
    const [showTuning, setShowTuning] = useState(false)
    const [draft, setDraft] = useState<Partial<AvoidanceParams>>({})
    const [note, setNote] = useState<string | null>(null)

    // Resolve THIS session's drone. The identity arrives a few seconds AFTER
    // telemetry connects (the FC's UID is read asynchronously), so this is
    // polled until it resolves, and re-run whenever the link state changes -
    // a one-shot lookup at session creation stayed at "connect a drone"
    // forever. Falls back to the fleet's single drone (sim, station drone).
    useEffect(() => {
        let alive = true
        const resolve = async () => {
            try {
                const j = await fetch(`${getServerUrl()}/api/sessions`).then(r => r.json())
                const mine = (j.sessions ?? []).find((s: { session_id?: string }) => s.session_id === sessionId)
                if (mine?.drone?.id) { if (alive) setDroneId(mine.drone.id); return }
                const f = await fetch(`${getServerUrl()}/api/fleet`).then(r => r.json())
                const fleet = (f.fleet ?? []).filter((d: { connected?: boolean }) => d.connected)
                if (fleet.length === 1) { if (alive) setDroneId(fleet[0].db_id); return }
                // Last resort: the one drone that has avoidance configured.
                const a = await fetch(`${getServerUrl()}/api/avoidance/status`).then(r => r.json())
                const ds = (a.drones ?? []) as { drone_id: string; enabled: boolean }[]
                if (alive) setDroneId(ds.length === 1 ? ds[0].drone_id : null)
            } catch { /* backend away */ }
        }
        resolve()
        const stop = visibleInterval(resolve, 1500)
        return () => { alive = false; stop() }
    }, [sessionId, telemetryStatus])

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
        return (
            <div className="text-xs font-mono py-3 text-center"
                style={{ color: 'hsl(var(--app-text-muted))' }}>
                Connect telemetry (or a fleet drone) to configure avoidance
            </div>
        )
    }

    const state = status?.state ?? 'disabled'
    const color = STATE_COLOR[state] ?? '#8a94a8'
    const nearest = status ? nearestAheadM(status.obstacle_distance_cm) : null
    // Any sensor streaming counts, exactly like the takeoff interlock: with the
    // sim's depth camera running, the mono path is switched off on purpose.
    const camOk = !!status?.sensors.some(s => s.status === 'ok')
    const goal = (status as (AvoidanceStatus & { goal?: [number, number] | null }) | null)?.goal ?? null
    const p = status?.params

    return (
        <div className="flex flex-col gap-2.5">
            {/* header + state pill */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    {status?.armed
                        ? <ShieldAlert size={16} style={{ color }} />
                        : status?.enabled ? <ShieldCheck size={16} style={{ color }} />
                            : <Shield size={16} style={{ color }} />}
                    <span className="text-xs font-mono tracking-wide"
                        style={{ color: 'hsl(var(--app-text))' }}>OBSTACLE AVOIDANCE</span>
                </div>
                <div className="flex items-center gap-1.5 px-2 py-0.5 rounded"
                    style={{ background: `${color}1a` }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
                    <span className="text-[10px] font-mono" style={{ color }}>{state.toUpperCase()}</span>
                </div>
            </div>

            {/* the two switches */}
            <div className="flex items-center justify-between">
                <div className="flex flex-col">
                    <span className="text-xs font-mono" style={{ color: 'hsl(var(--app-text))' }}>Detection</span>
                    <span className="text-[10px] font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>
                        camera depth runs in the background, any tab
                    </span>
                </div>
                <Switch on={!!status?.enabled} onClick={toggleDetection} disabled={busy}
                    title={status?.enabled ? 'Turn detection off' : 'Turn detection on'} />
            </div>
            <div className="flex items-center justify-between">
                <div className="flex flex-col">
                    <span className="text-xs font-mono" style={{ color: 'hsl(var(--app-text))' }}>
                        {confirmArm ? 'Tap again to confirm' : 'Steer the aircraft'}
                    </span>
                    <span className="text-[10px] font-mono" style={{ color: confirmArm ? '#fbbf24' : 'hsl(var(--app-text-muted))' }}>
                        reroute / hold / return on its own
                    </span>
                </div>
                <Switch on={!!status?.armed} onClick={arm} disabled={busy || !status?.enabled}
                    onColor={confirmArm ? '#fbbf24' : '#f87171'}
                    title={status?.armed ? 'Stop steering (detection stays on)' : 'Allow avoidance to steer'} />
            </div>

            <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-mono shrink-0" style={{ color: 'hsl(var(--app-text))' }}>Response</span>
                <select value={responseOf(p)} disabled={busy || !status}
                    onChange={async e => {
                        const r = RESPONSES.find(x => x.value === e.target.value)
                        if (!r || !droneId || !status) return
                        setBusy(true)
                        try { setStatus(await setEnabled(droneId, status.enabled, r.flags)) }
                        finally { setBusy(false) }
                    }}
                    title="What it may do on its own when the path is blocked. Order is always reroute, then hold, then return; this is how far it may go."
                    className="h-7 max-w-[62%] rounded px-1.5 text-[10px] font-mono bg-app-surface border border-app-border text-app-text outline-none">
                    {RESPONSES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
            </div>

            {status?.armed && !camOk && (
                <div className="flex items-start gap-2 text-[10px] font-mono px-2 py-1.5 rounded"
                    style={{ background: '#fbbf2418', color: '#fbbf24' }}>
                    <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                    <span>NO VIDEO - steering is on but the camera is not feeding. Start the video first; arming and takeoff are refused until it is.</span>
                </div>
            )}
            {status?.armed && camOk && (
                <div className="flex items-start gap-2 text-[10px] font-mono px-2 py-1.5 rounded"
                    style={{ background: '#f8717112', color: '#f87171' }}>
                    <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                    <span>ARMED - avoidance may steer this drone around obstacles (Offboard), hold it or return it. Switching mode on the RC hands it back to you at once.</span>
                </div>
            )}

            {/* what it sees and knows */}
            <div className="flex flex-col gap-1">
                <Row label="CAMERA" value={camOk ? 'feeding' : status?.enabled ? 'NO VIDEO' : '--'}
                    color={camOk ? '#4ade80' : status?.enabled ? '#fbbf24' : undefined}
                    hint="Depth observations arriving from this session's video. Connect the camera BEFORE takeoff." />
                <Row label="DESTINATION" value={goal ? `${goal[0].toFixed(5)}, ${goal[1].toFixed(5)}` : 'unknown - upload a mission'}
                    color={goal ? undefined : '#fbbf24'}
                    hint="Without a destination it can only hold, never route around." />
                <Row label="NEAREST AHEAD"
                    value={`${nearest !== null ? `${nearest.toFixed(1)} m` : 'clear'}${status?.obstacle_count ? `  (${status.obstacle_count} tracked)` : ''}`}
                    color={nearest !== null && nearest < (p?.reaction_distance_m ?? 12) ? '#fbbf24' : undefined} />
                {status?.enabled && (
                    <Row label="SENSOR"
                        value={status.sensor_mode === 'range' ? 'depth camera (measured range)'
                            : status.sensor_mode === 'mono'
                                ? `camera (estimated${status.mono_calibration?.error_pct_p50 != null ? `, ground-fit err ${status.mono_calibration.error_pct_p50}%` : ', not calibrated yet'})`
                                : 'none'}
                        color={status.sensor_mode === 'range' ? '#4ade80' : status.sensor_mode === 'mono' ? '#fbbf24' : undefined}
                        hint={`What the map is built from. Camera-only: senses above ${p?.mono_min_alt_m ?? 8} m, capped at ${p?.mono_speed_cap_m_s ?? 1.5} m/s. Pose ${status.pose_rate_hz ?? 0} Hz.`} />
                )}
                {status?.state === 'avoiding' && status.planner && (
                    <Row label="STEERING"
                        value={`${status.planner.reason}${status.planner.ttc_s != null ? `  TTC ${status.planner.ttc_s}s` : ''}  ${status.planner.speed_m_s.toFixed(1)} m/s`}
                        color="#22d3ee" hint="The local planner has the aircraft in Offboard; it hands back to the mission once the way to the waypoint is clear." />
                )}
                {!!status?.recommended_speed_m_s && status.enabled && (
                    <Row label="SPEED" value={`${status.recommended_speed_m_s.toFixed(1)} m/s`}
                        hint="What the governor is asking of the aircraft right now." />
                )}
            </div>

            {/* tuning */}
            <button onClick={() => setShowTuning(v => !v)}
                className="flex items-center gap-1 text-[10px] font-mono tracking-widest"
                style={{ color: 'hsl(var(--app-text-muted))' }}>
                {showTuning ? <ChevronDown size={12} /> : <ChevronRight size={12} />} TUNING
            </button>
            {showTuning && p && (
                <div className="flex flex-col gap-1.5">
                    {TUNING.map(t => (
                        <div key={t.key} className="flex items-center gap-2" title={t.hint}>
                            <span className="text-[10px] font-mono w-24 shrink-0" style={{ color: 'hsl(var(--app-text-muted))' }}>{t.label}</span>
                            <input type="number" step={t.step} min={t.min} max={t.max}
                                value={draft[t.key] ?? p[t.key]}
                                onChange={e => setDraft(d => ({ ...d, [t.key]: Number(e.target.value) }))}
                                className="h-7 w-full rounded px-2 text-[11px] font-mono bg-app-surface border border-app-border text-app-text outline-none" />
                            <span className="text-[10px] font-mono w-8" style={{ color: 'hsl(var(--app-text-muted))' }}>{t.unit}</span>
                        </div>
                    ))}
                    <div className="flex gap-2">
                        <button onClick={applyTuning} disabled={busy || Object.keys(draft).length === 0}
                            className="flex-1 text-[11px] font-mono py-1.5 rounded border disabled:opacity-40"
                            style={{ borderColor: '#22d3ee55', color: '#22d3ee', background: '#22d3ee12' }}>
                            APPLY
                        </button>
                        <button onClick={forget} disabled={busy}
                            className="flex-1 text-[11px] font-mono py-1.5 rounded border disabled:opacity-40"
                            style={{ borderColor: 'hsl(var(--app-border))', color: 'hsl(var(--app-text-muted))' }}
                            title="Clear every obstacle it has learned and stored. Do this before an honest re-run.">
                            FORGET HAZARDS
                        </button>
                    </div>
                </div>
            )}

            {/* last actions */}
            {events.length > 0 && (
                <div className="flex flex-col gap-0.5">
                    {events.slice(0, 3).map(e => (
                        <div key={e.id} className="text-[10px] font-mono truncate" title={e.reason}
                            style={{ color: STATE_COLOR[e.state] ?? 'hsl(var(--app-text-muted))' }}>
                            {e.t ? new Date(e.t).toLocaleTimeString([], { hour12: false }) : ''} {e.action.toUpperCase()} - {e.reason}
                        </div>
                    ))}
                </div>
            )}
            {(note || status?.reason) && (
                <span className="text-[10px] font-mono" style={{ color: note ? '#4ade80' : 'hsl(var(--app-text-muted))' }}>
                    {note ?? status?.reason}
                </span>
            )}
        </div>
    )
}
