'use client'

// Config > Power. What QGroundControl's Power page does, on the aircraft's
// own parameters: battery 1 and 2 (source, cells, full and empty cell
// voltage, capacity, load compensation), the analog power module's voltage
// divider and amps-per-volt with "calculate from a meter reading", the
// low / critical / emergency levels and what PX4 does at them, and ESC
// calibration. Nothing here is stored in the browser.

import React, { useMemo, useState } from 'react'
import { Battery, Calculator, Zap } from 'lucide-react'
import { useDroneStore } from '@/store/drone'
import { useVehicleParams, writeParam } from '@/lib/vehicleParams'
import { droneAction } from '@/lib/droneAction'
import {
    Btn, Chip, Dialog, Grid, Note, NumberBox, Panel, ParamRow, ParamSourceBar, Readout, ReloadButton, SubTabs, T, mix,
    resolveKey, type ParamSpec,
} from '@/components/config/kit'

const SOURCE_OPTS = [
    { value: -1, label: 'Disabled' },
    { value: 0, label: 'Power module (analog)' },
    { value: 1, label: 'External (smart battery, MAVLink)' },
    { value: 2, label: 'ESC telemetry' },
]
const CELL_OPTS = [{ value: 0, label: 'Unknown' }, ...Array.from({ length: 16 }, (_, i) => ({ value: i + 1, label: `${i + 1}S` }))]

export const LOW_BAT_ACT_OPTS = [
    { value: 0, label: 'Warning only' },
    { value: 2, label: 'Land at critical' },
    { value: 3, label: 'Return at critical, land at emergency' },
]

/** Battery n's keys, with the pre-1.13 BAT_* names as a fallback for battery 1. */
function k(n: number, suffix: string): { key: string; alt?: string[] } {
    return n === 1 ? { key: `BAT1_${suffix}`, alt: [`BAT_${suffix}`] } : { key: `BAT${n}_${suffix}` }
}

function packSpecs(n: number): ParamSpec[] {
    return [
        { ...k(n, 'SOURCE'), label: 'Source', options: SOURCE_OPTS, def: n === 1 ? 0 : -1, tip: 'Where the battery reading comes from. Power module = the analog voltage and current pins on the flight controller.' },
        { ...k(n, 'N_CELLS'), label: 'Cells in series', options: CELL_OPTS, def: 0, tip: 'The S number of the pack. A wrong value makes every percentage and warning wrong.' },
        { ...k(n, 'V_CHARGED'), label: 'Full cell voltage', unit: 'V', def: 4.05, min: 3, max: 5, step: 0.01, decimals: 2, tip: 'Voltage of one cell when the pack counts as full. 4.05 V is PX4\'s default for LiPo under light load; 4.2 V for a resting full LiPo, 4.35 V for HV.' },
        { ...k(n, 'V_EMPTY'), label: 'Empty cell voltage', unit: 'V', def: 3.6, min: 2.5, max: 4, step: 0.01, decimals: 2, tip: 'Voltage of one cell when the pack counts as empty. 3.5 to 3.6 V for LiPo, around 3.0 V for Li-ion.' },
        { ...k(n, 'CAPACITY'), label: 'Capacity', unit: 'mAh', def: -1, min: -1, max: 100000, step: 50, tip: 'Pack capacity. With a current sensor, PX4 blends used mAh into the remaining estimate. -1 = unknown.' },
    ]
}
function loadSpecs(n: number): ParamSpec[] {
    return [
        { ...k(n, 'V_LOAD_DROP'), label: 'Voltage drop under load', unit: 'V', def: 0.1, min: 0, max: 0.5, step: 0.01, decimals: 2, tip: 'Per-cell sag at full throttle. Used only when there is no current sensor, so the percentage does not plunge on every climb.' },
        { ...k(n, 'R_INTERNAL'), label: 'Internal resistance', unit: 'Ω', def: -1, min: -1, max: 0.2, step: 0.001, decimals: 3, tip: 'Per-cell internal resistance for load compensation with a current sensor. -1 lets PX4 estimate it in flight.' },
    ]
}

const THRESH: ParamSpec[] = [
    { key: 'BAT_LOW_THR', label: 'Low level', unit: '%', scale: 100, def: 0.15, min: 12, max: 50, step: 1, decimals: 0, tip: 'Remaining charge that raises the low-battery warning.' },
    { key: 'BAT_CRIT_THR', label: 'Critical level', unit: '%', scale: 100, def: 0.07, min: 5, max: 25, step: 1, decimals: 0, tip: 'Remaining charge that triggers the action below.' },
    { key: 'BAT_EMERGEN_THR', label: 'Emergency level', unit: '%', scale: 100, def: 0.05, min: 3, max: 20, step: 1, decimals: 0, tip: 'Remaining charge at which PX4 lands wherever it is.' },
]
export const LOW_BAT_ACT_SPEC: ParamSpec = { key: 'COM_LOW_BAT_ACT', label: 'Action', options: LOW_BAT_ACT_OPTS, def: 0, tip: 'What PX4 does as the battery passes the critical and emergency levels.' }

export function PowerSetup() {
    const vp = useVehicleParams()
    const [tab, setTab] = useState<'1' | '2'>('1')
    const hasBat2 = vp.has('BAT2_SOURCE')
    const n = tab === '2' ? 2 : 1
    const src = vp.get(resolveKey(k(n, 'SOURCE') as ParamSpec, vp.has))
    const disabled = vp.ready && src === -1

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}><ParamSourceBar what="the battery setup" /></div>
                <ReloadButton />
            </div>

            <SubTabs label="Battery" value={tab} onChange={setTab} tabs={[
                { id: '1', label: 'Battery 1' },
                ...(hasBat2 || !vp.ready ? [{ id: '2' as const, label: 'Battery 2', badge: vp.ready && vp.get('BAT2_SOURCE') === -1 ? <span style={{ fontSize: 12, color: T.muted, fontWeight: 600 }}>off</span> : undefined }] : []),
            ]} />

            {n === 1 && <LiveBattery />}

            <Grid min={340}>
                <Panel title="Pack" hint={disabled ? 'this battery is disabled' : undefined}>
                    {packSpecs(n).map(s => <ParamRow key={s.key} spec={s} disabled={disabled && !s.key.endsWith('SOURCE')} />)}
                    <PackRange n={n} />
                </Panel>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <AnalogSensor n={n} disabled={disabled || (vp.ready && src !== 0)} />
                    <Panel title="Load compensation" hint="keeps the percentage steady under throttle">
                        {loadSpecs(n).map(s => <ParamRow key={s.key} spec={s} disabled={disabled} />)}
                    </Panel>
                </div>
            </Grid>

            <Grid min={340}>
                <Thresholds />
                <EscCalibration />
            </Grid>
        </div>
    )
}

// ── Live readings ───────────────────────────────────────────────────────────

function LiveBattery() {
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const bat = useDroneStore(s => s.telemetry?.battery)
    const vp = useVehicleParams()
    const cells = vp.get(vp.has('BAT1_N_CELLS') ? 'BAT1_N_CELLS' : 'BAT_N_CELLS') ?? 0
    const v = connected && bat && bat.voltage_v > 0 ? bat.voltage_v : null
    const pct = connected && bat && bat.remaining_percent >= 0 ? bat.remaining_percent : null
    const low = (vp.get('BAT_LOW_THR') ?? 0.15) * 100
    const crit = (vp.get('BAT_CRIT_THR') ?? 0.07) * 100
    const tone = pct == null ? undefined : pct <= crit ? 'danger' as const : pct <= low ? 'warn' as const : 'ok' as const
    return (
        <Panel title="Now" hint={connected ? 'live from the drone' : 'connect a drone for live readings'}
            right={<Battery size={16} style={{ color: T.muted }} aria-hidden />}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 16 }}>
                <Readout label="Pack voltage" value={v != null ? v.toFixed(2) : '-'} unit="V" />
                <Readout label="Per cell" value={v != null && cells > 0 ? (v / cells).toFixed(2) : '-'} unit="V" />
                <Readout label="Current" value={connected && bat?.current_a != null ? bat.current_a.toFixed(1) : '-'} unit="A" />
                <Readout label="Used" value={connected && bat?.consumed_mah != null ? Math.round(bat.consumed_mah) : '-'} unit="mAh" />
                <Readout label="Remaining" value={pct != null ? Math.round(pct) : '-'} unit="%" tone={tone} />
            </div>
            {connected && bat && bat.current_a == null && (
                <p style={{ margin: 0, fontSize: 13, color: T.muted }}>No current reading: this power setup has no current sensor, or PX4 is not reporting one.</p>
            )}
        </Panel>
    )
}

/** Where the live voltage sits between the empty and full pack voltage. */
function PackRange({ n }: { n: number }) {
    const vp = useVehicleParams()
    const bat = useDroneStore(s => s.telemetry?.battery)
    const get = (suf: string, d: number) => {
        const s = k(n, suf) as ParamSpec
        return vp.get(resolveKey(s, vp.has)) ?? d
    }
    const cells = get('N_CELLS', 0), full = get('V_CHARGED', 4.05), empty = get('V_EMPTY', 3.6)
    if (cells <= 0) return <p style={{ margin: 0, fontSize: 13, color: T.muted }}>Set the cell count to see the pack&apos;s voltage range.</p>
    const vFull = cells * full, vEmpty = cells * empty
    const live = n === 1 && vp.connected && bat && bat.voltage_v > 0 ? bat.voltage_v : null
    const pos = live == null ? null : Math.max(0, Math.min(1, (live - vEmpty) / (vFull - vEmpty)))
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>
                <span>Empty {vEmpty.toFixed(1)} V</span>
                <span>Full {vFull.toFixed(1)} V</span>
            </div>
            <div aria-hidden style={{ position: 'relative', height: 14, borderRadius: 7, background: `linear-gradient(90deg, ${mix(T.danger, 30)}, ${mix(T.warn, 30)} 30%, ${mix(T.ok, 30)})`, border: `1px solid ${T.border}` }}>
                {pos != null && <span style={{ position: 'absolute', top: -4, bottom: -4, left: `calc(${pos * 100}% - 2px)`, width: 4, borderRadius: 2, background: T.text, transition: 'left var(--dur) var(--ease-out)' }} />}
            </div>
            <p style={{ margin: 0, fontSize: 13, color: T.muted }}>
                {cells}S pack. {live != null ? <>Live {live.toFixed(2)} V, {(live / cells).toFixed(2)} V per cell.</> : 'Connect a drone to see where the pack sits now.'}
            </p>
        </div>
    )
}

// ── Analog power module ─────────────────────────────────────────────────────

function AnalogSensor({ n, disabled }: { n: number; disabled: boolean }) {
    const vp = useVehicleParams()
    const bat = useDroneStore(s => s.telemetry?.battery)
    const [calc, setCalc] = useState<null | 'v' | 'a'>(null)
    const divSpec: ParamSpec = { ...k(n, 'V_DIV'), label: 'Voltage divider', def: -1, min: -1, max: 1000, step: 0.01, decimals: 4, tip: 'Multiplier from the ADC pin to pack voltage. -1 uses the board\'s built-in value. Use Calculate with a multimeter reading to correct it.' }
    const apvSpec: ParamSpec = { ...k(n, 'A_PER_V'), label: 'Amps per volt', def: -1, min: -1, max: 1000, step: 0.01, decimals: 4, tip: 'Current sensor scale. -1 uses the board\'s built-in value. Use Calculate with a clamp-meter or wattmeter reading.' }
    const offSpec: ParamSpec = { ...k(n, 'V_OFFS_CURR'), label: 'Current sensor offset', unit: 'V', def: 0, min: -1, max: 1, step: 0.001, decimals: 3, tip: 'Voltage the current sensor reads at zero amps.' }
    const canCalc = vp.ready && !disabled && n === 1
    return (
        <Panel title="Power module" hint={disabled && vp.ready ? 'used only when the source is Power module' : 'analog voltage and current sensing'}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}><ParamRow spec={divSpec} disabled={disabled} compact /></div>
                <Btn onClick={() => setCalc('v')} disabled={!canCalc} title={n !== 1 ? 'Live readings are for battery 1 only' : undefined}><Calculator size={14} /> Calculate</Btn>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}><ParamRow spec={apvSpec} disabled={disabled} compact /></div>
                <Btn onClick={() => setCalc('a')} disabled={!canCalc}><Calculator size={14} /> Calculate</Btn>
            </div>
            <ParamRow spec={offSpec} disabled={disabled} compact />
            <CalcDialog kind={calc} onClose={() => setCalc(null)}
                param={resolveKey(calc === 'a' ? apvSpec : divSpec, vp.has)}
                current={vp.get(resolveKey(calc === 'a' ? apvSpec : divSpec, vp.has))}
                reported={calc === 'a' ? (bat?.current_a ?? null) : (bat && bat.voltage_v > 0 ? bat.voltage_v : null)} />
        </Panel>
    )
}

/** QGC's "Calculate": new = old x measured / reported. */
function CalcDialog({ kind, onClose, param, current, reported }: {
    kind: null | 'v' | 'a'; onClose: () => void; param: string; current: number | null; reported: number | null
}) {
    const [measured, setMeasured] = useState<number | null>(null)
    const unit = kind === 'a' ? 'A' : 'V'
    const what = kind === 'a' ? 'current' : 'pack voltage'
    const result = useMemo(() => {
        if (measured == null || current == null || reported == null) return null
        if (current <= 0 || reported <= 0) return null
        return current * measured / reported
    }, [measured, current, reported])
    const close = () => { setMeasured(null); onClose() }
    return (
        <Dialog open={kind != null} onClose={close} title={kind === 'a' ? 'Calculate amps per volt' : 'Calculate voltage divider'}>
            <p style={{ margin: 0, fontSize: 14, color: T.text, lineHeight: 1.55 }}>
                {kind === 'a'
                    ? 'Draw a steady current (props off: spin the motors with Actuator testing, or use a load), read it on a clamp meter or wattmeter, and enter it here.'
                    : 'Measure the pack voltage at the balance or main lead with a multimeter and enter it here.'}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center', fontSize: 14, color: T.text }}>
                <span>The drone reports</span>
                <b style={{ fontVariantNumeric: 'tabular-nums' }}>{reported != null ? `${reported.toFixed(2)} ${unit}` : 'no reading'}</b>
                <span>Measured {what}</span>
                <NumberBox label={`Measured ${what}`} value={measured} onCommit={setMeasured} unit={unit} min={0} max={kind === 'a' ? 500 : 100} />
                <span>Current {param}</span>
                <b style={{ fontVariantNumeric: 'tabular-nums' }}>{current != null ? current : '-'}</b>
                <span>New {param}</span>
                <b style={{ fontVariantNumeric: 'tabular-nums', color: result != null ? T.accent : T.muted }}>{result != null ? result.toFixed(4) : '-'}</b>
            </div>
            {current != null && current <= 0 && (
                <Note tone="warn">{param} is {current}, which means the board&apos;s built-in value. There is nothing to scale from: enter your power module&apos;s datasheet value first (for example 18.1 for a Holybro PM02 divider), then calculate.</Note>
            )}
            {reported == null && <Note tone="warn">The drone is not reporting a {what} right now.</Note>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Btn onClick={close}>Cancel</Btn>
                <Btn kind="primary" disabled={result == null} onClick={() => { if (result != null) { writeParam(param, Number(result.toFixed(4))); close() } }}>Write {result != null ? result.toFixed(4) : ''}</Btn>
            </div>
        </Dialog>
    )
}

// ── Failsafe levels ────────────────────────────────────────────────────────

function Thresholds() {
    const vp = useVehicleParams()
    const low = (vp.get('BAT_LOW_THR') ?? 0.15) * 100
    const crit = (vp.get('BAT_CRIT_THR') ?? 0.07) * 100
    const emer = (vp.get('BAT_EMERGEN_THR') ?? 0.05) * 100
    const order = emer < crit && crit < low
    // Writing a level that breaks the order is refused here: PX4 accepts it
    // and then fires the levels in a confusing order.
    const guard = (key: string, v: number) => {
        const next = { BAT_LOW_THR: low / 100, BAT_CRIT_THR: crit / 100, BAT_EMERGEN_THR: emer / 100, [key]: v }
        if (!(next.BAT_EMERGEN_THR < next.BAT_CRIT_THR && next.BAT_CRIT_THR < next.BAT_LOW_THR)) {
            window.alert('Keep emergency below critical, and critical below low.')
            return
        }
        writeParam(key, v)
    }
    return (
        <Panel title="Low battery" hint="the levels and what PX4 does">
            <div aria-hidden style={{ position: 'relative', height: 26, borderRadius: 6, background: T.surface2, border: `1px solid ${T.border}`, overflow: 'hidden' }}>
                <span style={{ position: 'absolute', inset: 0, right: `${100 - low}%`, background: mix(T.warn, 18) }} />
                <span style={{ position: 'absolute', inset: 0, right: `${100 - crit}%`, background: mix(T.danger, 22) }} />
                <span style={{ position: 'absolute', inset: 0, right: `${100 - emer}%`, background: mix(T.danger, 45) }} />
                {[['Low', low], ['Crit', crit], ['Emerg', emer]].map(([l, v]) => (
                    <span key={l as string} style={{ position: 'absolute', top: 0, bottom: 0, left: `${v}%`, borderLeft: `1px solid ${T.borderStrong}` }} />
                ))}
                <span style={{ position: 'absolute', right: 8, top: 4, fontSize: 12, color: T.muted, fontWeight: 600 }}>100%</span>
            </div>
            {THRESH.map(s => <ParamRow key={s.key} spec={s} onWrite={guard} />)}
            {!order && vp.ready && <Note tone="warn">The levels are out of order. Emergency should be below critical, and critical below low.</Note>}
            <ParamRow spec={LOW_BAT_ACT_SPEC} />
        </Panel>
    )
}

// ── ESC calibration ────────────────────────────────────────────────────────

function EscCalibration() {
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const armed = useDroneStore(s => s.telemetry?.flight_mode?.is_armed ?? false)
    const msgs = useDroneStore(s => s.fcMessages)
    const [open, setOpen] = useState(false)
    const [props, setProps] = useState(false)
    const [usb, setUsb] = useState(false)
    const [startedAt, setStartedAt] = useState<number | null>(null)
    const [err, setErr] = useState<string | null>(null)
    const log = startedAt == null ? [] : msgs.filter(m => m.ts * (m.ts < 1e12 ? 1000 : 1) >= startedAt - 1000 && /cal|esc|battery/i.test(m.text)).slice(-8)
    const start = async () => {
        setErr(null)
        const r = await droneAction('esc_calibration', { props_removed: props })
        if (r.ok) setStartedAt(Date.now()); else setErr(r.error ?? 'The drone refused')
    }
    const close = () => { setOpen(false); setProps(false); setUsb(false); setStartedAt(null); setErr(null) }
    return (
        <Panel title="ESC calibration" hint="PWM ESCs only" right={<Zap size={16} style={{ color: T.muted }} aria-hidden />}>
            <p style={{ margin: 0, fontSize: 14, color: T.text, lineHeight: 1.55 }}>
                Teaches PWM ESCs the throttle range set on the Actuators page (each output&apos;s min and max). Not needed for DShot or CAN ESCs.
            </p>
            <Btn onClick={() => setOpen(true)} disabled={!connected || armed} title={!connected ? 'Connect a drone first' : armed ? 'Disarm first' : undefined}>Start ESC calibration</Btn>
            <Dialog open={open} onClose={close} title="ESC calibration">
                {startedAt == null ? (
                    <>
                        <Note tone="danger">The motors will be driven to full throttle during this. With propellers on, the aircraft will fly off the bench.</Note>
                        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14, color: T.text, cursor: 'pointer' }}>
                            <input type="checkbox" checked={props} onChange={e => setProps(e.target.checked)} style={{ width: 18, height: 18, marginTop: 2, accentColor: 'var(--app-danger)' }} />
                            I have removed every propeller.
                        </label>
                        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14, color: T.text, cursor: 'pointer' }}>
                            <input type="checkbox" checked={usb} onChange={e => setUsb(e.target.checked)} style={{ width: 18, height: 18, marginTop: 2, accentColor: 'var(--app-accent)' }} />
                            The flight battery is unplugged and the flight controller is powered over USB.
                        </label>
                        <p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.5 }}>After you start, PX4 asks for the battery to be connected. Plug it in when told; the ESCs beep as they learn the range.</p>
                        {err && <Note tone="danger">{err}</Note>}
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                            <Btn onClick={close}>Cancel</Btn>
                            <Btn kind="primary" disabled={!props || !usb || armed} onClick={start}>Start</Btn>
                        </div>
                    </>
                ) : (
                    <>
                        <Chip tone="accent">Running</Chip>
                        <p style={{ margin: 0, fontSize: 14, color: T.text }}>Follow the drone&apos;s messages below. Connect the battery when it asks.</p>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 10, borderRadius: 8, background: T.surface2, border: `1px solid ${T.border}`, minHeight: 80 }}>
                            {log.length === 0 ? <span style={{ fontSize: 13, color: T.muted }}>Waiting for the drone...</span>
                                : log.map(m => <span key={m.id} style={{ fontSize: 13, color: m.rank >= 4 ? T.danger : T.text }}>{m.text}</span>)}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end' }}><Btn onClick={close}>Close</Btn></div>
                    </>
                )}
            </Dialog>
        </Panel>
    )
}
