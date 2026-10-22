'use client'

// Config > Camera & gimbal. QGroundControl's Camera page (PX4 camera
// trigger: TRIG_*) and Gimbal page (PX4 gimbal driver: MNT_*), on the
// aircraft's parameters. Video itself is set up on Fly.

import React from 'react'
import { useVehicleParams } from '@/lib/vehicleParams'
import { Grid, Note, Panel, ParamRow, ParamSourceBar, ReloadButton, type ParamSpec } from '@/components/config/kit'

const TRIGGER: ParamSpec[] = [
    { key: 'TRIG_MODE', label: 'Trigger mode', def: 0, options: [
        { value: 0, label: 'Disabled' },
        { value: 1, label: 'Time based, on command' },
        { value: 2, label: 'Time based, always on' },
        { value: 3, label: 'Distance based, always on' },
        { value: 4, label: 'Distance based, on command (survey)' },
    ], tip: 'When PX4 fires the camera. Survey missions use distance based, on command. Needs a reboot.' },
    { key: 'TRIG_INTERFACE', label: 'Interface', def: 4, options: [
        { value: 1, label: 'GPIO' }, { value: 2, label: 'Seagull MAP2 (PWM)' }, { value: 3, label: 'MAVLink (camera protocol)' },
        { value: 4, label: 'Generic PWM (IR trigger, servo)' }, { value: 5, label: 'MAVLink (forward to companion)' },
    ], tip: 'How the trigger signal reaches the camera.' },
    { key: 'TRIG_INTERVAL', label: 'Interval', unit: 'ms', def: 40, min: 4, max: 10000, decimals: 0, tip: 'Time between photos in the time based modes.' },
    { key: 'TRIG_DISTANCE', label: 'Distance', unit: 'm', def: 25, min: 0, max: 1000, decimals: 1, tip: 'Distance between photos in the distance based modes.' },
    { key: 'TRIG_ACT_TIME', label: 'Pulse length', unit: 'ms', def: 40, min: 0, max: 3000, decimals: 1 },
    { key: 'TRIG_POLARITY', label: 'Polarity', def: 0, options: [{ value: 0, label: 'Active low' }, { value: 1, label: 'Active high' }] },
    { key: 'CAM_CAP_FBACK', label: 'Hot-shoe feedback', bool: true, def: 0, tip: 'Use the camera\'s hot-shoe signal to log exactly when each photo was taken.' },
]

const GIMBAL: ParamSpec[] = [
    { key: 'MNT_MODE_IN', label: 'Input', def: -1, options: [
        { value: -1, label: 'Disabled' }, { value: 0, label: 'Auto (RC and MAVLink)' }, { value: 1, label: 'RC only' },
        { value: 2, label: 'MAVLink ROI' }, { value: 3, label: 'MAVLink do-mount' }, { value: 4, label: 'MAVLink gimbal protocol v2' },
    ], tip: 'Where gimbal commands come from. Needs a reboot.' },
    { key: 'MNT_MODE_OUT', label: 'Output', def: 0, options: [
        { value: 0, label: 'Aux outputs (PWM servos)' }, { value: 1, label: 'MAVLink gimbal protocol v1' }, { value: 2, label: 'MAVLink gimbal protocol v2' },
    ], tip: 'How PX4 drives the gimbal.' },
    { key: 'MNT_DO_STAB', label: 'Stabilise', def: 0, options: [
        { value: 0, label: 'Off' }, { value: 1, label: 'All axes' }, { value: 2, label: 'Yaw only (lock)' }, { value: 3, label: 'Pitch only' },
    ], tip: 'PX4 stabilisation for servo gimbals. Brushless gimbals stabilise themselves.' },
    { key: 'MNT_MAN_PITCH', label: 'Pitch RC channel', def: 0, options: [{ value: 0, label: 'None' }, ...Array.from({ length: 6 }, (_, i) => ({ value: i + 1, label: `AUX ${i + 1}` }))] },
    { key: 'MNT_MAN_ROLL', label: 'Roll RC channel', def: 0, options: [{ value: 0, label: 'None' }, ...Array.from({ length: 6 }, (_, i) => ({ value: i + 1, label: `AUX ${i + 1}` }))] },
    { key: 'MNT_MAN_YAW', label: 'Yaw RC channel', def: 0, options: [{ value: 0, label: 'None' }, ...Array.from({ length: 6 }, (_, i) => ({ value: i + 1, label: `AUX ${i + 1}` }))] },
    { key: 'MNT_RANGE_PITCH', label: 'Pitch range', unit: '°', def: 90, min: 1, max: 720, decimals: 0 },
    { key: 'MNT_RANGE_ROLL', label: 'Roll range', unit: '°', def: 90, min: 1, max: 720, decimals: 0 },
    { key: 'MNT_RANGE_YAW', label: 'Yaw range', unit: '°', def: 360, min: 1, max: 720, decimals: 0 },
    { key: 'MNT_MAV_SYSID', label: 'Gimbal MAVLink system', def: 1, min: 1, max: 255, decimals: 0 },
    { key: 'MNT_MAV_COMPID', label: 'Gimbal MAVLink component', def: 154, min: 1, max: 255, decimals: 0 },
]

export function CameraGimbalSetup() {
    const vp = useVehicleParams()
    const noTrig = vp.ready && !vp.has('TRIG_MODE')
    const noMnt = vp.ready && !vp.has('MNT_MODE_IN')
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}><ParamSourceBar what="camera trigger and gimbal settings" /></div>
                <ReloadButton />
            </div>
            <Grid min={340}>
                <Panel title="Camera trigger" hint="photos for surveys and mapping">
                    {noTrig ? <Note>This firmware build has no camera trigger module.</Note> : TRIGGER.map(s => <ParamRow key={s.key} spec={s} />)}
                </Panel>
                <Panel title="Gimbal" hint="how PX4 points the camera">
                    {noMnt ? <Note>This firmware build has no gimbal driver.</Note> : GIMBAL.map(s => <ParamRow key={s.key} spec={s} />)}
                </Panel>
            </Grid>
            <p style={{ margin: 0, fontSize: 13, color: 'hsl(var(--app-text-muted))' }}>Mode and interface changes take effect after the flight controller reboots (Advanced, Reboot).</p>
        </div>
    )
}
