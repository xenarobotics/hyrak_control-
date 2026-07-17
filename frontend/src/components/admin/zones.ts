// Shared zone types/helpers — SSR-safe (no leaflet imports).

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
    }
}

export const ZONE_COLORS: Record<ZoneClass, string> = {
    green:  '#22c55e',
    orange: '#f59e0b',
    red:    '#ef4444',
}

// GeoJSON is (lng, lat); leaflet wants (lat, lng). Returns rings.
export function zoneRings(f: ZoneFeature): [number, number][][] {
    const swap = (ring: number[][]) => ring.map(([lng, lat]) => [lat, lng] as [number, number])
    if (f.geometry.type === 'Polygon') {
        return (f.geometry.coordinates as number[][][]).map(swap)
    }
    if (f.geometry.type === 'MultiPolygon') {
        return (f.geometry.coordinates as number[][][][]).flatMap(poly => poly.map(swap))
    }
    return []
}
