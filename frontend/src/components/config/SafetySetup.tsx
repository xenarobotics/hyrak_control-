'use client'

// Config > Safety. QGroundControl's Safety page on the aircraft's own
// parameters: low battery, RC loss, data link loss, Offboard loss (the one
// that matters most when the cloud is the companion computer), geofence,
// return home, landing, and arming hardware. On top, the same failsafe rules
// HYRAK checks before every arm and takeoff (backend
// app/telemetry/failsafe_check.py), so a setting that will block arming is
// visible here, not discovered on the flight line.

import React from 'react'
import { ShieldCheck } from 'lucide-react'
import { useMissionStore } from '@/store/mission'
import { useVehicleParams, writeParam } from '@/lib/vehicleParams'
import { Chip, Grid, Note, Panel, ParamRow, ParamSourceBar, ReloadButton, T, Toggle, mix, type ParamSpec } from '@/components/config/kit'
import { LOW_BAT_ACT_SPEC } from '@/components/config/PowerSetup'

const LOSS_OPTS = [
    { value: 0, label: 'Disabled' },
    { value: 1, label: 'Hold' },
    { value: 2, label: 'Return' },
    { value: 3, label: 'Land' },
    { value: 5, label: 'Terminate (motors off)' },
    { value: 6, label: 'Lockdown' },
]
const OBL_OPTS = [
    { value: 0, label: 'Position' }, { value: 1, label: 'Altitude' }, { value: 2, label: 'Manual' },
    { value: 3, label: 'Return' }, { value: 4, label: 'Land' }, { value: 5, label: 'Hold' },
    { value: 6, label: 'Terminate (motors off)' }, { value: 7, label: 'Disarm' },
]
const GF_OPTS = [
    { value: 0, label: 'None' }, { value: 1, label: 'Warning' }, { value: 2, label: 'Hold' },
    { value: 3, label: 'Return' }, { value: 4, label: 'Terminate' }, { value: 5, label: 'Land' },
]

const S = {
    rcAct: { key: 'NAV_RCL_ACT', label: 'Action', options: LOSS_OPTS, def: 2, tip: 'What PX4 does when the RC receiver loses the transmitter.' },
    rcT: { key: 'COM_RC_LOSS_T', label: 'Timeout', unit: 's', def: 0.5, min: 0, max: 35, step: 0.1, decimals: 1, tip: 'How long without RC before the action starts.' },
    dlAct: { key: 'NAV_DLL_ACT', label: 'Action', options: LOSS_OPTS, def: 0, tip: 'What PX4 does when it stops hearing the ground station. In HYRAK the ground station is the cloud.' },
    dlT: { key: 'COM_DL_LOSS_T', label: 'Timeout', unit: 's', def: 10, min: 5, max: 300, step: 1, decimals: 0, tip: 'How long without the ground station before the action starts.' },
    oblAct: { key: 'COM_OBL_RC_ACT', label: 'Action', options: OBL_OPTS, def: 0, tip: 'What PX4 does when Offboard setpoints stop. HYRAK flies tracking, follow and avoidance in Offboard.' },
    oblT: { key: 'COM_OF_LOSS_T', label: 'Timeout', unit: 's', def: 1, min: 0, max: 60, step: 0.1, decimals: 1, tip: 'How long without an Offboard setpoint before the action starts.' },
    gfAct: { key: 'GF_ACTION', label: 'Breach action', options: GF_OPTS, def: 2, tip: 'What PX4 does when the aircraft crosses a fence.' },
    gfR: { key: 'GF_MAX_HOR_DIST', label: 'Max distance from home', unit: 'm', def: 0, min: 0, max: 10000, step: 10, decimals: 0, tip: '0 = no limit.' },
    gfH: { key: 'GF_MAX_VER_DIST', label: 'Max height above home', unit: 'm', def: 0, min: 0, max: 10000, step: 5, decimals: 0, tip: '0 = no limit.' },
    rtlAlt: { key: 'RTL_RETURN_ALT', label: 'Climb to', unit: 'm', def: 60, min: 0, max: 6000, step: 1, decimals: 0, tip: 'Height above home the aircraft climbs to before flying back. Clear every obstacle on the way.' },
    rtlDesc: { key: 'RTL_DESCEND_ALT', label: 'Descend to', unit: 'm', def: 30, min: 2, max: 6000, step: 1, decimals: 0, tip: 'Height above home it descends to before the final landing or loiter.' },
    landSpd: { key: 'MPC_LAND_SPEED', label: 'Final descent speed', unit: 'm/s', def: 0.7, min: 0.6, max: 3, step: 0.1, decimals: 1, tip: 'Speed of the last part of a landing.' },
    disarmLand: { key: 'COM_DISARM_LAND', label: 'Disarm after landing', unit: 's', def: 2, min: -1, max: 20, step: 0.5, decimals: 1, tip: '-1 = never disarm automatically.' },
    disarmPre: { key: 'COM_DISARM_PRFLT', label: 'Disarm if not taken off within', unit: 's', def: 10, min: -1, max: 20, step: 1, decimals: 0, tip: '-1 = never.' },
    prearm: { key: 'COM_PREARM_MODE', label: 'Prearm mode', options: [{ value: 0, label: 'Disabled' }, { value: 1, label: 'Safety button' }, { value: 2, label: 'Always' }], def: 0, tip: 'When outputs other than motors (servos) go live.' },
    hitl: { key: 'SYS_HITL', label: 'Simulation mode', options: [{ value: -1, label: 'External HITL' }, { value: 0, label: 'Off (real flight)' }, { value: 1, label: 'HITL' }, { value: 2, label: 'SIH' }], def: 0, tip: 'Hardware-in-the-loop. Must be Off for real flight. Needs a reboot.' },
} satisfies Record<string, ParamSpec>

/** The same rules as backend app/telemetry/failsafe_check.py evaluate(). */
function evaluate(p: (k: string) => number | null): { block: string[]; warn: string[] } {
    const block: string[] = [], warn: string[] = []
    const dll = p('NAV_DLL_ACT'), obl = p('COM_OBL_RC_ACT'), t = p('COM_DL_LOSS_T'), of = p('COM_OF_LOSS_T')
    if (dll === 0) block.push('Data link loss action is Disabled: the aircraft does nothing if the cloud link is lost. Set Hold or Return.')
    else if (dll === 5 || dll === 6) block.push(`Data link loss action is ${dll === 5 ? 'Terminate: a link loss would cut the motors' : 'Lockdown: a link loss would freeze the aircraft'}. Set Hold or Return.`)
    if (obl === 6 || obl === 7) block.push(`Offboard loss action is ${obl === 6 ? 'Terminate' : 'Disarm'}: losing cloud control would ${obl === 6 ? 'cut the motors' : 'disarm in the air'}. Set Hold.`)
    if (t != null && (t < 3 || t > 30)) warn.push(`Data link timeout is ${t} s: outside the 3 to 30 s HYRAK expects.`)
    if (of != null && of < 0.5) warn.push(`Offboard loss timeout is ${of} s: tighter than internet jitter, so cloud control may trip it.`)
    if (of != null && of > 5) warn.push(`Offboard loss timeout is ${of} s: the aircraft keeps a stale command that long.`)
    return { block, warn }
}

export function SafetySetup() {
    const vp = useVehicleParams()
    const terrainFollow = useMissionStore(s => s.terrainFollow)
    const setTerrainFollow = useMissionStore(s => s.setTerrainFollow)
    const { block, warn } = evaluate(k => vp.ready ? vp.get(k) : null)
    const except = vp.get('COM_RCL_EXCEPT')
    const cbrk = vp.get('CBRK_IO_SAFETY')
    const delay = vp.get('RTL_LAND_DELAY')

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}><ParamSourceBar what="the failsafes" /></div>
                <ReloadButton />
            </div>

            {vp.ready && (
                <section style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '14px 16px', borderRadius: 10,
                    background: block.length ? mix('var(--app-danger)', 8) : warn.length ? mix('var(--app-warn)', 8) : mix('var(--app-ok)', 7),
                    border: `1px solid ${block.length ? mix('var(--app-danger)', 35) : warn.length ? mix('var(--app-warn)', 35) : mix('var(--app-ok)', 30)}` }}>
                    <ShieldCheck size={20} style={{ color: block.length ? T.danger : warn.length ? T.warn : T.ok, flexShrink: 0, marginTop: 1 }} aria-hidden />
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>
                            {block.length ? 'HYRAK will refuse to arm with these settings' : warn.length ? 'HYRAK will arm, with warnings' : 'Link-loss failsafes pass HYRAK\'s pre-flight check'}
                        </div>
                        {[...block, ...warn].map(l => <div key={l} style={{ fontSize: 13, color: T.text, lineHeight: 1.5 }}>{l}</div>)}
                    </div>
                </section>
            )}

            <Grid min={320}>
                <Panel title="Data link loss" hint="cloud link to the aircraft">
                    <ParamRow spec={S.dlAct} />
                    <ParamRow spec={S.dlT} />
                </Panel>
                <Panel title="Offboard loss" hint="cloud tracking, follow and avoidance">
                    <ParamRow spec={S.oblAct} />
                    <ParamRow spec={S.oblT} />
                </Panel>
                <Panel title="RC loss" hint="transmitter to receiver">
                    <ParamRow spec={S.rcAct} />
                    <ParamRow spec={S.rcT} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: T.muted }}>Ignore RC loss during</span>
                        {[['Mission', 0], ['Hold', 1], ['Offboard', 2]].map(([l, bit]) => {
                            const on = except != null && ((except >> (bit as number)) & 1) === 1
                            return (
                                <label key={l as string} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: vp.ready ? T.text : T.muted }}>
                                    <Toggle label={`Ignore RC loss in ${l}`} value={on} disabled={!vp.ready || except == null}
                                        onChange={v => except != null && writeParam('COM_RCL_EXCEPT', v ? except | (1 << (bit as number)) : except & ~(1 << (bit as number)))} />
                                    {l as string}
                                </label>
                            )
                        })}
                    </div>
                </Panel>
                <Panel title="Low battery" hint="levels are on the Power page">
                    <ParamRow spec={LOW_BAT_ACT_SPEC} />
                    <ParamRow spec={{ key: 'BAT_LOW_THR', label: 'Low level', unit: '%', scale: 100, def: 0.15, decimals: 0, min: 12, max: 50 }} disabled />
                    <ParamRow spec={{ key: 'BAT_CRIT_THR', label: 'Critical level', unit: '%', scale: 100, def: 0.07, decimals: 0, min: 5, max: 25 }} disabled />
                </Panel>
                <Panel title="Geofence" hint="around the home point">
                    <ParamRow spec={S.gfAct} />
                    <ParamRow spec={S.gfR} />
                    <ParamRow spec={S.gfH} />
                </Panel>
                <Panel title="Return home">
                    <ReturnProfile alt={vp.get('RTL_RETURN_ALT') ?? 60} desc={vp.get('RTL_DESCEND_ALT') ?? 30} delay={delay ?? 0} />
                    <ParamRow spec={S.rtlAlt} />
                    <ParamRow spec={S.rtlDesc} />
                    <ParamRow spec={{ key: 'RTL_LAND_DELAY', label: 'At home', def: 0, options: [
                        { value: 0, label: 'Land straight away' },
                        { value: -1, label: 'Hover, do not land' },
                        ...[5, 10, 30, 60].map(s => ({ value: s, label: `Hover ${s} s, then land` })),
                    ], tip: 'What the aircraft does once it is back over home.' }} />
                </Panel>
                <Panel title="Landing">
                    <ParamRow spec={S.landSpd} />
                    <ParamRow spec={S.disarmLand} />
                    <ParamRow spec={S.disarmPre} />
                </Panel>
                <Panel title="Arming and hardware">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 38 }}>
                        <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: T.text }}>Hardware safety switch</span>
                        {vp.ready && cbrk != null && <Chip tone={cbrk === 22027 ? 'off' : 'ok'}>{cbrk === 22027 ? 'Bypassed' : 'In use'}</Chip>}
                        <Toggle label="Use the hardware safety switch" value={vp.ready ? cbrk !== 22027 : true} disabled={!vp.ready || cbrk == null}
                            onChange={on => writeParam('CBRK_IO_SAFETY', on ? 0 : 22027)} />
                    </div>
                    <ParamRow spec={S.prearm} />
                    <ParamRow spec={S.hitl} />
                    {vp.ready && (vp.get('SYS_HITL') ?? 0) !== 0 && <Note tone="warn">Simulation mode is on. The aircraft will not fly for real until it is Off and the flight controller rebooted.</Note>}
                </Panel>
                <Panel title="Terrain following" hint="a HYRAK mission setting">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ flex: 1, fontSize: 14, color: T.text, lineHeight: 1.5 }}>
                            {terrainFollow ? 'On: missions hold the same height above the ground over hills.' : 'Off: mission heights are measured from the home point.'}
                        </span>
                        <Toggle label="Terrain following" value={terrainFollow} onChange={setTerrainFollow} />
                    </div>
                </Panel>
            </Grid>
        </div>
    )
}

/** Side view of a Return: climb, fly home, descend, hover, land. */
function ReturnProfile({ alt, desc, delay }: { alt: number; desc: number; delay: number }) {
    const W = 300, H = 110, top = 18, ground = H - 18
    const ceil = Math.max(alt, desc, 10) * 1.15
    const y = (a: number) => ground - (a / ceil) * (ground - top)
    const d = Math.min(desc, alt)
    const path = `M20,${ground} L40,${y(alt)} L220,${y(alt)} L240,${y(d)} ${delay !== 0 ? `L262,${y(d)}` : ''} ${delay === -1 ? '' : `L${delay !== 0 ? 262 : 240},${ground}`}`
    return (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Return: climb to ${alt} m, descend to ${d} m, then ${delay === -1 ? 'hover' : delay > 0 ? `hover ${delay} s and land` : 'land'}`}
            style={{ width: '100%', maxWidth: 320, minWidth: 240, display: 'block' }}>
            <line x1={8} x2={W - 8} y1={ground} y2={ground} stroke={T.borderStrong} strokeWidth={1.5} />
            <path d={path} fill="none" stroke="var(--app-accent)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
            <text x={130} y={y(alt) - 6} textAnchor="middle" fontSize={16} fontWeight={700} fill={T.text}>{alt} m</text>
            <text x={246} y={y(d) - 6} fontSize={15} fill={T.muted}>{d} m</text>
            <text x={262} y={ground + 15} textAnchor="middle" fontSize={15} fill={T.muted}>Home</text>
        </svg>
    )
}
