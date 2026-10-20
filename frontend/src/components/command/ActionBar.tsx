'use client'

// The actions that START a flight, in a bar under the Command stage, in the
// order a flight uses them: arm, take off (altitude stepper), fly the
// mission. Hold, RTL, Land and Kill are not here: they live in the global
// status bar, in the same place on every page (design audit 2, 5.2).
//
// Same commands and guards as the old left rail (useDrone.sendAction). The
// aircraft's refusal, if any, shows beside the buttons for a few seconds.

import { useEffect, useState } from 'react'
import { Loader2, Minus, Play, Plus, Power, RotateCcw, Rocket } from 'lucide-react'
import { useDrone } from '@/hooks/useDrone'
import { useDroneStore, type ActionResult } from '@/store/drone'
import type { AvoidanceStatus } from '@/lib/avoidance'
import { actingFloorM } from './avoidFloor'
import { AttachmentStrip } from '@/components/attachments/AttachmentStrip'
import { FOCUS, DISABLED } from '@/components/controls/flightStyles'
import { WhyDisabled } from '@/components/controls/WhyDisabled'
import { cn } from '@/lib/utils'

type Tone = 'default' | 'go' | 'warn' | 'danger'
const TONES: Record<Tone, string> = {
    default: 'border-app-border-strong text-app-text hover:bg-app-surface-2',
    go:      'border-app-ok text-app-ok hover:bg-app-ok-soft',
    warn:    'border-app-warn text-app-warn hover:bg-app-warn-soft',
    danger:  'border-app-danger text-app-danger hover:bg-app-danger-soft',
}

function BarButton({ icon, label, onClick, tone = 'default', active, pending, disabled, title, why }: {
    icon: React.ReactNode; label: string; onClick: () => void
    tone?: Tone; active?: boolean; pending?: boolean; disabled?: boolean; title?: string
    /** Plain-words reason shown as a tooltip while disabled. */
    why?: string | null
}) {
    return (
        <WhyDisabled reason={disabled ? (why ?? 'Not available right now') : null} className="inline-block shrink-0">
            <button onClick={onClick} disabled={disabled} title={disabled ? undefined : (title ?? label)}
                aria-pressed={active || undefined}
                className={cn(
                    'h-10 px-3.5 rounded-md border inline-flex items-center justify-center gap-2 text-[14px] font-bold whitespace-nowrap',
                    'transition-[color,background-color,border-color,transform] duration-[140ms] active:scale-[.98]',
                    active ? 'border-app-accent bg-app-accent-soft text-app-accent' : TONES[tone],
                    FOCUS, DISABLED,
                )}>
                {pending ? <Loader2 size={16} className="animate-spin" /> : icon}
                {label}
            </button>
        </WhyDisabled>
    )
}

const NO_LINK = 'Connect a drone first'
const INDOOR_TAKEOFF_M = 1.5, INDOOR_TAKEOFF_MAX_M = 2      // backend caps at 2 m too

export function ActionBar({ avoid }: { avoid?: AvoidanceStatus | null }) {
    const { sendAction, arm, disarm } = useDrone()
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
    // The aircraft's answer, shown for a moment: derived from the latest
    // result until the timer dismisses that particular result.
    const [flashDismissed, setFlashDismissed] = useState<ActionResult | null>(null)
    const flash = lastActionResult && lastActionResult !== flashDismissed && lastActionResult.ok === false
        ? `${(lastActionResult.action ?? '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())} refused${
            (lastActionResult.error ?? lastActionResult.msg) ? `: ${lastActionResult.error ?? lastActionResult.msg}` : ''}`
        : null

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
    const takeoffAlt = Math.min(alt, altMax)

    // One button, three meanings - always "fly the mission from here".
    const start = finished
        ? { label: 'Restart mission', icon: <RotateCcw size={16} />, action: armed ? 'restart_mission' : 'arm_and_restart_mission',
            title: 'Fly the mission again from the first item' }
        : midMission && inAir
            ? { label: 'Resume mission', icon: <Play size={16} />, action: 'start_mission',
                title: `Continue the mission from item ${(t?.mission_current_index ?? 0) + 1}` }
            : { label: 'Start mission', icon: <Play size={16} />, action: armed ? 'start_mission' : 'arm_and_start_mission',
                title: armed ? 'Fly the uploaded mission' : 'Arm and fly the uploaded mission' }

    return (
        <div className="flex flex-wrap md:flex-nowrap items-center gap-2 min-w-0">
            <BarButton icon={<Power size={16} />} label={armed ? 'Disarm' : 'Arm'} disabled={!linked || (armed && inAir)}
                tone={armed ? 'warn' : 'go'} pending={pend('arm', 'disarm')}
                onClick={() => (armed ? disarm() : arm())}
                why={!linked ? NO_LINK : 'Land before disarming'} />

            {/* Take off, with its altitude stepper attached */}
            <div className={cn('h-10 inline-flex items-stretch rounded-md border shrink-0 overflow-hidden',
                !linked || inAir ? 'border-dashed border-app-border-strong' : 'border-app-ok')}>
                <WhyDisabled reason={!linked ? NO_LINK : inAir ? 'Already flying' : null} className="inline-flex">
                    <button onClick={() => sendAction('takeoff', { altitude: takeoffAlt })} disabled={!linked || inAir}
                        title={!linked || inAir ? undefined : `Take off to ${takeoffAlt} m` + (indoor ? ' (indoor: capped at 2 m)' : '')
                            + (belowFloor ? `, below the avoidance floor (${floor} m): avoidance cannot steer there` : '')}
                        className={cn('h-full px-3.5 inline-flex items-center gap-2 text-[14px] font-bold whitespace-nowrap text-app-ok hover:bg-app-ok-soft transition-colors duration-[140ms]',
                            'disabled:bg-app-surface-2 disabled:text-app-text-subtle disabled:hover:bg-app-surface-2', FOCUS)}>
                        {pend('takeoff') ? <Loader2 size={16} className="animate-spin" /> : <Rocket size={16} />}
                        Take off
                    </button>
                </WhyDisabled>
                <div className="flex items-center border-l border-app-border bg-app-surface">
                    <button onClick={() => setAlt(a => Math.max(indoor ? 1 : 2, a - (indoor ? 0.5 : 1)))}
                        className={cn('h-full w-8 flex items-center justify-center text-app-text-muted hover:text-app-text hover:bg-app-surface-2 transition-colors duration-[140ms]', FOCUS)}
                        aria-label="Lower takeoff altitude" title="Lower takeoff altitude"><Minus size={14} /></button>
                    <span className={cn('min-w-[46px] text-center text-[14px] font-bold tabular-nums', belowFloor ? 'text-app-warn' : 'text-app-text')}
                        title={belowFloor ? `Below the avoidance floor (${floor} m)` : 'Takeoff altitude'}>{takeoffAlt} m</span>
                    <button onClick={() => setAlt(a => Math.min(altMax, a + (indoor ? 0.5 : 1)))}
                        className={cn('h-full w-8 flex items-center justify-center text-app-text-muted hover:text-app-text hover:bg-app-surface-2 transition-colors duration-[140ms]', FOCUS)}
                        aria-label="Raise takeoff altitude" title="Raise takeoff altitude"><Plus size={14} /></button>
                </div>
            </div>

            <span aria-hidden className="hidden md:block w-px h-6 bg-app-border shrink-0 mx-1" />

            <BarButton icon={start.icon} label={inMission && !finished ? 'Mission flying' : start.label} tone="go"
                disabled={!linked || (inMission && !finished)} active={inMission && !finished}
                pending={pend('start_mission', 'arm_and_start_mission', 'restart_mission', 'arm_and_restart_mission')}
                onClick={() => sendAction(start.action)} title={inMission ? 'Mission is flying. Hold pauses it.' : start.title}
                why={!linked ? NO_LINK : 'Mission is flying. Hold pauses it.'} />

            {/* The drone's attachments, inline (only when it has some). */}
            <AttachmentStrip frame={strip => (
                <div className="flex items-center gap-2 shrink-0 pl-2 border-l border-app-border [&_[role=group]]:flex-row [&_[role=group]]:items-center [&_[role=group]>div]:flex-nowrap [&_[role=group]>div>span:first-child]:!flex-none">
                    {strip}
                </div>
            )} />

            {flash && (
                <div role="alert" title={flash}
                    className="min-w-0 max-w-[360px] truncate text-[13px] font-semibold rounded-md border border-app-danger bg-app-danger-soft px-2.5 py-1.5 text-app-danger animate-in fade-in-0 duration-200">
                    {flash}
                </div>
            )}
        </div>
    )
}
