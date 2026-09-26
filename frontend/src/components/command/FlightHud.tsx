'use client'

// A light flight HUD drawn over the video: horizon line and pitch ladder
// (roll/pitch), a heading tape, speed on the left, altitude and climb rate on
// the right. One SVG, no clicks captured - the picture stays usable.

import { useDroneStore } from '@/store/drone'

const PX_PER_DEG = 4          // pitch ladder spacing
const TAPE_PX_PER_DEG = 3.2   // heading tape spacing

export function FlightHud() {
    const t = useDroneStore(s => s.telemetry)
    if (!t) return null
    const roll = t.attitude.roll_deg, pitch = t.attitude.pitch_deg
    const hdg = ((t.heading_deg % 360) + 360) % 360
    const alt = t.position.relative_altitude_m
    const gs = t.groundspeed_m_s
    const vs = -(t.velocity?.down_m_s ?? 0)

    const ticks: number[] = []
    for (let d = Math.floor((hdg - 40) / 10) * 10; d <= hdg + 40; d += 10) ticks.push(d)
    const card = (d: number) => {
        const n = ((d % 360) + 360) % 360
        return ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' } as Record<number, string>)[n] ?? String(n).padStart(3, '0')
    }

    return (
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="-500 -300 1000 600"
            preserveAspectRatio="xMidYMid meet" style={{ fontFamily: 'ui-monospace, monospace' }}>
            <defs>
                <clipPath id="hud-ladder"><rect x="-170" y="-150" width="340" height="300" /></clipPath>
                <clipPath id="hud-tape"><rect x="-150" y="-292" width="300" height="34" /></clipPath>
            </defs>
            <g stroke="rgba(163,230,53,.9)" fill="rgba(163,230,53,.95)" strokeWidth="1.6">
                {/* pitch ladder + horizon, rotated by roll */}
                <g clipPath="url(#hud-ladder)">
                    <g transform={`rotate(${-roll}) translate(0 ${pitch * PX_PER_DEG})`}>
                        <line x1="-160" y1="0" x2="160" y2="0" strokeWidth="2" />
                        {[-20, -10, 10, 20].map(p => (
                            <g key={p} transform={`translate(0 ${-p * PX_PER_DEG})`}>
                                <line x1="-45" y1="0" x2="45" y2="0" strokeDasharray={p < 0 ? '8 6' : undefined} />
                                <text x="52" y="4" fontSize="11" stroke="none">{p}</text>
                            </g>
                        ))}
                    </g>
                </g>
                {/* aircraft reference */}
                <path d="M -60 0 H -20 L -10 10 M 60 0 H 20 L 10 10" fill="none" strokeWidth="2.4" />
                <circle cx="0" cy="0" r="3" stroke="none" />
                {/* roll scale */}
                <g transform={`rotate(${-roll})`}><path d="M 0 -128 l -6 -10 h 12 z" stroke="none" /></g>
                {[-45, -30, -15, 0, 15, 30, 45].map(a => (
                    <line key={a} x1="0" y1="-140" x2="0" y2={a % 30 === 0 ? -152 : -147} transform={`rotate(${a})`} />
                ))}
                {/* heading tape */}
                <g clipPath="url(#hud-tape)">
                    {ticks.map(d => {
                        const x = (d - hdg) * TAPE_PX_PER_DEG
                        return (
                            <g key={d} transform={`translate(${x} -270)`}>
                                <line x1="0" y1="8" x2="0" y2={d % 30 === 0 ? 0 : 4} />
                                {d % 30 === 0 && <text x="0" y="-4" fontSize="11" textAnchor="middle" stroke="none">{card(d)}</text>}
                            </g>
                        )
                    })}
                </g>
                <rect x="-24" y="-296" width="48" height="16" fill="rgba(0,0,0,.55)" strokeWidth="1" />
                <text x="0" y="-284" fontSize="12" textAnchor="middle" stroke="none">{String(Math.round(hdg) % 360).padStart(3, '0')}</text>
                {/* speed (left) and altitude + climb (right) */}
                <g transform="translate(-300 0)">
                    <rect x="-44" y="-14" width="88" height="28" fill="rgba(0,0,0,.55)" strokeWidth="1" />
                    <text x="0" y="6" fontSize="16" textAnchor="middle" stroke="none">{gs.toFixed(1)}</text>
                    <text x="0" y="30" fontSize="10" textAnchor="middle" stroke="none">GS m/s</text>
                </g>
                <g transform="translate(300 0)">
                    <rect x="-44" y="-14" width="88" height="28" fill="rgba(0,0,0,.55)" strokeWidth="1" />
                    <text x="0" y="6" fontSize="16" textAnchor="middle" stroke="none">{alt.toFixed(1)}</text>
                    <text x="0" y="30" fontSize="10" textAnchor="middle" stroke="none">ALT m</text>
                    <text x="0" y="46" fontSize="11" textAnchor="middle" stroke="none">{vs >= 0 ? '▲' : '▼'} {Math.abs(vs).toFixed(1)}</text>
                </g>
            </g>
        </svg>
    )
}
