'use client'

// Config > Analyze > MAVLink Inspector: QGroundControl's inspector. Every
// message the drone sends, with who sent it and how fast, opened to its
// fields; tick numbers in any messages to plot them together live.

import React, { useMemo, useState } from 'react'
import { ChevronRight, Pause, Play, RotateCcw, Search, WifiOff, X } from 'lucide-react'
import { Btn, Chip, FOCUS_RING, Grid, Note, Panel, SubTabs, T, Tip, Toggle, mix } from '@/components/config/kit'
import { OptionSelect } from '@/components/config/OptionSelect'
import { MAX_PLOT, plotId, useInspectorStream, type FieldValue, type InspMsg, type PlotRef } from '@/lib/inspectorStream'
import { LineChart, SERIES_COLORS, fmtValue, type Pt } from './LineChart'

const WINDOWS = [10, 30, 60, 120]

/** One row per scalar, and per element of a short numeric array. */
function fieldRows(fields: Record<string, FieldValue>): { field: string; value: FieldValue; plottable: boolean }[] {
    const out: { field: string; value: FieldValue; plottable: boolean }[] = []
    for (const [k, v] of Object.entries(fields)) {
        if (Array.isArray(v) && v.length <= 16 && v.every(x => typeof x === 'number' || x === null)) {
            v.forEach((x, i) => out.push({ field: `${k}[${i}]`, value: x, plottable: true }))
        } else {
            out.push({ field: k, value: v, plottable: typeof v === 'number' })
        }
    }
    return out
}

function showValue(v: FieldValue): string {
    if (v === null) return 'not a number'
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : fmtValue(v)
    if (Array.isArray(v)) return '[' + v.map(x => (typeof x === 'number' ? fmtValue(x) : String(x))).join(', ') + ']'
    return `"${v}"`
}

function hzText(hz: number, age: number): string {
    if (hz <= 0) return age > 5 ? `${Math.round(age)} s ago` : 'once'
    return hz >= 10 ? `${Math.round(hz)} Hz` : `${hz.toFixed(1)} Hz`
}

export function MavlinkInspector() {
    const [open, setOpen] = useState<string[]>([])
    const [plot, setPlot] = useState<PlotRef[]>([])
    const [fast, setFast] = useState(false)
    const [query, setQuery] = useState('')
    const [span, setSpan] = useState(30)
    const [layout, setLayout] = useState<'together' | 'separate'>('together')
    const [frozen, setFrozen] = useState<{ series: Record<string, Pt[]>; now: number } | null>(null)
    const s = useInspectorStream(true, open, plot, fast)

    const q = query.trim().toUpperCase()
    const shown = useMemo(() => s.msgs.filter(m => !q || m.name.includes(q)), [s.msgs, q])
    const comps = new Set(s.msgs.map(m => `${m.sys}:${m.comp}`)).size

    const toggleOpen = (key: string) => setOpen(o => o.includes(key) ? o.filter(k => k !== key) : [...o, key].slice(-12))
    const isPlotted = (p: PlotRef) => plot.some(x => x.key === p.key && x.field === p.field)
    const togglePlot = (p: PlotRef) => setPlot(cur => isPlotted(p) ? cur.filter(x => !(x.key === p.key && x.field === p.field)) : cur.length >= MAX_PLOT ? cur : [...cur, p])

    const src = frozen ?? { series: s.series, now: s.now }
    const lines = plot.map((p, i) => {
        const name = p.key.split(':')[0]
        return { id: plotId(p), label: `${name}.${p.field}`, color: SERIES_COLORS[i % SERIES_COLORS.length], pts: src.series[plotId(p)] ?? [] }
    })
    const t1 = Math.max(src.now, span)

    if (!s.connected) {
        return (
            <Note icon={<WifiOff size={15} style={{ color: T.muted, flexShrink: 0, marginTop: 2 }} />}>
                <b>No drone connected.</b> Connect one from the Fly tab to see every MAVLink message it sends.
            </Note>
        )
    }

    const fastNote = s.fast && fast ? (
        !s.fast.allowed ? 'Your role can watch but not change what the drone sends, so plots use the normal rate.'
            : s.fast.raised.length ? `Sped up to ${s.fast.hz} Hz: ${s.fast.raised.join(', ')} (about ${Math.round(s.fast.bytes_s / 100) / 10} kB/s more on the link).${s.fast.skipped.length ? ` Left at normal rate: ${s.fast.skipped.join(', ')}.` : ''}`
            : plot.length ? (s.fast.skipped.length ? `Left at normal rate: ${s.fast.skipped.join(', ')}.` : 'Asking the drone...') : 'Tick a field to plot first.'
    ) : null

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {s.error && <Note tone="warn">{s.error}</Note>}
            <Grid min={340}>
                <Panel title="Messages" hint={s.msgs.length ? `${s.msgs.length} from ${comps} component${comps === 1 ? '' : 's'}` : 'Listening...'} pad={12} gap={10}>
                    <label style={{ position: 'relative', display: 'block' }}>
                        <span className="sr-only">Find a message</span>
                        <Search size={14} aria-hidden style={{ position: 'absolute', left: 10, top: 10, color: T.muted }} />
                        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="ATTITUDE, GPS..." className={FOCUS_RING}
                            style={{ width: '100%', height: 34, padding: '0 10px 0 30px', borderRadius: 8, border: `1px solid ${T.borderStrong}`, background: T.surface, color: T.text, fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
                    </label>
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 560, overflowY: 'auto', border: `1px solid ${T.border}`, borderRadius: 8 }}
                        className="divide-y divide-app-border">
                        {shown.length === 0 && (
                            <li style={{ padding: 14, fontSize: 13, color: T.muted }}>{s.msgs.length ? 'No message matches.' : 'Waiting for the first messages from the drone.'}</li>
                        )}
                        {shown.map(m => <MsgRow key={m.key} m={m} open={open.includes(m.key)} onToggle={() => toggleOpen(m.key)}
                            isPlotted={isPlotted} onPlot={togglePlot} full={plot.length >= MAX_PLOT} />)}
                    </ul>
                </Panel>

                <Panel title="Plot" hint={plot.length ? `${plot.length} of ${MAX_PLOT}` : undefined} pad={12} gap={10}
                    right={<>
                        <Btn onClick={() => setFrozen(f => f ? null : { series: s.series, now: s.now })} disabled={!plot.length}>
                            {frozen ? <><Play size={14} /> Resume</> : <><Pause size={14} /> Pause</>}
                        </Btn>
                        <Btn onClick={() => { s.clear(); setFrozen(null) }} disabled={!plot.length} title="Clear the plotted history"><RotateCcw size={14} /> Clear</Btn>
                    </>}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                        <span id="insp-window" style={{ fontSize: 13, color: T.muted }}>Window</span>
                        <OptionSelect size="sm" aria-labelledby="insp-window" value={span} onChange={v => setSpan(v)} className="w-auto min-w-[90px] text-[13px] data-[size=sm]:h-8"
                            options={WINDOWS.map(w => ({ value: w, label: `${w} s` }))} />
                        <div style={{ flex: '0 1 auto' }}>
                            <SubTabs label="Plot layout" value={layout} onChange={setLayout} tabs={[{ id: 'together', label: 'Together' }, { id: 'separate', label: 'Separate' }]} />
                        </div>
                    </div>
                    {lines.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {lines.map((l, i) => (
                                <span key={l.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 4px 2px 8px', borderRadius: 999, border: `1px solid ${T.border}`, fontSize: 12, fontWeight: 600, color: T.text, maxWidth: '100%' }}>
                                    <span aria-hidden style={{ width: 10, height: 3, borderRadius: 2, background: l.color, flexShrink: 0 }} />
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.label}</span>
                                    <button type="button" aria-label={`Stop plotting ${l.label}`} onClick={() => togglePlot(plot[i])} className={FOCUS_RING + ' hover:bg-app-surface-2'}
                                        style={{ border: 'none', background: 'transparent', color: T.muted, cursor: 'pointer', borderRadius: 999, width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><X size={12} /></button>
                                </span>
                            ))}
                        </div>
                    )}
                    {layout === 'together' || lines.length === 0 ? (
                        <LineChart label="Plotted MAVLink fields" series={lines} t1={t1} span={span} gapS={3} hover
                            overlay={lines.length === 0 ? <span style={{ fontSize: 13, color: T.muted, textAlign: 'center', background: T.surface, padding: '8px 12px', borderRadius: 8 }}>Open a message and tick a number to plot it here. Up to {MAX_PLOT}, from any messages.</span> : undefined} />
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {lines.map(l => (
                                <div key={l.id}>
                                    <div style={{ fontSize: 12, fontWeight: 700, color: T.muted, margin: '0 0 2px 52px' }}>{l.label}</div>
                                    <LineChart label={l.label} series={[l]} t1={t1} span={span} gapS={3} height={130} hover />
                                </div>
                            ))}
                        </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <Toggle label="Faster updates for plotted messages" value={fast} onChange={setFast} />
                        <span style={{ fontSize: 13, color: T.text, fontWeight: 600 }}>Faster updates</span>
                        <Tip text={`Asks the drone to send the plotted messages faster (${s.link === 'radio' ? '10 Hz on a telemetry radio, within a small budget' : '50 Hz on USB or network links'}) while this plot is open. The normal rates come back when you untick them, turn this off or leave the page. Needs the right to fly this drone.`} />
                        {frozen && <Chip tone="accent">Paused</Chip>}
                    </div>
                    {fastNote && <p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.5 }}>{fastNote}</p>}
                </Panel>
            </Grid>
        </div>
    )
}

function MsgRow({ m, open, onToggle, isPlotted, onPlot, full }: {
    m: InspMsg; open: boolean; onToggle: () => void
    isPlotted: (p: PlotRef) => boolean; onPlot: (p: PlotRef) => void; full: boolean
}) {
    const rows = open && m.fields ? fieldRows(m.fields) : null
    const stale = m.hz <= 0 && m.age > 5
    return (
        <li>
            <button type="button" onClick={onToggle} aria-expanded={open}
                className={FOCUS_RING + ' w-full text-left hover:bg-app-surface-2 transition-colors'}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', minHeight: 40, border: 'none', background: open ? mix('var(--app-accent)', 6) : 'transparent', cursor: 'pointer' }}>
                <ChevronRight size={14} aria-hidden style={{ color: T.muted, flexShrink: 0, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform var(--dur) var(--ease-out)' }} />
                <span className="font-code" style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, color: stale ? T.muted : T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
                <span title="System id / component id" style={{ fontSize: 12, color: T.muted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{m.sys}/{m.comp}</span>
                <span style={{ width: 72, textAlign: 'right', fontSize: 13, fontWeight: 600, color: stale ? T.muted : T.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{hzText(m.hz, m.age)}</span>
            </button>
            {open && (
                <div style={{ padding: '4px 10px 10px 32px' }}>
                    <div style={{ fontSize: 12, color: T.muted, marginBottom: 4 }}>{m.n.toLocaleString()} received</div>
                    {!rows ? <div style={{ fontSize: 13, color: T.muted }}>Reading fields...</div> : (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
                            <tbody>
                                {rows.map(r => {
                                    const p = { key: m.key, field: r.field }
                                    const on = isPlotted(p)
                                    return (
                                        <tr key={r.field} style={{ borderTop: `1px solid ${T.border}` }}>
                                            <td style={{ width: 30, padding: '3px 0' }}>
                                                {r.plottable && (
                                                    <input type="checkbox" checked={on} disabled={!on && full} onChange={() => onPlot(p)}
                                                        aria-label={`Plot ${m.name}.${r.field}`} title={!on && full ? `Up to ${MAX_PLOT} plotted fields` : 'Plot this field'}
                                                        style={{ width: 16, height: 16, accentColor: 'var(--app-accent)', cursor: !on && full ? 'not-allowed' : 'pointer' }} />
                                                )}
                                            </td>
                                            <td className="font-code" style={{ padding: '3px 8px 3px 0', color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.field}</td>
                                            <td style={{ padding: '3px 0', color: T.text, textAlign: 'right', fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={showValue(r.value)}>{showValue(r.value)}</td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    )}
                </div>
            )}
        </li>
    )
}
