'use client'

// Config > Flight & tuning. QGroundControl's Tuning page plus the flight
// behaviour limits it keeps under Parameters: speeds and takeoff height,
// hover thrust and thrust curve, the rate / attitude / velocity / position
// controller gains with a live setpoint vs response chart (tuning/), and
// PX4's in-flight autotune.

import React, { useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { useVehicleParams, writeParam } from '@/lib/vehicleParams'
import { Btn, Chip, Dialog, Grid, Note, NumberBox, Panel, ParamRow, ParamSourceBar, ReloadButton, SubTabs, T, Tip, mix, type ParamSpec } from '@/components/config/kit'
import { ATT, POS, RATE, RATE_COLS, VEL } from '@/components/config/tuning/gains'
import { LiveTuning } from '@/components/config/tuning/LiveTuning'

const BEHAVIOUR: ParamSpec[] = [
    { key: 'MIS_TAKEOFF_ALT', label: 'Takeoff height', unit: 'm', def: 2.5, min: 0, max: 100, decimals: 1, tip: 'Height an automatic takeoff climbs to.' },
    { key: 'MPC_XY_VEL_MAX', label: 'Max horizontal speed', unit: 'm/s', def: 12, min: 0, max: 20, decimals: 1, tip: 'Fastest the aircraft moves in Position mode and missions.' },
    { key: 'MPC_XY_CRUISE', label: 'Mission cruise speed', unit: 'm/s', def: 5, min: 3, max: 20, decimals: 1, tip: 'Default speed between mission waypoints.' },
    { key: 'MPC_Z_VEL_MAX_UP', label: 'Max climb rate', unit: 'm/s', def: 3, min: 0.5, max: 8, decimals: 1 },
    { key: 'MPC_Z_VEL_MAX_DN', label: 'Max descent rate', unit: 'm/s', def: 1.5, min: 0.5, max: 4, decimals: 1, tip: 'Above 2 m/s risks descending through its own propwash.' },
    { key: 'MPC_TKO_SPEED', label: 'Takeoff climb rate', unit: 'm/s', def: 1.5, min: 1, max: 5, decimals: 1 },
    { key: 'MPC_TILTMAX_AIR', label: 'Max tilt', unit: '°', def: 45, min: 20, max: 89, decimals: 0, tip: 'Steepest lean in any automatic or assisted mode.' },
    { key: 'MPC_ACC_HOR', label: 'Horizontal acceleration', unit: 'm/s²', def: 3, min: 2, max: 15, decimals: 1, tip: 'How briskly it speeds up and slows down in automatic flight.' },
    { key: 'NAV_ACC_RAD', label: 'Waypoint radius', unit: 'm', def: 2, min: 0.05, max: 200, decimals: 2, tip: 'How close counts as reaching a waypoint.' },
]

const HOVER: ParamSpec[] = [
    { key: 'MPC_THR_HOVER', label: 'Hover thrust', unit: '%', scale: 100, def: 0.5, min: 10, max: 80, decimals: 0, tip: 'Throttle that holds a hover. With the estimator on, PX4 learns it in flight and this is only the starting point.' },
    { key: 'MPC_USE_HTE', label: 'Learn hover thrust in flight', bool: true, def: 1, tip: 'PX4\'s hover thrust estimator. Leave on unless you have a reason.' },
    { key: 'THR_MDL_FAC', label: 'Thrust curve', def: 0, min: 0, max: 1, decimals: 2, tip: 'Linearises motor thrust against throttle. 0 = linear (PWM ESCs), around 0.3 for many DShot / RPM-controlled setups.' },
    { key: 'MC_AIRMODE', label: 'Airmode', options: [{ value: 0, label: 'Off' }, { value: 1, label: 'Roll and pitch' }, { value: 2, label: 'Roll, pitch and yaw' }], def: 0, tip: 'Keeps attitude control at zero throttle. Useful for acro; leave off for most aerial work.' },
]

export function TuningSetup() {
    const [tab, setTab] = useState<'behaviour' | 'gains' | 'autotune'>('behaviour')
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}><ParamSourceBar what="flight behaviour and gains" /></div>
                <ReloadButton />
            </div>
            <SubTabs label="Tuning" value={tab} onChange={setTab} tabs={[
                { id: 'behaviour', label: 'Behaviour' },
                { id: 'gains', label: 'Controller gains' },
                { id: 'autotune', label: 'Hover and autotune' },
            ]} />
            {tab === 'behaviour' && (
                <Panel title="Speeds and heights" hint="for Position mode, missions and HYRAK's automatic flight">
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', columnGap: 32 }}>
                        {BEHAVIOUR.map(s => <ParamRow key={s.key} spec={s} />)}
                    </div>
                </Panel>
            )}
            {tab === 'gains' && <Gains />}
            {tab === 'autotune' && (
                <Grid min={340}>
                    <Panel title="Hover and thrust">{HOVER.map(s => <ParamRow key={s.key} spec={s} />)}</Panel>
                    <Autotune />
                </Grid>
            )}
        </div>
    )
}

function Gains() {
    const vp = useVehicleParams()
    const COLS = RATE_COLS
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Note>Change one gain at a time, by 10 to 20 %, and fly between changes. Autotune (next tab) does this for you on most multirotors.</Note>
            <LiveTuning />
            <Panel title="Rate controller" hint="the innermost loop: how hard it fights a rotation"
                right={<Tip text="PX4 uses the parallel form: output = K x (P x error + I x integral + D x rate of change) + FF x setpoint. K scales the whole axis." />}>
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ borderCollapse: 'collapse', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                        <thead><tr>
                            <th style={TH} />
                            {COLS.map(c => <th key={c} style={TH}>{c}</th>)}
                        </tr></thead>
                        <tbody>
                            {RATE.map(row => (
                                <tr key={row.axis}>
                                    <td style={{ ...TD, fontWeight: 700, fontSize: 14 }}>{row.axis}</td>
                                    {row.cells.map(c => {
                                        const live = vp.get(c.key)
                                        const missing = vp.ready && live == null
                                        return (
                                            <td key={c.key} style={TD} title={c.key}>
                                                <span style={{ display: 'inline-flex', borderRadius: 7, outline: vp.pending[c.key] ? `2px solid ${mix('var(--app-accent)', 50)}` : vp.failed[c.key] ? `2px solid ${mix('var(--app-danger)', 60)}` : undefined }}>
                                                    <NumberBox label={`${row.axis} ${c.key}`} value={vp.ready ? live : c.def} disabled={!vp.ready || missing}
                                                        onCommit={v => writeParam(c.key, v)} min={0} max={c.key.endsWith('_K') ? 5 : 2} decimals={c.key.endsWith('_D') ? 4 : 3} width={84}
                                                        placeholder={missing ? 'n/a' : undefined} />
                                                </span>
                                            </td>
                                        )
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </Panel>
            <Grid min={320}>
                <Panel title="Attitude controller" hint="how quickly it levels out">{ATT.map(s => <ParamRow key={s.key} spec={s} compact />)}</Panel>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <Panel title="Velocity controller">{VEL.map(s => <ParamRow key={s.key} spec={s} compact />)}</Panel>
                    <Panel title="Position controller">{POS.map(s => <ParamRow key={s.key} spec={s} compact />)}</Panel>
                </div>
            </Grid>
        </div>
    )
}

const TH: React.CSSProperties = { padding: '6px 8px', fontWeight: 600, fontSize: 12, color: T.muted, textAlign: 'left', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { padding: '6px 8px', borderBottom: `1px solid ${T.border}`, color: T.text, whiteSpace: 'nowrap' }

/** PX4's multicopter autotune (MC_AT_*). It runs in the air, in Hold or
 *  Position mode: the aircraft twitches on each axis for about a minute. */
function Autotune() {
    const vp = useVehicleParams()
    const fm = useDroneStore(s => s.telemetry?.flight_mode)
    const [open, setOpen] = useState(false)
    const has = vp.has('MC_AT_EN')
    const enabled = (vp.get('MC_AT_EN') ?? 0) === 1
    const running = (vp.get('MC_AT_START') ?? 0) === 1
    const mode = (fm?.mode ?? '').toUpperCase()
    const okMode = /HOLD|LOITER|POSCTL|POSITION/.test(mode)
    const canStart = vp.ready && has && enabled && !!fm?.is_armed && !!fm?.is_in_air && okMode
    return (
        <Panel title="Autotune" hint="PX4 tunes the rate and attitude gains in flight" right={running ? <Chip tone="warn">Running</Chip> : undefined}>
            {vp.ready && !has && <Note tone="warn">This firmware has no autotune module (MC_AT_EN missing). It ships with PX4 1.13 and newer.</Note>}
            <ParamRow spec={{ key: 'MC_AT_EN', label: 'Allow autotune', bool: true, def: 0 }} />
            <ParamRow spec={{ key: 'MC_AT_APPLY', label: 'Apply new gains', def: 1, options: [
                { value: 0, label: 'Do not apply (review only)' },
                { value: 1, label: 'After landing and disarm' },
                { value: 2, label: 'Straight away, in flight' },
            ] }} />
            <ParamRow spec={{ key: 'MC_AT_SYSID_AMP', label: 'Excitation amplitude', def: 0.7, min: 0.1, max: 6, decimals: 2, tip: 'How hard each test twitch is. Lower it for a fragile airframe.' }} />
            <p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.55 }}>
                Take off, hover in Hold or Position mode with room around you, then start. The aircraft twitches on roll, pitch and yaw for about a minute. Switching mode stops it.
            </p>
            <Btn kind="primary" disabled={!canStart || running} onClick={() => setOpen(true)}
                title={!canStart ? 'Needs autotune allowed, the aircraft flying, and Hold or Position mode' : undefined}>Start autotune</Btn>
            <Dialog open={open} onClose={() => setOpen(false)} title="Start autotune">
                <Note tone="warn">The aircraft will wobble deliberately for about a minute. Keep the transmitter in hand; switching flight mode stops autotune.</Note>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <Btn onClick={() => setOpen(false)}>Cancel</Btn>
                    <Btn kind="primary" onClick={() => { writeParam('MC_AT_START', 1); setOpen(false) }}>Start</Btn>
                </div>
            </Dialog>
        </Panel>
    )
}
