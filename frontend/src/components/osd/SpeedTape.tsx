'use client'

import { useDroneStore } from '@/store/drone'

interface Props {
    height?: number
}

export function SpeedTape({ height = 200 }: Props) {
    const speed = useDroneStore(s => s.telemetry?.groundspeed_m_s ?? 0)

    const pxPerMs = height / 10  // 10 m/s visible range
    const cy = height / 2
    const w = 52

    const lines: { spd: number; offset: number }[] = []
    for (let i = -6; i <= 6; i++) {
        lines.push({ spd: Math.max(0, Math.round(speed) + i), offset: i })
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
                    <clipPath id="spd-clip">
                        <rect x={0} y={4} width={w} height={height - 8} />
                    </clipPath>
                </defs>

                <g clipPath="url(#spd-clip)">
                    {lines.map(({ spd: lineSpd, offset }) => {
                        const y = cy - (lineSpd - speed) * pxPerMs
                        const isMajor = lineSpd % 5 === 0
                        return (
                            <g key={offset}>
                                <line
                                    x1={4} y1={y}
                                    x2={isMajor ? w - 4 : w - 10} y2={y}
                                    stroke="rgba(255,255,255,0.35)"
                                    strokeWidth={isMajor ? 1 : 0.5}
                                />
                                {isMajor && (
                                    <text
                                        x={6} y={y - 2}
                                        fontSize={9} fill="rgba(255,255,255,0.6)"
                                        fontFamily="monospace"
                                        stroke="rgba(0,0,0,0.9)" strokeWidth={2.5}
                                        style={{ paintOrder: 'stroke fill' } as any}
                                    >
                                        {lineSpd}
                                    </text>
                                )}
                            </g>
                        )
                    })}
                </g>

                {/* Pointer */}
                <polygon
                    points={`${w},${cy} ${w - 10},${cy - 8} ${w - 10},${cy + 8}`}
                    fill="#10b981" opacity={0.9}
                />
                <rect x={4} y={cy - 10} width={w - 14} height={20}
                    fill="#065f46" opacity={0.85} rx={2}
                />
                <text
                    x={w / 2 - 2} y={cy + 4}
                    fontSize={11} fill="white" fontFamily="monospace"
                    textAnchor="middle" fontWeight="bold"
                    stroke="rgba(0,0,0,0.9)" strokeWidth={2.5}
                    style={{ paintOrder: 'stroke fill' } as any}
                >
                    {speed.toFixed(1)}
                </text>
            </svg>

            <div style={{
                position: 'absolute', bottom: -16, left: '50%',
                transform: 'translateX(-50%)',
                fontSize: 9, fontFamily: 'monospace',
                color: 'rgba(255,255,255,0.5)',
                whiteSpace: 'nowrap',
            }}>
                m/s
            </div>
        </div>
    )
}