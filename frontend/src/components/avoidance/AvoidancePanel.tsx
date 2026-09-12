'use client'

// The Fly-tab obstacle-avoidance control. Detection and control are two
// deliberate steps: ENABLE turns on sensing (advisory - it detects and shows,
// commands nothing), ARM then allows the cloud to actually take control. Arm
// is a two-tap confirm because it hands an aircraft to the avoidance loop.
import { useCallback, useEffect, useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { getServerUrl } from '@/lib/server-url'
import { visibleInterval } from '@/lib/poll'
import { ShieldCheck, ShieldAlert, Shield, TriangleAlert } from 'lucide-react'
import {
    getStatus, setEnabled, setArmed, nearestAheadM,
    type AvoidanceStatus,
} from '@/lib/avoidance'

const STATE_COLOR: Record<string, string> = {
    nominal: '#4ade80', holding: '#fbbf24', rerouted: '#22d3ee',
    climbing: '#a78bfa', returning: '#f87171', disabled: '#8a94a8',
}

export function AvoidancePanel() {
    const sessionId = useDroneStore(s => s.session?.session_id)
    const [droneId, setDroneId] = useState<string | null>(null)
    const [status, setStatus] = useState<AvoidanceStatus | null>(null)
    const [confirmArm, setConfirmArm] = useState(false)
    const [busy, setBusy] = useState(false)

    // Resolve THIS session's drone db id from /sessions.
    useEffect(() => {
        let alive = true
        fetch(`${getServerUrl()}/api/sessions`).then(r => r.json()).then(j => {
            if (!alive) return
            const mine = (j.sessions ?? []).find((s: { session_id?: string }) =>
                s.session_id === sessionId)
            setDroneId(mine?.drone?.id ?? null)
        }).catch(() => {})
        return () => { alive = false }
    }, [sessionId])

    const refresh = useCallback(async () => {
        if (!droneId) return
        try { setStatus(await getStatus(droneId)) } catch { /* backend away */ }
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

    if (!droneId) {
        return (
            <div className="text-xs font-mono py-3 text-center"
                style={{ color: 'hsl(var(--app-text-muted))' }}>
                Connect a drone to enable obstacle avoidance
            </div>
        )
    }

    const state = status?.state ?? 'disabled'
    const color = STATE_COLOR[state] ?? '#8a94a8'
    const nearest = status ? nearestAheadM(status.obstacle_distance_cm) : null

    return (
        <div className="flex flex-col gap-3">
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

            {/* nearest obstacle readout */}
            <div className="flex items-center justify-between text-[11px] font-mono px-2 py-1.5 rounded"
                style={{ background: 'hsl(var(--app-surface-2))' }}>
                <span style={{ color: 'hsl(var(--app-text-muted))' }}>NEAREST AHEAD</span>
                <div className="flex items-center gap-3">
                    {!!status?.obstacle_count && (
                        <span style={{ color: 'hsl(var(--app-text-muted))' }}>
                            {status.obstacle_count} tracked
                        </span>
                    )}
                    <span style={{ color: nearest !== null && nearest < 8 ? '#fbbf24' : 'hsl(var(--app-text))' }}>
                        {nearest !== null ? `${nearest.toFixed(1)} m` : 'clear'}
                    </span>
                </div>
            </div>

            {/* detection toggle + arm */}
            <div className="flex gap-2">
                <button onClick={toggleDetection} disabled={busy}
                    className="flex-1 text-xs font-mono py-2 rounded border transition-colors"
                    style={{
                        borderColor: status?.enabled ? '#22d3ee55' : 'hsl(var(--app-border))',
                        background: status?.enabled ? '#22d3ee18' : 'hsl(var(--app-surface-2))',
                        color: status?.enabled ? '#22d3ee' : 'hsl(var(--app-text-muted))',
                    }}>
                    {status?.enabled ? 'DETECTION ON' : 'DETECTION OFF'}
                </button>
                <button onClick={arm} disabled={busy || !status?.enabled}
                    className="flex-1 text-xs font-mono py-2 rounded border transition-colors disabled:opacity-40"
                    style={{
                        borderColor: status?.armed ? '#f8717155' : confirmArm ? '#fbbf2455' : 'hsl(var(--app-border))',
                        background: status?.armed ? '#f8717118' : confirmArm ? '#fbbf2418' : 'hsl(var(--app-surface-2))',
                        color: status?.armed ? '#f87171' : confirmArm ? '#fbbf24' : 'hsl(var(--app-text-muted))',
                    }}>
                    {status?.armed ? 'DISARM' : confirmArm ? 'CONFIRM ARM' : 'ARM CONTROL'}
                </button>
            </div>

            {/* armed warning */}
            {status?.armed && (
                <div className="flex items-start gap-2 text-[10px] font-mono px-2 py-1.5 rounded"
                    style={{ background: '#f8717112', color: '#f87171' }}>
                    <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                    <span>ARMED - the cloud may hold, reroute or return this drone. You can override any time.</span>
                </div>
            )}

            {/* sensor health */}
            {status && status.sensors.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {status.sensors.map(s => (
                        <span key={s.kind} className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                            style={{
                                background: s.status === 'ok' ? '#4ade8018' : 'hsl(var(--app-surface-2))',
                                color: s.status === 'ok' ? '#4ade80' : 'hsl(var(--app-text-muted))',
                            }}>
                            {s.kind.toUpperCase()} {s.status === 'ok' ? 'OK' : '--'}
                        </span>
                    ))}
                </div>
            )}
            {status?.reason && (
                <span className="text-[10px] font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>
                    {status.reason}
                </span>
            )}
        </div>
    )
}
