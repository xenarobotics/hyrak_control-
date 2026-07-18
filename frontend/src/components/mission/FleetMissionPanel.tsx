'use client'

// Fleet mission console for GENERAL waypoint missions (the survey planner has
// its own splitter in FleetSurveyPanel). Shows every connected fleet drone's
// plan + upload + flight state in one strip, bulk-uploads all plans, checks
// lanes against each other for conflicts, and group-starts with an optional
// liftoff stagger. Plan per drone by selecting it (its plan swaps into the
// editor), then run the whole fleet from here.

import { useEffect, useMemo, useState } from 'react'
import { useMissionStore, planKeyForDrone, planSignature, type DronePlan } from '@/store/mission'
import { useSwarmStore } from '@/store/swarm'
import { getSocket } from '@/lib/socket'
import { expandWaypointsWithTurnRadius } from '@/lib/uploadPath'
import { findLaneConflicts, type Lane } from '@/lib/deconflict'
import {
    Users, Upload, PlayCircle, Loader2, Check, AlertTriangle,
    ChevronDown, ChevronUp,
} from 'lucide-react'

type UploadState = 'idle' | 'uploading' | 'ok' | 'fail'

export default function FleetMissionPanel({ leftOffset }: { leftOffset: string }) {
    const swarmEnabled  = useSwarmStore(s => s.enabled)
    const drones        = useSwarmStore(s => s.drones)
    const activeDroneId = useSwarmStore(s => s.activeDroneId)
    const setActiveDrone = useSwarmStore(s => s.setActiveDrone)

    const plans              = useMissionStore(s => s.plans)
    const waypoints          = useMissionStore(s => s.waypoints)
    const activePlanKey      = useMissionStore(s => s.activePlanKey)
    const uploadedSignatures = useMissionStore(s => s.uploadedSignatures)
    const autoHeading        = useMissionStore(s => s.autoHeading)
    const terrainFollow      = useMissionStore(s => s.terrainFollow)

    const [open, setOpen] = useState(true)
    const [uploadStates, setUploadStates] = useState<Record<number, UploadState>>({})
    const [staggerS, setStaggerS] = useState(2)
    const [feedback, setFeedback] = useState<string | null>(null)

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
    // stay open for that drone regardless of selection changes.
    useEffect(() => {
        const socket = getSocket()
        const onUpload = (data: { drone_id: number; ok: boolean; msg?: string }) => {
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
            getSocket().emit('swarm_upload_mission', {
                drone_id: d.id,
                terrain_follow: terrainFollow,
                waypoints: expandWaypointsWithTurnRadius(plan.waypoints, autoHeading),
            })
        }
        setUploadStates(states)
        if (planned.length === 0) setFeedback('No drone has a plan yet — select a drone and add waypoints')
    }

    const handleStartAll = () => {
        if (uploadedIds.length === 0) {
            setFeedback('Upload missions first — no drone has its current plan on board')
            return
        }
        getSocket().emit('swarm_group_action', {
            drone_ids: uploadedIds,
            action: 'arm_and_restart_mission',
            stagger_s: staggerS,
        })
        setFeedback(staggerS > 0
            ? `Starting ${uploadedIds.length} drones, ${staggerS}s apart…`
            : `Starting ${uploadedIds.length} drones…`)
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
                                    </button>
                                )
                            })}
                        </div>

                        {/* Lane conflict advisory */}
                        {conflicts.length > 0 && (
                            <div
                                className="flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[9px]"
                                style={{ background: 'rgba(245,158,11,.1)', border: '1px solid rgba(245,158,11,.3)', color: '#fcd34d' }}
                            >
                                <AlertTriangle size={11} className="shrink-0 mt-px" />
                                <span>
                                    {conflicts.map(c => `${c.a} × ${c.b} come within ${c.distanceM} m at overlapping altitude`).join('; ')}
                                    {' '}— separate the lanes or their altitudes.
                                </span>
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
