// Shared zone types/helpers - SSR-safe (no leaflet imports).

import type { GeoPolygon, ZoneLayer } from '@/lib/access'

export type ZoneClass = 'green' | 'orange' | 'red'

export type ZoneFeature = {
    type: 'Feature'
    geometry: { type: string; coordinates: number[][][] | number[][][][] }
    properties: {
        id: string
        name: string
        zone_class: ZoneClass
        floor_m: number
        ceiling_m: number | null
        active: boolean
        // Access model (docs/ACCESS_MODEL.md section 3). Absent on an older
        // server, where every zone is effectively regulatory.
        layer?: ZoneLayer
        workspace_id?: string | null
        /** Red zones (phase 2b): false = prohibited, no permit possible. */
        permission_required?: boolean
    }
}

export const ZONE_COLORS: Record<ZoneClass, string> = {
    green:  '#22c55e',
    orange: '#f59e0b',
    red:    '#ef4444',
}

// GeoJSON is (lng, lat); leaflet wants (lat, lng). Returns rings.
export function zoneRings(f: ZoneFeature): [number, number][][] {
    return geoRings(f.geometry)
}

export function geoRings(g: { type: string; coordinates: unknown } | null | undefined): [number, number][][] {
    if (!g) return []
    const swap = (ring: number[][]) => ring.map(([lng, lat]) => [lat, lng] as [number, number])
    if (g.type === 'Polygon') {
        return (g.coordinates as number[][][]).map(swap)
    }
    if (g.type === 'MultiPolygon') {
        return (g.coordinates as number[][][][]).flatMap(poly => poly.map(swap))
    }
    return []
}

/** Clicked (lat, lng) vertices -> a closed GeoJSON polygon. */
export function polygonFromPoints(points: [number, number][]): GeoPolygon {
    const ring = [...points.map(([lat, lng]) => [lng, lat]), [points[0][1], points[0][0]]]
    return { type: 'Polygon', coordinates: [ring] }
}

/** The outer ring of a polygon as editable (lat, lng) vertices, unclosed. */
export function pointsFromPolygon(g: GeoPolygon | null | undefined): [number, number][] {
    const ring = geoRings(g)[0] ?? []
    if (ring.length > 1) {
        const [a, b] = [ring[0], ring[ring.length - 1]]
        if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1)
    }
    return ring
}
