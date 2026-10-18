'use client'

// A small satellite map for areas: shows reference outlines (operating
// areas, membership areas) over the active zones, and lets the caller draw
// one polygon by clicking vertices, the same way the ZONES editor does. The
// parent owns the draft points and the buttons. Import with
// next/dynamic({ ssr: false }).

import { useEffect } from 'react'
import {
    MapContainer, TileLayer, Polygon, Polyline, CircleMarker, Tooltip, useMap, useMapEvents,
} from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { MAP_LAYERS } from '@/types/mission'
import type { GeoPolygon } from '@/lib/access'
import { ZONE_COLORS, geoRings, zoneRings, type ZoneFeature } from '@/components/admin/zones'

export type Outline = { key: string; geom: GeoPolygon; color: string; label: string; dashed?: boolean }

function ClickCapture({ onClick }: { onClick: (lat: number, lng: number) => void }) {
    useMapEvents({ click: e => onClick(e.latlng.lat, e.latlng.lng) })
    return null
}

// Fit the view whenever fitKey changes (a different workspace, a new grant).
function FitTo({ fitKey, outlines, draft }: { fitKey: string; outlines: Outline[]; draft: [number, number][] }) {
    const map = useMap()
    useEffect(() => {
        const pts = [...outlines.flatMap(o => geoRings(o.geom).flat()), ...draft]
        if (pts.length === 0) return
        map.flyToBounds(L.latLngBounds(pts), { padding: [40, 40], duration: 0.5, maxZoom: 17 })
        // Only on fitKey: refitting on every vertex would fight the person drawing.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fitKey, map])
    return null
}

export default function AreaMap({
    outlines, zones = [], draft = [], draftColor = '#22d3ee', onMapClick, fitKey = '',
}: {
    outlines: Outline[]
    zones?: ZoneFeature[]
    draft?: [number, number][]
    draftColor?: string
    onMapClick?: (lat: number, lng: number) => void
    fitKey?: string
}) {
    const layer = MAP_LAYERS.find(l => l.key === 'satellite') ?? MAP_LAYERS[0]
    return (
        <MapContainer
            center={[17.445, 78.349]}
            zoom={14}
            className={`w-full h-full ${onMapClick ? 'cursor-crosshair' : ''}`}
            zoomControl={false}
            attributionControl={false}
        >
            <TileLayer url={layer.url} maxNativeZoom={layer.maxNativeZoom} maxZoom={layer.maxZoom} />
            {onMapClick && <ClickCapture onClick={onMapClick} />}
            <FitTo fitKey={fitKey} outlines={outlines} draft={draft} />

            {zones.filter(z => z.properties.active).map(z => (
                <Polygon key={z.properties.id} positions={zoneRings(z)}
                    pathOptions={{ color: ZONE_COLORS[z.properties.zone_class], weight: 1, fillOpacity: 0.1 }}>
                    <Tooltip sticky>{z.properties.name} - {z.properties.zone_class.toUpperCase()}</Tooltip>
                </Polygon>
            ))}

            {outlines.map(o => (
                <Polygon key={o.key} positions={geoRings(o.geom)}
                    pathOptions={{ color: o.color, weight: 2, fillOpacity: 0.05, dashArray: o.dashed ? '6 6' : undefined }}>
                    <Tooltip sticky>{o.label}</Tooltip>
                </Polygon>
            ))}

            {draft.length >= 3 && (
                <Polygon positions={[draft]}
                    pathOptions={{ color: draftColor, dashArray: '6 6', weight: 2, fillOpacity: 0.12 }} />
            )}
            {draft.length === 2 && (
                <Polyline positions={draft} pathOptions={{ color: draftColor, dashArray: '6 6', weight: 2 }} />
            )}
            {draft.map((p, i) => (
                <CircleMarker key={i} center={p} radius={4} pathOptions={{ color: draftColor, fillOpacity: 1 }} />
            ))}
        </MapContainer>
    )
}
