'use client'

// Indoor navigation - the add-on switch for flying without GPS. Auto decides
// from GPS and what the camera sees (sky, ceiling, near walls); Indoor /
// Outdoor pin it. Indoors avoidance uses PX4's LOCAL position (optical flow,
// rangefinder, visual odometry or motion capture - whatever feeds the
// autopilot's estimator) and a room-sized profile: 0.45 m clearance, 1 m/s,
// no climbing. See backend app/avoidance/core/controller.py INDOOR_PROFILE.

import { useState } from 'react'
import { Building2, Loader2, Trees } from 'lucide-react'
import { setParams, type AvoidanceStatus } from '@/lib/avoidance'
import { cn } from '@/lib/utils'
import { FOCUS } from '@/components/controls/flightStyles'

const MODES: { v: number; label: string }[] = [
    { v: 0, label: 'AUTO' }, { v: 2, label: 'INDOOR' }, { v: 1, label: 'OUTDOOR' },
]

export function IndoorNavCard({ avoid }: { avoid: AvoidanceStatus | null }) {
    const [busy, setBusy] = useState(false)
    const [err, setErr] = useState<string | null>(null)
    const box = 'rounded-[10px] border border-app-border bg-app-surface p-3 flex flex-col gap-2'

    if (!avoid || !avoid.enabled) {
        return (
            <div className={box}>
                <Title />
                <p className="text-[13px] text-app-text-muted">Turn on Detection in the Avoid tab first.</p>
            </div>
        )
    }
    if (avoid.env === undefined) {
        return (
            <div className={box}>
                <Title />
                <p className="text-[13px] text-app-text-muted">Needs the backend update - restart the backend once the aircraft is on the ground.</p>
            </div>
        )
    }
    const mode = avoid.env_mode ?? 0
    const indoor = avoid.env === 'indoor'
    const set = async (v: number) => {
        setBusy(true); setErr(null)
        try { await setParams(avoid.drone_id, { env_mode: v }) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
    }
    return (
        <div className={box}>
            <div className="flex items-center justify-between">
                <Title />
                {busy && <Loader2 size={13} className="animate-spin" />}
            </div>
            <div className="flex gap-0.5 p-0.5 rounded-md border border-app-border bg-app-surface-2 text-[13px] font-bold" role="group" aria-label="Navigation environment">
                {MODES.map(m => (
                    <button key={m.v} onClick={() => { void set(m.v) }} disabled={busy} aria-pressed={mode === m.v}
                        className={cn('flex-1 h-8 rounded transition-colors duration-[var(--dur-fast)] disabled:cursor-wait', FOCUS,
                            mode === m.v ? 'bg-app-surface text-app-accent shadow-[inset_0_-2px_0_var(--app-accent)]' : 'text-app-text-muted hover:text-app-text')}>
                        {m.label}
                    </button>
                ))}
            </div>
            {err && <p role="alert" className="text-[13px] text-app-danger">{err}</p>}
            <div className="flex items-center gap-2 text-[13px]">
                {indoor ? <Building2 size={15} className="text-app-warn" /> : <Trees size={15} className="text-app-ok" />}
                <span className={cn('font-bold', indoor ? 'text-app-warn' : 'text-app-ok')}>{indoor ? 'INDOOR' : 'OUTDOOR'}</span>
                <span className="truncate text-app-text-muted" title={avoid.env_reason}>{avoid.env_reason}</span>
            </div>
            <div className="text-[13px] text-app-text-muted">
                Position from: <span className="font-semibold text-app-text">
                    {avoid.pose_source === 'local' ? 'PX4 local (flow / rangefinder / VIO)'
                        : avoid.pose_source === 'gps' ? 'GPS' : 'no position yet'}</span>
            </div>
            {indoor && (
                <ul className="text-[13px] leading-snug list-disc pl-4 text-app-text-muted">
                    <li>The autopilot needs its own position without GPS: optical flow + downward rangefinder, visual odometry or motion capture.</li>
                    <li>Link-loss action: Land or Hold - Return needs GPS.</li>
                    <li>Clearance 0.45 m (x500): gaps under ~1.2 m are refused. Smaller airframe? Lower STEER GAP under AVOID - Tuning (indoor only; outdoor values come back when you leave).</li>
                </ul>
            )}
        </div>
    )
}

function Title() {
    return <span className="text-[14px] font-bold text-app-text">Indoor navigation</span>
}
