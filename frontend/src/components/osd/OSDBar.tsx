'use client'
import {
    Battery, Satellite, Gauge, Navigation,
    Compass, Wifi, WifiOff, Shield, ShieldOff, Clock
} from 'lucide-react'

import { useDroneStore } from '@/store/drone'
import {
    batteryTextColor, batteryBorderColor, gpsFixLabel,
    gpsFixColor, headingToCardinal, formatDuration
} from '@/lib/osd'
import { useFlightTimer } from '@/hooks/useFlightTimer'
import { connectionColor } from '@/lib/utils'
import { cn } from '@/lib/utils'

function Pill({ children, className, style }: {
    children: React.ReactNode
    className?: string
    style?: React.CSSProperties
}) {
    return (
        <div
            className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono',
                'bg-secondary border border-border',
                className
            )}
            style={style}
        >
            {children}
        </div>
    )
}

export function OSDBar() {
    const { telemetry, connectionStatus, telemetryStatus } = useDroneStore()
    const { elapsed, running } = useFlightTimer()

    const alt = telemetry?.position.relative_altitude_m ?? 0
    const speed = telemetry?.groundspeed_m_s ?? 0
    const hdg = telemetry?.heading_deg ?? 0
    const bat = telemetry?.battery.remaining_percent ?? 0
    const volts = telemetry?.battery.voltage_v ?? 0
    const sats = telemetry?.gps.satellites_visible ?? 0
    const fix = telemetry?.gps.fix_type ?? 0
    const mode = telemetry?.flight_mode.mode ?? 'NO LINK'
    const armed = telemetry?.flight_mode.is_armed ?? false
    const homeDist = telemetry?.home_distance_m ?? 0

    return (
        <div className="flex flex-col px-2.5 py-1.5 gap-1.5">

            {/* Row 1 — status */}
            <div className="flex items-center gap-2 flex-wrap">
                {/* Connection */}
                <Pill>
                    <span className={cn('w-2 h-2 rounded-full', connectionColor(connectionStatus))} />
                    <span className="text-muted-foreground">
                        {connectionStatus === 'connected' ? 'ONLINE' : connectionStatus.toUpperCase()}
                    </span>
                </Pill>

                {/* Armed */}
                <Pill className={cn(
                    armed && 'border-red-500/40 bg-red-500/10'
                )}>
                    {armed
                        ? <Shield size={12} className="text-red-500" />
                        : <ShieldOff size={12} className="text-muted-foreground" />
                    }
                    <span className={armed ? 'text-red-500 font-semibold' : 'text-muted-foreground'}>
                        {armed ? 'ARMED' : 'DISARMED'}
                    </span>
                </Pill>

                {/* Mode */}
                <Pill className="border-cyan-500/30 bg-cyan-500/5">
                    <span className="text-cyan-500 font-semibold">{mode}</span>
                </Pill>

                {/* Flight timer */}
                <Pill>
                    <Clock size={12} className={running ? 'text-green-500' : 'text-muted-foreground'} />
                    <span className={running ? 'text-green-500' : 'text-muted-foreground'}>
                        {formatDuration(elapsed)}
                    </span>
                </Pill>

                {/* Telemetry link */}
                <Pill className="ml-auto">
                    {telemetryStatus === 'connected'
                        ? <Wifi size={12} className="text-green-500" />
                        : <WifiOff size={12} className="text-muted-foreground" />
                    }
                    <span className="text-muted-foreground">TEL</span>
                </Pill>
            </div>

            {/* Row 2 — flight data */}
            <div className="flex items-center gap-2 flex-wrap">
                {/* Altitude */}
                <Pill>
                    <Navigation size={12} className="text-blue-400" />
                    <span className="text-muted-foreground">ALT</span>
                    <span className="font-semibold">{alt.toFixed(1)}</span>
                    <span className="text-muted-foreground text-[10px]">m</span>
                </Pill>

                {/* Speed */}
                <Pill>
                    <Gauge size={12} className="text-purple-400" />
                    <span className="text-muted-foreground">SPD</span>
                    <span className="font-semibold">{speed.toFixed(1)}</span>
                    <span className="text-muted-foreground text-[10px]">m/s</span>
                </Pill>

                {/* Heading */}
                <Pill>
                    <Compass size={12} className="text-orange-400" />
                    <span className="text-muted-foreground">HDG</span>
                    <span className="font-semibold">{Math.round(hdg).toString().padStart(3, '0')}°</span>
                    <span className="text-muted-foreground text-[10px]">{headingToCardinal(hdg)}</span>
                </Pill>

                {/* Home distance */}
                <Pill>
                    <span className="text-muted-foreground">HOME</span>
                    <span className="font-semibold">{homeDist.toFixed(0)}</span>
                    <span className="text-muted-foreground text-[10px]">m</span>
                </Pill>

                {/* Battery */}
                <Pill style={{ borderColor: batteryBorderColor(bat) }}>
                    <Battery size={12} style={{ color: batteryTextColor(bat) }} />
                    <span style={{ color: batteryTextColor(bat) }} className="font-bold">
                        {bat.toFixed(0)}%
                    </span>
                    <span className="text-muted-foreground text-[10px]">{volts.toFixed(1)}V</span>
                </Pill>

                {/* GPS */}
                <Pill>
                    <Satellite size={12} className={gpsFixColor(fix)} />
                    <span className={gpsFixColor(fix)}>{gpsFixLabel(fix)}</span>
                    <span className="text-muted-foreground">{sats}</span>
                </Pill>
            </div>

        </div>
    )
}