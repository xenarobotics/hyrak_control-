// ── MAVLink frame constants ──────────────────────────────────────────────────
// Frame 3  = MAV_FRAME_GLOBAL_RELATIVE_ALT  (altitude relative to home — default)
// Frame 10 = MAV_FRAME_GLOBAL_TERRAIN_ALT   (altitude AGL above terrain — terrain follow)
export const MAV_FRAME_GLOBAL_RELATIVE_ALT = 3
export const MAV_FRAME_GLOBAL_TERRAIN_ALT  = 10

// ── Waypoint types ──────────────────────────────────────────────────────────

export type WaypointType = 'takeoff' | 'waypoint' | 'loiter' | 'land' | 'rtl'

export interface Waypoint {
  id: string
  lat: number
  lng: number
  altitude: number   // metres AGL (above ground level)
  speed: number      // cruise speed m/s
  holdTime: number   // seconds to hover at this point
  type: WaypointType
  yaw: number | null // heading degrees — null = auto
  turnRadius: number // metres — 0 = sharp turn, >0 = smooth curve
}

export interface MissionStats {
  waypointCount: number
  totalDistanceM: number
  estimatedTimeS: number
  maxAltitude: number
}

// ── Survey planner ─────────────────────────────────────────────────────────

export interface SurveyPoint {
  lat: number
  lng: number
}

export interface SurveyConfig {
  altitude: number
  speed: number
  spacing: number      // metres between scan lines
  angle: number        // grid rotation degrees (0 = north-south)
  overshoot: number    // metres past boundary
  overlap: number      // percent front overlap (for camera)
  turnRadius: number   // metres — smooth turns at survey waypoints
}

// ── Map layer options ───────────────────────────────────────────────────────

export type MapLayer = 'street' | 'satellite' | 'terrain' | 'hybrid'

export interface MapLayerDef {
  key: MapLayer
  label: string
  url: string
  attribution: string
  maxZoom: number
  maxNativeZoom?: number    // highest zoom the tile server actually has tiles for; above this Leaflet upscales
  overlay?: string          // optional label overlay URL for hybrid
  overlayAttribution?: string
}

// Stadia Maps (alidade_satellite) requires an API key for all non-localhost
// origins — the free-tier auth bypass only covers localhost:*.
// ArcGIS World Imagery is free, requires no API key from any domain, and has
// good global coverage. The tile URL uses {z}/{y}/{x} (row before column) which
// is the ArcGIS native format and maps directly to Leaflet's {z}/{y}/{x} tokens.
export const MAP_LAYERS: MapLayerDef[] = [
  {
    key: 'street',
    label: 'Street',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxNativeZoom: 19,
    maxZoom: 22,
  },
  {
    key: 'satellite',
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; Esri, Maxar, Earthstar Geographics',
    maxNativeZoom: 18,
    maxZoom: 22,
  },
  {
    key: 'terrain',
    label: 'Terrain',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenTopoMap',
    maxNativeZoom: 17,
    maxZoom: 20,
  },
  {
    key: 'hybrid',
    label: 'Hybrid',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; Esri, Maxar, Earthstar Geographics',
    maxNativeZoom: 18,
    maxZoom: 22,
    // CartoDB light-only labels — reliable, renders roads/places/boundaries over satellite
    overlay: 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png',
    overlayAttribution: '&copy; CartoDB',
  },
]

// ── Waypoint type metadata ──────────────────────────────────────────────────

export const WP_META: Record<WaypointType, { label: string; color: string }> = {
  takeoff:  { label: 'Takeoff',  color: '#22c55e' },
  waypoint: { label: 'Waypoint', color: '#3b82f6' },
  loiter:   { label: 'Loiter',   color: '#f59e0b' },
  land:     { label: 'Land',     color: '#ef4444' },
  rtl:      { label: 'RTL',      color: '#a855f7' },
}
