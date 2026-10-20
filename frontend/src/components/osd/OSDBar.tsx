'use client'
import { useState } from 'react'
import {
    Battery, Satellite, Gauge, Navigation, Home,
    Compass, Wifi, WifiOff, Shield, ShieldOff, Clock, Video, ChevronDown,
} from 'lucide-react'

import { useDroneStore } from '@/store/drone'
import { gpsFixLabel, headingToCardinal, formatDuration } from '@/lib/osd'
import { useFlightTimer } from '@/hooks/useFlightTimer'
import { cn } from '@/lib/utils'
import { FOCUS } from '@/components/controls/flightStyles'

type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'muted'
const TONE_TEXT: Record<Tone, string> = {
    ok: 'text-app-ok', warn: 'text-app-warn', danger: 'text-app-danger',
    accent: 'text-app-accent', muted: 'text-app-text-muted',
}
const TONE_CHIP: Record<Tone, string> = {
    ok: 'border-app-border bg-app-surface-2',
    warn: 'border-app-warn bg-app-warn-soft',
    danger: 'border-app-danger bg-app-danger-soft',
    accent: 'border-app-accent bg-app-accent-soft',
    muted: 'border-app-border bg-app-surface-2',
}
const DOT: Record<Tone, string> = {
    ok: 'bg-app-ok', warn: 'bg-app-warn', danger: 'bg-app-danger', accent: 'bg-app-accent', muted: 'bg-app-text-subtle',
}

/** Status chip: icon + word + colour, 12px bold. */
function Chip({ children, tone = 'muted', title }: {
    children: React.ReactNode; tone?: Tone; title?: string
}) {
    return (
        <div title={title}
            className={cn('flex items-center gap-1.5 h-7 px-2.5 rounded-full border text-[12px] font-bold whitespace-nowrap',
                TONE_CHIP[tone], TONE_TEXT[tone])}>
            {children}
        </div>
    )
}

/** A main readout: small label, big bold value, small muted unit. */
function Readout({ icon, label, value, unit, tone, title }: {
    icon: React.ReactNode; label: string; value: string; unit?: string; tone?: Tone; title?: string
}) {
    return (
        <div title={title} className="flex flex-col min-w-0 px-2 sm:px-3 py-1.5 rounded-[10px] border border-app-border bg-app-surface-2">
            <span className="flex items-center gap-1 text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted">
                <span className="hidden sm:inline-flex">{icon}</span>{label}
            </span>
            <span className="flex items-baseline gap-1 min-w-0">
                <span className={cn('text-[20px] sm:text-[26px] leading-[1.1] font-extrabold tabular-nums truncate',
                    tone ? TONE_TEXT[tone] : 'text-app-text')}>{value}</span>
                {unit && <span className="text-[12px] font-semibold text-app-text-muted">{unit}</span>}
            </span>
        </div>
    )
}

function batteryTone(pct: number): Tone {
    return pct > 50 ? 'ok' : pct > 20 ? 'warn' : 'danger'
}
function gpsTone(fix: number): Tone {
    return fix >= 6 ? 'accent' : fix >= 3 ? 'ok' : fix === 2 ? 'warn' : 'danger'
}

export function OSDBar() {
    // Per-field selectors: a telemetry packet re-renders this bar, but a
    // cvResults update or an FC message must not.
    const telemetry = useDroneStore(s => s.telemetry)
    const connectionStatus = useDroneStore(s => s.connectionStatus)
    const streamStatus = useDroneStore(s => s.streamStatus)
    const telemetryStatus = useDroneStore(s => s.telemetryStatus)
    const { elapsed, running } = useFlightTimer()
    // Below 768px the status chips fold into one summary chip.
    const [open, setOpen] = useState(false)

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
    const linkLost = !!telemetry && telemetry.link_ok === false
    const has = !!telemetry

    const cloudTone: Tone = connectionStatus === 'connected' ? 'ok'
        : connectionStatus === 'connecting' || connectionStatus === 'reconnecting' ? 'warn' : 'danger'
    const videoTone: Tone = streamStatus === 'connected' ? 'ok' : streamStatus === 'error' ? 'danger' : 'warn'

    // The one-line summary: the worst thing first.
    const summary = linkLost ? { tone: 'danger' as Tone, text: `Link lost ${Math.round(telemetry?.link_lost_s ?? 0)}s` }
        : armed ? { tone: 'danger' as Tone, text: `Armed · ${mode}` }
            : !has ? { tone: 'muted' as Tone, text: 'No drone link' }
                : { tone: 'ok' as Tone, text: `Disarmed · ${mode}` }

    const chips = (
        <>
            {/* Cloud socket - never the video stream, which has its own chip */}
            <Chip tone={cloudTone} title="Browser to cloud (socket)">
                <span className={cn('w-2 h-2 rounded-full', DOT[cloudTone])} />
                {connectionStatus === 'connected' ? 'ONLINE' : connectionStatus.toUpperCase()}
            </Chip>

            {/* Video stream - only shown once a stream has been attempted */}
            {streamStatus !== 'idle' && (
                <Chip tone={videoTone} title="Video stream (WebRTC)">
                    <Video size={13} />
                    {streamStatus === 'connected' ? 'VIDEO' : streamStatus.toUpperCase()}
                </Chip>
            )}

            {/* Drone link lost (backend watchdog, ~2 s) - distinct from the
                socket to the cloud, which the chip above shows */}
            {linkLost && (
                <Chip tone="danger">
                    <span className="w-2 h-2 rounded-full bg-app-danger animate-pulse" />
                    DRONE LINK LOST {Math.round(telemetry?.link_lost_s ?? 0)}s
                </Chip>
            )}

            {/* Armed */}
            <Chip tone={armed ? 'danger' : 'muted'}>
                {armed ? <Shield size={13} /> : <ShieldOff size={13} />}
                {armed ? 'ARMED' : 'DISARMED'}
            </Chip>

            {/* Mode */}
            <Chip tone={has ? 'accent' : 'muted'} title="Flight mode">{mode}</Chip>

            {/* GPS */}
            <Chip tone={has ? gpsTone(fix) : 'muted'} title="GPS fix and satellites">
                <Satellite size={13} />
                {gpsFixLabel(fix)}
                <span className="text-app-text-muted font-semibold">{sats}</span>
            </Chip>

            {/* Flight timer */}
            <Chip tone={running ? 'ok' : 'muted'} title="Flight time">
                <Clock size={13} />
                <span className="tabular-nums">{formatDuration(elapsed)}</span>
            </Chip>

            {/* Telemetry link */}
            <Chip tone={telemetryStatus === 'connected' ? 'ok' : 'muted'} title="Telemetry link">
                {telemetryStatus === 'connected' ? <Wifi size={13} /> : <WifiOff size={13} />}
                TEL
            </Chip>
        </>
    )

    return (
        <div className="flex flex-col p-2 gap-2">

            {/* Row 1 - status. Wraps on desktop; one summary chip on phones. */}
            <div className="hidden md:flex items-center gap-1.5 flex-wrap">{chips}</div>
            <div className="md:hidden">
                <button onClick={() => setOpen(o => !o)} aria-expanded={open}
                    className={cn('w-full min-h-9 flex items-center gap-2 px-3 rounded-full border text-[13px] font-bold',
                        TONE_CHIP[summary.tone], TONE_TEXT[summary.tone], FOCUS)}>
                    <span className={cn('w-2 h-2 rounded-full shrink-0', DOT[cloudTone])} />
                    <span className="truncate">{summary.text}</span>
                    <span className="ml-auto flex items-center gap-1 text-[12px] text-app-text-muted">
                        {open ? 'Hide' : 'Status'}
                        <ChevronDown size={14} className={cn('transition-transform duration-[var(--dur)]', open && 'rotate-180')} />
                    </span>
                </button>
                {open && <div className="flex flex-wrap gap-1.5 pt-2">{chips}</div>}
            </div>

            {/* Row 2 - the main readouts */}
            <div className="grid grid-cols-3 gap-1.5 sm:flex sm:flex-wrap sm:gap-2">
                <Readout icon={<Navigation size={13} />} label="ALT" value={alt.toFixed(1)} unit="m" title="Altitude above home" />
                <Readout icon={<Gauge size={13} />} label="SPD" value={speed.toFixed(1)} unit="m/s" title="Ground speed" />
                <Readout icon={<Compass size={13} />} label="HDG"
                    value={`${Math.round(hdg).toString().padStart(3, '0')}°`} unit={headingToCardinal(hdg)} title="Heading" />
                <Readout icon={<Home size={13} />} label="HOME" value={homeDist.toFixed(0)} unit="m" title="Distance to home" />
                <Readout icon={<Battery size={13} />} label="BAT" value={`${bat.toFixed(0)}%`}
                    unit={`${volts.toFixed(1)}V`} tone={has ? batteryTone(bat) : undefined} title="Battery" />
            </div>

        </div>
    )
}
