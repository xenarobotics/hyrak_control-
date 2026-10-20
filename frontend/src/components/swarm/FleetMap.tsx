'use client'

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Polyline, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { useSwarmStore } from '@/store/swarm'
import { MAP_LAYERS } from '@/types/mission'
import { Crosshair } from 'lucide-react'
import { OVERLAY, OVERLAY_HOVER, FOCUS_OVERLAY } from '@/components/mission/ui'

const TRAIL_LEN = 60   // positions kept per drone (~1 min at fleet rate)

function droneIcon(id: number, color: string, active: boolean, connected: boolean): L.DivIcon {
  const sz = active ? 30 : 24
  const bg = connected ? color : '#52525b'
  return L.divIcon({
    className: '',
    html: `<div style="
      width:${sz}px;height:${sz}px;border-radius:50%;
      background:${bg};border:2px solid ${active ? '#fff' : 'rgba(255,255,255,.7)'};
      box-shadow:0 1px 6px rgba(0,0,0,.5)${active ? `,0 0 0 3px ${color}55` : ''};
      display:flex;align-items:center;justify-content:center;
      color:#fff;font-family:inherit;font-variant-numeric:tabular-nums;font-size:${active ? 13 : 12}px;font-weight:800;
    ">${id}</div>`,
    iconSize: [sz, sz],
    iconAnchor: [sz / 2, sz / 2],
  })
}

// Fits the fleet into view once when positions first arrive, then leaves the
// user's pan/zoom alone. The RECENTER button re-triggers it via `fitKey`.
function FitFleet({ points, fitKey }: { points: [number, number][]; fitKey: number }) {
  const map = useMap()
  const fitted = useRef(-1)
  useEffect(() => {
    if (points.length === 0 || fitted.current === fitKey) return
    fitted.current = fitKey
    map.fitBounds(L.latLngBounds(points), { padding: [50, 50], maxZoom: 19 })
  }, [points, fitKey, map])
  return null
}

export default function FleetMap() {
  const drones        = useSwarmStore(s => s.drones)
  const activeDroneId = useSwarmStore(s => s.activeDroneId)
  const setActiveDrone = useSwarmStore(s => s.setActiveDrone)
  const [fitKey, setFitKey] = useState(0)
  const trails = useRef<Record<number, [number, number][]>>({})

  const layer = MAP_LAYERS.find(l => l.key === 'hybrid') ?? MAP_LAYERS[0]

  const positioned = useMemo(
    () =>
      Object.values(drones).filter(d => {
        const p = d.telemetry?.position
        return p && (p.latitude_deg !== 0 || p.longitude_deg !== 0)
      }),
    [drones],
  )

  // Append to trails as telemetry flows
  useEffect(() => {
    for (const d of positioned) {
      const p = d.telemetry!.position!
      const pt: [number, number] = [p.latitude_deg, p.longitude_deg]
      const trail = (trails.current[d.id] ??= [])
      const last = trail[trail.length - 1]
      if (!last || last[0] !== pt[0] || last[1] !== pt[1]) {
        trail.push(pt)
        if (trail.length > TRAIL_LEN) trail.shift()
      }
    }
  }, [positioned])

  const points = useMemo(
    () =>
      positioned.map(d => [
        d.telemetry!.position!.latitude_deg,
        d.telemetry!.position!.longitude_deg,
      ] as [number, number]),
    [positioned],
  )

  if (points.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center rounded-[10px] border border-app-border bg-app-surface-2">
        <p className="text-[13px] text-app-text-muted">
          Waiting for drone positions…
        </p>
      </div>
    )
  }

  return (
    <div className="relative w-full h-full rounded-[10px] overflow-hidden border border-app-border">
      <MapContainer
        center={points[0]}
        zoom={18}
        className="w-full h-full"
        style={{ background: 'hsl(var(--app-surface-2))' }}
        zoomControl={false}
        attributionControl={false}
      >
        <TileLayer url={layer.url} maxZoom={layer.maxZoom} maxNativeZoom={layer.maxNativeZoom} />
        {layer.overlays?.map(url => <TileLayer key={url} url={url} maxZoom={layer.maxZoom} maxNativeZoom={layer.maxNativeZoom} />)}
        <FitFleet points={points} fitKey={fitKey} />

        {positioned.map(d => {
          const p = d.telemetry!.position!
          const trail = trails.current[d.id] ?? []
          const isActive = d.id === activeDroneId
          return (
            <Fragment key={d.id}>
              {trail.length > 1 && (
                <Polyline
                  positions={trail}
                  pathOptions={{ color: d.color, weight: 2, opacity: 0.55 }}
                />
              )}
              <Marker
                position={[p.latitude_deg, p.longitude_deg]}
                icon={droneIcon(d.id, d.color, isActive, d.connected)}
                eventHandlers={{ click: () => setActiveDrone(isActive ? null : d.id) }}
              />
            </Fragment>
          )
        })}
      </MapContainer>

      {/* Altitude chips - one per drone, matches marker colors */}
      <div className="absolute bottom-2 left-2 z-[1000] flex flex-wrap gap-1 max-w-[70%]">
        {positioned.map(d => (
          <button
            key={d.id}
            onClick={() => setActiveDrone(d.id === activeDroneId ? null : d.id)}
            className={`${OVERLAY} ${FOCUS_OVERLAY} inline-flex items-center gap-1 h-8 px-2.5 rounded-full text-xs font-bold tabular-nums shadow-[var(--app-shadow)] ${OVERLAY_HOVER}`}
            style={d.id === activeDroneId ? { borderColor: d.color } : undefined}
            aria-pressed={d.id === activeDroneId}
            title={`Drone ${d.id}: tap to ${d.id === activeDroneId ? 'clear' : 'select'}`}
          >
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: d.color }} aria-hidden />
            {d.id}
            <span className="text-overlay-muted font-semibold">alt</span>
            {(d.telemetry?.position?.relative_altitude_m ?? 0).toFixed(0)}
            <span className="text-overlay-muted font-semibold">m</span>
          </button>
        ))}
      </div>

      <button
        onClick={() => setFitKey(k => k + 1)}
        className={`${OVERLAY} ${FOCUS_OVERLAY} absolute top-2 right-2 z-[1000] flex items-center gap-1.5 h-8 px-3 rounded-[6px] text-[13px] font-semibold shadow-[var(--app-shadow)] ${OVERLAY_HOVER}`}
        title="Fit all drones in view"
      >
        <Crosshair size={14} aria-hidden />
        Recenter
      </button>
    </div>
  )
}
