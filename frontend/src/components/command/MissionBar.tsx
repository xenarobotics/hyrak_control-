'use client'

// The bottom bar of the Command window - a solid bar, not an overlay.
//
//   left    where in the mission: item N of M
//   centre  the mission's ALTITUDE PROFILE along its real distance, flown part
//           lit, aircraft marker at its true position, and the avoidance
//           acting floor as a dashed line. A leg under the floor is red: there
//           avoidance can see an obstacle but is not allowed to steer (the
//           2.8 m pillar crash of 2026-09-26 was exactly that).
//   right   distance to the next item, distance left, time left at the
//           current speed; then what avoidance is doing and the aircraft's
//           latest message - the lines that used to float over the video.

import { useMemo } from 'react'
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

const AVOID_TONE: Record<string, { fg: string; bg: string; label: string }> = {
    avoiding:  { fg: '#67e8f9', bg: 'rgba(8,51,68,.9)', label: 'AVOIDING' },
    holding:   { fg: '#fcd34d', bg: 'rgba(66,32,6,.9)', label: 'HOLDING' },
    returning: { fg: '#fca5a5', bg: 'rgba(69,10,10,.9)', label: 'RETURNING' },
    rerouted:  { fg: '#67e8f9', bg: 'rgba(8,51,68,.9)', label: 'REROUTED' },
    climbing:  { fg: '#c4b5fd', bg: 'rgba(46,16,101,.9)', label: 'CLIMBING' },
}

function Stat({ k, v }: { k: string; v: string }) {
    return (
        <div className="flex flex-col leading-tight">
            <span className="text-[8.5px] tracking-[0.2em] text-zinc-500">{k}</span>
            <span className="text-[13px] text-zinc-100 tabular-nums">{v}</span>
        </div>
    )
}

export function MissionBar({ avoid }: { avoid: AvoidanceStatus | null }) {
    const t = useDroneStore(s => s.telemetry)
    const msgs = useDroneStore(s => s.fcMessages)
    const plan = useMissionStore(s => s.waypoints)
    const last = msgs.length ? msgs[msgs.length - 1] : null
    const floor = actingFloorM(avoid)

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
    const here = t ? { lat: t.position.latitude_deg, lng: t.position.longitude_deg } : null
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

    const steer = avoid?.state && AVOID_TONE[avoid.state]
    const aLine = !avoid ? null
        : !avoid.enabled ? { fg: '#fca5a5', bg: 'transparent', label: 'AVOID OFF', why: 'Obstacle avoidance is off for this aircraft' }
            : !avoid.armed ? { fg: '#fcd34d', bg: 'transparent', label: 'WATCHING', why: 'Detects only - Steer is off' }
                : steer ? { ...steer, why: avoid.planner?.reason ?? avoid.reason }
                    : { fg: '#86efac', bg: 'transparent', label: 'CLEAR', why: avoid.reason || 'Path clear' }
    const lowLeg = floor != null && inAir && t && t.position.relative_altitude_m < floor && avoid?.enabled

    return (
        <div className="h-full flex items-stretch gap-4 px-3 font-mono">
            <div className="flex flex-col justify-center w-[92px] shrink-0">
                <span className="text-[8.5px] tracking-[0.2em] text-zinc-500">MISSION</span>
                {n > 0
                    ? <span className="text-[20px] font-bold tabular-nums leading-none text-zinc-100">
                        {finished ? n : idx >= 0 ? idx + 1 : '-'}<span className="text-[12px] text-zinc-500"> / {n}</span></span>
                    : <span className="text-[12px] text-zinc-500">none loaded</span>}
                {finished && <span className="text-[9px] text-emerald-300 tracking-wider">COMPLETE</span>}
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
                            <polyline points={pts.join(' ')} fill="none" stroke="#475569" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                            <path d={area} fill="rgba(34,211,238,.16)" clipPath="url(#mb-done)" />
                            <polyline points={pts.join(' ')} fill="none" stroke="#22d3ee" strokeWidth="2" vectorEffect="non-scaling-stroke" clipPath="url(#mb-done)" />
                            {floorY != null && (
                                <>
                                    <rect x="0" y={floorY} width="1000" height={100 - floorY} fill="rgba(248,113,113,.07)" />
                                    <line x1="0" y1={floorY} x2="1000" y2={floorY} stroke="#f87171" strokeWidth="1" strokeDasharray="6 5" vectorEffect="non-scaling-stroke" />
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
                                        background: low ? '#f87171' : done ? '#22d3ee' : i === idx ? '#e0f2fe' : '#64748b',
                                        boxShadow: i === idx && !finished ? '0 0 0 2px rgba(34,211,238,.5)' : undefined,
                                    }} />
                            )
                        })}
                        {idx >= 0 && t && (
                            <span className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none"
                                style={{ left: pct(along), top: yPct(Math.max(0, t.position.relative_altitude_m)) }}>
                                <svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 1 L13 12 L7 9 L1 12 Z" fill="#fb923c" stroke="#0b0e13" strokeWidth="1.2" transform="rotate(90 7 7)" /></svg>
                            </span>
                        )}
                        {floor != null && (
                            <span className="absolute right-0 text-[9px] text-red-300/90 -translate-y-full pr-0.5" style={{ top: yPct(floor) }}>
                                avoid floor {floor} m</span>
                        )}
                    </>
                ) : (
                    <div className="h-full flex items-center text-[11px] text-zinc-500">
                        Plan and upload a mission on the Mission tab - its altitude profile shows here.</div>
                )}
            </div>

            <div className="flex items-center gap-4 shrink-0">
                <Stat k="NEXT" v={nextM != null ? fmtM(nextM) : '-'} />
                <Stat k="LEFT" v={leftM != null && idx >= 0 ? fmtM(leftM) : '-'} />
                <Stat k="TIME" v={leftM != null && idx >= 0 && inAir ? fmtT(leftM / speed) : '-'} />
                <Stat k="GS" v={t ? `${t.groundspeed_m_s.toFixed(1)} m/s` : '-'} />
            </div>

            <div className="w-[300px] shrink-0 flex flex-col justify-center gap-1 min-w-0 border-l border-white/10 pl-3">
                {lowLeg ? (
                    <div className="flex items-center gap-2 text-[11px] min-w-0">
                        <span className="px-1.5 rounded font-bold tracking-wider text-red-200 bg-red-900/70 shrink-0">BELOW FLOOR</span>
                        <span className="truncate text-red-200/90">{t!.position.relative_altitude_m.toFixed(1)} m - avoidance can see but will not steer</span>
                    </div>
                ) : aLine && (
                    <div className="flex items-center gap-2 text-[11px] min-w-0" title={aLine.why}>
                        <span className="px-1.5 rounded font-bold tracking-wider shrink-0" style={{ color: aLine.fg, background: aLine.bg, border: `1px solid ${aLine.fg}55` }}>{aLine.label}</span>
                        <span className="truncate text-zinc-300">{aLine.why}</span>
                        {steer && avoid?.planner?.ttc_s != null && <span className="shrink-0 text-cyan-200 tabular-nums">TTC {avoid.planner.ttc_s}s</span>}
                    </div>
                )}
                <div className="text-[11px] truncate" title={last?.text}
                    style={{ color: !last ? '#71717a' : last.rank >= 5 ? '#f87171' : last.rank >= 4 ? '#fbbf24' : '#a1a1aa' }}>
                    {last ? last.text : 'No messages from the aircraft'}
                </div>
            </div>
        </div>
    )
}
