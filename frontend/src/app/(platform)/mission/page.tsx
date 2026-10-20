'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useMissionStore, planKeyForDrone, planSignature } from '@/store/mission'
import { expandWaypointsWithTurnRadius, type UploadWp } from '@/lib/uploadPath'
import FleetMissionPanel from '@/components/mission/FleetMissionPanel'
import { useDroneStore } from '@/store/drone'
import { useSwarmStore } from '@/store/swarm'
import { useDrone } from '@/hooks/useDrone'
import { MAP_LAYERS, MAV_FRAME_GLOBAL_RELATIVE_ALT, MAV_FRAME_GLOBAL_TERRAIN_ALT } from '@/types/mission'
import type { MapLayer, Waypoint } from '@/types/mission'
import WaypointPanel from '@/components/mission/WaypointPanel'
import { AvoidancePanel } from '@/components/avoidance/AvoidancePanel'
import { ShieldCheck } from 'lucide-react'
import WaypointEditor from '@/components/mission/WaypointEditor'
import SurveyPlanner from '@/components/mission/SurveyPlanner'
import MissionLibrary, { type LoadedPlan } from '@/components/mission/MissionLibrary'
import AltitudeProfile from '@/components/mission/AltitudeProfile'
import { AirspaceStrip, PermitRequestDialog, PermitsPanel } from '@/components/mission/Airspace'
import { useAccess, useActiveWorkspace } from '@/hooks/useAccess'
import { fromWire, planningAccess, requestPlanFit, type Permit } from '@/lib/planning'
import { getSocket } from '@/lib/socket'
import { useSessionAttachments } from '@/lib/attachments'
import { waypointActionHazard } from '@/components/attachments/WaypointActions'
import { cn } from '@/lib/utils'
import {
  FOCUS, PANEL, POPOVER, DIALOG, BACKDROP, OVERLAY, TITLE, LABEL, CHIP,
  BTN, BTN_PRIMARY, BTN_ACCENT, BTN_WARN, BTN_WARN_SOLID, BTN_DANGER, INPUT, ovBtn,
} from '@/components/mission/ui'
import {
  Upload, Trash2, FileUp, FileDown,
  Map as MapIcon, Satellite, Mountain, Layers,
  ChevronUp, PanelLeftClose, PanelLeftOpen,
  Route, Clock, ArrowUpDown, Gauge, Box, Square, Waves,
  PlayCircle, PauseCircle, Check, AlertTriangle, Battery, Wind,
  Navigation, Home, Loader2, WifiOff,
  Compass, Crosshair, ChevronDown, FolderOpen, Eye, LineChart,
} from 'lucide-react'

// Leaflet accesses `window` - no SSR
function MapLoading({ label }: { label: string }) {
  return (
    <div className="w-full h-full flex items-center justify-center bg-app-bg">
      <p className="flex items-center gap-2 text-[13px] text-app-text-muted">
        <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden /> {label}
      </p>
    </div>
  )
}

const MissionMap = dynamic(() => import('@/components/mission/MissionMap'), {
  ssr: false,
  loading: () => <MapLoading label="Loading map…" />,
})

const MissionMap3D = dynamic(() => import('@/components/mission/MissionMap3D'), {
  ssr: false,
  loading: () => <MapLoading label="Loading 3D map…" />,
})

// ── Map layer icons ─────────────────────────────────────────────────────────

const LAYER_ICONS: Record<MapLayer, React.ReactNode> = {
  nav:       <Navigation size={14} aria-hidden />,
  street:    <MapIcon size={14} aria-hidden />,
  satellite: <Satellite size={14} aria-hidden />,
  terrain:   <Mountain size={14} aria-hidden />,
  hybrid:    <Layers size={14} aria-hidden />,
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

// ── Page ────────────────────────────────────────────────────────────────────

/** One QGroundControl .plan SimpleItem, as far as the importer reads it. */
interface PlanItem {
  command: number
  /** [hold, accept radius, pass radius, yaw, lat, lng, alt] */
  params: (number | null)[]
}

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

  // ── Whose plans, and what this account may do with them ───────────────
  // (docs/ACCESS_MODEL.md 8d). A customer's live session belongs to one
  // workspace; staff sessions land on HYRAK. Viewers get read-only plans.
  const { isCustomer } = useAccess()
  const { workspace: activeWorkspace } = useActiveWorkspace()
  const liveSession  = useDroneStore(s => s.session)
  const planWorkspaceId = liveSession?.workspace_id ?? (isCustomer ? activeWorkspace?.id ?? null : null)
  const { canPlan, canFly } = planningAccess(activeWorkspace, isCustomer ? liveSession?.perms ?? null : null)
  const readOnly = !canPlan
  const boundDrone = liveSession?.drone ?? null
  const [loadedPlan, setLoadedPlan] = useState<LoadedPlan | null>(null)
  const [showLibrary, setShowLibrary] = useState(false)
  const [showPermitList, setShowPermitList] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  // The permit request dialog: open with the refusal that prompted it (if
  // any) and the exact waypoints it is for.
  const [permitAsk, setPermitAsk] = useState<{ reason: string | null; path: UploadWp[] } | null>(null)
  const [airspaceNonce, setAirspaceNonce] = useState(0)
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
  // "Is the current plan on the drone?" is derived, not stored: the plan's
  // content signature must match the one recorded at its last successful
  // upload. Switching fleet drones swaps the plan AND the signature key, so
  // upload state can never be forgotten (the old ARM-disabled bug) and any
  // edit invalidates it automatically.
  const activePlanKey      = useMissionStore(s => s.activePlanKey)
  const uploadedSignatures = useMissionStore(s => s.uploadedSignatures)
  const markPlanUploaded   = useMissionStore(s => s.markPlanUploaded)
  const missionUploaded =
    waypoints.length > 0 && uploadedSignatures[activePlanKey] === planSignature(waypoints)
  // Which plan an in-flight upload belongs to, so the success event marks the
  // right signature even if the user switches drones while it's uploading.
  const pendingUploadRef = useRef<{ key: string; sig: string } | null>(null)
  const [sitlAddress]  = useState('udp://:14540')

  const [leftOpen, setLeftOpen]     = useState(true)
  // 390px: the plan panel is a bottom sheet, peeking until opened.
  const [sheetOpen, setSheetOpen]   = useState(false)
  const [showLayers, setShowLayers] = useState(false)
  const selectedId = useMissionStore(s => s.selectedId)
  const [isUploading, setIsUploading]           = useState(false)
  const [showStartConfirm, setShowStartConfirm] = useState(false)
  const [uploadError, setUploadError]           = useState<string | null>(null)
  const [rtlLandConfirmVisible, setRtlLandConfirmVisible] = useState(false)
  const [rtlReturning, setRtlReturning]     = useState(false)
  // Fleet RTL progress: how many of the returning drones are at their homes
  const [fleetRtlArrived, setFleetRtlArrived] = useState<{ n: number; total: number } | null>(null)
  const [showSettings, setShowSettings]     = useState(false)
  const [showCamDropdown, setShowCamDropdown] = useState(false)
  const rtlDismissedRef = useRef(false)
  const rtlTargetRef    = useRef<{ lat: number; lng: number } | null>(null)
  // Fleet RTL: ids of the drones sent home - each is tracked against ITS OWN
  // home position for the arrival check, and the land confirmation targets
  // exactly these drones even if the tick boxes change meanwhile.
  const returningIdsRef = useRef<number[]>([])
  // How many are returning, as state - the ref drives the effects, this
  // drives the dialog text (refs are not read during render).
  const [returningCount, setReturningCount] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)

  // Close popovers on outside click
  useEffect(() => {
    if (!showSettings && !showCamDropdown && !showLayers) return
    const close = () => { setShowSettings(false); setShowCamDropdown(false); setShowLayers(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [showSettings, showCamDropdown, showLayers])

  // Holds the exact waypoint list of the last upload attempt so an
  // orange-zone acknowledgment (or a red-zone permit request) can re-send
  // it unchanged.
  const lastUploadRef = useRef<ReturnType<typeof expandWaypointsWithTurnRadius> | null>(null)
  // "Allow attachment actions in this mission": asked only when the plan has
  // an attachment action that can hurt someone; the last upload's answer is
  // re-sent with an orange-zone acknowledgement.
  const { attachments: fittedAttachments } = useSessionAttachments()
  const [allowAttachments, setAllowAttachments] = useState(false)
  const allowAttachRef = useRef<{ allow_attachment_actions?: true }>({})

  // ── Red-zone permits ──────────────────────────────────────────────────
  type MyPermit = {
    id: string; description: string; status: string
    waypoints: UploadWp[]; requested_at: string | null
  }
  const [approvedPermits, setApprovedPermits] = useState<MyPermit[]>([])
  const [showPermits, setShowPermits] = useState(false)
  const [showAvoidPanel, setShowAvoidPanel] = useState(false)
  // Where the 2D map portals its avoidance legend (the left column).
  const [legendHost, setLegendHost] = useState<HTMLDivElement | null>(null)

  // In swarm mode permits belong to the ACTIVE fleet drone - every permit
  // request/list call must name it explicitly.
  const permitScope = useCallback((): { fleet_drone_id?: number } => {
    const { enabled, activeDroneId } = useSwarmStore.getState()
    return enabled && activeDroneId !== null ? { fleet_drone_id: activeDroneId } : {}
  }, [])

  useEffect(() => {
    const socket = getSocket()
    const onPermitResult = (r: { ok: boolean; msg: string }) => {
      setUploadError(r.msg)
      setTimeout(() => setUploadError(null), 7000)
      if (r.ok) socket.emit('list_my_permits', permitScope())
    }
    const onMyPermits = (d: { permits: (MyPermit & { in_window?: boolean })[] }) =>
      setApprovedPermits((d.permits ?? []).filter(p => p.status === 'approved' && p.in_window !== false))
    socket.on('permit_result', onPermitResult)
    socket.on('my_permits', onMyPermits)
    return () => {
      socket.off('permit_result', onPermitResult)
      socket.off('my_permits', onMyPermits)
    }
  }, [permitScope])

  // Refresh permits whenever the drone (re)connects or the active fleet drone
  // changes - identity is resolved shortly after connect, so retry with delay.
  // Cleared on the edge where the link drops, during render.
  const [permitsLinked, setPermitsLinked] = useState(telStatus === 'connected')
  if ((telStatus === 'connected') !== permitsLinked) {
    setPermitsLinked(telStatus === 'connected')
    if (telStatus !== 'connected') setApprovedPermits([])
  }
  // Socket permits are the staff fleet's (swarm mode); a single drone's
  // permits go through REST (PermitsPanel), customers' included.
  useEffect(() => {
    if (telStatus !== 'connected' || !swarmEnabled) return
    getSocket().emit('list_my_permits', permitScope())
    const t = setTimeout(() => getSocket().emit('list_my_permits', permitScope()), 4000)
    return () => clearTimeout(t)
  }, [telStatus, activeDroneId, swarmEnabled, permitScope])

  const loadPermitMission = useCallback((p: MyPermit) => {
    const wps = p.waypoints.map((w, i) => ({
      id: `permit_${p.id.slice(0, 8)}_${i}`,
      lat: w.lat, lng: w.lng,
      altitude: w.altitude ?? 10,
      speed: w.speed ?? 5,
      holdTime: w.hold_time ?? 0,
      type: (w.type ?? 'waypoint') as Waypoint['type'],
      yaw: w.yaw ?? null,
    } as Waypoint))
    importWaypoints(wps)
    setShowPermits(false)
  }, [importWaypoints])

  // Auto-dismiss upload toast after 4s; clear loading state when result arrives
  useEffect(() => {
    if (!missionUploadResult) return
    // The upload result is a one-shot event from the store that drives the zone/permit dialogs
    // and is cleared afterwards; consuming it must happen after commit, not during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    setIsUploading(false)

    // Dialog flows below only belong to uploads THIS page initiated
    // (pendingUploadRef set in handleUpload). Fleet-panel bulk uploads mirror
    // their results here too (for the active drone) but run their own dialogs.
    const pageInitiated = pendingUploadRef.current !== null

    // Red-zone block with a permit path: offer to apply for permission.
    // A single drone asks over REST with a time window (the dialog); the
    // staff fleet keeps its socket request.
    if (missionUploadResult.blocked === 'red' && missionUploadResult.can_request
        && lastUploadRef.current && pageInitiated && !useSwarmStore.getState().enabled) {
      const msg = missionUploadResult.msg
      setMissionUploadResult(null)
      pendingUploadRef.current = null
      if (canPlan) setPermitAsk({ reason: msg, path: lastUploadRef.current })
      else setUploadError(`${msg}. Ask a pilot of this workspace to request a permit.`)
      return
    }
    if (missionUploadResult.blocked === 'red' && missionUploadResult.can_request
        && lastUploadRef.current && pageInitiated) {
      const msg = missionUploadResult.msg
      setMissionUploadResult(null)
      if (window.confirm(`${msg}.\n\nApply for permission to fly this exact mission?`)) {
        const description = window
          .prompt('Describe the purpose of this flight for the reviewing authority:')
          ?.trim()
        if (description) {
          getSocket().emit('request_permit', {
            description,
            waypoints: lastUploadRef.current,
            ...permitScope(),
          })
        }
      }
      return
    }

    // Orange-zone crossing: backend wants explicit pilot confirmation.
    // Re-send on the channel the upload came from (fleet vs primary).
    if (missionUploadResult.needs_ack && pageInitiated) {
      const msg = missionUploadResult.msg
      setMissionUploadResult(null)
      if (lastUploadRef.current &&
          window.confirm(`${msg}.\n\nYou will get warnings while inside it. Upload anyway?`)) {
        setIsUploading(true)
        const { enabled, activeDroneId: fleetId } = useSwarmStore.getState()
        if (enabled && fleetId !== null) {
          getSocket().emit('swarm_upload_mission', {
            drone_id: fleetId,
            terrain_follow: terrainFollow,
            waypoints: lastUploadRef.current,
            ack_orange: true,
            ...allowAttachRef.current,
          })
        } else {
          getSocket().emit('upload_mission', {
            terrain_follow: terrainFollow,
            waypoints: lastUploadRef.current,
            ack_orange: true,
            ...allowAttachRef.current,
          })
        }
      }
      return
    }

    if (missionUploadResult.ok && pendingUploadRef.current) {
      markPlanUploaded(pendingUploadRef.current.key, pendingUploadRef.current.sig)
      pendingUploadRef.current = null
    }
    const t = setTimeout(() => setMissionUploadResult(null),
      missionUploadResult.blocked === 'red' ? 7000 : 4000)
    return () => clearTimeout(t)
  }, [missionUploadResult, setMissionUploadResult, terrainFollow, markPlanUploaded, permitScope, canPlan])

  // wasMission: tracks whether drone has entered MISSION mode this session.
  // Reset when waypoints change so a re-uploaded mission shows "Start" not "Resume".
  const [wasMission, setWasMission] = useState(false)
  const [wasMissionFor, setWasMissionFor] = useState(waypoints)
  if (waypoints !== wasMissionFor) {
    setWasMissionFor(waypoints)
    setWasMission(false)
  }

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

  // Auto-close RTL land popup when the drone(s) disarm or enter LAND
  useEffect(() => {
    if (swarmEnabled && returningIdsRef.current.length > 0) {
      // Fleet RTL: done once every returning drone has disarmed
      const allDown = returningIdsRef.current.every(
        id => !swarmDrones[id]?.telemetry?.flight_mode?.is_armed
      )
      if (allDown) {
        // RTL land confirmation is a state machine stepped by telemetry transitions. Rewriting it as
        // derived state changes a safety flow that has to be re-verified in flight, so it stays an effect.
        // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
        setRtlLandConfirmVisible(false)
        setRtlReturning(false)
        rtlDismissedRef.current = false
        returningIdsRef.current = []
        setReturningCount(0)
      }
      return
    }
    if (flightMode === 'LAND' || !isArmed) {
      setRtlLandConfirmVisible(false)
      rtlDismissedRef.current = false
    }
    if (!isArmed) { setRtlReturning(false); rtlTargetRef.current = null }
  }, [flightMode, isArmed, swarmEnabled, swarmDrones])

  // Show RTL landing popup once the drone arrives within 8 m of the RTL target.
  // Fleet RTL: every returning drone is checked against ITS OWN home position;
  // the popup appears when the whole group has arrived (or already landed).
  useEffect(() => {
    if (!rtlReturning) return
    if (rtlLandConfirmVisible || rtlDismissedRef.current) return
    const dist = (lat1: number, lng1: number, lat2: number, lng2: number) => {
      const R = 6_371_000
      const dLat = (lat2 - lat1) * Math.PI / 180
      const dLng = (lng2 - lng1) * Math.PI / 180
      const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    }
    if (swarmEnabled && returningIdsRef.current.length > 0) {
      const arrived = returningIdsRef.current.filter(id => {
        const t = swarmDrones[id]?.telemetry
        if (!t?.position) return false
        if (!t.flight_mode?.is_in_air && !t.flight_mode?.is_armed) return true
        if (!t.home_lat && !t.home_lng) return false  // home not known yet
        return dist(t.home_lat, t.home_lng, t.position.latitude_deg, t.position.longitude_deg) < 8
      })
      setFleetRtlArrived({ n: arrived.length, total: returningIdsRef.current.length })
      if (arrived.length === returningIdsRef.current.length) setRtlLandConfirmVisible(true)
      return
    }
    if (!rtlTargetRef.current || !telemetry?.position) return
    const d = dist(
      rtlTargetRef.current.lat, rtlTargetRef.current.lng,
      telemetry.position.latitude_deg, telemetry.position.longitude_deg,
    )
    if (d < 8) setRtlLandConfirmVisible(true)
  }, [rtlReturning, telemetry?.position, rtlLandConfirmVisible, swarmEnabled, swarmDrones])

  // Surface failed start/pause/RTL commands instead of failing silently -
  // previously a failed start_mission left the UI looking unchanged, so users
  // had to guess and retry via Pause→Resume to get the mission going.
  useEffect(() => {
    if (!lastActionResult) return
    const FAILURE_MSG: Record<string, string> = {
      start_mission: 'Start failed - drone did not confirm MISSION mode. Try again.',
      arm_and_start_mission: 'Arm & start failed',
      restart_mission: 'Restart failed - drone did not confirm MISSION mode. Try again.',
      arm_and_restart_mission: 'Arm & restart failed',
      pause_mission: 'Pause failed',
      goto_custom_rtl: 'RTL failed - check drone connection',
      rtl_home: 'RTL failed - check drone connection',
    }
    if (!lastActionResult.ok && FAILURE_MSG[lastActionResult.action]) {
      // Consumes the one-shot action result from the store and clears it (a store write, which is
      // not allowed during render).
      // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
      setUploadError(FAILURE_MSG[lastActionResult.action])
    }
    setLastActionResult(null)
  }, [lastActionResult, setLastActionResult])

  // Safety timeout: back-end has 20s upload + 5s RTL set = 25s max
  useEffect(() => {
    if (!isUploading) return
    const t = setTimeout(() => {
      setIsUploading(false)
      setUploadError('Upload timed out - check drone connection and backend logs')
    }, 30000)
    return () => clearTimeout(t)
  }, [isUploading])

  // Battery estimate
  const batteryPct = telemetry?.battery?.remaining_percent ?? null
  const missionStats = stats()
  const estMinutes = missionStats.estimatedTimeS / 60
  const estBatteryDraw = Math.round(estMinutes * 10)
  const batteryWarning = batteryPct !== null && estBatteryDraw > batteryPct * 0.8

  // Mission state from flight mode - more reliable than index alone:
  //   MISSION mode  → drone is actively executing waypoints
  //   index >= 0, wasMission set, not MISSION → actually paused mid-mission
  //   index >= 0 but wasMission false → just uploaded, show "Start" not "Resume"
  //   mission_finished → drone reached the last waypoint; treat as neither
  //   executing nor paused so the status strip clears and the toolbar reverts to "Start"
  const missionCurrentIndex = telemetry?.mission_current_index ?? -1
  const missionFinished     = telemetry?.mission_finished ?? false
  const missionExecuting    = flightMode === 'MISSION' && !missionFinished
  // Latch the moment we see MISSION mode (adjusted during render), and drop
  // the latch once a mission finishes so the next upload+start cycle shows
  // "Start" rather than treating it as a resume.
  if (missionExecuting && !wasMission) setWasMission(true)
  if (missionFinished && wasMission) setWasMission(false)
  const missionPaused       = !missionExecuting && !missionFinished && missionCurrentIndex >= 0 && wasMission && flightMode !== 'UNKNOWN'
  const missionInProgress   = missionExecuting

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
  const toolbarTop = statusBarVisible ? 'top-12' : 'top-3'
  const legendTop  = statusBarVisible ? 'top-[100px]' : 'top-16'
  const toastTop   = statusBarVisible ? 'top-[100px]' : 'top-16'

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
            .filter((it: PlanItem) => [16, 21, 22].includes(it.command))
            .map((it: PlanItem, i: number) => {
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
      fileType: 'Plan', groundStation: 'HYRAK', version: 1,
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
    document.body.appendChild(a)   // Safari ignores a click on a detached anchor
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    // terrainFollow was missing: an export after toggling terrain follow
    // wrote the frame from before the toggle.
  }, [waypoints, terrainFollow])

  // The plan exactly as it would be uploaded (turn radii expanded): what the
  // airspace check and a permit request are about.
  const uploadPath = useMemo(() => expandWaypointsWithTurnRadius(waypoints, autoHeading),
    [waypoints, autoHeading])

  const loadPermitPlan = useCallback((p: Permit) => {
    importWaypoints(fromWire(p.waypoints ?? [], `permit_${p.id.slice(0, 8)}`))
    requestPlanFit()
    setLoadedPlan(null)
    setShowPermitList(false)
  }, [importWaypoints])

  // ── Upload to drone ───────────────────────────────────────────────────
  const planHasHazardActions = useMemo(
    () => waypoints.some(w => w.actions?.some(x => waypointActionHazard(x, fittedAttachments))),
    [waypoints, fittedAttachments])
  const handleUpload = useCallback(() => {
    if (waypoints.length === 0) return
    const { enabled, activeDroneId, drones } = useSwarmStore.getState()
    const uploadWaypoints = expandWaypointsWithTurnRadius(waypoints, autoHeading)
    allowAttachRef.current = planHasHazardActions && allowAttachments ? { allow_attachment_actions: true } : {}

    if (enabled && activeDroneId !== null) {
      const d = drones[activeDroneId]
      if (!d?.connected) {
        setUploadError(`${d?.name ?? 'Fleet drone'} not connected`)
        return
      }
      setIsUploading(true)
      lastUploadRef.current = uploadWaypoints
      pendingUploadRef.current = {
        key: planKeyForDrone(activeDroneId), sig: planSignature(waypoints),
      }
      getSocket().emit('swarm_upload_mission', {
        drone_id: activeDroneId,
        terrain_follow: terrainFollow,
        waypoints: uploadWaypoints,
        ...allowAttachRef.current,
      })
    } else {
      if (telStatus !== 'connected') {
        setUploadError('Drone not connected - connect via Telemetry first')
        return
      }
      setIsUploading(true)
      lastUploadRef.current = uploadWaypoints
      pendingUploadRef.current = {
        key: useMissionStore.getState().activePlanKey, sig: planSignature(waypoints),
      }
      getSocket().emit('upload_mission', {
        terrain_follow: terrainFollow,
        waypoints: uploadWaypoints,
        ...allowAttachRef.current,
      })
    }
  }, [waypoints, telStatus, terrainFollow, autoHeading, planHasHazardActions, allowAttachments])

  // ── Pieces shared by the desktop toolbar and the 390px Layers popover ──
  const viewToggle = (
    <div className="inline-flex items-center gap-0.5" role="group" aria-label="Map view">
      <button onClick={() => { setMapView('2d'); setFollowDrone(false) }}
        aria-pressed={mapView === '2d'} className={ovBtn(mapView === '2d')}>
        <Square size={13} aria-hidden /> 2D
      </button>
      <button onClick={() => setMapView('3d')}
        aria-pressed={mapView === '3d'} className={ovBtn(mapView === '3d')}>
        <Box size={13} aria-hidden /> 3D
      </button>
    </div>
  )
  const layerButtons = (labels: boolean) => (
    <div className={cn('flex gap-0.5', labels ? 'flex-col items-stretch' : 'items-center')} role="group" aria-label="Base map">
      {MAP_LAYERS.map(l => {
        const active = mapLayer === l.key
        return (
          <button
            key={l.key}
            onClick={() => setMapLayer(l.key)}
            aria-pressed={active}
            aria-label={labels ? undefined : l.label}
            className={cn(ovBtn(active), labels ? 'justify-start' : active ? '' : 'w-8 px-0')}
            title={l.label}
          >
            {LAYER_ICONS[l.key]}
            {(labels || active) && <span>{l.label}</span>}
          </button>
        )
      })}
    </div>
  )
  const profileButton = (inMenu: boolean) => (
    <button onClick={() => setShowProfile(v => !v)} title="Altitude profile"
      aria-pressed={showProfile} className={cn(ovBtn(showProfile), inMenu && 'justify-start')}>
      <LineChart size={14} aria-hidden /> Profile
    </button>
  )
  const toolDivider = <span className="w-px h-5 mx-0.5 bg-overlay-border shrink-0" aria-hidden />

  const editing = selectedId !== null
  const startLabel = missionExecuting ? 'Pause' : missionPaused ? 'Resume' : 'Start'
  const uploadBtn = (compact: boolean) => canFly ? (
    <span className={cn('relative inline-flex', !compact && 'flex-1')}
      title={waypoints.length === 0 ? 'Add waypoints first' : isUploading ? 'Upload in progress'
        : missionUploaded ? 'This plan is on the drone' : 'Send this plan to the drone'}>
      <button onClick={handleUpload} disabled={waypoints.length === 0 || isUploading}
        aria-label={waypoints.length === 0 ? 'Upload (Add waypoints first)' : undefined}
        className={cn(BTN_PRIMARY, compact ? 'h-9' : 'w-full h-10 text-[14px]')}>
        {isUploading
          ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden />
          : <Upload size={15} aria-hidden />}
        <span>{isUploading ? 'Uploading…' : 'Upload'}</span>
      </button>
      {missionUploaded && !isUploading && (
        <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-app-ok border-2 border-app-surface"
          title="Uploaded" aria-label="Uploaded" />
      )}
    </span>
  ) : null

  return (
    <div className="relative w-full h-full flex overflow-hidden rounded-[10px] border border-app-border bg-app-surface">

      {/* Hidden file input */}
      <input ref={fileRef} type="file" accept=".plan,.json" className="hidden" onChange={onFileChange} />

      {/* ── Plan panel: docked at the side (desktop), a bottom sheet at 390 ──
          It owns the whole workflow, top to bottom: waypoints, defaults,
          plans, then Upload and Start where the eye finishes. A selected
          waypoint's editor takes the body's place. */}
      <aside aria-label="Mission plan"
        className={cn(
          'z-[2100] flex flex-col min-h-0 bg-app-surface text-app-text',
          'md:relative md:h-full md:w-[320px] md:shrink-0 md:border-r md:border-app-border',
          !leftOpen && 'md:hidden',
          'max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:rounded-t-[14px] max-md:border-t max-md:border-app-border',
          'max-md:shadow-[0_-6px_24px_rgb(10_14_20/0.18)]',
          sheetOpen && 'max-md:h-[78%]',
        )}>
        {/* Sheet handle (390 only) */}
        <button type="button" onClick={() => setSheetOpen(o => !o)} aria-expanded={sheetOpen}
          aria-label={sheetOpen ? 'Collapse the mission plan' : 'Expand the mission plan'}
          className={cn('md:hidden flex items-center justify-center h-5 w-full rounded-t-[14px]', FOCUS)}>
          <span className="w-10 h-1 rounded-full bg-app-border-strong" aria-hidden />
        </button>

        {/* Header */}
        <div className="shrink-0 px-4 pt-1 md:pt-4 pb-3 flex flex-col gap-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className={cn(TITLE, 'shrink-0')}>Mission plan</h2>
            <span className={cn(CHIP, !editing && 'md:hidden')} title="Waypoints in this plan" suppressHydrationWarning>
              {waypoints.length}<span className="font-semibold text-app-text-muted max-md:hidden">waypoints</span>
            </span>
            {swarmEnabled && activeDrone && (
              <span className={cn(CHIP, 'min-w-0 max-w-[110px]')} title={`Plan for ${activeDrone.name}`}>
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: activeDrone.connected ? activeDrone.color : 'hsl(var(--app-text-subtle))' }} aria-hidden />
                <span className="truncate">{activeDrone.name}</span>
              </span>
            )}
            <span className="flex-1" />
            {/* 390 peek: the one action, and the expand control */}
            <span className="md:hidden flex items-center gap-1.5">
              {!sheetOpen && uploadBtn(true)}
              <button type="button" onClick={() => setSheetOpen(o => !o)} aria-expanded={sheetOpen}
                aria-label={sheetOpen ? 'Collapse the mission plan' : 'Expand the mission plan'}
                className={cn(BTN, 'w-9 h-9 px-0')}>
                {sheetOpen ? <ChevronDown size={16} aria-hidden /> : <ChevronUp size={16} aria-hidden />}
              </button>
            </span>
          </div>
          {readOnly && (
            <p className="flex items-center gap-1.5 text-[13px] font-semibold text-app-warn" title="Your role can view plans but not change them">
              <Eye size={14} aria-hidden /> View only
            </p>
          )}
          {loadedPlan && (
            <p className="text-[13px] font-semibold text-app-accent truncate" title="Opened from saved missions">
              {loadedPlan.name}
            </p>
          )}
        </div>

        {/* Body */}
        <div className={cn('min-h-0 flex-1 overflow-y-auto border-t border-app-border', !sheetOpen && 'max-md:hidden')}>
          {editing ? (
            <div className="px-3 py-3">
              {/* Viewers inspect a waypoint; every field is disabled. */}
              <fieldset disabled={readOnly} className="min-w-0 border-0 p-0 m-0">
                <WaypointEditor />
              </fieldset>
            </div>
          ) : (
            <div className="flex flex-col">
              {/* 390: the stats live here (the map strip is hidden) */}
              <div className="md:hidden grid grid-cols-3 gap-x-3 gap-y-2 px-4 py-3 border-b border-app-border">
                <Stat icon={<Route size={14} />}       label="Distance"  value={fmtDist(missionStats.totalDistanceM)} />
                <Stat icon={<Clock size={14} />}       label="Est. time" value={fmtTime(missionStats.estimatedTimeS)} />
                <Stat icon={<ArrowUpDown size={14} />} label="Max alt"   value={`${missionStats.maxAltitude} m`} />
                {batteryPct !== null && (
                  <Stat icon={<Battery size={14} />} label="Battery" value={`${batteryPct.toFixed(0)}%`}
                    warn={batteryWarning} warnMsg={`Est. mission uses ~${estBatteryDraw}%`} />
                )}
              </div>

              <div className="px-2.5 py-2">
                <WaypointPanel readOnly={readOnly} />
              </div>

              {/* Plan settings */}
              <section aria-labelledby="mission-settings-h" className="px-4 py-3 border-t border-app-border flex flex-col gap-1">
                <h3 id="mission-settings-h" className={cn(LABEL, 'mb-1')}>Settings</h3>
                {!readOnly && <>
                  <NumberRow label="Altitude" hint="Altitude for new waypoints" icon={<ArrowUpDown size={14} aria-hidden />}
                    value={defaultAlt} min={1} max={120} step={1} unit="m" onChange={setDefaultAlt} />
                  <NumberRow label="Speed" hint="Speed for new waypoints" icon={<Gauge size={14} aria-hidden />}
                    value={defaultSpd} min={0.5} max={15} step={0.5} unit="m/s" onChange={setDefaultSpd} />
                </>}
                <SwitchRow label="Terrain follow" icon={<Waves size={14} aria-hidden />} on={terrainFollow}
                  onChange={() => setTerrainFollow(!terrainFollow)}
                  hint="Terrain follow: keep the same height above the ground along the route" />
                <SwitchRow label="Auto heading" icon={<Compass size={14} aria-hidden />} on={autoHeading}
                  onChange={() => setAutoHeading(!autoHeading)}
                  hint="Auto heading: each waypoint faces the direction of travel when uploaded" />
                <SwitchRow label="Follow on start" icon={<Crosshair size={14} aria-hidden />} on={autoFollowOnMission}
                  onChange={() => setAutoFollowOnMission(!autoFollowOnMission)}
                  hint="Switch to the 3D chase cam when a mission starts" />
              </section>

              {/* Plans: saved, files, survey, clear */}
              <section aria-labelledby="mission-plans-h" className="px-4 py-3 border-t border-app-border flex flex-col gap-2">
                <h3 id="mission-plans-h" className={LABEL}>Plans</h3>
                <div className="flex flex-wrap gap-1.5">
                  <ToolBtn icon={<FolderOpen size={14} />} label="Saved"
                    tip={loadedPlan ? `Saved missions (open: ${loadedPlan.name})` : 'Saved missions'}
                    onClick={() => { setShowPermitList(false); setShowLibrary(v => !v) }} />
                  {!readOnly && <ToolBtn icon={<FileUp size={14} />} label="Import" onClick={handleImport} />}
                  <ToolBtn icon={<FileDown size={14} />} label="Export" onClick={handleExport}
                    disabled={waypoints.length === 0} why="Add waypoints first" />
                </div>
                {/* Approved red-zone mission profiles */}
                {approvedPermits.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <button
                      onClick={() => setShowPermits(v => !v)}
                      aria-expanded={showPermits}
                      className={cn(BTN, 'justify-start')}
                      title="Missions approved for a restricted zone"
                    >
                      <Check size={14} className="text-app-ok" aria-hidden />
                      Permitted missions <span className="tabular-nums text-app-text-muted">{approvedPermits.length}</span>
                      <ChevronDown size={14} className={cn('ml-auto transition-transform duration-[140ms]', showPermits && 'rotate-180')} aria-hidden />
                    </button>
                    {showPermits && (
                      <div className="rounded-[8px] border border-app-border overflow-hidden animate-in fade-in duration-200">
                        {approvedPermits.map(p => (
                          <button
                            key={p.id}
                            onClick={() => loadPermitMission(p)}
                            className={cn('w-full text-left px-3 py-2 border-b border-app-border last:border-b-0 hover:bg-app-surface-2', FOCUS)}
                            title="Load it and fly as approved. Editing it voids the permit."
                          >
                            <div className="text-[14px] font-semibold text-app-text truncate">{p.description}</div>
                            <div className="text-[13px] text-app-text-muted tabular-nums">{p.waypoints.length} waypoints</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {/* Set takeoff at the drone's current position */}
                {!readOnly && isConnected && telemetry?.position && telemetry.position.latitude_deg !== 0 && (
                  <ToolBtn
                    icon={<Navigation size={14} />}
                    label="Takeoff here"
                    tip="Put the takeoff waypoint at the drone's position"
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
                {!readOnly && <SurveyPlanner />}
                {!readOnly && <ToolBtn
                  icon={<Trash2 size={14} />} label="Clear plan" onClick={() => { clearMission(); setLoadedPlan(null) }}
                  disabled={waypoints.length === 0} why="Nothing to clear" tone="danger"
                  tip="Remove every waypoint from this plan"
                />}
              </section>

              {/* Obstacle avoidance (staff) */}
              {!isCustomer && (
                <section className="px-4 py-3 border-t border-app-border flex flex-col gap-2">
                  <button onClick={() => setShowAvoidPanel(v => !v)} aria-expanded={showAvoidPanel}
                    className={cn('flex items-center gap-2 min-h-8 -mx-1 px-1 rounded-[6px] text-left hover:bg-app-surface-2', FOCUS)}
                    title="Obstacle avoidance: detection, steering, response, tuning">
                    <ShieldCheck size={14} className="text-app-text-muted" aria-hidden />
                    <span className="text-[14px] font-semibold text-app-text">Avoidance</span>
                    <ChevronDown size={14} className={cn('ml-auto text-app-text-muted transition-transform duration-[140ms]', showAvoidPanel && 'rotate-180')} aria-hidden />
                  </button>
                  {showAvoidPanel && <div className="animate-in fade-in duration-200"><AvoidancePanel /></div>}
                </section>
              )}
            </div>
          )}
        </div>

        {/* Footer: link state, airspace, then Upload and Start */}
        <div className={cn('shrink-0 border-t border-app-border px-3 pt-3 pb-3 flex flex-col gap-2 bg-app-surface', !sheetOpen && 'max-md:hidden')}>
          {!isConnected && !(swarmEnabled && activeDrone) && (
            <div className="flex items-center gap-2 min-h-9">
              <WifiOff size={15} className="text-app-text-muted shrink-0" aria-hidden />
              <span className="flex-1 text-[13px] text-app-text-muted">No drone connected</span>
              {isCustomer ? (
                // Customers connect their own drone (radio / desktop relay)
                // from the link controls on the Fly / Command view.
                <Link href="/command" className={cn(BTN, 'h-8')} title="Connect a drone on the Command tab">
                  Connect a drone
                </Link>
              ) : (
                <button
                  onClick={() => telStatus !== 'connecting' && connectTelemetry(sitlAddress)}
                  aria-busy={telStatus === 'connecting'}
                  className={cn(BTN, 'h-8', telStatus === 'connecting' && 'cursor-default')}
                  title={telStatus === 'connecting' ? 'Connecting to the simulator' : 'No drone link. Connect the simulator (SITL).'}
                >
                  {telStatus === 'connecting'
                    ? <><Loader2 size={14} className="animate-spin motion-reduce:animate-none text-app-warn" aria-hidden /> Connecting…</>
                    : 'Connect SITL'}
                </button>
              )}
            </div>
          )}
          {!swarmEnabled && (
            <AirspaceStrip workspaceId={planWorkspaceId} droneId={boundDrone?.id ?? null}
              path={uploadPath} canPlan={canPlan} nonce={airspaceNonce}
              onRequest={() => setPermitAsk({ reason: null, path: uploadPath })}
              onShowPermits={() => { setShowLibrary(false); setShowPermitList(v => !v) }} />
          )}
          {canFly && planHasHazardActions && (
            <label
              className="flex items-center gap-2 min-h-9 rounded-[6px] px-2.5 cursor-pointer select-none border border-app-warn/50 bg-app-warn-soft text-app-warn"
              title="This plan has attachment actions that can hurt someone (drop, open, lower, spray). Without this tick they are refused. The other safety checks still apply."
            >
              <input type="checkbox" checked={allowAttachments} onChange={e => setAllowAttachments(e.target.checked)}
                className={cn('h-4 w-4 accent-[var(--app-warn)]', FOCUS)} />
              <span className="text-[13px] font-bold">Allow attachment actions</span>
            </label>
          )}
          {(canFly || missionExecuting) && (
            <div className="flex gap-2">
              {uploadBtn(false)}
              {/* Pause stays for anyone holding the link (a safety action). */}
              <span className="flex-1 inline-flex"
                title={waypoints.length === 0 ? 'Add waypoints first' : !isConnected ? 'Connect a drone first' : startLabel}>
                <button
                  onClick={() => {
                    if (missionExecuting) {
                      sendAction('pause_mission')
                    } else {
                      // Always show dialog - handles arm check, preflight, and resume
                      setShowStartConfirm(true)
                    }
                  }}
                  disabled={waypoints.length === 0 || !isConnected}
                  aria-label={waypoints.length === 0 ? `${startLabel} (Add waypoints first)` : !isConnected ? `${startLabel} (Connect a drone first)` : undefined}
                  className={cn(BTN_WARN, 'w-full h-10 text-[14px]')}
                >
                  {missionExecuting ? <PauseCircle size={15} aria-hidden /> : <PlayCircle size={15} aria-hidden />}
                  <span>{startLabel}</span>
                </button>
              </span>
            </div>
          )}
          {/* RTL - aborts whatever the drone is doing and repositions to the
              RTL point set in the waypoint panel (defaults to takeoff position).
              Fleet mode: every ticked drone flies to ITS OWN home instead - a
              shared point would stack the whole fleet on one spot. */}
          {isConnected && canFly && (
            <ToolBtn
              icon={<Home size={14} />}
              label="Return to launch"
              onClick={() => {
                if (swarmEnabled) {
                  const { selectedIds, drones } = useSwarmStore.getState()
                  const targets = selectedIds.filter(id => drones[id]?.connected)
                  if (targets.length === 0) {
                    setUploadError('Tick drones in the fleet panel first - RTL targets ticked drones')
                    return
                  }
                  returningIdsRef.current = targets
                  setReturningCount(targets.length)
                  sendAction('rtl_home', {})
                  rtlDismissedRef.current = false
                  setFleetRtlArrived({ n: 0, total: targets.length })
                  setRtlReturning(true)
                  return
                }
                const rtl = getRtlWaypoint()
                sendAction('goto_custom_rtl', { lat: rtl.lat, lng: rtl.lng, altitude: rtl.altitude })
                rtlTargetRef.current = { lat: rtl.lat, lng: rtl.lng }
                rtlDismissedRef.current = false
                setRtlReturning(true)
              }}
              tone="warn"
              wide
              tip="Return to launch: fly back to the RTL point now"
            />
          )}
        </div>
      </aside>

      {/* ── Map area ───────────────────────────────────────────────────── */}
      <div className="relative flex-1 min-w-0 h-full">
        {/* Full-bleed map - 2D or 3D */}
        {mapView === '3d' ? <MissionMap3D readOnly={readOnly}
          // The plan panel is docked beside the map, so the controls sit on
          // the map's right edge, centred.
          navStyle={{ right: 12, top: '50%', transform: 'translateY(-50%)' }} />
          : <MissionMap readOnly={readOnly}
          // Detections legend top-right; the avoidance legend joins the
          // left column under the toolbar (no overlap).
          detectionsLegendStyle={{ right: 12, top: statusBarVisible ? 52 : 12 }}
          avoidanceLegendHost={legendHost} />}

        {/* ── Fleet mission console (swarm mode, general missions) ────── */}
        {!isCustomer && <FleetMissionPanel leftOffset="12px" />}

        {/* ── Upload error toast (not connected etc.) ──────────────────── */}
        {uploadError && (
          <div role="alert"
            className={cn(`absolute ${toastTop} left-1/2 -translate-x-1/2 z-[2500] flex items-center gap-2.5 px-4 py-2.5 text-[14px] font-semibold w-max max-w-[calc(100%-32px)]`,
              POPOVER, 'border-app-warn/60 animate-in fade-in slide-in-from-top-2 duration-[240ms]')}>
            <AlertTriangle size={16} className="text-app-warn shrink-0" aria-hidden />
            {uploadError}
          </div>
        )}

        {/* ── Mission upload result toast ─────────────────────────────── */}
        {missionUploadResult && (
          <div role="status"
            className={cn(`absolute ${toastTop} left-1/2 -translate-x-1/2 z-[2500] flex items-center gap-2.5 px-4 py-2.5 text-[14px] font-semibold w-max max-w-[calc(100%-32px)]`,
              POPOVER, missionUploadResult.ok ? 'border-app-ok/60' : 'border-app-danger/60',
              'animate-in fade-in slide-in-from-top-2 duration-[240ms]')}>
            {missionUploadResult.ok
              ? <Check size={16} className="text-app-ok shrink-0" aria-hidden />
              : <AlertTriangle size={16} className="text-app-danger shrink-0" aria-hidden />}
            {missionUploadResult.msg}
            {missionUploadResult.ok && missionUploadResult.terrain_follow && (
              <span className={cn(CHIP, 'text-app-ok bg-app-ok-soft border-app-ok/40')}>Terrain follow on</span>
            )}
          </div>
        )}

        {/* ── Saved missions / permits popovers ───────────────────────── */}
        {(showLibrary || showPermitList) && (
          <div className={`absolute ${toastTop} left-3 z-[2600] max-w-[calc(100%-24px)] animate-in fade-in slide-in-from-top-1 duration-200`}>
            {showLibrary && (
              <MissionLibrary workspaceId={planWorkspaceId} canPlan={canPlan}
                droneId={boundDrone?.id ?? null} loaded={loadedPlan} onLoaded={setLoadedPlan}
                onClose={() => setShowLibrary(false)} />
            )}
            {showPermitList && (
              <PermitsPanel workspaceId={planWorkspaceId} canPlan={canPlan} nonce={airspaceNonce}
                onLoad={loadPermitPlan} onChanged={() => setAirspaceNonce(n => n + 1)}
                onClose={() => setShowPermitList(false)} />
            )}
          </div>
        )}

        {/* ── Mission status strip - top of the map, pushes the toolbar down ── */}
        {missionExecuting && !rtlLandConfirmVisible && (
          <div role="status"
            className={cn(OVERLAY, 'absolute top-0 left-0 right-0 z-[3000] flex items-center gap-3 h-10 px-4 border-x-0 border-t-0 border-b-[color:var(--overlay-ok)]')}>
            <Navigation size={14} className="shrink-0" style={{ color: 'var(--overlay-ok)' }} aria-hidden />
            <span className="text-[13px] font-bold whitespace-nowrap" style={{ color: 'var(--overlay-ok)' }}>Mission running</span>
            <span className="text-[13px] font-semibold tabular-nums whitespace-nowrap">
              WP {missionCurrentIndex + 1} / {waypoints.length}
            </span>
            <div className="flex-1 h-1.5 rounded-full bg-overlay-text/15 overflow-hidden">
              <div className="h-full rounded-full transition-[width] duration-[220ms]" style={{
                background: 'var(--overlay-ok)',
                width: `${waypoints.length > 0 ? ((missionCurrentIndex + 1) / waypoints.length) * 100 : 0}%`,
              }} />
            </div>
            <button
              onClick={() => {
                if (!followDrone) { setMapView('3d'); setFollowDrone(true) }
                else setFollowDrone(false)
              }}
              aria-pressed={followDrone}
              className={cn(followDrone ? BTN_ACCENT : BTN, 'h-7')}
            >
              <Crosshair size={13} aria-hidden /> {followDrone ? 'Following' : 'Follow'}
            </button>
            <button onClick={() => sendAction('pause_mission')} className={cn(BTN_WARN, 'h-7')}>
              <PauseCircle size={13} aria-hidden /> Pause
            </button>
          </div>
        )}

        {missionPaused && !rtlLandConfirmVisible && (
          <div role="status"
            className={cn(OVERLAY, 'absolute top-0 left-0 right-0 z-[3000] flex items-center gap-3 h-10 px-4 border-x-0 border-t-0 border-b-[color:var(--overlay-warn)]')}>
            <PauseCircle size={14} className="shrink-0" style={{ color: 'var(--overlay-warn)' }} aria-hidden />
            <span className="text-[13px] font-bold whitespace-nowrap" style={{ color: 'var(--overlay-warn)' }}>Mission paused</span>
            <span className="text-[13px] font-semibold tabular-nums whitespace-nowrap">
              WP {missionCurrentIndex + 1} / {waypoints.length}
            </span>
            <div className="flex-1 h-1.5 rounded-full bg-overlay-text/15 overflow-hidden">
              <div className="h-full rounded-full" style={{
                background: 'var(--overlay-warn)',
                width: `${waypoints.length > 0 ? ((missionCurrentIndex + 1) / waypoints.length) * 100 : 0}%`,
              }} />
            </div>
            <button onClick={() => setShowStartConfirm(true)} className={cn(BTN_WARN, 'h-7')}>
              <PlayCircle size={13} aria-hidden /> Resume
            </button>
          </div>
        )}

        {/* ── The one map toolbar (overlay surface), top-left ──────────── */}
        <div className={`absolute ${toolbarTop} left-3 right-3 z-[2000] flex items-start pointer-events-none`}>
          <div role="toolbar" aria-label="Map"
            className={cn(OVERLAY, 'pointer-events-auto relative flex items-center gap-0.5 p-1 rounded-[10px] shadow-[var(--app-shadow)] max-w-full')}
            onMouseDown={e => e.stopPropagation()}>
            <button onClick={() => setLeftOpen(o => !o)}
              className={cn(ovBtn(false), 'hidden md:inline-flex w-8 px-0')}
              aria-label={leftOpen ? 'Hide mission plan' : 'Show mission plan'}
              title={leftOpen ? 'Hide mission plan' : 'Show mission plan'}>
              {leftOpen ? <PanelLeftClose size={16} aria-hidden /> : <PanelLeftOpen size={16} aria-hidden />}
            </button>
            <span className="hidden md:inline-flex">{toolDivider}</span>
            {viewToggle}
            <span className="hidden md:inline-flex items-center gap-0.5">
              {toolDivider}
              {layerButtons(false)}
              {toolDivider}
              {profileButton(false)}
            </span>
            {/* 390: base map and profile fold into one Layers button */}
            <span className="md:hidden inline-flex items-center">
              {toolDivider}
              <button onClick={() => setShowLayers(v => !v)} aria-expanded={showLayers}
                className={ovBtn(showLayers)} title="Base map and profile">
                <Layers size={14} aria-hidden /> Layers <ChevronDown size={13} aria-hidden />
              </button>
            </span>
            {showLayers && (
              <div className={cn(OVERLAY, 'md:hidden absolute top-full left-0 mt-1.5 p-1.5 rounded-[10px] shadow-[var(--app-shadow)] flex flex-col gap-1 min-w-[180px] animate-in fade-in slide-in-from-top-1 duration-200')}>
                {layerButtons(true)}
                <span className="h-px bg-overlay-border my-0.5" aria-hidden />
                {profileButton(true)}
              </div>
            )}

            {/* Follow drone - split button: left = toggle, right = camera mode */}
            {isConnected && telemetry?.position && telemetry.position.latitude_deg !== 0 && (
              <span className="relative inline-flex items-center gap-0.5">
                {toolDivider}
                <button
                  onClick={() => {
                    if (!followDrone) { setMapView('3d'); setFollowDrone(true) }
                    else setFollowDrone(false)
                  }}
                  aria-pressed={followDrone}
                  className={ovBtn(followDrone)}
                  title="Chase cam: the 3D view follows the drone. Click the map to let go."
                >
                  <Crosshair size={14} aria-hidden />
                  <span className="max-md:hidden">
                    {followDrone ? (cameraMode === 'perspective' ? 'Perspective' : 'Following') : 'Follow'}
                  </span>
                </button>
                {/* Chevron - always shown so user can pre-select mode before enabling follow */}
                <button
                  onClick={() => setShowCamDropdown(s => !s)}
                  className={cn(ovBtn(false), 'w-7 px-0')}
                  title="Camera mode"
                  aria-label="Camera mode"
                  aria-expanded={showCamDropdown}
                >
                  <ChevronDown size={14} aria-hidden />
                </button>
                {showCamDropdown && (
                  <div className={cn(POPOVER, 'absolute top-full mt-2 right-0 z-[2200] overflow-hidden p-1.5 min-w-[200px] animate-in fade-in slide-in-from-top-1 duration-200')}>
                    <p className={cn(LABEL, 'px-2 pt-1 pb-1.5')}>Camera mode</p>
                    {([
                      { value: 'follow'      as const, label: 'Chase',       desc: 'Follow behind the drone' },
                      { value: 'perspective' as const, label: 'Perspective', desc: 'Keep the current angle' },
                    ]).map(opt => {
                      const on = cameraMode === opt.value
                      return (
                        <button
                          key={opt.value}
                          onClick={() => { setCameraMode(opt.value); setShowCamDropdown(false) }}
                          aria-pressed={on}
                          className={cn('w-full flex items-center gap-2.5 px-2 py-1.5 rounded-[6px] text-left', FOCUS,
                            on ? 'bg-app-accent-soft' : 'hover:bg-app-surface-2')}
                        >
                          <span className={cn('w-2 h-2 rounded-full shrink-0', on ? 'bg-app-accent' : 'bg-app-border-strong')} aria-hidden />
                          <span>
                            <span className={cn('block text-[14px] font-bold', on ? 'text-app-accent' : 'text-app-text')}>{opt.label}</span>
                            <span className="block text-[13px] text-app-text-muted">{opt.desc}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </span>
            )}
          </div>
        </div>

        {/* The 2D map's avoidance legend lands here (portal), under the toolbar. */}
        {mapView === '2d' && (
          <div ref={setLegendHost} className={`absolute ${legendTop} left-3 z-[1000] empty:hidden`} />
        )}

        {/* Fleet RTL progress chip - visible while the group is returning */}
        {rtlReturning && swarmEnabled && fleetRtlArrived && !rtlLandConfirmVisible && (
          <div role="status"
            className={cn('absolute bottom-[68px] left-1/2 -translate-x-1/2 z-[2400] flex items-center gap-2 h-9 px-3 text-[13px] font-bold', PANEL)}>
            <Home size={14} className="text-app-warn" aria-hidden />
            Returning home <span className="tabular-nums">{fleetRtlArrived.n}/{fleetRtlArrived.total}</span> arrived
          </div>
        )}

        {/* ── Altitude profile, above the stats strip ──────────────────── */}
        {showProfile && !(rtlReturning && swarmEnabled) && (
          <div className={cn(PANEL, 'absolute md:bottom-[68px] max-md:top-16 left-1/2 -translate-x-1/2 z-[1100] w-[min(640px,calc(100%-24px))] px-3 py-2 animate-in fade-in duration-200')}>
            <AltitudeProfile waypoints={waypoints} />
          </div>
        )}

        {/* ── Stats strip (bottom of the map; in the plan sheet at 390) ── */}
        <div className={cn(OVERLAY, 'max-md:hidden absolute bottom-3 left-1/2 -translate-x-1/2 z-[1000] flex items-center gap-5 h-12 px-4 rounded-[10px] shadow-[var(--app-shadow)] max-w-[calc(100%-24px)] overflow-x-auto')}>
          <Stat icon={<MapIcon size={14} />}      label="Waypoints" value={String(missionStats.waypointCount)} />
          <Stat icon={<Route size={14} />}        label="Distance"  value={fmtDist(missionStats.totalDistanceM)} />
          <Stat icon={<Clock size={14} />}        label="Est. time" value={fmtTime(missionStats.estimatedTimeS)} />
          <Stat icon={<ArrowUpDown size={14} />}  label="Max alt"   value={`${missionStats.maxAltitude} m`} />
          {/* Battery warning - only shown when drone connected */}
          {batteryPct !== null && (
            <Stat
              icon={<Battery size={14} />}
              label="Battery"
              value={`${batteryPct.toFixed(0)}%`}
              warn={batteryWarning}
              warnMsg={`Est. mission uses ~${estBatteryDraw}%`}
            />
          )}
          {/* Wind - only shown when drone connected and wind > 0.5 m/s */}
          {windSpeed > 0.5 && (
            <Stat
              icon={<Wind size={14} />}
              label="Wind"
              value={`${windSpeed.toFixed(1)} m/s`}
              warn={windSpeed > 8}
              warnMsg="Strong wind - check flight safety"
            />
          )}
        </div>
      </div>

      {permitAsk && (
        <PermitRequestDialog workspaceId={planWorkspaceId} droneId={boundDrone?.id ?? null}
          droneName={boundDrone?.name ?? null} path={permitAsk.path} missionId={loadedPlan?.id ?? null}
          reason={permitAsk.reason}
          onClose={() => setPermitAsk(null)}
          onSent={() => {
            setPermitAsk(null)
            setAirspaceNonce(n => n + 1)
            setShowLibrary(false)
            setShowPermitList(true)
          }} />
      )}

      {/* RTL confirm-land popup - shown when drone arrives at RTL point */}
      {rtlLandConfirmVisible && (
        <div className={cn('absolute inset-0 z-[3500] flex items-center justify-center p-4', BACKDROP)}>
          <div role="dialog" aria-modal="true" aria-labelledby="rtl-land-title" className={cn(DIALOG, 'w-full max-w-[360px] overflow-hidden')}>
            <div className="flex items-center gap-3 px-5 pt-5">
              <span className="w-9 h-9 rounded-[10px] flex items-center justify-center bg-app-warn-soft text-app-warn shrink-0">
                <Home size={18} aria-hidden />
              </span>
              <h2 id="rtl-land-title" className={TITLE}>Confirm landing</h2>
            </div>
            <div className="px-5 py-4 space-y-3">
              <p className="text-[14px] text-app-text">
                {swarmEnabled && returningCount > 1
                  ? `${returningCount} drones are home. Check the ground is clear.`
                  : 'The drone is over the landing spot. Check the ground is clear.'}
              </p>
              <ul className="space-y-1.5">
                {[
                  'No people or obstacles below',
                  'Ground is flat and stable',
                  'Ready to take over by hand',
                ].map((item, i) => (
                  <li key={i} className="flex items-center gap-2 text-[13px] text-app-text-muted">
                    <Check size={14} className="text-app-warn shrink-0" aria-hidden />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex gap-2 px-5 pb-5">
              <button
                onClick={() => {
                  rtlDismissedRef.current = true
                  setRtlLandConfirmVisible(false)
                  setRtlReturning(false)
                }}
                className={cn(BTN, 'flex-1 h-10')}
              >
                Dismiss
              </button>
              <button
                onClick={() => {
                  setRtlLandConfirmVisible(false)
                  setRtlReturning(false)
                  // Land exactly the drones that were sent home - the tick
                  // boxes may have changed since the RTL was issued.
                  if (swarmEnabled && returningIdsRef.current.length > 0) {
                    getSocket().emit('swarm_group_action', {
                      drone_ids: returningIdsRef.current, action: 'land',
                    })
                  } else {
                    sendAction('land')
                  }
                }}
                className={cn(BTN_WARN_SOLID, 'flex-[1.4] h-10')}
              >
                <Home size={15} aria-hidden /> Land now{swarmEnabled && returningCount > 1 ? ` (${returningCount})` : ''}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Start mission confirmation dialog ────────────────────────── */}
      {showStartConfirm && (
        <div className={cn('absolute inset-0 z-[3000] flex items-center justify-center p-4', BACKDROP)}>
          <div role="dialog" aria-modal="true" aria-labelledby="start-confirm-title" className={cn(DIALOG, 'w-full max-w-[360px] overflow-hidden')}>
            {/* Header */}
            <div className="flex items-center gap-3 px-5 pt-5">
              <span className="w-9 h-9 rounded-[10px] flex items-center justify-center bg-app-warn-soft text-app-warn shrink-0">
                <AlertTriangle size={18} aria-hidden />
              </span>
              <h2 id="start-confirm-title" className={TITLE}>
                {missionPaused ? 'Resume mission?' : 'Start mission?'}
              </h2>
            </div>

            {/* Status row */}
            <div className="flex flex-wrap gap-2 px-5 pt-3">
              <span className={cn(CHIP, isArmed ? 'text-app-ok bg-app-ok-soft border-app-ok/40' : 'text-app-danger bg-app-danger-soft border-app-danger/40')}>
                {isArmed ? <Check size={12} aria-hidden /> : <AlertTriangle size={12} aria-hidden />}
                {isArmed ? 'Armed' : 'Disarmed'}
              </span>
              <span className={cn(CHIP, missionUploaded ? 'text-app-ok bg-app-ok-soft border-app-ok/40' : 'text-app-danger bg-app-danger-soft border-app-danger/40')}>
                {missionUploaded ? <Check size={12} aria-hidden /> : <AlertTriangle size={12} aria-hidden />}
                {missionUploaded ? 'Uploaded' : 'Not uploaded'}
              </span>
            </div>

            {/* Body */}
            <div className="px-5 py-4 space-y-3">
              {!missionUploaded && !missionPaused ? (
                <p className="text-[14px] font-semibold text-app-danger">
                  Upload the mission to the drone first.
                </p>
              ) : missionPaused ? (
                <p className="text-[14px] text-app-text">
                  {isArmed
                    ? 'The drone is holding. It resumes from the current waypoint.'
                    : 'The drone arms, then resumes from the current waypoint.'}
                </p>
              ) : !isArmed ? (
                <p className="text-[14px] text-app-text">
                  The drone arms, then starts the mission.
                </p>
              ) : (
                <p className="text-[14px] text-app-text">
                  The drone is armed. The mission starts right away.
                </p>
              )}
              <ul className="space-y-1.5">
                {['Airspace clear of people and obstacles', 'GPS lock confirmed (HDOP < 1.5)', 'Waypoints and altitudes checked', 'Ready to take over by hand'].map((item, i) => (
                  <li key={i} className="flex items-center gap-2 text-[13px] text-app-text-muted">
                    <Check size={14} className="text-app-warn shrink-0" aria-hidden />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Actions */}
            <div className="flex gap-2 px-5 pb-5">
              <button onClick={() => setShowStartConfirm(false)} className={cn(BTN, 'flex-1 h-10')}>
                Cancel
              </button>
              <button
                disabled={!missionUploaded && !missionPaused}
                title={!missionUploaded && !missionPaused ? 'Upload the mission first' : undefined}
                onClick={() => {
                  if (!missionUploaded && !missionPaused) return
                  setShowStartConfirm(false)
                  if (missionPaused) {
                    // Resume from current waypoint - do not reset sequence
                    sendAction(isArmed ? 'start_mission' : 'arm_and_start_mission')
                  } else {
                    // Fresh start - reset to waypoint 0 before starting
                    sendAction(isArmed ? 'restart_mission' : 'arm_and_restart_mission')
                  }
                }}
                className={cn(BTN_WARN_SOLID, 'flex-[1.4] h-10')}
              >
                <PlayCircle size={15} aria-hidden />
                {missionPaused ? (isArmed ? 'Resume' : 'Arm & resume')
                               : (isArmed ? 'Start mission' : 'Arm & start')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Drone mission offer popup (QGC-style) ─────────────────────── */}
      {droneMissionOffer && droneMissionOffer.length > 0 && (
        <div className={cn('absolute inset-0 z-[3000] flex items-center justify-center p-4', BACKDROP)}>
          <div role="dialog" aria-modal="true" aria-labelledby="drone-offer-title" className={cn(DIALOG, 'w-full max-w-[360px] overflow-hidden')}>
            <div className="flex items-center gap-3 px-5 pt-5">
              <span className="w-9 h-9 rounded-[10px] flex items-center justify-center bg-app-accent-soft text-app-accent shrink-0">
                <Navigation size={18} aria-hidden />
              </span>
              <h2 id="drone-offer-title" className={TITLE}>Mission on the drone</h2>
            </div>
            <div className="px-5 py-4 space-y-1.5">
              <p className="text-[14px] text-app-text">
                The drone already has a{' '}
                <span className="font-bold text-app-accent tabular-nums">{droneMissionOffer.length}-waypoint</span>{' '}
                mission. Load it here?
              </p>
              <p className="text-[13px] text-app-text-muted">
                Discard keeps your current plan.
              </p>
            </div>
            <div className="flex gap-2 px-5 pb-5">
              <button onClick={() => setDroneMissionOffer(null)} className={cn(BTN, 'flex-1 h-10')}>
                Discard
              </button>
              <button
                onClick={() => {
                  const wps = droneMissionOffer.map((wp, i) => ({
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
                  // It's already on the drone - record its signature as uploaded
                  const st = useMissionStore.getState()
                  markPlanUploaded(st.activePlanKey, planSignature(st.waypoints))
                  setDroneMissionOffer(null)
                }}
                className={cn(BTN_PRIMARY, 'flex-[1.4] h-10')}
              >
                <FileDown size={15} aria-hidden /> Load mission
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function ToolBtn({ icon, label, onClick, disabled, why, tone, tip, wide }: {
  icon: React.ReactNode; label: string; onClick: () => void
  disabled?: boolean
  /** Full width of its column. */
  wide?: boolean
  /** Tooltip while disabled: why it cannot be used. */
  why?: string
  tone?: 'primary' | 'warn' | 'danger'
  /** Tooltip while enabled (defaults to the label). */
  tip?: string
}) {
  const cls = tone === 'primary' ? BTN_PRIMARY : tone === 'warn' ? BTN_WARN : tone === 'danger' ? BTN_DANGER : BTN
  const title = disabled ? (why ?? label) : (tip ?? label)
  // A disabled button gets no pointer events in some browsers, so the
  // tooltip sits on a wrapper.
  return (
    <span title={title} className={wide ? 'flex' : 'inline-flex'}>
      <button onClick={onClick} disabled={disabled} className={cn(cls, wide && 'w-full')} aria-label={disabled && why ? `${label} (${why})` : undefined}>
        {icon}
        <span>{label}</span>
      </button>
    </span>
  )
}

/** A labelled number with its unit, one row of the plan settings. */
function NumberRow({ label, hint, icon, value, min, max, step, unit, onChange }: {
  label: string; hint: string; icon: React.ReactNode
  value: number; min: number; max: number; step: number; unit: string
  onChange: (v: number) => void
}) {
  return (
    <label className="flex items-center gap-2 min-h-9" title={hint}>
      <span className="text-app-text-muted shrink-0">{icon}</span>
      <span className="flex-1 text-[14px] font-semibold text-app-text">{label}</span>
      <input
        type="number" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className={cn(INPUT, 'w-16 text-right font-bold')}
      />
      <span className="w-8 text-[13px] text-app-text-muted">{unit}</span>
    </label>
  )
}

/** An on/off plan setting. */
function SwitchRow({ label, hint, icon, on, onChange }: {
  label: string; hint: string; icon: React.ReactNode; on: boolean; onChange: () => void
}) {
  return (
    <button
      role="switch" aria-checked={on} onClick={onChange} title={hint}
      className={cn('w-full min-h-9 flex items-center gap-2 rounded-[6px] -mx-1 px-1 text-left hover:bg-app-surface-2', FOCUS)}
    >
      <span className="text-app-text-muted shrink-0">{icon}</span>
      <span className="flex-1 text-[14px] font-semibold text-app-text">{label}</span>
      <span
        className={cn('relative shrink-0 w-9 h-5 rounded-full transition-colors duration-[180ms]',
          on ? 'bg-app-accent' : 'bg-app-border-strong')}
        aria-hidden
      >
        <span
          className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-app-raised shadow-sm transition-transform duration-[180ms] motion-reduce:transition-none"
          style={{ transform: on ? 'translateX(16px)' : 'translateX(0)' }}
        />
      </span>
    </button>
  )
}

function Stat({ icon, label, value, warn, warnMsg }: {
  icon: React.ReactNode; label: string; value: string
  warn?: boolean; warnMsg?: string
}) {
  return (
    <div className="flex items-center gap-2 shrink-0" title={warn && warnMsg ? warnMsg : undefined}>
      <span className={warn ? 'text-app-danger' : 'text-app-text-muted'} aria-hidden>{icon}</span>
      <div className="leading-tight">
        <p className={cn('text-xs font-semibold whitespace-nowrap', warn ? 'text-app-danger' : 'text-app-text-muted')}>
          {label}{warn && <AlertTriangle size={11} className="inline ml-1 -mt-0.5" aria-label="warning" />}
        </p>
        <p className={cn('text-[15px] font-bold tabular-nums whitespace-nowrap', warn ? 'text-app-danger' : 'text-app-text')} suppressHydrationWarning>{value}</p>
      </div>
    </div>
  )
}
