'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  Polygon,
  Circle,
  useMapEvents,
  useMap,
} from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { useMissionStore, planKeyForDrone } from '@/store/mission'
import { useDroneStore } from '@/store/drone'
import { useSwarmStore } from '@/store/swarm'
import { MAP_LAYERS, WP_META } from '@/types/mission'
import type { Waypoint, MapLayer } from '@/types/mission'
import { getServerUrl } from '@/lib/server-url'
import { visibleInterval } from '@/lib/poll'
import { getHazards, getObstaclesAndPath, addHazard, type KnownHazard, type LiveObstacle, type LatLng } from '@/lib/avoidance'
import { ZONE_COLORS, zoneRings, type ZoneFeature } from '@/components/admin/zones'

// ── Flight zones (green/orange/red) - pilots plan around these ─────────────

function FlightZonesOverlay() {
  const [zones, setZones] = useState<ZoneFeature[]>([])
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch(`${getServerUrl()}/api/zones`)
        const data = await res.json()
        if (alive) setZones(data.features ?? [])
      } catch { /* zones stay hidden if backend unreachable */ }
    }
    void load()
    const id = setInterval(load, 60000)
    return () => { alive = false; clearInterval(id) }
  }, [])
  return (
    <>
      {zones.filter(z => z.properties.active).map(z => (
        <Polygon
          key={z.properties.id}
          positions={zoneRings(z)}
          pathOptions={{
            color: ZONE_COLORS[z.properties.zone_class],
            weight: 1.5,
            fillOpacity: 0.12,
            interactive: false,
          }}
        />
      ))}
    </>
  )
}

// ── Obstacle avoidance overlay ──────────────────────────────────────────────
// Known hazards (persistent shared map, blue) + every avoidance drone's LIVE
// obstacle map (grey = confirmed static, amber = moving). Pure read-only.
function AvoidanceOverlay({ show, reload, home, drone }: {
  show: boolean; reload: number; home: LatLng | null; drone: LatLng | null
}) {
  const [hazards, setHazards] = useState<KnownHazard[]>([])
  const [obstacles, setObstacles] = useState<LiveObstacle[]>([])
  const [reroutes, setReroutes] = useState<LatLng[][]>([])
  const [goals, setGoals] = useState<LatLng[]>([])
  useEffect(() => {
    if (!show) return
    let alive = true
    const load = async () => {
      try {
        const hz = await getHazards()
        const st = await fetch(`${getServerUrl()}/api/avoidance/status`).then(r => r.json())
        const ids: string[] = (st.drones ?? []).map((d: { drone_id: string }) => d.drone_id)
        const per = await Promise.all(ids.map(id =>
          getObstaclesAndPath(id).catch(() => ({ obstacles: [], reroutePath: null, goal: null }))))
        if (alive) {
          setHazards(hz)
          setObstacles(per.flatMap(p => p.obstacles))
          setReroutes(per.map(p => p.reroutePath).filter((p): p is LatLng[] => !!p && p.length > 1))
          setGoals(per.map(p => p.goal).filter((g): g is LatLng => !!g))
        }
      } catch { /* overlay stays empty if backend unreachable */ }
    }
    void load()
    return visibleInterval(load, 1500)   // fast poll so the reroute updates live
  }, [show, reload])
  if (!show) return null
  const start = home ?? drone     // mission start = the drone's home / launch point
  return (
    <>
      {/* Planned mission path: start -> destination, and the endpoints. Drawn
          even for an API-flown mission so start / land / route are visible. */}
      {start && goals.map((g, i) => (
        <Polyline key={`mp-${i}`} positions={[[start.lat, start.lng], [g.lat, g.lng]]}
          pathOptions={{ color: '#3b82f6', weight: 2, opacity: 0.5, dashArray: '2 7',
            interactive: false }} />
      ))}
      {goals.map((g, i) => (
        <Marker key={`goal-${i}`} position={[g.lat, g.lng]} icon={destIcon} interactive={false} />
      ))}
      {start && (
        <Marker position={[start.lat, start.lng]} icon={startIcon} interactive={false} />
      )}
      {hazards.map(h => (
        <Circle key={h.id} center={[h.lat, h.lng]} radius={h.radius_m}
          pathOptions={{ color: '#38bdf8', weight: 1.5, fillColor: '#38bdf8',
            fillOpacity: 0.12, interactive: false }} />
      ))}
      {obstacles.map((o, i) => (
        <Circle key={`obs-${i}`} center={[o.lat, o.lng]} radius={o.radius_m}
          pathOptions={{ color: o.is_static ? '#9aa3b5' : '#fbbf24', weight: 1.5,
            fillColor: o.is_static ? '#9aa3b5' : '#fbbf24', fillOpacity: 0.2,
            interactive: false }} />
      ))}
      {/* Active reroute path - the detour the drone is flying right now, drawn
          amber and dashed so it reads as "plan changed to avoid the obstacle". */}
      {reroutes.map((path, i) => (
        <Polyline key={`rr-${i}`} positions={path.map(p => [p.lat, p.lng] as [number, number])}
          pathOptions={{ color: '#f59e0b', weight: 3.5, opacity: 0.95,
            dashArray: '10 6', interactive: false }} />
      ))}
    </>
  )
}

// ── Custom icons ────────────────────────────────────────────────────────────

function wpIcon(index: number, type: string, selected: boolean): L.DivIcon {
  const color = WP_META[type as keyof typeof WP_META]?.color ?? '#3b82f6'
  const sz = selected ? 34 : 28
  return L.divIcon({
    className: '',
    html: `<div style="
      width:${sz}px;height:${sz}px;border-radius:50%;
      background:${selected ? color : '#0f172a'};
      border:2.5px solid ${color};
      color:#fff;font-size:11px;font-weight:700;
      display:flex;align-items:center;justify-content:center;
      font-family:var(--font-geist-mono,monospace);
      box-shadow:0 2px 10px rgba(0,0,0,.5),0 0 0 3px ${color}30;
      transition:all .15s;cursor:pointer;
    ">${index + 1}</div>`,
    iconSize: [sz, sz],
    iconAnchor: [sz / 2, sz / 2],
  })
}

const homeIcon = L.divIcon({
  className: '',
  html: `<div style="
    width:22px;height:22px;border-radius:4px;
    background:#22c55e;border:2px solid #fff;
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 2px 6px rgba(0,0,0,.3);
  "><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
})

// Mission start (A) and destination/land (B) markers for the avoidance overlay.
const startIcon = L.divIcon({
  className: '',
  html: `<div style="width:26px;height:26px;border-radius:50%;background:#22c55e;
    border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.5);display:flex;
    align-items:center;justify-content:center;color:#fff;font-weight:800;
    font-size:12px;font-family:monospace;">A</div>`,
  iconSize: [26, 26], iconAnchor: [13, 13],
})
const destIcon = L.divIcon({
  className: '',
  html: `<div style="width:26px;height:26px;border-radius:50% 50% 50% 0;
    transform:rotate(45deg);background:#ef4444;border:3px solid #fff;
    box-shadow:0 2px 8px rgba(0,0,0,.5);display:flex;align-items:center;
    justify-content:center;"><span style="transform:rotate(-45deg);color:#fff;
    font-weight:800;font-size:12px;font-family:monospace;">B</span></div>`,
  iconSize: [26, 26], iconAnchor: [13, 24],
})

const rtlIcon = L.divIcon({
  className: '',
  html: `<div style="
    width:22px;height:22px;border-radius:6px;
    background:#a855f7;border:2px solid #fff;
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 2px 6px rgba(0,0,0,.3);
    font-size:8px;font-weight:800;color:#fff;font-family:monospace;
  ">RTL</div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
})

// Red, matching the 3D view's drone billboard exactly - drone position should
// look the same regardless of which view you're in.
function makeDroneIcon(heading: number): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div style="
      width:52px;height:52px;position:relative;
      display:flex;align-items:center;justify-content:center;
    ">
      <div style="
        position:absolute;width:52px;height:52px;
        transform:rotate(${heading}deg);
        display:flex;align-items:flex-start;justify-content:center;
      ">
        <div style="
          width:0;height:0;
          border-left:7px solid transparent;
          border-right:7px solid transparent;
          border-bottom:13px solid #f87171;
          margin-top:1px;
        "></div>
      </div>
      <div style="
        width:20px;height:20px;border-radius:50%;
        background:#dc2626;border:2.5px solid #fff;
        box-shadow:0 0 14px rgba(239,68,68,.6);
        position:relative;z-index:1;
      "></div>
      <div style="
        position:absolute;width:36px;height:36px;border-radius:50%;
        border:1.5px solid rgba(239,68,68,.35);
      "></div>
    </div>`,
    iconSize: [52, 52],
    iconAnchor: [26, 26],
  })
}

// Fleet drone icon - colored circle with short name label, distinct from main drone
function makeFleetDroneIcon(name: string, color: string, isActive: boolean): L.DivIcon {
  const label = name.replace(/drone\s*/i, '#')
  const sz = isActive ? 40 : 34
  return L.divIcon({
    className: '',
    html: `<div style="
      width:${sz}px;height:${sz}px;border-radius:50%;
      background:${color};
      border:${isActive ? 3 : 2}px solid #fff;
      color:#fff;font-size:${isActive ? 10 : 9}px;font-weight:800;
      display:flex;align-items:center;justify-content:center;
      font-family:monospace;
      box-shadow:0 2px 10px rgba(0,0,0,.5),0 0 0 ${isActive ? 3 : 2}px ${color}60;
      cursor:default;
    ">${label}</div>`,
    iconSize: [sz, sz],
    iconAnchor: [sz / 2, sz / 2],
  })
}

// ── Smooth 2D Bezier flight path ────────────────────────────────────────────

function buildSmoothPath2D(waypoints: Waypoint[]): [number, number][] {
  if (waypoints.length < 2) return waypoints.map(w => [w.lat, w.lng])

  // Work in local metre coords to keep geometry accurate
  const cLat = waypoints.reduce((s, w) => s + w.lat, 0) / waypoints.length
  const cLng = waypoints.reduce((s, w) => s + w.lng, 0) / waypoints.length
  const mPerDegLat = 111_320
  const mPerDegLng = 111_320 * Math.cos((cLat * Math.PI) / 180)

  const pts = waypoints.map(w => ({
    x: (w.lng - cLng) * mPerDegLng,
    y: (w.lat - cLat) * mPerDegLat,
  }))
  const radii = waypoints.map(w => w.turnRadius ?? 0)

  const smooth: { x: number; y: number }[] = [pts[0]]

  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]
    const curr = pts[i]
    const next = pts[i + 1]
    const r = radii[i] || 0

    if (r <= 0) {
      smooth.push(curr)
      continue
    }

    const toPrev = { x: prev.x - curr.x, y: prev.y - curr.y }
    const toNext = { x: next.x - curr.x, y: next.y - curr.y }
    const lenPrev = Math.sqrt(toPrev.x ** 2 + toPrev.y ** 2)
    const lenNext = Math.sqrt(toNext.x ** 2 + toNext.y ** 2)

    if (lenPrev === 0 || lenNext === 0) { smooth.push(curr); continue }

    const maxR = Math.min(lenPrev * 0.4, lenNext * 0.4, r)
    const uPrev = { x: toPrev.x / lenPrev, y: toPrev.y / lenPrev }
    const uNext = { x: toNext.x / lenNext, y: toNext.y / lenNext }

    const arcStart = { x: curr.x + uPrev.x * maxR, y: curr.y + uPrev.y * maxR }
    const arcEnd   = { x: curr.x + uNext.x * maxR, y: curr.y + uNext.y * maxR }

    // Quadratic Bezier: arcStart → curr (control) → arcEnd
    for (let s = 0; s <= 14; s++) {
      const t = s / 14
      const it = 1 - t
      smooth.push({
        x: it * it * arcStart.x + 2 * it * t * curr.x + t * t * arcEnd.x,
        y: it * it * arcStart.y + 2 * it * t * curr.y + t * t * arcEnd.y,
      })
    }
  }

  smooth.push(pts[pts.length - 1])

  return smooth.map(p => [
    cLat + p.y / mPerDegLat,
    cLng + p.x / mPerDegLng,
  ] as [number, number])
}

// ── Map click handler ───────────────────────────────────────────────────────

function ClickHandler({ pinMode, onPin }: { pinMode: boolean; onPin: (lat: number, lng: number) => void }) {
  const addWaypoint    = useMissionStore(s => s.addWaypoint)
  const surveyMode     = useMissionStore(s => s.surveyMode)
  const addSurveyPoint = useMissionStore(s => s.addSurveyPoint)

  useMapEvents({
    click(e) {
      if (pinMode) {
        onPin(e.latlng.lat, e.latlng.lng)
      } else if (surveyMode) {
        addSurveyPoint(e.latlng.lat, e.latlng.lng)
      } else {
        addWaypoint(e.latlng.lat, e.latlng.lng)
      }
    },
  })

  return null
}

// ── Live drone marker, smooth like QGC ─────────────────────────────────────
// Telemetry arrives a few times a second. Rebuilding the icon per sample (the
// old <Marker icon={makeDroneIcon(heading)}>) replaced its DOM every update and
// teleported it from point to point. Here the marker is created ONCE and each
// animation frame moves it along the last two samples, spread over the gap
// between them, with the heading turning the short way round. It trails the
// real position by one sample interval (~0.1-0.5 s) in exchange for motion
// that reads as flight rather than hops.

function SmoothDroneMarker() {
  const map = useMap()
  useEffect(() => {
    const marker = L.marker([0, 0], { icon: makeDroneIcon(0), interactive: false, keyboard: false })
    let added = false
    let raf = 0
    // interpolation state
    let from = { lat: 0, lng: 0, hdg: 0 }
    let to = { lat: 0, lng: 0, hdg: 0 }
    let shown = { lat: 0, lng: 0, hdg: 0 }
    let t0 = 0, span = 200, lastSample = 0

    const arrow = () => (marker.getElement()?.firstElementChild?.firstElementChild as HTMLElement | null)
    const frame = () => {
      raf = requestAnimationFrame(frame)
      if (!added) return
      const f = Math.min(1, (performance.now() - t0) / span)
      const e = f * f * (3 - 2 * f)                 // ease so each segment joins softly
      const dh = ((to.hdg - from.hdg + 540) % 360) - 180
      shown = { lat: from.lat + (to.lat - from.lat) * e, lng: from.lng + (to.lng - from.lng) * e, hdg: from.hdg + dh * e }
      marker.setLatLng([shown.lat, shown.lng])
      const a = arrow()
      if (a) a.style.transform = `rotate(${shown.hdg}deg)`
    }
    const onSample = (lat: number, lng: number, hdg: number) => {
      const now = performance.now()
      if (!added) {
        from = to = shown = { lat, lng, hdg }
        marker.setLatLng([lat, lng]).addTo(map)
        added = true
      } else {
        from = shown
        to = { lat, lng, hdg }
        // Spread the move over the time since the previous sample, within
        // limits: a long gap (link hiccup) should not crawl for seconds.
        span = Math.max(60, Math.min(700, now - lastSample))
      }
      t0 = now
      lastSample = now
    }
    const take = (t: ReturnType<typeof useDroneStore.getState>['telemetry']) => {
      const p = t?.position
      if (!p || !p.latitude_deg || !p.longitude_deg) return
      if (p.latitude_deg === to.lat && p.longitude_deg === to.lng && (t!.heading_deg ?? 0) === to.hdg && added) return
      onSample(p.latitude_deg, p.longitude_deg, t!.heading_deg ?? 0)
    }
    take(useDroneStore.getState().telemetry)
    const unsub = useDroneStore.subscribe(s => take(s.telemetry))
    raf = requestAnimationFrame(frame)
    return () => { unsub(); cancelAnimationFrame(raf); marker.remove() }
  }, [map])
  return null
}

// ── Fly to drone position on first telemetry ────────────────────────────────

function DronePositionTracker() {
  const map      = useMap()
  const telemetry = useDroneStore(s => s.telemetry)
  const movedRef  = useRef(false)

  useEffect(() => {
    if (!telemetry?.position || movedRef.current) return
    const { latitude_deg, longitude_deg } = telemetry.position
    if (latitude_deg && longitude_deg) {
      map.setView([latitude_deg, longitude_deg], 17)
      movedRef.current = true
    }
  }, [telemetry, map])

  return null
}

// ── Keep the drone in view (Command tab) - pans only near the edge, so the
// operator can still zoom and look around.

function DroneFollower() {
  const map = useMap()
  const telemetry = useDroneStore(s => s.telemetry)
  useEffect(() => {
    const p = telemetry?.position
    if (!p || !p.latitude_deg || !p.longitude_deg) return
    const pt = map.latLngToContainerPoint([p.latitude_deg, p.longitude_deg])
    const size = map.getSize()
    const margin = Math.min(size.x, size.y) * 0.2
    if (pt.x < margin || pt.y < margin || pt.x > size.x - margin || pt.y > size.y - margin) {
      map.panTo([p.latitude_deg, p.longitude_deg], { animate: true })
    }
  }, [telemetry, map])
  return null
}

// Leaflet caches its container size; when the pane is resized (the Command
// tab's minimap swap, a dock drag) it must be told, or it draws grey tiles.
function MapResizeWatcher() {
  const map = useMap()
  useEffect(() => {
    const el = map.getContainer()
    let raf = 0
    const ro = new ResizeObserver(() => {       // at most one redraw per frame
      if (raf) return
      raf = requestAnimationFrame(() => { raf = 0; map.invalidateSize({ animate: false }) })
    })
    ro.observe(el)
    return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf) }
  }, [map])
  return null
}

// ── Draggable waypoint marker ───────────────────────────────────────────────

function WaypointMarker({ wp, index, readOnly = false }: { wp: Waypoint; index: number; readOnly?: boolean }) {
  const selectedId    = useMissionStore(s => s.selectedId)
  const selectWaypoint = useMissionStore(s => s.selectWaypoint)
  const updateWaypoint = useMissionStore(s => s.updateWaypoint)

  const icon = useMemo(
    () => wpIcon(index, wp.type, wp.id === selectedId),
    [index, wp.type, wp.id, selectedId],
  )

  return (
    <Marker
      position={[wp.lat, wp.lng]}
      icon={icon}
      draggable={!readOnly}
      eventHandlers={readOnly ? {} : {
        click: () => selectWaypoint(wp.id),
        dragend: (e) => {
          const { lat, lng } = e.target.getLatLng()
          updateWaypoint(wp.id, {
            lat: Math.round(lat * 1e7) / 1e7,
            lng: Math.round(lng * 1e7) / 1e7,
          })
        },
      }}
    />
  )
}

// ── Main map ────────────────────────────────────────────────────────────────

/**
 * readOnly: a monitoring view (Command tab) - clicks never add or move
 * waypoints and hazards cannot be pinned, so a stray click while flying
 * cannot change the mission. follow: keep the drone in view. compact: a
 * minimap - no legend box.
 */
// `layer`: force a base layer for this instance (Normal mode uses the plain
// street map) without touching the operator's saved choice.
export default function MissionMap({ readOnly = false, follow = false, compact = false, layer }: { readOnly?: boolean; follow?: boolean; compact?: boolean; layer?: MapLayer } = {}) {
  const rawWaypoints       = useMissionStore(s => s.waypoints)
  const homePosition       = useMissionStore(s => s.homePosition)
  const getRtlWaypoint     = useMissionStore(s => s.getRtlWaypoint)
  const savedLayer         = useMissionStore(s => s.mapLayer)
  const mapLayer           = layer ?? savedLayer
  const surveyPolygon      = useMissionStore(s => s.surveyPolygon)
  const surveyMode         = useMissionStore(s => s.surveyMode)
  const updateSurveyPoint  = useMissionStore(s => s.updateSurveyPoint)
  const terrainFollow      = useMissionStore(s => s.terrainFollow)
  const telemetry          = useDroneStore(s => s.telemetry)
  const swarmEnabled       = useSwarmStore(s => s.enabled)
  const fleetDrones        = useSwarmStore(s => s.drones)
  const activeFleetId      = useSwarmStore(s => s.activeDroneId)
  const fleetPlans         = useMissionStore(s => s.plans)
  const activePlanKey      = useMissionStore(s => s.activePlanKey)

  // RTL is a separate, non-mission control (see rtlPosition in the mission
  // store) - never part of the orderable/flown path. Defensive filter in case
  // older persisted data still has a legacy 'rtl' type entry.
  const waypoints = useMemo(() => rawWaypoints.filter(w => w.type !== 'rtl'), [rawWaypoints])
  const rtlWp = getRtlWaypoint()

  const layerDef = MAP_LAYERS.find(l => l.key === mapLayer) ?? MAP_LAYERS[0]
  const dronePos = telemetry?.position
  const missionFinished     = telemetry?.mission_finished ?? false
  const missionCurrentIndex = missionFinished ? -1 : (telemetry?.mission_current_index ?? -1)

  // Build full smooth path for the planned route
  const smoothPath = useMemo(
    () => waypoints.length >= 2 ? buildSmoothPath2D(waypoints) : [],
    [waypoints],
  )

  // During an active mission: split the smooth path into completed (green) and remaining (blue)
  const completedPath = useMemo(() => {
    if (missionCurrentIndex < 1 || waypoints.length < 2) return []
    const count = Math.min(missionCurrentIndex + 1, waypoints.length)
    return buildSmoothPath2D(waypoints.slice(0, count))
  }, [waypoints, missionCurrentIndex])

  const remainingPath = useMemo(() => {
    if (missionCurrentIndex < 0 || waypoints.length < 2) return smoothPath
    const start = Math.max(0, missionCurrentIndex)
    return waypoints.length - start >= 2 ? buildSmoothPath2D(waypoints.slice(start)) : []
  }, [waypoints, missionCurrentIndex, smoothPath])

  // Drone position trail - last 60 positions for a flight path ghost
  const [droneTrail, setDroneTrail] = useState<[number, number][]>([])
  const lastTrailPos = useRef<{ lat: number; lng: number } | null>(null)
  const [showAvoid, setShowAvoid] = useState(true)   // obstacle-avoidance overlay
  const [pinMode, setPinMode] = useState(false)      // click-to-pin a known hazard
  const [hazardNonce, setHazardNonce] = useState(0)  // bump to force overlay reload

  const pinHazard = useCallback(async (lat: number, lng: number) => {
    try {
      await addHazard(lat, lng, 8, 0)
      setHazardNonce(n => n + 1)   // reload the overlay so the new circle shows
    } catch { /* backend unreachable - nothing pinned */ }
    setPinMode(false)             // one pin per activation
  }, [])

  useEffect(() => {
    if (!dronePos || dronePos.latitude_deg === 0) return
    const lat = dronePos.latitude_deg
    const lng = dronePos.longitude_deg
    const last = lastTrailPos.current
    if (last && Math.abs(lat - last.lat) < 0.000005 && Math.abs(lng - last.lng) < 0.000005) return
    lastTrailPos.current = { lat, lng }
    setDroneTrail(prev => [...prev.slice(-59), [lat, lng]])
  }, [dronePos])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
    <MapContainer
      center={[20, 0]}
      zoom={3}
      className="w-full h-full"
      style={{ background: '#0a0a0a' }}
      zoomControl={false}
      attributionControl={false}
    >
      <TileLayer
        key={layerDef.key}
        url={layerDef.url}
        attribution={layerDef.attribution}
        maxZoom={layerDef.maxZoom}
        maxNativeZoom={layerDef.maxNativeZoom}
      />

      {layerDef.overlay && (
        <TileLayer
          url={layerDef.overlay}
          attribution={layerDef.overlayAttribution ?? ''}
          maxZoom={layerDef.maxZoom}
          maxNativeZoom={layerDef.maxNativeZoom}
        />
      )}

      {!readOnly && <ClickHandler pinMode={pinMode} onPin={pinHazard} />}
      <DronePositionTracker />
      {follow && <DroneFollower />}
      <MapResizeWatcher />
      <FlightZonesOverlay />
      <AvoidanceOverlay show={showAvoid} reload={hazardNonce}
        home={homePosition ? { lat: homePosition.lat, lng: homePosition.lng } : null}
        drone={dronePos && dronePos.latitude_deg !== 0
          ? { lat: dronePos.latitude_deg, lng: dronePos.longitude_deg } : null} />

      {/* Planned flight path (no active mission) - cyan when terrain-follow is on
          (path adapts to terrain), blue when off (fixed altitude relative to home) */}
      {missionCurrentIndex < 0 && smoothPath.length >= 2 && (
        <>
          <Polyline positions={smoothPath} pathOptions={{ color: terrainFollow ? '#0e7490' : '#1d4ed8', weight: 10, opacity: 0.2 }} />
          <Polyline positions={smoothPath} pathOptions={{ color: terrainFollow ? '#22d3ee' : '#3b82f6', weight: 4.5, opacity: 0.95 }} />
        </>
      )}

      {/* Active mission: remaining path */}
      {missionCurrentIndex >= 0 && remainingPath.length >= 2 && (
        <>
          <Polyline positions={remainingPath} pathOptions={{ color: terrainFollow ? '#0e7490' : '#1d4ed8', weight: 8, opacity: 0.18 }} />
          <Polyline positions={remainingPath} pathOptions={{ color: terrainFollow ? '#22d3ee' : '#3b82f6', weight: 3.5, opacity: 0.75 }} />
        </>
      )}

      {/* Active mission: completed legs - solid, bold, fully-opaque green (no
          glow underlayer here, unlike the planned/remaining path - elapsed
          progress should read as solid and certain, not stylistic) */}
      {missionCurrentIndex >= 1 && completedPath.length >= 2 && (
        <Polyline positions={completedPath} pathOptions={{ color: '#22c55e', weight: 5, opacity: 1 }} />
      )}

      {/* Drone position trail (fading ghost path) */}
      {droneTrail.length >= 2 && (
        <Polyline
          positions={droneTrail}
          pathOptions={{ color: '#60a5fa', weight: 2, opacity: 0.45, dashArray: '4 5' }}
        />
      )}

      {/* Home marker */}
      {homePosition && (
        <Marker position={[homePosition.lat, homePosition.lng]} icon={homeIcon} />
      )}

      {/* RTL marker - where the drone goes when RTL is triggered */}
      {waypoints.length > 0 && (
        <Marker position={[rtlWp.lat, rtlWp.lng]} icon={rtlIcon} />
      )}

      {/* Live drone - glides between telemetry samples */}
      <SmoothDroneMarker />

      {/* Survey area polygon while drawing */}
      {surveyMode && surveyPolygon.length >= 2 && (
        <Polyline
          positions={surveyPolygon.map(p => [p.lat, p.lng] as [number, number])}
          pathOptions={{ color: '#a855f7', weight: 3, dashArray: '8 5', opacity: 0.9 }}
        />
      )}
      {surveyMode && surveyPolygon.length >= 3 && (
        <Polygon
          positions={surveyPolygon.map(p => [p.lat, p.lng] as [number, number])}
          pathOptions={{
            color: '#a855f7',
            weight: 3,
            fillColor: '#a855f7',
            fillOpacity: 0.15,
          }}
        />
      )}
      {/* Survey vertex dots - draggable to edit polygon */}
      {surveyMode && surveyPolygon.map((p, i) => (
        <Marker
          key={`sv_${i}`}
          position={[p.lat, p.lng]}
          draggable
          icon={L.divIcon({
            className: '',
            html: `<div style="
              width:18px;height:18px;border-radius:50%;
              background:#a855f7;border:2.5px solid #fff;
              box-shadow:0 1px 5px rgba(0,0,0,.45);
              display:flex;align-items:center;justify-content:center;
              font-size:8px;font-weight:700;color:#fff;font-family:monospace;
              cursor:grab;
            ">${i + 1}</div>`,
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          })}
          eventHandlers={{
            dragend: (e) => {
              const { lat, lng } = e.target.getLatLng()
              updateSurveyPoint(
                i,
                Math.round(lat * 1e7) / 1e7,
                Math.round(lng * 1e7) / 1e7,
              )
            },
          }}
        />
      ))}

      {/* Waypoint markers */}
      {waypoints.map((wp, i) => (
        <WaypointMarker key={wp.id} wp={wp} index={i} readOnly={readOnly} />
      ))}

      {/* Fleet mission lanes (swarm mode) - every OTHER connected drone's
          banked plan drawn as a dashed line in its color, so the operator sees
          the whole fleet's routes while editing one. The active drone's plan
          is the working set and renders as the normal editable mission. */}
      {swarmEnabled && Object.values(fleetDrones)
        .filter(d => d.connected && planKeyForDrone(d.id) !== activePlanKey)
        .map(d => {
          const plan = fleetPlans[planKeyForDrone(d.id)]
          if (!plan || plan.waypoints.length < 2) return null
          return (
            <Polyline
              key={`lane-${d.id}`}
              positions={plan.waypoints.map(w => [w.lat, w.lng] as [number, number])}
              pathOptions={{ color: d.color, weight: 2, opacity: 0.55, dashArray: '6 6' }}
              interactive={false}
            />
          )
        })}

      {/* Fleet drone positions (swarm mode) - each gets a distinct colored icon
          with the drone label inside, so overlapping positions are still readable */}
      {swarmEnabled && Object.values(fleetDrones).map(drone => {
        const pos = drone.telemetry?.position
        if (!pos || pos.latitude_deg === 0) return null
        return (
          <Marker
            key={`fleet-${drone.id}`}
            position={[pos.latitude_deg, pos.longitude_deg]}
            icon={makeFleetDroneIcon(drone.name, drone.color, drone.id === activeFleetId)}
            interactive={false}
            zIndexOffset={drone.id === activeFleetId ? 900 : 800}
          />
        )
      })}
    </MapContainer>

      {/* Avoidance overlay control - toggle visibility, legend, click-to-pin */}
      {!compact && <div style={{
        position: 'absolute', bottom: 12, left: 12, zIndex: 1000,
        background: 'rgba(10,12,18,0.82)', backdropFilter: 'blur(6px)',
        border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8,
        padding: '8px 10px', fontSize: 11, color: '#e5e7eb',
        fontFamily: 'var(--font-geist-mono,monospace)', minWidth: 148,
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontWeight: 700 }}>
          <input type="checkbox" checked={showAvoid}
            onChange={e => setShowAvoid(e.target.checked)}
            style={{ accentColor: '#38bdf8', cursor: 'pointer' }} />
          Avoidance
        </label>
        {showAvoid && (
          <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <LegendRow color="#38bdf8" label="Known hazard" />
            <LegendRow color="#9aa3b5" label="Static obstacle" />
            <LegendRow color="#fbbf24" label="Moving obstacle" />
            {!readOnly && <button
              onClick={() => setPinMode(p => !p)}
              style={{
                marginTop: 4, width: '100%', padding: '4px 6px', borderRadius: 5,
                border: `1px solid ${pinMode ? '#38bdf8' : 'rgba(255,255,255,0.12)'}`,
                background: pinMode ? 'rgba(56,189,248,0.18)' : 'rgba(255,255,255,0.04)',
                color: pinMode ? '#7dd3fc' : '#cbd5e1', cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 10.5, fontWeight: 600,
              }}>
              {pinMode ? 'Click map to pin...' : '+ Pin hazard'}
            </button>}
          </div>
        )}
      </div>}
    </div>
  )
}

function LegendRow({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        width: 11, height: 11, borderRadius: '50%', flexShrink: 0,
        background: `${color}44`, border: `1.5px solid ${color}`,
      }} />
      <span style={{ color: '#cbd5e1' }}>{label}</span>
    </div>
  )
}
