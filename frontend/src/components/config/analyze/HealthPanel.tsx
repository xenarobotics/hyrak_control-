'use client'

// Config > Analyze > Health: the estimator's innovation test ratios
// (ESTIMATOR_STATUS), what the autopilot says about every sensor and
// controller it has (SYS_STATUS present / enabled / healthy bits), and its
// latest messages (STATUSTEXT). All read passively off the session's own
// link (lib/configLive) and the session's message log (store/drone).

import React, { useState } from 'react'
import { Check, AlertTriangle, WifiOff } from 'lucide-react'
import { Chip, Grid, Note, Panel, T, Tip, Toggle } from '@/components/config/kit'
import { useConfigLive } from '@/lib/configLive'
import { useDroneStore } from '@/store/drone'
import { LevelBar, LevelScale } from './LevelBar'

const RATIOS: { key: 'vel_ratio' | 'pos_horiz_ratio' | 'pos_vert_ratio' | 'mag_ratio' | 'hagl_ratio' | 'tas_ratio'; label: string; hint: string }[] = [
    { key: 'vel_ratio', label: 'Velocity', hint: 'GPS / flow speed' },
    { key: 'pos_horiz_ratio', label: 'Horizontal position', hint: 'GPS / vision' },
    { key: 'pos_vert_ratio', label: 'Vertical position', hint: 'baro / GPS height' },
    { key: 'mag_ratio', label: 'Magnetometer', hint: 'compass heading' },
    { key: 'hagl_ratio', label: 'Height above ground', hint: 'range finder' },
    { key: 'tas_ratio', label: 'Airspeed', hint: 'airspeed sensor' },
]

/** ESTIMATOR_STATUS_FLAGS: what the estimator currently has a good solution for. */
const EKF_FLAGS: { bit: number; label: string; bad?: boolean }[] = [
    { bit: 1, label: 'Attitude' },
    { bit: 2, label: 'Horizontal velocity' },
    { bit: 4, label: 'Vertical velocity' },
    { bit: 8, label: 'Relative horizontal position' },
    { bit: 16, label: 'Absolute horizontal position' },
    { bit: 32, label: 'Absolute vertical position' },
    { bit: 64, label: 'Height above ground' },
    { bit: 128, label: 'Constant position mode (no position aid)', bad: true },
    { bit: 1024, label: 'GPS glitch', bad: true },
    { bit: 2048, label: 'Accelerometer error', bad: true },
]

/** MAV_SYS_STATUS_SENSOR bits, in plain words. */
const SENSORS: string[] = [
    'Gyroscope', 'Accelerometer', 'Magnetometer', 'Barometer', 'Airspeed (differential pressure)', 'GPS',
    'Optical flow', 'Vision position', 'Laser position', 'External ground truth', 'Rate control', 'Attitude stabilisation',
    'Yaw position', 'Altitude control', 'Position control', 'Motor outputs', 'RC receiver', 'Gyroscope 2',
    'Accelerometer 2', 'Magnetometer 2', 'Geofence', 'Attitude estimate (AHRS)', 'Terrain', 'Reverse motor',
    'Logging', 'Battery', 'Proximity', 'Satellite link', 'Pre-arm checks', 'Obstacle avoidance', 'Propulsion',
]

type SensorState = 'ok' | 'fault' | 'off'

function sensorList(present: number, enabled: number, health: number): { bit: number; label: string; state: SensorState }[] {
    const out: { bit: number; label: string; state: SensorState }[] = []
    SENSORS.forEach((label, bit) => {
        const m = 2 ** bit
        // >>> 0 keeps bit 31 positive; JS bit ops are signed 32-bit.
        if (!(((present >>> 0) & m) >>> 0)) return
        const en = ((enabled >>> 0) & m) >>> 0
        const ok = ((health >>> 0) & m) >>> 0
        out.push({ bit, label, state: !en ? 'off' : ok ? 'ok' : 'fault' })
    })
    return out
}

/** MAVSDK's ordering: 0 DEBUG ... 7 EMERGENCY. */
const sevColor = (rank: number) => rank >= 4 ? T.danger : rank === 3 ? T.warn : rank === 2 ? T.accent : T.muted

export function HealthPanel() {
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const fcMessages = useDroneStore(s => s.fcMessages)
    const { data, at } = useConfigLive(true)
    const [showOff, setShowOff] = useState(false)
    const est = data.ESTIMATOR_STATUS
    const sys = data.SYS_STATUS

    if (!connected) {
        return (
            <Note icon={<WifiOff size={15} style={{ color: T.muted, flexShrink: 0, marginTop: 2 }} />}>
                <b>No drone connected.</b> Connect one from the Fly tab to read its estimator and sensor health.
            </Note>
        )
    }
    const flags = est?.flags ?? null
    const sensors = sys && sys.onboard_control_sensors_present != null
        ? sensorList(sys.onboard_control_sensors_present, sys.onboard_control_sensors_enabled ?? 0, sys.onboard_control_sensors_health ?? 0)
        : null
    const faults = sensors?.filter(x => x.state === 'fault') ?? []
    const shownSensors = sensors?.filter(x => showOff || x.state !== 'off') ?? []
    const worstRatio = est ? Math.max(...RATIOS.map(r => est[r.key] ?? 0)) : null
    const recent = fcMessages.slice(-40).reverse()

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Grid min={360}>
                <Panel title="Estimator test ratios" hint="how far each sensor disagrees with the estimate"
                    right={worstRatio != null ? <Chip tone={worstRatio > 1 ? 'danger' : worstRatio >= 0.5 ? 'warn' : 'ok'}>{worstRatio > 1 ? 'A sensor is rejected' : worstRatio >= 0.5 ? 'Watch' : 'All consistent'}</Chip> : undefined}>
                    {!est && at > 0 && <Note>No ESTIMATOR_STATUS from this drone yet. PX4 sends it on most links; the MAVLink Inspector tab shows what arrives.</Note>}
                    {RATIOS.map(r => <LevelBar key={r.key} label={r.label} hint={r.hint} value={est?.[r.key]} max={1.5} warnAt={0.5} badAt={1} decimals={2} zeroUnused />)}
                    <LevelScale max={1.5} warnAt={0.5} badAt={1} decimals={1} />
                    <p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.5 }}>
                        Below 0.5 is healthy. Between 0.5 and 1 the sensor is drifting from the estimate. Above 1 the estimator rejects that sensor&apos;s data. A ratio of exactly 0 means the estimator is not using that sensor.
                    </p>
                    {est && (est.pos_horiz_accuracy != null || est.pos_vert_accuracy != null) && (
                        <p style={{ margin: 0, fontSize: 13, color: T.text }}>
                            Position accuracy: {est.pos_horiz_accuracy != null ? `${est.pos_horiz_accuracy.toFixed(2)} m horizontal` : ''}{est.pos_horiz_accuracy != null && est.pos_vert_accuracy != null ? ', ' : ''}{est.pos_vert_accuracy != null ? `${est.pos_vert_accuracy.toFixed(2)} m vertical` : ''}
                        </p>
                    )}
                </Panel>
                <Panel title="Estimator solution" hint="what it can estimate now">
                    {flags == null ? <span style={{ fontSize: 13, color: T.muted }}>{at > 0 ? 'No estimator status yet.' : 'Listening...'}</span> : (
                        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {EKF_FLAGS.filter(f => !f.bad || (flags & f.bit)).map(f => {
                                const on = (flags & f.bit) !== 0
                                const good = f.bad ? !on : on
                                return (
                                    <li key={f.bit} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: good ? T.text : f.bad ? T.danger : T.muted }}>
                                        {good ? <Check size={15} strokeWidth={3} style={{ color: T.ok, flexShrink: 0 }} aria-label="Yes" />
                                            : f.bad ? <AlertTriangle size={15} style={{ color: T.danger, flexShrink: 0 }} aria-label="Warning" />
                                                : <span aria-label="No" style={{ width: 15, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}><span style={{ width: 9, height: 2, borderRadius: 1, background: T.subtle }} /></span>}
                                        {f.label}
                                    </li>
                                )
                            })}
                        </ul>
                    )}
                </Panel>
            </Grid>
            <Grid min={360}>
                <Panel title="Sensors and controllers" hint="as the autopilot reports them"
                    right={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: T.muted }}>
                        Show turned off <Toggle label="Show sensors that are turned off" value={showOff} onChange={setShowOff} />
                    </span>}>
                    {!sensors ? <span style={{ fontSize: 13, color: T.muted }}>{at > 0 ? 'No SYS_STATUS from this drone yet.' : 'Listening...'}</span> : (
                        <>
                            {faults.length > 0 && <Note tone="warn">Unhealthy: {faults.map(f => f.label).join(', ')}.</Note>}
                            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 220px), 1fr))', gap: '6px 16px' }}>
                                {shownSensors.map(x => (
                                    <li key={x.bit} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, minHeight: 26, color: x.state === 'off' ? T.muted : T.text }}>
                                        {x.state === 'ok' ? <Check size={15} strokeWidth={3} style={{ color: T.ok, flexShrink: 0 }} aria-label="Healthy" />
                                            : x.state === 'fault' ? <AlertTriangle size={15} style={{ color: T.danger, flexShrink: 0 }} aria-label="Unhealthy" />
                                                : <span aria-label="Turned off" style={{ width: 15, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}><span style={{ width: 9, height: 2, borderRadius: 1, background: T.subtle }} /></span>}
                                        <span style={{ flex: 1, minWidth: 0 }}>{x.label}</span>
                                        <span style={{ fontSize: 12, fontWeight: 700, color: x.state === 'ok' ? T.ok : x.state === 'fault' ? T.danger : T.muted }}>{x.state === 'ok' ? 'Healthy' : x.state === 'fault' ? 'Problem' : 'Off'}</span>
                                    </li>
                                ))}
                            </ul>
                            {sys?.load != null && <p style={{ margin: 0, fontSize: 13, color: T.muted }}>Flight controller CPU load: <b style={{ color: T.text }}>{(sys.load / 10).toFixed(1)}%</b></p>}
                        </>
                    )}
                </Panel>
                <Panel title="Autopilot messages" hint="newest first" right={<Tip text="The text messages the flight controller sends (STATUSTEXT): preflight check results, estimator and GPS changes, failsafes. The same log as the message button in the status bar." />}>
                    {recent.length === 0 ? <span style={{ fontSize: 13, color: T.muted }}>No messages from the autopilot yet in this session.</span> : (
                        <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column' }} className="divide-y divide-app-border">
                            {recent.map(msg => (
                                <li key={msg.id} style={{ display: 'flex', gap: 10, padding: '6px 0', fontSize: 13, lineHeight: 1.45 }}>
                                    <span style={{ color: T.muted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', flexShrink: 0 }}>{new Date(msg.ts * 1000).toLocaleTimeString([], { hour12: false })}</span>
                                    <span style={{ fontSize: 12, fontWeight: 700, color: sevColor(msg.rank), width: 64, flexShrink: 0, textTransform: 'capitalize' }}>{msg.severity.toLowerCase()}</span>
                                    <span style={{ color: T.text, minWidth: 0, overflowWrap: 'anywhere' }}>{msg.text}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </Panel>
            </Grid>
        </div>
    )
}
