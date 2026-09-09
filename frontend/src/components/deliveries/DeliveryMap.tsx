'use client'

// The dispatch map - the operational picture in one frame: the pad/station
// network, every in-flight order's route (positioning leg amber, delivery
// leg cyan, selected order emphasized), zone + land-use overlays, and every
// live drone. Clicking a drone opens its status card (with the live camera
// when this session is streaming). Renders state only - never mutates it.

import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, Marker, Polyline, Polygon, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { getServerUrl } from '@/lib/server-url'
import { MAP_LAYERS } from '@/types/mission'
import { ZONE_COLORS, zoneRings, type ZoneFeature } from '@/components/admin/zones'
import Delivery3D, { warmCesium } from './Delivery3D'
import { useWebRTCContext } from '@/contexts/WebRTCContext'

export type MapPad = {
    id: string; name: string; lat: number; lng: number; kind?: 'pad' | 'station'
}
export type MapWp = { lat: number; lng: number; altitude: number; type: string }
export type MapDroneLive = {
    id: string; name: string
    lat: number; lng: number; alt?: number; heading: number
    battery: number; mode: string; in_air: boolean
    order_no?: string | null
    is_session?: boolean       // this browser's own telemetry link
}
export type MapRoute = {
    key: string                // stable id for React
    order_no: string
    leg: 'pickup' | 'delivery'
    waypoints: MapWp[]
    selected: boolean
}
export type MapSelection = {
    order_no: string
    pickup: { name: string; lat: number; lng: number }
    dropoff: { name: string; lat: number; lng: number }
    waypoints: MapWp[]
} | null

const LEG_COLOR = { pickup: '#f59e0b', delivery: '#22d3ee' } as const

// ── Icons ────────────────────────────────────────────────────────────────
// Labels get a dark chip behind them so they read on street AND satellite.

function labelChip(text: string, color: string) {
    return `<div style="position:absolute;top:14px;left:50%;transform:translateX(-50%);
        white-space:nowrap;font:600 9px monospace;color:${color};
        background:rgba(10,10,14,.78);padding:1px 5px;border-radius:4px;
        border:1px solid ${color}44">${text}</div>`
}

function padIcon(label: string, highlight: 'pickup' | 'dropoff' | null,
                 kind: 'pad' | 'station' = 'pad') {
    const color = highlight === 'pickup' ? '#4ade80'
        : highlight === 'dropoff' ? '#f87171'
            : kind === 'station' ? '#fbbf24' : '#06b6d4'
    const tag = highlight === 'pickup' ? 'PICKUP' : highlight === 'dropoff' ? 'DROP' : ''
    const shape = kind === 'station'
        ? `<div style="width:16px;height:16px;border-radius:4px;background:${color};
            display:flex;align-items:center;justify-content:center;
            font:800 10px monospace;color:#000;
            box-shadow:0 0 0 2px rgba(0,0,0,.45), 0 0 8px ${color}88">H</div>`
        : `<div style="width:14px;height:14px;border-radius:50%;
            background:${color}33;border:2.5px solid ${color};box-sizing:border-box;
            box-shadow:0 0 0 2px rgba(0,0,0,.35)"></div>`
    return L.divIcon({
        className: '', iconSize: [16, 16], iconAnchor: [8, 8],
        html: `<div style="position:relative">
            ${shape}
            ${tag ? `<div style="position:absolute;top:-15px;left:50%;transform:translateX(-50%);
                font:700 8px monospace;color:${color};letter-spacing:.5px">${tag}</div>` : ''}
            ${labelChip(label, color)}
        </div>`,
    })
}

function endpointIcon(kind: 'takeoff' | 'land') {
    const color = kind === 'takeoff' ? '#4ade80' : '#f87171'
    return L.divIcon({
        className: '', iconSize: [20, 20], iconAnchor: [10, 10],
        html: `<div style="width:20px;height:20px;border-radius:50%;
            background:${color};color:#000;display:flex;align-items:center;
            justify-content:center;font:800 10px monospace;
            box-shadow:0 0 0 2px rgba(0,0,0,.4), 0 0 8px ${color}aa">
            ${kind === 'takeoff' ? '▲' : '▼'}</div>`,
    })
}

function droneIcon(d: MapDroneLive, focused: boolean) {
    const color = d.in_air ? '#fbbf24' : '#34d399'
    const batColor = d.battery < 25 ? '#f87171' : d.battery < 40 ? '#fbbf24' : '#a1a1aa'
    return L.divIcon({
        className: '', iconSize: [26, 26], iconAnchor: [13, 13],
        html: `<div style="position:relative">
            <div style="transform:rotate(${d.heading}deg);width:26px;height:26px;
                display:flex;align-items:center;justify-content:center;
                filter:drop-shadow(0 0 ${focused ? 8 : 4}px ${color})">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="${color}"
                    stroke="rgba(0,0,0,.5)" stroke-width="1">
                    <path d="M12 2 L19 21 L12 16 L5 21 Z"/>
                </svg></div>
            <div style="position:absolute;top:22px;left:50%;transform:translateX(-50%);
                white-space:nowrap;font:600 9px monospace;color:#e4e4e7;
                background:rgba(10,10,14,.82);padding:1px 5px 2px;border-radius:4px;
                border:1px solid ${focused ? color : 'rgba(255,255,255,.15)'}">
                ${d.name}${d.order_no ? ` <span style="color:#22d3ee">${d.order_no}</span>` : ''}
                <div style="margin-top:1px;height:3px;border-radius:2px;background:rgba(255,255,255,.15);overflow:hidden">
                    <div style="width:${Math.max(0, Math.min(100, d.battery))}%;height:100%;background:${batColor}"></div>
                </div>
            </div>
        </div>`,
    })
}

// Direction arrow rendered mid-segment so a path reads as a FLIGHT, not a line
function arrowIcon(bearing: number, color: string) {
    return L.divIcon({
        className: '', iconSize: [12, 12], iconAnchor: [6, 6],
        html: `<div style="transform:rotate(${bearing}deg);width:12px;height:12px;
            display:flex;align-items:center;justify-content:center">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="${color}">
                <path d="M12 3 L18 20 L12 16 L6 20 Z"/>
            </svg></div>`,
    })
}

function midArrow(wps: MapWp[]): { pos: [number, number]; bearing: number } | null {
    if (wps.length < 2) return null
    const i = Math.floor((wps.length - 1) / 2)
    const a = wps[i], b = wps[Math.min(i + 1, wps.length - 1)]
    const bearing = (Math.atan2(b.lng - a.lng, b.lat - a.lat) * 180 / Math.PI + 360) % 360
    return { pos: [(a.lat + b.lat) / 2, (a.lng + b.lng) / 2], bearing }
}

// ── Overlays ─────────────────────────────────────────────────────────────

const FEATURE_COLORS: Record<string, string> = {
    road: '#94a3b8', water: '#38bdf8', forest: '#22c55e', open_field: '#a3e635',
    farmland: '#eab308', residential: '#f472b6', hostel: '#ef4444',
    school: '#fb923c', campus: '#06b6d4', industrial: '#a855f7',
}

type FeatureGJ = {
    geometry: { type: string; coordinates: unknown }
    properties: { id: string; category: string; active: boolean }
}

function featurePolys(f: FeatureGJ): [number, number][][][] {
    const g = f.geometry
    const toLatLng = (ring: number[][]) => ring.map(([lng, lat]) => [lat, lng] as [number, number])
    if (g.type === 'Polygon') return [(g.coordinates as number[][][]).map(toLatLng)]
    if (g.type === 'MultiPolygon') return (g.coordinates as number[][][][]).map(poly => poly.map(toLatLng))
    return []
}

function LandUseOverlay() {
    const [features, setFeatures] = useState<FeatureGJ[]>([])
    useEffect(() => {
        fetch(`${getServerUrl()}/api/map-features`)
            .then(r => r.json())
            .then(j => setFeatures((j.features ?? []).filter((f: FeatureGJ) => f.properties.active)))
            .catch(() => { /* overlay stays hidden */ })
    }, [])
    return (
        <>
            {features.flatMap((f, fi) => {
                const color = FEATURE_COLORS[f.properties.category] ?? '#a1a1aa'
                const fill = f.properties.category === 'campus' ? 0.0 : 0.18
                return featurePolys(f).map((poly, pi) => (
                    <Polygon key={`${fi}-${pi}`} positions={poly}
                        pathOptions={{
                            color, weight: f.properties.category === 'campus' ? 1.5 : 0.8,
                            fillOpacity: fill, interactive: false,
                        }} />
                ))
            })}
        </>
    )
}

function ZonesOverlay() {
    const [zones, setZones] = useState<ZoneFeature[]>([])
    useEffect(() => {
        let alive = true
        const load = async () => {
            try {
                const r = await fetch(`${getServerUrl()}/api/zones`)
                const j = await r.json()
                if (alive) setZones(j.features ?? [])
            } catch { /* zones stay hidden if backend unreachable */ }
        }
        void load()
        const t = setInterval(load, 60000)
        return () => { alive = false; clearInterval(t) }
    }, [])
    return (
        <>
            {zones.filter(z => z.properties.active).map(z => (
                <Polygon key={z.properties.id} positions={zoneRings(z)}
                    pathOptions={{
                        color: ZONE_COLORS[z.properties.zone_class],
                        weight: 1, fillOpacity: 0.08, interactive: false,
                    }} />
            ))}
        </>
    )
}

function FitBounds({ pads, selection }: { pads: MapPad[]; selection: MapSelection }) {
    const map = useMap()
    const key = selection?.order_no ?? (pads.length ? 'pads' : 'none')
    useEffect(() => {
        const pts: [number, number][] = selection
            ? selection.waypoints.map(w => [w.lat, w.lng] as [number, number])
            : pads.map(p => [p.lat, p.lng] as [number, number])
        if (pts.length === 0) return
        if (pts.length === 1) { map.setView(pts[0], 16); return }
        map.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 17 })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, map])
    return null
}

// ── Route rendering ──────────────────────────────────────────────────────

function RouteLayer({ route }: { route: MapRoute }) {
    const pts = route.waypoints.map(w => [w.lat, w.lng] as [number, number])
    if (pts.length < 2) return null
    const color = LEG_COLOR[route.leg]
    const opacity = route.selected ? 0.95 : 0.45
    const weight = route.selected ? 3.5 : 2
    const arrow = midArrow(route.waypoints)
    return (
        <>
            <Polyline positions={pts}
                pathOptions={{ color: '#000', weight: weight + 3, opacity: opacity * 0.4 }} />
            <Polyline positions={pts}
                pathOptions={{
                    color, weight, opacity,
                    dashArray: route.leg === 'pickup' ? '6 8' : undefined,
                }} />
            {arrow && (
                <Marker position={arrow.pos} interactive={false}
                    icon={arrowIcon(arrow.bearing, color)} />
            )}
            {route.selected && (
                <>
                    <Marker position={pts[0]} interactive={false} icon={endpointIcon('takeoff')} />
                    <Marker position={pts[pts.length - 1]} interactive={false} icon={endpointIcon('land')} />
                </>
            )}
        </>
    )
}

// ── Focused-drone card (with live video when available) ──────────────────

function DroneCard({ drone, onClose }: { drone: MapDroneLive; onClose: () => void }) {
    const { isStreaming, remoteStream, localStream } = useWebRTCContext()
    const showVideo = drone.is_session && isStreaming
    const videoRef = (el: HTMLVideoElement | null) => {
        if (el) el.srcObject = remoteStream ?? localStream
    }
    const batColor = drone.battery < 25 ? '#f87171' : drone.battery < 40 ? '#fbbf24' : '#4ade80'
    return (
        <div className="absolute bottom-2 left-2 z-[600] w-[240px] rounded-lg border overflow-hidden shadow-xl"
            style={{ background: 'hsl(var(--app-surface))', borderColor: 'hsl(var(--app-border))' }}>
            {showVideo ? (
                <div className="relative">
                    <video ref={videoRef} autoPlay muted playsInline
                        className="w-full aspect-video object-cover bg-black" />
                    <span className="absolute top-1 left-1.5 flex items-center gap-1 text-[9px] font-mono text-white/90">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /> LIVE
                    </span>
                </div>
            ) : (
                <div className="w-full aspect-video flex items-center justify-center bg-black/60">
                    <p className="text-[10px] font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>
                        {drone.is_session ? 'Camera not streaming' : 'No camera on this link yet'}
                    </p>
                </div>
            )}
            <div className="p-2.5">
                <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full"
                        style={{ background: drone.in_air ? '#fbbf24' : '#4ade80' }} />
                    <span className="font-mono text-xs">{drone.name}</span>
                    <button className="ml-auto text-xs opacity-60 hover:opacity-100" onClick={onClose}>✕</button>
                </div>
                {/* Battery bar with the 20% reserve line - below it the drone
                    must be heading home, not taking work. */}
                <div className="mt-2 relative h-1.5 rounded-full overflow-hidden"
                    style={{ background: 'hsl(var(--app-border))' }}>
                    <div className="h-full rounded-full"
                        style={{ width: `${Math.min(100, Math.max(0, drone.battery))}%`, background: batColor }} />
                    <div className="absolute top-0 h-full w-px" style={{ left: '20%', background: '#f87171' }} />
                </div>
                <div className="mt-1.5 flex items-center gap-2 text-[10px] font-mono"
                    style={{ color: 'hsl(var(--app-text-muted))' }}>
                    <span style={{ color: batColor }}>{Math.round(drone.battery)}%</span>
                    <span>{drone.mode}</span>
                    <span>{drone.in_air ? 'IN AIR' : 'GROUND'}</span>
                    {drone.order_no && <span className="text-cyan-500">{drone.order_no}</span>}
                </div>
            </div>
        </div>
    )
}

// ── Shared control styles ────────────────────────────────────────────────

const activeBtn = { background: '#06b6d4', color: '#000', border: '1px solid #06b6d4' }
const idleBtn = {
    background: 'hsl(var(--app-surface))',
    color: 'hsl(var(--app-text-muted))',
    border: '1px solid hsl(var(--app-border))',
}

function ModeButtons({ mode, setMode }: {
    mode: '2d' | '3d'; setMode: (m: '2d' | '3d') => void
}) {
    return (
        <>
            {(['2d', '3d'] as const).map(m => (
                <button key={m} onClick={() => setMode(m)}
                    className="px-2 py-1 rounded text-[10px] font-mono border"
                    style={mode === m ? activeBtn : idleBtn}>
                    {m.toUpperCase()}
                </button>
            ))}
        </>
    )
}

// ── The map ──────────────────────────────────────────────────────────────

export default function DeliveryMap({ pads, selection, drones, routes = [] }: {
    pads: MapPad[]
    selection: MapSelection
    drones: MapDroneLive[]
    routes?: MapRoute[]
}) {
    const [layerKey, setLayerKey] = useState<'nav' | 'street' | 'satellite'>('nav')
    const [mode, setMode] = useState<'2d' | '3d'>('2d')

    // Pull the (large) Cesium chunk down while the user is still on 2D,
    // so flipping to 3D costs seconds, not a cold bundle download.
    useEffect(() => { warmCesium() }, [])
    const [showLandUse, setShowLandUse] = useState(false)
    const [focusId, setFocusId] = useState<string | null>(null)
    const [pinnedId, setPinnedId] = useState<string | null>(null)
    const [stationId, setStationId] = useState<string | null>(null)
    const [showAirspace, setShowAirspace] = useState(true)
    const layer = MAP_LAYERS.find(l => l.key === layerKey) ?? MAP_LAYERS[0]

    const shownId = pinnedId ?? focusId
    const focused = useMemo(
        () => drones.find(d => d.id === shownId) ?? null, [drones, shownId])

    const center: [number, number] = pads.length
        ? [pads[0].lat, pads[0].lng] : [17.6, 78.12]

    if (mode === '3d') {
        return (
            <div className="relative h-full w-full rounded-lg overflow-hidden border"
                style={{ borderColor: 'hsl(var(--app-border))', background: '#000' }}>
                <Delivery3D pads={pads} selection={selection} drones={drones}
                    showAirspace={showAirspace} />
                <div className="absolute top-2 right-2 z-[500] flex gap-1">
                    <button onClick={() => setShowAirspace(v => !v)}
                        title="Show restricted airspace as 3D volumes (zone floor to ceiling)"
                        className="px-2 py-1 rounded text-[10px] font-mono border"
                        style={showAirspace ? activeBtn : idleBtn}>
                        AIRSPACE
                    </button>
                    <ModeButtons mode={mode} setMode={setMode} />
                </div>
                {focused && (
                    <DroneCard drone={focused}
                        onClose={() => { setPinnedId(null); setFocusId(null) }} />
                )}
            </div>
        )
    }

    return (
        <div className="relative h-full w-full rounded-lg overflow-hidden border"
            style={{ borderColor: 'hsl(var(--app-border))' }}>
            <MapContainer center={center} zoom={15} className="h-full w-full"
                zoomControl={false} attributionControl={false}>
                <TileLayer key={layer.key} url={layer.url}
                    maxNativeZoom={layer.maxNativeZoom} maxZoom={layer.maxZoom} />
                <ZonesOverlay />
                {showLandUse && <LandUseOverlay />}
                <FitBounds pads={pads} selection={selection} />

                {routes.map(r => <RouteLayer key={r.key} route={r} />)}

                {pads.map(p => {
                    const hl = selection && p.name === selection.pickup.name ? 'pickup'
                        : selection && p.name === selection.dropoff.name ? 'dropoff' : null
                    const isStation = p.kind === 'station'
                    return (
                        <Marker key={p.id} position={[p.lat, p.lng]}
                            icon={padIcon(p.name, hl, p.kind ?? 'pad')}
                            interactive={isStation}
                            eventHandlers={isStation ? {
                                click: () => setStationId(id => (id === p.id ? null : p.id)),
                            } : undefined} />
                    )
                })}

                {drones.map(d => (
                    <Marker key={d.id} position={[d.lat, d.lng]}
                        icon={droneIcon(d, d.id === shownId)}
                        eventHandlers={{
                            mouseover: () => setFocusId(d.id),
                            mouseout: () => setFocusId(f => (f === d.id ? null : f)),
                            click: () => setPinnedId(pin => (pin === d.id ? null : d.id)),
                        }} />
                ))}
            </MapContainer>

            <div className="absolute top-2 right-2 z-[500] flex gap-1">
                {(['nav', 'street', 'satellite'] as const).map(k => (
                    <button key={k} onClick={() => setLayerKey(k)}
                        className="px-2 py-1 rounded text-[10px] font-mono border"
                        style={layerKey === k ? activeBtn : idleBtn}>
                        {k.toUpperCase()}
                    </button>
                ))}
                <button onClick={() => setShowLandUse(v => !v)}
                    title="Show the land-use data the route profiles read"
                    className="px-2 py-1 rounded text-[10px] font-mono border"
                    style={showLandUse ? activeBtn : idleBtn}>
                    LAND USE
                </button>
                <ModeButtons mode={mode} setMode={setMode} />
            </div>

            {/* Legend - the map must explain itself */}
            <div className="absolute top-2 left-2 z-[500] px-2.5 py-1.5 rounded-md border flex flex-col gap-1"
                style={{ background: 'hsl(var(--app-surface))', borderColor: 'hsl(var(--app-border))' }}>
                {([
                    ['#22d3ee', 'delivery leg', false],
                    ['#f59e0b', 'pickup leg', true],
                ] as const).map(([c, t, dash]) => (
                    <span key={t} className="flex items-center gap-1.5 text-[9px] font-mono"
                        style={{ color: 'hsl(var(--app-text-muted))' }}>
                        <span className="inline-block w-5 h-0"
                            style={{ borderTop: `2px ${dash ? 'dashed' : 'solid'} ${c}` }} />
                        {t}
                    </span>
                ))}
                <span className="flex items-center gap-1.5 text-[9px] font-mono"
                    style={{ color: 'hsl(var(--app-text-muted))' }}>
                    <span className="inline-block w-2.5 h-2.5 rounded-[3px]"
                        style={{ background: '#fbbf24' }} /> station
                    <span className="inline-block w-2.5 h-2.5 rounded-full ml-1"
                        style={{ border: '2px solid #06b6d4' }} /> pad
                </span>
            </div>

            {focused && (
                <DroneCard drone={focused}
                    onClose={() => { setPinnedId(null); setFocusId(null) }} />
            )}

            {stationId && !focused && (() => {
                const st = pads.find(p => p.id === stationId)
                if (!st) return null
                const here = drones.filter(d =>
                    Math.hypot((d.lat - st.lat) * 111320,
                        (d.lng - st.lng) * 111320 * Math.cos(st.lat * Math.PI / 180)) < 40)
                return (
                    <div className="absolute bottom-2 left-2 z-[600] w-[230px] rounded-lg border p-2.5 shadow-xl"
                        style={{ background: 'hsl(var(--app-surface))', borderColor: 'hsl(var(--app-border))' }}>
                        <div className="flex items-center gap-1.5">
                            <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: '#fbbf24' }} />
                            <span className="font-mono text-xs">{st.name}</span>
                            <button className="ml-auto text-xs opacity-60 hover:opacity-100"
                                onClick={() => setStationId(null)}>✕</button>
                        </div>
                        {here.length === 0 ? (
                            <p className="mt-2 text-[10px] font-mono"
                                style={{ color: 'hsl(var(--app-text-muted))' }}>
                                No drones at this station.
                            </p>
                        ) : (
                            <div className="mt-2 flex flex-col gap-1">
                                {here.map(d => (
                                    <button key={d.id}
                                        className="flex items-center gap-1.5 text-[10px] font-mono rounded px-1 py-0.5 hover:bg-zinc-500/10 text-left"
                                        onClick={() => setPinnedId(d.id)}>
                                        <span className="w-1.5 h-1.5 rounded-full"
                                            style={{ background: d.in_air ? '#fbbf24' : '#4ade80' }} />
                                        <span>{d.name}</span>
                                        <span className="ml-auto"
                                            style={{ color: d.battery < 25 ? '#f87171' : '#4ade80' }}>
                                            {Math.round(d.battery)}%
                                        </span>
                                        <span style={{ color: 'hsl(var(--app-text-muted))' }}>
                                            {d.order_no ?? (d.in_air ? 'flying' : 'idle')}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        )}
                        <p className="mt-1.5 text-[9px]" style={{ color: 'hsl(var(--app-text-muted))' }}>
                            LINKS: {here.length} connected - tap a drone for detail
                        </p>
                    </div>
                )
            })()}

            {selection && (
                <div className="absolute bottom-2 right-2 z-[500] px-2.5 py-1.5 rounded-md border text-[11px] font-mono"
                    style={{
                        background: 'hsl(var(--app-surface))',
                        borderColor: 'hsl(var(--app-border))',
                        color: 'hsl(var(--app-text))',
                    }}>
                    {selection.order_no}: {selection.pickup.name}
                    <span style={{ color: 'hsl(var(--app-text-muted))' }}> to </span>
                    {selection.dropoff.name}
                </div>
            )}
        </div>
    )
}
