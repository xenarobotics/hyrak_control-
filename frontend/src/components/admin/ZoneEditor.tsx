'use client'

// Zone editor for the ZONES tab. Draw a polygon by clicking vertices on the
// map, pick a class (green/orange/red), name it, save. Zones persist in
// Postgres and feed the backend zone engine that mission validation and
// flight enforcement run against. Import with next/dynamic({ ssr: false }).
//
// Zones come in layers (docs/ACCESS_MODEL.md section 3). Every active zone
// applies to every drone; the layer only decides who may edit it:
// regulatory (founders, anywhere), area (airspace managers and workspace
// managers, inside their area) and site (workspace owners/admins, inside
// the operating area). The caller's editable area is outlined while
// drawing, and the server's refusal (403 not allowed, 409 outside the area)
// is shown as it said it.

import { useCallback, useEffect, useState } from 'react'
import {
    MapContainer, TileLayer, Polygon, Polyline, CircleMarker, Tooltip, useMap, useMapEvents,
} from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { MAP_LAYERS } from '@/types/mission'
import { useAccess } from '@/hooks/useAccess'
import {
    LAYER_LABELS, ZONE_LAYER_PERM, editableArea, hasPerm, platformOf, type GeoPolygon, type ZoneLayer,
} from '@/lib/access'
import { createZone, deleteZone, updateZone, type ApiResult } from '@/lib/workspaces'
import {
    ZONE_COLORS, geoRings, polygonFromPoints, zoneRings, type ZoneClass, type ZoneFeature,
} from '@/components/admin/zones'

const LAYERS: ZoneLayer[] = ['regulatory', 'area', 'site']
const LAYER_WEIGHT: Record<ZoneLayer, number> = { regulatory: 2, area: 1.5, site: 1 }

type Failure = { title: string; text: string }

/** A refusal worded by the server, headed by what kind of refusal it was. */
function failure(r: ApiResult<unknown>, action: string): Failure | null {
    if (r.ok) return null
    const title = r.status === 403 ? 'NOT ALLOWED'
        : r.status === 409 ? 'REJECTED - OUTSIDE YOUR AREA OR A RULE CONFLICT'
        : `${action} FAILED`
    return { title, text: r.error }
}

function FailureBox({ f, onClose }: { f: Failure | null; onClose?: () => void }) {
    if (!f) return null
    return (
        <div role="alert" className="border border-red-800/70 bg-red-500/5 rounded p-2 space-y-1">
            <div className="flex items-center gap-2 text-[9px] tracking-widest text-red-400">
                {f.title}
                {onClose && (
                    <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200" aria-label="Dismiss">x</button>
                )}
            </div>
            <div className="text-[10px] text-red-200/90 leading-relaxed">{f.text}</div>
        </div>
    )
}

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

// Fly to the caller's editable area when drawing starts or the target changes.
function FlyToArea({ area, k }: { area: GeoPolygon | null; k: string }) {
    const map = useMap()
    useEffect(() => {
        const rings = geoRings(area)
        if (!k || rings.length === 0) return
        map.flyToBounds(L.latLngBounds(rings.flat()), { padding: [60, 60], duration: 0.6 })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [k, map])
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
    const tiles = MAP_LAYERS.find(l => l.key === 'satellite') ?? MAP_LAYERS[0]
    const { isFounder, workspaces, memberships } = useAccess()
    const [drawing, setDrawing] = useState(false)
    const [points, setPoints] = useState<[number, number][]>([])
    const [zoneClass, setZoneClass] = useState<ZoneClass>('red')
    const [name, setName] = useState('')
    const [ceiling, setCeiling] = useState('')
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [focusZone, setFocusZone] = useState<ZoneFeature | null>(null)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [editName, setEditName] = useState('')
    const [editClass, setEditClass] = useState<ZoneClass>('red')
    const [editCeiling, setEditCeiling] = useState('')
    const [editActive, setEditActive] = useState(true)
    const [pickedLayer, setPickedLayer] = useState<ZoneLayer | null>(null)
    const [pickedWs, setPickedWs] = useState('')
    const [saveFailure, setSaveFailure] = useState<Failure | null>(null)
    const [listFailure, setListFailure] = useState<Failure | null>(null)

    // Which layers this person may draw on, and on which workspaces. An older
    // server without workspaces leaves founders (compat admin) with the
    // regulatory layer only, sent without a workspace.
    const platform = platformOf(workspaces)
    const workspacesFor = (l: ZoneLayer) => l === 'regulatory'
        ? (platform ? [platform] : [])
        : workspaces.filter(w => isFounder || hasPerm(w, ZONE_LAYER_PERM[l]))
    const layerOptions = LAYERS.filter(l => l === 'regulatory' ? isFounder : workspacesFor(l).length > 0)
    const drawLayer = pickedLayer && layerOptions.includes(pickedLayer) ? pickedLayer : layerOptions[0] ?? null
    const wsOptions = drawLayer ? workspacesFor(drawLayer) : []
    const drawWs = wsOptions.find(w => w.id === pickedWs) ?? wsOptions[0] ?? null
    const area = drawLayer ? editableArea(drawWs, drawLayer, memberships, workspaces) : null
    const wsName = (id: string | null | undefined) => workspaces.find(w => w.id === id)?.name

    const canEdit = (z: ZoneFeature) => {
        if (isFounder) return true
        const l = z.properties.layer ?? 'regulatory'
        if (l === 'regulatory') return false
        // Airspace managers edit area zones on any workspace, inside their area.
        if (l === 'area' && memberships.some(m => m.role === 'airspace')) return true
        return workspaces.some(w => w.id === z.properties.workspace_id && hasPerm(w, ZONE_LAYER_PERM[l]))
    }

    const startEdit = (z: ZoneFeature) => {
        setEditingId(z.properties.id)
        setEditName(z.properties.name)
        setEditClass(z.properties.zone_class)
        setEditCeiling(z.properties.ceiling_m != null ? String(z.properties.ceiling_m) : '')
        setEditActive(z.properties.active)
    }

    const saveEdit = async () => {
        if (!editingId) return
        setListFailure(null)
        const r = await updateZone(editingId, {
            name: editName,
            zone_class: editClass,
            ceiling_m: editCeiling !== '' ? Number(editCeiling) : null,
            active: editActive,
        })
        if (!r.ok) { setListFailure(failure(r, 'SAVE')); return }
        setEditingId(null)
        onChanged()
    }

    const addPoint = useCallback((lat: number, lng: number) => {
        setPoints(p => [...p, [lat, lng]])
    }, [])

    const reset = () => {
        setDrawing(false)
        setPoints([])
        setName('')
        setCeiling('')
        setError(null)
        setSaveFailure(null)
    }

    const save = async () => {
        if (points.length < 3) return
        setSaving(true)
        setError(null)
        setSaveFailure(null)
        const r = await createZone({
            name: name || undefined,
            zone_class: zoneClass,
            geometry: polygonFromPoints(points),
            ceiling_m: ceiling !== '' ? Number(ceiling) : undefined,
            layer: drawLayer ?? undefined,
            workspace_id: drawWs?.id,
        })
        setSaving(false)
        if (!r.ok) { setSaveFailure(failure(r, 'SAVE')); return }
        reset()
        onChanged()
    }

    const remove = async (z: ZoneFeature) => {
        if (!window.confirm(`Delete the zone "${z.properties.name}"?`)) return
        setListFailure(null)
        const r = await deleteZone(z.properties.id)
        if (!r.ok) { setListFailure(failure(r, 'DELETE')); return }
        onChanged()
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
                <TileLayer url={tiles.url} maxNativeZoom={tiles.maxNativeZoom} maxZoom={tiles.maxZoom} />
                {drawing && <ClickCapture onClick={addPoint} />}
                <FlyToZone zone={focusZone} />
                <FlyToArea area={area} k={drawing ? `${drawLayer}-${drawWs?.id ?? ''}` : ''} />

                {/* Where this person may draw the selected layer */}
                {drawing && area && (
                    <Polygon positions={geoRings(area)} interactive={false}
                        pathOptions={{ color: '#22d3ee', weight: 2, dashArray: '4 6', fillOpacity: 0.04 }} />
                )}

                {zones.filter(z => z.properties.active).map(z => (
                    <Polygon
                        key={z.properties.id}
                        positions={zoneRings(z)}
                        pathOptions={{
                            color: ZONE_COLORS[z.properties.zone_class],
                            weight: LAYER_WEIGHT[z.properties.layer ?? 'regulatory'],
                            fillOpacity: 0.18,
                        }}
                    >
                        <Tooltip sticky>
                            {z.properties.name} - {z.properties.zone_class.toUpperCase()}
                            {z.properties.layer && ` - ${LAYER_LABELS[z.properties.layer].toUpperCase()}`}
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
                    FLIGHT ZONES - {zones.length}
                </div>

                {!drawing ? (
                    <>
                        <div className="p-2 space-y-2">
                            {layerOptions.length > 0 ? (
                                <button
                                    onClick={() => setDrawing(true)}
                                    className="w-full py-2 rounded border border-cyan-700 text-xs text-cyan-400 hover:border-cyan-500"
                                >
                                    + DRAW NEW ZONE
                                </button>
                            ) : (
                                <div className="text-[10px] text-zinc-500">
                                    You can see every zone, but none of your roles edits zones.
                                </div>
                            )}
                            <FailureBox f={listFailure} onClose={() => setListFailure(null)} />
                        </div>
                        <div className="flex-1 overflow-y-auto p-2 pt-0 space-y-2">
                            {zones.length === 0 && (
                                <div className="text-[10px] text-zinc-500 p-2">
                                    No zones yet. Draw your test field&apos;s green / orange / red
                                    areas - the backend enforces them on every connected drone.
                                </div>
                            )}
                            {zones.map(z => (
                                <div
                                    key={z.properties.id}
                                    className="border border-zinc-800 rounded p-2.5 text-xs cursor-pointer hover:border-zinc-600"
                                    onClick={() => setFocusZone(z)}
                                >
                                    {editingId === z.properties.id ? (
                                        <div className="space-y-2" onClick={e => e.stopPropagation()}>
                                            <input
                                                value={editName}
                                                onChange={e => setEditName(e.target.value)}
                                                className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 outline-none"
                                            />
                                            <div className="flex gap-1.5">
                                                {(['green', 'orange', 'red'] as ZoneClass[]).map(c => (
                                                    <button
                                                        key={c}
                                                        onClick={() => setEditClass(c)}
                                                        className="flex-1 py-1 rounded border text-[9px] uppercase"
                                                        style={{
                                                            borderColor: editClass === c ? ZONE_COLORS[c] : 'rgba(255,255,255,.15)',
                                                            color: editClass === c ? ZONE_COLORS[c] : '#71717a',
                                                        }}
                                                    >
                                                        {c}
                                                    </button>
                                                ))}
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <input
                                                    value={editCeiling}
                                                    onChange={e => setEditCeiling(e.target.value.replace(/[^0-9.]/g, ''))}
                                                    placeholder="ceiling m"
                                                    className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-[10px] text-zinc-200 outline-none placeholder:text-zinc-600"
                                                />
                                                <label className="flex items-center gap-1 text-[9px] text-zinc-400">
                                                    <input
                                                        type="checkbox"
                                                        checked={editActive}
                                                        onChange={e => setEditActive(e.target.checked)}
                                                    />
                                                    ACTIVE
                                                </label>
                                            </div>
                                            <div className="flex gap-2">
                                                <button onClick={() => void saveEdit()}
                                                    className="flex-1 py-1 rounded border border-emerald-700 text-[10px] text-emerald-400 hover:border-emerald-500">
                                                    SAVE
                                                </button>
                                                <button onClick={() => setEditingId(null)}
                                                    className="px-3 py-1 rounded border border-zinc-700 text-[10px] text-zinc-400 hover:border-zinc-500">
                                                    CANCEL
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <div className="flex items-center gap-2">
                                                <span
                                                    className="w-2.5 h-2.5 rounded-sm shrink-0"
                                                    style={{ background: ZONE_COLORS[z.properties.zone_class] }}
                                                />
                                                <span className={
                                                    'font-semibold truncate ' +
                                                    (z.properties.active ? 'text-zinc-100' : 'text-zinc-600 line-through')
                                                }>
                                                    {z.properties.name}
                                                </span>
                                                {canEdit(z) && (
                                                    <>
                                                        <button
                                                            onClick={e => { e.stopPropagation(); startEdit(z) }}
                                                            className="ml-auto text-[10px] text-zinc-600 hover:text-cyan-400"
                                                        >
                                                            EDIT
                                                        </button>
                                                        <button
                                                            onClick={e => { e.stopPropagation(); void remove(z) }}
                                                            className="text-[10px] text-zinc-600 hover:text-red-400"
                                                        >
                                                            DELETE
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                            <div className="mt-1 text-[9px] text-zinc-600">
                                                {z.properties.zone_class.toUpperCase()}
                                                {z.properties.layer && ` · ${LAYER_LABELS[z.properties.layer].toUpperCase()}`}
                                                {wsName(z.properties.workspace_id) && z.properties.layer !== 'regulatory' &&
                                                    ` · ${wsName(z.properties.workspace_id)}`}
                                                {z.properties.ceiling_m != null &&
                                                    ` · up to ${z.properties.ceiling_m} m`}
                                                {!z.properties.active && ' · INACTIVE'}
                                            </div>
                                        </>
                                    )}
                                </div>
                            ))}
                        </div>
                    </>
                ) : (
                    <div className="p-3 space-y-3 text-xs overflow-y-auto">
                        <div className="space-y-1">
                            <div className="text-[9px] tracking-widest text-zinc-500">LAYER</div>
                            <div className="flex gap-1.5">
                                {layerOptions.map(l => (
                                    <button
                                        key={l}
                                        onClick={() => { setPickedLayer(l); setSaveFailure(null) }}
                                        aria-pressed={drawLayer === l}
                                        className={'flex-1 py-1.5 rounded border text-[10px] uppercase transition-colors ' +
                                            (drawLayer === l
                                                ? 'border-cyan-500 text-cyan-400 bg-cyan-500/10'
                                                : 'border-zinc-700 text-zinc-500 hover:border-zinc-500')}
                                    >
                                        {LAYER_LABELS[l]}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {drawLayer !== 'regulatory' && wsOptions.length > 0 && (
                            <div className="space-y-1">
                                <label htmlFor="zone-ws" className="block text-[9px] tracking-widest text-zinc-500">WORKSPACE</label>
                                <select
                                    id="zone-ws"
                                    value={drawWs?.id ?? ''}
                                    onChange={e => { setPickedWs(e.target.value); setSaveFailure(null) }}
                                    className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 outline-none"
                                >
                                    {wsOptions.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                                </select>
                            </div>
                        )}

                        <div className="text-[10px] text-zinc-500 leading-relaxed">
                            {drawLayer === 'regulatory'
                                ? 'Regulatory zones can go anywhere and apply to every drone.'
                                : area
                                    ? 'Draw inside the dashed cyan outline - your editable area. The server refuses anything outside it.'
                                    : drawWs
                                        ? `${drawWs.name} has no operating area yet, so the server has nothing to check this against and may refuse it.`
                                        : 'Pick a workspace.'}
                        </div>

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
                            placeholder="ceiling m AGL (optional - blank = all altitudes)"
                            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
                        />

                        {error && <div className="text-[10px] text-red-400">{error}</div>}
                        <FailureBox f={saveFailure} />

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
