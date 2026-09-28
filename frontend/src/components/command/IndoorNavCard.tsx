'use client'

// Indoor navigation - the add-on switch for flying without GPS. Auto decides
// from GPS and what the camera sees (sky, ceiling, near walls); Indoor /
// Outdoor pin it. Indoors avoidance uses PX4's LOCAL position (optical flow,
// rangefinder, visual odometry or motion capture - whatever feeds the
// autopilot's estimator) and a room-sized profile: 0.45 m clearance, 1 m/s,
// no climbing. See backend app/avoidance/core/controller.py INDOOR_PROFILE.

import { useState } from 'react'
import { Building2, Loader2, Trees } from 'lucide-react'
import { setEnabled, type AvoidanceStatus } from '@/lib/avoidance'

const MODES: { v: number; label: string }[] = [
    { v: 0, label: 'AUTO' }, { v: 2, label: 'INDOOR' }, { v: 1, label: 'OUTDOOR' },
]

export function IndoorNavCard({ avoid }: { avoid: AvoidanceStatus | null }) {
    const [busy, setBusy] = useState(false)
    const muted = { color: 'hsl(var(--app-text-muted))' }
    const box = 'rounded-lg border p-3 flex flex-col gap-2'
    const border = { borderColor: 'hsl(var(--app-border))' }

    if (!avoid || !avoid.enabled) {
        return (
            <div className={box} style={border}>
                <Title />
                <p className="text-[11px]" style={muted}>Turn on avoidance Detection (AVOID tab) to use indoor navigation.</p>
            </div>
        )
    }
    if (avoid.env === undefined) {
        return (
            <div className={box} style={border}>
                <Title />
                <p className="text-[11px]" style={muted}>Needs the backend update - restart the backend once the aircraft is on the ground.</p>
            </div>
        )
    }
    const mode = avoid.env_mode ?? 0
    const indoor = avoid.env === 'indoor'
    const set = async (v: number) => {
        setBusy(true)
        try { await setEnabled(avoid.drone_id, avoid.enabled, { env_mode: v }) } finally { setBusy(false) }
    }
    return (
        <div className={box} style={border}>
            <div className="flex items-center justify-between">
                <Title />
                {busy && <Loader2 size={13} className="animate-spin" />}
            </div>
            <div className="flex rounded-md border overflow-hidden text-[10px] font-mono tracking-widest" style={border}>
                {MODES.map(m => (
                    <button key={m.v} onClick={() => { void set(m.v) }} disabled={busy}
                        className="flex-1 h-8"
                        style={mode === m.v ? { background: 'rgba(34,211,238,.18)', color: '#67e8f9' } : muted}>
                        {m.label}
                    </button>
                ))}
            </div>
            <div className="flex items-center gap-2 text-[12px] font-mono">
                {indoor ? <Building2 size={14} className="text-amber-300" /> : <Trees size={14} className="text-emerald-300" />}
                <span className={indoor ? 'text-amber-200' : 'text-emerald-200'}>{indoor ? 'INDOOR' : 'OUTDOOR'}</span>
                <span className="text-[10.5px] truncate" style={muted} title={avoid.env_reason}>{avoid.env_reason}</span>
            </div>
            <div className="text-[10.5px] font-mono" style={muted}>
                Position from: <span className="text-zinc-200">
                    {avoid.pose_source === 'local' ? 'PX4 local (flow / rangefinder / VIO)'
                        : avoid.pose_source === 'gps' ? 'GPS' : 'no position yet'}</span>
            </div>
            {indoor && (
                <ul className="text-[10.5px] leading-snug list-disc pl-4" style={muted}>
                    <li>The autopilot needs its own position without GPS: optical flow + downward rangefinder, visual odometry or motion capture.</li>
                    <li>Link-loss action: Land or Hold - Return needs GPS.</li>
                    <li>Clearance 0.45 m (x500): gaps under ~1.2 m are refused. Smaller airframe? Lower STEER GAP under AVOID - Tuning (indoor only; outdoor values come back when you leave).</li>
                </ul>
            )}
        </div>
    )
}

function Title() {
    return <span className="text-[11px] font-mono tracking-widest" style={{ color: 'hsl(var(--app-text-muted))' }}>INDOOR NAVIGATION</span>
}
