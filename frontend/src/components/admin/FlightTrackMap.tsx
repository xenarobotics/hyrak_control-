'use client'

// Small map rendering one recorded flight's 1 Hz track.
// Import with next/dynamic({ ssr: false }).

import { useEffect } from 'react'
import { MapContainer, TileLayer, Polyline, CircleMarker, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { MAP_LAYERS } from '@/types/mission'

function FitTrack({ points }: { points: [number, number][] }) {
    const map = useMap()
    useEffect(() => {
        if (points.length === 0) return
        map.fitBounds(L.latLngBounds(points), { padding: [30, 30], maxZoom: 19 })
    }, [points, map])
    return null
}

export default function FlightTrackMap({ track }: { track: { lat: number; lng: number }[] }) {
    const layer = MAP_LAYERS.find(l => l.key === 'satellite') ?? MAP_LAYERS[0]
    const points = track
        .filter(p => p.lat !== 0 || p.lng !== 0)
        .map(p => [p.lat, p.lng] as [number, number])

    return (
        <MapContainer
            center={points[0] ?? [17.445, 78.349]}
            zoom={16}
            className="w-full h-full"
            zoomControl={false}
            attributionControl={false}
            dragging={true}
            scrollWheelZoom={true}
        >
            <TileLayer url={layer.url} maxNativeZoom={layer.maxNativeZoom} maxZoom={layer.maxZoom} />
            <FitTrack points={points} />
            {points.length > 1 && (
                <Polyline positions={points} pathOptions={{ color: '#22d3ee', weight: 2.5 }} />
            )}
            {points.length > 0 && (
                <>
                    <CircleMarker center={points[0]} radius={5}
                        pathOptions={{ color: '#22c55e', fillOpacity: 1 }} />
                    <CircleMarker center={points[points.length - 1]} radius={5}
                        pathOptions={{ color: '#ef4444', fillOpacity: 1 }} />
                </>
            )}
        </MapContainer>
    )
}
