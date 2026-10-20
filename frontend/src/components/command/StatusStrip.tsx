'use client'

// The status cells in the Command window's top bar: is everything connected, what
// is the aircraft doing, is avoidance watching. Built for a glance, not for
// reading - the details live in the dock.

import { Battery, Cloud, Navigation, Radio, Satellite, ShieldCheck, Timer, Video } from 'lucide-react'
import { useDroneStore } from '@/store/drone'
import { useFlightTimer } from '@/hooks/useFlightTimer'
import type { AvoidanceStatus } from '@/lib/avoidance'

type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'muted' | 'text'
const TONE: Record<Tone, string> = {
    ok: 'text-app-ok', warn: 'text-app-warn', danger: 'text-app-danger',
    accent: 'text-app-accent', muted: 'text-app-text-muted', text: 'text-app-text',
}
const AVOID_TONE: Record<string, Tone> = {
    nominal: 'ok', avoiding: 'accent', holding: 'warn', returning: 'danger',
    rerouted: 'accent', climbing: 'accent', disabled: 'muted',
    guarding: 'accent', follow: 'ok',
}

function Cell({ icon, label, value, tone = 'text', title }: {
    icon?: React.ReactNode; label?: string; value: React.ReactNode; tone?: Tone; title?: string
}) {
    return (
        <div className="flex items-center gap-1.5 px-2.5 h-full border-r border-app-border whitespace-nowrap" title={title}>
            {icon && <span className={TONE[tone]}>{icon}</span>}
            {label && <span className="text-[12px] font-bold text-app-text-muted">{label}</span>}
            <span className={`text-[13px] font-bold tabular-nums ${TONE[tone]}`}>{value}</span>
        </div>
    )
}

export function StatusStrip({ avoid }: { avoid: AvoidanceStatus | null }) {
    const t = useDroneStore(s => s.telemetry)
    const connectionStatus = useDroneStore(s => s.connectionStatus)
    const streamStatus = useDroneStore(s => s.streamStatus)
    const telemetryStatus = useDroneStore(s => s.telemetryStatus)
    const { elapsed } = useFlightTimer()
    const cloudOk = connectionStatus === 'connected'
    const droneOk = telemetryStatus === 'connected' && t?.link_ok !== false
    const bat = t?.battery.remaining_percent
    const batTone: Tone = bat == null ? 'text' : bat < 20 ? 'danger' : bat < 35 ? 'warn' : 'ok'
    const armed = t?.flight_mode.is_armed ?? false
    const rangeLost = !!avoid && avoid.enabled && (avoid.params?.use_range_sensor ?? 1) !== 0
        && avoid.sensor_mode !== 'range' && (t?.flight_mode.is_in_air ?? false) && !avoid.stale
    const aState = avoid?.stale ? 'stale' : avoid
        ? (avoid.enabled
            ? (avoid.armed ? (avoid.guarding ? 'guarding' : avoid.following ? 'follow' : avoid.state) : 'watching')
            : 'off')
        : '-'
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0'), ss = String(elapsed % 60).padStart(2, '0')

    return (
        <div className="flex items-stretch h-9 overflow-x-auto [scrollbar-width:none]">
            <Cell icon={<Cloud size={13} />} value={cloudOk ? 'CLOUD' : connectionStatus.toUpperCase()}
                tone={cloudOk ? 'ok' : connectionStatus === 'reconnecting' ? 'warn' : 'danger'}
                title="Browser to cloud (socket)" />
            {streamStatus !== 'idle' && (
                <Cell icon={<Video size={13} />}
                    value={streamStatus === 'connected' ? 'VIDEO' : streamStatus.toUpperCase()}
                    tone={streamStatus === 'connected' ? 'ok' : streamStatus === 'connecting' ? 'warn' : 'danger'}
                    title="Video stream (WebRTC)" />
            )}
            <Cell icon={<Radio size={13} />}
                value={droneOk ? 'LINK' : t?.link_ok === false ? `LOST ${Math.round(t.link_lost_s ?? 0)}s` : 'NO LINK'}
                tone={droneOk ? 'ok' : 'danger'} title="Cloud to aircraft (MAVLink)" />
            <Cell value={t?.flight_mode.mode ?? '-'} tone="accent" title="Flight mode" />
            <Cell value={armed ? 'ARMED' : 'DISARMED'} tone={armed ? 'danger' : 'muted'} />
            <Cell icon={<Battery size={13} />} value={bat != null ? `${Math.round(bat)}%` : '-'} tone={batTone}
                title={t ? `${t.battery.voltage_v.toFixed(1)} V` : undefined} />
            <Cell icon={<Satellite size={13} />} value={t ? `${t.gps.satellites_visible}` : '-'}
                tone={t && t.gps.fix_type >= 3 ? 'text' : 'warn'} title="GPS satellites" />
            <Cell icon={<Navigation size={13} />} label="HOME" value={t ? `${Math.round(t.home_distance_m)} m` : '-'} />
            <Cell icon={<Timer size={13} />} value={`${mm}:${ss}`} title="Flight time" />
            <Cell icon={<ShieldCheck size={13} />} label="AVOID"
                value={aState === 'stale' ? `STALE ${avoid?.stale_s ?? 0}s` : String(aState).toUpperCase()}
                tone={aState === 'stale' || aState === 'off' ? 'danger' : aState === 'watching' ? 'warn' : AVOID_TONE[aState] ?? 'text'}
                title={aState === 'stale' ? 'No answer from avoidance - what you see is old' : avoid?.reason || (aState === 'off' ? 'Avoidance is off' : aState === 'watching' ? 'Detecting only - Steer is off' : '')} />
            {rangeLost && (
                <Cell label="SENSOR" value="RANGE LOST" tone="danger"
                    title="The range sensor stopped streaming: avoidance is on the camera (or blind) and its acting floor moved up" />
            )}
            {avoid?.sensor_stale && !avoid.stale && (
                <Cell value="BLIND" tone="danger" title="No scan has reached the map for 2 s" />
            )}
            {avoid?.env === 'indoor' && (
                <Cell label="NAV" value="INDOOR" tone="warn"
                    title={`${avoid.env_reason ?? ''} - position from ${avoid.pose_source === 'local' ? 'PX4 local' : 'GPS'}`} />
            )}
            {avoid?.sensor_mode && (
                <Cell label="SENSOR" value={avoid.sensor_mode === 'range' ? 'DEPTH' : avoid.sensor_mode === 'mono' ? 'CAMERA' : 'NONE'}
                    tone={avoid.sensor_mode === 'none' ? 'danger' : 'text'} />
            )}
        </div>
    )
}
