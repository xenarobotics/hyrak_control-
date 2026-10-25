'use client'

// Config > Tuning > live response: QGroundControl's PID tuning charts.
// The selected loop's setpoint against what the aircraft did, with that
// loop's gains beside it so the pilot edits and watches in one place, and a
// step capture that reads off overshoot, rise and settling time.

import React, { useMemo, useState } from 'react'
import { Crosshair, Pause, Play, RotateCcw } from 'lucide-react'
import { Btn, Chip, FOCUS_RING, Note, NumberBox, Panel, T, Tip, mix, resolveKey, type ParamSpec } from '@/components/config/kit'
import { useVehicleParams, writeParam } from '@/lib/vehicleParams'
import { series, useTuningStream, type Axis, type Loop, type Pt } from '@/lib/tuningStream'
import { TuningChart, MEAS_COLOR, SP_COLOR } from './TuningChart'
import { analyzeStep, type StepResult } from './stepAnalysis'
import { gainsFor, LOOP_ADVICE } from './gains'
import { fwGainsFor } from './fwGains'

const LOOPS: { id: Loop; label: string }[] = [
    { id: 'rate', label: 'Rate' }, { id: 'attitude', label: 'Attitude' },
    { id: 'velocity', label: 'Velocity' }, { id: 'position', label: 'Position' },
]
const ANG_AXES = ['Roll', 'Pitch', 'Yaw']
const NED_AXES = ['North', 'East', 'Down']
const WINDOWS = [5, 10, 20] as const

const META: Record<Loop, { unit: string; minRange: number; stepThr: [number, number, number]; what: string }> = {
    rate: { unit: '°/s', minRange: 20, stepThr: [30, 30, 20], what: 'rate' },
    attitude: { unit: '°', minRange: 4, stepThr: [5, 5, 10], what: 'angle' },
    velocity: { unit: 'm/s', minRange: 0.4, stepThr: [0.5, 0.5, 0.4], what: 'velocity' },
    position: { unit: 'm', minRange: 0.4, stepThr: [0.5, 0.5, 0.4], what: 'position' },
}

type Frozen = { sp: Pt[]; meas: Pt[]; t1: number; span: number; tRef: number; step: StepResult | null }

/** `fw`: the aircraft flies as a plane too (fixed-wing or VTOL), so the
 *  gains column adds the fixed-wing gains for the same loop and axis. */
export function LiveTuning({ fw = false }: { fw?: boolean } = {}) {
    const [loop, setLoop] = useState<Loop>('rate')
    const [axis, setAxis] = useState<Axis>(0)
    const [span, setSpan] = useState<(typeof WINDOWS)[number]>(10)
    const [frozen, setFrozen] = useState<Frozen | null>(null)
    const [capMsg, setCapMsg] = useState<string | null>(null)
    const s = useTuningStream(true, loop)
    const meta = META[loop]
    const axes = loop === 'rate' || loop === 'attitude' ? ANG_AXES : NED_AXES
    const axisName = axes[axis]

    // Recomputed on every redraw tick (a new snapshot), not on every packet.
    const live = useMemo(() => series(s.snap, loop, axis), [s.snap, loop, axis])
    const hasData = live.meas.length > 0 || live.sp.length > 0
    const stale = s.stale

    const pick = (fn: () => void) => { fn(); setFrozen(null); setCapMsg(null) }
    const pause = () => {
        if (frozen) { setFrozen(null); return }
        setCapMsg(null)
        setFrozen({ sp: live.sp, meas: live.meas, t1: live.now, span, tRef: live.now, step: null })
    }
    const capture = () => {
        const r = analyzeStep(live.sp, live.meas, meta.stepThr[axis])
        if (!r) {
            setCapMsg(`No clear ${axisName.toLowerCase()} ${meta.what} step in the last minute. Move the stick sharply on this axis, hold it for a second, then let go.`)
            return
        }
        setCapMsg(null)
        const view = Math.max(2, r.tEnd - r.t0 + 0.9)
        setFrozen({ sp: live.sp, meas: live.meas, t1: r.t0 - 0.6 + view, span: view, tRef: r.t0, step: r })
    }

    const view = frozen ?? { sp: live.sp, meas: live.meas, t1: live.now, span, tRef: live.now, step: null }
    const lastOf = (a: Pt[]) => (a.length ? a[a.length - 1].v : null)
    const spNow = lastOf(live.sp), measNow = lastOf(live.meas)

    let overlay: React.ReactNode = null
    // After a disconnect the last samples stay readable; the chip says Offline.
    if (!s.connected && !hasData) {
        overlay = <Empty title="No vehicle connected" body="Connect a vehicle; the chart is most useful in flight, hovering in Position mode." />
    } else if (s.error) {
        overlay = <Empty title="No data from the vehicle" body={s.error} />
    } else if (!hasData && !frozen) {
        overlay = <Empty title="Waiting for data" body={loop === 'rate' || loop === 'attitude'
            ? 'Measured attitude shows straight away; PX4 sends rate and angle setpoints while armed.'
            : 'Velocity and position setpoints appear in Position, Hold and mission flight.'} />
    }

    const status = !s.connected ? <Chip tone="off">Offline</Chip>
        : s.error ? <Chip tone="warn">No data</Chip>
        : frozen ? <Chip tone="accent">{frozen.step ? 'Step captured' : 'Paused'}</Chip>
        : stale ? <Chip tone="warn">No samples for 3 s</Chip>
        : s.status && s.status.hz === 0 ? <Chip tone="ok">View only, normal rate</Chip>
        : s.status ? <Chip tone="ok">{s.status.hz} Hz{s.status.link === 'radio' ? ' on radio' : ''}</Chip>
        : <Chip tone="off">Starting</Chip>

    const gains = gainsFor(loop, axis)
    const fwGains = fw ? fwGainsFor(loop, axis) : []

    return (
        <Panel title="Live response" hint="setpoint against what the aircraft did" right={status}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 16px', alignItems: 'center' }}>
                <Segmented label="Controller loop" value={loop} options={LOOPS} onChange={v => pick(() => setLoop(v))} />
                <Segmented label="Axis" value={axis} options={axes.map((a, i) => ({ id: i as Axis, label: a }))} onChange={v => pick(() => setAxis(v))} />
                <Segmented label="Window" value={span} options={WINDOWS.map(w => ({ id: w, label: `${w} s` }))} onChange={v => { setSpan(v); if (frozen && !frozen.step) setFrozen({ ...frozen, span: v }) }} />
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'stretch' }}>
                <div style={{ flex: '999 1 420px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 16px', fontSize: 13, color: T.muted }}>
                        <Legend color={SP_COLOR} dashed label="Setpoint" />
                        <Legend color={MEAS_COLOR} label="Measured" />
                        <span style={{ fontSize: 12, color: T.subtle }}>{axisName} {meta.what}, {meta.unit}</span>
                        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
                            <Btn onClick={pause} disabled={!hasData && !frozen} title={frozen ? 'Back to the live chart' : 'Freeze the chart'}>
                                {frozen ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}{frozen ? 'Resume' : 'Pause'}
                            </Btn>
                            <Btn onClick={() => { s.clear(); setFrozen(null); setCapMsg(null) }} disabled={!hasData && !frozen} title="Forget the samples so far">
                                <RotateCcw size={14} aria-hidden />Clear
                            </Btn>
                            <Btn kind="primary" onClick={capture} disabled={!hasData} title="Freeze around the latest large setpoint change and measure it">
                                <Crosshair size={14} aria-hidden />Capture step
                            </Btn>
                        </span>
                    </div>
                    <TuningChart sp={view.sp} meas={view.meas} t1={view.t1} span={view.span} tRef={view.tRef}
                        minRange={meta.minRange} step={view.step} overlay={overlay}
                        label={`${axisName} ${meta.what} setpoint and measured, ${view.span.toFixed(0)} seconds`} />
                    {capMsg && <Note tone="warn">{capMsg}</Note>}
                    {view.step ? <StepReadouts r={view.step} unit={meta.unit} />
                        : (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 28px' }}>
                                <Stat label="Setpoint" value={fmt(spNow)} unit={meta.unit} />
                                <Stat label="Measured" value={fmt(measNow)} unit={meta.unit} />
                                <Stat label="Error" value={spNow != null && measNow != null ? fmt(spNow - measNow) : '-'} unit={meta.unit} />
                                {s.status && <Stat label="Link use" value={(s.status.bytes_s / 1000).toFixed(1)} unit="kB/s" />}
                            </div>
                        )}
                </div>
                <aside aria-label={`${axisName} ${meta.what} gains`} style={{ flex: '1 1 280px', maxWidth: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 12px', borderRadius: 8, background: T.surface2, border: `1px solid ${T.border}` }}>
                    <h4 style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 700, color: T.text }}>{axisName} {meta.what} gains</h4>
                    {gains.map(g => <GainRow key={g.key} spec={g} />)}
                    {fwGains.length > 0 && <h4 style={{ margin: '10px 0 4px', fontSize: 13, fontWeight: 700, color: T.text }}>Fixed-wing {meta.what} gains</h4>}
                    {fwGains.map(g => <GainRow key={g.key} spec={g} />)}
                    <p style={{ margin: '8px 0 0', fontSize: 12, lineHeight: 1.5, color: T.muted }}>{LOOP_ADVICE[loop]}</p>
                </aside>
            </div>
        </Panel>
    )
}

/** One gain beside the chart: narrower than ParamRow so label and box stay
 *  on one line at phone width. Each commit is a write to the aircraft. */
function GainRow({ spec }: { spec: ParamSpec }) {
    const vp = useVehicleParams()
    const key = resolveKey(spec, vp.has)
    const live = vp.get(key)
    const missing = vp.ready && live == null
    const failed = vp.failed[key]
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 38 }}>
            <span style={{ flex: '1 1 auto', minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: missing ? T.muted : T.text }}>{spec.label}</span>
                {spec.tip && <Tip text={`${spec.tip} (${key})`} />}
                {!vp.ready && <span style={{ fontSize: 12, color: T.subtle }}>default</span>}
                {missing && <span style={{ fontSize: 12, color: T.muted }}>not on this drone</span>}
            </span>
            <span title={failed || key} style={{ display: 'inline-flex', borderRadius: 7, flexShrink: 0,
                outline: vp.pending[key] ? `2px solid ${mix('var(--app-accent)', 50)}` : failed ? `2px solid ${mix('var(--app-danger)', 60)}` : undefined }}>
                <NumberBox label={`${spec.label} (${key})`} value={vp.ready ? live : spec.def ?? null} disabled={!vp.ready || missing}
                    onCommit={v => writeParam(key, v)} min={spec.min} max={spec.max} decimals={spec.decimals} unit={spec.unit} width={88}
                    placeholder={missing ? 'n/a' : undefined} />
            </span>
        </div>
    )
}

function fmt(v: number | null): string {
    if (v == null) return '-'
    const a = Math.abs(v)
    const out = v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2)
    return /^-0(\.0+)?$/.test(out) ? out.slice(1) : out
}

function StepReadouts({ r, unit }: { r: StepResult; unit: string }) {
    const over = r.overshootPct
    const tone = over > 25 ? 'danger' : over > 10 ? 'warn' : undefined
    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 28px', alignItems: 'flex-end' }}>
            <Stat label="Step" value={`${fmt(r.before)} to ${fmt(r.after)}`} unit={unit} />
            <Stat label="Overshoot" value={over.toFixed(1)} unit="%" tone={tone} />
            <Stat label="Rise time (10 to 90 %)" value={r.riseS == null ? 'did not reach' : (r.riseS * 1000).toFixed(0)} unit={r.riseS == null ? undefined : 'ms'} />
            <Stat label={`Settling (within ${r.bandPct} %)`} value={r.settleS == null ? 'not settled' : (r.settleS * 1000).toFixed(0)} unit={r.settleS == null ? undefined : 'ms'}
                tone={r.settleS == null ? 'warn' : undefined} />
        </div>
    )
}

function Stat({ label, value, unit, tone }: { label: string; value: string; unit?: string; tone?: 'warn' | 'danger' }) {
    const c = tone === 'danger' ? T.danger : tone === 'warn' ? T.warn : T.text
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: T.muted }}>{label}</span>
            <span style={{ fontSize: 17, fontWeight: 700, color: c, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {value}{unit && <span style={{ fontSize: 12, fontWeight: 600, color: T.muted, marginLeft: 3 }}>{unit}</span>}
            </span>
        </div>
    )
}

function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
    return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600, color: T.text }}>
            <svg width={22} height={8} aria-hidden><line x1={1} x2={21} y1={4} y2={4} stroke={color} strokeWidth={2.5} strokeDasharray={dashed ? '6 3' : undefined} strokeLinecap="round" /></svg>
            {label}
        </span>
    )
}

function Empty({ title, body }: { title: string; body: string }) {
    return (
        <div style={{ maxWidth: 360, textAlign: 'center', padding: '12px 16px', borderRadius: 8, background: 'hsl(var(--app-surface))', border: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{title}</div>
            <div style={{ marginTop: 4, fontSize: 13, lineHeight: 1.5, color: T.muted }}>{body}</div>
        </div>
    )
}

function Segmented<V extends string | number>({ label, value, options, onChange }: {
    label: string; value: V; options: { id: V; label: string }[]; onChange: (v: V) => void
}) {
    return (
        <div role="radiogroup" aria-label={label} style={{ display: 'inline-flex', padding: 2, gap: 2, borderRadius: 8, background: T.surface2, border: `1px solid ${T.border}`, maxWidth: '100%', overflowX: 'auto' }}>
            {options.map(o => {
                const on = o.id === value
                return (
                    <button key={String(o.id)} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.id)}
                        className={FOCUS_RING + ' transition-colors ' + (on ? '' : 'hover:text-app-text')}
                        style={{ minHeight: 30, padding: '0 12px', borderRadius: 6, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
                            fontSize: 13, fontWeight: on ? 700 : 600,
                            background: on ? 'hsl(var(--app-surface))' : 'transparent',
                            color: on ? T.text : T.muted,
                            boxShadow: on ? `0 0 0 1px ${mix('var(--app-accent)', 35)}` : 'none' }}>
                        {o.label}
                    </button>
                )
            })}
        </div>
    )
}
