'use client'

// The mission half of the Command action bar.
//
//   left    where in the mission: item N of M
//   centre  the mission's ALTITUDE PROFILE along its real distance, flown part
//           lit, aircraft marker at its true position, and the avoidance
//           acting floor as a dashed line. A leg under the floor is red: there
//           avoidance can see an obstacle but is not allowed to steer (the
//           2.8 m pillar crash of 2026-09-26 was exactly that).
//   right   distance to the next item, distance left, time left at the
//           current speed, ground speed.
// What avoidance is doing and the aircraft's latest message moved to the
// global status bar (AvoidChips, the messages button).

import { useMemo } from 'react'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { useUiMode } from '@/hooks/useUiMode'
import { useDroneStore } from '@/store/drone'
import { useMissionStore } from '@/store/mission'
import type { AvoidanceStatus } from '@/lib/avoidance'
import { actingFloorM } from './avoidFloor'

const R = 6371000
function dist(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
    const p1 = a.lat * Math.PI / 180, p2 = b.lat * Math.PI / 180
    const dp = p2 - p1, dl = (b.lng - a.lng) * Math.PI / 180
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(h))
}
const fmtM = (m: number) => m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`
const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

function Stat({ k, v }: { k: string; v: string }) {
    return (
        <div className="flex flex-col leading-tight">
            <span className="text-[13px] font-semibold text-app-text-muted">{k}</span>
            <span className="text-[14px] font-bold text-app-text tabular-nums">{v}</span>
        </div>
    )
}

export function MissionBar({ avoid }: { avoid: AvoidanceStatus | null }) {
    const t = useDroneStore(s => s.telemetry)
    const plan = useMissionStore(s => s.waypoints)
    const floor = actingFloorM(avoid)
    // Normal mode names the Mission tab "Plan".
    const normal = useUiMode()[0] === 'normal'

    const geo = useMemo(() => {
        const cum = [0]
        for (let i = 1; i < plan.length; i++) cum.push(cum[i - 1] + dist(plan[i - 1], plan[i]))
        const total = cum[cum.length - 1] || 1
        const maxAlt = Math.max(1, floor ?? 0, ...plan.map(w => w.altitude)) * 1.2
        return { cum, total, maxAlt }
    }, [plan, floor])

    const n = plan.length
    const idx = t?.mission_current_index ?? -1
    const finished = t?.mission_finished ?? false
    // Indoors (PX4 local frame) the lat/lng are a fiction: no distances from them.
    const localNav = avoid?.pose_source === 'local' || !!(t && !t.position.latitude_deg && !t.position.longitude_deg)
    const here = t && !localNav ? { lat: t.position.latitude_deg, lng: t.position.longitude_deg } : null
    const inAir = t?.flight_mode.is_in_air ?? false

    // Where along the route the aircraft is (metres from the first item).
    let along = 0
    if (n > 1 && here && idx >= 0) {
        if (finished || idx >= n) along = geo.total
        else if (idx === 0) along = 0
        else {
            const leg = geo.cum[idx] - geo.cum[idx - 1]
            along = geo.cum[idx - 1] + Math.min(leg, dist(plan[idx - 1], here))
        }
    }
    const nextM = here && idx >= 0 && idx < n && !finished ? dist(here, plan[idx]) : null
    const leftM = n > 1 ? Math.max(0, geo.total - along) : null
    const speed = Math.max(0.5, t?.groundspeed_m_s ?? 0)
    const pct = (m: number) => `${(m / geo.total) * 100}%`
    const yPct = (alt: number) => `${100 - (alt / geo.maxAlt) * 100}%`

    // SVG profile in a 1000 x 100 box (stretched; no text inside it).
    const pts = plan.map((w, i) => `${(geo.cum[i] / geo.total) * 1000},${100 - (w.altitude / geo.maxAlt) * 100}`)
    const area = n > 1 ? `M0,100 L${pts.join(' L')} L1000,100 Z` : ''
    const floorY = floor != null ? 100 - (floor / geo.maxAlt) * 100 : null

    // No plan yet: say so once and point to where plans are made.
    if (n === 0) {
        return (
            <div className="h-full flex items-center gap-2 min-w-0 text-[13px] text-app-text-muted">
                <span className="whitespace-nowrap">No mission loaded</span>
                <Link href="/mission" className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md whitespace-nowrap text-app-accent font-semibold hover:bg-app-accent-soft transition-colors duration-[140ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app-bg">
                    Plan on {normal ? 'Plan' : 'Mission'} <ChevronRight size={14} /></Link>
            </div>
        )
    }

    return (
        <div className="h-full flex items-stretch gap-4 min-w-0">
            <div className="flex flex-col justify-center w-[84px] shrink-0">
                <span className="text-[13px] font-semibold text-app-text-muted">Mission</span>
                {n > 0
                    ? <span className="text-[18px] font-extrabold tabular-nums leading-none text-app-text">
                        {finished ? n : idx >= 0 ? idx + 1 : '-'}<span className="text-[13px] font-semibold text-app-text-muted"> / {n}</span></span>
                    : <span className="text-[13px] text-app-text-muted">None loaded</span>}
                {finished && <span className="text-[12px] font-bold text-app-ok">Complete</span>}
            </div>

            {/* altitude profile along the route */}
            <div className="flex-1 min-w-[160px] relative my-2">
                {n > 1 ? (
                    <>
                        <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
                            <defs>
                                <clipPath id="mb-done"><rect x="0" y="0" width={(along / geo.total) * 1000} height="100" /></clipPath>
                            </defs>
                            <path d={area} fill="rgba(148,163,184,.10)" />
                            <polyline points={pts.join(' ')} fill="none" style={{ stroke: 'hsl(var(--app-border-strong))' }} strokeWidth="2" vectorEffect="non-scaling-stroke" />
                            <path d={area} style={{ fill: 'var(--app-accent-soft)' }} clipPath="url(#mb-done)" />
                            <polyline points={pts.join(' ')} fill="none" style={{ stroke: 'var(--app-accent)' }} strokeWidth="2" vectorEffect="non-scaling-stroke" clipPath="url(#mb-done)" />
                            {floorY != null && (
                                <>
                                    <rect x="0" y={floorY} width="1000" height={100 - floorY} fill="rgba(248,113,113,.07)" />
                                    <line x1="0" y1={floorY} x2="1000" y2={floorY} style={{ stroke: 'var(--app-danger)' }} strokeWidth="1" strokeDasharray="6 5" vectorEffect="non-scaling-stroke" />
                                </>
                            )}
                        </svg>
                        {plan.map((w, i) => {
                            const low = floor != null && w.altitude < floor
                            const done = finished || i < idx
                            return (
                                <span key={w.id} title={`Item ${i + 1} - ${w.altitude} m${low ? ' - below the avoidance floor' : ''}`}
                                    className="absolute rounded-full -translate-x-1/2 -translate-y-1/2"
                                    style={{
                                        left: pct(geo.cum[i]), top: yPct(w.altitude),
                                        width: i === idx && !finished ? 9 : 5, height: i === idx && !finished ? 9 : 5,
                                        background: low ? 'var(--app-danger)' : done ? 'var(--app-accent)' : i === idx ? 'hsl(var(--app-text))' : 'hsl(var(--app-border-strong))',
                                        boxShadow: i === idx && !finished ? '0 0 0 2px var(--app-accent-soft), 0 0 0 3px var(--app-accent)' : undefined,
                                    }} />
                            )
                        })}
                        {idx >= 0 && t && (
                            <span className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none"
                                style={{ left: pct(along), top: yPct(Math.max(0, t.position.relative_altitude_m)) }}>
                                <svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 1 L13 12 L7 9 L1 12 Z" fill="#fb923c" style={{ stroke: 'hsl(var(--app-surface))' }} strokeWidth="1.2" transform="rotate(90 7 7)" /></svg>
                            </span>
                        )}
                        {floor != null && (
                            <span className="absolute right-0 text-[12px] font-semibold text-app-danger -translate-y-full pr-0.5" style={{ top: yPct(floor) }}>
                                avoid floor {floor} m</span>
                        )}
                    </>
                ) : (
                    <div className="h-full flex items-center gap-3 text-[13px] text-app-text-muted">
                        <span>No mission loaded.</span>
                        <Link href="/mission" className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md text-app-accent font-semibold hover:bg-app-accent-soft transition-colors duration-[140ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app-bg">
                            Plan on {normal ? 'Plan' : 'Mission'} <ChevronRight size={14} /></Link>
                    </div>
                )}
            </div>

            <div className="flex items-center gap-4 shrink-0">
                <Stat k="Next" v={localNav ? 'local' : nextM != null ? fmtM(nextM) : '-'} />
                <Stat k="Left" v={localNav ? 'nav' : leftM != null && idx >= 0 ? fmtM(leftM) : '-'} />
                <Stat k="Time" v={localNav ? '-' : leftM != null && idx >= 0 && inAir ? fmtT(leftM / speed) : '-'} />
                <Stat k="Speed" v={t ? `${t.groundspeed_m_s.toFixed(1)} m/s` : '-'} />
            </div>

        </div>
    )
}
