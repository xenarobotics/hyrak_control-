'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { useMissionStore } from '@/store/mission'
import { useDroneStore } from '@/store/drone'
import { useSwarmStore } from '@/store/swarm'
import { useDrone } from '@/hooks/useDrone'
import { MAP_LAYERS, MAV_FRAME_GLOBAL_RELATIVE_ALT, MAV_FRAME_GLOBAL_TERRAIN_ALT } from '@/types/mission'
import type { MapLayer, Waypoint } from '@/types/mission'
import WaypointPanel from '@/components/mission/WaypointPanel'
import WaypointEditor from '@/components/mission/WaypointEditor'
import SurveyPlanner from '@/components/mission/SurveyPlanner'
import { getSocket } from '@/lib/socket'
import { cn } from '@/lib/utils'
import {
  Upload, Trash2, FileUp, FileDown,
  Map as MapIcon, Satellite, Mountain, Layers,
  ChevronLeft, ChevronRight,
  Route, Clock, ArrowUpDown, Gauge, Box, Square, Waves,
  PlayCircle, PauseCircle, Check, AlertTriangle, Battery, Wind,
  Navigation, Home, Loader2, WifiOff,
  Compass, Crosshair, ChevronDown,
} from 'lucide-react'

// Leaflet accesses `window` — no SSR
const MissionMap = dynamic(() => import('@/components/mission/MissionMap'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center"
      style={{ background: '#0a0a0a' }}>
      <p className="text-xs font-mono" style={{ color: '#555' }}>Loading map...</p>
    </div>
  ),
})

const MissionMap3D = dynamic(() => import('@/components/mission/MissionMap3D'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center"
      style={{ background: '#0a0a0a' }}>
      <p className="text-xs font-mono" style={{ color: '#555' }}>Loading 3D map...</p>
    </div>
  ),
})

// ── Solid dark panel — no more pure translucent ─────────────────────────────

function Panel({ children, className, style }: {
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <div
      className={cn('rounded-xl border', className)}
      style={{
        background: 'rgba(17, 19, 24, .94)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderColor: 'rgba(255, 255, 255, .08)',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

// ── Map layer icons ─────────────────────────────────────────────────────────

const LAYER_ICONS: Record<MapLayer, React.ReactNode> = {
  street:    <MapIcon size={12} />,
  satellite: <Satellite size={12} />,
  terrain:   <Mountain size={12} />,
  hybrid:    <Layers size={12} />,
}

// ── Format helpers ──────────────────────────────────────────────────────────

function fmtDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`
}
function fmtTime(s: number): string {
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return mm > 0 ? `${mm}m ${ss}s` : `${ss}s`
}

// ── Bearing (true heading, deg, 0=N clockwise) between two WGS-84 points ────
function computeBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const Δλ = ((lng2 - lng1) * Math.PI) / 180
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

// ── Turn-radius path expansion ───────────────────────────────────────────────
// Converts a waypoint list with turn radii into a dense list of intermediate
// waypoints that trace the Bezier curves shown on the map. Without this the
// drone flies the raw corners; with it the uploaded mission matches the display.
// When autoHeading is true, each point's yaw is set to the bearing toward the
// next point along the actual flight path (including Bezier arc tangents).

type UploadWp = { lat: number; lng: number; altitude: number; speed: number; hold_time: number; type: string; yaw: number | null; turn_radius: number }

function expandWaypointsWithTurnRadius(allWaypoints: import('@/types/mission').Waypoint[], autoHeading = false): UploadWp[] {
  // RTL is a separate, non-mission control now (see rtlPosition in the mission
  // store) — defensively strip any legacy 'rtl'-type entries before building
  // the uploaded mission so they never end up as a mission item.
  const waypoints = allWaypoints.filter(w => w.type !== 'rtl')

  const flat = (wp: import('@/types/mission').Waypoint): UploadWp => ({
    lat: wp.lat, lng: wp.lng, altitude: wp.altitude,
    speed: wp.speed, hold_time: wp.holdTime, type: wp.type, yaw: wp.yaw,
    turn_radius: 0,
  })

  // No expansion needed if < 3 points or no turn radii set
  if (waypoints.length < 3 || !waypoints.some(w => (w.turnRadius ?? 0) > 0)) {
    return waypoints.map(flat)
  }

  const cLat = waypoints.reduce((s, w) => s + w.lat, 0) / waypoints.length
  const cLng = waypoints.reduce((s, w) => s + w.lng, 0) / waypoints.length
  const mPerDegLat = 111_320
  const mPerDegLng = 111_320 * Math.cos((cLat * Math.PI) / 180)

  const pts = waypoints.map(w => ({
    x: (w.lng - cLng) * mPerDegLng,
    y: (w.lat - cLat) * mPerDegLat,
  }))

  const result: UploadWp[] = [flat(waypoints[0])]

  for (let i = 1; i < waypoints.length - 1; i++) {
    const prev = pts[i - 1], curr = pts[i], next = pts[i + 1]
    const r = waypoints[i].turnRadius ?? 0

    if (r <= 0) { result.push(flat(waypoints[i])); continue }

    const toPrev = { x: prev.x - curr.x, y: prev.y - curr.y }
    const toNext = { x: next.x - curr.x, y: next.y - curr.y }
    const lenPrev = Math.sqrt(toPrev.x ** 2 + toPrev.y ** 2)
    const lenNext = Math.sqrt(toNext.x ** 2 + toNext.y ** 2)

    if (lenPrev === 0 || lenNext === 0) { result.push(flat(waypoints[i])); continue }

    const maxR = Math.min(lenPrev * 0.4, lenNext * 0.4, r)
    const uP = { x: toPrev.x / lenPrev, y: toPrev.y / lenPrev }
    const uN = { x: toNext.x / lenNext, y: toNext.y / lenNext }
    const arcS = { x: curr.x + uP.x * maxR, y: curr.y + uP.y * maxR }
    const arcE = { x: curr.x + uN.x * maxR, y: curr.y + uN.y * maxR }

    const a0 = waypoints[i - 1].altitude
    const a1 = waypoints[i].altitude
    const a2 = waypoints[i + 1].altitude
    const altS = a1 + (a0 - a1) * (maxR / lenPrev)
    const altE = a1 + (a2 - a1) * (maxR / lenNext)

    // Each intermediate Bezier point gets an acceptance radius ≈ half the arc
    // step spacing so the drone flows through the arc without stopping at each
    // point. PX4 for multirotors has no built-in turn-radius arc generator —
    // `acceptance_radius_m` only controls when to switch to the next waypoint.
    // With is_fly_through=True + a proper acceptance radius the drone naturally
    // blends through consecutive points and traces the Bezier shape.
    const arcStepAcceptance = Math.max(1.5, maxR * 0.12)

    for (let s = 0; s <= 8; s++) {
      const t = s / 8, it = 1 - t
      const bx = it * it * arcS.x + 2 * it * t * curr.x + t * t * arcE.x
      const by = it * it * arcS.y + 2 * it * t * curr.y + t * t * arcE.y
      result.push({
        lat: Math.round((cLat + by / mPerDegLat) * 1e7) / 1e7,
        lng: Math.round((cLng + bx / mPerDegLng) * 1e7) / 1e7,
        altitude: it * it * altS + 2 * it * t * a1 + t * t * altE,
        speed: waypoints[i].speed,
        hold_time: 0,
        type: 'waypoint',
        yaw: null,
        turn_radius: arcStepAcceptance,
      })
    }
  }

  result.push(flat(waypoints[waypoints.length - 1]))

  // Auto-heading: bearing from each expanded point toward the next, so arc
  // tangents are naturally accounted for by the intermediate Bezier steps.
  if (autoHeading && result.length >= 2) {
    for (let i = 0; i < result.length - 1; i++) {
      result[i].yaw = computeBearing(result[i].lat, result[i].lng, result[i + 1].lat, result[i + 1].lng)
    }
    result[result.length - 1].yaw = result[result.length - 2].yaw!
  }

  return result
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function MissionPage() {
  const waypoints        = useMissionStore(s => s.waypoints)
  const stats            = useMissionStore(s => s.stats)
  const mapLayer         = useMissionStore(s => s.mapLayer)
  const setMapLayer      = useMissionStore(s => s.setMapLayer)
  const mapView          = useMissionStore(s => s.mapView)
  const setMapView       = useMissionStore(s => s.setMapView)
  const terrainFollow    = useMissionStore(s => s.terrainFollow)
  const setTerrainFollow = useMissionStore(s => s.setTerrainFollow)
  const autoHeading      = useMissionStore(s => s.autoHeading)
  const setAutoHeading   = useMissionStore(s => s.setAutoHeading)
  const followDrone            = useMissionStore(s => s.followDrone)
  const setFollowDrone         = useMissionStore(s => s.setFollowDrone)
  const autoFollowOnMission    = useMissionStore(s => s.autoFollowOnMission)
  const setAutoFollowOnMission = useMissionStore(s => s.setAutoFollowOnMission)
  const cameraMode             = useMissionStore(s => s.cameraMode)
  const setCameraMode          = useMissionStore(s => s.setCameraMode)
  const clearMission     = useMissionStore(s => s.clearMission)
  const importWaypoints  = useMissionStore(s => s.importWaypoints)
  const addWaypoint      = useMissionStore(s => s.addWaypoint)
  const updateWaypoint   = useMissionStore(s => s.updateWaypoint)
  const defaultAlt       = useMissionStore(s => s.defaultAltitude)
  const setDefaultAlt    = useMissionStore(s => s.setDefaultAltitude)
  const defaultSpd       = useMissionStore(s => s.defaultSpeed)
  const setDefaultSpd    = useMissionStore(s => s.setDefaultSpeed)
  const getRtlWaypoint   = useMissionStore(s => s.getRtlWaypoint)
  const { connectTelemetry, sendAction } = useDrone()
  const telStatus              = useDroneStore(s => s.telemetryStatus)
  const telemetry              = useDroneStore(s => s.telemetry)
  const swarmEnabled           = useSwarmStore(s => s.enabled)
  const activeDroneId          = useSwarmStore(s => s.activeDroneId)
  const swarmDrones            = useSwarmStore(s => s.drones)
  const activeDrone            = activeDroneId !== null ? swarmDrones[activeDroneId] : null
  // In swarm mode with an active connected fleet drone, treat as 'connected'
  // for all UI gates (the actual telemetryStatus is mirrored in useDrone, but
  // this covers the edge case before the first telemetry event arrives).
  const isConnected = telStatus === 'connected' || (swarmEnabled && !!activeDrone?.connected)
  const missionUploadResult    = useDroneStore(s => s.missionUploadResult)
  const setMissionUploadResult = useDroneStore(s => s.setMissionUploadResult)
  const droneMissionOffer      = useDroneStore(s => s.droneMissionOffer)
  const setDroneMissionOffer   = useDroneStore(s => s.setDroneMissionOffer)
  const lastActionResult       = useDroneStore(s => s.lastActionResult)
  const setLastActionResult    = useDroneStore(s => s.setLastActionResult)

  const isArmed        = telemetry?.flight_mode?.is_armed ?? false
  const flightMode     = telemetry?.flight_mode?.mode ?? 'UNKNOWN'
  const [missionUploaded, setMissionUploaded] = useState(false)
  const [sitlAddress]  = useState('udp://:14540')

  const [leftOpen, setLeftOpen]     = useState(true)
  const [rightOpen, setRightOpen]   = useState(true)
  const [isUploading, setIsUploading]           = useState(false)
  const [showStartConfirm, setShowStartConfirm] = useState(false)
  const [uploadError, setUploadError]           = useState<string | null>(null)
  const [rtlLandConfirmVisible, setRtlLandConfirmVisible] = useState(false)
  const [rtlReturning, setRtlReturning]     = useState(false)
  const [showSettings, setShowSettings]     = useState(false)
  const [showCamDropdown, setShowCamDropdown] = useState(false)
  const rtlDismissedRef = useRef(false)
  const rtlTargetRef    = useRef<{ lat: number; lng: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Close popovers on outside click
  useEffect(() => {
    if (!showSettings && !showCamDropdown) return
    const close = () => { setShowSettings(false); setShowCamDropdown(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [showSettings, showCamDropdown])

  // Holds the exact waypoint list of the last upload attempt so an
  // orange-zone acknowledgment can re-send it unchanged.
  const lastUploadRef = useRef<ReturnType<typeof expandWaypointsWithTurnRadius> | null>(null)

  // Auto-dismiss upload toast after 4s; clear loading state when result arrives
  useEffect(() => {
    if (!missionUploadResult) return
    setIsUploading(false)

    // Orange-zone crossing: backend wants explicit pilot confirmation
    if (missionUploadResult.needs_ack) {
      const msg = missionUploadResult.msg
      setMissionUploadResult(null)
      if (lastUploadRef.current &&
          window.confirm(`${msg}.\n\nYou will get warnings while inside it. Upload anyway?`)) {
        setIsUploading(true)
        getSocket().emit('upload_mission', {
          terrain_follow: terrainFollow,
          waypoints: lastUploadRef.current,
          ack_orange: true,
        })
      }
      return
    }

    if (missionUploadResult.ok) setMissionUploaded(true)
    const t = setTimeout(() => setMissionUploadResult(null),
      missionUploadResult.blocked === 'red' ? 7000 : 4000)
    return () => clearTimeout(t)
  }, [missionUploadResult, setMissionUploadResult, terrainFollow])

  // wasMissionRef: tracks whether drone has entered MISSION mode this session.
  // Reset when waypoints change so a re-uploaded mission shows "Start" not "Resume".
  const wasMissionRef = useRef(false)

  // Reset uploaded state and mission-was-executing flag when waypoints change
  useEffect(() => {
    setMissionUploaded(false)
    wasMissionRef.current = false
  }, [waypoints])

  // One-time migration: older persisted sessions may still have an explicit
  // 'rtl'-type entry in the waypoints array (added by the old "Add RTL"
  // toolbar button). RTL is now tracked separately via rtlPosition, so pull
  // any legacy entry out of the array instead of just filtering it at render time.
  useEffect(() => {
    const state = useMissionStore.getState()
    const legacy = state.waypoints.find(w => w.type === 'rtl')
    if (!legacy) return
    useMissionStore.setState({
      waypoints: state.waypoints.filter(w => w.type !== 'rtl'),
      rtlPosition: state.rtlPosition ?? { lat: legacy.lat, lng: legacy.lng, altitude: legacy.altitude },
    })
  }, [])

  // Auto-dismiss upload error after 4s
  useEffect(() => {
    if (!uploadError) return
    const t = setTimeout(() => setUploadError(null), 4000)
    return () => clearTimeout(t)
  }, [uploadError])

  // Auto-close RTL land popup when drone disarms or enters LAND
  useEffect(() => {
    if (flightMode === 'LAND' || !isArmed) {
      setRtlLandConfirmVisible(false)
      rtlDismissedRef.current = false
    }
    if (!isArmed) { setRtlReturning(false); rtlTargetRef.current = null }
  }, [flightMode, isArmed])

  // Show RTL landing popup once the drone arrives within 15 m of the RTL target
  useEffect(() => {
    if (!rtlReturning || !rtlTargetRef.current || !telemetry?.position) return
    if (rtlLandConfirmVisible || rtlDismissedRef.current) return
    const { latitude_deg: lat2, longitude_deg: lng2 } = telemetry.position
    const { lat: lat1, lng: lng1 } = rtlTargetRef.current
    const R = 6_371_000
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLng = (lng2 - lng1) * Math.PI / 180
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
    const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    if (dist < 8) setRtlLandConfirmVisible(true)
  }, [rtlReturning, telemetry?.position, rtlLandConfirmVisible])

  // Surface failed start/pause/RTL commands instead of failing silently —
  // previously a failed start_mission left the UI looking unchanged, so users
  // had to guess and retry via Pause→Resume to get the mission going.
  useEffect(() => {
    if (!lastActionResult) return
    const FAILURE_MSG: Record<string, string> = {
      start_mission: 'Start failed — drone did not confirm MISSION mode. Try again.',
      arm_and_start_mission: 'Arm & start failed',
      restart_mission: 'Restart failed — drone did not confirm MISSION mode. Try again.',
      arm_and_restart_mission: 'Arm & restart failed',
      pause_mission: 'Pause failed',
      goto_custom_rtl: 'RTL failed — check drone connection',
    }
    if (!lastActionResult.ok && FAILURE_MSG[lastActionResult.action]) {
      setUploadError(FAILURE_MSG[lastActionResult.action])
    }
    setLastActionResult(null)
  }, [lastActionResult, setLastActionResult])

  // Safety timeout: back-end has 20s upload + 5s RTL set = 25s max
  useEffect(() => {
    if (!isUploading) return
    const t = setTimeout(() => {
      setIsUploading(false)
      setUploadError('Upload timed out — check drone connection and backend logs')
    }, 30000)
    return () => clearTimeout(t)
  }, [isUploading])

  // Battery estimate
  const batteryPct = telemetry?.battery?.remaining_percent ?? null
  const missionStats = stats()
  const estMinutes = missionStats.estimatedTimeS / 60
  const estBatteryDraw = Math.round(estMinutes * 10)
  const batteryWarning = batteryPct !== null && estBatteryDraw > batteryPct * 0.8

  // Mission state from flight mode — more reliable than index alone:
  //   MISSION mode  → drone is actively executing waypoints
  //   index >= 0, wasMissionRef set, not MISSION → actually paused mid-mission
  //   index >= 0 but wasMissionRef false → just uploaded, show "Start" not "Resume"
  //   mission_finished → drone reached the last waypoint; treat as neither
  //   executing nor paused so the status strip clears and the toolbar reverts to "Start"
  const missionCurrentIndex = telemetry?.mission_current_index ?? -1
  const missionFinished     = telemetry?.mission_finished ?? false
  const missionExecuting    = flightMode === 'MISSION' && !missionFinished
  // Latch the ref the moment we see MISSION mode (runs synchronously during render)
  if (missionExecuting) wasMissionRef.current = true
  const missionPaused       = !missionExecuting && !missionFinished && missionCurrentIndex >= 0 && wasMissionRef.current && flightMode !== 'UNKNOWN'
  const missionInProgress   = missionExecuting

  // Once a mission finishes, drop the "was executing" latch so the next
  // upload+start cycle shows "Start" rather than treating it as a resume.
  useEffect(() => {
    if (missionFinished) wasMissionRef.current = false
  }, [missionFinished])

  // Reset follow when leaving the mission page entirely (e.g. navigating to settings)
  useEffect(() => () => { setFollowDrone(false) }, [setFollowDrone])

  // Auto-switch to 3D chase cam the moment a mission starts (if setting is on)
  const prevMissionExecuting = useRef(false)
  useEffect(() => {
    if (missionExecuting && !prevMissionExecuting.current && autoFollowOnMission) {
      setMapView('3d')
      setFollowDrone(true)
    }
    prevMissionExecuting.current = missionExecuting
  }, [missionExecuting, autoFollowOnMission, setMapView, setFollowDrone])

  // Status strip layout helpers
  const statusBarVisible = missionExecuting || missionPaused
  const toolbarTop = statusBarVisible ? 'top-6' : 'top-3'
  const panelTop   = statusBarVisible ? 'top-6' : 'top-3'
  const toastTop   = statusBarVisible ? 'top-20' : 'top-16'

  // Wind speed from EKF2
  const windN = telemetry?.wind_north_m_s ?? 0
  const windE = telemetry?.wind_east_m_s ?? 0
  const windSpeed = Math.sqrt(windN * windN + windE * windE)

  // ── File import ───────────────────────────────────────────────────────
  const handleImport = useCallback(() => fileRef.current?.click(), [])
  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string)
        if (data.mission?.items) {
          const wps: Waypoint[] = data.mission.items
            .filter((it: any) => [16, 21, 22].includes(it.command))
            .map((it: any, i: number) => {
              const [hold, , , yaw, lat, lng, alt] = it.params
              return {
                id: `imp_${Date.now()}_${i}`,
                lat, lng,
                altitude: alt ?? 10,
                speed: data.mission.hoverSpeed ?? 5,
                holdTime: hold ?? 0,
                type: it.command === 22 ? 'takeoff' : it.command === 21 ? 'land' : 'waypoint',
                yaw: yaw || null,
              } as Waypoint
            })
          importWaypoints(wps)
        } else if (Array.isArray(data)) {
          importWaypoints(data)
        }
      } catch { alert('Could not parse mission file') }
    }
    reader.readAsText(file)
    e.target.value = ''
  }, [importWaypoints])

  // ── File export ───────────────────────────────────────────────────────
  const handleExport = useCallback(() => {
    if (waypoints.length === 0) return
    // Frame 3  = MAV_FRAME_GLOBAL_RELATIVE_ALT  (altitude relative to home, default)
    // Frame 10 = MAV_FRAME_GLOBAL_TERRAIN_ALT   (altitude AGL above terrain surface)
    // PX4 and ArduPilot both honour frame=10 to trigger terrain following
    const frame = terrainFollow ? MAV_FRAME_GLOBAL_TERRAIN_ALT : MAV_FRAME_GLOBAL_RELATIVE_ALT
    const items = waypoints.map((wp, i) => ({
      autoContinue: true,
      command: wp.type === 'takeoff' ? 22 : wp.type === 'land' ? 21 : wp.type === 'rtl' ? 20 : 16,
      doJumpId: i + 1,
      frame,
      params: [wp.holdTime, 0, 0, wp.yaw ?? 0, wp.lat, wp.lng, wp.altitude],
      type: 'SimpleItem',
      // Terrain follow metadata (informational for QGC)
      ...(terrainFollow ? { terrainAltitude: true } : {}),
    }))
    const plan = {
      fileType: 'Plan', groundStation: 'Verocore', version: 1,
      mission: {
        cruiseSpeed: 15,
        hoverSpeed: waypoints[0]?.speed ?? 5,
        items,
        plannedHomePosition: [waypoints[0]?.lat ?? 0, waypoints[0]?.lng ?? 0, 0],
        vehicleType: 2, firmwareType: 12,
      },
    }
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `mission_${new Date().toISOString().slice(0, 10)}.plan`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [waypoints])

  // ── Upload to drone ───────────────────────────────────────────────────
  const handleUpload = useCallback(() => {
    if (waypoints.length === 0) return
    const { enabled, activeDroneId, drones } = useSwarmStore.getState()
    const uploadWaypoints = expandWaypointsWithTurnRadius(waypoints, autoHeading)

    if (enabled && activeDroneId !== null) {
      const d = drones[activeDroneId]
      if (!d?.connected) {
        setUploadError(`${d?.name ?? 'Fleet drone'} not connected`)
        return
      }
      setIsUploading(true)
      getSocket().emit('swarm_upload_mission', {
        drone_id: activeDroneId,
        terrain_follow: terrainFollow,
        waypoints: uploadWaypoints,
      })
    } else {
      if (telStatus !== 'connected') {
        setUploadError('Drone not connected — connect via Telemetry first')
        return
      }
      setIsUploading(true)
      lastUploadRef.current = uploadWaypoints
      getSocket().emit('upload_mission', {
        terrain_follow: terrainFollow,
        waypoints: uploadWaypoints,
      })
    }
  }, [waypoints, telStatus, terrainFollow, autoHeading])

  return (
    <div className="relative w-full h-full overflow-hidden rounded-xl border"
      style={{ borderColor: 'hsl(var(--app-border))' }}>

      {/* Full-bleed map — 2D or 3D */}
      {mapView === '3d' ? <MissionMap3D /> : <MissionMap />}

      {/* Hidden file input */}
      <input ref={fileRef} type="file" accept=".plan,.json" className="hidden" onChange={onFileChange} />

      {/* ── Upload error toast (not connected etc.) ──────────────────── */}
      {uploadError && (
        <div
          className={`absolute ${toastTop} left-1/2 -translate-x-1/2 z-[2500] flex items-center gap-2.5 px-4 py-2.5 rounded-xl font-mono text-[11px] font-bold shadow-2xl`}
          style={{
            background: 'rgba(120,53,15,.95)',
            border: '1px solid rgba(251,191,36,.4)',
            color: '#fde68a',
            backdropFilter: 'blur(8px)',
          }}
        >
          <WifiOff size={14} />
          {uploadError}
        </div>
      )}

      {/* ── Mission upload result toast ───────────────────────────────── */}
      {missionUploadResult && (
        <div
          className={`absolute ${toastTop} left-1/2 -translate-x-1/2 z-[2500] flex items-center gap-2.5 px-4 py-2.5 rounded-xl font-mono text-[11px] font-bold shadow-2xl`}
          style={{
            background: missionUploadResult.ok ? 'rgba(21,128,61,.95)' : 'rgba(185,28,28,.95)',
            border: `1px solid ${missionUploadResult.ok ? 'rgba(34,197,94,.5)' : 'rgba(248,113,113,.5)'}`,
            color: '#fff',
            backdropFilter: 'blur(8px)',
          }}
        >
          {missionUploadResult.ok
            ? <Check size={14} />
            : <AlertTriangle size={14} />}
          {missionUploadResult.msg}
          {missionUploadResult.ok && missionUploadResult.terrain_follow && (
            <span style={{ color: '#86efac' }}>· Terrain follow ON</span>
          )}
        </div>
      )}

      {/* ── Mission status strip — absolute top of screen, pushes toolbar down ── */}
      {missionExecuting && !rtlLandConfirmVisible && (
        <div
          className="absolute top-0 left-0 right-0 z-[3000] flex items-center gap-3 px-4 py-1"
          style={{ background: 'rgba(21,128,61,.92)', backdropFilter: 'blur(8px)' }}
        >
          <Navigation size={11} color="#4ade80" />
          <span className="text-[10px] font-mono font-bold" style={{ color: '#86efac' }}>MISSION ACTIVE</span>
          <span className="text-[10px] font-mono" style={{ color: '#fff' }}>
            WP {missionCurrentIndex + 1} / {waypoints.length}
          </span>
          <div className="flex-1 h-1 rounded-full" style={{ background: 'rgba(255,255,255,.2)' }}>
            <div className="h-1 rounded-full transition-all" style={{
              width: `${waypoints.length > 0 ? ((missionCurrentIndex + 1) / waypoints.length) * 100 : 0}%`,
              background: '#4ade80',
            }} />
          </div>
          <button
            onClick={() => {
              if (!followDrone) { setMapView('3d'); setFollowDrone(true) }
              else setFollowDrone(false)
            }}
            className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono font-bold"
            style={{
              background: followDrone ? 'rgba(59,130,246,.35)' : 'rgba(255,255,255,.12)',
              color: followDrone ? '#93c5fd' : '#d1d5db',
              border: followDrone ? '1px solid rgba(59,130,246,.5)' : '1px solid transparent',
            }}
          >
            <Crosshair size={11} /> {followDrone ? 'Following' : 'Follow'}
          </button>
          <button
            onClick={() => sendAction('pause_mission')}
            className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono font-bold"
            style={{ background: 'rgba(255,255,255,.15)', color: '#fff' }}
          >
            <PauseCircle size={11} /> Pause
          </button>
        </div>
      )}

      {missionPaused && !rtlLandConfirmVisible && (
        <div
          className="absolute top-0 left-0 right-0 z-[3000] flex items-center gap-3 px-4 py-1"
          style={{ background: 'rgba(120,53,15,.92)', backdropFilter: 'blur(8px)' }}
        >
          <PauseCircle size={11} color="#fbbf24" />
          <span className="text-[10px] font-mono font-bold" style={{ color: '#fde68a' }}>MISSION PAUSED</span>
          <span className="text-[10px] font-mono" style={{ color: '#fcd34d' }}>
            WP {missionCurrentIndex + 1} / {waypoints.length}
          </span>
          <div className="flex-1 h-1 rounded-full" style={{ background: 'rgba(255,255,255,.15)' }}>
            <div className="h-1 rounded-full" style={{
              width: `${waypoints.length > 0 ? ((missionCurrentIndex + 1) / waypoints.length) * 100 : 0}%`,
              background: '#fbbf24',
            }} />
          </div>
          <button
            onClick={() => setShowStartConfirm(true)}
            className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono font-bold"
            style={{ background: 'rgba(255,255,255,.15)', color: '#fde68a' }}
          >
            <PlayCircle size={11} /> Resume
          </button>
        </div>
      )}

      {/* RTL confirm-land popup — shown when drone arrives at RTL point */}
      {rtlLandConfirmVisible && (
        <div
          className="absolute inset-0 z-[3500] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,.65)', backdropFilter: 'blur(4px)' }}
        >
          <div
            className="rounded-2xl border w-80 shadow-2xl overflow-hidden"
            style={{ background: 'rgba(17,19,24,.97)', borderColor: 'rgba(192,132,252,.35)' }}
          >
            {/* Header */}
            <div
              className="flex items-center gap-2.5 px-4 py-3 border-b"
              style={{ borderColor: 'rgba(192,132,252,.2)', background: 'rgba(88,28,135,.4)' }}
            >
              <Home size={16} color="#c084fc" />
              <span className="text-[12px] font-mono font-bold" style={{ color: '#e9d5ff' }}>
                CONFIRM LANDING
              </span>
            </div>
            {/* Body */}
            <div className="px-4 py-4 space-y-3">
              <p className="text-[11px] font-mono" style={{ color: '#d1d5db' }}>
                Drone has reached the landing zone. Confirm the area is clear before allowing it to land.
              </p>
              <ul className="space-y-1.5 pt-1">
                {[
                  'Landing area free of people and obstacles',
                  'Ground is flat and stable',
                  'Ready to take manual override if needed',
                ].map((item, i) => (
                  <li key={i} className="flex items-center gap-2 text-[10px] font-mono" style={{ color: '#9ca3af' }}>
                    <span style={{ color: '#c084fc' }}>▸</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            {/* Actions */}
            <div className="flex gap-2 px-4 pb-4">
              <button
                onClick={() => {
                  rtlDismissedRef.current = true
                  setRtlLandConfirmVisible(false)
                  setRtlReturning(false)
                }}
                className="flex-1 py-2 rounded-lg text-[11px] font-mono font-bold"
                style={{ background: 'rgba(255,255,255,.08)', color: '#9ca3af', border: '1px solid rgba(255,255,255,.1)' }}
              >
                Dismiss
              </button>
              <button
                onClick={() => {
                  setRtlLandConfirmVisible(false)
                  setRtlReturning(false)
                  sendAction('land')
                }}
                className="flex-1 py-2 rounded-lg text-[11px] font-mono font-bold flex items-center justify-center gap-1.5"
                style={{ background: 'rgba(192,132,252,.25)', color: '#e9d5ff', border: '1px solid rgba(192,132,252,.4)' }}
              >
                <Home size={13} /> Ground Clear — Land
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Top centre toolbar — shifts down when mission status strip is visible ── */}
      <div className={`absolute ${toolbarTop} z-[2000] flex items-center gap-2 flex-wrap justify-center transition-all duration-200`}
        style={{ left: leftOpen ? 'calc(224px + 24px)' : '24px', right: rightOpen ? 'calc(224px + 24px)' : '24px' }}>
        {/* Default altitude & speed */}
        <Panel className="flex items-center gap-3 px-3 py-2">
          <label className="flex items-center gap-1.5">
            <ArrowUpDown size={12} color="#9ca3af" />
            <span className="text-[9px] font-mono font-bold text-gray-400">ALT</span>
            <input
              type="number" min={1} max={120} step={1} value={defaultAlt}
              onChange={e => setDefaultAlt(Number(e.target.value))}
              className="w-10 text-[11px] font-mono font-bold text-center outline-none tabular-nums rounded px-1 py-0.5"
              style={{ background: 'rgba(255,255,255,.08)', color: '#fff', border: '1px solid rgba(255,255,255,.12)' }}
            />
            <span className="text-[9px] font-mono text-gray-500">m</span>
          </label>
          <div className="w-px h-4 bg-gray-700" />
          <label className="flex items-center gap-1.5">
            <Gauge size={12} color="#9ca3af" />
            <span className="text-[9px] font-mono font-bold text-gray-400">SPD</span>
            <input
              type="number" min={0.5} max={15} step={0.5} value={defaultSpd}
              onChange={e => setDefaultSpd(Number(e.target.value))}
              className="w-10 text-[11px] font-mono font-bold text-center outline-none tabular-nums rounded px-1 py-0.5"
              style={{ background: 'rgba(255,255,255,.08)', color: '#fff', border: '1px solid rgba(255,255,255,.12)' }}
            />
            <span className="text-[9px] font-mono text-gray-500">m/s</span>
          </label>
        </Panel>

        {/* 2D / 3D toggle */}
        <Panel className="flex items-center rounded-lg overflow-hidden p-0">
          <button
            onClick={() => { setMapView('2d'); setFollowDrone(false) }}
            className="flex items-center gap-1 px-2.5 py-2 transition-colors"
            style={{
              background: mapView === '2d' ? 'rgba(59,130,246,.25)' : 'transparent',
              color: mapView === '2d' ? '#93c5fd' : '#6b7280',
              fontWeight: mapView === '2d' ? 700 : 500,
              borderRight: '1px solid rgba(255,255,255,.06)',
            }}
          >
            <Square size={12} />
            <span className="text-[10px] font-mono font-bold">2D</span>
          </button>
          <button
            onClick={() => setMapView('3d')}
            className="flex items-center gap-1 px-2.5 py-2 transition-colors"
            style={{
              background: mapView === '3d' ? 'rgba(59,130,246,.25)' : 'transparent',
              color: mapView === '3d' ? '#93c5fd' : '#6b7280',
              fontWeight: mapView === '3d' ? 700 : 500,
            }}
          >
            <Box size={12} />
            <span className="text-[10px] font-mono font-bold">3D</span>
          </button>
        </Panel>

        {/* Terrain Follow toggle */}
        <button
          onClick={() => setTerrainFollow(!terrainFollow)}
          className="flex items-center gap-1.5 px-2.5 py-2 rounded-xl transition-colors select-none"
          style={{
            background: terrainFollow ? 'rgba(34,197,94,.12)' : 'rgba(17,19,24,.94)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: terrainFollow ? '1.5px solid rgba(34,197,94,.45)' : '1px solid rgba(255,255,255,.08)',
          }}
        >
          <Waves size={12} color={terrainFollow ? '#4ade80' : '#6b7280'} />
          <span
            className="text-[10px] font-mono font-bold"
            style={{ color: terrainFollow ? '#4ade80' : '#6b7280' }}
          >
            Terrain Follow
          </span>
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: terrainFollow ? '#4ade80' : '#374151' }}
          />
        </button>

        {/* Auto Heading toggle */}
        <button
          onClick={() => setAutoHeading(!autoHeading)}
          className="flex items-center gap-1.5 px-2.5 py-2 rounded-xl transition-colors select-none"
          style={{
            background: autoHeading ? 'rgba(251,191,36,.12)' : 'rgba(17,19,24,.94)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: autoHeading ? '1.5px solid rgba(251,191,36,.45)' : '1px solid rgba(255,255,255,.08)',
          }}
          title="When on, each waypoint's heading is set to face the direction of travel at upload time"
        >
          <Compass size={12} color={autoHeading ? '#fbbf24' : '#6b7280'} />
          <span className="text-[10px] font-mono font-bold" style={{ color: autoHeading ? '#fbbf24' : '#6b7280' }}>
            Auto Heading
          </span>
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: autoHeading ? '#fbbf24' : '#374151' }} />
        </button>

        {/* Follow Drone — split button: left = toggle, right = camera mode dropdown */}
        {isConnected && telemetry?.position && telemetry.position.latitude_deg !== 0 && (
          <div
            className="relative flex items-center rounded-xl select-none"
            style={{
              background: followDrone ? 'rgba(59,130,246,.18)' : 'rgba(17,19,24,.94)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              border: followDrone ? '1.5px solid rgba(59,130,246,.55)' : '1px solid rgba(255,255,255,.08)',
            }}
            onMouseDown={e => e.stopPropagation()}
          >
            {/* Toggle half */}
            <button
              onClick={() => {
                if (!followDrone) { setMapView('3d'); setFollowDrone(true) }
                else setFollowDrone(false)
              }}
              className="flex items-center gap-1.5 px-2.5 py-2 transition-colors"
              title="Chase cam: 3D view tracks behind drone. Click map to release."
            >
              <Crosshair size={12} color={followDrone ? '#93c5fd' : '#6b7280'} />
              <span className="text-[10px] font-mono font-bold" style={{ color: followDrone ? '#93c5fd' : '#6b7280' }}>
                {followDrone
                  ? (cameraMode === 'perspective' ? 'Perspective' : 'Following')
                  : 'Follow'}
              </span>
            </button>
            {/* Separator + chevron — always shown so user can pre-select mode before enabling follow */}
            <div className="w-px h-4" style={{ background: followDrone ? 'rgba(59,130,246,.4)' : 'rgba(255,255,255,.1)' }} />
            <button
              onClick={() => setShowCamDropdown(s => !s)}
              className="px-1.5 py-2 flex items-center"
              title="Camera mode"
              style={{ color: followDrone ? '#93c5fd' : '#6b7280' }}
            >
              <ChevronDown size={11} />
            </button>
            {/* Camera mode dropdown — always accessible */}
            {showCamDropdown && (
              <div
                className="absolute top-full mt-1.5 left-0 rounded-xl border shadow-2xl z-[2200] overflow-hidden"
                style={{ background: 'rgba(17,19,24,.97)', borderColor: 'rgba(59,130,246,.3)', minWidth: 172 }}
              >
                <p className="text-[8px] font-mono tracking-widest px-3 pt-2.5 pb-1" style={{ color: '#4b5563' }}>
                  CAMERA MODE
                </p>
                {([
                  { value: 'follow'      as const, label: 'Chase',       desc: 'Follow behind drone' },
                  { value: 'perspective' as const, label: 'Perspective', desc: 'Lock current view angle' },
                ]).map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => { setCameraMode(opt.value); setShowCamDropdown(false) }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors"
                    style={{
                      background: cameraMode === opt.value ? 'rgba(59,130,246,.18)' : 'transparent',
                    }}
                  >
                    <div style={{
                      width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                      background: cameraMode === opt.value ? '#3b82f6' : '#374151',
                    }} />
                    <div>
                      <p className="text-[10px] font-mono font-bold" style={{ color: cameraMode === opt.value ? '#93c5fd' : '#d1d5db' }}>
                        {opt.label}
                      </p>
                      <p className="text-[9px] font-mono" style={{ color: '#6b7280' }}>{opt.desc}</p>
                    </div>
                  </button>
                ))}
                <div className="h-2" />
              </div>
            )}
          </div>
        )}

        {/* Connection status chip */}
        {swarmEnabled && activeDrone ? (
          // Swarm mode: show which drone is active instead of the connect button
          <div
            className="flex items-center gap-1.5 px-2.5 py-2 rounded-xl text-[10px] font-mono font-bold"
            style={{
              background: 'rgba(34,211,238,.1)',
              border: '1px solid rgba(34,211,238,.35)',
              color: '#67e8f9',
              backdropFilter: 'blur(12px)',
            }}
          >
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: activeDrone.connected ? activeDrone.color : '#71717a' }} />
            {activeDrone.name}
          </div>
        ) : !isConnected ? (
          <button
            onClick={() => telStatus !== 'connecting' && connectTelemetry(sitlAddress)}
            className="flex items-center gap-1.5 px-2.5 py-2 rounded-xl text-[10px] font-mono font-bold"
            style={{
              background: telStatus === 'connecting' ? 'rgba(251,191,36,.12)' : 'rgba(239,68,68,.12)',
              border: `1px solid ${telStatus === 'connecting' ? 'rgba(251,191,36,.35)' : 'rgba(239,68,68,.35)'}`,
              color: telStatus === 'connecting' ? '#fcd34d' : '#f87171',
              backdropFilter: 'blur(12px)',
              cursor: telStatus === 'connecting' ? 'default' : 'pointer',
            }}
          >
            {telStatus === 'connecting'
              ? <><Loader2 size={11} className="animate-spin" /> Connecting…</>
              : <><WifiOff size={11} /> Connect SITL</>}
          </button>
        ) : null}

        {/* Actions */}
        <Panel className="flex items-center gap-1 px-2 py-1.5">
          <ToolBtn icon={<FileUp size={13} />}  label="Import" onClick={handleImport} />
          <ToolBtn icon={<FileDown size={13} />} label="Export" onClick={handleExport} disabled={waypoints.length === 0} />
          <div className="w-px h-5 mx-0.5 bg-gray-700" />
          {/* Set takeoff at drone's current position */}
          {isConnected && telemetry?.position && telemetry.position.latitude_deg !== 0 && (
            <ToolBtn
              icon={<Navigation size={13} />}
              label="Takeoff Here"
              onClick={() => {
                const lat = telemetry!.position!.latitude_deg
                const lng = telemetry!.position!.longitude_deg
                const existing = waypoints[0]
                if (existing?.type === 'takeoff') {
                  updateWaypoint(existing.id, { lat: Math.round(lat * 1e7) / 1e7, lng: Math.round(lng * 1e7) / 1e7 })
                } else {
                  addWaypoint(lat, lng, 'takeoff')
                }
              }}
            />
          )}
          {/* RTL — aborts whatever the drone is doing and repositions to the
              RTL point set in the waypoint panel (defaults to takeoff position) */}
          {isConnected && (
            <ToolBtn
              icon={<Home size={13} />}
              label="RTL"
              onClick={() => {
                const rtl = getRtlWaypoint()
                sendAction('goto_custom_rtl', { lat: rtl.lat, lng: rtl.lng, altitude: rtl.altitude })
                rtlTargetRef.current = { lat: rtl.lat, lng: rtl.lng }
                rtlDismissedRef.current = false
                setRtlReturning(true)
              }}
              danger
            />
          )}
          <div className="w-px h-5 mx-0.5 bg-gray-700" />
          <div className="relative">
            <ToolBtn
              icon={isUploading
                ? <Loader2 size={13} className="animate-spin" />
                : <Upload size={13} />}
              label={isUploading ? 'Uploading…' : 'Upload'}
              onClick={handleUpload}
              disabled={waypoints.length === 0 || isUploading}
              accent
            />
            {missionUploaded && !isUploading && (
              <div
                className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full border"
                style={{ background: '#4ade80', borderColor: '#0a0a0a' }}
              />
            )}
          </div>
          <ToolBtn
            icon={missionExecuting ? <PauseCircle size={13} /> : <PlayCircle size={13} />}
            label={missionExecuting ? 'Pause' : missionPaused ? 'Resume' : 'Start'}
            onClick={() => {
              if (missionExecuting) {
                sendAction('pause_mission')
              } else {
                // Always show dialog — handles arm check, preflight, and resume
                setShowStartConfirm(true)
              }
            }}
            disabled={waypoints.length === 0 || !isConnected}
            accent
          />
          <div className="w-px h-5 mx-0.5 bg-gray-700" />
          <ToolBtn
            icon={<Trash2 size={13} />} label="Clear" onClick={clearMission}
            disabled={waypoints.length === 0} danger
          />
        </Panel>
      </div>

      {/* ── Left panel — waypoint list ────────────────────────────────── */}
      <div className={cn(
        `absolute ${panelTop} bottom-14 left-3 z-[1000] transition-all duration-200`,
        leftOpen ? 'w-56' : 'w-0',
      )}>
        {leftOpen && (
          <Panel className="h-full flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-3 pt-3 pb-2">
              <p className="text-[10px] font-mono tracking-widest font-bold text-gray-400">
                MISSION PLAN
              </p>
              <div className="flex items-center gap-1.5 min-w-0">
                {/* Whose plan is this? Each fleet drone has its own waypoint list */}
                {swarmEnabled && activeDrone && (
                  <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded truncate"
                    style={{ background: activeDrone.color + '25', color: activeDrone.color }}>
                    {activeDrone.name}
                  </span>
                )}
                <span className="text-[10px] font-mono font-bold tabular-nums px-1.5 py-0.5 rounded"
                  style={{ background: 'rgba(255,255,255,.08)', color: '#fff' }} suppressHydrationWarning>
                  {waypoints.length}
                </span>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-1.5 pb-2">
              <WaypointPanel />
            </div>
            {/* Settings section */}
            <div className="px-3 py-2 border-t" style={{ borderColor: 'rgba(255,255,255,.08)' }}>
              <p className="text-[8px] font-mono tracking-widest font-bold mb-2" style={{ color: '#4b5563' }}>
                SETTINGS
              </p>
              {/* Auto-follow on mission start */}
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[9px] font-mono font-bold" style={{ color: '#d1d5db' }}>Auto-follow on start</p>
                  <p className="text-[8px] font-mono" style={{ color: '#6b7280' }}>3D chase cam when mission begins</p>
                </div>
                <button
                  onClick={() => setAutoFollowOnMission(!autoFollowOnMission)}
                  className="relative flex-shrink-0 w-8 h-4 rounded-full transition-colors"
                  style={{ background: autoFollowOnMission ? '#3b82f6' : '#374151' }}
                >
                  <div
                    className="absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform duration-150"
                    style={{ transform: autoFollowOnMission ? 'translateX(16px)' : 'translateX(0)' }}
                  />
                </button>
              </div>
            </div>
            {/* Survey planner at bottom of left panel */}
            <div className="px-2 pb-2 pt-1 border-t" style={{ borderColor: 'rgba(255,255,255,.08)' }}>
              <SurveyPlanner />
            </div>
          </Panel>
        )}
      </div>

      {/* Left collapse toggle */}
      <button
        onClick={() => setLeftOpen(o => !o)}
        className="absolute bottom-16 left-3 z-[1000] rounded-lg p-1.5 transition-colors"
        style={{
          background: 'rgba(17, 19, 24, .92)',
          border: '1px solid rgba(255,255,255,.1)',
          color: '#fff',
        }}
      >
        {leftOpen ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
      </button>

      {/* ── Right panel — waypoint editor ─────────────────────────────── */}
      <div className={cn(
        `absolute ${panelTop} bottom-14 right-3 z-[1000] transition-all duration-200`,
        rightOpen ? 'w-56' : 'w-0',
      )}>
        {rightOpen && (
          <Panel className="h-full flex flex-col overflow-hidden">
            <div className="px-3 pt-3 pb-2">
              <p className="text-[10px] font-mono tracking-widest font-bold text-gray-400">
                WAYPOINT
              </p>
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-3">
              <WaypointEditor />
            </div>
          </Panel>
        )}
      </div>

      {/* Right collapse toggle */}
      <button
        onClick={() => setRightOpen(o => !o)}
        className="absolute bottom-16 right-3 z-[1000] rounded-lg p-1.5 transition-colors"
        style={{
          background: 'rgba(17, 19, 24, .92)',
          border: '1px solid rgba(255,255,255,.1)',
          color: '#fff',
        }}
      >
        {rightOpen ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </button>

      {/* ── Start mission confirmation dialog ────────────────────────── */}
      {showStartConfirm && (
        <div
          className="absolute inset-0 z-[3000] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,.65)', backdropFilter: 'blur(4px)' }}
        >
          <div
            className="rounded-2xl border w-80 shadow-2xl overflow-hidden"
            style={{
              background: 'rgba(17,19,24,.97)',
              borderColor: 'rgba(251,191,36,.35)',
            }}
          >
            {/* Header */}
            <div
              className="flex items-center gap-2.5 px-4 py-3 border-b"
              style={{ borderColor: 'rgba(251,191,36,.2)', background: 'rgba(120,53,15,.4)' }}
            >
              <AlertTriangle size={16} color="#fbbf24" />
              <span className="text-[12px] font-mono font-bold" style={{ color: '#fde68a' }}>
                PRE-FLIGHT CAUTION
              </span>
            </div>

            {/* Status row */}
            <div className="flex gap-2 px-4 pt-3">
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-mono font-bold"
                style={{
                  background: isArmed ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
                  border: `1px solid ${isArmed ? 'rgba(34,197,94,.35)' : 'rgba(239,68,68,.35)'}`,
                  color: isArmed ? '#4ade80' : '#f87171',
                }}>
                <div className="w-1.5 h-1.5 rounded-full" style={{ background: isArmed ? '#4ade80' : '#f87171' }} />
                {isArmed ? 'ARMED' : 'DISARMED'}
              </div>
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-mono font-bold"
                style={{
                  background: missionUploaded ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
                  border: `1px solid ${missionUploaded ? 'rgba(34,197,94,.35)' : 'rgba(239,68,68,.35)'}`,
                  color: missionUploaded ? '#4ade80' : '#f87171',
                }}>
                <div className="w-1.5 h-1.5 rounded-full" style={{ background: missionUploaded ? '#4ade80' : '#f87171' }} />
                {missionUploaded ? 'UPLOADED' : 'NOT UPLOADED'}
              </div>
            </div>

            {/* Body */}
            <div className="px-4 py-3 space-y-2">
              {!missionUploaded && !missionPaused ? (
                <p className="text-[11px] font-mono" style={{ color: '#f87171' }}>
                  Upload the mission to the drone first before starting.
                </p>
              ) : missionPaused ? (
                <p className="text-[11px] font-mono" style={{ color: '#fcd34d' }}>
                  {isArmed
                    ? 'Drone is in HOLD. Mission will resume from current waypoint.'
                    : 'Drone is disarmed. It will be armed, then mission will resume.'}
                </p>
              ) : !isArmed ? (
                <p className="text-[11px] font-mono" style={{ color: '#fcd34d' }}>
                  Drone will be armed automatically, then mission will start.
                </p>
              ) : (
                <p className="text-[11px] font-mono" style={{ color: '#d1d5db' }}>
                  Drone is armed and ready. Mission will start immediately.
                </p>
              )}
              <ul className="space-y-1 pt-1">
                {['Airspace clear of obstacles and people', 'GPS lock confirmed (HDOP &lt; 1.5)', 'All waypoints and altitudes verified', 'Ready to take manual override'].map((item, i) => (
                  <li key={i} className="flex items-center gap-2 text-[10px] font-mono" style={{ color: '#9ca3af' }}>
                    <span style={{ color: '#fbbf24' }}>▸</span>
                    <span dangerouslySetInnerHTML={{ __html: item }} />
                  </li>
                ))}
              </ul>
            </div>

            {/* Actions */}
            <div className="flex gap-2 px-4 pb-4">
              <button
                onClick={() => setShowStartConfirm(false)}
                className="flex-1 py-2 rounded-lg text-[11px] font-mono font-bold"
                style={{ background: 'rgba(255,255,255,.08)', color: '#9ca3af', border: '1px solid rgba(255,255,255,.1)' }}
              >
                Cancel
              </button>
              <button
                disabled={!missionUploaded && !missionPaused}
                onClick={() => {
                  if (!missionUploaded && !missionPaused) return
                  setShowStartConfirm(false)
                  if (missionPaused) {
                    // Resume from current waypoint — do not reset sequence
                    sendAction(isArmed ? 'start_mission' : 'arm_and_start_mission')
                  } else {
                    // Fresh start — reset to waypoint 0 before starting
                    sendAction(isArmed ? 'restart_mission' : 'arm_and_restart_mission')
                  }
                }}
                className="flex-1 py-2 rounded-lg text-[11px] font-mono font-bold flex items-center justify-center gap-1.5"
                style={{
                  background: (missionUploaded || missionPaused) ? 'rgba(59,130,246,.25)' : 'rgba(107,114,128,.12)',
                  color: (missionUploaded || missionPaused) ? '#93c5fd' : '#6b7280',
                  border: `1px solid ${(missionUploaded || missionPaused) ? 'rgba(59,130,246,.4)' : 'rgba(107,114,128,.2)'}`,
                  cursor: (missionUploaded || missionPaused) ? 'pointer' : 'not-allowed',
                }}
              >
                <PlayCircle size={13} />
                {missionPaused ? (isArmed ? 'Resume' : 'Arm & Resume')
                               : (isArmed ? 'Start Mission' : 'Arm & Start')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Drone mission offer popup (QGC-style) ─────────────────────── */}
      {droneMissionOffer && droneMissionOffer.length > 0 && (
        <div className="absolute inset-0 z-[3000] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)' }}>
          <div className="rounded-2xl border w-80 shadow-2xl overflow-hidden"
            style={{ background: 'rgba(17,19,24,.97)', borderColor: 'rgba(59,130,246,.35)' }}>
            <div className="flex items-center gap-2.5 px-4 py-3 border-b"
              style={{ borderColor: 'rgba(59,130,246,.2)', background: 'rgba(30,58,138,.35)' }}>
              <Navigation size={16} color="#93c5fd" />
              <span className="text-[12px] font-mono font-bold" style={{ color: '#93c5fd' }}>
                MISSION ON DRONE
              </span>
            </div>
            <div className="px-4 py-4">
              <p className="text-[11px] font-mono" style={{ color: '#d1d5db' }}>
                The drone has an existing mission with{' '}
                <span style={{ color: '#93c5fd', fontWeight: 700 }}>{droneMissionOffer.length} waypoints</span>.
                Load it into the planner?
              </p>
              <p className="text-[10px] font-mono mt-1.5" style={{ color: '#6b7280' }}>
                Choosing "Discard" keeps your current plan unchanged.
              </p>
            </div>
            <div className="flex gap-2 px-4 pb-4">
              <button
                onClick={() => setDroneMissionOffer(null)}
                className="flex-1 py-2 rounded-lg text-[11px] font-mono font-bold"
                style={{ background: 'rgba(255,255,255,.08)', color: '#9ca3af', border: '1px solid rgba(255,255,255,.1)' }}
              >
                Discard
              </button>
              <button
                onClick={() => {
                  const wps = droneMissionOffer.map((wp: any, i: number) => ({
                    id: `drone_${Date.now()}_${i}`,
                    lat: wp.lat, lng: wp.lng,
                    altitude: wp.altitude ?? 10,
                    speed: wp.speed ?? 5,
                    holdTime: wp.hold_time ?? 0,
                    type: wp.type ?? 'waypoint',
                    yaw: wp.yaw ?? null,
                    turnRadius: 0,
                  }))
                  importWaypoints(wps)
                  setMissionUploaded(true)   // it's already on the drone
                  setDroneMissionOffer(null)
                }}
                className="flex-1 py-2 rounded-lg text-[11px] font-mono font-bold flex items-center justify-center gap-1.5"
                style={{ background: 'rgba(59,130,246,.25)', color: '#93c5fd', border: '1px solid rgba(59,130,246,.4)' }}
              >
                <Upload size={13} /> Load Mission
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Bottom bar — stats + map layer switcher ───────────────────── */}
      <Panel className="absolute bottom-3 left-1/2 -translate-x-1/2 z-[1000] flex items-center gap-3 px-4 py-2">
        {/* Map layer segmented control */}
        <div className="flex items-center rounded-lg overflow-hidden"
          style={{ background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.08)' }}>
          {MAP_LAYERS.map(l => {
            const active = mapLayer === l.key
            return (
              <button
                key={l.key}
                onClick={() => setMapLayer(l.key)}
                className="flex items-center gap-1 px-2.5 py-1.5 transition-colors"
                style={{
                  background: active ? 'rgba(59,130,246,.25)' : 'transparent',
                  color: active ? '#93c5fd' : '#6b7280',
                  fontWeight: active ? 700 : 500,
                  borderRight: '1px solid rgba(255,255,255,.06)',
                }}
                title={l.label}
              >
                {LAYER_ICONS[l.key]}
                <span className="text-[9px] font-mono">{l.label}</span>
              </button>
            )
          })}
        </div>

        <div className="w-px h-6 bg-gray-700" />

        <Stat icon={<MapIcon size={12} />}      label="Waypoints" value={String(missionStats.waypointCount)} />
        <div className="w-px h-6 bg-gray-700" />
        <Stat icon={<Route size={12} />}        label="Distance"  value={fmtDist(missionStats.totalDistanceM)} />
        <div className="w-px h-6 bg-gray-700" />
        <Stat icon={<Clock size={12} />}        label="Est. time" value={fmtTime(missionStats.estimatedTimeS)} />
        <div className="w-px h-6 bg-gray-700" />
        <Stat icon={<ArrowUpDown size={12} />}  label="Max alt"   value={`${missionStats.maxAltitude} m`} />
        {/* Battery warning — only shown when drone connected */}
        {batteryPct !== null && (
          <>
            <div className="w-px h-6 bg-gray-700" />
            <Stat
              icon={<Battery size={12} color={batteryWarning ? '#f87171' : '#9ca3af'} />}
              label="Battery"
              value={`${batteryPct.toFixed(0)}%`}
              warn={batteryWarning}
              warnMsg={`Est. mission uses ~${estBatteryDraw}%`}
            />
          </>
        )}
        {/* Wind — only shown when drone connected and wind > 0.5 m/s */}
        {windSpeed > 0.5 && (
          <>
            <div className="w-px h-6 bg-gray-700" />
            <Stat
              icon={<Wind size={12} color={windSpeed > 8 ? '#f87171' : '#9ca3af'} />}
              label="Wind"
              value={`${windSpeed.toFixed(1)} m/s`}
              warn={windSpeed > 8}
              warnMsg="Strong wind — check flight safety"
            />
          </>
        )}
      </Panel>
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function ToolBtn({ icon, label, onClick, disabled, accent, danger }: {
  icon: React.ReactNode; label: string; onClick: () => void
  disabled?: boolean; accent?: boolean; danger?: boolean
}) {
  let color = '#e5e7eb'  // gray-200 — bright white-ish
  let bg = 'rgba(255,255,255,.06)'
  let hoverBg = 'rgba(255,255,255,.14)'
  if (accent) { color = '#93c5fd'; bg = 'rgba(59,130,246,.15)'; hoverBg = 'rgba(59,130,246,.28)' }
  if (danger) { color = '#fca5a5'; bg = 'rgba(248,113,113,.12)'; hoverBg = 'rgba(248,113,113,.24)' }
  return (
    <button
      onClick={onClick} disabled={disabled} title={label}
      className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors disabled:opacity-30 disabled:pointer-events-none"
      style={{ color, background: bg }}
      onMouseEnter={e => { if (!disabled) (e.currentTarget.style.background = hoverBg) }}
      onMouseLeave={e => { (e.currentTarget.style.background = bg) }}
    >
      {icon}
      <span className="text-[10px] font-mono font-bold">{label}</span>
    </button>
  )
}

function Stat({ icon, label, value, warn, warnMsg }: {
  icon: React.ReactNode; label: string; value: string
  warn?: boolean; warnMsg?: string
}) {
  return (
    <div className="flex items-center gap-1.5" title={warn && warnMsg ? warnMsg : undefined}>
      <span style={{ color: warn ? '#f87171' : '#6b7280' }}>{icon}</span>
      <div>
        <p className="text-[8px] font-mono tracking-wider font-semibold" style={{ color: warn ? '#fca5a5' : '#6b7280' }}>{label}</p>
        <p className="text-[11px] font-mono font-bold tabular-nums" style={{ color: warn ? '#fca5a5' : '#fff' }} suppressHydrationWarning>{value}</p>
      </div>
    </div>
  )
}
