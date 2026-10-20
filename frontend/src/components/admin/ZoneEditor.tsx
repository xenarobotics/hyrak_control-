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
        <div role="alert" className="border border-app-danger/50 bg-app-danger-soft rounded-md p-2 space-y-1">
            <div className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.04em] text-app-danger">
                {f.title}
                {onClose && (
                    <button onClick={onClose} className="ml-auto text-app-text-muted hover:text-app-text" aria-label="Dismiss">x</button>
                )}
            </div>
            <div className="text-[12px] text-app-danger leading-relaxed">{f.text}</div>
        </div>
    )
}

/** Zone class picker button: a colour swatch + the word, readable in both themes. */
function classBtnStyle(c: ZoneClass, active: boolean): React.CSSProperties {
    return {
        borderColor: active ? ZONE_COLORS[c] : 'hsl(var(--app-border-strong))',
        background: active ? `${ZONE_COLORS[c]}22` : 'transparent',
        color: active ? 'hsl(var(--app-text))' : 'hsl(var(--app-text-muted))',
    }
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
    // Red only: no permit can ever be requested for it (an airport, say).
    const [prohibited, setProhibited] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [focusZone, setFocusZone] = useState<ZoneFeature | null>(null)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [editName, setEditName] = useState('')
    const [editClass, setEditClass] = useState<ZoneClass>('red')
    const [editCeiling, setEditCeiling] = useState('')
    const [editActive, setEditActive] = useState(true)
    const [editProhibited, setEditProhibited] = useState(false)
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
        setEditProhibited(z.properties.permission_required === false)
    }

    const saveEdit = async () => {
        if (!editingId) return
        setListFailure(null)
        const r = await updateZone(editingId, {
            name: editName,
            zone_class: editClass,
            ceiling_m: editCeiling !== '' ? Number(editCeiling) : null,
            active: editActive,
            permission_required: !(editClass === 'red' && editProhibited),
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
        setProhibited(false)
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
            permission_required: !(zoneClass === 'red' && prohibited),
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
                className="absolute left-3 top-3 bottom-3 z-[1000] w-72 max-w-[calc(100%-24px)] rounded-[10px] border border-app-border bg-app-surface shadow-[var(--app-shadow)] flex flex-col overflow-hidden"
            >
                <div className="px-3 min-h-10 py-2 text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted border-b border-app-border flex items-center gap-2">
                    Flight zones <span className="ml-auto tabular-nums">{zones.length}</span>
                </div>

                {!drawing ? (
                    <>
                        <div className="p-2 space-y-2">
                            {layerOptions.length > 0 ? (
                                <button
                                    onClick={() => setDrawing(true)}
                                    className="w-full h-9 rounded-md bg-app-accent text-app-accent-ink text-[14px] font-bold transition-opacity duration-[120ms] hover:opacity-90"
                                >
                                    + Draw new zone
                                </button>
                            ) : (
                                <div className="text-[12px] text-app-text-muted">
                                    You can see every zone, but none of your roles edits zones.
                                </div>
                            )}
                            <FailureBox f={listFailure} onClose={() => setListFailure(null)} />
                        </div>
                        <div className="flex-1 overflow-y-auto p-2 pt-0 space-y-2">
                            {zones.length === 0 && (
                                <div className="text-[12px] text-app-text-muted p-2">
                                    No zones yet. Draw your test field&apos;s green / orange / red
                                    areas - the backend enforces them on every connected drone.
                                </div>
                            )}
                            {zones.map(z => (
                                <div
                                    key={z.properties.id}
                                    className="border border-app-border rounded-md bg-app-surface p-2.5 text-[13px] cursor-pointer transition-colors duration-[120ms] hover:border-app-text-subtle"
                                    onClick={() => setFocusZone(z)}
                                >
                                    {editingId === z.properties.id ? (
                                        <div className="space-y-2" onClick={e => e.stopPropagation()}>
                                            <input
                                                value={editName}
                                                onChange={e => setEditName(e.target.value)}
                                                className="w-full bg-app-surface-2 border border-app-border-strong rounded-md px-2 h-8 text-[13px] text-app-text outline-none"
                                            />
                                            <div className="flex gap-1.5">
                                                {(['green', 'orange', 'red'] as ZoneClass[]).map(c => (
                                                    <button
                                                        key={c}
                                                        onClick={() => setEditClass(c)}
                                                        className="flex-1 h-8 inline-flex items-center justify-center gap-1.5 rounded-md border text-[13px] font-semibold capitalize transition-colors duration-[120ms]"
 style={classBtnStyle(c, editClass === c)}
 aria-pressed={editClass === c}
 >
 <span className="size-2.5 rounded-full" style={{ background: ZONE_COLORS[c] }} aria-hidden />
 {c}
                                                    </button>
                                                ))}
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <input
                                                    value={editCeiling}
                                                    onChange={e => setEditCeiling(e.target.value.replace(/[^0-9.]/g, ''))}
                                                    placeholder="ceiling m"
                                                    className="flex-1 bg-app-surface-2 border border-app-border-strong rounded-md px-2 h-8 text-[13px] text-app-text outline-none placeholder:text-app-text-subtle"
                                                />
                                                <label className="flex items-center gap-1 text-[12px] text-app-text-muted">
                                                    <input
                                                        type="checkbox"
                                                        checked={editActive}
                                                        onChange={e => setEditActive(e.target.checked)}
                                                    />
                                                    ACTIVE
                                                </label>
                                            </div>
                                            {editClass === 'red' && (
                                                <label className="flex items-center gap-1 text-[12px] text-app-text-muted"
                                                    title="Changing this withdraws the permits approved for this zone">
                                                    <input type="checkbox" checked={editProhibited}
                                                        onChange={e => setEditProhibited(e.target.checked)} />
                                                    PROHIBITED - NO PERMITS
                                                </label>
                                            )}
                                            <div className="flex gap-2">
                                                <button onClick={() => void saveEdit()}
                                                    className="flex-1 h-8 rounded-md border border-app-ok/50 text-[13px] font-semibold text-app-ok hover:bg-app-ok-soft transition-colors duration-[120ms]">
                                                    Save
                                                </button>
                                                <button onClick={() => setEditingId(null)}
                                                    className="h-8 px-3 rounded-md border border-app-border-strong text-[13px] font-semibold text-app-text hover:bg-app-surface-2 transition-colors duration-[120ms]">
                                                    Cancel
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
                                                    (z.properties.active ? 'text-app-text' : 'text-app-text-muted line-through')
                                                }>
                                                    {z.properties.name}
                                                </span>
                                                {canEdit(z) && (
                                                    <>
                                                        <button
                                                            onClick={e => { e.stopPropagation(); startEdit(z) }}
                                                            className="ml-auto h-7 px-2 rounded-md text-[13px] font-semibold text-app-text-muted hover:text-app-accent hover:bg-app-surface-2"
                                                        >
                                                            Edit
                                                        </button>
                                                        <button
                                                            onClick={e => { e.stopPropagation(); void remove(z) }}
                                                            className="h-7 px-2 rounded-md text-[13px] font-semibold text-app-text-muted hover:text-app-danger hover:bg-app-danger-soft"
                                                        >
                                                            Delete
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                            <div className="mt-1 text-[12px] text-app-text-muted">
                                                <span className="capitalize">{z.properties.zone_class}</span>
                                                {z.properties.layer && ` · ${LAYER_LABELS[z.properties.layer]}`}
                                                {wsName(z.properties.workspace_id) && z.properties.layer !== 'regulatory' &&
                                                    ` · ${wsName(z.properties.workspace_id)}`}
                                                {z.properties.ceiling_m != null &&
                                                    ` · up to ${z.properties.ceiling_m} m`}
                                                {z.properties.zone_class === 'red' && z.properties.permission_required === false &&
                                                    ' · no permits'}
                                                {!z.properties.active && ' · inactive'}
                                            </div>
                                        </>
                                    )}
                                </div>
                            ))}
                        </div>
                    </>
                ) : (
                    <div className="p-3 space-y-3 text-[13px] overflow-y-auto">
                        <div className="space-y-1">
                            <div className="text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted">Layer</div>
                            <div className="flex gap-1.5">
                                {layerOptions.map(l => (
                                    <button
                                        key={l}
                                        onClick={() => { setPickedLayer(l); setSaveFailure(null) }}
                                        aria-pressed={drawLayer === l}
                                        className={'flex-1 h-8 rounded-md border text-[13px] font-semibold capitalize transition-colors duration-[120ms] ' +
                                            (drawLayer === l
                                                ? 'border-app-accent text-app-accent bg-app-accent-soft'
                                                : 'border-app-border-strong text-app-text-muted hover:border-app-text-subtle')}
                                    >
                                        {LAYER_LABELS[l]}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {drawLayer !== 'regulatory' && wsOptions.length > 0 && (
                            <div className="space-y-1">
                                <label htmlFor="zone-ws" className="block text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted">Workspace</label>
                                <select
                                    id="zone-ws"
                                    value={drawWs?.id ?? ''}
                                    onChange={e => { setPickedWs(e.target.value); setSaveFailure(null) }}
                                    className="w-full bg-app-surface-2 border border-app-border-strong rounded-md px-2 h-8 text-[13px] text-app-text outline-none"
                                >
                                    {wsOptions.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                                </select>
                            </div>
                        )}

                        <div className="text-[12px] text-app-text-muted leading-relaxed">
                            {drawLayer === 'regulatory'
                                ? 'Regulatory zones can go anywhere and apply to every drone.'
                                : area
                                    ? 'Draw inside the dashed cyan outline - your editable area. The server refuses anything outside it.'
                                    : drawWs
                                        ? `${drawWs.name} has no operating area yet, so the server has nothing to check this against and may refuse it.`
                                        : 'Pick a workspace.'}
                        </div>

                        <div className="text-[12px] text-app-text-muted">
                            Click the map to add vertices ({points.length} placed
                            {points.length < 3 ? `, need ${3 - points.length} more` : ''})
                        </div>

                        <div className="flex gap-1.5">
                            {(['green', 'orange', 'red'] as ZoneClass[]).map(c => (
                                <button
                                    key={c}
                                    onClick={() => setZoneClass(c)}
                                    className="flex-1 h-8 inline-flex items-center justify-center gap-1.5 rounded-md border text-[13px] font-semibold capitalize transition-colors duration-[120ms]"
 style={classBtnStyle(c, zoneClass === c)}
 aria-pressed={zoneClass === c}
 >
 <span className="size-2.5 rounded-full" style={{ background: ZONE_COLORS[c] }} aria-hidden />
 {c}
                                </button>
                            ))}
                        </div>

                        <input
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder="zone name (optional)"
                            className="w-full bg-app-surface-2 border border-app-border-strong rounded-md px-2 h-8 text-[13px] text-app-text outline-none placeholder:text-app-text-subtle"
                        />
                        <input
                            value={ceiling}
                            onChange={e => setCeiling(e.target.value.replace(/[^0-9.]/g, ''))}
                            placeholder="ceiling m AGL (optional - blank = all altitudes)"
                            className="w-full bg-app-surface-2 border border-app-border-strong rounded-md px-2 h-8 text-[13px] text-app-text outline-none placeholder:text-app-text-subtle"
                        />
                        {zoneClass === 'red' && (
                            <label className="flex items-start gap-2 text-[13px] text-app-text-muted">
                                <input type="checkbox" checked={prohibited} onChange={e => setProhibited(e.target.checked)} className="mt-0.5" />
                                <span>Prohibited: no permit can be requested (otherwise pilots may ask
                                    to cross it, and reviewers for this area decide).</span>
                            </label>
                        )}

                        {error && <div className="text-[12px] text-app-danger">{error}</div>}
                        <FailureBox f={saveFailure} />

                        <div className="flex gap-2">
                            <button
                                onClick={() => void save()}
                                disabled={points.length < 3 || saving}
                                title={points.length < 3 ? 'Click the map to add at least 3 points' : undefined}
                                className="flex-1 h-9 rounded-md border border-app-ok/50 bg-app-ok-soft text-[14px] font-bold text-app-ok disabled:cursor-not-allowed disabled:bg-transparent disabled:border-dashed disabled:border-app-border-strong disabled:text-app-text-muted hover:border-app-ok transition-colors duration-[120ms]"
                            >
                                {saving ? 'Saving…' : 'Save zone'}
                            </button>
                            <button
                                onClick={() => setPoints(p => p.slice(0, -1))}
                                disabled={points.length === 0}
                                className="h-9 px-3 rounded-md border border-app-border-strong text-[13px] font-semibold text-app-text disabled:cursor-not-allowed disabled:border-dashed disabled:text-app-text-muted hover:bg-app-surface-2 transition-colors duration-[120ms]"
                            >
                                Undo
                            </button>
                            <button
                                onClick={reset}
                                className="h-9 px-3 rounded-md border border-app-border-strong text-[13px] font-semibold text-app-text hover:bg-app-surface-2 transition-colors duration-[120ms]"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
