'use client'

// Config > Actuators. QGroundControl's PX4 1.14+ Actuators page, in HYRAK's
// style: the geometry (airframe type, rotor positions and spin directions,
// control surfaces), the output mapping per bus (function, disarmed, min,
// max, failsafe, reverse, timer rates for DShot), and actuator testing with
// motor identification and DShot spin direction.
//
// TESTING SAFETY, the same rules QGC follows and a few more:
//  - only on a connected, disarmed aircraft on the ground (the backend
//    refuses the command otherwise too, app/telemetry/actuator_control.py);
//  - nothing moves until the operator confirms the propellers are off;
//  - sliders start at Stop and are capped at a low level (20 % by default);
//  - every command carries a 1 s timeout on the aircraft and is re-sent
//    while the slider is held up, so a closed tab, a dropped socket or a
//    crashed server stops the motors within a second;
//  - 10 s with no touch stops everything, as does arming, a link drop,
//    hiding the tab or leaving the page;
//  - a big Stop button, and Escape, stop everything at once.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Fan, Hand, OctagonX, RotateCcw, RotateCw, Volume2 } from 'lucide-react'
import { useDroneStore } from '@/store/drone'
import { getSocket } from '@/lib/socket'
import { numberedKeys, useVehicleParams, writeParam, writeParams } from '@/lib/vehicleParams'
import { droneAction, droneActionNoWait } from '@/lib/droneAction'
import { OptionSelect } from '@/components/config/OptionSelect'
import { Segmented } from '@/components/ui/segmented'
import {
    Btn, Chip, Dialog, Grid, Note, NumberBox, Panel, ParamRow, ParamSourceBar, ReloadButton, SubTabs, T, Tip, Toggle, mix, FOCUS_RING,
    type ParamSpec,
} from '@/components/config/kit'
import {
    AIRFRAME_OPTS, BUSES, DEMO_ROTORS, ROTOR_AIRFRAMES, SURFACE_AIRFRAMES, SURFACE_TYPE_OPTS, TIMER_OPTS,
    functionLabel, functionOptions, isDshotRate, isMotorFn, isServoFn, type Bus,
} from '@/components/config/actuatorMeta'

type Rotor = { i: number; px: number; py: number; pz: number; km: number }

function useRotors(): { rotors: Rotor[]; demo: boolean } {
    const vp = useVehicleParams()
    if (!vp.ready) return { rotors: DEMO_ROTORS.map((r, i) => ({ i, ...r })), demo: true }
    const n = Math.max(0, Math.min(12, vp.get('CA_ROTOR_COUNT') ?? 0))
    return {
        demo: false,
        rotors: Array.from({ length: n }, (_, i) => ({
            i,
            px: vp.get(`CA_ROTOR${i}_PX`) ?? 0,
            py: vp.get(`CA_ROTOR${i}_PY`) ?? 0,
            pz: vp.get(`CA_ROTOR${i}_PZ`) ?? 0,
            km: vp.get(`CA_ROTOR${i}_KM`) ?? 0.05,
        })),
    }
}

/** One output: which bus, which number, and its function. */
type Output = { bus: Bus; n: number; fn: number }

function useOutputs(): { buses: Bus[]; outputs: Output[]; demo: boolean } {
    const vp = useVehicleParams()
    return useMemo(() => {
        if (!vp.ready) {
            const main = BUSES[0]
            return { demo: true, buses: [main], outputs: Array.from({ length: 8 }, (_, i) => ({ bus: main, n: i + 1, fn: i < 4 ? 101 + i : 0 })) }
        }
        const buses: Bus[] = []
        const outputs: Output[] = []
        for (const b of BUSES) {
            const ns = numberedKeys(vp.params, new RegExp(`^${b.prefix}_FUNC(\\d+)$`))
            if (!ns.length) continue
            buses.push(b)
            for (const n of ns) outputs.push({ bus: b, n, fn: vp.get(`${b.prefix}_FUNC${n}`) ?? 0 })
        }
        return { demo: false, buses, outputs }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vp.ready, vp.params])
}

export function ActuatorsSetup() {
    const [tab, setTab] = useState<'geometry' | 'outputs' | 'test'>('geometry')
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}><ParamSourceBar what="the motor and output setup" /></div>
                <ReloadButton />
            </div>
            <SubTabs label="Actuators" value={tab} onChange={setTab} tabs={[
                { id: 'geometry', label: 'Geometry' },
                { id: 'outputs', label: 'Outputs' },
                { id: 'test', label: 'Test motors' },
            ]} />
            {tab === 'geometry' && <Geometry />}
            {tab === 'outputs' && <Outputs />}
            {tab === 'test' && <Testing />}
        </div>
    )
}

// ── Geometry ────────────────────────────────────────────────────────────────

function Geometry() {
    const vp = useVehicleParams()
    const { rotors, demo } = useRotors()
    const [sel, setSel] = useState<number | null>(null)
    const frame = vp.ready ? vp.get('CA_AIRFRAME') : 0
    const missing = vp.ready && frame === null
    const showRotors = frame == null || ROTOR_AIRFRAMES.has(frame)
    const showSurfaces = frame != null && SURFACE_AIRFRAMES.has(frame) && (vp.has('CA_SV_CS_COUNT') || !vp.ready)

    const writeAirframe = (key: string, v: number) => {
        if (window.confirm(`Change the geometry type to ${AIRFRAME_OPTS.find(o => o.value === v)?.label ?? v}? PX4 rebuilds its mixing from this, and the outputs may need reassigning. Reboot the flight controller afterwards.`)) writeParam(key, v)
    }

    if (missing) {
        return <Note tone="warn">This aircraft has no CA_AIRFRAME parameter. Actuator geometry needs PX4 1.14 or newer; older firmware mixes from the airframe file, which you change with SYS_AUTOSTART.</Note>
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Grid min={300}>
                <Panel title="Vehicle" hint={demo ? 'example: PX4 generic quad X' : undefined}>
                    <ParamRow spec={{ key: 'CA_AIRFRAME', label: 'Geometry type', options: AIRFRAME_OPTS, def: 0, tip: 'How PX4 turns roll, pitch, yaw and thrust into actuator outputs.' }} onWrite={writeAirframe} />
                    {showRotors && <ParamRow spec={{ key: 'CA_ROTOR_COUNT', label: 'Motors', options: Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: String(i + 1) })), def: 4, tip: 'Number of rotors. Each gets a position and spin direction below.' }} />}
                    <RotorDiagram rotors={rotors} selected={sel} onPick={setSel} />
                    <Legend />
                </Panel>
                {showRotors && <RotorTable rotors={rotors} demo={demo} selected={sel} onSelect={setSel} tilt={frame === 3 || frame === 8} />}
            </Grid>
            {showSurfaces && <Surfaces />}
        </div>
    )
}

function Legend() {
    return (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, color: T.muted }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><RotateCcw size={14} style={{ color: T.accent }} /> Counter-clockwise</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><RotateCw size={14} style={{ color: 'var(--app-magenta)' }} /> Clockwise</span>
            <span>Seen from above, nose up</span>
        </div>
    )
}

/** The rotors from above, nose up. +X forward, +Y right (PX4 body frame). */
export function RotorDiagram({ rotors, selected, onPick, spinning, pickMode, labels }: {
    rotors: Rotor[]; selected?: number | null; onPick?: (i: number) => void
    spinning?: Set<number>; pickMode?: boolean; labels?: Record<number, string>
}) {
    const S = 300, H = 324, C = S / 2, CY = 172
    const maxR = Math.max(0.1, ...rotors.map(r => Math.max(Math.abs(r.px), Math.abs(r.py))))
    const k = 88 / maxR
    let minD = Infinity
    for (let a = 0; a < rotors.length; a++) for (let b = a + 1; b < rotors.length; b++) {
        const d = Math.hypot(rotors[a].px - rotors[b].px, rotors[a].py - rotors[b].py) * k
        if (d > 1) minD = Math.min(minD, d)
    }
    const pr = Math.max(18, Math.min(38, isFinite(minD) ? minD / 2.3 : 38))
    return (
        <svg viewBox={`0 0 ${S} ${H}`} role="img" aria-label="Motor layout seen from above" style={{ width: '100%', maxWidth: 340, minWidth: 260, alignSelf: 'center', display: 'block' }}>
            <defs>
                <marker id="rot-arrow-ccw" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--app-accent)" /></marker>
                <marker id="rot-arrow-cw" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--app-magenta)" /></marker>
            </defs>
            {/* nose */}
            <path d={`M${C - 9},${CY - 34} L${C},${CY - 50} L${C + 9},${CY - 34}`} fill="none" stroke={T.muted} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
            <text x={C} y={18} textAnchor="middle" fontSize={14} fontWeight={700} fill={T.muted}>Front</text>
            {rotors.map(r => (
                <line key={'arm' + r.i} x1={C} y1={CY} x2={C + r.py * k} y2={CY - r.px * k} stroke={T.borderStrong} strokeWidth={5} strokeLinecap="round" opacity={0.55} />
            ))}
            <rect x={C - 22} y={CY - 28} width={44} height={56} rx={12} fill={T.surface2} stroke={T.borderStrong} strokeWidth={1.5} />
            {rotors.map(r => {
                const x = C + r.py * k, y = CY - r.px * k
                const ccw = r.km >= 0
                const col = ccw ? 'var(--app-accent)' : 'var(--app-magenta)'
                const on = selected === r.i
                const spin = spinning?.has(r.i)
                // Screen angles grow clockwise (y points down). The arc runs 260
                // degrees round the bottom and its arrowhead shows the spin.
                const a0 = ccw ? 220 : -40, a1 = ccw ? -40 : 220
                const ar = pr * 0.72
                const pt = (deg: number) => [x + ar * Math.cos(deg * Math.PI / 180), y + ar * Math.sin(deg * Math.PI / 180)]
                const [sx, sy] = pt(a0), [ex, ey] = pt(a1)
                return (
                    <g key={r.i} onClick={onPick ? () => onPick(r.i) : undefined} style={{ cursor: onPick ? 'pointer' : 'default' }}
                        role={onPick ? 'button' : undefined} aria-label={`Motor ${r.i + 1}`} tabIndex={onPick ? 0 : undefined}
                        onKeyDown={onPick ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(r.i) } } : undefined}>
                        {spin && <circle cx={x} cy={y} r={pr + 6} fill="none" stroke="var(--app-warn)" strokeWidth={3} className="animate-pulse" />}
                        <circle cx={x} cy={y} r={pr} fill={mix(col, on ? 26 : 12)} stroke={on || pickMode ? col : mix(col, 60)} strokeWidth={on ? 3 : 1.5} strokeDasharray={pickMode && !on ? '4 3' : undefined} />
                        <path d={`M${sx},${sy} A${ar},${ar} 0 1 ${ccw ? 0 : 1} ${ex},${ey}`} fill="none" stroke={col} strokeWidth={2} markerEnd={`url(#rot-arrow-${ccw ? 'ccw' : 'cw'})`} opacity={0.9} />
                        <text x={x} y={y + 5} textAnchor="middle" fontSize={15} fontWeight={800} fill={T.text}>{labels?.[r.i] ?? r.i + 1}</text>
                    </g>
                )
            })}
        </svg>
    )
}

function RotorTable({ rotors, demo, selected, onSelect, tilt }: { rotors: Rotor[]; demo: boolean; selected: number | null; onSelect: (i: number | null) => void; tilt: boolean }) {
    const vp = useVehicleParams()
    const [axis, setAxis] = useState(false)
    const edit = vp.ready
    const cell = (key: string, value: number, label: string, opts?: { min?: number; max?: number; decimals?: number }) => (
        <ParamCell key={key} k={key} value={value} label={label} disabled={!edit} {...opts} />
    )
    return (
        <Panel title="Motor positions" hint="metres from the centre of gravity"
            right={<label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: T.muted }}>Thrust axis <Toggle label="Show thrust axis" value={axis} onChange={setAxis} /></label>}>
            {rotors.length === 0 && <p style={{ margin: 0, fontSize: 14, color: T.muted }}>No motors. Set the motor count.</p>}
            <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                    <thead>
                        <tr style={{ color: T.muted, textAlign: 'left' }}>
                            <th style={TH}>Motor</th>
                            <th style={TH}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>X fwd <Tip text="Forward of the centre of gravity, metres (CA_ROTORn_PX)." /></span></th>
                            <th style={TH}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>Y right <Tip text="Right of the centre of gravity, metres (CA_ROTORn_PY)." /></span></th>
                            <th style={TH}>Z down</th>
                            <th style={TH}>Direction</th>
                            {axis && <><th style={TH}>Axis X</th><th style={TH}>Axis Y</th><th style={TH}>Axis Z</th></>}
                            {tilt && <th style={TH}>Tilt servo</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {rotors.map(r => {
                            const on = selected === r.i
                            return (
                                <tr key={r.i} onClick={() => onSelect(on ? null : r.i)} style={{ background: on ? mix('var(--app-accent)', 8) : undefined, cursor: 'pointer' }}>
                                    <td style={TD}><b style={{ color: r.km >= 0 ? T.accent : 'var(--app-magenta)' }}>{r.i + 1}</b></td>
                                    <td style={TD}>{cell(`CA_ROTOR${r.i}_PX`, r.px, `Motor ${r.i + 1} X`, { min: -100, max: 100, decimals: 3 })}</td>
                                    <td style={TD}>{cell(`CA_ROTOR${r.i}_PY`, r.py, `Motor ${r.i + 1} Y`, { min: -100, max: 100, decimals: 3 })}</td>
                                    <td style={TD}>{cell(`CA_ROTOR${r.i}_PZ`, r.pz, `Motor ${r.i + 1} Z`, { min: -100, max: 100, decimals: 3 })}</td>
                                    <td style={TD} onClick={e => e.stopPropagation()}>
                                        <OptionSelect size="sm" aria-label={`Motor ${r.i + 1} direction`} className="w-auto min-w-[92px] text-[13px] data-[size=sm]:h-8"
                                            value={r.km >= 0 ? 1 : -1} disabled={!edit}
                                            onChange={d => writeParam(`CA_ROTOR${r.i}_KM`, d * (Math.abs(r.km) || 0.05))}
                                            options={[{ value: 1, label: 'CCW' }, { value: -1, label: 'CW' }]} />
                                    </td>
                                    {axis && ['AX', 'AY', 'AZ'].map((a, j) => (
                                        <td key={a} style={TD}>{cell(`CA_ROTOR${r.i}_${a}`, vp.get(`CA_ROTOR${r.i}_${a}`) ?? (j === 2 ? -1 : 0), `Motor ${r.i + 1} axis ${a}`, { min: -100, max: 100, decimals: 2 })}</td>
                                    ))}
                                    {tilt && <td style={TD} onClick={e => e.stopPropagation()}>
                                        <OptionSelect size="sm" aria-label={`Motor ${r.i + 1} tilt servo`} className="w-auto min-w-[92px] text-[13px] data-[size=sm]:h-8"
                                            value={vp.get(`CA_ROTOR${r.i}_TILT`) ?? 0} disabled={!edit}
                                            onChange={v => writeParam(`CA_ROTOR${r.i}_TILT`, v)}
                                            options={[{ value: 0, label: 'None' }, ...[1, 2, 3, 4].map(t => ({ value: t, label: `Tilt ${t}` }))]} />
                                    </td>}
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
            </div>
            {demo && <p style={{ margin: 0, fontSize: 13, color: T.muted }}>Connect a drone to edit its own geometry.</p>}
        </Panel>
    )
}

const TH: React.CSSProperties = { padding: '6px 6px', fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', borderBottom: `1px solid ${T.border}` }
const TD: React.CSSProperties = { padding: '5px 6px', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }

/** A number in a table cell, written to the aircraft on Enter or blur. */
function ParamCell({ k, value, label, disabled, min, max, decimals, width = 76 }: {
    k: string; value: number | null; label: string; disabled?: boolean; min?: number; max?: number; decimals?: number; width?: number
}) {
    const vp = useVehicleParams()
    const failed = vp.failed[k]
    return (
        <span title={failed} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, outline: vp.pending[k] ? `2px solid ${mix('var(--app-accent)', 50)}` : failed ? `2px solid ${mix('var(--app-danger)', 60)}` : undefined, borderRadius: 7 }}>
            <NumberBox label={label} value={value} onCommit={v => writeParam(k, v)} disabled={disabled || (vp.ready && !vp.has(k))} min={min} max={max} decimals={decimals} width={width}
                placeholder={vp.ready && !vp.has(k) ? 'n/a' : undefined} />
        </span>
    )
}

function Surfaces() {
    const vp = useVehicleParams()
    const n = vp.ready ? Math.max(0, Math.min(8, vp.get('CA_SV_CS_COUNT') ?? 0)) : 0
    return (
        <Panel title="Control surfaces" hint="ailerons, elevator, rudder and friends">
            <ParamRow spec={{ key: 'CA_SV_CS_COUNT', label: 'Number of surfaces', options: Array.from({ length: 9 }, (_, i) => ({ value: i, label: String(i) })), def: 0 }} />
            {n > 0 && (
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                        <thead><tr style={{ color: T.muted, textAlign: 'left' }}>
                            <th style={TH}>Surface</th><th style={TH}>Type</th><th style={TH}>Roll</th><th style={TH}>Pitch</th><th style={TH}>Yaw</th><th style={TH}>Trim</th>
                        </tr></thead>
                        <tbody>
                            {Array.from({ length: n }, (_, i) => (
                                <tr key={i}>
                                    <td style={TD}><b>Servo {i + 1}</b></td>
                                    <td style={TD}>
                                        <OptionSelect size="sm" aria-label={`Surface ${i + 1} type`} className="w-auto min-w-[150px] text-[13px] data-[size=sm]:h-8"
                                            value={vp.get(`CA_SV_CS${i}_TYPE`) ?? 0} disabled={!vp.ready}
                                            onChange={v => writeParam(`CA_SV_CS${i}_TYPE`, v)} options={SURFACE_TYPE_OPTS} />
                                    </td>
                                    {['TRQ_R', 'TRQ_P', 'TRQ_Y', 'TRIM'].map(s => (
                                        <td key={s} style={TD}><ParamCell k={`CA_SV_CS${i}_${s}`} value={vp.get(`CA_SV_CS${i}_${s}`)} label={`Surface ${i + 1} ${s}`} min={-1} max={1} decimals={2} width={68} /></td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </Panel>
    )
}

// ── Outputs ─────────────────────────────────────────────────────────────────

function Outputs() {
    const vp = useVehicleParams()
    const { rotors } = useRotors()
    const { buses, outputs, demo } = useOutputs()
    const [busId, setBusId] = useState<string>('')
    const bus = buses.find(b => b.id === busId) ?? buses[0]
    const fnOpts = useMemo(() => functionOptions(12, 8), [])

    if (!bus) {
        return <Note tone="warn">No output buses found. PX4 1.14 or newer exposes them as PWM_MAIN_FUNCn, UAVCAN_EC_FUNCn and similar parameters.</Note>
    }
    const rows = outputs.filter(o => o.bus.id === bus.id)
    const timers = bus.timers ? numberedKeys(vp.params, new RegExp(`^${bus.timers}(\\d+)$`)) : []

    // Every motor the geometry needs should be on exactly one output.
    const motorUses: Record<number, number> = {}
    for (const o of outputs) if (isMotorFn(o.fn)) motorUses[o.fn] = (motorUses[o.fn] ?? 0) + 1
    const unassigned = rotors.map(r => 101 + r.i).filter(f => !motorUses[f])
    const doubled = Object.entries(motorUses).filter(([, c]) => c > 1).map(([f]) => Number(f))

    const has = (s: string, n: number) => demo || vp.has(`${bus.prefix}_${s}${n}`)
    const cols = (['DIS', 'MIN', 'MAX', 'FAIL'] as const).filter(s => rows.some(r => has(s, r.n)))
    const revKey = `${bus.prefix}_REV`
    const rev = vp.get(revKey)
    const COL: Record<string, string> = { DIS: 'Disarmed', MIN: 'Minimum', MAX: 'Maximum', FAIL: 'Failsafe' }
    const COL_TIP: Record<string, string> = {
        DIS: 'Sent while disarmed. For PWM ESCs, below the minimum so the motor stays stopped (commonly 1000 us).',
        MIN: 'The lowest value sent while armed. For motors this is idle spin.',
        MAX: 'The highest value sent while armed.',
        FAIL: 'Sent if the flight controller loses its outputs (IO failsafe). -1 = the disarmed value.',
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {buses.length > 1 && (
                <Segmented ariaLabel="Output bus" value={bus.id} onChange={setBusId}
                    options={buses.map(b => ({ value: b.id, label: b.label }))} />
            )}
            {(unassigned.length > 0 || doubled.length > 0) && !demo && (
                <Note tone="warn">
                    {unassigned.length > 0 && <div>{unassigned.map(functionLabel).join(', ')} {unassigned.length === 1 ? 'is' : 'are'} not on any output. That motor will not spin.</div>}
                    {doubled.length > 0 && <div>{doubled.map(functionLabel).join(', ')} {doubled.length === 1 ? 'is' : 'are'} on more than one output.</div>}
                </Note>
            )}
            {timers.length > 0 && (
                <Panel title="Output rates" hint="one rate per timer group; DShot for digital ESCs">
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
                        {timers.map(t => (
                            <ParamRow key={t} compact spec={{ key: `${bus.timers}${t}`, label: `Group ${t + 1}`, options: TIMER_OPTS, def: 400, tip: 'The protocol for every output on this timer. Outputs sharing a timer must share a rate.' }} />
                        ))}
                    </div>
                </Panel>
            )}
            <Panel title={`${bus.label} outputs`} hint={demo ? 'example: quad X on the main outputs' : bus.hint}>
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                        <thead><tr style={{ color: T.muted, textAlign: 'left' }}>
                            <th style={TH}>Output</th>
                            <th style={TH}>Function</th>
                            {cols.map(c => <th key={c} style={TH}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{COL[c]} <Tip text={COL_TIP[c]} /></span></th>)}
                            {rev != null && <th style={TH}>Reverse</th>}
                        </tr></thead>
                        <tbody>
                            {rows.map(o => {
                                const fn = o.fn
                                const motor = isMotorFn(fn), servo = isServoFn(fn)
                                return (
                                    <tr key={o.n}>
                                        <td style={TD}><b>{bus.label.split(' ')[0] === 'PWM' ? (bus.id === 'aux' ? 'AUX' : 'MAIN') : ''} {o.n}</b></td>
                                        <td style={TD}>
                                            <OptionSelect size="sm" aria-label={`${bus.label} ${o.n} function`} className="w-auto min-w-[150px] text-[13px] data-[size=sm]:h-8"
                                                value={fn} disabled={!vp.ready}
                                                onChange={v => writeParam(`${bus.prefix}_FUNC${o.n}`, v)}
                                                options={fnOpts.some(x => x.value === fn) ? fnOpts : [...fnOpts, { value: fn, label: `Function ${fn}` }]} />
                                        </td>
                                        {cols.map(c => {
                                            const key = `${bus.prefix}_${c}${o.n}`
                                            const val = demo ? ({ DIS: 1000, MIN: 1100, MAX: 1900, FAIL: -1 } as Record<string, number>)[c] : vp.get(key)
                                            return <td key={c} style={TD}>{fn === 0 && !demo ? <span style={{ color: T.subtle }}>-</span>
                                                : <ParamCell k={key} value={val} label={`${bus.label} ${o.n} ${COL[c]}`} disabled={!vp.ready} min={-1} max={65535} decimals={0} width={72} />}</td>
                                        })}
                                        {rev != null && <td style={TD}>{servo || !motor
                                            ? <Toggle label={`Reverse ${bus.label} ${o.n}`} value={((rev >> (o.n - 1)) & 1) === 1} disabled={!vp.ready || fn === 0}
                                                onChange={on => writeParam(revKey, on ? rev | (1 << (o.n - 1)) : rev & ~(1 << (o.n - 1)))} />
                                            : <span style={{ color: T.subtle }}>-</span>}</td>}
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
                <p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.5 }}>
                    PWM values are microseconds. On DShot groups, disarmed / min / max are DShot throttle steps (0 to 1999). Changes take effect immediately; check them on the Test motors tab with the propellers off.
                </p>
            </Panel>
        </div>
    )
}

// ── Testing ─────────────────────────────────────────────────────────────────

const IDLE_STOP_MS = 10_000
/** Record an operator touch (for the idle auto-stop). */
function touch(ref: React.MutableRefObject<number>) { ref.current = Date.now() }
const KEEPALIVE_MS = 300
const CAPS = [10, 20, 30, 50, 100]

function Testing() {
    const vp = useVehicleParams()
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const armed = useDroneStore(s => s.telemetry?.flight_mode?.is_armed ?? false)
    const inAir = useDroneStore(s => s.telemetry?.flight_mode?.is_in_air ?? false)
    const { rotors } = useRotors()
    const { outputs, buses } = useOutputs()
    const testEn = vp.get('COM_MOT_TEST_EN')
    const canRun = connected && vp.ready && !armed && !inAir && testEn !== 0

    const [enabled, setEnabled] = useState(false)
    const [confirmOpen, setConfirmOpen] = useState(false)
    const [cap, setCap] = useState(20)
    /** function -> level (motors 0..1, servos -1..1). Absent = stopped. */
    const [levels, setLevels] = useState<Record<number, number>>({})
    const [notice, setNotice] = useState<string | null>(null)
    const lastTouch = useRef(0)
    const levelsRef = useRef(levels)
    useEffect(() => { levelsRef.current = levels }, [levels])

    // Losing any precondition switches testing off and clears every level,
    // during render, so it can never resume when the precondition returns.
    const [prevCan, setPrevCan] = useState(canRun)
    if (prevCan !== canRun) {
        setPrevCan(canRun)
        if (!canRun && enabled) {
            setEnabled(false)
            setLevels({})
            setNotice(armed ? 'Stopped: the aircraft armed.' : !connected ? 'Stopped: the link dropped.' : 'Stopped.')
        }
    }

    const servoFns = useMemo(() => Array.from(new Set(outputs.filter(o => isServoFn(o.fn)).map(o => o.fn))).sort((a, b) => a - b), [outputs])
    const motorFns = rotors.map(r => 101 + r.i)
    const dshot = buses.some(b => b.timers && numberedKeys(vp.params, new RegExp(`^${b.timers}(\\d+)$`)).some(t => isDshotRate(vp.get(`${b.timers}${t}`))))

    const sendStop = useCallback((fns: number[]) => {
        for (const f of fns) droneActionNoWait('actuator_test', { function: f, value: null })
    }, [])
    const stopAll = useCallback((why?: string) => {
        const active = Object.keys(levelsRef.current).map(Number)
        sendStop(Array.from(new Set([...active, ...Array.from({ length: 12 }, (_, i) => 101 + i)])))
        setLevels({})
        if (why) setNotice(why)
    }, [sendStop])

    // Keep-alive: re-send every active level with a 1 s timeout on the aircraft.
    useEffect(() => {
        if (!enabled) return
        const t = setInterval(() => {
            const lv = levelsRef.current
            const keys = Object.keys(lv)
            if (!keys.length) return
            if (Date.now() - lastTouch.current > IDLE_STOP_MS) { stopAll(`Stopped after ${IDLE_STOP_MS / 1000} s without a touch.`); return }
            for (const k of keys) droneActionNoWait('actuator_test', { function: Number(k), value: lv[Number(k)], timeout_s: 1 })
        }, KEEPALIVE_MS)
        return () => clearInterval(t)
    }, [enabled, stopAll])

    // Stop on hide, on leaving the page, and on Escape.
    useEffect(() => {
        if (!enabled) return
        const onVis = () => { if (document.hidden) stopAll('Stopped: the tab was hidden.') }
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') stopAll('Stopped.') }
        document.addEventListener('visibilitychange', onVis)
        window.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('visibilitychange', onVis)
            window.removeEventListener('keydown', onKey)
        }
    }, [enabled, stopAll])
    useEffect(() => () => {
        const active = Object.keys(levelsRef.current).map(Number)
        if (active.length) sendStop(active)
    }, [sendStop])

    // A refusal from the aircraft or the backend stops everything.
    useEffect(() => {
        const socket = getSocket()
        const on = (r: { action: string; ok: boolean; error?: string }) => {
            if (r.action !== 'actuator_test' || r.ok) return
            if (Object.keys(levelsRef.current).length) {
                setLevels({})
                setNotice(`Stopped: ${r.error ?? 'the drone refused the test'}`)
            }
        }
        socket.on('action_result', on)
        return () => { socket.off('action_result', on) }
    }, [])

    const setLevel = (fn: number, v: number | null) => {
        touch(lastTouch)
        setNotice(null)
        setLevels(prev => {
            const n = { ...prev }
            if (v == null) delete n[fn]; else n[fn] = v
            return n
        })
        if (v == null) sendStop([fn])
        else droneActionNoWait('actuator_test', { function: fn, value: v, timeout_s: 1 })
    }

    const spinningRotors = new Set(Object.keys(levels).map(Number).filter(isMotorFn).map(f => f - 101))
    const anyActive = Object.keys(levels).length > 0
    const block = !connected ? 'Connect a drone to test its motors.'
        : !vp.ready ? 'Reading parameters from the drone...'
        : armed ? 'Disarm first. Testing only runs on a disarmed aircraft.'
        : inAir ? 'The aircraft is in the air.'
        : testEn === 0 ? 'Actuator testing is turned off on this aircraft (COM_MOT_TEST_EN = 0).'
        : null

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* The safety strip: state, the switch, the stop. */}
            <section style={{
                display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '14px 16px', borderRadius: 10,
                background: enabled ? mix('var(--app-warn)', 9) : T.surface, border: `1px solid ${enabled ? mix('var(--app-warn)', 45) : T.border}`,
                transition: 'background-color var(--dur) var(--ease-out), border-color var(--dur) var(--ease-out)',
            }}>
                <AlertTriangle size={20} style={{ color: enabled ? T.warn : T.muted, flexShrink: 0 }} aria-hidden />
                <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{enabled ? 'Testing is on. Motors can spin.' : 'Propellers off before testing'}</div>
                    <div style={{ fontSize: 13, color: T.muted, marginTop: 2 }}>
                        {block ?? (enabled ? `Escape or Stop halts everything. Anything idle for ${IDLE_STOP_MS / 1000} s stops by itself.` : 'Switch on to unlock the sliders. Each one starts at Stop.')}
                    </div>
                </div>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600, color: T.text }}>
                    Enable testing
                    <Toggle label="Enable testing" value={enabled} disabled={!canRun}
                        onChange={on => { if (on) setConfirmOpen(true); else { stopAll(); setEnabled(false) } }} />
                </label>
                <Btn kind="danger" big onClick={() => stopAll('Stopped.')} disabled={!connected}
                    style={{ minWidth: 140 }}><OctagonX size={20} /> Stop all</Btn>
            </section>
            {notice && <Note tone="warn">{notice}</Note>}

            <Grid min={320}>
                <Panel title="Motors" hint={`0 to ${cap} %`}
                    right={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: T.muted }}>
                        Max level
                        <OptionSelect size="sm" aria-label="Maximum test level" className="w-auto min-w-[80px] text-[13px] data-[size=sm]:h-8"
                            value={cap} onChange={c => { setCap(c); setLevels(prev => { const n = { ...prev }; for (const k of Object.keys(n)) if (isMotorFn(+k) && n[+k] > c / 100) n[+k] = c / 100; return n }) }}
                            options={CAPS.map(c => ({ value: c, label: `${c} %` }))} />
                    </span>}>
                    <SliderRow label="All motors" fn={-1} value={motorFns.length && motorFns.every(f => levels[f] != null) ? Math.min(...motorFns.map(f => levels[f])) : null}
                        cap={cap} disabled={!enabled}
                        onChange={v => {
                            touch(lastTouch)
                            if (v == null) { sendStop(motorFns); setLevels(prev => { const n = { ...prev }; motorFns.forEach(f => delete n[f]); return n }) }
                            else { setLevels(prev => { const n = { ...prev }; motorFns.forEach(f => { n[f] = v }); return n }); motorFns.forEach(f => droneActionNoWait('actuator_test', { function: f, value: v, timeout_s: 1 })) }
                        }} />
                    <div style={{ height: 1, background: T.border }} />
                    {motorFns.map(f => (
                        <SliderRow key={f} label={functionLabel(f)} fn={f} value={levels[f] ?? null} cap={cap} disabled={!enabled}
                            onChange={v => setLevel(f, v)}
                            extra={dshot ? <DshotButtons fn={f} disabled={!enabled || anyActive} /> : undefined} />
                    ))}
                    {motorFns.length === 0 && <p style={{ margin: 0, fontSize: 13, color: T.muted }}>No motors in the geometry.</p>}
                </Panel>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <Panel title="Which motor is spinning" hint="from the geometry">
                        <RotorDiagram rotors={rotors} spinning={spinningRotors} />
                    </Panel>
                    {servoFns.length > 0 && (
                        <Panel title="Servos" hint="-100 to 100 %">
                            {servoFns.map(f => (
                                <ServoRow key={f} label={functionLabel(f)} value={levels[f] ?? null} disabled={!enabled} onChange={v => setLevel(f, v)} />
                            ))}
                        </Panel>
                    )}
                </div>
            </Grid>

            <IdentifyMotors enabled={enabled} cap={cap} rotors={rotors} outputs={outputs}
                spin={(fn, v) => setLevel(fn, v)} />

            <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Enable motor testing">
                <ConfirmBody onCancel={() => setConfirmOpen(false)} onConfirm={() => { setConfirmOpen(false); setNotice(null); setLevels({}); touch(lastTouch); setEnabled(true) }} />
            </Dialog>
        </div>
    )
}

function ConfirmBody({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
    const [props, setProps] = useState(false)
    const [clear, setClear] = useState(false)
    return (
        <>
            <Note tone="danger">Motors will spin for real. A spinning propeller cuts to the bone, and an aircraft with propellers on can lift off the bench.</Note>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14, color: T.text, cursor: 'pointer' }}>
                <input type="checkbox" checked={props} onChange={e => setProps(e.target.checked)} style={{ width: 18, height: 18, marginTop: 2, accentColor: 'var(--app-danger)' }} />
                I have removed every propeller.
            </label>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14, color: T.text, cursor: 'pointer' }}>
                <input type="checkbox" checked={clear} onChange={e => setClear(e.target.checked)} style={{ width: 18, height: 18, marginTop: 2, accentColor: 'var(--app-accent)' }} />
                The aircraft is held or secured, and nobody is near the motors.
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Btn onClick={onCancel}>Cancel</Btn>
                <Btn kind="primary" disabled={!props || !clear} onClick={onConfirm}>Enable testing</Btn>
            </div>
        </>
    )
}

/** Stop, then 0 to cap %. Level 0 % is PX4's minimum spin, not stopped. */
function SliderRow({ label, fn, value, cap, disabled, onChange, extra }: {
    label: string; fn: number; value: number | null; cap: number; disabled: boolean; onChange: (v: number | null) => void; extra?: React.ReactNode
}) {
    // The slider runs -1 (Stop) .. cap. -1 is a notch below idle.
    const pos = value == null ? -1 : Math.round(value * 100)
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }} data-fn={fn}>
            <span style={{ width: 86, fontSize: 14, fontWeight: 600, color: disabled ? T.muted : T.text }}>{label}</span>
            <input type="range" aria-label={`${label} level`} min={-1} max={cap} step={1} value={pos} disabled={disabled}
                onChange={e => { const v = Number(e.target.value); onChange(v < 0 ? null : v / 100) }}
                className={FOCUS_RING}
                style={{ flex: '1 1 140px', minWidth: 120, accentColor: value != null ? 'var(--app-warn)' : 'var(--app-accent)', cursor: disabled ? 'not-allowed' : 'pointer' }} />
            <span style={{ width: 52, textAlign: 'right', fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: value != null ? T.warn : T.muted }}>
                {value == null ? 'Stop' : `${Math.round(value * 100)} %`}
            </span>
            {extra}
        </div>
    )
}

function ServoRow({ label, value, disabled, onChange }: { label: string; value: number | null; disabled: boolean; onChange: (v: number | null) => void }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ width: 86, fontSize: 14, fontWeight: 600, color: disabled ? T.muted : T.text }}>{label}</span>
            <input type="range" aria-label={`${label} position`} min={-100} max={100} step={1} value={value == null ? 0 : Math.round(value * 100)} disabled={disabled}
                onChange={e => onChange(Number(e.target.value) / 100)} className={FOCUS_RING}
                style={{ flex: '1 1 140px', minWidth: 120, accentColor: 'var(--app-accent)' }} />
            <span style={{ width: 52, textAlign: 'right', fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: value != null ? T.text : T.muted }}>
                {value == null ? 'Off' : `${Math.round(value * 100)} %`}
            </span>
            <Btn onClick={() => onChange(null)} disabled={disabled || value == null}>Release</Btn>
        </div>
    )
}

/** DShot only: beep and spin direction, sent to the ESC itself. */
function DshotButtons({ fn, disabled }: { fn: number; disabled: boolean }) {
    const [err, setErr] = useState<string | null>(null)
    const send = async (config: string) => {
        setErr(null)
        const r = await droneAction('configure_actuator', { function: fn, config })
        if (!r.ok) setErr(r.error ?? 'Refused')
    }
    return (
        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <IconBtn label={`Beep ${functionLabel(fn)}`} disabled={disabled} onClick={() => send('beep')}><Volume2 size={14} /></IconBtn>
            <IconBtn label={`${functionLabel(fn)}: spin direction 1`} disabled={disabled} onClick={() => send('spin_direction_1')}><RotateCw size={14} /></IconBtn>
            <IconBtn label={`${functionLabel(fn)}: spin direction 2`} disabled={disabled} onClick={() => send('spin_direction_2')}><RotateCcw size={14} /></IconBtn>
            {err && <span style={{ fontSize: 12, color: T.danger }}>{err}</span>}
        </span>
    )
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
    return (
        <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}
            className={FOCUS_RING + ' transition-colors hover:bg-app-surface-2'}
            style={{ width: 32, height: 32, borderRadius: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent',
                border: `1px solid ${T.border}`, color: disabled ? T.subtle : T.text, cursor: disabled ? 'not-allowed' : 'pointer' }}>{children}</button>
    )
}

// ── Identify and assign motors ─────────────────────────────────────────────

/** QGC's "Identify & assign motors": spin each motor output in turn, the
 *  operator clicks the motor that moved, and the outputs are reassigned so
 *  output and geometry agree. */
function IdentifyMotors({ enabled, cap, rotors, outputs, spin }: {
    enabled: boolean; cap: number; rotors: Rotor[]; outputs: Output[]; spin: (fn: number, v: number | null) => void
}) {
    const motorOutputs = useMemo(() => {
        // The bus that carries the motors (the first one with any).
        const bus = outputs.find(o => isMotorFn(o.fn))?.bus
        return bus ? outputs.filter(o => o.bus.id === bus.id && isMotorFn(o.fn)) : []
    }, [outputs])
    const [step, setStep] = useState<number | null>(null)
    const [picks, setPicks] = useState<Record<number, number>>({})
    const [level, setLevel] = useState(10)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const lvl = Math.min(level, cap)
    const cur = step != null ? motorOutputs[step] : null

    const pulse = useCallback((o: Output) => {
        if (timer.current) clearTimeout(timer.current)
        spin(o.fn, lvl / 100)
        timer.current = setTimeout(() => spin(o.fn, null), 1500)
    }, [spin, lvl])
    useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

    // Testing switched off mid-way: abandon the run.
    const [prevEnabled, setPrevEnabled] = useState(enabled)
    if (prevEnabled !== enabled) {
        setPrevEnabled(enabled)
        if (!enabled) setStep(null)
    }

    const begin = () => { setPicks({}); setStep(0); if (motorOutputs[0]) pulse(motorOutputs[0]) }
    const pick = (rotor: number) => {
        if (step == null || !cur) return
        if (timer.current) clearTimeout(timer.current)
        spin(cur.fn, null)
        const next = { ...picks, [cur.n]: rotor }
        setPicks(next)
        const s = step + 1
        if (s < motorOutputs.length) { setStep(s); setTimeout(() => pulse(motorOutputs[s]), 400) }
        else setStep(motorOutputs.length)
    }
    const review = step != null && step >= motorOutputs.length
    const chosen = Object.values(picks)
    const dup = chosen.length !== new Set(chosen).size
    const changes = motorOutputs.filter(o => picks[o.n] != null && 101 + picks[o.n] !== o.fn)
    const apply = async () => {
        await writeParams(changes.map(o => [`${o.bus.prefix}_FUNC${o.n}`, 101 + picks[o.n]] as [string, number]))
        setStep(null)
    }

    return (
        <Panel title="Identify and assign motors" hint="match each output to the motor that spins" right={<Fan size={16} style={{ color: T.muted }} aria-hidden />}>
            {step == null && (
                <>
                    <p style={{ margin: 0, fontSize: 14, color: T.text, lineHeight: 1.55 }}>
                        Each motor output spins briefly in turn. Click the motor on the drawing that actually moved. At the end you can write the corrected output mapping.
                    </p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13, color: T.muted }}>Spin level</span>
                        <OptionSelect size="sm" aria-label="Identify spin level" className="w-auto min-w-[80px] text-[13px] data-[size=sm]:h-8"
                            value={level} onChange={setLevel} options={[5, 8, 10, 15].map(v => ({ value: v, label: `${v} %` }))} />
                        <Btn kind="primary" onClick={begin} disabled={!enabled || motorOutputs.length === 0}
                            title={!enabled ? 'Enable testing first' : undefined}><Hand size={14} /> Start identifying</Btn>
                        {motorOutputs.length === 0 && <span style={{ fontSize: 13, color: T.muted }}>No outputs are set to a motor function.</span>}
                    </div>
                </>
            )}
            {step != null && !review && cur && (
                <Grid min={260}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <Chip tone="warn">Output {cur.n} of {motorOutputs.length}</Chip>
                        <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: T.text, lineHeight: 1.5 }}>
                            {cur.bus.label} output {cur.n} ({functionLabel(cur.fn)}) is spinning at {lvl} %. Click the motor that moved.
                        </p>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <Btn onClick={() => pulse(cur)}>Spin again</Btn>
                            <Btn onClick={() => { const s = step + 1; setStep(s); if (s < motorOutputs.length) setTimeout(() => pulse(motorOutputs[s]), 400) }}>Skip</Btn>
                            <Btn kind="danger" onClick={() => { spin(cur.fn, null); setStep(null) }}>Cancel</Btn>
                        </div>
                    </div>
                    <RotorDiagram rotors={rotors} onPick={pick} pickMode
                        labels={Object.fromEntries(Object.entries(picks).map(([n, r]) => [r, `O${n}`]))} />
                </Grid>
            )}
            {review && (
                <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'auto auto auto', gap: '4px 18px', fontSize: 14, fontVariantNumeric: 'tabular-nums', color: T.text, justifyContent: 'start' }}>
                        <span style={{ color: T.muted, fontSize: 12, fontWeight: 600 }}>Output</span>
                        <span style={{ color: T.muted, fontSize: 12, fontWeight: 600 }}>Now</span>
                        <span style={{ color: T.muted, fontSize: 12, fontWeight: 600 }}>Will be</span>
                        {motorOutputs.map(o => (
                            <React.Fragment key={o.n}>
                                <span>{o.n}</span>
                                <span>{functionLabel(o.fn)}</span>
                                <span style={{ fontWeight: 700, color: picks[o.n] == null ? T.muted : 101 + picks[o.n] !== o.fn ? T.accent : T.text }}>
                                    {picks[o.n] == null ? 'skipped' : `Motor ${picks[o.n] + 1}`}
                                </span>
                            </React.Fragment>
                        ))}
                    </div>
                    {dup && <Note tone="warn">Two outputs were matched to the same motor. Run it again.</Note>}
                    <div style={{ display: 'flex', gap: 8 }}>
                        <Btn kind="primary" disabled={dup || changes.length === 0} onClick={apply}>{changes.length ? `Write ${changes.length} change${changes.length > 1 ? 's' : ''}` : 'Already correct'}</Btn>
                        <Btn onClick={begin} disabled={!enabled}>Run again</Btn>
                        <Btn onClick={() => setStep(null)}>Close</Btn>
                    </div>
                </>
            )}
        </Panel>
    )
}

export type { ParamSpec }
