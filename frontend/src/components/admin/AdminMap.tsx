'use client'

// Live-fleet map for the admin console. One marker per session with a GPS
// fix; clicking a marker opens that drone's detail panel. Import this with
// next/dynamic({ ssr: false }) — leaflet touches window at import time.

import { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { MAP_LAYERS } from '@/types/mission'

export type MapDrone = {
    session_id: string
    name: string
    lat: number
    lng: number
    heading: number
    armed: boolean
    in_air: boolean
    selected: boolean
}

function droneIcon(d: MapDrone): L.DivIcon {
    const color = d.armed ? '#f59e0b' : '#22d3ee'
    const sz = d.selected ? 34 : 28
    return L.divIcon({
        className: '',
        html: `<div style="
            width:${sz}px;height:${sz}px;border-radius:50%;
            background:#09090bcc;border:2px solid ${color};
            ${d.selected ? `box-shadow:0 0 0 4px ${color}44;` : ''}
            display:flex;align-items:center;justify-content:center;">
            <div style="transform:rotate(${d.heading}deg);color:${color};
                font-size:${sz - 16}px;line-height:1;">▲</div>
        </div>
        <div style="text-align:center;margin-top:2px;color:#e4e4e7;
            font-family:monospace;font-size:10px;white-space:nowrap;
            text-shadow:0 1px 3px #000;">${d.name}</div>`,
        iconSize: [sz, sz],
        iconAnchor: [sz / 2, sz / 2],
    })
}

// Fits all drones into view when they first appear (or on RECENTER), then
// leaves the operator's pan/zoom alone.
function FitAll({ points, fitKey }: { points: [number, number][]; fitKey: number }) {
    const map = useMap()
    const fitted = useRef(-1)
    useEffect(() => {
        if (points.length === 0 || fitted.current === fitKey) return
        fitted.current = fitKey
        map.fitBounds(L.latLngBounds(points), { padding: [80, 80], maxZoom: 18 })
    }, [points, fitKey, map])
    return null
}

export default function AdminMap({
    drones,
    onSelect,
}: {
    drones: MapDrone[]
    onSelect: (sessionId: string) => void
}) {
    const layer = MAP_LAYERS.find(l => l.key === 'satellite') ?? MAP_LAYERS[0]
    const [fitKey, setFitKey] = useState(0)
    const points = drones.map(d => [d.lat, d.lng] as [number, number])

    return (
        <div className="absolute inset-0">
            <MapContainer
                center={[17.445, 78.349]}
                zoom={5}
                className="w-full h-full"
                zoomControl={false}
                attributionControl={false}
            >
                <TileLayer
                    url={layer.url}
                    maxNativeZoom={layer.maxNativeZoom}
                    maxZoom={layer.maxZoom}
                />
                <FitAll points={points} fitKey={fitKey} />
                {drones.map(d => (
                    <Marker
                        key={d.session_id}
                        position={[d.lat, d.lng]}
                        icon={droneIcon(d)}
                        eventHandlers={{ click: () => onSelect(d.session_id) }}
                    />
                ))}
            </MapContainer>
            <button
                onClick={() => setFitKey(k => k + 1)}
                className="absolute bottom-3 right-3 z-[1000] px-3 py-1.5 rounded border border-zinc-700 bg-zinc-950/80 text-[10px] font-mono text-zinc-300 hover:border-zinc-500"
            >
                RECENTER
            </button>
            {drones.length === 0 && (
                <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] px-3 py-1.5 rounded border border-zinc-800 bg-zinc-950/80 text-[10px] font-mono text-zinc-500">
                    No drones with GPS fix
                </div>
            )}
        </div>
    )
}
