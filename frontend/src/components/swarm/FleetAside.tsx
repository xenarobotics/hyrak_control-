'use client'

import { useState, useEffect } from 'react'
import {
    Plus, ChevronDown, ChevronRight, Wifi, ScanLine, RefreshCw, X,
    Check, Zap, MoveVertical, AlertTriangle, Unplug, PlayCircle,
} from 'lucide-react'
import { useSwarmStore } from '@/store/swarm'
import {
    FLEET_COLORS, portForDrone, FLEET_SCAN_COUNT, GROUP_TAKEOFF_ALT,
} from '@/lib/fleet'
import { getSocket } from '@/lib/socket'

function triggerScan() {
    getSocket().emit('scan_swarm_drones', { count: FLEET_SCAN_COUNT })
}

export function FleetAside() {
    const {
        drones, activeDroneId, scanStatus, selectedIds, lastGroupResult,
        setActiveDrone, addDrone, removeDrone, toggleSelected, setSelected, setGroupResult,
    } = useSwarmStore()
    const latestAlert = useSwarmStore(s => s.alerts[0])
    const [showAdd, setShowAdd]         = useState(false)
    const [expandedIds, setExpandedIds] = useState<number[]>([])
    const [form, setForm]               = useState({ name: '', port: '14541' })
    const [selectedColor, setSelectedColor] = useState(FLEET_COLORS[1])
    const [killConfirm, setKillConfirm] = useState(false)
    const [groupAlt, setGroupAlt]       = useState(GROUP_TAKEOFF_ALT)

    // Auto-scan for SITL drones on mount
    useEffect(() => {
        triggerScan()
    }, [])

    // Group result feedback auto-clears
    useEffect(() => {
        if (!lastGroupResult) return
        const t = setTimeout(() => setGroupResult(null), 4000)
        return () => clearTimeout(t)
    }, [lastGroupResult, setGroupResult])

    // Kill confirm times out
    useEffect(() => {
        if (!killConfirm) return
        const t = setTimeout(() => setKillConfirm(false), 3000)
        return () => clearTimeout(t)
    }, [killConfirm])

    const droneList = Object.values(drones).sort((a, b) => a.id - b.id)
    const connected = droneList.filter(d => d.connected)
    const armed     = connected.filter(d => d.telemetry?.flight_mode?.is_armed)
    const flying    = connected.filter(d => d.telemetry?.flight_mode?.is_in_air)
    const battLevels = connected
        .map(d => d.telemetry?.battery?.remaining_percent)
        .filter((n): n is number => n != null)
    const minBatt = battLevels.length ? Math.min(...battLevels) : null

    // Commands target ONLY the ticked drones (matches Flight Controls routing)
    const targetIds = selectedIds
        .filter(id => drones[id]?.connected)
        .sort((a, b) => a - b)
    const allSelected = connected.length > 0 && selectedIds.length >= connected.length

    const sendGroup = (action: string, extra: Record<string, unknown> = {}) => {
        if (targetIds.length === 0) return
        getSocket().emit('swarm_group_action', { drone_ids: targetIds, action, ...extra })
    }

    const handleKill = () => {
        if (!killConfirm) {
            setKillConfirm(true)
            return
        }
        setKillConfirm(false)
        sendGroup('emergency_stop')
    }

    const handleConnect = () => {
        const nextId = droneList.length > 0
            ? Math.max(...droneList.map(d => d.id)) + 1
            : 1
        const name = form.name.trim() || `Drone ${nextId}`
        addDrone(nextId, name, selectedColor)
        getSocket().emit('connect_swarm_drone', {
            drone_id: nextId,
            port: parseInt(form.port) || 14541,
            name,
            color: selectedColor,
        })
        setShowAdd(false)
        setForm({ name: '', port: '14541' })
    }

    const handleRemove = (id: number, e: React.MouseEvent) => {
        e.stopPropagation()
        getSocket().emit('disconnect_swarm_drone', { drone_id: id })
        removeDrone(id)
        setExpandedIds(ids => ids.filter(i => i !== id))
    }

    const handleDisconnectAll = () => {
        for (const d of droneList) {
            getSocket().emit('disconnect_swarm_drone', { drone_id: d.id })
            removeDrone(d.id)
        }
        setExpandedIds([])
    }

    // Per-drone health flags surfaced as a row warning
    const healthIssue = (d: (typeof droneList)[number]): string | null => {
        const tel = d.telemetry
        if (!d.connected) return null
        const batt = tel?.battery?.remaining_percent
        if (batt != null && batt < 25) return `Low battery: ${batt.toFixed(0)}%`
        return null
    }

    const handleSelectDrone = (id: number) => {
        setActiveDrone(activeDroneId === id ? null : id)
    }

    return (
        <aside
            className="w-56 shrink-0 flex flex-col border-l overflow-hidden"
            style={{ background: 'hsl(var(--app-sidebar))', borderColor: 'hsl(var(--app-border))' }}
        >
            {/* Header */}
            <div
                className="flex items-center justify-between px-3 py-2.5 shrink-0 border-b"
                style={{ borderColor: 'hsl(var(--app-border))' }}
            >
                <span
                    className="text-[10px] font-mono tracking-widest"
                    style={{ color: 'hsl(var(--app-text-muted))' }}
                >
                    FLEET
                </span>
                <div className="flex items-center gap-1">
                    <button
                        onClick={triggerScan}
                        disabled={scanStatus === 'scanning'}
                        title="Re-scan for drones"
                        className="rounded p-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-40"
                    >
                        <RefreshCw
                            size={12}
                            className={scanStatus === 'scanning' ? 'animate-spin' : ''}
                            style={{ color: 'hsl(var(--app-text-muted))' }}
                        />
                    </button>
                    <button
                        onClick={() => setShowAdd(v => !v)}
                        title="Add drone manually"
                        className="rounded p-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                    >
                        <Plus size={12} style={{ color: 'hsl(var(--app-text-muted))' }} />
                    </button>
                    {droneList.length > 0 && (
                        <button
                            onClick={handleDisconnectAll}
                            title="Disconnect all drones"
                            className="rounded p-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                        >
                            <Unplug size={12} style={{ color: '#f87171' }} />
                        </button>
                    )}
                </div>
            </div>

            {/* Fleet summary strip */}
            {droneList.length > 0 && (
                <div
                    className="flex items-center gap-2 px-3 py-1.5 text-[9px] font-mono border-b shrink-0"
                    style={{ borderColor: 'hsl(var(--app-border))', color: 'hsl(var(--app-text-muted))' }}
                >
                    <span style={{ color: connected.length ? '#10b981' : undefined }}>
                        {connected.length}/{droneList.length} ONLINE
                    </span>
                    <span style={{ color: armed.length ? '#f59e0b' : undefined }}>
                        {armed.length} ARMED
                    </span>
                    <span style={{ color: flying.length ? '#22d3ee' : undefined }}>
                        {flying.length} AIR
                    </span>
                    {minBatt != null && (
                        <span
                            className="ml-auto"
                            style={{ color: minBatt < 25 ? '#ef4444' : undefined }}
                            title="Lowest battery in fleet"
                        >
                            ▼{minBatt.toFixed(0)}%
                        </span>
                    )}
                </div>
            )}

            {/* Scan status banner */}
            {scanStatus === 'scanning' && (
                <div
                    className="flex items-center gap-1.5 px-3 py-1.5 text-[9px] font-mono border-b shrink-0"
                    style={{ borderColor: 'hsl(var(--app-border))', color: '#22d3ee' }}
                >
                    <ScanLine size={10} className="animate-pulse" />
                    Scanning for drones…
                </div>
            )}
            {scanStatus === 'done' && droneList.length === 0 && (
                <div
                    className="flex items-center gap-1.5 px-3 py-1.5 text-[9px] font-mono border-b shrink-0"
                    style={{ borderColor: 'hsl(var(--app-border))', color: 'hsl(var(--app-text-muted))' }}
                >
                    No SITL drones found
                </div>
            )}

            {/* Group command bar */}
            {connected.length > 0 && (
                <div
                    className="px-2 py-2 border-b shrink-0 flex flex-col gap-1.5"
                    style={{ borderColor: 'hsl(var(--app-border))' }}
                >
                    <div className="flex items-center justify-between px-1">
                        <button
                            onClick={() => setSelected(allSelected ? [] : connected.map(d => d.id))}
                            className="flex items-center gap-1 text-[9px] font-mono hover:opacity-80 transition-opacity"
                            style={{ color: 'hsl(var(--app-text-muted))' }}
                        >
                            <span
                                className="w-3 h-3 rounded-sm border flex items-center justify-center"
                                style={{
                                    borderColor: 'hsl(var(--app-border))',
                                    background: allSelected ? '#22d3ee' : 'transparent',
                                }}
                            >
                                {allSelected && <Check size={9} className="text-black" />}
                            </span>
                            {targetIds.length ? `${targetIds.length} SELECTED` : 'SELECT ALL'}
                        </button>
                        <span className="text-[9px] font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>
                            FLEET CMD
                        </span>
                    </div>

                    {/* SET ALT: grounded drones arm + take off to this height,
                        flying drones re-position to it. Per-drone flight
                        commands live in Flight Controls for the active drone. */}
                    <div className="flex items-center gap-1">
                        <input
                            type="number"
                            min={2}
                            max={120}
                            value={groupAlt}
                            onChange={e => setGroupAlt(Math.max(1, Number(e.target.value) || 1))}
                            className="w-14 text-[10px] font-mono px-1.5 py-1 rounded border bg-transparent outline-none focus:border-cyan-500 transition-colors"
                            style={{ borderColor: 'hsl(var(--app-border))', color: 'hsl(var(--app-text))' }}
                            title="Fleet altitude target (m)"
                        />
                        <span className="text-[9px] font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>m</span>
                        <button
                            onClick={() => sendGroup('set_altitude', { altitude: groupAlt })}
                            disabled={targetIds.length === 0}
                            className="flex-1 flex items-center justify-center gap-1 text-[9px] font-mono py-1.5 rounded border transition-colors hover:border-cyan-500 hover:text-cyan-400 disabled:opacity-40"
                            style={{ borderColor: 'hsl(var(--app-border))', color: 'hsl(var(--app-text-muted))' }}
                            title={`All targeted drones fly to ${groupAlt} m (grounded ones take off to it)`}
                        >
                            <MoveVertical size={10} />
                            SET ALT
                        </button>
                    </div>

                    {/* Start each ticked drone's own uploaded mission (arms
                        first if needed; finished missions rewind to WP 0) */}
                    <button
                        onClick={() => sendGroup('arm_and_start_mission')}
                        disabled={targetIds.length === 0}
                        className="flex items-center justify-center gap-1 text-[9px] font-mono py-1.5 rounded border transition-colors hover:border-green-500 hover:text-green-400 disabled:opacity-40"
                        style={{ borderColor: 'hsl(var(--app-border))', color: '#4ade80' }}
                        title="Arm + start the uploaded mission on every ticked drone"
                    >
                        <PlayCircle size={10} />
                        START MISSION
                    </button>

                    <button
                        onClick={handleKill}
                        disabled={targetIds.length === 0}
                        className="flex items-center justify-center gap-1 text-[9px] font-mono py-1.5 rounded border transition-colors disabled:opacity-40"
                        style={{
                            borderColor: killConfirm ? '#ef4444' : 'hsl(var(--app-border))',
                            color: '#ef4444',
                            background: killConfirm ? '#ef444422' : 'transparent',
                        }}
                    >
                        <Zap size={10} />
                        {killConfirm ? `CONFIRM KILL ${targetIds.length} DRONE${targetIds.length > 1 ? 'S' : ''}?` : 'KILL'}
                    </button>

                    {lastGroupResult && (
                        <div
                            className="text-[9px] font-mono text-center py-0.5 rounded"
                            style={{
                                color: lastGroupResult.okCount === lastGroupResult.total ? '#10b981' : '#f59e0b',
                                background: (lastGroupResult.okCount === lastGroupResult.total ? '#10b981' : '#f59e0b') + '15',
                            }}
                        >
                            {lastGroupResult.action.toUpperCase()}: {lastGroupResult.okCount}/{lastGroupResult.total} OK
                        </div>
                    )}

                    {/* Latest supervisor alert (full feed on the mission page) */}
                    {latestAlert && (
                        <div
                            className="flex items-center gap-1.5 text-[9px] font-mono px-1.5 py-1 rounded truncate"
                            title={latestAlert.msg}
                            style={{
                                color: latestAlert.severity === 'critical' ? '#f87171'
                                    : latestAlert.severity === 'warn' ? '#fbbf24' : '#22d3ee',
                                background: (latestAlert.severity === 'critical' ? '#f87171'
                                    : latestAlert.severity === 'warn' ? '#fbbf24' : '#22d3ee') + '12',
                            }}
                        >
                            <span
                                className={`w-1.5 h-1.5 rounded-full shrink-0 ${latestAlert.severity === 'critical' ? 'animate-pulse' : ''}`}
                                style={{ background: 'currentColor' }}
                            />
                            <span className="truncate">{latestAlert.msg}</span>
                        </div>
                    )}
                </div>
            )}

            {/* Manual add-drone form */}
            {showAdd && (
                <div
                    className="p-3 border-b flex flex-col gap-2 shrink-0"
                    style={{ borderColor: 'hsl(var(--app-border))' }}
                >
                    <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[9px] font-mono tracking-wider" style={{ color: 'hsl(var(--app-text-muted))' }}>
                            MANUAL CONNECT
                        </span>
                        <button onClick={() => setShowAdd(false)}>
                            <X size={10} style={{ color: 'hsl(var(--app-text-muted))' }} />
                        </button>
                    </div>
                    <input
                        value={form.name}
                        onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                        placeholder="Name (e.g. Drone 2)"
                        className="w-full text-xs px-2 py-1.5 rounded border bg-transparent outline-none focus:border-cyan-500 transition-colors"
                        style={{ borderColor: 'hsl(var(--app-border))', color: 'hsl(var(--app-text))' }}
                    />
                    <input
                        value={form.port}
                        onChange={e => setForm(f => ({ ...f, port: e.target.value }))}
                        placeholder="UDP port (e.g. 14541)"
                        className="w-full text-xs px-2 py-1.5 rounded border bg-transparent outline-none focus:border-cyan-500 transition-colors"
                        style={{ borderColor: 'hsl(var(--app-border))', color: 'hsl(var(--app-text))' }}
                    />
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>Color</span>
                        <div className="flex gap-1.5 flex-wrap">
                            {FLEET_COLORS.slice(0, 10).map(c => (
                                <button
                                    key={c}
                                    onClick={() => setSelectedColor(c)}
                                    className="w-4 h-4 rounded-full transition-all"
                                    style={{
                                        background: c,
                                        outline: selectedColor === c ? `2px solid white` : 'none',
                                        outlineOffset: 1,
                                    }}
                                />
                            ))}
                        </div>
                    </div>
                    <button
                        onClick={handleConnect}
                        className="w-full text-xs py-1.5 rounded bg-cyan-500 hover:bg-cyan-600 text-white font-mono transition-colors"
                    >
                        Connect
                    </button>
                </div>
            )}

            {/* Active drone label */}
            {activeDroneId !== null && drones[activeDroneId] && (
                <div
                    className="flex items-center justify-between px-3 py-1.5 text-[9px] font-mono shrink-0 border-b"
                    style={{ borderColor: 'hsl(var(--app-border))' }}
                >
                    <span style={{ color: 'hsl(var(--app-text-muted))' }}>Controlling</span>
                    <span
                        className="rounded px-1.5 py-0.5 font-bold"
                        style={{
                            background: drones[activeDroneId].color + '22',
                            color: drones[activeDroneId].color,
                        }}
                    >
                        {drones[activeDroneId].name}
                    </span>
                </div>
            )}

            {/* Drone list */}
            <div className="flex-1 overflow-y-auto py-2 min-h-0">
                {droneList.length === 0 && scanStatus === 'idle' && (
                    <p
                        className="text-center text-[10px] font-mono mt-8 px-4 leading-relaxed"
                        style={{ color: 'hsl(var(--app-text-muted))' }}
                    >
                        Scanning for drones…
                    </p>
                )}

                {droneList.map(drone => {
                    const isActive   = drone.id === activeDroneId
                    const isExpanded = expandedIds.includes(drone.id)
                    const isSelected = selectedIds.includes(drone.id)
                    const tel        = drone.telemetry
                    const droneArmed = tel?.flight_mode?.is_armed ?? false
                    const warning    = healthIssue(drone)

                    return (
                        <div
                            key={drone.id}
                            className="mx-2 mb-1.5 rounded-lg overflow-hidden cursor-pointer transition-all"
                            style={{
                                border: `${isActive ? 2 : 1}px solid ${isActive ? drone.color : 'hsl(var(--app-border))'}`,
                                boxShadow: isActive ? `0 0 0 1px ${drone.color}30` : 'none',
                            }}
                            onClick={() => handleSelectDrone(drone.id)}
                        >
                            {/* Collapsed header row */}
                            <div className="flex items-center gap-1.5 px-2 py-1.5">
                                <button
                                    className="shrink-0 w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors"
                                    style={{
                                        borderColor: isSelected ? drone.color : 'hsl(var(--app-border))',
                                        background: isSelected ? drone.color : 'transparent',
                                    }}
                                    title="Include in group commands"
                                    onClick={e => { e.stopPropagation(); toggleSelected(drone.id) }}
                                >
                                    {isSelected && <Check size={9} className="text-black" />}
                                </button>
                                <div
                                    className="w-2 h-2 rounded-full shrink-0 transition-colors"
                                    style={{ background: drone.connected ? drone.color : '#71717a' }}
                                />
                                <span
                                    className="text-xs font-mono font-medium flex-1 truncate"
                                    style={{ color: 'hsl(var(--app-text))' }}
                                >
                                    {drone.name}
                                </span>
                                {warning && (
                                    <span className="shrink-0" title={warning}>
                                        <AlertTriangle size={10} color="#ef4444" />
                                    </span>
                                )}
                                {droneArmed && (
                                    <span
                                        className="text-[8px] font-mono font-bold px-1 rounded shrink-0"
                                        style={{ background: '#f59e0b25', color: '#f59e0b' }}
                                    >
                                        ARM
                                    </span>
                                )}
                                {isActive && (
                                    <span
                                        className="text-[8px] font-mono font-bold px-1 rounded shrink-0"
                                        style={{ background: drone.color + '30', color: drone.color }}
                                    >
                                        CTRL
                                    </span>
                                )}
                                <button
                                    className="shrink-0 opacity-40 hover:opacity-80 transition-opacity"
                                    onClick={e => {
                                        e.stopPropagation()
                                        setExpandedIds(ids => isExpanded
                                            ? ids.filter(i => i !== drone.id)
                                            : [...ids, drone.id])
                                    }}
                                >
                                    {isExpanded
                                        ? <ChevronDown size={11} />
                                        : <ChevronRight size={11} />}
                                </button>
                            </div>

                            {/* Quick-status line */}
                            {tel && (
                                <div
                                    className="flex gap-2 px-2 pb-1.5 text-[9px] font-mono"
                                    style={{ color: 'hsl(var(--app-text-muted))' }}
                                >
                                    <span>{tel.flight_mode?.mode ?? '—'}</span>
                                    <span>
                                        {tel.battery?.remaining_percent != null
                                            ? `${tel.battery.remaining_percent.toFixed(0)}%`
                                            : '—'}
                                    </span>
                                    <span>
                                        {tel.position?.relative_altitude_m != null
                                            ? `↑${tel.position.relative_altitude_m.toFixed(0)}m`
                                            : '—'}
                                    </span>
                                </div>
                            )}

                            {!tel && !drone.connected && (
                                <div
                                    className="flex items-center gap-1.5 px-2 pb-1.5 text-[9px] font-mono"
                                    style={{ color: 'hsl(var(--app-text-muted))' }}
                                >
                                    <Wifi size={9} />
                                    <span>Connecting…</span>
                                </div>
                            )}

                            {/* Expanded detail card */}
                            {isExpanded && (
                                <div
                                    className="border-t px-2.5 py-2 flex flex-col gap-1"
                                    style={{ borderColor: 'hsl(var(--app-border))' }}
                                >
                                    {([
                                        ['Mode',    tel?.flight_mode?.mode ?? '—'],
                                        ['Battery', tel?.battery
                                            ? `${tel.battery.remaining_percent.toFixed(0)}% · ${tel.battery.voltage_v.toFixed(1)}v`
                                            : '—'],
                                        ['Alt',     tel?.position
                                            ? `${tel.position.relative_altitude_m.toFixed(1)} m AGL`
                                            : '—'],
                                        ['Speed',   tel?.groundspeed_m_s != null
                                            ? `${tel.groundspeed_m_s.toFixed(1)} m/s`
                                            : '—'],
                                        ['GPS',     tel?.gps
                                            ? `${tel.gps.fix_type === 3 ? '3D' : tel.gps.fix_type === 2 ? '2D' : 'No'} Fix · ${tel.gps.satellites_visible} sat`
                                            : '—'],
                                        ['Port',    `UDP ${portForDrone(drone.id)}`],
                                    ] as [string, string][]).map(([label, value]) => (
                                        <div key={label} className="flex justify-between text-[9px] font-mono">
                                            <span style={{ color: 'hsl(var(--app-text-muted))' }}>{label}</span>
                                            <span style={{ color: 'hsl(var(--app-text))' }}>{value}</span>
                                        </div>
                                    ))}
                                    <div className="flex gap-1 mt-1">
                                        <button
                                            onClick={e => { e.stopPropagation(); handleSelectDrone(drone.id) }}
                                            className="flex-1 text-[9px] font-mono py-0.5 rounded transition-colors"
                                            style={{
                                                background: isActive ? drone.color + '22' : 'transparent',
                                                color: isActive ? drone.color : 'hsl(var(--app-text-muted))',
                                                border: `1px solid ${isActive ? drone.color + '40' : 'hsl(var(--app-border))'}`,
                                            }}
                                        >
                                            {isActive ? 'Deselect' : 'Select'}
                                        </button>
                                        <button
                                            onClick={e => handleRemove(drone.id, e)}
                                            className="text-[9px] font-mono text-red-400 hover:text-red-300 px-2 py-0.5 rounded transition-colors"
                                            style={{ border: '1px solid hsl(var(--app-border))' }}
                                        >
                                            Remove
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>

            {/* Footer hint */}
            <div
                className="px-3 py-2 shrink-0 border-t text-[9px] font-mono text-center"
                style={{ borderColor: 'hsl(var(--app-border))', color: 'hsl(var(--app-text-muted))' }}
            >
                Click a drone to control · ☐ for group cmds
            </div>
        </aside>
    )
}
