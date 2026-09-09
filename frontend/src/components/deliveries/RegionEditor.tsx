'use client'

// REGIONS editor - the enterprise-tier land-use control the route profiles
// read: draw a polygon (click vertices), pick its category (hostel, road,
// water...), name it, save. Edits feed map_features and reshape every
// route planned afterwards. ZONES (law) stay on the /admin page - this
// edits PREFERENCE, which is exactly the separation the tier model wants.

import { useCallback, useEffect, useState } from 'react'
import {
    MapContainer, TileLayer, Polygon, Polyline, CircleMarker, Tooltip, useMap, useMapEvents,
} from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { MAP_LAYERS } from '@/types/mission'
import { getServerUrl } from '@/lib/server-url'

const TOKEN = process.env.NEXT_PUBLIC_SECRET_TOKEN || ''

export const CATEGORY_COLORS: Record<string, string> = {
    road: '#94a3b8', water: '#38bdf8', forest: '#22c55e', open_field: '#a3e635',
    farmland: '#eab308', residential: '#f472b6', hostel: '#ef4444',
    school: '#fb923c', campus: '#06b6d4', industrial: '#a855f7',
}

type FeatureGJ = {
    geometry: { type: string; coordinates: unknown }
    properties: { id: string; name: string; category: string; active: boolean }
}

function featureRings(f: FeatureGJ): [number, number][][] {
    const swap = (ring: number[][]) => ring.map(([lng, lat]) => [lat, lng] as [number, number])
    const g = f.geometry
    if (g.type === 'Polygon') return (g.coordinates as number[][][]).map(swap)
    if (g.type === 'MultiPolygon') {
        return (g.coordinates as number[][][][]).flatMap(poly => poly.map(swap))
    }
    return []
}

function ClickCapture({ onClick }: { onClick: (lat: number, lng: number) => void }) {
    useMapEvents({ click: e => onClick(e.latlng.lat, e.latlng.lng) })
    return null
}

function FlyTo({ feature }: { feature: FeatureGJ | null }) {
    const map = useMap()
    useEffect(() => {
        if (!feature) return
        const rings = featureRings(feature)
        if (rings.length === 0) return
        map.flyToBounds(L.latLngBounds(rings.flat()), { padding: [60, 60], duration: 0.6 })
    }, [feature, map])
    return null
}

const panelStyle: React.CSSProperties = {
    background: 'hsl(var(--app-surface))',
    borderColor: 'hsl(var(--app-border))',
}
const inputCls = 'w-full rounded-md border px-2 py-1.5 text-xs bg-transparent ' +
    'focus:outline-none focus:ring-1 focus:ring-cyan-500'
const inputStyle = {
    borderColor: 'hsl(var(--app-border))',
    color: 'hsl(var(--app-text))',
    background: 'hsl(var(--app-bg))',
}

export default function RegionEditor() {
    const layer = MAP_LAYERS.find(l => l.key === 'nav') ?? MAP_LAYERS[0]
    const [features, setFeatures] = useState<FeatureGJ[]>([])
    const [categories, setCategories] = useState<string[]>(Object.keys(CATEGORY_COLORS))
    const [drawing, setDrawing] = useState(false)
    const [points, setPoints] = useState<[number, number][]>([])
    const [category, setCategory] = useState('hostel')
    const [name, setName] = useState('')
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')
    const [focus, setFocus] = useState<FeatureGJ | null>(null)
    const [filter, setFilter] = useState('')

    const api = (p: string) => `${getServerUrl()}/api${p}`
    const AUTH = { 'X-Auth-Token': TOKEN, 'Content-Type': 'application/json' }

    const refresh = useCallback(async () => {
        try {
            const r = await fetch(api('/map-features'))
            setFeatures(((await r.json()).features ?? []))
        } catch { /* transient */ }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        refresh()
        fetch(api('/planner/meta')).then(r => r.json())
            .then(j => { if (j.categories?.length) setCategories(j.categories) })
            .catch(() => { /* fall back to the static list */ })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refresh])

    const addPoint = useCallback((lat: number, lng: number) => {
        setPoints(p => [...p, [lat, lng]])
    }, [])

    const reset = () => { setDrawing(false); setPoints([]); setName(''); setError('') }

    const save = async () => {
        if (points.length < 3) return
        setSaving(true); setError('')
        const ring = [...points.map(([lat, lng]) => [lng, lat]), [points[0][1], points[0][0]]]
        try {
            const r = await fetch(api('/map-features'), {
                method: 'POST', headers: AUTH,
                body: JSON.stringify({
                    name: name || `${category} region`,
                    category,
                    geometry: { type: 'Polygon', coordinates: [ring] },
                }),
            })
            if (!r.ok) throw new Error((await r.json()).detail ?? 'Save failed')
            reset(); await refresh()
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Save failed')
        } finally { setSaving(false) }
    }

    const toggle = async (f: FeatureGJ) => {
        await fetch(api(`/map-features/${f.properties.id}`), {
            method: 'PATCH', headers: AUTH,
            body: JSON.stringify({ active: !f.properties.active }),
        }).catch(() => {})
        await refresh()
    }

    const remove = async (f: FeatureGJ) => {
        if (!window.confirm(`Delete "${f.properties.name}"?`)) return
        await fetch(api(`/map-features/${f.properties.id}`), {
            method: 'DELETE', headers: AUTH,
        }).catch(() => {})
        await refresh()
    }

    const visible = features.filter(f =>
        !filter || f.properties.name.toLowerCase().includes(filter.toLowerCase())
        || f.properties.category.includes(filter.toLowerCase()))

    return (
        <div className="relative h-full min-h-[520px] rounded-lg overflow-hidden border"
            style={{ borderColor: 'hsl(var(--app-border))' }}>
            <MapContainer center={[17.598, 78.125]} zoom={15} className="w-full h-full"
                zoomControl={false} attributionControl={false}>
                <TileLayer url={layer.url} maxNativeZoom={layer.maxNativeZoom} maxZoom={layer.maxZoom} />
                {drawing && <ClickCapture onClick={addPoint} />}
                <FlyTo feature={focus} />

                {features.filter(f => f.properties.active).map(f => {
                    const color = CATEGORY_COLORS[f.properties.category] ?? '#a1a1aa'
                    return featureRings(f).map((ring, i) => (
                        <Polygon key={`${f.properties.id}-${i}`} positions={ring}
                            pathOptions={{ color, weight: 1, fillOpacity: 0.18 }}>
                            <Tooltip sticky>
                                {f.properties.name} - {f.properties.category}
                            </Tooltip>
                        </Polygon>
                    ))
                })}

                {points.length >= 3 && (
                    <Polygon positions={[points]}
                        pathOptions={{
                            color: CATEGORY_COLORS[category] ?? '#22d3ee',
                            dashArray: '6 6', weight: 2, fillOpacity: 0.1,
                        }} />
                )}
                {points.length >= 2 && points.length < 3 && (
                    <Polyline positions={points}
                        pathOptions={{
                            color: CATEGORY_COLORS[category] ?? '#22d3ee',
                            dashArray: '6 6', weight: 2,
                        }} />
                )}
                {points.map((p, i) => (
                    <CircleMarker key={i} center={p} radius={4}
                        pathOptions={{ color: CATEGORY_COLORS[category] ?? '#22d3ee', fillOpacity: 1 }} />
                ))}
            </MapContainer>

            <div className="absolute left-3 top-3 bottom-3 z-[1000] w-72 rounded-xl border flex flex-col overflow-hidden"
                style={panelStyle}>
                <div className="px-3 py-2.5 text-[10px] font-mono tracking-widest border-b"
                    style={{ color: 'hsl(var(--app-text-muted))', borderColor: 'hsl(var(--app-border))' }}>
                    LAND-USE REGIONS - {features.length}
                </div>

                {!drawing ? (
                    <>
                        <div className="p-2 space-y-2">
                            <button onClick={() => setDrawing(true)}
                                className="w-full py-2 rounded-md border text-xs font-mono text-cyan-500 hover:bg-cyan-500/10"
                                style={{ borderColor: '#06b6d455' }}>
                                + DRAW NEW REGION
                            </button>
                            <input className={inputCls} style={inputStyle}
                                placeholder="filter (hostel, road...)"
                                value={filter} onChange={e => setFilter(e.target.value)} />
                        </div>
                        <div className="flex-1 overflow-y-auto p-2 pt-0 space-y-1.5">
                            {visible.map(f => (
                                <div key={f.properties.id}
                                    className="border rounded-md p-2 text-xs cursor-pointer hover:border-zinc-500"
                                    style={{ borderColor: 'hsl(var(--app-border))' }}
                                    onClick={() => setFocus(f)}>
                                    <div className="flex items-center gap-2">
                                        <span className="w-2.5 h-2.5 rounded-sm shrink-0"
                                            style={{ background: CATEGORY_COLORS[f.properties.category] ?? '#a1a1aa' }} />
                                        <span className={'truncate font-mono text-[11px] ' +
                                            (f.properties.active ? '' : 'line-through opacity-50')}>
                                            {f.properties.name}
                                        </span>
                                        <button className="ml-auto text-[9px] font-mono opacity-60 hover:opacity-100"
                                            onClick={e => { e.stopPropagation(); void toggle(f) }}>
                                            {f.properties.active ? 'OFF' : 'ON'}
                                        </button>
                                        <button className="text-[9px] font-mono text-red-400 opacity-60 hover:opacity-100"
                                            onClick={e => { e.stopPropagation(); void remove(f) }}>
                                            DEL
                                        </button>
                                    </div>
                                    <p className="mt-0.5 text-[9px] font-mono"
                                        style={{ color: 'hsl(var(--app-text-muted))' }}>
                                        {f.properties.category}
                                    </p>
                                </div>
                            ))}
                        </div>
                        <p className="p-2 text-[9px] font-mono border-t"
                            style={{ color: 'hsl(var(--app-text-muted))', borderColor: 'hsl(var(--app-border))' }}>
                            Regions shape route PREFERENCE. Flight-law ZONES are
                            managed on /admin. Bulk import: scripts/import_osm_features.py
                        </p>
                    </>
                ) : (
                    <div className="p-3 space-y-3 text-xs">
                        <p className="text-[10px] font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>
                            Click the map to add vertices ({points.length} placed
                            {points.length < 3 ? `, need ${3 - points.length} more` : ''})
                        </p>
                        <select className={inputCls} style={inputStyle} value={category}
                            onChange={e => setCategory(e.target.value)}>
                            {categories.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <input className={inputCls} style={inputStyle}
                            placeholder="region name (e.g. Hostel Block K)"
                            value={name} onChange={e => setName(e.target.value)} />
                        {error && <p className="text-[10px] text-red-400">{error}</p>}
                        <div className="flex gap-2">
                            <button onClick={() => void save()}
                                disabled={points.length < 3 || saving}
                                className="flex-1 py-2 rounded-md border font-mono text-emerald-500 disabled:opacity-40 hover:bg-emerald-500/10"
                                style={{ borderColor: '#10b98155' }}>
                                {saving ? 'SAVING...' : 'SAVE REGION'}
                            </button>
                            <button onClick={() => setPoints(p => p.slice(0, -1))}
                                disabled={points.length === 0}
                                className="px-3 py-2 rounded-md border font-mono disabled:opacity-40"
                                style={{ borderColor: 'hsl(var(--app-border))' }}>
                                UNDO
                            </button>
                            <button onClick={reset}
                                className="px-3 py-2 rounded-md border font-mono"
                                style={{ borderColor: 'hsl(var(--app-border))' }}>
                                CANCEL
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
