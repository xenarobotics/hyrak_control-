'use client'

// Zone editor for the ZONES tab. Draw a polygon by clicking vertices on the
// map, pick a class (green/orange/red), name it, save. Zones persist in
// Postgres and feed the backend zone engine that mission validation and
// flight enforcement run against. Import with next/dynamic({ ssr: false }).

import { useCallback, useEffect, useState } from 'react'
import {
    MapContainer, TileLayer, Polygon, Polyline, CircleMarker, Tooltip, useMap, useMapEvents,
} from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { MAP_LAYERS } from '@/types/mission'
import { getServerUrl } from '@/lib/server-url'
import { ZONE_COLORS, zoneRings, type ZoneClass, type ZoneFeature } from '@/components/admin/zones'

const TOKEN = process.env.NEXT_PUBLIC_SECRET_TOKEN || 'change_this_to_a_random_string'

const PANEL_STYLE: React.CSSProperties = {
    background: 'rgba(17, 19, 24, .94)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    borderColor: 'rgba(255, 255, 255, .08)',
}

function ClickCapture({ onClick }: { onClick: (lat: number, lng: number) => void }) {
    useMapEvents({ click: e => onClick(e.latlng.lat, e.latlng.lng) })
    return null
}

function FlyToZone({ zone }: { zone: ZoneFeature | null }) {
    const map = useMap()
    useEffect(() => {
        if (!zone) return
        const rings = zoneRings(zone)
        if (rings.length === 0) return
        map.flyToBounds(L.latLngBounds(rings.flat()), { padding: [60, 60], duration: 0.6 })
    }, [zone, map])
    return null
}

export default function ZoneEditor({
    zones,
    onChanged,
}: {
    zones: ZoneFeature[]
    onChanged: () => void
}) {
    const layer = MAP_LAYERS.find(l => l.key === 'satellite') ?? MAP_LAYERS[0]
    const [drawing, setDrawing] = useState(false)
    const [points, setPoints] = useState<[number, number][]>([])
    const [zoneClass, setZoneClass] = useState<ZoneClass>('red')
    const [name, setName] = useState('')
    const [ceiling, setCeiling] = useState('')
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [focusZone, setFocusZone] = useState<ZoneFeature | null>(null)

    const addPoint = useCallback((lat: number, lng: number) => {
        setPoints(p => [...p, [lat, lng]])
    }, [])

    const reset = () => {
        setDrawing(false)
        setPoints([])
        setName('')
        setCeiling('')
        setError(null)
    }

    const save = async () => {
        if (points.length < 3) return
        setSaving(true)
        setError(null)
        // GeoJSON ring: (lng, lat), closed
        const ring = [...points.map(([lat, lng]) => [lng, lat]), [points[0][1], points[0][0]]]
        try {
            const res = await fetch(`${getServerUrl()}/api/zones`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Auth-Token': TOKEN },
                body: JSON.stringify({
                    name: name || undefined,
                    zone_class: zoneClass,
                    geometry: { type: 'Polygon', coordinates: [ring] },
                    ceiling_m: ceiling !== '' ? Number(ceiling) : undefined,
                }),
            })
            if (!res.ok) {
                const d = await res.json().catch(() => ({}))
                throw new Error(d.detail ?? `HTTP ${res.status}`)
            }
            reset()
            onChanged()
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Save failed')
        } finally {
            setSaving(false)
        }
    }

    const remove = async (id: string) => {
        if (!window.confirm('Delete this zone?')) return
        try {
            await fetch(`${getServerUrl()}/api/zones/${id}`, {
                method: 'DELETE',
                headers: { 'X-Auth-Token': TOKEN },
            })
            onChanged()
        } catch { /* poll shows the truth */ }
    }

    return (
        <div className="absolute inset-0">
            <MapContainer
                center={[17.445, 78.349]}
                zoom={15}
                className="w-full h-full"
                zoomControl={false}
                attributionControl={false}
            >
                <TileLayer url={layer.url} maxNativeZoom={layer.maxNativeZoom} maxZoom={layer.maxZoom} />
                {drawing && <ClickCapture onClick={addPoint} />}
                <FlyToZone zone={focusZone} />

                {zones.filter(z => z.properties.active).map(z => (
                    <Polygon
                        key={z.properties.id}
                        positions={zoneRings(z)}
                        pathOptions={{
                            color: ZONE_COLORS[z.properties.zone_class],
                            weight: 1.5,
                            fillOpacity: 0.18,
                        }}
                    >
                        <Tooltip sticky>
                            {z.properties.name} — {z.properties.zone_class.toUpperCase()}
                        </Tooltip>
                    </Polygon>
                ))}

                {/* Draft polygon */}
                {points.length >= 3 && (
                    <Polygon
                        positions={[points]}
                        pathOptions={{
                            color: ZONE_COLORS[zoneClass], dashArray: '6 6',
                            weight: 2, fillOpacity: 0.1,
                        }}
                    />
                )}
                {points.length >= 2 && points.length < 3 && (
                    <Polyline
                        positions={points}
                        pathOptions={{ color: ZONE_COLORS[zoneClass], dashArray: '6 6', weight: 2 }}
                    />
                )}
                {points.map((p, i) => (
                    <CircleMarker
                        key={i}
                        center={p}
                        radius={4}
                        pathOptions={{ color: ZONE_COLORS[zoneClass], fillOpacity: 1 }}
                    />
                ))}
            </MapContainer>

            {/* Control panel */}
            <div
                className="absolute left-3 top-3 bottom-3 z-[1000] w-72 rounded-xl border flex flex-col overflow-hidden"
                style={PANEL_STYLE}
            >
                <div className="px-3 py-2.5 text-[10px] tracking-widest text-zinc-500 border-b border-zinc-800/80">
                    FLIGHT ZONES — {zones.length}
                </div>

                {!drawing ? (
                    <>
                        <div className="p-2">
                            <button
                                onClick={() => setDrawing(true)}
                                className="w-full py-2 rounded border border-cyan-700 text-xs text-cyan-400 hover:border-cyan-500"
                            >
                                + DRAW NEW ZONE
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-2 pt-0 space-y-2">
                            {zones.length === 0 && (
                                <div className="text-[10px] text-zinc-500 p-2">
                                    No zones yet. Draw your test field&apos;s green / orange / red
                                    areas — the backend enforces them on every connected drone.
                                </div>
                            )}
                            {zones.map(z => (
                                <div
                                    key={z.properties.id}
                                    className="border border-zinc-800 rounded p-2.5 text-xs cursor-pointer hover:border-zinc-600"
                                    onClick={() => setFocusZone(z)}
                                >
                                    <div className="flex items-center gap-2">
                                        <span
                                            className="w-2.5 h-2.5 rounded-sm shrink-0"
                                            style={{ background: ZONE_COLORS[z.properties.zone_class] }}
                                        />
                                        <span className="font-semibold text-zinc-100 truncate">
                                            {z.properties.name}
                                        </span>
                                        <button
                                            onClick={e => { e.stopPropagation(); void remove(z.properties.id) }}
                                            className="ml-auto text-[10px] text-zinc-600 hover:text-red-400"
                                        >
                                            DELETE
                                        </button>
                                    </div>
                                    <div className="mt-1 text-[9px] text-zinc-600">
                                        {z.properties.zone_class.toUpperCase()}
                                        {z.properties.ceiling_m != null &&
                                            ` · up to ${z.properties.ceiling_m} m`}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>
                ) : (
                    <div className="p-3 space-y-3 text-xs">
                        <div className="text-[10px] text-zinc-500">
                            Click the map to add vertices ({points.length} placed
                            {points.length < 3 ? `, need ${3 - points.length} more` : ''})
                        </div>

                        <div className="flex gap-1.5">
                            {(['green', 'orange', 'red'] as ZoneClass[]).map(c => (
                                <button
                                    key={c}
                                    onClick={() => setZoneClass(c)}
                                    className="flex-1 py-1.5 rounded border text-[10px] uppercase transition-colors"
                                    style={{
                                        borderColor: zoneClass === c ? ZONE_COLORS[c] : 'rgba(255,255,255,.15)',
                                        color: zoneClass === c ? ZONE_COLORS[c] : '#71717a',
                                        background: zoneClass === c ? `${ZONE_COLORS[c]}18` : 'transparent',
                                    }}
                                >
                                    {c}
                                </button>
                            ))}
                        </div>

                        <input
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder="zone name (optional)"
                            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
                        />
                        <input
                            value={ceiling}
                            onChange={e => setCeiling(e.target.value.replace(/[^0-9.]/g, ''))}
                            placeholder="ceiling m AGL (optional — blank = all altitudes)"
                            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
                        />

                        {error && <div className="text-[10px] text-red-400">{error}</div>}

                        <div className="flex gap-2">
                            <button
                                onClick={() => void save()}
                                disabled={points.length < 3 || saving}
                                className="flex-1 py-2 rounded border border-emerald-700 text-emerald-400 disabled:border-zinc-800 disabled:text-zinc-600 hover:border-emerald-500"
                            >
                                {saving ? 'SAVING…' : 'SAVE ZONE'}
                            </button>
                            <button
                                onClick={() => setPoints(p => p.slice(0, -1))}
                                disabled={points.length === 0}
                                className="px-3 py-2 rounded border border-zinc-700 text-zinc-400 disabled:text-zinc-700 hover:border-zinc-500"
                            >
                                UNDO
                            </button>
                            <button
                                onClick={reset}
                                className="px-3 py-2 rounded border border-zinc-700 text-zinc-400 hover:border-zinc-500"
                            >
                                CANCEL
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
