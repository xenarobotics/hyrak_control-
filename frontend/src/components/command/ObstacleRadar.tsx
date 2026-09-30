'use client'

// Optional avoidance views for the Command window's AVOID tab. Both are OFF
// by default and cost nothing until switched on (the radar's map poll only
// runs while it is mounted).
//
//   ObstacleRadar  top-down, nose up: the fused 5-degree sectors avoidance is
//                  acting on (status.obstacle_distance_cm, body frame) and the
//                  occupancy-grid obstacles (GET /obstacles, 1 Hz) placed
//                  around the aircraft by position and heading.
//   DepthStrip     the forward 90 degrees of the same sectors as a parking-
//                  sensor bar: how close things are, left to right.

import { useEffect, useState } from 'react'
import { getServerUrl } from '@/lib/server-url'
import { useDroneStore } from '@/store/drone'
import type { AvoidanceStatus } from '@/lib/avoidance'

const NO_READING = 65535
const SECTOR = 5
const tone = (m: number) => (m < 2 ? '#f87171' : m < 5 ? '#fbbf24' : '#22d3ee')

interface Obstacle { lat: number; lng: number; radius_m: number; dn_m?: number; de_m?: number }

function sectorsM(a: AvoidanceStatus | null): (number | null)[] {
    const cm = a?.obstacle_distance_cm ?? []
    return cm.map(c => (c >= NO_READING || c <= 0 ? null : c / 100))
}

export function ObstacleRadar({ avoid, rangeM = 15 }: { avoid: AvoidanceStatus | null; rangeM?: number }) {
    const t = useDroneStore(s => s.telemetry)
    const [obs, setObs] = useState<Obstacle[]>([])
    const id = avoid?.drone_id

    useEffect(() => {
        if (!id) return
        let alive = true
        const tick = () => {
            if (document.visibilityState !== 'visible') return
            fetch(`${getServerUrl()}/api/avoidance/${id}/obstacles`).then(r => r.json())
                .then(j => { if (alive) setObs(j.obstacles ?? []) }).catch(() => { /* keep last */ })
        }
        tick()
        const iv = setInterval(tick, 1000)
        return () => { alive = false; clearInterval(iv) }
    }, [id])

    const S = 100 / rangeM                      // svg units per metre (radius 100)
    const hdg = t?.heading_deg ?? 0
    const sectors = sectorsM(avoid)
    const here = t ? { lat: t.position.latitude_deg, lng: t.position.longitude_deg } : null

    // world obstacle -> body frame (x right, y forward), metres
    const place = (o: Obstacle) => {
        // Backend-relative offsets when present (indoors the lat/lng are a
        // local frame's fiction); lat/lng maths only as the fallback.
        let n: number, e: number
        if (o.dn_m != null && o.de_m != null) {
            n = o.dn_m; e = o.de_m
        } else {
            if (!here) return null
            n = (o.lat - here.lat) * 111320
            e = (o.lng - here.lng) * 111320 * Math.cos(here.lat * Math.PI / 180)
        }
        const h = hdg * Math.PI / 180
        return { x: e * Math.cos(h) - n * Math.sin(h), y: e * Math.sin(h) + n * Math.cos(h), r: o.radius_m }
    }
    const wedge = (i: number, d: number) => {
        const a0 = (i * SECTOR - 90) * Math.PI / 180, a1 = ((i + 1) * SECTOR - 90) * Math.PI / 180
        const r0 = Math.min(d, rangeM) * S, r1 = 100
        return `M${r0 * Math.cos(a0)},${r0 * Math.sin(a0)} A${r0},${r0} 0 0 1 ${r0 * Math.cos(a1)},${r0 * Math.sin(a1)} `
            + `L${r1 * Math.cos(a1)},${r1 * Math.sin(a1)} A${r1},${r1} 0 0 0 ${r1 * Math.cos(a0)},${r1 * Math.sin(a0)} Z`
    }
    const plan = avoid?.planner?.heading_deg
    const nearest = sectors.reduce<number | null>((m, d) => (d != null && (m == null || d < m) ? d : m), null)

    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-[10px] font-mono tracking-widest" style={{ color: 'hsl(var(--app-text-muted))' }}>
                <span>RADAR · {rangeM} m</span>
                <span style={{ color: nearest != null ? tone(nearest) : undefined }}>
                    {nearest != null ? `nearest ${nearest.toFixed(1)} m` : 'nothing in range'}</span>
            </div>
            <svg viewBox="-104 -104 208 208" className="w-full max-w-[260px] self-center aspect-square">
                <circle r="100" fill="rgba(15,23,32,.9)" stroke="rgba(148,163,184,.25)" />
                {[1 / 3, 2 / 3].map(f => <circle key={f} r={100 * f} fill="none" stroke="rgba(148,163,184,.15)" strokeDasharray="2 3" />)}
                <line x1="0" y1="-100" x2="0" y2="100" stroke="rgba(148,163,184,.10)" />
                <line x1="-100" y1="0" x2="100" y2="0" stroke="rgba(148,163,184,.10)" />
                {sectors.map((d, i) => d != null && d <= rangeM && (
                    <path key={i} d={wedge(i, d)} fill={tone(d)} fillOpacity=".28" />
                ))}
                {obs.map((o, i) => {
                    const p = place(o)
                    if (!p || Math.hypot(p.x, p.y) - p.r > rangeM) return null
                    return <circle key={i} cx={p.x * S} cy={-p.y * S} r={Math.max(2.5, p.r * S)}
                        fill="rgba(249,115,22,.35)" stroke="#fb923c" strokeWidth="1" />
                })}
                {plan != null && (
                    <line x1="0" y1="0" x2={70 * Math.sin((plan - hdg) * Math.PI / 180)} y2={-70 * Math.cos((plan - hdg) * Math.PI / 180)}
                        stroke="#67e8f9" strokeWidth="2" strokeDasharray="5 4" />
                )}
                <path d="M0 -9 L6 7 L0 3 L-6 7 Z" fill="#fb923c" stroke="#0b0e13" strokeWidth="1" />
                <text x="0" y="-90" fontSize="9" textAnchor="middle" fill="rgba(148,163,184,.7)" fontFamily="monospace">NOSE</text>
                <text x={100 / 3 + 2} y="-2" fontSize="8" fill="rgba(148,163,184,.6)" fontFamily="monospace">{Math.round(rangeM / 3)}</text>
                <text x={200 / 3 + 2} y="-2" fontSize="8" fill="rgba(148,163,184,.6)" fontFamily="monospace">{Math.round(rangeM * 2 / 3)}</text>
            </svg>
            <p className="text-[10px] font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>
                Wedges: live sensor sectors. Orange: mapped obstacles. Dashed: planner direction.</p>
        </div>
    )
}

export function DepthStrip({ avoid, rangeM = 10 }: { avoid: AvoidanceStatus | null; rangeM?: number }) {
    const s = sectorsM(avoid)
    // forward 90 degrees, left to right: sectors 63..71 then 0..8
    const idx = [...Array(9)].map((_, k) => 63 + k).concat([...Array(9)].map((_, k) => k))
    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-[10px] font-mono tracking-widest" style={{ color: 'hsl(var(--app-text-muted))' }}>
                <span>FORWARD DEPTH</span><span>45° L · 45° R</span>
            </div>
            <div className="flex items-end gap-[2px] h-16 rounded-md px-1 pt-1" style={{ background: 'rgba(15,23,32,.9)' }}>
                {idx.map(i => {
                    const d = s[i]
                    const h = d == null ? 4 : Math.max(8, (1 - Math.min(d, rangeM) / rangeM) * 100)
                    return <div key={i} title={d == null ? 'clear' : `${d.toFixed(1)} m`} className="flex-1 rounded-t-sm"
                        style={{ height: `${h}%`, background: d == null ? 'rgba(148,163,184,.18)' : tone(d) }} />
                })}
            </div>
            <p className="text-[10px] font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>
                Taller = closer (full height at 0 m, flat beyond {rangeM} m).</p>
        </div>
    )
}
