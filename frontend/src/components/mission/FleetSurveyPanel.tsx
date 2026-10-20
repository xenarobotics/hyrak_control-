'use client'

import { useEffect, useMemo, useState } from 'react'
import { useMissionStore, planKeyForDrone, planSignature, type DronePlan } from '@/store/mission'
import { useSwarmStore } from '@/store/swarm'
import { getSocket } from '@/lib/socket'
import { generateSurveyLines, partitionSurveyLines, serpentine, pathLengthM } from '@/lib/survey'
import type { Waypoint, WaypointType } from '@/types/mission'
import { Users, Upload, PlayCircle, Loader2, Check, AlertTriangle, Eye } from 'lucide-react'
import { BTN_ACCENT, BTN_WARN, FOCUS, INPUT } from './ui'
import { cn } from '@/lib/utils'

let _fsCounter = 0
const fsUid = () => `fswp_${Date.now()}_${++_fsCounter}`

interface Assignment {
  droneId: number
  name: string
  color: string
  waypointCount: number
  distanceM: number
}

type UploadState = 'idle' | 'uploading' | 'ok' | 'fail'

// Shown inside the Survey planner when swarm mode is active. Splits the drawn
// survey area's scan lines into contiguous strips - one per connected drone,
// balanced by line length - banks each strip as that drone's mission plan,
// then bulk-uploads and group-starts the fleet.
export default function FleetSurveyPanel() {
  const surveyPolygon = useMissionStore(s => s.surveyPolygon)
  const surveyConfig  = useMissionStore(s => s.surveyConfig)
  const assignFleetPlans = useMissionStore(s => s.assignFleetPlans)

  const swarmEnabled  = useSwarmStore(s => s.enabled)
  const drones        = useSwarmStore(s => s.drones)
  const activeDroneId = useSwarmStore(s => s.activeDroneId)
  const setActiveDrone = useSwarmStore(s => s.setActiveDrone)

  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [uploadStates, setUploadStates] = useState<Record<number, UploadState>>({})
  const [startResult, setStartResult] = useState<string | null>(null)
  const [altStagger, setAltStagger] = useState(2)

  const connected = useMemo(
    () => Object.values(drones).filter(d => d.connected).sort((a, b) => a.id - b.id),
    [drones],
  )

  // Upload + group-start feedback
  useEffect(() => {
    const socket = getSocket()
    const onUpload = (data: { drone_id: number; ok: boolean }) => {
      setUploadStates(s =>
        s[data.drone_id] === 'uploading'
          ? { ...s, [data.drone_id]: data.ok ? 'ok' : 'fail' }
          : s,
      )
      // Record the uploaded plan's signature so the mission page's per-drone
      // ARM/START gates see this drone as "mission on board".
      if (data.ok) {
        const st = useMissionStore.getState()
        const key = planKeyForDrone(data.drone_id)
        const plan = key === st.activePlanKey
          ? { waypoints: st.waypoints }
          : st.plans[key]
        if (plan && plan.waypoints.length > 0) {
          st.markPlanUploaded(key, planSignature(plan.waypoints))
        }
      }
    }
    const onGroup = (data: { action: string; ok_count: number; total: number }) => {
      if (data.action === 'arm_and_start_mission') {
        setStartResult(`Mission started on ${data.ok_count}/${data.total} drones`)
        setTimeout(() => setStartResult(null), 6000)
      }
    }
    socket.on('swarm_mission_upload_result', onUpload)
    socket.on('swarm_group_result', onGroup)
    return () => {
      socket.off('swarm_mission_upload_result', onUpload)
      socket.off('swarm_group_result', onGroup)
    }
  }, [])

  if (!swarmEnabled || connected.length < 2) return null

  const canSplit = surveyPolygon.length >= 3

  const handleSplit = () => {
    const lines = generateSurveyLines(surveyPolygon, surveyConfig)
    if (lines.length === 0) return
    const parts = partitionSurveyLines(lines, connected.length)

    const plans: Record<string, DronePlan> = {}
    const next: Assignment[] = []

    parts.forEach((part, k) => {
      const drone = connected[k]
      const path = serpentine(part)
      const wps: Waypoint[] = path.map(p => ({
        id: fsUid(),
        lat: p.lat,
        lng: p.lng,
        // Optional vertical separation so transit legs to/from the strips
        // never share an altitude with a neighbour.
        altitude: surveyConfig.altitude + k * altStagger,
        speed: surveyConfig.speed,
        holdTime: 0,
        type: 'waypoint' as WaypointType,
        yaw: null,
        turnRadius: surveyConfig.turnRadius,
      }))
      plans[planKeyForDrone(drone.id)] = { waypoints: wps, rtlPosition: null }
      next.push({
        droneId: drone.id,
        name: drone.name,
        color: drone.color,
        waypointCount: wps.length,
        distanceM: pathLengthM(path),
      })
    })

    assignFleetPlans(plans)
    setAssignments(next)
    setUploadStates({})
    // Preview the first strip on the map
    if (next.length > 0) setActiveDrone(next[0].droneId)
  }

  const handleUploadAll = () => {
    const plans = useMissionStore.getState().plans
    const states: Record<number, UploadState> = {}
    for (const a of assignments) {
      const plan = plans[planKeyForDrone(a.droneId)]
      if (!plan || plan.waypoints.length === 0) continue
      states[a.droneId] = 'uploading'
      getSocket().emit('swarm_upload_mission', {
        drone_id: a.droneId,
        terrain_follow: false,
        waypoints: plan.waypoints,
      })
    }
    setUploadStates(states)
  }

  const handleStartAll = () => {
    getSocket().emit('swarm_group_action', {
      drone_ids: assignments.map(a => a.droneId),
      action: 'arm_and_start_mission',
    })
    setStartResult('Starting fleet mission…')
  }

  const allUploaded =
    assignments.length > 0 &&
    assignments.every(a => uploadStates[a.droneId] === 'ok')
  const anyUploading = Object.values(uploadStates).some(s => s === 'uploading')

  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] p-3 mt-1 border border-app-border bg-app-surface-2">
      <div className="flex items-center gap-2">
        <span className="w-7 h-7 rounded-[6px] bg-app-accent-soft text-app-accent flex items-center justify-center">
          <Users size={14} />
        </span>
        <span className="text-[14px] font-bold text-app-text">Fleet survey</span>
        <span className="ml-auto inline-flex items-center h-6 px-2 rounded-full text-xs font-bold tabular-nums bg-app-surface text-app-text border border-app-border">
          {connected.length} drones
        </span>
      </div>

      {/* Altitude stagger */}
      <label className="flex items-center justify-between gap-2" title="Each drone flies this much higher than the one before">
        <span className="text-[13px] font-semibold text-app-text">Height step per drone</span>
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={0}
            max={10}
            step={1}
            value={altStagger}
            onChange={e => {
              const v = Number(e.target.value)
              if (!isNaN(v)) setAltStagger(Math.min(10, Math.max(0, v)))
            }}
            className={cn(INPUT, 'w-14 text-right font-bold')}
          />
          <span className="text-xs text-app-text-muted">m</span>
        </div>
      </label>

      {/* Split button */}
      <button
        onClick={handleSplit}
        disabled={!canSplit}
        title={canSplit ? 'Give each drone its own strip of the area' : 'Draw an area first (3+ points)'}
        className={BTN_ACCENT}
      >
        <Users size={13} />
        {assignments.length > 0 ? 'Re-split area' : `Split across ${connected.length} drones`}
      </button>

      {/* Assignment list */}
      {assignments.length > 0 && (
        <div className="flex flex-col gap-1">
          {assignments.map(a => {
            const st = uploadStates[a.droneId] ?? 'idle'
            const isActive = a.droneId === activeDroneId
            return (
              <button
                key={a.droneId}
                onClick={() => setActiveDrone(a.droneId)}
                aria-pressed={isActive}
                className={cn(
                  'flex items-center gap-2 rounded-[6px] px-2 min-h-8 text-left border transition-colors duration-[120ms]',
                  isActive ? 'bg-app-accent-soft border-app-accent/50' : 'bg-app-surface border-app-border hover:border-app-border-strong',
                  FOCUS,
                )}
                title="Preview this drone's strip on the map"
              >
                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: a.color }} />
                <span className="flex-1 text-[13px] font-bold truncate text-app-text">
                  {a.name}
                </span>
                <span className="text-xs tabular-nums text-app-text-muted">
                  {a.waypointCount} wp · {(a.distanceM / 1000).toFixed(2)} km
                </span>
                {st === 'uploading' && <Loader2 size={13} className="animate-spin text-app-warn" aria-label="Uploading" />}
                {st === 'ok' && <Check size={13} className="text-app-ok" aria-label="Uploaded" />}
                {st === 'fail' && <AlertTriangle size={13} className="text-app-danger" aria-label="Upload failed" />}
                {isActive && st === 'idle' && <Eye size={13} className="text-app-accent" aria-label="Previewing" />}
              </button>
            )
          })}
        </div>
      )}

      {/* Upload / start */}
      {assignments.length > 0 && (
        <div className="flex gap-2">
          <button
            onClick={handleUploadAll}
            disabled={anyUploading}
            title={anyUploading ? 'Uploading now' : 'Send each drone its strip'}
            className={cn(BTN_ACCENT, 'flex-1')}
          >
            {anyUploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            Upload all
          </button>
          <button
            onClick={handleStartAll}
            disabled={!allUploaded}
            title={allUploaded ? 'Arm and start every drone' : 'Upload to every drone first'}
            className={cn(BTN_WARN, 'flex-1')}
          >
            <PlayCircle size={13} />
            Start all
          </button>
        </div>
      )}

      {startResult && (
        <span className="text-[13px] font-semibold text-app-ok" role="status">
          {startResult}
        </span>
      )}
    </div>
  )
}
