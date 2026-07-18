import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { MapLayer, MissionStats, SurveyConfig, SurveyPoint, Waypoint, WaypointType } from '@/types/mission'
import { generateSurveyLines, serpentine } from '@/lib/survey'
import { useSwarmStore } from './swarm'

// ── Helpers ─────────────────────────────────────────────────────────────────

let _idCounter = 0
const uid = () => `wp_${Date.now()}_${++_idCounter}`

/** Haversine distance in metres. */
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ── Store ───────────────────────────────────────────────────────────────────

// Sentinel selectedId for the separate RTL entry — never a real waypoint id,
// so WaypointEditor/WaypointPanel can special-case it without touching `waypoints`.
export const RTL_SENTINEL_ID = '__rtl__'

// Per-drone mission plan. The store keeps ONE working set (waypoints/rtl) that
// every mission component edits; `plans` banks the other drones' plans. Switching
// the active drone saves the working set under the old key and loads the new one.
export interface DronePlan {
  waypoints: Waypoint[]
  rtlPosition: { lat: number; lng: number; altitude: number } | null
}

// Plan key: 'primary' when no fleet drone is selected, 'drone-<id>' otherwise.
export const PRIMARY_PLAN_KEY = 'primary'
export const planKeyForDrone = (id: number) => `drone-${id}`

// Content signature of a plan — ids excluded so an identical re-import still
// matches. uploadedSignatures remembers, per plan key, the signature that was
// last successfully uploaded; "is this plan on the drone?" is then a pure
// comparison, so switching between fleet drones can never forget upload state
// and any edit invalidates it automatically.
export const planSignature = (wps: Waypoint[]) =>
  JSON.stringify(wps.map(w => [w.lat, w.lng, w.altitude, w.speed, w.holdTime, w.type, w.yaw, w.turnRadius]))

interface MissionStore {
  // State
  waypoints: Waypoint[]
  selectedId: string | null
  homePosition: { lat: number; lng: number } | null
  // null = mirrors the takeoff waypoint (or waypoints[0]); set once the user edits it
  rtlPosition: { lat: number; lng: number; altitude: number } | null
  plans: Record<string, DronePlan>   // banked plans for non-active drones
  activePlanKey: string              // which drone the working set belongs to
  uploadedSignatures: Record<string, string>  // planKey → signature last uploaded OK
  mapLayer: MapLayer
  mapView: '2d' | '3d'
  terrainFollow: boolean          // when true: export frame=10, 3D path follows terrain surface
  autoHeading: boolean            // when true: yaw at each uploaded waypoint = bearing to next
  followDrone: boolean            // when true (3D only): chase cam tracks behind the drone
  autoFollowOnMission: boolean    // when true: auto-switch to 3D + chase cam when mission starts
  cameraMode: 'follow' | 'perspective'   // chase cam mode (not persisted, resets each session)
  defaultAltitude: number   // new waypoints inherit this
  defaultSpeed: number

  // Survey planner
  surveyMode: boolean
  surveyPolygon: SurveyPoint[]
  surveyConfig: SurveyConfig
  surveyGenerated: boolean

  // Computed
  stats: () => MissionStats
  getRtlWaypoint: () => { lat: number; lng: number; altitude: number }

  // Actions
  addWaypoint: (lat: number, lng: number, type?: WaypointType) => void
  removeWaypoint: (id: string) => void
  updateWaypoint: (id: string, patch: Partial<Waypoint>) => void
  selectWaypoint: (id: string | null) => void
  moveWaypoint: (fromIdx: number, toIdx: number) => void
  setHomePosition: (lat: number, lng: number) => void
  setRtlPosition: (lat: number, lng: number) => void
  setRtlAltitude: (altitude: number) => void
  resetRtlToTakeoff: () => void
  setMapLayer: (layer: MapLayer) => void
  setMapView: (view: '2d' | '3d') => void
  setTerrainFollow: (on: boolean) => void
  setAutoHeading: (on: boolean) => void
  setFollowDrone: (on: boolean) => void
  setAutoFollowOnMission: (on: boolean) => void
  setCameraMode: (mode: 'follow' | 'perspective') => void
  setDefaultAltitude: (m: number) => void
  setDefaultSpeed: (ms: number) => void
  clearMission: () => void
  importWaypoints: (wps: Waypoint[]) => void
  switchPlan: (key: string) => void
  assignFleetPlans: (assignments: Record<string, DronePlan>) => void
  markPlanUploaded: (key: string, signature: string) => void

  // Survey actions
  setSurveyMode: (on: boolean) => void
  addSurveyPoint: (lat: number, lng: number) => void
  clearSurveyPolygon: () => void
  updateSurveyPoint: (index: number, lat: number, lng: number) => void
  removeSurveyPoint: (index: number) => void
  setSurveyConfig: (patch: Partial<SurveyConfig>) => void
  generateSurveyWaypoints: () => void
  setSurveyGenerated: (v: boolean) => void
}

// ── Survey grid generator ──────────────────────────────────────────────────
// Line generation lives in lib/survey.ts (shared with the fleet survey
// partitioner); a single-drone grid is just all lines serpentined together.

function generateGrid(polygon: SurveyPoint[], config: SurveyConfig): SurveyPoint[] {
  return serpentine(generateSurveyLines(polygon, config))
}

export const useMissionStore = create<MissionStore>()(persist((set, get) => ({
  waypoints: [],
  selectedId: null,
  homePosition: null,
  rtlPosition: null,
  plans: {},
  activePlanKey: PRIMARY_PLAN_KEY,
  uploadedSignatures: {},
  mapLayer: 'hybrid',
  mapView: '2d',
  terrainFollow: false,
  autoHeading: false,
  followDrone: false,
  autoFollowOnMission: true,
  cameraMode: 'follow' as 'follow' | 'perspective',
  defaultAltitude: 10,
  defaultSpeed: 5,

  // Survey planner defaults
  surveyMode: false,
  surveyPolygon: [],
  surveyGenerated: false,
  surveyConfig: {
    altitude: 30,
    speed: 5,
    spacing: 20,
    angle: 0,
    overshoot: 5,
    overlap: 60,
    turnRadius: 0,
  },

  stats: () => {
    const wps = get().waypoints.filter(w => w.type !== 'rtl')
    if (wps.length === 0) return { waypointCount: 0, totalDistanceM: 0, estimatedTimeS: 0, maxAltitude: 0 }
    let dist = 0
    for (let i = 1; i < wps.length; i++) {
      dist += haversine(wps[i - 1].lat, wps[i - 1].lng, wps[i].lat, wps[i].lng)
    }
    const avgSpeed = wps.reduce((a, w) => a + w.speed, 0) / wps.length || 5
    const holdTime = wps.reduce((a, w) => a + w.holdTime, 0)
    return {
      waypointCount: wps.length,
      totalDistanceM: Math.round(dist),
      estimatedTimeS: Math.round(dist / avgSpeed + holdTime),
      maxAltitude: Math.max(...wps.map(w => w.altitude)),
    }
  },

  // RTL defaults to the takeoff point (or first waypoint) until the user edits it
  getRtlWaypoint: () => {
    const s = get()
    if (s.rtlPosition) return s.rtlPosition
    const orderable = s.waypoints.filter(w => w.type !== 'rtl')
    const takeoff = orderable.find(w => w.type === 'takeoff') ?? orderable[0]
    return takeoff
      ? { lat: takeoff.lat, lng: takeoff.lng, altitude: takeoff.altitude }
      : { lat: 0, lng: 0, altitude: s.defaultAltitude }
  },

  addWaypoint: (lat, lng, type = 'waypoint') =>
    set(s => {
      const wp: Waypoint = {
        id: uid(),
        lat: Math.round(lat * 1e7) / 1e7,
        lng: Math.round(lng * 1e7) / 1e7,
        altitude: s.defaultAltitude,
        speed: s.defaultSpeed,
        holdTime: 0,
        type,
        yaw: null,
        turnRadius: 0,
      }
      return { waypoints: [...s.waypoints, wp], selectedId: wp.id }
    }),

  removeWaypoint: id =>
    set(s => ({
      waypoints: s.waypoints.filter(w => w.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    })),

  updateWaypoint: (id, patch) =>
    set(s => ({
      waypoints: s.waypoints.map(w => (w.id === id ? { ...w, ...patch } : w)),
    })),

  selectWaypoint: id => set({ selectedId: id }),

  moveWaypoint: (from, to) =>
    set(s => {
      const wps = [...s.waypoints]
      const [moved] = wps.splice(from, 1)
      wps.splice(to, 0, moved)
      return { waypoints: wps }
    }),

  setHomePosition: (lat, lng) => set({ homePosition: { lat, lng } }),

  setRtlPosition: (lat, lng) =>
    set(s => ({
      rtlPosition: {
        ...s.getRtlWaypoint(),
        lat: Math.round(lat * 1e7) / 1e7,
        lng: Math.round(lng * 1e7) / 1e7,
      },
    })),
  setRtlAltitude: altitude =>
    set(s => ({ rtlPosition: { ...s.getRtlWaypoint(), altitude } })),
  resetRtlToTakeoff: () => set({ rtlPosition: null }),

  setMapLayer: layer => set({ mapLayer: layer }),
  setMapView: view => set({ mapView: view }),
  setTerrainFollow: on => set({ terrainFollow: on }),
  setAutoHeading: on => set({ autoHeading: on }),
  setFollowDrone: on => set({ followDrone: on }),
  setAutoFollowOnMission: on => set({ autoFollowOnMission: on }),
  setCameraMode: mode => set({ cameraMode: mode }),
  setDefaultAltitude: m => set({ defaultAltitude: m }),
  setDefaultSpeed: ms => set({ defaultSpeed: ms }),

  clearMission: () => set({ waypoints: [], selectedId: null }),

  // Bank the current working set under its plan key and load the plan for
  // `key` (empty plan if this drone was never planned before).
  switchPlan: key =>
    set(s => {
      if (key === s.activePlanKey) return {}
      const plans = {
        ...s.plans,
        [s.activePlanKey]: { waypoints: s.waypoints, rtlPosition: s.rtlPosition },
      }
      const next = plans[key] ?? { waypoints: [], rtlPosition: null }
      return {
        plans,
        activePlanKey: key,
        waypoints: next.waypoints,
        rtlPosition: next.rtlPosition,
        selectedId: null,
        surveyMode: false,
        surveyGenerated: false,
      }
    }),

  // Bank a batch of per-drone plans at once (fleet survey assignment). If one
  // of them belongs to the currently active drone, it also becomes the
  // working set so the map preview updates immediately.
  assignFleetPlans: assignments =>
    set(s => {
      const plans = { ...s.plans, ...assignments }
      const active = assignments[s.activePlanKey]
      return active
        ? { plans, waypoints: active.waypoints, rtlPosition: active.rtlPosition, selectedId: null }
        : { plans }
    }),

  markPlanUploaded: (key, signature) =>
    set(s => ({ uploadedSignatures: { ...s.uploadedSignatures, [key]: signature } })),

  // Strip any legacy 'rtl'-type entries out of imported lists — RTL now lives
  // in rtlPosition, never in the orderable waypoints array.
  importWaypoints: wps =>
    set(s => {
      const legacyRtl = wps.find(w => w.type === 'rtl')
      return {
        waypoints: wps.filter(w => w.type !== 'rtl'),
        selectedId: null,
        rtlPosition: legacyRtl
          ? { lat: legacyRtl.lat, lng: legacyRtl.lng, altitude: legacyRtl.altitude }
          : s.rtlPosition,
      }
    }),

  // Survey planner
  setSurveyMode: on => set({ surveyMode: on, surveyPolygon: on ? [] : get().surveyPolygon, surveyGenerated: on ? get().surveyGenerated : false }),
  addSurveyPoint: (lat, lng) =>
    set(s => ({ surveyPolygon: [...s.surveyPolygon, { lat, lng }] })),
  clearSurveyPolygon: () => set({ surveyPolygon: [], surveyGenerated: false }),
  updateSurveyPoint: (index, lat, lng) =>
    set(s => ({
      surveyPolygon: s.surveyPolygon.map((p, i) => i === index ? { lat, lng } : p),
    })),
  removeSurveyPoint: (index) =>
    set(s => ({
      surveyPolygon: s.surveyPolygon.filter((_, i) => i !== index),
      surveyGenerated: false,
    })),
  setSurveyConfig: patch =>
    set(s => ({ surveyConfig: { ...s.surveyConfig, ...patch } })),
  generateSurveyWaypoints: () => {
    const { surveyPolygon, surveyConfig } = get()
    const gridPoints = generateGrid(surveyPolygon, surveyConfig)
    if (gridPoints.length === 0) return
    const wps: Waypoint[] = gridPoints.map((p) => ({
      id: uid(),
      lat: p.lat,
      lng: p.lng,
      altitude: surveyConfig.altitude,
      speed: surveyConfig.speed,
      holdTime: 0,
      type: 'waypoint' as WaypointType,
      yaw: null,
      turnRadius: surveyConfig.turnRadius,
    }))
    // Keep polygon so user can adjust params and re-generate
    set({ waypoints: wps, selectedId: null, surveyGenerated: true })
  },
  setSurveyGenerated: v => set({ surveyGenerated: v }),
}), {
  name: 'verocore-mission',
  // Only persist the parts that should survive a page refresh
  partialize: (s) => ({
    waypoints:       s.waypoints,
    homePosition:    s.homePosition,
    rtlPosition:     s.rtlPosition,
    plans:           s.plans,
    activePlanKey:   s.activePlanKey,
    mapLayer:        s.mapLayer,
    terrainFollow:        s.terrainFollow,
    autoFollowOnMission:  s.autoFollowOnMission,
    defaultAltitude:      s.defaultAltitude,
    defaultSpeed:         s.defaultSpeed,
  }),
}))

// ── Per-drone plan switching ────────────────────────────────────────────────
// Selecting a different fleet drone (or leaving swarm mode) swaps the working
// mission plan. Runs at store level so the swap happens no matter which page
// the user is on when they change drones.
if (typeof window !== 'undefined') {
  useSwarmStore.subscribe((state, prev) => {
    if (state.activeDroneId === prev.activeDroneId && state.enabled === prev.enabled) return
    const key = state.enabled && state.activeDroneId !== null
      ? planKeyForDrone(state.activeDroneId)
      : PRIMARY_PLAN_KEY
    useMissionStore.getState().switchPlan(key)
  })

  // Reconcile after reload: the persisted activePlanKey may reference a fleet
  // drone, but swarm state resets to "no drone selected" on page load.
  setTimeout(() => {
    const swarm = useSwarmStore.getState()
    const key = swarm.enabled && swarm.activeDroneId !== null
      ? planKeyForDrone(swarm.activeDroneId)
      : PRIMARY_PLAN_KEY
    useMissionStore.getState().switchPlan(key)
  }, 0)
}
