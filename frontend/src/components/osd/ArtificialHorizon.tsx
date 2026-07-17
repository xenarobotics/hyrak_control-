'use client'

import { useDroneStore } from '@/store/drone'

interface Props {
    width?: number
    height?: number
}

export function ArtificialHorizon({ width = 400, height = 300 }: Props) {
    const telemetry = useDroneStore(s => s.telemetry)
    const roll = telemetry?.attitude.roll_deg ?? 0
    const pitch = telemetry?.attitude.pitch_deg ?? 0

    const cx = width / 2
    const cy = height / 2
    const pxPerDeg = height / 40  // 40 degrees fills the height

    // Pitch ladder lines
    const ladderLines: number[] = []
    for (let d = -30; d <= 30; d += 5) {
        ladderLines.push(d)
    }

    return (
        <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="xMidYMid meet"
            style={{ overflow: 'hidden', pointerEvents: 'none', display: 'block' }}
        >
            {/* Pitch ladder — rotates with roll, translates with pitch */}
            <g transform={`rotate(${-roll}, ${cx}, ${cy}) translate(0, ${pitch * pxPerDeg})`}>
                {ladderLines.map(deg => {
                    if (deg === 0) return null
                    const y = cy - deg * pxPerDeg
                    const isLarge = deg % 10 === 0
                    const lineW = isLarge ? width * 0.25 : width * 0.14
                    const opacity = Math.max(0, 1 - Math.abs(deg) / 35) * 0.55

                    return (
                        <g key={deg} opacity={opacity}>
                            {/* Left line */}
                            <line
                                x1={cx - lineW / 2} y1={y}
                                x2={cx - width * 0.04} y2={y}
                                stroke="white" strokeWidth={deg % 10 === 0 ? 1 : 0.6}
                            />
                            {/* Right line */}
                            <line
                                x1={cx + width * 0.04} y1={y}
                                x2={cx + lineW / 2} y2={y}
                                stroke="white" strokeWidth={deg % 10 === 0 ? 1 : 0.6}
                            />
                            {/* Degree label — right side only */}
                            {isLarge && (
                                <text
                                    x={cx + lineW / 2 + 6} y={y + 3.5}
                                    fontSize={10} fill="white" opacity={0.6}
                                    fontFamily="monospace"
                                    stroke="rgba(0,0,0,0.9)" strokeWidth={2.5}
                                    style={{ paintOrder: 'stroke fill' } as any}
                                >
                                    {deg > 0 ? `+${deg}` : deg}
                                </text>
                            )}
                        </g>
                    )
                })}

                {/* Horizon line — zero pitch */}
                <line
                    x1={cx - width * 0.35} y1={cy}
                    x2={cx - width * 0.06} y2={cy}
                    stroke="rgba(255,255,255,0.65)" strokeWidth={1.5}
                />
                <line
                    x1={cx + width * 0.06} y1={cy}
                    x2={cx + width * 0.35} y2={cy}
                    stroke="rgba(255,255,255,0.65)" strokeWidth={1.5}
                />
            </g>

            {/* Fixed aircraft reticle — always centered, never rotates */}
            <g transform={`translate(${cx}, ${cy})`}>
                {/* Left wing bar */}
                <rect x={-width * 0.12} y={-1.5} width={width * 0.08} height={3}
                    fill="#f59e0b" rx={1.5} opacity={0.9}
                />
                {/* Right wing bar */}
                <rect x={width * 0.04} y={-1.5} width={width * 0.08} height={3}
                    fill="#f59e0b" rx={1.5} opacity={0.9}
                />
                {/* Center dot */}
                <circle cx={0} cy={0} r={2.5} fill="#f59e0b" opacity={0.95} />
                {/* Center tail */}
                <rect x={-1.5} y={4} width={3} height={8}
                    fill="#f59e0b" rx={1} opacity={0.9}
                />
            </g>

            {/* Pitch angle readout — subtle, bottom of element */}
            <text
                x={cx + width * 0.38} y={cy + 4}
                fontSize={9} fill="rgba(255,255,255,0.45)"
                fontFamily="monospace" textAnchor="start"
                stroke="rgba(0,0,0,0.8)" strokeWidth={2}
                style={{ paintOrder: 'stroke fill' } as any}
            >
                {pitch.toFixed(1)}°
            </text>
        </svg>
    )
}