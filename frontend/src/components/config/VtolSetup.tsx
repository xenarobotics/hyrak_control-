'use client'

// Config > VTOL. QGroundControl keeps VTOL setup under Parameters; this page
// gathers PX4's VT_* settings (1.15-1.17) in the order a VTOL is set up:
// the transition (speeds, times, throttle, back-transition braking), tilt
// for tiltrotors and tilt-wings (with the tilt servos from the geometry),
// forward thrust in hover, quad-chute protection and differential thrust in
// forward flight. It checks the combinations PX4 does not, such as a
// transition airspeed below the wing's minimum airspeed.

import React from 'react'
import { useVehicleParams } from '@/lib/vehicleParams'
import { Grid, Note, Panel, ParamRow, ParamSourceBar, ReloadButton, T, mix, type ParamSpec } from '@/components/config/kit'
import { BitmaskRow, SpecRows, WriteLog, useVehicleClass } from '@/components/config/setupKit'

const TYPE: ParamSpec[] = [
    { key: 'VT_TYPE', label: 'VTOL type', options: [{ value: 0, label: 'Tailsitter' }, { value: 1, label: 'Tiltrotor / tilt-wing' }, { value: 2, label: 'Standard (separate pusher)' }], tip: 'Set by the airframe. Changing it needs a reboot and a matching geometry on the Actuators page.' },
]

const FRONT: ParamSpec[] = [
    { key: 'VT_ARSP_TRANS', label: 'Switch to plane at', unit: 'm/s', tip: 'Airspeed at which the transition completes and the wing takes over. Must be above the wing\'s minimum airspeed.' },
    { key: 'VT_ARSP_BLEND', label: 'Start blending at', unit: 'm/s', tip: 'Airspeed at which the plane controls start to blend in. 0 = no blending.' },
    { key: 'VT_F_TRANS_DUR', label: 'Front transition time', unit: 's', tip: 'Time to reach full transition throttle and, on tiltrotors, the transition tilt.' },
    { key: 'VT_TRANS_MIN_TM', label: 'Shortest transition', unit: 's' },
    { key: 'VT_F_TR_OL_TM', label: 'Transition time without airspeed', unit: 's', tip: 'With no airspeed sensor the transition is timed: it completes after this long.' },
    { key: 'VT_TRANS_TIMEOUT', label: 'Give up after', unit: 's', tip: 'If the transition has not completed in this time it is cancelled and the aircraft returns to hover (quad-chute).' },
    { key: 'VT_F_TRANS_THR', label: 'Transition throttle', unit: '%', scale: 100, decimals: 0, min: 0, max: 100, tip: 'Forward thrust used to accelerate through the transition.' },
    { key: 'VT_PSHER_SLEW', label: 'Pusher ramp rate', tip: 'How fast the pusher throttle rises to the transition throttle (per second). 0 = at once.' },
]

const BACK: ParamSpec[] = [
    { key: 'VT_B_TRANS_DUR', label: 'Back transition time', unit: 's', tip: 'Maximum time to slow from plane to hover.' },
    { key: 'VT_B_DEC_MSS', label: 'Braking', unit: 'm/s²', tip: 'Deceleration during back transition. Also how far ahead of a landing point the back transition starts in missions.' },
    { key: 'VT_B_DEC_I', label: 'Braking correction', tip: 'Integrator that adjusts tilt or pitch to hold the braking rate.' },
    { key: 'VT_B_TRANS_RAMP', label: 'Hover motor spin-up', unit: 's', tip: 'Time for the hover motors to ramp up during back transition.' },
]

const TILT: ParamSpec[] = [
    { key: 'VT_TILT_MC', label: 'Tilt in hover', min: 0, max: 1, decimals: 2, tip: '0 = motors up (hover), 1 = fully forward. Normalised across each tilt servo\'s range.' },
    { key: 'VT_TILT_TRANS', label: 'Tilt during transition', min: 0, max: 1, decimals: 2, tip: 'Tilt held while accelerating to the transition airspeed.' },
    { key: 'VT_TILT_FW', label: 'Tilt in forward flight', min: 0, max: 1, decimals: 2 },
    { key: 'VT_TRANS_P2_DUR', label: 'Final tilt time', unit: 's', tip: 'Time to tilt from the transition tilt to the forward-flight tilt once the airspeed is reached.' },
    { key: 'VT_BT_TILT_DUR', label: 'Tilt back up time', unit: 's', tip: 'Time to tilt back to hover during the back transition.' },
]

const HOVER: ParamSpec[] = [
    { key: 'VT_FWD_THRUST_EN', label: 'Use forward thrust in hover', tip: 'Instead of pitching the nose down into wind, push forward with the pusher or by tilting the motors.' },
    { key: 'VT_FWD_THRUST_SC', label: 'Forward thrust strength' },
    { key: 'VT_PITCH_MIN', label: 'Lowest hover pitch', unit: '°', tip: 'Pitch setpoints below this become forward thrust (when enabled above).' },
    { key: 'VT_LND_PITCH_MIN', label: 'Lowest pitch while landing', unit: '°' },
    { key: 'VT_ELEV_MC_LOCK', label: 'Lock control surfaces in hover' },
    { key: 'VT_SPOILER_MC_LD', label: 'Spoilers while landing' },
]

const QUADCHUTE: ParamSpec[] = [
    { key: 'COM_QC_ACT', label: 'Then', tip: 'What the aircraft does after a quad-chute (back to hover).' },
    { key: 'VT_FW_QC_P', label: 'Back to hover if pitch exceeds', unit: '°', tip: '0 = off.' },
    { key: 'VT_FW_QC_R', label: 'Back to hover if bank exceeds', unit: '°', tip: '0 = off.' },
    { key: 'VT_FW_MIN_ALT', label: 'Back to hover below', unit: 'm', tip: 'Height above home under which plane flight is abandoned. 0 = off.' },
    { key: 'VT_QC_ALT_LOSS', label: 'Back to hover after losing', unit: 'm', tip: 'Unplanned height loss in plane flight. 0 = off.' },
    { key: 'VT_QC_T_ALT_LOSS', label: 'Height loss allowed in transition', unit: 'm', tip: '0 = off.' },
    { key: 'VT_FW_QC_HMAX', label: 'Only below', unit: 'm', tip: 'Quad-chute only triggers below this height: higher up, hovering home could empty the battery. 0 = any height.' },
]

const DIFTHR: ParamSpec[] = [
    { key: 'VT_FW_DIFTHR_S_R', label: 'Roll strength' },
    { key: 'VT_FW_DIFTHR_S_P', label: 'Pitch strength' },
    { key: 'VT_FW_DIFTHR_S_Y', label: 'Yaw strength' },
]

const MISSION: ParamSpec[] = [
    { key: 'NAV_FORCE_VT', label: 'Land and take off as a multicopter', tip: 'Missions take off and land in hover even if the item says plane.' },
    { key: 'RTL_TYPE', label: 'Return path' },
]

export function VtolSetup() {
    const vp = useVehicleParams()
    const vc = useVehicleClass()
    const g = (k: string) => vp.get(k)
    const warn: string[] = []
    if (vp.ready) {
        const trans = g('VT_ARSP_TRANS'), blend = g('VT_ARSP_BLEND'), amin = g('FW_AIRSPD_MIN'), stall = g('FW_AIRSPD_STALL')
        if (trans != null && blend != null && blend > 0 && blend >= trans) warn.push(`Blending starts at ${blend} m/s, not below the ${trans} m/s switch speed. Set it lower.`)
        if (trans != null && amin != null && trans < amin) warn.push(`The switch to plane (${trans} m/s) is below the wing's minimum airspeed (${amin} m/s): the wing would take over too slow to fly.`)
        else if (trans != null && stall != null && trans < stall * 1.2) warn.push(`The switch to plane (${trans} m/s) is close to stall (${stall} m/s). Leave at least 20 % margin.`)
        const tmin = g('VT_TRANS_MIN_TM'), tout = g('VT_TRANS_TIMEOUT'), ol = g('VT_F_TR_OL_TM')
        if (tmin != null && tout != null && tmin >= tout) warn.push(`The shortest transition (${tmin} s) is not below the timeout (${tout} s): every transition would be cancelled.`)
        if (ol != null && tout != null && ol >= tout) warn.push(`The transition time without airspeed (${ol} s) is not below the timeout (${tout} s).`)
    }
    const noAirspeed = vp.ready && ((vp.get('SYS_HAS_NUM_ASPD') ?? 1) === 0 || vp.get('FW_USE_AIRSPD') === 0 || vp.get('FW_ARSP_MODE') === 1)
    const tilt = vc.vtolType === 1 || !vp.ready
    const isVtol = !vp.ready || vp.has('VT_TYPE')
    if (!isVtol) {
        return <Note>This firmware has no VTOL controller (VT_TYPE missing).</Note>
    }
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}><ParamSourceBar what="VTOL settings" /></div>
                <ReloadButton />
            </div>
            {warn.map(w => <Note key={w} tone="warn">{w}</Note>)}
            {noAirspeed && <Note>No airspeed sensor in use: front transitions are timed by &quot;Transition time without airspeed&quot;, not by airspeed. Choose it from a flight log, with margin.</Note>}
            <TransitionStrip />
            <Grid min={360}>
                <Panel title="Front transition" hint="hover to plane"><SpecRows specs={[...TYPE, ...FRONT]} compact /></Panel>
                <Panel title="Back transition" hint="plane to hover"><SpecRows specs={BACK} compact /></Panel>
                {tilt && (
                    <Panel title="Tilt" hint="tiltrotors and tilt-wings">
                        <TiltDiagram />
                        <SpecRows specs={TILT} compact />
                        <TiltServos />
                    </Panel>
                )}
                <Panel title="Hover in wind" hint="forward thrust instead of nose-down"><SpecRows specs={HOVER} compact /></Panel>
                <Panel title="Quad-chute" hint="give up plane flight and hover">
                    <SpecRows specs={QUADCHUTE} compact />
                </Panel>
                <Panel title="Differential thrust in plane flight" hint="motors steer where surfaces cannot">
                    <BitmaskRow k="VT_FW_DIFTHR_EN" label="Use the motors for" bits={[[0, 'Yaw'], [1, 'Roll'], [2, 'Pitch']]}
                        tip="An airframe without ailerons or rudder (the HYRAK tandem tilt-wing has no ailerons) can steer with different thrust on each motor." />
                    <SpecRows specs={DIFTHR} compact empty={null} />
                </Panel>
                <Panel title="Missions and return"><SpecRows specs={MISSION} compact /></Panel>
            </Grid>
            <WriteLog />
        </div>
    )
}

/** Front transition as a strip: hover, blending, plane, against airspeed. */
function TransitionStrip() {
    const vp = useVehicleParams()
    const v = (k: string, d: number) => vp.get(k) ?? d
    const stall = v('FW_AIRSPD_STALL', 7), amin = v('FW_AIRSPD_MIN', 10), blend = v('VT_ARSP_BLEND', 8), trans = v('VT_ARSP_TRANS', 10), trim = v('FW_AIRSPD_TRIM', 15)
    const top = Math.max(trim, trans, amin) * 1.2 || 20
    const x = (s: number) => `${Math.max(0, Math.min(100, (s / top) * 100))}%`
    const marks = [
        { s: stall, label: 'Stall', c: T.danger },
        { s: amin, label: 'Wing minimum', c: T.warn },
        { s: trim, label: 'Cruise', c: T.ok },
    ]
    return (
        <Panel title="Transition at a glance" hint={vp.ready ? 'from this aircraft' : 'PX4 defaults'}>
            <div role="img" aria-label={`Hover until ${blend} m/s, blend until ${trans} m/s, then plane. Stall ${stall}, wing minimum ${amin}, cruise ${trim} m/s.`}
                style={{ position: 'relative', height: 26, margin: '0 4px' }}>
                <div style={{ position: 'absolute', left: 0, right: 0, top: 6, height: 14, borderRadius: 7, overflow: 'hidden', display: 'flex', border: `1px solid ${T.border}` }}>
                    <div style={{ width: x(blend > 0 ? blend : trans), background: mix('var(--app-accent)', 22) }} />
                    <div style={{ width: `calc(${x(trans)} - ${x(blend > 0 ? blend : trans)})`, background: mix('var(--app-warn)', 28) }} />
                    <div style={{ flex: 1, background: mix('var(--app-ok)', 24) }} />
                </div>
                {marks.map(m => <div key={m.label} aria-hidden style={{ position: 'absolute', left: x(m.s), top: 0, height: 26, borderLeft: `2px solid ${m.c}` }} />)}
            </div>
            <div aria-hidden style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', fontSize: 12, color: T.muted }}>
                {[
                    { c: mix('var(--app-accent)', 45), l: `Hover below ${blend > 0 ? blend : trans} m/s`, bar: true },
                    ...(blend > 0 ? [{ c: mix('var(--app-warn)', 55), l: `Blend ${blend} to ${trans} m/s`, bar: true }] : []),
                    { c: mix('var(--app-ok)', 50), l: `Plane from ${trans} m/s`, bar: true },
                    ...marks.map(m => ({ c: m.c, l: `${m.label} ${m.s} m/s`, bar: false })),
                ].map(i => (
                    <span key={i.l} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                        <span style={{ width: i.bar ? 14 : 2, height: i.bar ? 10 : 14, borderRadius: i.bar ? 3 : 1, background: i.c }} />{i.l}
                    </span>
                ))}
            </div>
        </Panel>
    )
}

/** Side view: the motor tilted to its hover, transition and forward angles. */
function TiltDiagram() {
    const vp = useVehicleParams()
    const v = (k: string, d: number) => vp.get(k) ?? d
    const minA = v('CA_SV_TL0_MINA', 0), maxA = v('CA_SV_TL0_MAXA', 90)
    const ang = (t: number) => minA + (maxA - minA) * t
    const states = [
        { t: v('VT_TILT_MC', 0), label: 'Hover', c: 'var(--app-accent)' },
        { t: v('VT_TILT_TRANS', 0.4), label: 'Transition', c: 'var(--app-warn)' },
        { t: v('VT_TILT_FW', 1), label: 'Plane', c: 'var(--app-ok)' },
    ]
    return (
        <svg viewBox="0 0 300 96" role="img" aria-label={states.map(s => `${s.label} ${ang(s.t).toFixed(0)} degrees`).join(', ')} style={{ width: '100%', maxWidth: 340, display: 'block' }}>
            {states.map((s, i) => {
                const cx = 50 + i * 100, cy = 62, a = (ang(s.t) * Math.PI) / 180
                const dx = Math.sin(a) * 34, dy = -Math.cos(a) * 34
                return (
                    <g key={s.label}>
                        <line x1={cx - 30} x2={cx + 30} y1={cy} y2={cy} stroke={T.borderStrong} strokeWidth={2} />
                        <line x1={cx} y1={cy} x2={cx + dx} y2={cy + dy} stroke={s.c} strokeWidth={3} strokeLinecap="round" />
                        <circle cx={cx + dx} cy={cy + dy} r={4} fill={s.c} />
                        <text x={cx} y={cy + 22} textAnchor="middle" fontSize={12} fill={T.muted}>{s.label} {ang(s.t).toFixed(0)}°</text>
                    </g>
                )
            })}
        </svg>
    )
}

/** The tilt servos from the geometry (CA_SV_TL*): range and what they also control. */
function TiltServos() {
    const vp = useVehicleParams()
    const n = vp.ready ? Math.max(0, Math.min(4, vp.get('CA_SV_TL_COUNT') ?? 0)) : 1
    if (vp.ready && !vp.has('CA_SV_TL_COUNT')) return null
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Tilt servos ({n})</span>
            {n === 0 && <p style={{ margin: 0, fontSize: 13, color: T.muted }}>No tilt servos in the geometry. Add them on the Actuators page.</p>}
            {Array.from({ length: n }, (_, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: T.muted }}>Tilt {i}</span>
                    <ParamRow compact spec={{ key: `CA_SV_TL${i}_MINA`, label: 'Angle at hover end', unit: '°', def: 0, min: -90, max: 90, decimals: 0 }} />
                    <ParamRow compact spec={{ key: `CA_SV_TL${i}_MAXA`, label: 'Angle at forward end', unit: '°', def: 90, min: -90, max: 90, decimals: 0 }} />
                    <ParamRow compact spec={{ key: `CA_SV_TL${i}_CT`, label: 'Also steers', def: 1, options: [{ value: 0, label: 'Nothing' }, { value: 1, label: 'Yaw' }, { value: 2, label: 'Pitch' }, { value: 3, label: 'Yaw and pitch' }] }} />
                    <ParamRow compact spec={{ key: `CA_SV_TL${i}_TD`, label: 'Tilt direction', unit: '°', def: 0, min: 0, max: 359, decimals: 0, tip: '0 = tilts toward the nose, 90 = toward the right.' }} />
                </div>
            ))}
        </div>
    )
}
