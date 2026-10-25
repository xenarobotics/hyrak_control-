'use client'

// Config > Analyze > Log viewer: open a PX4 flight log (.ulg) saved from
// Config > Logs and plot any of its topics' fields over time. The file is
// read in this browser (./ulog.ts) and never uploaded.

import React, { useMemo, useRef, useState } from 'react'
import { ChevronRight, FileText, Search, X, ZoomOut } from 'lucide-react'
import { Btn, Chip, FOCUS_RING, Grid, Note, Panel, SubTabs, T, mix } from '@/components/config/kit'
import { LineChart, SERIES_COLORS, type Pt } from './LineChart'
import { decimate, parseULog, readSeries, topicLabel, type ULog, type ULogTopic } from './ulog'

const MAX_LINES = 6
const MAX_FILE = 1024 ** 3     // 1 GB: past this a browser tab runs out of memory

interface Pick { topic: number; field: string }

export function fmtBytes(n: number): string {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
    if (n >= 1024) return `${Math.round(n / 1024)} KB`
    return `${n} B`
}

export function fmtDuration(s: number): string {
    if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
    if (s >= 60) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`
    return `${s.toFixed(1)} s`
}

const LEVEL = ['Emergency', 'Alert', 'Critical', 'Error', 'Warning', 'Notice', 'Info', 'Debug']
const levelColor = (l: number) => l <= 3 ? T.danger : l === 4 ? T.warn : T.muted

/** A file picker drawn as a button, with the chosen file's name beside it. */
export function FilePick({ label, accept, onFiles, multiple, folder, name, busy }: {
    label: string; accept?: string; onFiles: (f: File[]) => void; multiple?: boolean; folder?: boolean; name?: string | null; busy?: boolean
}) {
    const ref = useRef<HTMLInputElement>(null)
    return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
            <input ref={el => { ref.current = el; if (el && folder) el.setAttribute('webkitdirectory', '') }} type="file" accept={accept} multiple={multiple || folder} hidden
                onChange={e => { const f = Array.from(e.target.files ?? []); e.target.value = ''; if (f.length) onFiles(f) }} />
            <Btn kind="primary" onClick={() => ref.current?.click()} disabled={busy}><FileText size={14} /> {label}</Btn>
            {name && <span style={{ fontSize: 13, color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>{name}</span>}
        </span>
    )
}

export function LogViewer() {
    const [file, setFile] = useState<{ name: string; size: number } | null>(null)
    const [log, setLog] = useState<ULog | null>(null)
    const [busy, setBusy] = useState(false)
    const [err, setErr] = useState<string | null>(null)
    const [picks, setPicks] = useState<Pick[]>([])
    const [openTopic, setOpenTopic] = useState<number | null>(null)
    const [query, setQuery] = useState('')
    const [zoom, setZoom] = useState<[number, number] | null>(null)
    const [layout, setLayout] = useState<'together' | 'separate'>('together')
    const cache = useRef(new Map<string, { t: Float64Array; v: Float64Array }>())

    const load = async (f: File) => {
        setErr(null); setLog(null); setPicks([]); setZoom(null); setOpenTopic(null); cache.current.clear()
        if (f.size > MAX_FILE) { setErr(`This log is ${fmtBytes(f.size)}. The viewer opens logs up to 1 GB.`); return }
        setBusy(true)
        setFile({ name: f.name, size: f.size })
        try {
            const buf = await f.arrayBuffer()
            const l = parseULog(buf)
            setLog(l)
            const lp = l.topics.findIndex(t => t.name === 'vehicle_local_position' && t.starts.length)
            if (lp >= 0 && l.topics[lp].fields.some(x => x.name === 'z')) setPicks([{ topic: lp, field: 'z' }])
        } catch (e) {
            setErr(e instanceof Error ? e.message : 'This file could not be read as a flight log')
        } finally {
            setBusy(false)
        }
    }

    const duration = log ? (log.lastUs - log.firstUs) / 1e6 : 0
    const [a, b] = zoom ?? [0, Math.max(1, duration)]
    const lines = useMemo(() => {
        if (!log) return []
        return picks.map((p, i) => {
            const topic = log.topics[p.topic]
            const key = `${p.topic}|${p.field}`
            let s = cache.current.get(key)
            if (!s) { s = readSeries(log, topic, p.field); cache.current.set(key, s) }
            const pts: Pt[] = decimate(s.t, s.v, a, b, 700)
            return { id: key, label: `${topicLabel(topic)}.${p.field}`, color: SERIES_COLORS[i % SERIES_COLORS.length], pts }
        })
    }, [log, picks, a, b])

    const isPicked = (p: Pick) => picks.some(x => x.topic === p.topic && x.field === p.field)
    const toggle = (p: Pick) => setPicks(cur => isPicked(p) ? cur.filter(x => !(x.topic === p.topic && x.field === p.field)) : cur.length >= MAX_LINES ? cur : [...cur, p])

    const q = query.trim().toLowerCase()
    const topics = log ? log.topics.map((t, i) => ({ t, i })).filter(({ t }) => t.starts.length && (!q || t.name.includes(q) || t.fields.some(f => f.name.toLowerCase().includes(q)))) : []

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Panel title="Flight log" hint="a .ulg file saved from Config > Logs, opened in this browser only">
                <FilePick label={log ? 'Open another log' : 'Open a log'} accept=".ulg" onFiles={f => load(f[0])} name={file ? `${file.name}, ${fmtBytes(file.size)}` : null} busy={busy} />
                {busy && <span style={{ fontSize: 13, color: T.muted }}>Reading the log...</span>}
                {err && <Note tone="warn">{err}</Note>}
                {log && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        <Chip tone="off">{fmtDuration(duration)}</Chip>
                        {log.info.sys_name != null && <Chip tone="off">{String(log.info.sys_name)}{log.info.ver_hw ? ` on ${log.info.ver_hw}` : ''}</Chip>}
                        {typeof log.info.ver_sw === 'string' && <Chip tone="off">firmware {log.info.ver_sw.slice(0, 8)}</Chip>}
                        <Chip tone="off">{log.topics.filter(t => t.starts.length).length} topics</Chip>
                        {log.dropouts > 0 && <Chip tone="warn">{log.dropouts} dropouts, {(log.dropoutMs / 1000).toFixed(1)} s lost</Chip>}
                        {log.truncated && <Chip tone="warn">File ends early</Chip>}
                    </div>
                )}
            </Panel>

            {log && (
                <Grid min={340}>
                    <Panel title="Topics" hint="open one, tick fields to plot" pad={12} gap={10}>
                        <label style={{ position: 'relative', display: 'block' }}>
                            <span className="sr-only">Find a topic or field</span>
                            <Search size={14} aria-hidden style={{ position: 'absolute', left: 10, top: 10, color: T.muted }} />
                            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="attitude, battery, z..." className={FOCUS_RING}
                                style={{ width: '100%', height: 34, padding: '0 10px 0 30px', borderRadius: 8, border: `1px solid ${T.borderStrong}`, background: T.surface, color: T.text, fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
                        </label>
                        <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 560, overflowY: 'auto', border: `1px solid ${T.border}`, borderRadius: 8 }} className="divide-y divide-app-border">
                            {topics.length === 0 && <li style={{ padding: 14, fontSize: 13, color: T.muted }}>No topic matches.</li>}
                            {topics.map(({ t, i }) => (
                                <TopicRow key={i} topic={t} open={openTopic === i} duration={duration} onToggle={() => setOpenTopic(o => o === i ? null : i)}
                                    isPicked={f => isPicked({ topic: i, field: f })} onPick={f => toggle({ topic: i, field: f })} full={picks.length >= MAX_LINES} query={q} />
                            ))}
                        </ul>
                    </Panel>
                    <Panel title="Plot" hint={zoom ? `${a.toFixed(1)} to ${b.toFixed(1)} s` : 'drag across the chart to zoom'} pad={12} gap={10}
                        right={zoom ? <Btn onClick={() => setZoom(null)}><ZoomOut size={14} /> Whole log</Btn> : undefined}>
                        <SubTabs label="Plot layout" value={layout} onChange={setLayout} tabs={[{ id: 'together', label: 'Together' }, { id: 'separate', label: 'Separate' }]} />
                        {lines.length > 0 && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                {lines.map((l, i) => (
                                    <span key={l.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 4px 2px 8px', borderRadius: 999, border: `1px solid ${T.border}`, fontSize: 12, fontWeight: 600, color: T.text, maxWidth: '100%' }}>
                                        <span aria-hidden style={{ width: 10, height: 3, borderRadius: 2, background: l.color, flexShrink: 0 }} />
                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.label}</span>
                                        <button type="button" aria-label={`Stop plotting ${l.label}`} onClick={() => toggle(picks[i])} className={FOCUS_RING + ' hover:bg-app-surface-2'}
                                            style={{ border: 'none', background: 'transparent', color: T.muted, cursor: 'pointer', borderRadius: 999, width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><X size={12} /></button>
                                    </span>
                                ))}
                            </div>
                        )}
                        {layout === 'together' || lines.length === 0 ? (
                            <LineChart label="Log fields over time" series={lines} t1={b} span={b - a} gapS={Math.max(2, (b - a) / 50)} hover onSelectRange={(x0, x1) => setZoom([Math.max(0, x0), x1])}
                                overlay={lines.length === 0 ? <span style={{ fontSize: 13, color: T.muted, textAlign: 'center', background: T.surface, padding: '8px 12px', borderRadius: 8 }}>Open a topic and tick a field to plot it. Up to {MAX_LINES}.</span> : undefined} />
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {lines.map(l => (
                                    <div key={l.id}>
                                        <div style={{ fontSize: 12, fontWeight: 700, color: T.muted, margin: '0 0 2px 52px' }}>{l.label}</div>
                                        <LineChart label={l.label} series={[l]} t1={b} span={b - a} gapS={Math.max(2, (b - a) / 50)} height={130} hover onSelectRange={(x0, x1) => setZoom([Math.max(0, x0), x1])} />
                                    </div>
                                ))}
                            </div>
                        )}
                        <p style={{ margin: 0, fontSize: 12, color: T.muted }}>Time is seconds since logging started. Long logs are thinned to the highest and lowest value per pixel, so spikes stay visible.</p>
                    </Panel>
                </Grid>
            )}

            {log && (
                <Panel title="Messages in the log" hint={`${log.messages.length}`}>
                    {log.messages.length === 0 ? <span style={{ fontSize: 13, color: T.muted }}>The autopilot logged no text messages.</span> : (
                        <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 320, overflowY: 'auto' }} className="divide-y divide-app-border">
                            {log.messages.map((m, i) => (
                                <li key={i} style={{ display: 'flex', gap: 10, padding: '6px 0', fontSize: 13, lineHeight: 1.45 }}>
                                    <span style={{ color: T.muted, fontVariantNumeric: 'tabular-nums', width: 64, flexShrink: 0, textAlign: 'right' }}>{Math.max(0, (m.t - log.firstUs) / 1e6).toFixed(1)} s</span>
                                    <span style={{ fontSize: 12, fontWeight: 700, color: levelColor(m.level), width: 64, flexShrink: 0 }}>{LEVEL[m.level] ?? m.level}</span>
                                    <span style={{ color: T.text, minWidth: 0, overflowWrap: 'anywhere' }}>{m.text.trim()}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </Panel>
            )}
        </div>
    )
}

function TopicRow({ topic, open, duration, onToggle, isPicked, onPick, full, query }: {
    topic: ULogTopic; open: boolean; duration: number; onToggle: () => void
    isPicked: (f: string) => boolean; onPick: (f: string) => void; full: boolean; query: string
}) {
    const hz = duration > 0 ? topic.starts.length / duration : 0
    const fields = query && !topic.name.includes(query) ? topic.fields.filter(f => f.name.toLowerCase().includes(query)) : topic.fields
    return (
        <li>
            <button type="button" onClick={onToggle} aria-expanded={open} className={FOCUS_RING + ' w-full text-left hover:bg-app-surface-2 transition-colors'}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', minHeight: 40, border: 'none', background: open ? mix('var(--app-accent)', 6) : 'transparent', cursor: 'pointer' }}>
                <ChevronRight size={14} aria-hidden style={{ color: T.muted, flexShrink: 0, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform var(--dur) var(--ease-out)' }} />
                <span className="font-code" style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{topicLabel(topic)}</span>
                <span style={{ fontSize: 12, color: T.muted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{hz >= 1 ? `${Math.round(hz)} Hz` : `${topic.starts.length} samples`}</span>
            </button>
            {open && (
                <ul style={{ listStyle: 'none', margin: 0, padding: '2px 10px 10px 32px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 170px), 1fr))', gap: '0 12px' }}>
                    {fields.length === 0 && <li style={{ fontSize: 13, color: T.muted }}>No numeric fields.</li>}
                    {fields.map(f => {
                        const on = isPicked(f.name)
                        return (
                            <li key={f.name}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 30, fontSize: 13, color: T.text, cursor: !on && full ? 'not-allowed' : 'pointer' }}>
                                    <input type="checkbox" checked={on} disabled={!on && full} onChange={() => onPick(f.name)}
                                        style={{ width: 16, height: 16, accentColor: 'var(--app-accent)', flexShrink: 0 }} />
                                    <span className="font-code" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                                </label>
                            </li>
                        )
                    })}
                </ul>
            )}
        </li>
    )
}
