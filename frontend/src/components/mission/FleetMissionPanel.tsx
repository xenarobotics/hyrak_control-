'use client'

// Fleet mission console for GENERAL waypoint missions (the survey planner has
// its own splitter in FleetSurveyPanel). Shows every connected fleet drone's
// plan + upload + flight state in one strip, bulk-uploads all plans, checks
// lanes against each other for conflicts, and group-starts with an optional
// liftoff stagger. Plan per drone by selecting it (its plan swaps into the
// editor), then run the whole fleet from here.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMissionStore, planKeyForDrone, planSignature, type DronePlan } from '@/store/mission'
import { useSwarmStore } from '@/store/swarm'
import { getSocket } from '@/lib/socket'
import { expandWaypointsWithTurnRadius } from '@/lib/uploadPath'
import { findLaneConflicts, type Lane } from '@/lib/deconflict'
import type { Waypoint } from '@/types/mission'
import {
    Users, Upload, PlayCircle, Loader2, Check, AlertTriangle,
    ChevronDown, ChevronUp, CornerUpRight, Layers,
} from 'lucide-react'

let _rsCounter = 0
const rsUid = () => `rs_${Date.now()}_${++_rsCounter}`

const ALERT_COLORS: Record<string, string> = {
    info: '#22d3ee', warn: '#fbbf24', critical: '#f87171',
}

type UploadState = 'idle' | 'uploading' | 'ok' | 'fail'

export default function FleetMissionPanel({ leftOffset }: { leftOffset: string }) {
    const swarmEnabled  = useSwarmStore(s => s.enabled)
    const drones        = useSwarmStore(s => s.drones)
    const activeDroneId = useSwarmStore(s => s.activeDroneId)
    const setActiveDrone = useSwarmStore(s => s.setActiveDrone)
    const alerts        = useSwarmStore(s => s.alerts)

    const plans              = useMissionStore(s => s.plans)
    const waypoints          = useMissionStore(s => s.waypoints)
    const activePlanKey      = useMissionStore(s => s.activePlanKey)
    const uploadedSignatures = useMissionStore(s => s.uploadedSignatures)
    const assignFleetPlans   = useMissionStore(s => s.assignFleetPlans)
    const autoHeading        = useMissionStore(s => s.autoHeading)
    const terrainFollow      = useMissionStore(s => s.terrainFollow)

    const [open, setOpen] = useState(true)
    const [uploadStates, setUploadStates] = useState<Record<number, UploadState>>({})
    const [staggerS, setStaggerS] = useState(2)
    const [feedback, setFeedback] = useState<string | null>(null)
    const [reassignFrom, setReassignFrom] = useState<number | null>(null)
    // Orange-ack batching: needs_ack results collected briefly, then ONE
    // confirm dialog re-uploads all of them with ack_orange
    const ackPendingRef = useRef<Set<number>>(new Set())
    const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    // Uploads THIS panel initiated — the mission page runs its own ack/permit
    // dialogs for uploads made from its Upload button, so ignore those here.
    const panelUploadsRef = useRef<Set<number>>(new Set())

    const connected = useMemo(
        () => Object.values(drones).filter(d => d.connected).sort((a, b) => a.id - b.id),
        [drones],
    )

    // The active drone's plan is the working set, not yet banked in `plans`.
    const planFor = (id: number): DronePlan | undefined => {
        const key = planKeyForDrone(id)
        if (key === activePlanKey) return { waypoints, rtlPosition: null }
        return plans[key]
    }

    // Upload results — mark the store signature so ARM/START gates open and
    // stay open for that drone regardless of selection changes. Orange-zone
    // needs_ack results are batched into one confirm dialog.
    useEffect(() => {
        const socket = getSocket()

        const flushAckBatch = () => {
            ackTimerRef.current = null
            const ids = [...ackPendingRef.current]
            ackPendingRef.current.clear()
            if (ids.length === 0) return
            const st = useMissionStore.getState()
            const names = ids.map(id => drones[id]?.name ?? `Drone ${id}`).join(', ')
            if (!window.confirm(
                `${ids.length} mission(s) pass through restricted (orange) zones (${names}).\n\n` +
                `Pilots will get warnings while inside. Upload anyway?`
            )) {
                setUploadStates(s => {
                    const next = { ...s }
                    for (const id of ids) next[id] = 'fail'
                    return next
                })
                return
            }
            for (const id of ids) {
                const key = planKeyForDrone(id)
                const plan = key === st.activePlanKey ? { waypoints: st.waypoints } : st.plans[key]
                if (!plan || plan.waypoints.length === 0) continue
                socket.emit('swarm_upload_mission', {
                    drone_id: id,
                    terrain_follow: useMissionStore.getState().terrainFollow,
                    waypoints: expandWaypointsWithTurnRadius(plan.waypoints, useMissionStore.getState().autoHeading),
                    ack_orange: true,
                })
            }
            setUploadStates(s => {
                const next = { ...s }
                for (const id of ids) next[id] = 'uploading'
                return next
            })
        }

        const onUpload = (data: {
            drone_id: number; ok: boolean; msg?: string; needs_ack?: boolean
        }) => {
            if (data.needs_ack) {
                if (!panelUploadsRef.current.has(data.drone_id)) return
                ackPendingRef.current.add(data.drone_id)
                if (!ackTimerRef.current) ackTimerRef.current = setTimeout(flushAckBatch, 400)
                return
            }
            panelUploadsRef.current.delete(data.drone_id)
            setUploadStates(s =>
                s[data.drone_id] === 'uploading'
                    ? { ...s, [data.drone_id]: data.ok ? 'ok' : 'fail' }
                    : s,
            )
            if (data.ok) {
                const st = useMissionStore.getState()
                const key = planKeyForDrone(data.drone_id)
                const plan = key === st.activePlanKey
                    ? { waypoints: st.waypoints }
                    : st.plans[key]
                if (plan && plan.waypoints.length > 0) {
                    useMissionStore.getState().markPlanUploaded(key, planSignature(plan.waypoints))
                }
            } else if (data.msg) {
                setFeedback(`${drones[data.drone_id]?.name ?? `Drone ${data.drone_id}`}: ${data.msg}`)
            }
        }
        const onGroup = (data: { action: string; ok_count: number; total: number }) => {
            if (data.action === 'arm_and_start_mission' || data.action === 'arm_and_restart_mission') {
                setFeedback(`Mission started on ${data.ok_count}/${data.total} drones`)
                setTimeout(() => setFeedback(null), 6000)
            }
        }
        socket.on('swarm_mission_upload_result', onUpload)
        socket.on('swarm_group_result', onGroup)
        return () => {
            socket.off('swarm_mission_upload_result', onUpload)
            socket.off('swarm_group_result', onGroup)
        }
    }, [drones])

    // Lane-vs-lane conflict check across all planned drones (advisory)
    const conflicts = useMemo(() => {
        const lanes: Lane[] = connected
            .map(d => ({ id: d.id, name: d.name, wps: planFor(d.id)?.waypoints ?? [] }))
            .filter(l => l.wps.length >= 2)
        return findLaneConflicts(lanes)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connected, plans, waypoints, activePlanKey])

    // Expanded upload lengths per drone — mission_current_index refers to the
    // EXPANDED (turn-radius) list, so remainder mapping needs the ratio.
    const connectedIds = connected.map(d => d.id).join(',')
    const expandedLens = useMemo(() => {
        const m: Record<number, number> = {}
        for (const d of connected) {
            const p = planFor(d.id)
            if (p && p.waypoints.length > 0) {
                m[d.id] = expandWaypointsWithTurnRadius(p.waypoints, false).length
            }
        }
        return m
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connectedIds, plans, waypoints, activePlanKey])

    if (!swarmEnabled || connected.length === 0) return null

    const planned = connected.filter(d => (planFor(d.id)?.waypoints.length ?? 0) > 0)
    const uploadedIds = planned
        .filter(d => {
            const plan = planFor(d.id)!
            return uploadedSignatures[planKeyForDrone(d.id)] === planSignature(plan.waypoints)
        })
        .map(d => d.id)
    const anyUploading = Object.values(uploadStates).some(s => s === 'uploading')

    const handleUploadAll = () => {
        const states: Record<number, UploadState> = {}
        for (const d of planned) {
            const plan = planFor(d.id)!
            states[d.id] = 'uploading'
            panelUploadsRef.current.add(d.id)
            getSocket().emit('swarm_upload_mission', {
                drone_id: d.id,
                terrain_follow: terrainFollow,
                waypoints: expandWaypointsWithTurnRadius(plan.waypoints, autoHeading),
            })
        }
        setUploadStates(states)
        if (planned.length === 0) setFeedback('No drone has a plan yet — select a drone and add waypoints')
    }

    // Liftoff order: farthest first waypoint launches first, so early starters
    // clear the pad area while closer drones are still waiting their turn.
    const handleStartAll = () => {
        if (uploadedIds.length === 0) {
            setFeedback('Upload missions first — no drone has its current plan on board')
            return
        }
        const distToFirst = (id: number): number => {
            const pos = drones[id]?.telemetry?.position
            const first = planFor(id)?.waypoints[0]
            if (!pos || !first || (!pos.latitude_deg && !pos.longitude_deg)) return 0
            const dx = (first.lng - pos.longitude_deg) * 111_320 * Math.cos(pos.latitude_deg * Math.PI / 180)
            const dy = (first.lat - pos.latitude_deg) * 111_320
            return Math.sqrt(dx * dx + dy * dy)
        }
        const order = [...uploadedIds].sort((a, b) => distToFirst(b) - distToFirst(a))
        getSocket().emit('swarm_group_action', {
            drone_ids: uploadedIds,
            action: 'arm_and_restart_mission',
            stagger_s: staggerS,
            stagger_order: order,
        })
        setFeedback(staggerS > 0
            ? `Starting ${uploadedIds.length} drones, ${staggerS}s apart…`
            : `Starting ${uploadedIds.length} drones…`)
    }

    // ── Failure reassignment ────────────────────────────────────────────
    // A drone that started its mission but is now disarmed with waypoints left
    const reassignEligible = (id: number): boolean => {
        const plan = planFor(id)
        const tel = drones[id]?.telemetry
        if (!plan || plan.waypoints.length < 2 || !tel) return false
        const mci = tel.mission_current_index ?? -1
        const expLen = expandedLens[id] ?? plan.waypoints.length
        return !tel.flight_mode?.is_armed && mci > 0 && mci < expLen - 1
    }

    const remainderOf = (id: number): Waypoint[] => {
        const plan = planFor(id)
        if (!plan) return []
        const mci = drones[id]?.telemetry?.mission_current_index ?? -1
        const expLen = expandedLens[id] ?? plan.waypoints.length
        if (mci < 0) return plan.waypoints
        const frac = Math.min(1, mci / Math.max(1, expLen - 1))
        const from = Math.min(plan.waypoints.length - 1, Math.floor(frac * (plan.waypoints.length - 1)))
        return plan.waypoints.slice(from)
    }

    const doReassign = (from: number, to: number) => {
        const rem = remainderOf(from).map(w => ({ ...w, id: rsUid() }))
        if (rem.length === 0) { setReassignFrom(null); return }
        assignFleetPlans({
            [planKeyForDrone(to)]: { waypoints: rem, rtlPosition: null },
        })
        setReassignFrom(null)
        setActiveDrone(to)
        setFeedback(
            `${rem.length} remaining wp of ${drones[from]?.name ?? from} → ` +
            `${drones[to]?.name ?? to} — review, then UPLOAD ALL`
        )
    }

    // ── Altitude auto-stagger (conflict fix) ────────────────────────────
    // Offsets each planned drone's whole lane by +2 m per drone (id order),
    // the standard vertical-layering deconfliction. Repeat clicks stack.
    const autoStaggerAlt = () => {
        const updates: Record<string, DronePlan> = {}
        planned.forEach((d, k) => {
            if (k === 0) return
            const plan = planFor(d.id)!
            updates[planKeyForDrone(d.id)] = {
                waypoints: plan.waypoints.map(w => ({ ...w, altitude: w.altitude + k * 2 })),
                rtlPosition: plan.rtlPosition ?? null,
            }
        })
        if (Object.keys(updates).length === 0) return
        assignFleetPlans(updates)
        setFeedback('Lanes layered: +2 m per drone — re-upload before starting')
    }

    return (
        <div
            className="absolute bottom-3 z-[1500] w-[300px] font-mono transition-all duration-200"
            style={{ left: leftOffset }}
        >
            <div
                className="rounded-xl border overflow-hidden"
                style={{
                    background: 'rgba(17, 19, 24, .94)',
                    backdropFilter: 'blur(12px)',
                    borderColor: 'rgba(255, 255, 255, .08)',
                }}
            >
                {/* Header */}
                <button
                    onClick={() => setOpen(v => !v)}
                    className="w-full flex items-center gap-2 px-3 py-2"
                >
                    <Users size={13} color="#22d3ee" />
                    <span className="text-[10px] font-bold tracking-widest" style={{ color: '#a5f3fc' }}>
                        FLEET MISSION — {connected.length} DRONES
                    </span>
                    <span className="ml-auto" style={{ color: '#6b7280' }}>
                        {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
                    </span>
                </button>

                {open && (
                    <div className="px-2.5 pb-2.5 flex flex-col gap-1.5">
                        {/* Per-drone rows */}
                        <div className="flex flex-col gap-1 max-h-44 overflow-y-auto">
                            {connected.map(d => {
                                const plan = planFor(d.id)
                                const wpCount = plan?.waypoints.length ?? 0
                                const uploaded = wpCount > 0 &&
                                    uploadedSignatures[planKeyForDrone(d.id)] === planSignature(plan!.waypoints)
                                const st = uploadStates[d.id] ?? 'idle'
                                const tel = d.telemetry
                                const isActive = d.id === activeDroneId
                                return (
                                    <button
                                        key={d.id}
                                        onClick={() => setActiveDrone(d.id)}
                                        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left"
                                        style={{
                                            background: isActive ? d.color + '18' : 'rgba(255,255,255,.03)',
                                            border: `1px solid ${isActive ? d.color + '55' : 'rgba(255,255,255,.08)'}`,
                                        }}
                                        title="Select to edit this drone's plan"
                                    >
                                        <div className="w-2 h-2 rounded-full shrink-0" style={{ background: d.color }} />
                                        <span className="flex-1 text-[10px] font-bold truncate" style={{ color: d.color }}>
                                            {d.name}
                                        </span>
                                        <span className="text-[9px] tabular-nums" style={{ color: wpCount ? '#d1d5db' : '#4b5563' }}>
                                            {wpCount ? `${wpCount} wp` : 'no plan'}
                                        </span>
                                        {tel?.flight_mode?.is_armed && (
                                            <span className="text-[8px] font-bold px-1 rounded"
                                                style={{ background: 'rgba(245,158,11,.15)', color: '#fbbf24' }}>
                                                {tel.flight_mode.is_in_air ? 'AIR' : 'ARM'}
                                            </span>
                                        )}
                                        {st === 'uploading'
                                            ? <Loader2 size={10} className="animate-spin" color="#facc15" />
                                            : uploaded
                                                ? <Check size={10} color="#4ade80" />
                                                : st === 'fail'
                                                    ? <AlertTriangle size={10} color="#f87171" />
                                                    : <span className="w-2.5 h-2.5 rounded-full border" style={{ borderColor: '#3f3f46' }} />}
                                        {reassignEligible(d.id) && (
                                            <span
                                                onClick={e => {
                                                    e.stopPropagation()
                                                    setReassignFrom(v => v === d.id ? null : d.id)
                                                }}
                                                title="Mission incomplete — hand the remaining waypoints to another drone"
                                                className="px-1 rounded"
                                                style={{
                                                    background: reassignFrom === d.id ? 'rgba(245,158,11,.25)' : 'rgba(255,255,255,.06)',
                                                    color: '#fbbf24',
                                                }}
                                            >
                                                <CornerUpRight size={10} className="inline" />
                                            </span>
                                        )}
                                    </button>
                                )
                            })}
                        </div>

                        {/* Reassignment target picker */}
                        {reassignFrom !== null && (
                            <div
                                className="flex items-center gap-1.5 flex-wrap rounded-md px-2 py-1.5 text-[9px]"
                                style={{ background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.25)' }}
                            >
                                <span style={{ color: '#fcd34d' }}>
                                    Send {remainderOf(reassignFrom).length} remaining wp of{' '}
                                    {drones[reassignFrom]?.name} to:
                                </span>
                                {connected.filter(d => d.id !== reassignFrom).map(d => (
                                    <button
                                        key={d.id}
                                        onClick={() => doReassign(reassignFrom, d.id)}
                                        className="px-1.5 py-0.5 rounded font-bold"
                                        style={{ background: d.color + '22', color: d.color, border: `1px solid ${d.color}55` }}
                                    >
                                        {d.name}
                                    </button>
                                ))}
                                <button
                                    onClick={() => setReassignFrom(null)}
                                    className="ml-auto px-1.5 py-0.5 rounded"
                                    style={{ color: '#9ca3af', background: 'rgba(255,255,255,.06)' }}
                                >
                                    ✕
                                </button>
                            </div>
                        )}

                        {/* Lane conflict advisory + one-click vertical layering */}
                        {conflicts.length > 0 && (
                            <div
                                className="flex flex-col gap-1.5 rounded-md px-2 py-1.5 text-[9px]"
                                style={{ background: 'rgba(245,158,11,.1)', border: '1px solid rgba(245,158,11,.3)', color: '#fcd34d' }}
                            >
                                <div className="flex items-start gap-1.5">
                                    <AlertTriangle size={11} className="shrink-0 mt-px" />
                                    <span>
                                        {conflicts.map(c => `${c.a} × ${c.b} come within ${c.distanceM} m at overlapping altitude`).join('; ')}
                                        {' '}— separate the lanes or their altitudes.
                                    </span>
                                </div>
                                <button
                                    onClick={autoStaggerAlt}
                                    className="flex items-center justify-center gap-1 rounded py-1 font-bold"
                                    style={{ background: 'rgba(245,158,11,.2)', border: '1px solid rgba(245,158,11,.4)', color: '#fde68a' }}
                                    title="Offset every drone's lane by +2 m per drone (vertical layering)"
                                >
                                    <Layers size={10} /> AUTO-LAYER ALTITUDES (+2 m / drone)
                                </button>
                            </div>
                        )}

                        {/* Supervisor alert feed — latest 3 */}
                        {alerts.length > 0 && (
                            <div className="flex flex-col gap-1">
                                {alerts.slice(0, 3).map((a, i) => (
                                    <div
                                        key={`${a.at}-${i}`}
                                        className="flex items-center gap-1.5 rounded px-2 py-1 text-[9px]"
                                        style={{
                                            background: ALERT_COLORS[a.severity] + '12',
                                            border: `1px solid ${ALERT_COLORS[a.severity]}33`,
                                            color: ALERT_COLORS[a.severity],
                                        }}
                                    >
                                        <span
                                            className={`w-1.5 h-1.5 rounded-full shrink-0 ${a.severity === 'critical' ? 'animate-pulse' : ''}`}
                                            style={{ background: ALERT_COLORS[a.severity] }}
                                        />
                                        <span className="truncate" title={a.msg}>{a.msg}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Liftoff stagger */}
                        <div className="flex items-center justify-between px-0.5">
                            <span className="text-[9px]" style={{ color: '#9ca3af' }}>Liftoff stagger</span>
                            <div className="flex items-center gap-1">
                                <input
                                    type="number" min={0} max={15} step={1}
                                    value={staggerS}
                                    onChange={e => {
                                        const v = Number(e.target.value)
                                        if (!isNaN(v)) setStaggerS(Math.min(15, Math.max(0, v)))
                                    }}
                                    className="w-11 text-[10px] font-bold text-right tabular-nums rounded-md px-1.5 py-0.5 outline-none"
                                    style={{
                                        background: 'rgba(255,255,255,.08)',
                                        border: '1px solid rgba(255,255,255,.15)',
                                        color: '#fff',
                                    }}
                                />
                                <span className="text-[8px]" style={{ color: '#9ca3af' }}>s</span>
                            </div>
                        </div>

                        {/* Bulk actions */}
                        <div className="flex gap-1.5">
                            <button
                                onClick={handleUploadAll}
                                disabled={planned.length === 0 || anyUploading}
                                className="flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-[10px] font-bold disabled:opacity-30"
                                style={{
                                    background: 'rgba(59,130,246,.2)',
                                    border: '1.5px solid rgba(59,130,246,.45)',
                                    color: '#93c5fd',
                                }}
                            >
                                {anyUploading ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
                                UPLOAD ALL ({planned.length})
                            </button>
                            <button
                                onClick={handleStartAll}
                                disabled={uploadedIds.length === 0 || anyUploading}
                                className="flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-[10px] font-bold disabled:opacity-30"
                                style={{
                                    background: 'rgba(34,197,94,.2)',
                                    border: '1.5px solid rgba(34,197,94,.45)',
                                    color: '#4ade80',
                                }}
                            >
                                <PlayCircle size={11} />
                                START ALL ({uploadedIds.length})
                            </button>
                        </div>

                        {feedback && (
                            <div className="text-[9px] text-center py-0.5 rounded"
                                style={{ color: '#fcd34d', background: 'rgba(245,158,11,.08)' }}>
                                {feedback}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}
