'use client'

import { useDroneStore } from '@/store/drone'
import { climbRate } from '@/lib/osd'

interface Props {
    height?: number
}

export function AltitudeTape({ height = 200 }: Props) {
    const telemetry = useDroneStore(s => s.telemetry)
    const alt = telemetry?.position.relative_altitude_m ?? 0
    const downMs = telemetry?.velocity.down_m_s ?? 0
    const climb = climbRate(downMs)

    const pxPerM = height / 20  // 20m visible range
    const cy = height / 2
    const w = 52

    // Generate altitude lines
    const lines: number[] = []
    for (let i = -12; i <= 12; i++) {
        lines.push(Math.floor(alt) + i)
    }

    return (
        <div style={{
            position: 'relative', width: w, height,
            background: 'rgba(0,0,0,0.45)',
            backdropFilter: 'blur(4px)',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.12)',
        }}>
            <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`}
                style={{ overflow: 'hidden' }}
            >
                <defs>
                    <clipPath id="alt-clip">
                        <rect x={0} y={4} width={w} height={height - 8} />
                    </clipPath>
                </defs>

                <g clipPath="url(#alt-clip)">
                    {lines.map(lineAlt => {
                        const y = cy - (lineAlt - alt) * pxPerM
                        const isMajor = lineAlt % 10 === 0
                        const isMed = lineAlt % 5 === 0

                        return (
                            <g key={lineAlt}>
                                <line
                                    x1={isMajor ? 4 : isMed ? 8 : 12} y1={y}
                                    x2={w - 4} y2={y}
                                    stroke="rgba(255,255,255,0.35)"
                                    strokeWidth={isMajor ? 1 : 0.5}
                                />
                                {(isMajor || isMed) && (
                                    <text
                                        x={isMajor ? 6 : 8} y={y - 2}
                                        fontSize={12}
                                        fill={isMajor ? '#F2F6FA' : '#C3CCD8'} fontWeight={isMajor ? 700 : 600}
                                        stroke="rgba(0,0,0,0.9)" strokeWidth={2.5}
                                        style={{ paintOrder: 'stroke fill' }}
                                    >
                                        {lineAlt}
                                    </text>
                                )}
                            </g>
                        )
                    })}
                </g>

                {/* Current value pointer */}
                <polygon
                    points={`0,${cy} 10,${cy - 8} 10,${cy + 8}`}
                    fill="#3b82f6" opacity={0.9}
                />
                <rect x={10} y={cy - 10} width={w - 14} height={20}
                    fill="#1d4ed8" opacity={0.85} rx={2}
                />
                <text
                    x={w / 2 + 4} y={cy + 4}
                    fontSize={12} fill="white"
                    textAnchor="middle" fontWeight="bold"
                    stroke="rgba(0,0,0,0.9)" strokeWidth={2.5}
                    style={{ paintOrder: 'stroke fill' }}
                >
                    {alt.toFixed(1)}
                </text>
            </svg>

            {/* Climb rate indicator */}
            <div style={{
                position: 'absolute', bottom: -20, left: '50%',
                transform: 'translateX(-50%)',
                fontSize: 12, 
                color: climb > 0.5 ? '#5BD38B' : climb < -0.5 ? '#F2787A' : '#EAF0F6', textShadow: '0 1px 2px rgba(0,0,0,.8)', fontWeight: 700,
                whiteSpace: 'nowrap',
            }}>
                {climb >= 0 ? '▲' : '▼'} {Math.abs(climb).toFixed(1)}m/s
            </div>
        </div>
    )
}