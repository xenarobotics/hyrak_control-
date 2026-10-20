'use client'

// The dispatch map - the operational picture in one frame: the pad/station
// network, every in-flight order's route (positioning leg amber, delivery
// leg cyan, selected order emphasized), zone + land-use overlays, and every
// live drone. Clicking a drone opens its status card (with the live camera
// when this session is streaming). Renders state only - never mutates it.

import { apiFetch } from '@/lib/api'
import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, Marker, Polyline, Polygon, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { getServerUrl } from '@/lib/server-url'
import { MAP_LAYERS } from '@/types/mission'
import { ZONE_COLORS, zoneRings, type ZoneFeature } from '@/components/admin/zones'
import Delivery3D, { warmCesium } from './Delivery3D'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUS, OVERLAY, PANEL, ovBtn } from '@/components/mission/ui'

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
// Marker HTML is drawn on map tiles, so it uses the always-dark overlay set
// (CSS variables, which the light-mode hex remap in globals.css cannot hit).

const OV = {
    text: 'var(--overlay-text)', muted: 'var(--overlay-muted)', scrim: 'var(--overlay-scrim)',
    border: 'var(--overlay-border)', ok: 'var(--overlay-ok)', danger: 'var(--overlay-danger)',
    warn: 'var(--overlay-warn)', accent: 'var(--overlay-accent)',
}
const MARKER_FONT = "var(--font-nunito),Nunito,system-ui,sans-serif"
const tint = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`

function labelChip(text: string, color: string) {
    return `<div style="position:absolute;top:16px;left:50%;transform:translateX(-50%);
        white-space:nowrap;font:700 12px/16px ${MARKER_FONT};color:${OV.text};
        background:${OV.scrim};padding:1px 6px;border-radius:6px;
        border:1px solid ${tint(color, 60)}">${text}</div>`
}

function padIcon(label: string, highlight: 'pickup' | 'dropoff' | null,
                 kind: 'pad' | 'station' = 'pad') {
    const color = highlight === 'pickup' ? OV.ok
        : highlight === 'dropoff' ? OV.danger
            : kind === 'station' ? OV.warn : OV.accent
    const tag = highlight === 'pickup' ? 'Pickup' : highlight === 'dropoff' ? 'Drop' : ''
    const shape = kind === 'station'
        ? `<div style="width:16px;height:16px;border-radius:4px;background:${color};
            display:flex;align-items:center;justify-content:center;
            font:800 12px/1 ${MARKER_FONT};color:#111;
            box-shadow:0 0 0 2px rgba(0,0,0,.45), 0 0 8px ${tint(color, 53)}">H</div>`
        : `<div style="width:14px;height:14px;border-radius:50%;
            background:${tint(color, 20)};border:2.5px solid ${color};box-sizing:border-box;
            box-shadow:0 0 0 2px rgba(0,0,0,.35)"></div>`
    return L.divIcon({
        className: '', iconSize: [16, 16], iconAnchor: [8, 8],
        html: `<div style="position:relative">
            ${shape}
            ${tag ? `<div style="position:absolute;top:-20px;left:50%;transform:translateX(-50%);
                white-space:nowrap;font:800 12px/16px ${MARKER_FONT};color:${color};
                background:${OV.scrim};padding:0 5px;border-radius:6px">${tag}</div>` : ''}
            ${labelChip(label, color)}
        </div>`,
    })
}

function endpointIcon(kind: 'takeoff' | 'land') {
    const color = kind === 'takeoff' ? OV.ok : OV.danger
    return L.divIcon({
        className: '', iconSize: [20, 20], iconAnchor: [10, 10],
        html: `<div style="width:20px;height:20px;border-radius:50%;
            background:${color};color:#111;display:flex;align-items:center;
            justify-content:center;font:800 12px/1 ${MARKER_FONT};
            box-shadow:0 0 0 2px rgba(0,0,0,.4), 0 0 8px ${tint(color, 67)}">
            ${kind === 'takeoff' ? '▲' : '▼'}</div>`,
    })
}

function droneIcon(d: MapDroneLive, focused: boolean) {
    const color = d.in_air ? OV.warn : OV.ok
    const batColor = d.battery < 25 ? OV.danger : d.battery < 40 ? OV.warn : OV.muted
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
                white-space:nowrap;font:700 12px/16px ${MARKER_FONT};color:${OV.text};
                font-variant-numeric:tabular-nums;
                background:${OV.scrim};padding:1px 6px 3px;border-radius:6px;
                border:1px solid ${focused ? color : OV.border}">
                ${d.name}${d.order_no ? ` <span style="color:${OV.accent}">${d.order_no}</span>` : ''}
                <div style="margin-top:2px;height:3px;border-radius:2px;background:${OV.border};overflow:hidden">
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
        apiFetch(`${getServerUrl()}/api/map-features`)
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
                const r = await apiFetch(`${getServerUrl()}/api/zones`)
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
    const batTone = drone.battery < 25 ? 'danger' : drone.battery < 40 ? 'warn' : 'ok'
    const batBg = { danger: 'bg-app-danger', warn: 'bg-app-warn', ok: 'bg-app-ok' }[batTone]
    const batText = { danger: 'text-app-danger', warn: 'text-app-warn', ok: 'text-app-ok' }[batTone]
    return (
        <div className={`${PANEL} absolute bottom-2 left-2 z-[600] w-[260px] max-w-[calc(100%-16px)] overflow-hidden`}>
            {showVideo ? (
                <div className="relative">
                    <video ref={videoRef} autoPlay muted playsInline
                        className="w-full aspect-video object-cover bg-[#1A2129]" />
                    <span className={`${OVERLAY} absolute top-1.5 left-1.5 flex items-center gap-1.5 h-6 px-2 rounded-full text-xs font-bold`}>
                        <span className="w-1.5 h-1.5 rounded-full animate-pulse motion-reduce:animate-none"
                            style={{ background: 'var(--overlay-danger)' }} aria-hidden /> Live
                    </span>
                </div>
            ) : (
                <div className="w-full aspect-video flex items-center justify-center bg-app-surface-2">
                    <p className="text-[13px] text-app-text-muted">
                        {drone.is_session ? 'Camera not streaming' : 'No camera on this link yet'}
                    </p>
                </div>
            )}
            <div className="p-3">
                <div className="flex items-center gap-2">
                    <span className={cn('w-2 h-2 rounded-full shrink-0', drone.in_air ? 'bg-app-warn' : 'bg-app-ok')} aria-hidden />
                    <span className="text-base font-bold truncate">{drone.name}</span>
                    <button className={cn('ml-auto -mr-1 w-8 h-8 inline-flex items-center justify-center rounded-[6px] text-app-text-muted hover:text-app-text hover:bg-app-surface-2 transition-colors duration-[120ms]', FOCUS)}
                        onClick={onClose} aria-label="Close drone card" title="Close">
                        <X size={16} />
                    </button>
                </div>
                {/* Battery bar with the 20% reserve line - below it the drone
                    must be heading home, not taking work. */}
                <div className="mt-2 relative h-1.5 rounded-full overflow-hidden bg-app-border"
                    title="Battery, with the 20% reserve line">
                    <div className={cn('h-full rounded-full', batBg)}
                        style={{ width: `${Math.min(100, Math.max(0, drone.battery))}%` }} />
                    <div className="absolute top-0 h-full w-px bg-app-danger" style={{ left: '20%' }} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-app-text-muted tabular-nums">
                    <span className={cn('font-bold', batText)}>{Math.round(drone.battery)}%</span>
                    <span>{drone.mode}</span>
                    <span>{drone.in_air ? 'In air' : 'On ground'}</span>
                    {drone.order_no && <span className="font-semibold text-app-accent">{drone.order_no}</span>}
                </div>
            </div>
        </div>
    )
}

// ── Shared control styles ────────────────────────────────────────────────

// Map buttons sit on the tiles, grouped in one overlay toolbar (follows the
// theme), accent when on.
const mapBtn = (on: boolean) => ovBtn(on)

/** The one toolbar surface on the map, top-right. */
const MAP_BAR =
    `${OVERLAY} absolute top-2 right-2 z-[500] flex flex-nowrap items-center gap-0.5 p-1 rounded-[10px] ` +
    'shadow-[var(--app-shadow)] max-w-[calc(100%-16px)] overflow-x-auto [scrollbar-width:none]'

const BarDivider = () => <span className="w-px h-5 mx-0.5 bg-overlay-border" aria-hidden />

function ModeButtons({ mode, setMode }: {
    mode: '2d' | '3d'; setMode: (m: '2d' | '3d') => void
}) {
    return (
        <>
            {(['2d', '3d'] as const).map(m => (
                <button key={m} onClick={() => setMode(m)}
                    aria-pressed={mode === m}
                    className={mapBtn(mode === m)}>
                    {m === '2d' ? '2D' : '3D'}
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
            <div className="relative h-full w-full rounded-[10px] overflow-hidden border border-app-border bg-app-surface-2">
                <Delivery3D pads={pads} selection={selection} drones={drones}
                    showAirspace={showAirspace} />
                <div className={MAP_BAR} role="toolbar" aria-label="Map">
                    <button onClick={() => setShowAirspace(v => !v)}
                        title="Show restricted airspace as 3D volumes (zone floor to ceiling)"
                        aria-pressed={showAirspace}
                        className={mapBtn(showAirspace)}>
                        Airspace
                    </button>
                    <BarDivider />
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
        <div className="relative h-full w-full rounded-[10px] overflow-hidden border border-app-border">
            <MapContainer center={center} zoom={15} className="h-full w-full"
                style={{ background: 'hsl(var(--app-surface-2))' }}
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

            <div className={MAP_BAR} role="toolbar" aria-label="Map">
                {(['nav', 'street', 'satellite'] as const).map(k => (
                    <button key={k} onClick={() => setLayerKey(k)}
                        aria-pressed={layerKey === k}
                        className={mapBtn(layerKey === k)}>
                        {k === 'nav' ? 'Nav' : k === 'street' ? 'Street' : 'Satellite'}
                    </button>
                ))}
                <button onClick={() => setShowLandUse(v => !v)}
                    title="Show the land-use data the route profiles read"
                    aria-pressed={showLandUse}
                    className={mapBtn(showLandUse)}>
                    Land use
                </button>
                <BarDivider />
                <ModeButtons mode={mode} setMode={setMode} />
            </div>

            {/* Legend - the map must explain itself. Bottom-left, clear of the
                toolbar; the drone and station cards cover it while open. */}
            <div className={`${OVERLAY} absolute bottom-2 left-2 z-[500] px-3 py-2 rounded-[10px] flex flex-col gap-1 text-xs font-semibold shadow-[var(--app-shadow)]`}>
                {([
                    [LEG_COLOR.delivery, 'Delivery leg', false],
                    [LEG_COLOR.pickup, 'Pickup leg', true],
                ] as const).map(([c, t, dash]) => (
                    <span key={t} className="flex items-center gap-2">
                        <span className="inline-block w-5 h-0" aria-hidden
                            style={{ borderTop: `2px ${dash ? 'dashed' : 'solid'} ${c}` }} />
                        {t}
                    </span>
                ))}
                <span className="flex items-center gap-2">
                    <span className="inline-block w-2.5 h-2.5 rounded-[3px]" aria-hidden
                        style={{ background: 'var(--overlay-warn)' }} /> Station
                    <span className="inline-block w-2.5 h-2.5 rounded-full ml-1" aria-hidden
                        style={{ border: '2px solid var(--overlay-accent)' }} /> Pad
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
                    <div className={`${PANEL} absolute bottom-2 left-2 z-[600] w-[260px] max-w-[calc(100%-16px)] p-3`}>
                        <div className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-[3px] shrink-0 bg-app-warn" aria-hidden />
                            <span className="text-base font-bold truncate">{st.name}</span>
                            <button className={cn('ml-auto -mr-1 w-8 h-8 inline-flex items-center justify-center rounded-[6px] text-app-text-muted hover:text-app-text hover:bg-app-surface-2 transition-colors duration-[120ms]', FOCUS)}
                                onClick={() => setStationId(null)} aria-label="Close station card" title="Close">
                                <X size={16} />
                            </button>
                        </div>
                        {here.length === 0 ? (
                            <p className="mt-2 text-[13px] text-app-text-muted">
                                No drones at this station.
                            </p>
                        ) : (
                            <div className="mt-2 flex flex-col gap-1">
                                {here.map(d => (
                                    <button key={d.id}
                                        className={cn('flex items-center gap-2 h-8 text-[13px] rounded-[6px] px-2 hover:bg-app-surface-2 text-left tabular-nums transition-colors duration-[120ms]', FOCUS)}
                                        onClick={() => setPinnedId(d.id)}>
                                        <span className={cn('w-2 h-2 rounded-full shrink-0', d.in_air ? 'bg-app-warn' : 'bg-app-ok')} aria-hidden />
                                        <span className="font-semibold truncate">{d.name}</span>
                                        <span className={cn('ml-auto font-bold', d.battery < 25 ? 'text-app-danger' : 'text-app-ok')}>
                                            {Math.round(d.battery)}%
                                        </span>
                                        <span className="text-app-text-muted">
                                            {d.order_no ?? (d.in_air ? 'flying' : 'idle')}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        )}
                        <p className="mt-2 text-[13px] text-app-text-muted">
                            {here.length} connected. Tap a drone for detail.
                        </p>
                    </div>
                )
            })()}

            {selection && (
                <div className={`${OVERLAY} absolute bottom-2 right-2 z-[500] max-w-[calc(100%-16px)] px-3 py-1.5 rounded-[10px] text-[13px] font-semibold truncate`}>
                    <span className="font-bold">{selection.order_no}</span>: {selection.pickup.name}
                    <span className="text-overlay-muted font-normal"> to </span>
                    {selection.dropoff.name}
                </div>
            )}
        </div>
    )
}
