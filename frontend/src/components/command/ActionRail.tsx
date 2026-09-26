'use client'

// The flight actions, as a solid column on the left of the Command window,
// in the order a flight uses them:
//   GROUND   arm, take off (altitude stepper)
//   MISSION  a dedicated START (becomes RESUME after a hold mid-mission,
//            RESTART once the mission finished) - HOLD pauses it
//   RECOVER  RTL, land
//   KILL     alone at the bottom, second tap within 3 s
// Same commands the Fly tab sends (useDrone.sendAction). The aircraft's
// refusal, if any, shows under the buttons for a few seconds.

import { useEffect, useState } from 'react'
import { ArrowDownToLine, CirclePause, Home, Loader2, Minus, OctagonX, Play, Plus, Power, RotateCcw, Rocket } from 'lucide-react'
import { useDrone } from '@/hooks/useDrone'
import { useDroneStore } from '@/store/drone'

type Tone = 'default' | 'go' | 'warn' | 'danger' | 'fire'
const TONES: Record<Tone, { fg: string; bg: string; bd: string }> = {
    default: { fg: '#e5e7eb', bg: 'rgba(255,255,255,.04)', bd: 'rgba(255,255,255,.10)' },
    go:      { fg: '#86efac', bg: 'rgba(74,222,128,.08)', bd: 'rgba(74,222,128,.35)' },
    warn:    { fg: '#fcd34d', bg: 'rgba(251,191,36,.07)', bd: 'rgba(251,191,36,.32)' },
    danger:  { fg: '#fca5a5', bg: 'rgba(248,113,113,.08)', bd: 'rgba(248,113,113,.45)' },
    fire:    { fg: '#ffffff', bg: '#b91c1c', bd: '#ef4444' },
}

function RailButton({ icon, label, sub, onClick, tone = 'default', active, pending, disabled, title, tall }: {
    icon: React.ReactNode; label: string; sub?: string; onClick: () => void
    tone?: Tone; active?: boolean; pending?: boolean; disabled?: boolean; title?: string; tall?: boolean
}) {
    const c = TONES[tone]
    return (
        <button onClick={onClick} disabled={disabled} title={title ?? label}
            className="w-full rounded-lg border flex flex-col items-center justify-center gap-0.5 transition-colors disabled:opacity-30 hover:brightness-125"
            style={{
                height: tall ? 64 : 50,
                background: active ? 'rgba(34,211,238,.18)' : c.bg,
                borderColor: active ? 'rgba(34,211,238,.7)' : c.bd,
                color: active ? '#a5f3fc' : c.fg,
            }}>
            {pending ? <Loader2 size={17} className="animate-spin" /> : icon}
            <span className="text-[9.5px] font-mono font-bold tracking-wider leading-none">{label}</span>
            {sub && <span className="text-[9px] font-mono opacity-60 leading-none">{sub}</span>}
        </button>
    )
}

const Group = ({ label }: { label: string }) => (
    <span className="text-[8.5px] font-mono tracking-[0.2em] text-zinc-500 pt-1.5 pl-0.5">{label}</span>
)

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
        const r = lastActionResult as { action?: string; ok?: boolean; error?: string; msg?: string }
        const why = r.error ?? r.msg
        setFlash(r.ok === false ? `${(r.action ?? '').replace(/_/g, ' ').toUpperCase()} refused${why ? `: ${why}` : ''}` : null)
        const id = setTimeout(() => setFlash(null), 6000)
        return () => clearTimeout(id)
    }, [lastActionResult])

    const linked = telemetryStatus === 'connected'
    const armed = t?.flight_mode.is_armed ?? false
    const inAir = t?.flight_mode.is_in_air ?? false
    const mode = (t?.flight_mode.mode ?? '').toUpperCase()
    const inMission = mode === 'MISSION'
    const finished = t?.mission_finished ?? false
    const midMission = !finished && (t?.mission_current_index ?? -1) > 0
    const pend = (...a: string[]) => a.includes(pendingAction?.action ?? '')

    // One button, three meanings - always "fly the mission from here".
    const start = finished
        ? { label: 'RESTART', icon: <RotateCcw size={18} />, action: armed ? 'restart_mission' : 'arm_and_restart_mission',
            title: 'Fly the mission again from the first item' }
        : midMission && inAir
            ? { label: 'RESUME', icon: <Play size={18} />, action: 'start_mission',
                title: `Continue the mission from item ${(t?.mission_current_index ?? 0) + 1}` }
            : { label: 'START', icon: <Play size={18} />, action: armed ? 'start_mission' : 'arm_and_start_mission',
                title: armed ? 'Fly the uploaded mission' : 'Arm and fly the uploaded mission' }

    return (
        <div className="flex flex-col gap-1.5 h-full w-[72px]">
            <Group label="GROUND" />
            <RailButton icon={<Power size={17} />} label={armed ? 'DISARM' : 'ARM'} disabled={!linked || (armed && inAir)}
                tone={armed ? 'danger' : 'go'} pending={pend('arm', 'disarm')}
                onClick={() => (armed ? disarm() : arm())}
                title={armed && inAir ? 'Cannot disarm in the air' : undefined} />
            <div className="rounded-lg border flex flex-col overflow-hidden"
                style={{ borderColor: TONES.go.bd, background: TONES.go.bg }}>
                <button onClick={() => sendAction('takeoff', { altitude: alt })} disabled={!linked || inAir}
                    title={`Take off to ${alt} m`}
                    className="h-[44px] flex flex-col items-center justify-center gap-0.5 disabled:opacity-30 hover:brightness-125"
                    style={{ color: TONES.go.fg }}>
                    {pend('takeoff') ? <Loader2 size={17} className="animate-spin" /> : <Rocket size={17} />}
                    <span className="text-[9.5px] font-mono font-bold tracking-wider leading-none">TAKEOFF</span>
                </button>
                <div className="flex items-center justify-between border-t px-0.5" style={{ borderColor: TONES.go.bd }}>
                    <button onClick={() => setAlt(a => Math.max(2, a - 1))} className="p-1.5 text-zinc-300" aria-label="Lower takeoff altitude"><Minus size={11} /></button>
                    <span className="text-[10px] font-mono font-bold text-zinc-100 tabular-nums">{alt}m</span>
                    <button onClick={() => setAlt(a => Math.min(120, a + 1))} className="p-1.5 text-zinc-300" aria-label="Raise takeoff altitude"><Plus size={11} /></button>
                </div>
            </div>

            <Group label="MISSION" />
            <RailButton icon={start.icon} label={start.label} tone="go" tall
                disabled={!linked || inMission} active={inMission}
                sub={inMission ? 'flying' : undefined}
                pending={pend('start_mission', 'arm_and_start_mission', 'restart_mission', 'arm_and_restart_mission')}
                onClick={() => sendAction(start.action)} title={inMission ? 'Mission is flying - HOLD pauses it' : start.title} />
            <RailButton icon={<CirclePause size={17} />} label="HOLD" disabled={!linked || !inAir}
                active={mode === 'HOLD'} pending={pend('hold', 'pause_mission')}
                onClick={() => sendAction(inMission ? 'pause_mission' : 'hold')}
                title={inMission ? 'Pause the mission and hover' : 'Hover in place'} />

            <Group label="RECOVER" />
            <RailButton icon={<Home size={17} />} label="RTL" tone="warn" disabled={!linked || !inAir}
                active={mode.includes('RETURN') || mode === 'RTL'} pending={pend('return')} onClick={() => sendAction('return')}
                title="Return to launch" />
            <RailButton icon={<ArrowDownToLine size={17} />} label="LAND" tone="warn" disabled={!linked || !inAir}
                active={mode === 'LAND'} pending={pend('land')} onClick={() => sendAction('land')} title="Land here" />

            <div className="flex-1 min-h-2" />
            {flash && (
                <div className="text-[9.5px] font-mono rounded border border-red-400/40 px-1.5 py-1 text-red-200 break-words"
                    style={{ background: 'rgba(69,10,10,.85)' }}>{flash}</div>
            )}
            <RailButton icon={<OctagonX size={18} />} label={killArmed ? 'CONFIRM' : 'KILL'} tone={killArmed ? 'fire' : 'danger'} tall
                sub={killArmed ? 'tap again' : 'tap twice'} disabled={!linked}
                onClick={() => { if (killArmed) { emergencyStop(); setKillArmed(false) } else setKillArmed(true) }}
                title="Emergency motor stop - tap twice" />
        </div>
    )
}
