'use client'

import { useState, useEffect } from 'react'

import { useDrone } from '@/hooks/useDrone'
import { useDroneStore, type RcTakeoverReport, type ActionResult } from '@/store/drone'
import { useSwarmStore } from '@/store/swarm'
import { Button } from '@/components/ui/button'
import {
    Select, SelectContent, SelectItem,
    SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
    Shield, ShieldOff, PlaneTakeoff,
    RotateCcw, MapPin, PlaneLanding, Loader,
    Hand, Cpu, Radio
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { FLIGHT_MODES, modeOptionFor, modeLabel } from '@/lib/flightModes'
import { useHydrated } from '@/hooks/useClientValue'
import { FOCUS, DISABLED } from './flightStyles'
import { WhyDisabled } from './WhyDisabled'

export function DroneControls() {
    const mounted = useHydrated()
    const [takeoffAlt, setTakeoffAlt] = useState(5)

    const { arm, disarm, sendAction } = useDrone()
    const telemetry = useDroneStore(s => s.telemetry)
    const telemetryStatus = useDroneStore(s => s.telemetryStatus)
    const pendingAction = useDroneStore(s => s.pendingAction)
    const lastActionResult = useDroneStore(s => s.lastActionResult)
    const swarmEnabled = useSwarmStore(s => s.enabled)
    const selectedIds  = useSwarmStore(s => s.selectedIds)
    const drones       = useSwarmStore(s => s.drones)

    // In swarm mode the ticked drones are the ONLY command targets (tick one
    // box to fly one drone); the highlighted drone just picks whose telemetry
    // is displayed. Mirrors useDrone.sendAction routing.
    const groupTargets = swarmEnabled
        ? selectedIds.filter(id => drones[id]?.connected)
        : []
    const isGroup = groupTargets.length > 0

    const modePending = pendingAction?.action === 'set_mode'

    // Derived from the latest set_mode result; a later success clears it and
    // the timer dismisses that particular refusal after 12 s.
    const [modeDismissed, setModeDismissed] = useState<ActionResult | null>(null)
    const modeRefusal = lastActionResult?.action === 'set_mode' && !lastActionResult.ok ? lastActionResult : null
    const modeError = modeRefusal && modeRefusal !== modeDismissed
        ? (modeRefusal.error || modeRefusal.msg || 'The drone did not change mode')
        : null
    useEffect(() => {
        if (!modeRefusal) return
        const t = setTimeout(() => setModeDismissed(modeRefusal), 12000)
        return () => clearTimeout(t)
    }, [modeRefusal])

    // WHO IS FLYING is a different question from WHICH MODE, and only the
    // second was ever on screen. They agree right up until the moment they
    // stop - a pilot taking the aircraft on their mode switch - which is the
    // one moment the operator needs to be told.
    const appIsFlying  = telemetry?.offboard_active ?? false
    const pilotHasIt   = telemetry?.pilot_override ?? null
    const handoverPending = pendingAction?.action === 'handover_to_pilot'

    // CAN THE PILOT TAKE THIS BACK AT ALL - answered from the aircraft's own
    // parameters on the ground, which is the only place the answer is cheap.
    // Runs on request, not automatically: it downloads the full parameter
    // table, which is seconds on SITL and half a minute on a 3DR radio.
    // The last report stays up while other commands come and go, so it is
    // captured during render when a new rc_takeover_check result lands.
    const [rcReport, setRcReport] = useState<RcTakeoverReport | null>(null)
    const [rcSeen, setRcSeen] = useState<ActionResult | null>(null)
    if (lastActionResult?.action === 'rc_takeover_check' && lastActionResult !== rcSeen) {
        setRcSeen(lastActionResult)
        setRcReport(lastActionResult.report ?? null)
    }
    const rcPending = pendingAction?.action === 'rc_takeover_check'

    const armed = telemetry?.flight_mode?.is_armed ?? false
    // Sent, not yet acknowledged. On a 3DR radio that gap is about a second,
    // and an unchanged button across it reads as a press that never landed.
    const armPending = pendingAction?.action === 'arm' || pendingAction?.action === 'disarm'
    const inAir = telemetry?.flight_mode?.is_in_air ?? false
    const mode  = telemetry?.flight_mode?.mode ?? '-'
    const connected = swarmEnabled ? isGroup : telemetryStatus === 'connected'
    // Group targets are in mixed states (some armed, some flying) - the
    // per-drone armed/in-air gates only make sense for the primary drone. The
    // backend reports per-drone failures for whichever can't comply.
    const canTakeoff = isGroup ? connected : (connected && armed && !inAir)
    const canFly     = isGroup ? connected : (connected && inAir)

    // Plain-words reasons for every disabled control (design system 8).
    const linkReason = connected ? null
        : swarmEnabled ? 'Tick drones in the Fleet panel first' : 'Connect a drone first'
    const armReason = linkReason ?? (armPending ? 'Waiting for the drone to answer' : null)
    const takeoffReason = linkReason ?? (canTakeoff ? null : !armed ? 'Arm first' : 'Already flying')
    const flyReason = linkReason ?? (canFly ? null : 'Only while flying')
    const modeReason = linkReason ?? (modePending ? 'Switching mode' : null)

    if (!mounted) {
        return <div className="space-y-3 min-h-[175px]" />
    }

    const ACTION = cn(
        'h-9 w-full text-[13px] font-bold gap-1.5 rounded-md text-app-text',
        FOCUS, DISABLED,
    )

    return (
        <div className="space-y-3">

            {/* Swarm command target - ticked drones only */}
            {swarmEnabled && (
                isGroup ? (
                    <div className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-bold border border-app-accent bg-app-accent-soft text-app-accent">
                        Commanding {groupTargets.length} drone{groupTargets.length > 1 ? 's' : ''}
                    </div>
                ) : (
                    <div className="px-3 py-1.5 rounded-md text-[13px] text-center border border-dashed border-app-border-strong text-app-text-muted">
                        Tick drones in the Fleet panel to command them
                    </div>
                )
            )}

            {/* Flight mode: one labelled control.
                SHOWS THE LIVE MODE, not a permanent "Change flight mode...".
                Without that, asking for Position and landing in Hold looked
                exactly like asking for Position and getting it - the only clue
                was a separate chip, and only if you knew POSCTL and HOLD are
                different things. The control that sets the mode is the one
                place a refusal or a substitution has to be visible. */}
            <div className="flex items-end gap-2">
                <div className="flex-1 min-w-0">
                    <label className="block text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted mb-1">
                        Mode
                    </label>
                    {isGroup ? (
                        <div className="h-9 flex items-center px-3 rounded-md border border-app-border bg-app-surface-2 text-[14px] font-bold text-app-accent">
                            {groupTargets.length > 1 ? `Group ×${groupTargets.length}` : `Drone ${groupTargets[0]}`}
                        </div>
                    ) : (
                        <WhyDisabled reason={modeReason}>
                            <Select
                                value={modeOptionFor(mode)}
                                disabled={!connected || modePending}
                                onValueChange={(m) => m && sendAction('set_mode', { mode: m })}
                            >
                                <SelectTrigger
                                    aria-label="Flight mode"
                                    className={cn('data-[size=default]:h-9 w-full text-[14px] font-bold border-app-border-strong rounded-md disabled:opacity-100 data-[disabled]:opacity-100 disabled:border-dashed data-[disabled]:border-dashed disabled:text-app-text-subtle data-[disabled]:text-app-text-subtle', FOCUS)}
                                >
                                    <SelectValue placeholder={connected ? modeLabel(mode) : 'No link'}>
                                        {modePending ? 'Switching…' : connected ? modeLabel(mode) : 'No link'}
                                    </SelectValue>
                                </SelectTrigger>
                                <SelectContent>
                                    {FLIGHT_MODES.map(m => (
                                        <SelectItem key={m.value} value={m.value} className="text-[13px]">
                                            <div>
                                                <div className="font-bold">{m.label}</div>
                                                <div className="text-[12px] text-muted-foreground">{m.description}</div>
                                                {m.requires && (
                                                    <div className="text-[12px] text-muted-foreground">
                                                        needs {m.requires}
                                                    </div>
                                                )}
                                            </div>
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </WhyDisabled>
                    )}
                </div>

                {/* Takeoff altitude */}
                <div className="w-[88px] shrink-0">
                    <label htmlFor="fly-takeoff-alt" className="block text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted mb-1">
                        Takeoff
                    </label>
                    <div className="h-9 flex items-center gap-1 px-2 rounded-md border border-app-border-strong bg-app-surface-2 focus-within:ring-2 focus-within:ring-app-accent focus-within:ring-offset-2 focus-within:ring-offset-app-bg"
                        title="Takeoff altitude in metres"
                    >
                        <input
                            id="fly-takeoff-alt"
                            type="number"
                            min={1} max={120} step={1}
                            value={takeoffAlt}
                            onChange={e => setTakeoffAlt(Math.max(1, Math.min(120, Number(e.target.value))))}
                            className="w-full min-w-0 bg-transparent text-[14px] font-bold text-app-text text-right outline-none border-none"
                            style={{ MozAppearance: 'textfield' }}
                        />
                        <span className="text-[12px] text-app-text-muted">m</span>
                    </div>
                </div>
            </div>

            {/* PX4 refuses a mode whose conditions are not met and says nothing
                about it over the wire that MAVSDK surfaces, so the backend
                confirms every switch against telemetry and sends back the
                reason. Dropping that on the floor here would put us straight
                back to a menu that silently does nothing. */}
            {modeError && (
                <p role="alert" className="text-[13px] text-app-danger leading-snug break-words">
                    {modeError}
                </p>
            )}

            {/* WHO IS FLYING.
                Shown only when there is something to say - an aircraft nobody
                is flying autonomously needs no band, and a control that is
                always there stops being read.

                The pilot's own route out of Offboard is their mode switch or
                their sticks, and BOTH depend on aircraft parameters this app
                does not own: COM_RC_IN_MODE decides whether the transmitter
                reaches PX4 at all, COM_RC_OVERRIDE bit 1 decides whether the
                sticks do anything during Offboard, and it is CLEAR by default.
                The button below depends on none of that - it stops Offboard
                and commands a stick-flown mode over the link. It also covers
                the case the switch cannot: PX4 acts on the mode switch when it
                CHANGES, so a switch already sitting in the slot the pilot
                wants does nothing until they toggle away and back. */}
            {!swarmEnabled && pilotHasIt && (
                <div className="space-y-2 px-3 py-2.5 rounded-md border border-app-warn bg-app-warn-soft">
                    <div className="flex items-center gap-1.5 text-[13px] font-bold text-app-warn">
                        <Hand size={14} /> Pilot has control
                    </div>
                    <p className="text-[13px] leading-snug text-app-text">
                        The aircraft left Offboard for {pilotHasIt} without this app
                        asking. Tracking has stopped and will not restart on its own.
                    </p>
                    <WhyDisabled reason={linkReason}>
                        <Button
                            size="sm" variant="outline"
                            className={cn(ACTION, 'border-app-accent text-app-accent hover:bg-app-accent-soft')}
                            disabled={!connected}
                            onClick={() => sendAction('resume_from_pilot')}
                            title="Allow the app to fly this aircraft again. Does not re-enter Offboard by itself."
                        >
                            <Cpu size={14} /> Take control back
                        </Button>
                    </WhyDisabled>
                </div>
            )}

            {!swarmEnabled && !pilotHasIt && appIsFlying && (
                <WhyDisabled reason={linkReason ?? (handoverPending ? 'Handing over' : null)}>
                    <Button
                        size="sm" variant="outline"
                        className={cn(ACTION, 'border-app-warn text-app-warn hover:bg-app-warn-soft')}
                        disabled={!connected || handoverPending}
                        onClick={() => sendAction('handover_to_pilot')}
                        title="Stop Offboard and put PX4 in a stick-flown mode, so the transmitter is live immediately"
                    >
                        {handoverPending
                            ? <><Loader size={14} className="animate-spin" /> Handing over…</>
                            : <><Hand size={14} /> Give to pilot</>}
                    </Button>
                </WhyDisabled>
            )}

            {/* Arm / Disarm */}
            <WhyDisabled reason={armReason}>
                <Button
                    size="sm"
                    className={cn(
                        ACTION, 'h-10 text-[14px]',
                        armed && !isGroup
                            ? 'border-app-warn text-app-warn hover:bg-app-warn-soft'
                            : 'border-app-ok text-app-ok hover:bg-app-ok-soft'
                    )}
                    variant="outline"
                    disabled={!connected || armPending}
                    onClick={(!isGroup && armed) ? disarm : arm}
                >
                    {armPending
                        ? <><Loader size={15} className="animate-spin" /> {armed ? 'DISARMING' : 'ARMING'}…</>
                        : (!isGroup && armed)
                            ? <><ShieldOff size={15} /> DISARM</>
                            : <><Shield size={15} /> ARM{groupTargets.length > 1 ? ' ALL' : ''}</>
                    }
                </Button>
            </WhyDisabled>

            {/* Group disarm is its own button - group members can be in mixed
                armed states, so arm/disarm can't share one toggle */}
            {isGroup && (
                <Button
                    size="sm"
                    variant="outline"
                    className={cn(ACTION, 'border-app-warn text-app-warn hover:bg-app-warn-soft')}
                    onClick={disarm}
                >
                    <ShieldOff size={15} /> DISARM{groupTargets.length > 1 ? ' ALL' : ''}
                </Button>
            )}

            {/* Action grid */}
            <div className="grid grid-cols-2 gap-2">
                <WhyDisabled reason={takeoffReason}>
                    <Button
                        size="sm" variant="outline"
                        className={cn(ACTION, 'hover:border-app-accent hover:text-app-accent')}
                        disabled={!canTakeoff}
                        onClick={() => sendAction('takeoff', { altitude: takeoffAlt })}
                        title={isGroup ? `Takeoff ${groupTargets.length} drones to ${takeoffAlt} m` : `Take off to ${takeoffAlt} m`}
                    >
                        <PlaneTakeoff size={14} /> Takeoff
                    </Button>
                </WhyDisabled>

                <WhyDisabled reason={flyReason}>
                    <Button
                        size="sm" variant="outline"
                        className={cn(ACTION, 'hover:border-app-accent hover:text-app-accent')}
                        disabled={!canFly}
                        onClick={() => sendAction('land')}
                    >
                        <PlaneLanding size={14} /> Land
                    </Button>
                </WhyDisabled>

                <WhyDisabled reason={flyReason}>
                    <Button
                        size="sm" variant="outline"
                        className={cn(ACTION, 'hover:border-app-accent hover:text-app-accent')}
                        disabled={!canFly}
                        onClick={() => sendAction('hold')}
                    >
                        <MapPin size={14} /> Hold
                    </Button>
                </WhyDisabled>

                <WhyDisabled reason={flyReason}>
                    <Button
                        size="sm" variant="outline"
                        className={cn(ACTION, 'hover:border-app-accent hover:text-app-accent')}
                        disabled={!canFly}
                        onClick={() => sendAction('return')}
                    >
                        <RotateCcw size={14} /> RTL
                    </Button>
                </WhyDisabled>
            </div>

            {/* One readable line saying why everything above is greyed out. */}
            {linkReason && (
                <p className="text-[13px] text-app-text-muted text-center">{linkReason}</p>
            )}

            {/* RC takeover readiness.
                These parameters belong to whoever set the airframe up, so this
                READS and never writes: a ground station that quietly rewrites
                RC behaviour mid-campaign is a worse problem than the one it
                solves, and the operator would have no idea it had happened. */}
            {!swarmEnabled && (
                <div className="space-y-1.5 pt-1">
                    <WhyDisabled reason={linkReason ?? (rcPending ? 'Reading parameters' : null)}>
                        <Button
                            size="sm" variant="ghost"
                            className={cn(ACTION, 'h-8 text-[13px] font-semibold text-app-text-muted hover:text-app-accent disabled:border-transparent disabled:bg-transparent')}
                            disabled={!connected || rcPending}
                            onClick={() => sendAction('rc_takeover_check')}
                            title="Read the parameters that decide whether the transmitter can take the aircraft back"
                        >
                            {rcPending
                                ? <><Loader size={13} className="animate-spin" /> Reading parameters…</>
                                : <><Radio size={13} /> RC takeover check</>}
                        </Button>
                    </WhyDisabled>
                    {rcReport && (
                        <div className={cn('px-3 py-2 rounded-md space-y-1 border',
                            rcReport.ok ? 'border-app-ok bg-app-ok-soft' : 'border-app-warn bg-app-warn-soft')}
                        >
                            <div className={cn('text-[13px] font-bold',
                                rcReport.ok ? 'text-app-ok' : 'text-app-warn')}>
                                {rcReport.ok
                                    ? 'The pilot can take this aircraft back'
                                    : 'RC takeover is not fully set up'}
                            </div>
                            {rcReport.error && (
                                <p className="text-[13px] text-app-text">{rcReport.error}</p>
                            )}
                            {rcReport.findings.filter(f => f.verdict !== 'ok').map(f => (
                                <p key={f.param} className={cn('text-[13px] leading-snug break-words',
                                    f.verdict === 'blocked' ? 'text-app-danger' : 'text-app-text')}
                                >
                                    <span className="font-bold font-code">{f.param}={f.value}</span> - {f.detail}
                                </p>
                            ))}
                            {rcReport.unreadable.length > 0 && (
                                <p className="text-[13px] text-app-text-muted break-words">
                                    Not present on this airframe: {rcReport.unreadable.join(', ')}
                                </p>
                            )}
                        </div>
                    )}
                </div>
            )}

        </div>
    )
}
