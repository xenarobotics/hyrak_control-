'use client'

// The status cells in the Command window's top bar: is everything connected, what
// is the aircraft doing, is avoidance watching. Built for a glance, not for
// reading - the details live in the dock.

import { Battery, Cloud, Navigation, Radio, Satellite, ShieldCheck, Timer } from 'lucide-react'
import { useDroneStore } from '@/store/drone'
import { useFlightTimer } from '@/hooks/useFlightTimer'
import type { AvoidanceStatus } from '@/lib/avoidance'

const AVOID_COLOR: Record<string, string> = {
    nominal: '#4ade80', avoiding: '#22d3ee', holding: '#fbbf24', returning: '#f87171',
    rerouted: '#22d3ee', climbing: '#a78bfa', disabled: '#71717a',
    guarding: '#22d3ee', follow: '#4ade80',
}

function Cell({ icon, label, value, color, title }: {
    icon?: React.ReactNode; label?: string; value: React.ReactNode; color?: string; title?: string
}) {
    return (
        <div className="flex items-center gap-1.5 px-2.5 h-full border-r border-white/10 whitespace-nowrap" title={title}>
            {icon && <span className="opacity-70">{icon}</span>}
            {label && <span className="text-[9px] tracking-widest text-zinc-400">{label}</span>}
            <span className="text-[12px] font-semibold tabular-nums" style={{ color: color ?? '#e5e7eb' }}>{value}</span>
        </div>
    )
}

export function StatusStrip({ avoid }: { avoid: AvoidanceStatus | null }) {
    const { telemetry: t, connectionStatus, telemetryStatus } = useDroneStore()
    const { elapsed } = useFlightTimer()
    const cloudOk = connectionStatus === 'connected'
    const droneOk = telemetryStatus === 'connected' && t?.link_ok !== false
    const bat = t?.battery.remaining_percent
    const batColor = bat == null ? undefined : bat < 20 ? '#f87171' : bat < 35 ? '#fbbf24' : '#4ade80'
    const armed = t?.flight_mode.is_armed ?? false
    const aState = avoid
        ? (avoid.enabled
            ? (avoid.armed ? (avoid.guarding ? 'guarding' : avoid.following ? 'follow' : avoid.state) : 'watching')
            : 'off')
        : '-'
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0'), ss = String(elapsed % 60).padStart(2, '0')

    return (
        <div className="flex items-stretch h-9 font-mono overflow-x-auto [scrollbar-width:none]">
            <Cell icon={<Cloud size={13} />} value={cloudOk ? 'CLOUD' : connectionStatus.toUpperCase()}
                color={cloudOk ? '#4ade80' : connectionStatus === 'reconnecting' ? '#fbbf24' : '#f87171'}
                title="Browser to cloud (socket)" />
            <Cell icon={<Radio size={13} />}
                value={droneOk ? 'LINK' : t?.link_ok === false ? `LOST ${Math.round(t.link_lost_s ?? 0)}s` : 'NO LINK'}
                color={droneOk ? '#4ade80' : '#f87171'} title="Cloud to aircraft (MAVLink)" />
            <Cell value={t?.flight_mode.mode ?? '-'} color="#22d3ee" title="Flight mode" />
            <Cell value={armed ? 'ARMED' : 'DISARMED'} color={armed ? '#f87171' : '#a1a1aa'} />
            <Cell icon={<Battery size={13} />} value={bat != null ? `${Math.round(bat)}%` : '-'} color={batColor}
                title={t ? `${t.battery.voltage_v.toFixed(1)} V` : undefined} />
            <Cell icon={<Satellite size={13} />} value={t ? `${t.gps.satellites_visible}` : '-'}
                color={t && t.gps.fix_type >= 3 ? '#e5e7eb' : '#fbbf24'} title="GPS satellites" />
            <Cell icon={<Navigation size={13} />} label="HOME" value={t ? `${Math.round(t.home_distance_m)} m` : '-'} />
            <Cell icon={<Timer size={13} />} value={`${mm}:${ss}`} title="Flight time" />
            <Cell icon={<ShieldCheck size={13} />} label="AVOID"
                value={String(aState).toUpperCase()}
                color={aState === 'off' ? '#f87171' : aState === 'watching' ? '#fbbf24' : AVOID_COLOR[aState] ?? '#e5e7eb'}
                title={avoid?.reason || (aState === 'off' ? 'Avoidance is off' : aState === 'watching' ? 'Detecting only - Steer is off' : '')} />
            {avoid?.env === 'indoor' && (
                <Cell label="NAV" value="INDOOR" color="#fcd34d"
                    title={`${avoid.env_reason ?? ''} - position from ${avoid.pose_source === 'local' ? 'PX4 local' : 'GPS'}`} />
            )}
            {avoid?.sensor_mode && (
                <Cell label="SENSOR" value={avoid.sensor_mode === 'range' ? 'DEPTH' : avoid.sensor_mode === 'mono' ? 'CAMERA' : 'NONE'}
                    color={avoid.sensor_mode === 'none' ? '#f87171' : '#e5e7eb'} />
            )}
        </div>
    )
}
