'use client'

import { useEffect, useMemo, useState } from 'react'
import { useMissionStore, planKeyForDrone, type DronePlan } from '@/store/mission'
import { useSwarmStore } from '@/store/swarm'
import { getSocket } from '@/lib/socket'
import { generateSurveyLines, partitionSurveyLines, serpentine, pathLengthM } from '@/lib/survey'
import type { Waypoint, WaypointType } from '@/types/mission'
import { Users, Upload, PlayCircle, Loader2, Check, AlertTriangle, Eye } from 'lucide-react'

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
// survey area's scan lines into contiguous strips — one per connected drone,
// balanced by line length — banks each strip as that drone's mission plan,
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
    <div
      className="flex flex-col gap-2.5 rounded-lg p-3 mt-1"
      style={{
        background: 'rgba(6, 182, 212, .07)',
        border: '1px solid rgba(6, 182, 212, .25)',
      }}
    >
      <div className="flex items-center gap-2">
        <Users size={13} color="#22d3ee" />
        <span className="text-[11px] font-mono font-bold" style={{ color: '#a5f3fc' }}>
          Fleet Survey — {connected.length} drones
        </span>
      </div>

      {/* Altitude stagger */}
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-mono font-semibold" style={{ color: '#67e8f9' }}>
          Alt stagger / drone
        </span>
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
            className="w-12 text-[10px] font-mono font-bold text-right tabular-nums rounded-md px-1.5 py-0.5 outline-none"
            style={{
              background: 'rgba(255,255,255,.08)',
              border: '1px solid rgba(255,255,255,.15)',
              color: '#fff',
            }}
          />
          <span className="text-[8px] font-mono font-semibold" style={{ color: '#9ca3af' }}>m</span>
        </div>
      </div>

      {/* Split button */}
      <button
        onClick={handleSplit}
        disabled={!canSplit}
        className="flex items-center justify-center gap-1.5 rounded-lg py-2 transition-colors disabled:opacity-30 disabled:pointer-events-none"
        style={{
          background: 'rgba(6, 182, 212, .2)',
          border: '1.5px solid rgba(6, 182, 212, .45)',
          color: '#67e8f9',
          fontSize: 10,
          fontWeight: 700,
          fontFamily: 'var(--font-geist-mono)',
        }}
      >
        <Users size={11} />
        {assignments.length > 0 ? 'Re-split area' : `Split across ${connected.length} drones`}
      </button>
      {!canSplit && (
        <span className="text-[9px] font-mono" style={{ color: '#4b5563' }}>
          Draw an area polygon first (3+ points)
        </span>
      )}

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
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-all"
                style={{
                  background: isActive ? a.color + '18' : 'rgba(255,255,255,.03)',
                  border: `1px solid ${isActive ? a.color + '55' : 'rgba(255,255,255,.08)'}`,
                }}
                title="Preview this drone's strip on the map"
              >
                <div className="w-2 h-2 rounded-full shrink-0" style={{ background: a.color }} />
                <span className="flex-1 text-[10px] font-mono font-bold truncate" style={{ color: a.color }}>
                  {a.name}
                </span>
                <span className="text-[9px] font-mono tabular-nums" style={{ color: '#9ca3af' }}>
                  {a.waypointCount} wp · {(a.distanceM / 1000).toFixed(2)} km
                </span>
                {st === 'uploading' && <Loader2 size={10} className="animate-spin" color="#facc15" />}
                {st === 'ok' && <Check size={10} color="#4ade80" />}
                {st === 'fail' && <AlertTriangle size={10} color="#f87171" />}
                {isActive && st === 'idle' && <Eye size={10} color={a.color} />}
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
            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 transition-colors disabled:opacity-40"
            style={{
              background: 'rgba(59, 130, 246, .2)',
              border: '1.5px solid rgba(59, 130, 246, .45)',
              color: '#93c5fd',
              fontSize: 10,
              fontWeight: 700,
              fontFamily: 'var(--font-geist-mono)',
            }}
          >
            {anyUploading ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
            Upload all
          </button>
          <button
            onClick={handleStartAll}
            disabled={!allUploaded}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 transition-colors disabled:opacity-30 disabled:pointer-events-none"
            style={{
              background: 'rgba(34, 197, 94, .2)',
              border: '1.5px solid rgba(34, 197, 94, .5)',
              color: '#86efac',
              fontSize: 10,
              fontWeight: 700,
              fontFamily: 'var(--font-geist-mono)',
            }}
          >
            <PlayCircle size={11} />
            Start fleet mission
          </button>
        </div>
      )}

      {startResult && (
        <span className="text-[9px] font-mono font-semibold" style={{ color: '#86efac' }}>
          {startResult}
        </span>
      )}
    </div>
  )
}
