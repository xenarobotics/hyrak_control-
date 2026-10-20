'use client'

// Command's own read-only status, placed in the global status bar through
// <StatusBarSlot>: distance home, what obstacle avoidance is doing, and the
// sensor faults that change what avoidance can do. These used to live in
// Command's own top strip (StatusStrip), which repeated the link, mode,
// battery and GPS the status bar already shows.

import { Home, ShieldCheck, ShieldOff, ScanEye, TriangleAlert } from 'lucide-react'
import { useDroneStore } from '@/store/drone'
import type { AvoidanceStatus } from '@/lib/avoidance'
import { BarStat, StatusBarSlot, type BarTone } from '@/components/layout/StatusBar'
import { actingFloorM } from './avoidFloor'

const AVOID_TONE: Record<string, BarTone> = {
    nominal: 'ok', avoiding: 'accent', holding: 'warn', returning: 'danger',
    rerouted: 'accent', climbing: 'accent', disabled: 'muted',
    guarding: 'accent', follow: 'ok',
}
const AVOID_WORD: Record<string, string> = {
    nominal: 'Clear', avoiding: 'Avoiding', holding: 'Holding', returning: 'Returning',
    rerouted: 'Rerouted', climbing: 'Climbing', disabled: 'Off', guarding: 'Guarding',
    follow: 'Following', watching: 'Watching', off: 'Off',
}

export function AvoidChips({ avoid }: { avoid: AvoidanceStatus | null }) {
    const t = useDroneStore(s => s.telemetry)
    const linked = useDroneStore(s => s.telemetryStatus) === 'connected'
    const inAir = t?.flight_mode.is_in_air ?? false

    const rangeLost = !!avoid && avoid.enabled && (avoid.params?.use_range_sensor ?? 1) !== 0
        && avoid.sensor_mode !== 'range' && inAir && !avoid.stale
    const aState = avoid?.stale ? 'stale' : avoid
        ? (avoid.enabled
            ? (avoid.armed ? (avoid.guarding ? 'guarding' : avoid.following ? 'follow' : avoid.state) : 'watching')
            : 'off')
        : null
    const floor = actingFloorM(avoid)
    const lowLeg = floor != null && inAir && !!t && t.position.relative_altitude_m < floor && !!avoid?.enabled

    const avoidTone: BarTone = aState === 'stale' ? 'danger'
        : aState === 'off' ? (inAir ? 'warn' : 'muted')
            : aState === 'watching' ? 'warn' : aState ? AVOID_TONE[aState] ?? 'text' : 'muted'
    const steering = !!avoid && !avoid.stale && avoid.enabled && avoid.armed
        && (avoid.guarding || ['avoiding', 'holding', 'returning', 'rerouted', 'climbing'].includes(avoid.state ?? ''))
    const avoidTitle = steering && !avoid?.guarding ? (avoid?.planner?.reason ?? avoid?.reason ?? 'Avoiding') : aState === 'stale' ? 'No answer from avoidance: what you see is old'
        : avoid?.reason || (aState === 'off' ? 'Obstacle avoidance is off'
            : aState === 'watching' ? 'Detecting only: Steer is off' : 'Obstacle avoidance')

    return (
        <StatusBarSlot>
            <BarStat icon={<Home size={15} />} tone={linked && t ? 'text' : 'muted'} title="Distance to home" label="Home">
                {linked && t ? `${Math.round(t.home_distance_m)} m` : <span className="text-app-text-muted">-</span>}
            </BarStat>
            <BarStat icon={aState === 'off' || !aState ? <ShieldOff size={15} /> : <ShieldCheck size={15} />}
                tone={avoidTone} strong={avoidTone === 'danger'} title={avoidTitle}>
                <span className="text-app-text-muted font-normal">Avoid</span>
                {aState === 'stale' ? `Stale ${avoid?.stale_s ?? 0}s` : aState ? AVOID_WORD[aState] ?? aState : '-'}
                {steering && avoid?.planner?.ttc_s != null && <span className="text-app-accent">{avoid.planner.ttc_s} s to contact</span>}
            </BarStat>
            {lowLeg && (
                <BarStat icon={<TriangleAlert size={15} />} tone="danger" strong
                    title={`Below the avoidance floor (${floor} m): avoidance can see obstacles but will not steer`}>
                    Below avoid floor
                </BarStat>
            )}
            {rangeLost && (
                <BarStat icon={<TriangleAlert size={15} />} tone="danger" strong
                    title="The range sensor stopped streaming: avoidance is on the camera (or blind) and its acting floor moved up">
                    Range sensor lost
                </BarStat>
            )}
            {avoid?.sensor_stale && !avoid.stale && (
                <BarStat icon={<ScanEye size={15} />} tone="danger" strong title="No scan has reached the map for 2 s">
                    Sensor blind
                </BarStat>
            )}
            {avoid?.env === 'indoor' && (
                <BarStat tone="warn" title={`${avoid.env_reason ?? ''} Position from ${avoid.pose_source === 'local' ? 'PX4 local' : 'GPS'}`}>
                    Indoor
                </BarStat>
            )}
            {avoid?.sensor_mode && (
                <BarStat tone={avoid.sensor_mode === 'none' ? 'danger' : 'muted'} strong={avoid.sensor_mode === 'none'}
                    title="What avoidance senses with">
                    <span className="text-app-text-muted font-normal">Sensor</span>
                    {avoid.sensor_mode === 'range' ? 'Depth' : avoid.sensor_mode === 'mono' ? 'Camera' : 'None'}
                </BarStat>
            )}
        </StatusBarSlot>
    )
}
