'use client'

// The flight actions, as a solid column on the left of the Command window,
// in the order a flight uses them:
//   GROUND   arm, take off (altitude stepper)
//   MISSION  a dedicated START (becomes RESUME after a hold mid-mission,
//            RESTART once the mission finished) - HOLD pauses it
//   RECOVER  RTL, land
//   PAYLOAD  the drone's attachments (only when it has some)
//   KILL     alone at the bottom, second tap within 3 s
// Same commands the Fly tab sends (useDrone.sendAction). The aircraft's
// refusal, if any, shows under the buttons for a few seconds.

import { useEffect, useState } from 'react'
import { ArrowDownToLine, CirclePause, Home, Loader2, Minus, OctagonX, Play, Plus, Power, RotateCcw, Rocket } from 'lucide-react'
import { useDrone } from '@/hooks/useDrone'
import { useDroneStore, type ActionResult } from '@/store/drone'
import type { AvoidanceStatus } from '@/lib/avoidance'
import { actingFloorM } from './avoidFloor'
import { AttachmentStrip } from '@/components/attachments/AttachmentStrip'
import { FOCUS, DISABLED } from '@/components/controls/flightStyles'
import { WhyDisabled } from '@/components/controls/WhyDisabled'
import { cn } from '@/lib/utils'

type Tone = 'default' | 'go' | 'warn' | 'danger' | 'fire'
// Theme tokens, so the rail follows light and dark like the rest of the page.
const TONES: Record<Tone, string> = {
    default: 'border-app-border-strong bg-app-surface-2 text-app-text',
    go:      'border-app-ok bg-app-ok-soft text-app-ok',
    warn:    'border-app-warn bg-app-warn-soft text-app-warn',
    danger:  'border-app-danger bg-app-danger-soft text-app-danger',
    fire:    'border-[#ef4444] bg-[#b91c1c] text-white',
}

function RailButton({ icon, label, sub, onClick, tone = 'default', active, pending, disabled, title, why, tall }: {
    icon: React.ReactNode; label: string; sub?: string; onClick: () => void
    tone?: Tone; active?: boolean; pending?: boolean; disabled?: boolean; title?: string
    /** Plain-words reason shown as a tooltip while disabled. */
    why?: string | null; tall?: boolean
}) {
    return (
        <WhyDisabled reason={disabled ? (why ?? 'Not available right now') : null}>
            <button onClick={onClick} disabled={disabled} title={disabled ? undefined : (title ?? label)}
                aria-label={sub ? `${label}, ${sub}` : label}
                className={cn(
                    'w-full rounded-md border flex flex-col items-center justify-center gap-1',
                    'transition-colors duration-[var(--dur-fast)] hover:brightness-110',
                    active ? 'border-app-accent bg-app-accent-soft text-app-accent' : TONES[tone],
                    tall ? 'h-16' : 'h-[52px]',
                    FOCUS, DISABLED,
                )}>
                {pending ? <Loader2 size={18} className="animate-spin" /> : icon}
                <span className="text-[12px] font-extrabold tracking-[0.04em] leading-none">{label}</span>
                {sub && <span className="text-[12px] font-semibold leading-none">{sub}</span>}
            </button>
        </WhyDisabled>
    )
}

const Group = ({ label }: { label: string }) => (
    <span className="text-[12px] font-bold uppercase tracking-[0.06em] text-app-text-muted pt-2 pl-0.5">{label}</span>
)

const NO_LINK = 'Connect a drone first'
const INDOOR_TAKEOFF_M = 1.5, INDOOR_TAKEOFF_MAX_M = 2      // backend caps at 2 m too

export function ActionRail({ avoid }: { avoid?: AvoidanceStatus | null }) {
    const { sendAction, arm, disarm, emergencyStop } = useDrone()
    const t = useDroneStore(s => s.telemetry)
    const telemetryStatus = useDroneStore(s => s.telemetryStatus)
    const pendingAction = useDroneStore(s => s.pendingAction)
    const lastActionResult = useDroneStore(s => s.lastActionResult)
    const indoor = avoid?.env === 'indoor'
    const [alt, setAlt] = useState(10)
    // Indoors the 10 m default meets the ceiling: drop to 1.5 m and cap at 2.
    // Adjusted during render on the outdoor -> indoor edge, not in an effect.
    const [wasIndoor, setWasIndoor] = useState(false)
    if (indoor !== wasIndoor) {
        setWasIndoor(indoor)
        if (indoor) setAlt(a => Math.min(a, INDOOR_TAKEOFF_M))
    }
    const altMax = indoor ? INDOOR_TAKEOFF_MAX_M : 120
    const floor = actingFloorM(avoid ?? null)
    const belowFloor = floor != null && alt < floor
    const [killArmed, setKillArmed] = useState(false)
    // The aircraft's answer, shown for a moment: derived from the latest
    // result until the timer dismisses that particular result.
    const [flashDismissed, setFlashDismissed] = useState<ActionResult | null>(null)
    const flash = lastActionResult && lastActionResult !== flashDismissed && lastActionResult.ok === false
        ? `${(lastActionResult.action ?? '').replace(/_/g, ' ').toUpperCase()} refused${
            (lastActionResult.error ?? lastActionResult.msg) ? `: ${lastActionResult.error ?? lastActionResult.msg}` : ''}`
        : null

    useEffect(() => {
        if (!killArmed) return
        const id = setTimeout(() => setKillArmed(false), 3000)
        return () => clearTimeout(id)
    }, [killArmed])

    useEffect(() => {
        if (!lastActionResult) return
        const id = setTimeout(() => setFlashDismissed(lastActionResult), 6000)
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
                why={!linked ? NO_LINK : 'Land before disarming'} />
            <div className="rounded-md border border-app-ok bg-app-ok-soft flex flex-col overflow-hidden">
                <WhyDisabled reason={!linked ? NO_LINK : inAir ? 'Already flying' : null}>
                    <button onClick={() => sendAction('takeoff', { altitude: Math.min(alt, altMax) })} disabled={!linked || inAir}
                        title={!linked || inAir ? undefined : `Take off to ${Math.min(alt, altMax)} m` + (indoor ? ' (indoor: capped at 2 m)' : '')
                            + (belowFloor ? ` - below the avoidance floor (${floor} m): avoidance cannot steer there` : '')}
                        className={cn('w-full h-[46px] flex flex-col items-center justify-center gap-1 text-app-ok hover:brightness-110', FOCUS, DISABLED)}>
                        {pend('takeoff') ? <Loader2 size={18} className="animate-spin" /> : <Rocket size={18} />}
                        <span className="text-[12px] font-extrabold tracking-[0.04em] leading-none">TAKEOFF</span>
                    </button>
                </WhyDisabled>
                <div className="flex items-center justify-between border-t border-app-ok bg-app-surface">
                    <button onClick={() => setAlt(a => Math.max(indoor ? 1 : 2, a - (indoor ? 0.5 : 1)))}
                        className={cn('h-8 w-6 flex items-center justify-center text-app-text hover:text-app-accent', FOCUS)}
                        aria-label="Lower takeoff altitude" title="Lower takeoff altitude"><Minus size={14} /></button>
                    <span className={cn('text-[13px] font-extrabold tabular-nums', belowFloor ? 'text-app-warn' : 'text-app-text')}
                        title={belowFloor ? `below the avoidance floor (${floor} m)` : 'Takeoff altitude'}>{Math.min(alt, altMax)}m</span>
                    <button onClick={() => setAlt(a => Math.min(altMax, a + (indoor ? 0.5 : 1)))}
                        className={cn('h-8 w-6 flex items-center justify-center text-app-text hover:text-app-accent', FOCUS)}
                        aria-label="Raise takeoff altitude" title="Raise takeoff altitude"><Plus size={14} /></button>
                </div>
            </div>

            <Group label="MISSION" />
            <RailButton icon={start.icon} label={start.label} tone="go" tall
                disabled={!linked || (inMission && !finished)} active={inMission && !finished}
                sub={inMission && !finished ? 'flying' : undefined}
                pending={pend('start_mission', 'arm_and_start_mission', 'restart_mission', 'arm_and_restart_mission')}
                onClick={() => sendAction(start.action)} title={inMission ? 'Mission is flying - HOLD pauses it' : start.title}
                why={!linked ? NO_LINK : 'Mission is flying - HOLD pauses it'} />
            <RailButton icon={<CirclePause size={17} />} label="HOLD" disabled={!linked || !inAir}
                active={mode === 'HOLD'} pending={pend('hold', 'pause_mission')}
                onClick={() => sendAction(inMission ? 'pause_mission' : 'hold')}
                title={inMission ? 'Pause the mission and hover' : 'Hover in place'}
                why={!linked ? NO_LINK : 'Only while flying'} />

            <Group label="RECOVER" />
            <RailButton icon={<Home size={17} />} label="RTL" tone="warn" disabled={!linked || !inAir}
                active={mode.includes('RETURN') || mode === 'RTL'} pending={pend('return')} onClick={() => sendAction('return')}
                title="Return to launch" why={!linked ? NO_LINK : 'Only while flying'} />
            <RailButton icon={<ArrowDownToLine size={17} />} label="LAND" tone="warn" disabled={!linked || !inAir}
                active={mode === 'LAND'} pending={pend('land')} onClick={() => sendAction('land')} title="Land here" why={!linked ? NO_LINK : 'Only while flying'} />

            <AttachmentStrip variant="rail" frame={strip => <><Group label="PAYLOAD" />{strip}</>} />

            <div className="flex-1 min-h-2" />
            {flash && (
                <div role="alert" className="text-[12px] font-semibold rounded-md border border-app-danger bg-app-danger-soft px-1.5 py-1 text-app-danger break-words">{flash}</div>
            )}
            <RailButton icon={<OctagonX size={18} />} label={killArmed ? 'CONFIRM' : 'KILL'} tone={killArmed ? 'fire' : 'danger'} tall
                sub={killArmed ? 'tap again' : 'tap twice'} disabled={!linked}
                onClick={() => { if (killArmed) { emergencyStop(); setKillArmed(false) } else setKillArmed(true) }}
                title="Emergency motor stop - tap twice" why={NO_LINK} />
        </div>
    )
}
