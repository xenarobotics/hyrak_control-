'use client'

import { useState, useEffect } from 'react'

import { useDrone } from '@/hooks/useDrone'
import { useDroneStore, type RcTakeoverReport } from '@/store/drone'
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

export function DroneControls() {
    const [mounted, setMounted] = useState(false)
    const [takeoffAlt, setTakeoffAlt] = useState(5)
    useEffect(() => { setMounted(true) }, [])

    const { arm, disarm, sendAction } = useDrone()
    const { telemetry, telemetryStatus, pendingAction, lastActionResult } = useDroneStore()
    const [modeError, setModeError] = useState<string | null>(null)
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

    useEffect(() => {
        if (!lastActionResult || lastActionResult.action !== 'set_mode') return
        if (lastActionResult.ok) { setModeError(null); return }
        setModeError(lastActionResult.error || lastActionResult.msg || 'The drone did not change mode')
        const t = setTimeout(() => setModeError(null), 12000)
        return () => clearTimeout(t)
    }, [lastActionResult])

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
    const [rcReport, setRcReport] = useState<RcTakeoverReport | null>(null)
    const rcPending = pendingAction?.action === 'rc_takeover_check'
    useEffect(() => {
        if (lastActionResult?.action !== 'rc_takeover_check') return
        setRcReport(lastActionResult.report ?? null)
    }, [lastActionResult])

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

    if (!mounted) {
        return <div className="space-y-3 min-h-[175px]" />
    }

    return (
        <div className="space-y-3">

            {/* Swarm command target - ticked drones only */}
            {swarmEnabled && (
                isGroup ? (
                    <div
                        className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold"
                        style={{ background: 'rgba(34,211,238,.1)', border: '1px solid rgba(34,211,238,.35)', color: '#22d3ee' }}
                    >
                        COMMANDING {groupTargets.length} DRONE{groupTargets.length > 1 ? 'S' : ''}
                    </div>
                ) : (
                    <div
                        className="px-3 py-1.5 rounded-lg text-[10px] font-mono text-center"
                        style={{ border: '1px dashed hsl(var(--app-border))', color: 'hsl(var(--app-text-muted))' }}
                    >
                        Tick drones in the Fleet panel to command them
                    </div>
                )
            )}

            {/* Live mode + takeoff altitude */}
            <div className="flex items-center gap-2">
                <div className="flex items-center justify-between px-3 py-2 rounded-lg flex-1"
                    style={{ background: 'hsl(var(--app-surface-2))' }}
                >
                    <span className="text-xs font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>
                        MODE
                    </span>
                    <span className="text-xs font-mono font-semibold text-cyan-500">
                        {isGroup
                            ? (groupTargets.length > 1 ? `GROUP ×${groupTargets.length}` : `DRONE ${groupTargets[0]}`)
                            : mode}
                    </span>
                </div>

                {/* Takeoff altitude */}
                <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg"
                    style={{ background: 'hsl(var(--app-surface-2))' }}
                    title="Desired takeoff altitude (metres)"
                >
                    <span className="text-xs font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>ALT</span>
                    <input
                        type="number"
                        min={1} max={120} step={1}
                        value={takeoffAlt}
                        onChange={e => setTakeoffAlt(Math.max(1, Math.min(120, Number(e.target.value))))}
                        className="w-10 bg-transparent text-xs font-mono font-semibold text-cyan-500 text-center outline-none border-none"
                        style={{ MozAppearance: 'textfield' }}
                    />
                    <span className="text-xs font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>m</span>
                </div>
            </div>

            {/* Flight mode selector.
                SHOWS THE LIVE MODE, not a permanent "Change flight mode...".
                Without that, asking for Position and landing in Hold looked
                exactly like asking for Position and getting it - the only clue
                was a separate chip, and only if you knew POSCTL and HOLD are
                different things. The control that sets the mode is the one
                place a refusal or a substitution has to be visible. */}
            <Select
                value={modeOptionFor(mode)}
                disabled={!connected || modePending}
                onValueChange={(m) => m && sendAction('set_mode', { mode: m })}
            >
                <SelectTrigger className="h-8 text-xs font-mono">
                    <SelectValue placeholder={connected ? modeLabel(mode) : 'Change flight mode...'}>
                        {modePending ? 'Switching…' : modeLabel(mode)}
                    </SelectValue>
                </SelectTrigger>
                <SelectContent>
                    {FLIGHT_MODES.map(m => (
                        <SelectItem key={m.value} value={m.value} className="text-xs">
                            <div>
                                <div className="font-mono font-medium">{m.label}</div>
                                <div className="text-[10px] text-muted-foreground">{m.description}</div>
                                {m.requires && (
                                    <div className="text-[10px] text-muted-foreground/70">
                                        needs {m.requires}
                                    </div>
                                )}
                            </div>
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            {/* PX4 refuses a mode whose conditions are not met and says nothing
                about it over the wire that MAVSDK surfaces, so the backend
                confirms every switch against telemetry and sends back the
                reason. Dropping that on the floor here would put us straight
                back to a menu that silently does nothing. */}
            {modeError && (
                <p className="text-[10px] font-mono text-red-400/90 leading-relaxed break-words">
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
                <div className="space-y-2 px-3 py-2 rounded-lg"
                    style={{ background: 'rgba(251,146,60,.1)', border: '1px solid rgba(251,146,60,.4)' }}
                >
                    <div className="flex items-center gap-1.5 text-[10px] font-mono font-bold text-orange-400">
                        <Hand size={12} /> PILOT HAS CONTROL
                    </div>
                    <p className="text-[10px] font-mono leading-relaxed text-orange-300/80">
                        The aircraft left Offboard for {pilotHasIt} without this app
                        asking. Tracking has stopped and will not restart on its own.
                    </p>
                    <Button
                        size="sm" variant="outline"
                        className="w-full font-mono text-xs gap-1.5 border-cyan-500/40 text-cyan-500 hover:bg-cyan-500/10"
                        disabled={!connected}
                        onClick={() => sendAction('resume_from_pilot')}
                        title="Allow the app to fly this aircraft again. Does not re-enter Offboard by itself."
                    >
                        <Cpu size={12} /> TAKE CONTROL BACK
                    </Button>
                </div>
            )}

            {!swarmEnabled && !pilotHasIt && appIsFlying && (
                <Button
                    size="sm" variant="outline"
                    className="w-full font-mono text-xs gap-1.5 border-orange-500/40 text-orange-500 hover:bg-orange-500/10"
                    disabled={!connected || handoverPending}
                    onClick={() => sendAction('handover_to_pilot')}
                    title="Stop Offboard and put PX4 in a stick-flown mode, so the transmitter is live immediately"
                >
                    {handoverPending
                        ? <><Loader size={12} className="animate-spin" /> HANDING OVER…</>
                        : <><Hand size={12} /> GIVE TO PILOT</>}
                </Button>
            )}

            {/* RC takeover readiness.
                These parameters belong to whoever set the airframe up, so this
                READS and never writes: a ground station that quietly rewrites
                RC behaviour mid-campaign is a worse problem than the one it
                solves, and the operator would have no idea it had happened. */}
            {!swarmEnabled && (
                <div className="space-y-1.5">
                    <Button
                        size="sm" variant="outline"
                        className="w-full font-mono text-[11px] gap-1.5 hover:border-cyan-500/50 hover:text-cyan-500"
                        disabled={!connected || rcPending}
                        onClick={() => sendAction('rc_takeover_check')}
                        title="Read the parameters that decide whether the transmitter can take the aircraft back"
                    >
                        {rcPending
                            ? <><Loader size={11} className="animate-spin" /> READING PARAMS…</>
                            : <><Radio size={11} /> RC TAKEOVER CHECK</>}
                    </Button>
                    {rcReport && (
                        <div className="px-2.5 py-2 rounded-lg space-y-1"
                            style={{
                                background: rcReport.ok ? 'rgba(34,197,94,.08)' : 'rgba(251,146,60,.08)',
                                border: `1px solid ${rcReport.ok ? 'rgba(34,197,94,.3)' : 'rgba(251,146,60,.35)'}`,
                            }}
                        >
                            <div className={cn('text-[10px] font-mono font-bold',
                                rcReport.ok ? 'text-green-400' : 'text-orange-400')}>
                                {rcReport.ok
                                    ? 'THE PILOT CAN TAKE THIS AIRCRAFT BACK'
                                    : 'RC TAKEOVER IS NOT FULLY CONFIGURED'}
                            </div>
                            {rcReport.error && (
                                <p className="text-[10px] font-mono text-orange-300/80">{rcReport.error}</p>
                            )}
                            {rcReport.findings.filter(f => f.verdict !== 'ok').map(f => (
                                <p key={f.param} className="text-[10px] font-mono leading-relaxed break-words"
                                    style={{ color: f.verdict === 'blocked' ? '#f87171' : '#fdba74' }}
                                >
                                    <span className="font-bold">{f.param}={f.value}</span> - {f.detail}
                                </p>
                            ))}
                            {rcReport.unreadable.length > 0 && (
                                <p className="text-[10px] font-mono text-orange-300/70 break-words">
                                    Not present on this airframe: {rcReport.unreadable.join(', ')}
                                </p>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Arm / Disarm */}
            <Button
                size="sm"
                className={cn(
                    'w-full font-mono text-xs gap-2 transition-colors',
                    armed
                        ? 'border-orange-500/40 text-orange-500 hover:bg-orange-500/10'
                        : 'border-green-500/40 text-green-500 hover:bg-green-500/10'
                )}
                variant="outline"
                disabled={!connected || armPending}
                onClick={(!isGroup && armed) ? disarm : arm}
            >
                {armPending
                    ? <><Loader size={13} className="animate-spin" /> {armed ? 'DISARMING' : 'ARMING'}…</>
                    : (!isGroup && armed)
                        ? <><ShieldOff size={13} /> DISARM</>
                        : <><Shield size={13} /> ARM{groupTargets.length > 1 ? ' ALL' : ''}</>
                }
            </Button>

            {/* Group disarm is its own button - group members can be in mixed
                armed states, so arm/disarm can't share one toggle */}
            {isGroup && (
                <Button
                    size="sm"
                    variant="outline"
                    className="w-full font-mono text-xs gap-2 border-orange-500/40 text-orange-500 hover:bg-orange-500/10"
                    onClick={disarm}
                >
                    <ShieldOff size={13} /> DISARM{groupTargets.length > 1 ? ' ALL' : ''}
                </Button>
            )}

            {/* Action grid */}
            <div className="grid grid-cols-2 gap-2">
                <Button
                    size="sm" variant="outline"
                    className="font-mono text-xs gap-1.5 hover:border-cyan-500/50 hover:text-cyan-500"
                    disabled={!canTakeoff}
                    onClick={() => sendAction('takeoff', { altitude: takeoffAlt })}
                    title={isGroup ? `Takeoff ${groupTargets.length} drones to ${takeoffAlt} m`
                        : !armed ? 'Arm first' : inAir ? 'Already airborne' : 'Takeoff'}
                >
                    <PlaneTakeoff size={12} /> Takeoff
                </Button>

                <Button
                    size="sm" variant="outline"
                    className="font-mono text-xs gap-1.5 hover:border-sky-500/50 hover:text-sky-500"
                    disabled={!canFly}
                    onClick={() => sendAction('land')}
                >
                    <PlaneLanding size={12} /> Land
                </Button>

                <Button
                    size="sm" variant="outline"
                    className="font-mono text-xs gap-1.5 hover:border-yellow-500/50 hover:text-yellow-500"
                    disabled={!canFly}
                    onClick={() => sendAction('hold')}
                >
                    <MapPin size={12} /> Hold
                </Button>

                <Button
                    size="sm" variant="outline"
                    className="font-mono text-xs gap-1.5 hover:border-purple-500/50 hover:text-purple-500"
                    disabled={!canFly}
                    onClick={() => sendAction('return')}
                >
                    <RotateCcw size={12} /> RTL
                </Button>
            </div>

        </div>
    )
}