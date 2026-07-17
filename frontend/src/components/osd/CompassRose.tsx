'use client'

import { useDroneStore } from '@/store/drone'
import { headingToCardinal } from '@/lib/osd'

interface Props {
    width?: number
}

export function HeadingTape({ width = 300 }: Props) {
    const heading = useDroneStore(s => s.telemetry?.heading_deg ?? 0)

    const pxPerDeg = width / 60  // 60 degrees visible
    const cx = width / 2
    const h = 36

    // Generate tick marks around current heading
    const ticks: number[] = []
    for (let d = -35; d <= 35; d += 5) ticks.push(d)

    const cardinalMap: Record<number, string> = {
        0: 'N', 45: 'NE', 90: 'E', 135: 'SE',
        180: 'S', 225: 'SW', 270: 'W', 315: 'NW', 360: 'N'
    }

    return (
        <div style={{ position: 'relative', width, height: h + 16 }}>
            {/* Tape background */}
            <div style={{
                position: 'absolute', inset: 0,
                background: 'rgba(0,0,0,0.45)',
                backdropFilter: 'blur(4px)',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.12)',
            }} />

            {/* Center pointer */}
            <div style={{
                position: 'absolute',
                bottom: 0,
                left: cx - 4,
                width: 0, height: 0,
                borderLeft: '4px solid transparent',
                borderRight: '4px solid transparent',
                borderBottom: '6px solid #f59e0b',
            }} />

            <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`}
                style={{ position: 'absolute', top: 0, left: 0 }}
            >
                <defs>
                    <clipPath id="tape-clip">
                        <rect x={4} y={0} width={width - 8} height={h} />
                    </clipPath>
                </defs>

                <g clipPath="url(#tape-clip)">
                    {ticks.map(offset => {
                        const deg = ((heading + offset) % 360 + 360) % 360
                        const x = cx + offset * pxPerDeg
                        const isMajor = deg % 45 === 0
                        const isMed = deg % 10 === 0

                        return (
                            <g key={offset}>
                                <line
                                    x1={x} y1={isMajor ? 4 : isMed ? 8 : 12}
                                    x2={x} y2={20}
                                    stroke="rgba(255,255,255,0.5)"
                                    strokeWidth={isMajor ? 1.5 : 0.8}
                                />
                                {(isMed || isMajor) && (
                                    <text
                                        x={x} y={32}
                                        fontSize={isMajor ? 11 : 9}
                                        fill={isMajor ? (cardinalMap[deg] === 'N' ? '#f87171' : 'rgba(255,255,255,0.9)') : 'rgba(255,255,255,0.5)'}
                                        textAnchor="middle"
                                        fontFamily="monospace"
                                        fontWeight={isMajor ? 'bold' : 'normal'}
                                        stroke="rgba(0,0,0,0.9)" strokeWidth={2.5}
                                        style={{ paintOrder: 'stroke fill' } as any}
                                    >
                                        {cardinalMap[deg] ?? deg}
                                    </text>
                                )}
                            </g>
                        )
                    })}
                </g>
            </svg>

            {/* Center heading value */}
            <div style={{
                position: 'absolute',
                top: -20,
                left: '50%',
                transform: 'translateX(-50%)',
                background: 'rgba(0,0,0,0.6)',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: 4,
                padding: '1px 8px',
                fontFamily: 'monospace',
                fontSize: 12,
                color: 'white',
                fontWeight: 'bold',
                whiteSpace: 'nowrap',
            }}>
                {Math.round(heading).toString().padStart(3, '0')}° {headingToCardinal(heading)}
            </div>
        </div>
    )
}