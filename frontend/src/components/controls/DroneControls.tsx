'use client'

import { useState, useEffect } from 'react'

import { useDrone } from '@/hooks/useDrone'
import { useDroneStore } from '@/store/drone'
import { useSwarmStore } from '@/store/swarm'
import { Button } from '@/components/ui/button'
import {
    Select, SelectContent, SelectItem,
    SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
    Shield, ShieldOff, PlaneTakeoff,
    RotateCcw, MapPin, PlaneLanding
} from 'lucide-react'
import { cn } from '@/lib/utils'

const FLIGHT_MODES = [
    { value: 'HOLD', label: 'Hold', description: 'Hover in place' },
    { value: 'POSITION', label: 'Position', description: 'GPS hold, hover in place' },
    { value: 'STABILIZED', label: 'Stabilized', description: 'Self-levels, no GPS hold' },
    { value: 'MISSION', label: 'Mission', description: 'Follow uploaded waypoints' },
    { value: 'RETURN', label: 'Return to Launch', description: 'Fly home and land' },
    { value: 'LAND', label: 'Land', description: 'Descend and land now' },
    { value: 'OFFBOARD', label: 'Offboard', description: 'AI / software control' },
]

export function DroneControls() {
    const [mounted, setMounted] = useState(false)
    const [takeoffAlt, setTakeoffAlt] = useState(5)
    useEffect(() => { setMounted(true) }, [])

    const { arm, disarm, sendAction } = useDrone()
    const { telemetry, telemetryStatus } = useDroneStore()
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

    const armed = telemetry?.flight_mode?.is_armed ?? false
    const inAir = telemetry?.flight_mode?.is_in_air ?? false
    const mode  = telemetry?.flight_mode?.mode ?? '—'
    const connected = swarmEnabled ? isGroup : telemetryStatus === 'connected'
    // Group targets are in mixed states (some armed, some flying) — the
    // per-drone armed/in-air gates only make sense for the primary drone. The
    // backend reports per-drone failures for whichever can't comply.
    const canTakeoff = isGroup ? connected : (connected && armed && !inAir)
    const canFly     = isGroup ? connected : (connected && inAir)

    if (!mounted) {
        return <div className="space-y-3 min-h-[175px]" />
    }

    return (
        <div className="space-y-3">

            {/* Swarm command target — ticked drones only */}
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

            {/* Flight mode selector */}
            <Select
                disabled={!connected}
                onValueChange={(m) => m && sendAction('set_mode', { mode: m })}
            >
                <SelectTrigger className="h-8 text-xs font-mono">
                    <SelectValue placeholder="Change flight mode..." />
                </SelectTrigger>
                <SelectContent>
                    {FLIGHT_MODES.map(m => (
                        <SelectItem key={m.value} value={m.value} className="text-xs">
                            <div>
                                <div className="font-mono font-medium">{m.label}</div>
                                <div className="text-[10px] text-muted-foreground">{m.description}</div>
                            </div>
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

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
                disabled={!connected}
                onClick={(!isGroup && armed) ? disarm : arm}
            >
                {(!isGroup && armed)
                    ? <><ShieldOff size={13} /> DISARM</>
                    : <><Shield size={13} /> ARM{groupTargets.length > 1 ? ' ALL' : ''}</>
                }
            </Button>

            {/* Group disarm is its own button — group members can be in mixed
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