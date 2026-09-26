'use client'

// The flight actions, on the edge of the view where the eye already is:
// arm, take off, fly the mission, hold, return, land, kill. Same commands the
// Fly tab's buttons send (useDrone.sendAction), laid out for a pilot watching
// the picture. KILL needs a second tap within 3 s.

import { useEffect, useState } from 'react'
import { ArrowDownToLine, Home, Loader2, Minus, OctagonX, PauseCircle, Play, Plus, Power, Rocket } from 'lucide-react'
import { useDrone } from '@/hooks/useDrone'
import { useDroneStore } from '@/store/drone'

function RailButton({ icon, label, onClick, tone = 'default', active, pending, disabled, title }: {
    icon: React.ReactNode; label: string; onClick: () => void
    tone?: 'default' | 'danger' | 'go'; active?: boolean; pending?: boolean; disabled?: boolean; title?: string
}) {
    const base = tone === 'danger' ? '#f87171' : tone === 'go' ? '#4ade80' : '#e5e7eb'
    return (
        <button onClick={onClick} disabled={disabled} title={title ?? label}
            className="w-[58px] h-[52px] rounded-lg border flex flex-col items-center justify-center gap-0.5 transition-colors disabled:opacity-35"
            style={{
                background: active ? 'rgba(34,211,238,.22)' : 'rgba(9,11,16,.78)',
                borderColor: active ? 'rgba(34,211,238,.6)' : 'rgba(255,255,255,.12)',
                color: base, backdropFilter: 'blur(8px)',
            }}>
            {pending ? <Loader2 size={16} className="animate-spin" /> : icon}
            <span className="text-[9px] font-mono font-bold tracking-wider">{label}</span>
        </button>
    )
}

export function ActionRail() {
    const { sendAction, arm, disarm, emergencyStop } = useDrone()
    const { telemetry: t, telemetryStatus, pendingAction, lastActionResult } = useDroneStore()
    const [alt, setAlt] = useState(10)
    const [killArmed, setKillArmed] = useState(false)
    const [flash, setFlash] = useState<string | null>(null)

    useEffect(() => {
        if (!killArmed) return
        const id = setTimeout(() => setKillArmed(false), 3000)
        return () => clearTimeout(id)
    }, [killArmed])

    useEffect(() => {                 // show the aircraft's answer for a moment
        if (!lastActionResult) return
        const r = lastActionResult as { action?: string; ok?: boolean; error?: string }
        setFlash(r.ok === false ? `${(r.action ?? '').toUpperCase()} refused${r.error ? `: ${r.error}` : ''}` : null)
        const id = setTimeout(() => setFlash(null), 6000)
        return () => clearTimeout(id)
    }, [lastActionResult])

    const linked = telemetryStatus === 'connected'
    const armed = t?.flight_mode.is_armed ?? false
    const inAir = t?.flight_mode.is_in_air ?? false
    const mode = (t?.flight_mode.mode ?? '').toUpperCase()
    const pend = (a: string) => pendingAction?.action === a

    return (
        <div className="flex flex-col gap-1.5 items-start">
            <RailButton icon={<Power size={16} />} label={armed ? 'DISARM' : 'ARM'} disabled={!linked || (armed && inAir)}
                tone={armed ? 'danger' : 'go'} pending={pend('arm') || pend('disarm')}
                onClick={() => (armed ? disarm() : arm())}
                title={armed && inAir ? 'Cannot disarm in the air' : undefined} />
            <div className="flex flex-col items-center rounded-lg border border-white/10 py-1 w-[58px]"
                style={{ background: 'rgba(9,11,16,.78)' }}>
                <button onClick={() => setAlt(a => Math.min(120, a + 5))} className="text-zinc-300 p-0.5" title="Higher"><Plus size={12} /></button>
                <span className="text-[11px] font-mono font-bold text-zinc-100 tabular-nums">{alt} m</span>
                <button onClick={() => setAlt(a => Math.max(3, a - 5))} className="text-zinc-300 p-0.5" title="Lower"><Minus size={12} /></button>
            </div>
            <RailButton icon={<Rocket size={16} />} label="TAKEOFF" disabled={!linked || inAir} tone="go"
                pending={pend('takeoff')} onClick={() => sendAction('takeoff', { altitude: alt })}
                title={`Take off to ${alt} m`} />
            {mode === 'MISSION'
                ? <RailButton icon={<PauseCircle size={16} />} label="PAUSE" pending={pend('pause_mission')}
                    onClick={() => sendAction('pause_mission')} active />
                : <RailButton icon={<Play size={16} />} label="MISSION" disabled={!linked} tone="go"
                    pending={pend('arm_and_start_mission') || pend('start_mission')}
                    onClick={() => sendAction(armed ? 'start_mission' : 'arm_and_start_mission')}
                    title={armed ? 'Fly the uploaded mission' : 'Arm and fly the uploaded mission'} />}
            <RailButton icon={<PauseCircle size={16} />} label="HOLD" disabled={!linked || !inAir}
                active={mode === 'HOLD'} pending={pend('hold')} onClick={() => sendAction('hold')} />
            <RailButton icon={<Home size={16} />} label="RTL" disabled={!linked || !inAir}
                active={mode.includes('RETURN')} pending={pend('return')} onClick={() => sendAction('return')} />
            <RailButton icon={<ArrowDownToLine size={16} />} label="LAND" disabled={!linked || !inAir}
                active={mode === 'LAND'} pending={pend('land')} onClick={() => sendAction('land')} />
            <RailButton icon={<OctagonX size={16} />} label={killArmed ? 'CONFIRM' : 'KILL'} tone="danger"
                active={killArmed} disabled={!linked}
                onClick={() => { if (killArmed) { emergencyStop(); setKillArmed(false) } else setKillArmed(true) }}
                title="Emergency motor stop - tap twice" />
            {flash && (
                <div className="max-w-[220px] text-[10px] font-mono rounded border border-red-400/40 px-2 py-1 text-red-200"
                    style={{ background: 'rgba(69,10,10,.85)' }}>{flash}</div>
            )}
        </div>
    )
}
