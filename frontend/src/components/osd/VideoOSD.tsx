'use client'

import { useDroneStore } from '@/store/drone'
import { ArtificialHorizon } from './ArtificialHorizon'
import { AltitudeTape } from './AltitudeTape'
import { SpeedTape } from './SpeedTape'
import { HeadingTape } from './CompassRose'
import { OSDConfigPanel, useOSDConfig } from './OSDConfigPanel'
import { useFlightTimer } from '@/hooks/useFlightTimer'
import {
    batteryTextColor, batteryBorderColor,
    gpsFixLabel, gpsFixColor,
    formatDuration, climbRate, climbRateColor,
    connectionQuality, connectionQualityColor,
    estimatedFlightTimeRemaining,
} from '@/lib/osd'
import type { WebRTCStats } from '@/hooks/useWebRTC'

interface Props {
    stats?: WebRTCStats | null
}

// Glass pill — all OSD elements use this
function GP({
    children, style
}: {
    children: React.ReactNode
    style?: React.CSSProperties
}) {
    return (
        <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '5px 9px', borderRadius: 8,
            background: 'rgba(0,0,0,0.52)',
            backdropFilter: 'blur(10px)',
            border: '1px solid rgba(255,255,255,0.13)',
            fontFamily: 'monospace', fontSize: 11,
            color: 'white', whiteSpace: 'nowrap',
            ...style,
        }}>
            {children}
        </div>
    )
}

function RollArc({ roll }: { roll: number }) {
    const w = 200, h = 28, cx = w / 2, r = 80

    return (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}
            style={{ pointerEvents: 'none', display: 'block' }}
        >
            <path
                d={`M ${cx - 72} ${h} A ${r} ${r} 0 0 1 ${cx + 72} ${h}`}
                fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth={1}
            />
            {[-30, -20, -10, 0, 10, 20, 30].map(deg => {
                const rad = (deg - 90) * Math.PI / 180
                const rInner = r - 7
                return (
                    <line key={deg}
                        x1={cx + Math.cos(rad) * rInner}
                        y1={h + Math.sin(rad) * rInner - r}
                        x2={cx + Math.cos(rad) * r}
                        y2={h + Math.sin(rad) * r - r}
                        stroke={`rgba(255,255,255,${deg === 0 ? 0.7 : 0.3})`}
                        strokeWidth={deg === 0 ? 2 : 0.8}
                    />
                )
            })}
            {/* Roll pointer */}
            <g transform={`translate(${cx}, ${h}) rotate(${-roll})`}>
                <polygon
                    points="0,-3 -5,-13 5,-13"
                    fill="#f59e0b" opacity={0.95}
                    transform={`translate(0, ${-r})`}
                />
            </g>
            {/* Roll value */}
            <text x={cx} y={h - 2}
                fontSize={9} fill="white" textAnchor="middle"
                fontFamily="monospace" opacity={0.5}
                style={{ paintOrder: 'stroke fill' } as any}
                stroke="rgba(0,0,0,0.8)" strokeWidth={2}
            >
                {roll.toFixed(1)}°
            </text>
        </svg>
    )
}

export function VideoOSD({ stats }: Props) {
    const { telemetry } = useDroneStore()
    const { elapsed, running } = useFlightTimer()
    const { config, updateWidget, setPreset } = useOSDConfig()

    const armed = telemetry?.flight_mode.is_armed ?? false
    const mode = telemetry?.flight_mode.mode ?? 'NO LINK'
    const bat = telemetry?.battery.remaining_percent ?? 0
    const volts = telemetry?.battery.voltage_v ?? 0
    const sats = telemetry?.gps.satellites_visible ?? 0
    const fix = telemetry?.gps.fix_type ?? 0
    const alt = telemetry?.position.relative_altitude_m ?? 0
    const absAlt = telemetry?.position.absolute_altitude_m ?? 0
    const lat = telemetry?.position.latitude_deg ?? 0
    const lon = telemetry?.position.longitude_deg ?? 0
    const homeDist = telemetry?.home_distance_m ?? 0
    const downMs = telemetry?.velocity.down_m_s ?? 0
    const climb = climbRate(downMs)
    const roll = telemetry?.attitude.roll_deg ?? 0

    const rtt = stats?.roundTripTime ?? 0
    const bitrate = stats?.bitrate ?? 0
    const fps = stats?.inputFps ?? 0
    const packetLoss = stats?.packetLoss ?? 0
    const quality = connectionQuality(rtt, packetLoss)
    const qualColor = connectionQualityColor(quality)
    const estFlight = estimatedFlightTimeRemaining(bat, elapsed)

    // If OSD disabled, only show the config button
    if (!config.enabled) {
        return (
            <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 30, pointerEvents: 'auto' }}>
                <OSDConfigPanel config={config} onUpdate={updateWidget} onPreset={setPreset} />
            </div>
        )
    }

    return (
        <div style={{
            position: 'absolute', inset: 0,
            pointerEvents: 'none', userSelect: 'none', overflow: 'hidden',
        }}>

            {/* ── TOP LEFT — armed + mode + timer ── */}
            {config.armedMode && (
                <div style={{ position: 'absolute', top: 10, left: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                        <GP style={{
                            borderColor: armed ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.12)',
                            background: armed ? 'rgba(120,20,20,0.6)' : 'rgba(0,0,0,0.52)',
                            color: armed ? '#fca5a5' : 'rgba(255,255,255,0.5)',
                        }}>
                            {armed ? '● ARMED' : '○ DISARMED'}
                        </GP>
                        <GP style={{ borderColor: 'rgba(34,211,238,0.3)', background: 'rgba(8,50,65,0.6)', color: '#67e8f9', fontWeight: 'bold' }}>
                            {mode}
                        </GP>
                    </div>
                    {config.flightTimer && (
                        <GP style={{ color: running ? '#4ade80' : 'rgba(255,255,255,0.35)' }}>
                            ⏱ {formatDuration(elapsed)}
                            {estFlight !== '—' && bat > 0 && (
                                <span style={{ color: 'rgba(255,255,255,0.3)', marginLeft: 6, fontSize: 10 }}>
                                    ~{estFlight}
                                </span>
                            )}
                        </GP>
                    )}
                </div>
            )}

            {/* ── TOP CENTER — roll arc ── */}
            <div style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', pointerEvents: 'none' }}>
                <RollArc roll={roll} />
            </div>

            {/* ── TOP RIGHT — OSD config + battery + GPS ── */}
            <div style={{
                position: 'absolute', top: 10, right: 10,
                display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6,
                pointerEvents: 'auto',
            }}>
                <OSDConfigPanel config={config} onUpdate={updateWidget} onPreset={setPreset} />

                {config.batteryWidget && (
                    <GP style={{
                        borderColor: batteryBorderColor(bat),
                        background: bat <= 20 ? 'rgba(120,20,20,0.6)' : 'rgba(0,0,0,0.52)',
                    }}>
                        <span style={{ color: batteryTextColor(bat), fontWeight: 'bold', fontSize: 13 }}>
                            {bat.toFixed(0)}%
                        </span>
                        <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10 }}>{volts.toFixed(2)}V</span>
                        {bat <= 30 && (
                            <span style={{ color: batteryTextColor(bat), fontSize: 10 }}>
                                {bat <= 15 ? '⚠ CRITICAL' : '⚠ LOW'}
                            </span>
                        )}
                    </GP>
                )}

                {config.gpsWidget && (
                    <GP>
                        <span style={{ color: gpsFixColor(fix), fontWeight: 'bold' }}>{gpsFixLabel(fix)}</span>
                        <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10 }}>{sats}sat</span>
                    </GP>
                )}

                {config.coordinates && lat !== 0 && (
                    <GP style={{ fontSize: 9 }}>
                        <span style={{ color: 'rgba(255,255,255,0.45)' }}>
                            {lat.toFixed(5)}, {lon.toFixed(5)}
                        </span>
                    </GP>
                )}
            </div>

            {/* ── LEFT EDGE — altitude tape ── */}
            {config.altitudeTape && (
                <div style={{
                    position: 'absolute', left: 10,
                    top: '50%', transform: 'translateY(-50%)',
                }}>
                    <AltitudeTape height={180} />
                </div>
            )}

            {/* ── RIGHT EDGE — speed tape ── */}
            {config.speedTape && (
                <div style={{
                    position: 'absolute', right: 10,
                    top: '50%', transform: 'translateY(-50%)',
                }}>
                    <SpeedTape height={180} />
                </div>
            )}

            {/* ── CENTER — artificial horizon ── */}
            {config.artificialHorizon && (
                <div style={{
                    position: 'absolute',
                    top: '50%', left: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: '60%', height: '55%',
                    minWidth: 300, minHeight: 200,
                    pointerEvents: 'none',
                }}>
                    <ArtificialHorizon width={400} height={260} />
                </div>
            )}

            {/* ── BOTTOM LEFT — home + climb + network ── */}
            <div style={{ position: 'absolute', bottom: 56, left: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
                {config.networkStats && stats && (
                    <GP>
                        <span style={{ color: qualColor, fontWeight: 'bold', textTransform: 'uppercase' }}>{quality}</span>
                        <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10 }}>
                            {fps.toFixed(0)}fps · {(bitrate / 1_000_000).toFixed(1)}Mb · {rtt.toFixed(0)}ms
                        </span>
                    </GP>
                )}

                {config.homeDistance && (
                    <GP>
                        <span style={{ color: '#c4b5fd' }}>⌂</span>
                        <span style={{ color: 'rgba(255,255,255,0.6)' }}>HOME</span>
                        <span style={{ fontWeight: 'bold' }}>{homeDist.toFixed(0)}m</span>
                    </GP>
                )}

                {config.climbRate && (
                    <GP>
                        <span style={{ color: climbRateColor(climb) }}>
                            {climb >= 0 ? '▲' : '▼'} {Math.abs(climb).toFixed(1)}m/s
                        </span>
                    </GP>
                )}

                {config.verticalSpeed && (
                    <GP style={{ fontSize: 10 }}>
                        <span style={{ color: 'rgba(255,255,255,0.45)' }}>ABS {absAlt.toFixed(1)}m</span>
                    </GP>
                )}
            </div>

            {/* ── BOTTOM CENTER — heading tape ── */}
            {config.headingTape && (
                <div style={{
                    position: 'absolute', bottom: 10,
                    left: '50%', transform: 'translateX(-50%)',
                }}>
                    <HeadingTape width={260} />
                </div>
            )}

            {/* ── Critical battery warning ── */}
            {bat > 0 && bat <= 15 && (
                <div style={{
                    position: 'absolute', top: '60%', left: '50%',
                    transform: 'translateX(-50%)',
                    background: 'rgba(120,20,20,0.8)',
                    backdropFilter: 'blur(8px)',
                    border: '1px solid rgba(239,68,68,0.6)',
                    borderRadius: 10, padding: '8px 20px',
                    color: '#fca5a5', fontFamily: 'monospace',
                    fontSize: 14, fontWeight: 'bold', textAlign: 'center',
                    animation: 'pulse 1s infinite',
                }}>
                    ⚠ CRITICAL BATTERY — {bat.toFixed(0)}%
                    <div style={{ fontSize: 11, fontWeight: 'normal', marginTop: 2, color: 'rgba(252,165,165,0.7)' }}>
                        LAND IMMEDIATELY
                    </div>
                </div>
            )}

        </div>
    )
}