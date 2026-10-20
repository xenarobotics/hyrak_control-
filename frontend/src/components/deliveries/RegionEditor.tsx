'use client'

// REGIONS editor - the enterprise-tier land-use control the route profiles
// read: draw a polygon (click vertices), pick its category (hostel, road,
// water...), name it, save. Edits feed map_features and reshape every
// route planned afterwards. ZONES (law) stay on the /admin page - this
// edits PREFERENCE, which is exactly the separation the tier model wants.

import { apiFetch } from '@/lib/api'
import { useCallback, useEffect, useState } from 'react'
import {
    MapContainer, TileLayer, Polygon, Polyline, CircleMarker, Tooltip, useMap, useMapEvents,
} from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { MAP_LAYERS } from '@/types/mission'
import { getServerUrl } from '@/lib/server-url'
import { liveAuthHeaders } from '@/lib/auth'
import { Plus, Undo2 } from 'lucide-react'
import { BTN, BTN_ACCENT, BTN_PRIMARY, FOCUS, INPUT, LABEL, PANEL } from '@/components/mission/ui'


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

const inputCls = `${INPUT} w-full`
const smallBtn = 'inline-flex items-center h-8 px-2 rounded-[6px] text-xs font-bold transition-colors duration-[120ms] ' + FOCUS

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
    const AUTH = liveAuthHeaders({ 'Content-Type': 'application/json' })

    const refresh = useCallback(async () => {
        try {
            const r = await apiFetch(api('/map-features'))
            setFeatures(((await r.json()).features ?? []))
        } catch { /* transient */ }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        refresh()
        apiFetch(api('/planner/meta')).then(r => r.json())
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
            const r = await apiFetch(api('/map-features'), {
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
        await apiFetch(api(`/map-features/${f.properties.id}`), {
            method: 'PATCH', headers: AUTH,
            body: JSON.stringify({ active: !f.properties.active }),
        }).catch(() => {})
        await refresh()
    }

    const remove = async (f: FeatureGJ) => {
        if (!window.confirm(`Delete "${f.properties.name}"?`)) return
        await apiFetch(api(`/map-features/${f.properties.id}`), {
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

            <div className={`${PANEL} absolute left-3 top-3 bottom-3 z-[1000] w-72 max-w-[calc(100%-24px)] flex flex-col overflow-hidden`}>
                <div className="flex items-center gap-2 px-4 pt-4 pb-3 border-b border-app-border">
                    <h3 className="text-[18px] leading-6 font-bold">Land-use regions</h3>
                    <span className="ml-auto inline-flex items-center h-6 px-2 rounded-full text-xs font-bold tabular-nums bg-app-surface-2 border border-app-border">
                        {features.length}
                    </span>
                </div>

                {!drawing ? (
                    <>
                        <div className="p-3 space-y-2">
                            <button onClick={() => setDrawing(true)}
                                className={`${BTN_ACCENT} w-full`}>
                                <Plus size={14} aria-hidden /> Draw new region
                            </button>
                            <input className={inputCls}
                                placeholder="Filter (hostel, road...)"
                                aria-label="Filter regions"
                                value={filter} onChange={e => setFilter(e.target.value)} />
                        </div>
                        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1.5">
                            {visible.map(f => (
                                <div key={f.properties.id}
                                    role="button" tabIndex={0}
                                    className={`border border-app-border rounded-[10px] px-3 py-2 cursor-pointer hover:border-app-border-strong hover:bg-app-surface-2 transition-colors duration-[120ms] ${FOCUS}`}
                                    onClick={() => setFocus(f)}
                                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFocus(f) } }}>
                                    <div className="flex items-center gap-2">
                                        <span className="w-2.5 h-2.5 rounded-sm shrink-0" aria-hidden
                                            style={{ background: CATEGORY_COLORS[f.properties.category] ?? '#a1a1aa' }} />
                                        <span className={'truncate text-sm font-semibold ' +
                                            (f.properties.active ? 'text-app-text' : 'line-through text-app-text-subtle')}>
                                            {f.properties.name}
                                        </span>
                                        <button className={`${smallBtn} ml-auto text-app-text-muted hover:text-app-text hover:bg-app-raised`}
                                            title={f.properties.active ? 'Turn this region off' : 'Turn this region on'}
                                            onClick={e => { e.stopPropagation(); void toggle(f) }}>
                                            {f.properties.active ? 'Off' : 'On'}
                                        </button>
                                        <button className={`${smallBtn} text-app-danger hover:bg-app-danger-soft`}
                                            title="Delete this region"
                                            onClick={e => { e.stopPropagation(); void remove(f) }}>
                                            Delete
                                        </button>
                                    </div>
                                    <p className="text-[13px] text-app-text-muted capitalize">
                                        {f.properties.category.replace(/_/g, ' ')}
                                    </p>
                                </div>
                            ))}
                        </div>
                        <p className="px-4 py-3 text-[13px] text-app-text-muted border-t border-app-border"
                            title="Bulk import: scripts/import_osm_features.py">
                            Regions shape route preference. Flight-law zones live in Admin.
                        </p>
                    </>
                ) : (
                    <div className="p-4 space-y-3 text-sm">
                        <p className="text-[13px] text-app-text-muted">
                            Click the map to add corners ({points.length} placed
                            {points.length < 3 ? `, need ${3 - points.length} more` : ''})
                        </p>
                        <label className="block space-y-1">
                            <span className={LABEL}>Category</span>
                        <select className={inputCls} value={category}
                            onChange={e => setCategory(e.target.value)}>
                            {categories.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        </label>
                        <label className="block space-y-1">
                            <span className={LABEL}>Name</span>
                        <input className={inputCls}
                            placeholder="e.g. Hostel Block K"
                            value={name} onChange={e => setName(e.target.value)} />
                        </label>
                        {error && <p className="text-[13px] text-app-danger" role="alert">{error}</p>}
                        <div className="flex gap-2">
                            <button onClick={() => void save()}
                                disabled={points.length < 3 || saving}
                                title={points.length < 3 ? 'Place at least 3 corners first' : undefined}
                                className={`${BTN_PRIMARY} flex-1`}>
                                {saving ? 'Saving...' : 'Save region'}
                            </button>
                            <button onClick={() => setPoints(p => p.slice(0, -1))}
                                disabled={points.length === 0}
                                title={points.length === 0 ? 'No corners to undo' : 'Remove the last corner'}
                                aria-label="Undo last corner"
                                className={BTN}>
                                <Undo2 size={14} aria-hidden />
                            </button>
                            <button onClick={reset} className={BTN}>
                                Cancel
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
