'use client'

// The plan Copilot is asking about, drawn on the Command map as a dashed
// magenta preview: the route (preview.waypoints) and the area
// (preview.area). It reads only the Copilot store and never touches the
// pilot's mission plan; it disappears when the card closes, expires, or the
// pilot turns "Show on map" off. Rendered inside MissionMap's MapContainer.

import { useEffect, useState } from 'react'
import { Polyline, Circle, CircleMarker } from 'react-leaflet'
import { useCopilotStore, latestOpenCard, toMs } from '@/lib/copilot'

/** The theme's magenta (it differs per theme), refreshed on theme change. */
function useMagenta(): string {
    const read = () => getComputedStyle(document.documentElement).getPropertyValue('--app-magenta').trim() || '#E08AF5'
    const [c, setC] = useState(read)
    useEffect(() => {
        const mo = new MutationObserver(() => setC(read()))
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
        return () => mo.disconnect()
    }, [])
    return c
}

export function CopilotMapPreview() {
    const show = useCopilotStore(s => s.showPreview)
    const card = useCopilotStore(s => latestOpenCard(s, c => !!(c.preview && (c.preview.waypoints?.length || c.preview.area))))
    const color = useMagenta()
    // Drop the preview when the card runs out, even if no update arrives.
    const [, setTick] = useState(0)
    useEffect(() => {
        if (!card) return
        const ms = toMs(card.expires_at) - Date.now()
        const t = setTimeout(() => setTick(n => n + 1), Math.max(0, ms) + 50)
        return () => clearTimeout(t)
    }, [card])

    if (!show || !card?.preview) return null
    const { waypoints = [], area } = card.preview
    const path = waypoints.filter(w => Number.isFinite(w.lat) && Number.isFinite(w.lng)).map(w => [w.lat, w.lng] as [number, number])
    return (
        <>
            {area && Number.isFinite(area.center?.lat) && area.radius_m > 0 && (
                <Circle center={[area.center.lat, area.center.lng]} radius={area.radius_m} interactive={false}
                    pathOptions={{ color, weight: 2, dashArray: '8 6', fillColor: color, fillOpacity: 0.08 }} />
            )}
            {path.length >= 2 && (
                <Polyline positions={path} interactive={false}
                    pathOptions={{ color, weight: 3, opacity: 0.95, dashArray: '8 6' }} />
            )}
            {path.map((p, i) => (
                <CircleMarker key={i} center={p} radius={i === 0 ? 5 : 3.5} interactive={false}
                    pathOptions={{ color, weight: 2, fillColor: color, fillOpacity: i === 0 ? 1 : 0.6 }} />
            ))}
        </>
    )
}
