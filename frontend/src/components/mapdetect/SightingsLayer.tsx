'use client'

// Detections on a Leaflet map: one small class-coloured dot per sighting,
// grouped into a numbered bubble where they crowd together at the current
// zoom (a 44 px screen grid - no clustering library needed for a few
// thousand points). Clicking a dot opens its details; clicking a bubble
// zooms in on it. While a popover is open the estimated accuracy is drawn as
// a circle, so "+/- 8 m" is visible, not just written.
//
// Lives inside a react-leaflet <MapContainer>.

import { useMemo, useState } from 'react'
import { Circle, Marker, Popup, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import { classColor, fmtTime, type Sighting } from '@/lib/mapSightings'

const CELL_PX = 44

function dotIcon(color: string): L.DivIcon {
    return L.divIcon({
        className: '',
        html: `<div style="width:12px;height:12px;border-radius:50%;background:${color};`
            + `border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.55);cursor:pointer"></div>`,
        iconSize: [12, 12],
        iconAnchor: [6, 6],
    })
}

function bubbleIcon(n: number, color: string): L.DivIcon {
    const sz = n < 10 ? 24 : n < 100 ? 28 : 34
    return L.divIcon({
        className: '',
        html: `<div style="width:${sz}px;height:${sz}px;border-radius:50%;background:${color};`
            + `border:2px solid #fff;color:#0b0f17;font:700 11px/1 var(--font-geist-mono,monospace);`
            + `display:flex;align-items:center;justify-content:center;`
            + `box-shadow:0 1px 6px rgba(0,0,0,.55);cursor:pointer">${n}</div>`,
        iconSize: [sz, sz],
        iconAnchor: [sz / 2, sz / 2],
    })
}

interface Group { key: string; items: Sighting[]; lat: number; lon: number; color: string }

function useGroups(list: Sighting[]): Group[] {
    const map = useMap()
    const [view, setView] = useState(() => ({ zoom: map.getZoom() }))
    useMapEvents({ zoomend: () => setView({ zoom: map.getZoom() }) })
    return useMemo(() => {
        const cells = new Map<string, Sighting[]>()
        for (const s of list) {
            const p = map.project([s.lat, s.lon], view.zoom)
            const key = `${Math.floor(p.x / CELL_PX)}:${Math.floor(p.y / CELL_PX)}`
            const c = cells.get(key)
            if (c) c.push(s)
            else cells.set(key, [s])
        }
        return [...cells.entries()].map(([key, items]) => {
            const lat = items.reduce((a, s) => a + s.lat, 0) / items.length
            const lon = items.reduce((a, s) => a + s.lon, 0) / items.length
            const tally: Record<string, number> = {}
            for (const s of items) tally[s.label] = (tally[s.label] ?? 0) + 1
            const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0]
            return { key, items, lat, lon, color: classColor(top) }
        })
    }, [list, map, view.zoom])
}

export function SightingPopover({ s }: { s: Sighting }) {
    const color = classColor(s.label)
    return (
        <div style={{ minWidth: 180, maxWidth: 230, fontSize: 12, lineHeight: 1.45, color: '#111827' }}>
            {s.thumb && (
                // eslint-disable-next-line @next/next/no-img-element -- a data: URL crop, nothing to optimise
                <img src={s.thumb} alt={`Best view of the ${s.label}`}
                    style={{ display: 'block', maxWidth: '100%', maxHeight: 110, borderRadius: 6, marginBottom: 6 }} />
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13 }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0 }} />
                <span style={{ textTransform: 'capitalize' }}>{s.label}</span>
                {s.best_score != null && (
                    <span style={{ marginLeft: 'auto', fontWeight: 600, color: '#4b5563' }}>
                        {Math.round(s.best_score * 100)}%</span>
                )}
            </div>
            <dl style={{ margin: '6px 0 0', display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 2 }}>
                <dt style={{ color: '#6b7280' }}>Seen</dt>
                <dd style={{ margin: 0 }}>
                    {fmtTime(s.first_seen)}
                    {s.last_seen && s.first_seen && s.last_seen - s.first_seen >= 1 ? ` - ${fmtTime(s.last_seen)}` : ''}
                    {s.count > 1 ? ` (${s.count} frames)` : ''}
                </dd>
                <dt style={{ color: '#6b7280' }}>Position</dt>
                <dd style={{ margin: 0 }}>about +/- {s.accuracy_m} m</dd>
                <dt style={{ color: '#6b7280' }}>Model</dt>
                <dd style={{ margin: 0 }}>{s.model_name || s.source}</dd>
            </dl>
            {s.angle_source === 'default' && (
                <p style={{ margin: '6px 0 0', color: '#92400e' }}>
                    Camera angle not set, so this assumes the camera points straight down.
                </p>
            )}
        </div>
    )
}

/** `list`: the sightings to draw (already filtered by the caller). */
export function SightingsLayer({ list }: { list: Sighting[] }) {
    const map = useMap()
    const groups = useGroups(list)
    const [openId, setOpenId] = useState<string | null>(null)
    const open = openId ? list.find(s => s.id === openId) : undefined
    return (
        <>
            {open && (
                <Circle center={[open.lat, open.lon]} radius={open.accuracy_m}
                    pathOptions={{ color: classColor(open.label), weight: 1.5, fillOpacity: 0.12,
                        dashArray: '4 4', interactive: false }} />
            )}
            {groups.map(g => g.items.length === 1 ? (
                <Marker key={g.items[0].id} position={[g.items[0].lat, g.items[0].lon]}
                    icon={dotIcon(g.color)} zIndexOffset={600}
                    title={`${g.items[0].label}, about +/- ${g.items[0].accuracy_m} m`}
                    eventHandlers={{
                        popupopen: () => setOpenId(g.items[0].id),
                        popupclose: () => setOpenId(id => (id === g.items[0].id ? null : id)),
                    }}>
                    <Popup autoPan closeButton>
                        <SightingPopover s={g.items[0]} />
                    </Popup>
                </Marker>
            ) : (
                <Marker key={`g-${g.key}-${g.items.length}`} position={[g.lat, g.lon]}
                    icon={bubbleIcon(g.items.length, g.color)} zIndexOffset={650}
                    title={`${g.items.length} detections here - zoom in`}
                    eventHandlers={{
                        click: () => {
                            const b = L.latLngBounds(g.items.map(s => [s.lat, s.lon] as [number, number]))
                            const z = Math.min(map.getBoundsZoom(b.pad(0.3)), map.getMaxZoom())
                            map.flyTo(b.getCenter(), Math.max(z, map.getZoom() + 1), { duration: 0.4 })
                        },
                    }} />
            ))}
        </>
    )
}
