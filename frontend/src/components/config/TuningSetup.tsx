'use client'

// Config > Tuning. QGroundControl's Tuning page: hover thrust and thrust
// curve, the multicopter rate / attitude / velocity / position controller
// gains with a live setpoint vs response chart (tuning/), PX4's in-flight
// autotune, and for planes and VTOLs the fixed-wing gains, TECS, path
// following, airspeeds and throttle (tuning/FixedWingTuning.tsx). Speeds,
// heights and other flight behaviour limits are on Config > Flight behaviour.

import React, { useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { useVehicleParams, writeParam } from '@/lib/vehicleParams'
import { Btn, Chip, Dialog, Grid, Note, NumberBox, Panel, ParamRow, ParamSourceBar, ReloadButton, SubTabs, T, Tip, mix, type ParamSpec } from '@/components/config/kit'
import { ATT, POS, RATE, RATE_COLS, VEL } from '@/components/config/tuning/gains'
import { LiveTuning } from '@/components/config/tuning/LiveTuning'
import { FixedWingTuning } from '@/components/config/tuning/FixedWingTuning'
import { useVehicleClass, WriteLog } from '@/components/config/setupKit'

const HOVER: ParamSpec[] = [
    { key: 'MPC_THR_HOVER', label: 'Hover thrust', unit: '%', scale: 100, def: 0.5, min: 10, max: 80, decimals: 0, tip: 'Throttle that holds a hover. With the estimator on, PX4 learns it in flight and this is only the starting point.' },
    { key: 'MPC_USE_HTE', label: 'Learn hover thrust in flight', bool: true, def: 1, tip: 'PX4\'s hover thrust estimator. Leave on unless you have a reason.' },
    { key: 'THR_MDL_FAC', label: 'Thrust curve', def: 0, min: 0, max: 1, decimals: 2, tip: 'Linearises motor thrust against throttle. 0 = linear (PWM ESCs), around 0.3 for many DShot / RPM-controlled setups.' },
    { key: 'MC_AIRMODE', label: 'Airmode', options: [{ value: 0, label: 'Off' }, { value: 1, label: 'Roll and pitch' }, { value: 2, label: 'Roll, pitch and yaw' }], def: 0, tip: 'Keeps attitude control at zero throttle. Useful for acro; leave off for most aerial work.' },
]

type TuningTab = 'gains' | 'fixedwing' | 'autotune'

export function TuningSetup() {
    const vc = useVehicleClass()
    // A pure plane has no multicopter loops to tune; a VTOL has both.
    const mc = !(vc.ready && vc.plane && !vc.vtol)
    const tabs: { id: TuningTab; label: string }[] = [
        ...(mc ? [{ id: 'gains' as const, label: vc.fw ? 'Multicopter gains' : 'Controller gains' }] : []),
        ...(vc.fw ? [{ id: 'fixedwing' as const, label: 'Fixed-wing' }] : []),
        ...(mc ? [{ id: 'autotune' as const, label: 'Hover and autotune' }] : []),
    ]
    const [picked, setTab] = useState<TuningTab>('gains')
    const tab = tabs.some(t => t.id === picked) ? picked : tabs[0].id
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}><ParamSourceBar what="controller gains" /></div>
                <ReloadButton />
            </div>
            <SubTabs label="Tuning" value={tab} onChange={setTab} tabs={tabs} />
            {tab === 'gains' && <Gains fw={vc.ready && vc.fw} />}
            {tab === 'fixedwing' && <FixedWingTuning />}
            {tab === 'autotune' && (
                <Grid min={340}>
                    <Panel title="Hover and thrust">{HOVER.map(s => <ParamRow key={s.key} spec={s} />)}</Panel>
                    <Autotune />
                </Grid>
            )}
            <WriteLog />
        </div>
    )
}

function Gains({ fw }: { fw: boolean }) {
    const vp = useVehicleParams()
    const COLS = RATE_COLS
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Note>Change one gain at a time, by 10 to 20 %, and fly between changes. Autotune (next tab) does this for you on most multirotors.</Note>
            <LiveTuning fw={fw} />
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
