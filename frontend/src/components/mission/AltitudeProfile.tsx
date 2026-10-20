'use client'

// The plan's altitude profile along its real distance, for the Mission tab
// (the Command tab's mission bar draws the same while flying). Each item is
// a dot at its altitude; hover one for its number and height.

import { useMemo } from 'react'
import type { Waypoint } from '@/types/mission'

const R = 6371000
function dist(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
    const p1 = a.lat * Math.PI / 180, p2 = b.lat * Math.PI / 180
    const dp = p2 - p1, dl = (b.lng - a.lng) * Math.PI / 180
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(h))
}
const fmtM = (m: number) => m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`

export default function AltitudeProfile({ waypoints }: { waypoints: Waypoint[] }) {
    const plan = useMemo(() => waypoints.filter(w => w.type !== 'rtl'), [waypoints])
    const geo = useMemo(() => {
        const cum = [0]
        for (let i = 1; i < plan.length; i++) cum.push(cum[i - 1] + dist(plan[i - 1], plan[i]))
        const total = cum[cum.length - 1] || 1
        const maxAlt = Math.max(1, ...plan.map(w => w.altitude)) * 1.15
        return { cum, total, maxAlt }
    }, [plan])

    if (plan.length < 2) {
        return <div className="text-[13px] text-app-text-muted px-1 py-3">Add two or more waypoints to see the profile.</div>
    }
    const pts = plan.map((w, i) => `${(geo.cum[i] / geo.total) * 1000},${100 - (w.altitude / geo.maxAlt) * 100}`)
    const area = `M0,100 L${pts.join(' L')} L1000,100 Z`
    return (
        <div>
            <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className="text-[13px] font-semibold text-app-text-muted">Altitude profile</span>
                <span className="text-[13px] text-app-text tabular-nums">
                    <b className="font-bold">{Math.max(...plan.map(w => w.altitude))}</b>
                    <span className="text-xs text-app-text-muted"> m max</span>
                    <span className="text-app-text-muted"> · </span>
                    <b className="font-bold">{fmtM(geo.total)}</b>
                </span>
            </div>
            <div className="relative h-20">
                <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full text-app-accent" aria-hidden="true">
                    <path d={area} fill="currentColor" fillOpacity={0.14} />
                    <polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                </svg>
                {plan.map((w, i) => (
                    <span key={w.id} title={`Item ${i + 1} (${w.type}) - ${w.altitude} m at ${fmtM(geo.cum[i])}`}
                        className={`absolute rounded-full -translate-x-1/2 -translate-y-1/2 border border-app-surface ${
                            w.type === 'takeoff' ? 'bg-app-ok' : w.type === 'land' ? 'bg-app-danger' : 'bg-app-accent'}`}
                        style={{
                            left: `${(geo.cum[i] / geo.total) * 100}%`,
                            top: `${100 - (w.altitude / geo.maxAlt) * 100}%`,
                            width: 8, height: 8,
                        }} />
                ))}
            </div>
            <div className="flex justify-between text-xs text-app-text-muted tabular-nums mt-0.5"><span>0 m</span><span>{fmtM(geo.total)}</span></div>
        </div>
    )
}
