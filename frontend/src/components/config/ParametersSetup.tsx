'use client'

// Config > Parameters: every PX4 parameter, in HYRAK's own browser. A
// sidebar of colour-coded groups with counts, and cards that lead with the
// human name and a plain description, the PX4 key underneath. Beginner mode
// hides the expert-only groups; Expert shows everything.
//
// Values come from the shared parameter copy (lib/vehicleParams.ts); writes
// go through the guarded `set_param` event and show what the aircraft
// confirmed. Metadata (defaults, units, ranges, enum values, bitmask bits)
// comes from the drone's own firmware when it sends it, else from a bundled
// PX4 copy (lib/paramMeta.ts). Names and descriptions prefer HYRAK's own
// wording (lib/px4-params-meta.ts) where it exists.
//
// Reset one parameter: only to a known default. Revert: back to the value it
// had when the parameters were loaded. Reset all: either the airframe's
// defaults (SYS_AUTOCONFIG = 1 and a reboot, calibration kept) or the
// firmware's (PREFLIGHT_STORAGE, everything wiped), typed confirmation,
// disarmed only.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Download, FileUp, Loader, Power, RotateCcw, Search, X, Zap } from 'lucide-react'
import { useDroneStore } from '@/store/drone'
import { useParamStore, useVehicleParams, writeParam, writeParams } from '@/lib/vehicleParams'
import { describeValue, fmtValue, sameValue, useParamMeta, validate, type PMeta } from '@/lib/paramMeta'
import { PX4_META, getGroupFromKey, humanizeParamKey } from '@/lib/px4-params-meta'
import { droneAction } from '@/lib/droneAction'
import { OptionSelect } from '@/components/config/OptionSelect'
import { Btn, Chip, Dialog, FOCUS_RING, Note, ParamSourceBar, ReloadButton, T, Tip, mix } from '@/components/config/kit'
import { ParamCard, type Row } from '@/components/config/params/ParamCard'
import { ALL_STYLE, EXPERT_GROUPS, groupStyle } from '@/components/config/params/groupStyle'

type Show = 'all' | 'default' | 'session'
const PAGE = 48
const ALL = 'All parameters'

function unitOf(m: PMeta | null) { return m?.u ? ` ${m.u}` : '' }

function oneLine(s: string) { return s.replace(/\s*\n\s*/g, ' ').trim() }

function makeRow(key: string, value: number | null, isFloat: boolean, m: PMeta | null, loadedValue: number | null): Row {
    const own = PX4_META[key]
    const group = m?.g || getGroupFromKey(key)
    const short = m?.s?.trim().replace(/\.$/, '') || ''
    const name = own?.name ?? (short || humanizeParamKey(key))
    const long = longText(m)
    const desc = own?.desc ?? (long ? oneLine(long) : null)
    const extra = own && short && short !== name ? short : ''
    return {
        key, value, isFloat, m, group, name, desc,
        expert: !!own?.expert || EXPERT_GROUPS.has(group),
        danger: !!own?.danger || key.startsWith('CBRK_'),
        offDefault: value != null && m?.d != null && !sameValue(value, m.d, isFloat),
        session: value != null && loadedValue != null && !sameValue(value, loadedValue, isFloat),
        loaded: loadedValue,
        hay: `${key} ${name} ${extra} ${desc ?? ''}`.toLowerCase(),
    }
}

export function ParametersSetup() {
    const vp = useVehicleParams()
    const loaded = useParamStore(s => s.loaded)
    const pm = useParamMeta()
    const armed = useDroneStore(s => s.telemetry?.flight_mode?.is_armed ?? false)
    const [query, setQuery] = useState('')
    const [group, setGroup] = useState<string>('Commander')
    const [show, setShow] = useState<Show>('all')
    const [expert, setExpert] = useState(false)
    const [editing, setEditing] = useState<string | null>(null)
    const [importing, setImporting] = useState(false)
    const [resetting, setResetting] = useState(false)
    const [reverting, setReverting] = useState(false)
    const live = vp.ready

    const rows = useMemo<Row[]>(() => {
        const meta = pm.meta
        const out: Row[] = []
        if (vp.params) {
            for (const [key, p] of Object.entries(vp.params)) {
                out.push(makeRow(key, p.value, p.type === 'float', meta?.[key] ?? null, loaded?.[key] ?? null))
            }
        } else if (meta && !vp.connected) {
            for (const [key, m] of Object.entries(meta)) out.push(makeRow(key, null, m.t === 'f', m, null))
        }
        return out.sort((a, b) => a.key.localeCompare(b.key))
    }, [vp.params, vp.connected, pm.meta, loaded])

    const counts = useMemo(() => {
        const c = { default: 0, session: 0, expert: 0 }
        for (const r of rows) { if (r.offDefault) c.default++; if (r.session) c.session++; if (r.expert) c.expert++ }
        return c
    }, [rows])

    // Beginner hides expert-only parameters from browsing; the two change
    // filters always show everything that changed.
    const base = useMemo(() => show === 'default' ? rows.filter(r => r.offDefault)
        : show === 'session' ? rows.filter(r => r.session)
        : expert ? rows : rows.filter(r => !r.expert), [rows, show, expert])

    const groups = useMemo(() => {
        const g = new Map<string, number>()
        for (const r of base) g.set(r.group, (g.get(r.group) ?? 0) + 1)
        return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    }, [base])

    const q = query.trim().toLowerCase()
    const activeGroup = group === ALL || groups.some(([g]) => g === group) ? group : (groups[0]?.[0] ?? ALL)
    const crossGroup = !!q || show !== 'all' || activeGroup === ALL

    const filtered = useMemo(() => {
        if (q) return base.filter(r => r.hay.includes(q))
        if (show !== 'all' || activeGroup === ALL) return base
        return base.filter(r => r.group === activeGroup)
    }, [base, q, show, activeGroup])

    // Matches or group members that Beginner is hiding, offered as a link.
    const hiddenExpert = useMemo(() => {
        if (expert || show !== 'all') return 0
        if (q) return rows.filter(r => r.expert && r.hay.includes(q)).length
        return activeGroup === ALL ? counts.expert : rows.filter(r => r.expert && r.group === activeGroup).length
    }, [expert, show, q, rows, activeGroup, counts.expert])

    // Cards render a page at a time; more load as the list end scrolls in.
    const viewKey = `${q}|${show}|${activeGroup}|${expert}`
    const [lim, setLim] = useState({ key: viewKey, n: PAGE })
    const limit = lim.key === viewKey ? lim.n : PAGE
    const more = useCallback(() => setLim(l => ({ key: viewKey, n: (l.key === viewKey ? l.n : PAGE) + PAGE })), [viewKey])
    const sentinel = useRef<HTMLDivElement>(null)
    const hasMore = filtered.length > limit
    useEffect(() => {
        const el = sentinel.current
        if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return
        const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) more() }, { rootMargin: '600px 0px' })
        io.observe(el)
        return () => io.disconnect()
    }, [hasMore, more])

    const rebootKeys = Object.keys(vp.saved).filter(k => pm.meta?.[k]?.r)
    const editRow = editing ? rows.find(r => r.key === editing) ?? null : null
    const defaultsLabel = pm.source === 'drone' ? 'this firmware' : pm.version || 'PX4'
    const openEditor = useCallback((k: string) => setEditing(k), [])
    const pickGroup = (g: string) => { setGroup(g); setQuery(''); setShow('all') }

    const exportFile = () => {
        if (!vp.params) return
        const lines = ['# Onboard parameters for Vehicle 1', `# Saved by HYRAK ${new Date().toISOString()}`, '#', '# Vehicle-Id\tComponent-Id\tName\tValue\tType']
        for (const [k, p] of Object.entries(vp.params).sort(([a], [b]) => a.localeCompare(b))) {
            lines.push(`1\t1\t${k}\t${p.type === 'int' ? Math.round(p.value) : Number(p.value.toPrecision(9))}\t${p.type === 'int' ? 6 : 9}`)
        }
        const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/plain' }))
        const a = document.createElement('a')
        a.href = url; a.download = `parameters_${new Date().toISOString().slice(0, 10)}.params`
        document.body.appendChild(a); a.click(); a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }

    const head = q
        ? `${filtered.length} ${filtered.length === 1 ? 'result' : 'results'} for "${query.trim()}" across all groups`
        : show === 'default' ? `${filtered.length} ${filtered.length === 1 ? 'parameter' : 'parameters'} not at the default, across all groups`
        : show === 'session' ? `${filtered.length} ${filtered.length === 1 ? 'parameter' : 'parameters'} changed since loading, across all groups`
        : `${activeGroup} - ${filtered.length} ${filtered.length === 1 ? 'parameter' : 'parameters'}`
    const headColor = q ? T.muted : show !== 'all' ? T.warn : activeGroup === ALL ? ALL_STYLE.color : groupStyle(activeGroup).color

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Toolbar */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ flex: '1 1 280px', position: 'relative', minWidth: 0 }}>
                    <span className="sr-only">Search parameters</span>
                    <Search size={15} aria-hidden style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: T.muted, pointerEvents: 'none' }} />
                    <input value={query} onChange={e => setQuery(e.target.value)} placeholder={`Search ${rows.length || ''} parameters`}
                        className={FOCUS_RING}
                        style={{ width: '100%', height: 40, padding: '0 36px 0 38px', borderRadius: 8, boxSizing: 'border-box', outline: 'none',
                            background: T.surface, border: `1px solid ${T.borderStrong}`, color: T.text, fontSize: 14 }} />
                    {query && (
                        <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className={FOCUS_RING}
                            style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', width: 28, height: 28, borderRadius: 6, border: 'none', background: 'transparent', color: T.muted, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <X size={14} />
                        </button>
                    )}
                </label>
                <button type="button" onClick={() => setExpert(e => !e)} aria-pressed={expert} className={FOCUS_RING + ' transition-colors'}
                    title={expert ? 'Showing every parameter. Switch back to hide the expert-only ones' : `Show the ${counts.expert} expert-only parameters too`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 40, padding: '0 13px', borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap', fontSize: 13,
                        border: `1px solid ${expert ? mix(T.warn, 60) : T.borderStrong}`, background: expert ? mix(T.warn, 10) : T.surface,
                        color: expert ? T.warn : T.muted, fontWeight: expert ? 700 : 600 }}>
                    <Zap size={14} />{expert ? 'Expert on' : 'Beginner'}
                </button>
                <Segmented value={show} onChange={setShow} label="Which parameters" options={[
                    { id: 'all', label: 'All' },
                    { id: 'default', label: `Not default${live ? ` (${counts.default})` : ''}`, disabled: !live || !pm.meta },
                    { id: 'session', label: `Changed now${live ? ` (${counts.session})` : ''}`, disabled: !live },
                ]} />
                {live && counts.session > 0 && (
                    <button type="button" onClick={() => setReverting(true)} className={FOCUS_RING + ' transition-colors'}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 40, padding: '0 13px', borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap',
                            border: `1px solid ${mix(T.warn, 30)}`, background: mix(T.warn, 7), color: T.warn, fontSize: 13, fontWeight: 700 }}>
                        <RotateCcw size={13} /> Revert all
                    </button>
                )}
                <ReloadButton />
            </div>

            {/* Where the values come from */}
            <ParamSourceBar what="parameters" />
            {live && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, flexWrap: 'wrap',
                    background: mix(T.ok, 6), border: `1px solid ${mix(T.ok, 22)}` }}>
                    <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: T.ok, flexShrink: 0 }} />
                    <span style={{ fontSize: 13, color: T.ok, fontWeight: 700 }}>{rows.length} parameters from the drone</span>
                    <span style={{ fontSize: 13, color: T.muted, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {pm.droneLoading ? <><Loader size={12} className="animate-spin" /> Reading descriptions from the drone</> : pm.source === 'drone' ? 'Defaults and descriptions from this firmware' : `Defaults from ${pm.version || 'a bundled PX4 copy'}`}
                    </span>
                </div>
            )}
            {vp.connected && pm.source !== 'drone' && !pm.droneLoading && (
                <Note tone="warn">
                    The drone did not send its parameter descriptions{pm.droneError ? ` (${pm.droneError})` : ''}. Defaults shown are from {pm.version || 'a bundled PX4 copy'} and may differ on this firmware.
                </Note>
            )}
            {rebootKeys.length > 0 && (
                <Note tone="warn">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <span style={{ flex: 1, minWidth: 200 }}>Reboot the flight controller to apply <span className="font-code">{rebootKeys.join(', ')}</span>.</span>
                        <RebootButton armed={armed} />
                    </div>
                </Note>
            )}
            {expert && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', borderRadius: 8, background: mix(T.danger, 6), border: `1px solid ${mix(T.danger, 22)}` }}>
                    <AlertTriangle size={15} style={{ color: T.danger, flexShrink: 0, marginTop: 2 }} />
                    <p style={{ fontSize: 13, color: T.text, margin: 0, lineHeight: 1.55 }}>
                        <span style={{ color: T.danger, fontWeight: 700 }}>Expert mode. </span>
                        Parameters marked with a warning sign can make the drone unsafe. Change gains in small steps and hover-test after every change.
                    </p>
                </div>
            )}

            {/* Phone: the group list becomes a picker */}
            {!q && show === 'all' ? (
                <div className="md:hidden">
                    <OptionSelect aria-label="Parameter group" value={activeGroup} onChange={pickGroup}
                        options={[{ value: ALL, label: `${ALL} (${base.length})` }, ...groups.map(([g, n]) => ({ value: g, label: `${g} (${n})` }))]} />
                </div>
            ) : null}

            <div style={{ display: 'flex', alignItems: 'flex-start' }}>
                {/* Group sidebar, hidden while searching or filtering, as before */}
                {!q && show === 'all' && (
                    <>
                        <nav aria-label="Parameter groups" className="hidden md:flex"
                            style={{ flex: '0 0 230px', flexDirection: 'column', gap: 2, position: 'sticky', top: 8, maxHeight: 'calc(100vh - 120px)', overflowY: 'auto', paddingRight: 2 }}>
                            <SidebarItem label={ALL} count={base.length} style={ALL_STYLE} active={activeGroup === ALL} onClick={() => pickGroup(ALL)} />
                            <div aria-hidden style={{ height: 1, background: T.border, margin: '4px 6px' }} />
                            {groups.map(([g, n]) => (
                                <SidebarItem key={g} label={g} count={n} style={groupStyle(g)} active={g === activeGroup} onClick={() => pickGroup(g)} />
                            ))}
                            {!expert && (
                                <button type="button" onClick={() => setExpert(true)} className={FOCUS_RING}
                                    style={{ marginTop: 6, padding: '6px 10px', border: 'none', background: 'none', textAlign: 'left', fontSize: 12, color: T.muted, cursor: 'pointer', lineHeight: 1.45 }}>
                                    {counts.expert} expert-only parameters hidden. <span style={{ color: T.warn, fontWeight: 700 }}>Show them</span>
                                </button>
                            )}
                        </nav>
                        <div aria-hidden className="hidden md:block" style={{ width: 1, alignSelf: 'stretch', background: T.border, margin: '0 16px', flexShrink: 0 }} />
                    </>
                )}

                {/* Cards */}
                <section aria-label="Parameters" style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 24, flexWrap: 'wrap' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                            <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: headColor, flexShrink: 0 }} />
                            <span style={{ fontSize: 13, fontWeight: 600, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>{head}</span>
                        </span>
                        <span style={{ flex: 1 }} />
                        {hiddenExpert > 0 && (
                            <button type="button" onClick={() => setExpert(true)} className={FOCUS_RING}
                                style={{ border: 'none', background: 'none', padding: '2px 0', fontSize: 13, fontWeight: 700, color: T.warn, cursor: 'pointer' }}>
                                +{hiddenExpert} expert {hiddenExpert === 1 ? 'parameter' : 'parameters'}
                            </button>
                        )}
                        {(q || show !== 'all') && <Btn onClick={() => { setQuery(''); setShow('all') }}>Back to groups</Btn>}
                    </div>

                    {filtered.length === 0 ? (
                        <div style={{ padding: '48px 16px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, borderRadius: 10, border: `1px dashed ${T.border}` }}>
                            <span style={{ fontSize: 14, color: T.muted }}>
                                {vp.loading ? 'Reading parameters from the drone' : q ? `No parameter matches "${query.trim()}"` : show === 'default' ? 'Every parameter is at its default' : show === 'session' ? 'Nothing changed since the parameters were loaded' : vp.connected ? 'No parameters loaded yet' : 'Parameter descriptions are loading'}
                            </span>
                            {(q || show !== 'all') && <Btn onClick={() => { setQuery(''); setShow('all') }}>Show all parameters</Btn>}
                        </div>
                    ) : (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 270px), 1fr))', gap: 10, alignItems: 'stretch' }}>
                            {filtered.slice(0, limit).map(r => (
                                <ParamCard key={r.key} row={r} live={live} pending={!!vp.pending[r.key]} failed={vp.failed[r.key]} savedAt={vp.saved[r.key] ?? 0}
                                    showGroup={crossGroup} canResetDefault={pm.source === 'drone'} defaultsLabel={pm.version || 'PX4'} onOpen={openEditor} />
                            ))}
                        </div>
                    )}
                    {hasMore && (
                        <div ref={sentinel} style={{ padding: 8, display: 'flex', justifyContent: 'center' }}>
                            <Btn onClick={more}>Show {Math.min(PAGE, filtered.length - limit)} more of {filtered.length - limit}</Btn>
                        </div>
                    )}
                </section>
            </div>

            {/* File and reset tools */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 200px), 1fr))', gap: 8, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
                <Tile icon={<Download size={16} />} color="light-dark(#1d4ed8, #60a5fa)" title="Export .params" sub="Save every value to a file"
                    onClick={exportFile} disabled={!live} why="Connect a drone first" />
                <Tile icon={<FileUp size={16} />} color="light-dark(#7e22ce, #c084fc)" title="Import .params" sub="Compare a file, then write"
                    onClick={() => setImporting(true)} disabled={!live} why="Connect a drone first" />
                <RebootButton armed={armed} tile />
                <Tile icon={<RotateCcw size={16} />} color={T.danger} title="Reset all to defaults" sub="Airframe or firmware defaults" danger
                    onClick={() => setResetting(true)} disabled={!live || armed} why={armed ? 'Disarm first' : 'Connect a drone first'} />
            </div>

            {editRow && <ParamEditor row={editRow} live={live} source={pm.source} defaultsLabel={defaultsLabel} onClose={() => setEditing(null)} />}
            {importing && <ImportDialog onClose={() => setImporting(false)} />}
            {resetting && <ResetAllDialog armed={armed} onClose={() => setResetting(false)} />}
            {reverting && <RevertAllDialog rows={rows.filter(r => r.session)} onClose={() => setReverting(false)} />}
        </div>
    )
}

// ── pieces ──────────────────────────────────────────────────────────────────

function Segmented<V extends string>({ value, onChange, options, label }: {
    value: V; onChange: (v: V) => void; label: string; options: { id: V; label: string; disabled?: boolean }[]
}) {
    return (
        <div role="radiogroup" aria-label={label} style={{ display: 'inline-flex', padding: 3, borderRadius: 9, background: T.surface2, border: `1px solid ${T.border}`, gap: 2, maxWidth: '100%', overflowX: 'auto' }}>
            {options.map(o => {
                const on = o.id === value
                return (
                    <button key={o.id} type="button" role="radio" aria-checked={on} disabled={o.disabled} onClick={() => onChange(o.id)}
                        className={FOCUS_RING + ' transition-colors'}
                        style={{ minHeight: 32, padding: '0 12px', borderRadius: 7, border: 'none', fontSize: 13, fontWeight: on ? 700 : 600, whiteSpace: 'nowrap',
                            cursor: o.disabled ? 'not-allowed' : 'pointer', fontVariantNumeric: 'tabular-nums',
                            background: on ? T.surface : 'transparent', color: o.disabled ? T.subtle : on ? T.text : T.muted,
                            boxShadow: on ? `0 1px 2px ${mix('hsl(var(--app-text))', 12)}` : 'none' }}>
                        {o.label}
                    </button>
                )
            })}
        </div>
    )
}

function SidebarItem({ label, count, style, active, onClick }: {
    label: string; count: number; style: { color: string; icon: React.ElementType }; active: boolean; onClick: () => void
}) {
    const Icon = style.icon
    return (
        <button type="button" onClick={onClick} aria-current={active ? 'true' : undefined} title={label}
            className={FOCUS_RING + ' transition-colors ' + (active ? '' : 'hover:bg-app-surface-2')}
            style={{ display: 'flex', alignItems: 'center', gap: 9, minHeight: 34, padding: '6px 10px', borderRadius: 6, border: 'none', borderLeft: `3px solid ${active ? style.color : 'transparent'}`,
                background: active ? mix(style.color, 10) : 'transparent', cursor: 'pointer', width: '100%', textAlign: 'left', flexShrink: 0 }}>
            <Icon size={15} aria-hidden style={{ color: active ? style.color : T.muted, flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: active ? T.text : T.muted, fontWeight: active ? 700 : 500, lineHeight: 1.3 }}>{label}</span>
            <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: active ? style.color : T.subtle, fontWeight: active ? 700 : 500 }}>{count}</span>
        </button>
    )
}

function Tile({ icon, color, title, sub, onClick, disabled, why, danger }: {
    icon: React.ReactNode; color: string; title: string; sub: string; onClick: () => void; disabled?: boolean; why?: string; danger?: boolean
}) {
    return (
        <button type="button" onClick={disabled ? undefined : onClick} disabled={disabled} title={disabled ? why : undefined}
            className={FOCUS_RING + ' transition-colors ' + (disabled ? '' : 'hover:bg-app-surface-2')}
            style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 14px', borderRadius: 8, textAlign: 'left', width: '100%',
                background: T.surface, border: `1px solid ${disabled ? T.border : danger ? mix(color, 40) : T.borderStrong}`, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.7 : 1 }}>
            <span style={{ color: disabled ? T.muted : color, display: 'flex', flexShrink: 0 }}>{icon}</span>
            <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: disabled ? T.muted : T.text }}>{title}</span>
                <span style={{ display: 'block', fontSize: 12, color: T.muted, marginTop: 1 }}>{sub}</span>
            </span>
        </button>
    )
}

function RebootButton({ armed, tile }: { armed: boolean; tile?: boolean }) {
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [err, setErr] = useState<string | null>(null)
    const go = async () => {
        setBusy(true); setErr(null)
        const r = await droneAction('reboot', {}, 8000)
        setBusy(false)
        if (r.ok) setOpen(false); else setErr(r.error ?? 'The drone refused the reboot')
    }
    return (
        <>
            {tile
                ? <Tile icon={<Power size={16} />} color={T.danger} title="Reboot" sub="Restart the flight controller" danger
                    onClick={() => setOpen(true)} disabled={!connected || armed} why={armed ? 'Disarm first' : 'Connect a drone first'} />
                : <Btn kind="primary" onClick={() => setOpen(true)} disabled={!connected || armed} title={armed ? 'Disarm first' : undefined}><Power size={15} /> Reboot</Btn>}
            <Dialog open={open} onClose={() => setOpen(false)} title="Reboot the flight controller?" width={440}>
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: T.text }}>The link drops for about 10 to 30 seconds while PX4 restarts, then the parameters are read again.</p>
                {err && <Note tone="danger">{err}</Note>}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <Btn onClick={() => setOpen(false)}>Cancel</Btn>
                    <Btn kind="primary" onClick={go} disabled={busy || armed}>{busy ? <Loader size={14} className="animate-spin" /> : <Power size={14} />} Reboot now</Btn>
                </div>
            </Dialog>
        </>
    )
}

/** Write every parameter changed this session back to its loaded value. */
function RevertAllDialog({ rows, onClose }: { rows: Row[]; onClose: () => void }) {
    const [busy, setBusy] = useState(false)
    const go = async () => {
        setBusy(true)
        await writeParams(rows.filter(r => r.loaded != null).map(r => [r.key, r.loaded!] as [string, number]))
        setBusy(false)
        onClose()
    }
    return (
        <Dialog open onClose={onClose} title={`Revert ${rows.length} ${rows.length === 1 ? 'parameter' : 'parameters'}?`} width={480}>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: T.text }}>Each goes back to the value it had when the parameters were loaded from the drone.</p>
            <div style={{ borderRadius: 8, border: `1px solid ${T.border}`, maxHeight: 220, overflowY: 'auto' }}>
                {rows.map(r => (
                    <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderTop: `1px solid ${T.border}`, fontSize: 13 }}>
                        <span className="font-code" style={{ flex: 1, minWidth: 0, color: T.text, fontWeight: 600 }}>{r.key}</span>
                        <span style={{ color: T.muted, fontVariantNumeric: 'tabular-nums' }}>{r.value == null ? '-' : fmtValue(r.value, r.m, r.isFloat)}</span>
                        <span style={{ color: T.muted }}>to</span>
                        <span style={{ color: T.text, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{r.loaded == null ? '-' : fmtValue(r.loaded, r.m, r.isFloat)}{unitOf(r.m)}</span>
                    </div>
                ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <Btn onClick={onClose}>Cancel</Btn>
                <Btn kind="primary" onClick={go} disabled={busy}>{busy ? <Loader size={14} className="animate-spin" /> : <RotateCcw size={14} />} Revert all</Btn>
            </div>
        </Dialog>
    )
}

// ── one parameter ───────────────────────────────────────────────────────────

/** The long description, without the bit list a bitmask's text repeats
 *  (the checkboxes show it), and marked when the metadata cut it short. */
function longText(m: PMeta | null): string | null {
    let l = m?.l?.trim()
    if (!l) return null
    if (m?.b) {
        const i = l.search(/set bits true to enable|\b0\s*:\s/i)
        if (i > 0) return l.slice(0, i).trim() || null
        if (i === 0) return null
    }
    if (l.length >= 400) l = l.replace(/\s+\S*$/, '') + ' ...'
    return l
}

function hasBit(v: number, bit: number) { return Math.floor(Math.round(v) / 2 ** bit) % 2 === 1 }

function ParamEditor({ row, live, source, defaultsLabel, onClose }: {
    row: Row; live: boolean; source: 'drone' | 'bundled' | null; defaultsLabel: string; onClose: () => void
}) {
    const { m, key } = row
    const pending = useParamStore(s => !!s.pending[key])
    const failed = useParamStore(s => s.failed[key])
    const current = row.value ?? m?.d ?? 0
    const [draft, setDraft] = useState<string>(() => fmtValue(current, m, row.isFloat))
    const [bits, setBits] = useState<number>(() => Math.round(current))
    const [err, setErr] = useState<string | null>(null)
    const [sent, setSent] = useState(false)
    const enumOpts = m?.v
    const bitmask = !enumOpts && m?.b ? m.b : null
    const [choice, setChoice] = useState<number>(Math.round(current))
    const def = m?.d
    const atDefault = def != null && sameValue(current, def, row.isFloat)

    // Close once the aircraft confirms the write.
    const savedAt = useParamStore(s => s.saved[key] ?? 0)
    const [savedAtOpen] = useState(savedAt)
    useEffect(() => {
        if (sent && !pending && !failed && savedAt !== savedAtOpen) onClose()
    }, [sent, pending, failed, savedAt, savedAtOpen, onClose])

    const value = (): number | null => {
        if (enumOpts) return choice
        if (bitmask) return bits
        const t = draft.trim()
        const v = t === '' ? NaN : Number(t)
        const why = validate(v, m, row.isFloat)
        setErr(why)
        return why ? null : v
    }
    const save = (v: number | null = value()) => {
        if (v == null || !live) return
        if (sameValue(v, current, row.isFloat)) { onClose(); return }
        setSent(true)
        writeParam(key, v)
    }

    const unknownBits = bitmask ? Math.round(bits) - bitmask.reduce((acc, [b]) => acc + (hasBit(bits, b) ? 2 ** b : 0), 0) : 0

    return (
        <Dialog open onClose={onClose} title={row.name} width={560}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="font-code" style={{ fontSize: 13, fontWeight: 600, color: T.muted }}>{key}</span>
                {m?.s && m.s.replace(/\.$/, '') !== row.name && <span style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{m.s}</span>}
                {!m?.s && !row.desc && <span style={{ fontSize: 14, color: T.muted }}>No description for this parameter</span>}
                {PX4_META[key]?.desc && <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: T.text }}>{PX4_META[key].desc}</p>}
                {longText(m) && <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: T.muted, whiteSpace: 'pre-line' }}>{longText(m)}</p>}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                    <Chip tone="off">{row.group}</Chip>
                    <Chip tone="off">{row.isFloat ? 'Decimal' : 'Whole number'}</Chip>
                    {m?.r && <Chip tone="warn">Needs a reboot</Chip>}
                </div>
            </div>

            {enumOpts ? (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Value</span>
                    <OptionSelect aria-label={`${key} value`} value={choice} disabled={!live} onChange={v => setChoice(v)}
                        options={(enumOpts.some(([v]) => v === choice) ? enumOpts : [...enumOpts, [choice, `Value ${choice}`] as [number, string]])
                            .map(([v, l]) => ({ value: v, label: `${l} (${v})` }))} />
                </label>
            ) : bitmask ? (
                <fieldset style={{ margin: 0, padding: 0, border: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <legend style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 6 }}>
                        Bits <span style={{ fontWeight: 600, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>value {bits}</span>
                    </legend>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 230px), 1fr))', gap: 2, maxHeight: 300, overflowY: 'auto' }}>
                        {bitmask.map(([b, l]) => {
                            const on = hasBit(bits, b)
                            return (
                                <label key={b} className="hover:bg-app-surface-2 transition-colors" style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32, padding: '0 8px', borderRadius: 6, cursor: live ? 'pointer' : 'not-allowed', fontSize: 13, color: T.text }}>
                                    <input type="checkbox" checked={on} disabled={!live} onChange={() => setBits(x => on ? x - 2 ** b : x + 2 ** b)}
                                        style={{ width: 16, height: 16, accentColor: 'var(--app-accent)', flexShrink: 0 }} />
                                    <span style={{ flex: 1, minWidth: 0 }}>{l}</span>
                                    <span style={{ fontSize: 12, color: T.subtle, fontVariantNumeric: 'tabular-nums' }}>bit {b}</span>
                                </label>
                            )
                        })}
                    </div>
                    {unknownBits > 0 && <span style={{ fontSize: 12, color: T.warn }}>Also set: bits this firmware does not describe (value {unknownBits}). They are kept.</span>}
                </fieldset>
            ) : (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Value</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input value={draft} disabled={!live} inputMode="decimal" aria-invalid={!!err}
                            onChange={e => { setDraft(e.target.value); setErr(null) }}
                            onBlur={() => { const t = draft.trim(); setErr(validate(t === '' ? NaN : Number(t), m, row.isFloat)) }}
                            onKeyDown={e => { if (e.key === 'Enter') save() }}
                            className={FOCUS_RING}
                            style={{ flex: '0 1 200px', minWidth: 0, height: 38, padding: '0 10px', borderRadius: 8, outline: 'none', boxSizing: 'border-box', textAlign: 'right',
                                background: live ? T.surface : T.surface2, border: `1px solid ${err ? T.danger : T.borderStrong}`, color: T.text, fontSize: 15, fontVariantNumeric: 'tabular-nums' }} />
                        {m?.u && <span style={{ fontSize: 14, color: T.muted }}>{m.u}</span>}
                    </span>
                    {err && <span role="alert" style={{ fontSize: 12, color: T.danger }}>{err}</span>}
                    {(m?.min != null || m?.max != null) && (
                        <span style={{ fontSize: 12, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>
                            Range {m?.min ?? 'any'} to {m?.max ?? 'any'}{unitOf(m)}{m?.inc != null ? `, steps of ${m.inc}` : ''}
                        </span>
                    )}
                </label>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 13, padding: '10px 12px', borderRadius: 8, background: T.surface2, border: `1px solid ${T.border}` }}>
                <span style={{ color: T.muted }}>On the drone</span>
                <span style={{ color: T.text, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{row.value == null ? 'No drone connected' : `${fmtValue(row.value, m, row.isFloat)}${unitOf(m)}`}</span>
                <span style={{ color: T.muted, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Default <Tip text={`From ${source === 'drone' ? "the drone's own firmware" : defaultsLabel}. Airframe files can set their own starting values, so an airframe-tuned value also shows as not default.`} />
                </span>
                <span style={{ color: T.text, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                    {def == null ? 'Not known' : `${fmtValue(def, m, row.isFloat)}${unitOf(m)}`}{def != null && describeValue(def, m) ? ` (${describeValue(def, m)})` : ''}
                    {def != null && source === 'bundled' && <span style={{ color: T.muted, fontWeight: 500 }}> in {defaultsLabel}</span>}
                </span>
            </div>

            {failed && <Note tone="danger">{failed}</Note>}
            {!live && <Note>Connect a drone to change this parameter.</Note>}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {def != null && live && !atDefault && (
                    <Btn onClick={() => save(def)} disabled={pending}
                        title={source === 'bundled' ? `The default in ${defaultsLabel}; it may differ on this firmware` : 'Write the firmware default'}>
                        <RotateCcw size={14} /> {source === 'drone' ? 'Reset to default' : `Use ${defaultsLabel} default`}
                    </Btn>
                )}
                <span style={{ flex: 1 }} />
                <Btn onClick={onClose}>Cancel</Btn>
                <Btn kind="primary" onClick={() => save()} disabled={!live || pending}>{pending ? <><Loader size={14} className="animate-spin" /> Saving</> : 'Save'}</Btn>
            </div>
        </Dialog>
    )
}

// ── import ──────────────────────────────────────────────────────────────────

interface Diff { key: string; file: number; drone: number | null; kind: 'changed' | 'same' | 'unknown'; problem: string | null }

function parseParams(text: string): { key: string; value: number }[] {
    const out: { key: string; value: number }[] = []
    for (const line of text.split(/\r?\n/)) {
        const t = line.trim()
        if (!t || t.startsWith('#')) continue
        const parts = t.split(/[\s,]+/)
        // QGroundControl: sysid compid name value type. Mission Planner: name,value.
        const [key, raw] = parts.length >= 4 ? [parts[2], parts[3]] : [parts[0], parts[1]]
        const v = Number(raw)
        if (key && /^[A-Za-z0-9_]{1,16}$/.test(key) && Number.isFinite(v)) out.push({ key, value: v })
    }
    return out
}

function ImportDialog({ onClose }: { onClose: () => void }) {
    const vp = useVehicleParams()
    const pm = useParamMeta()
    const [name, setName] = useState<string | null>(null)
    const [diff, setDiff] = useState<Diff[] | null>(null)
    const [pick, setPick] = useState<Record<string, boolean>>({})
    const [writing, setWriting] = useState<string[] | null>(null)
    const [readErr, setReadErr] = useState<string | null>(null)
    const fileRef = useRef<HTMLInputElement>(null)

    const read = (f: File) => {
        if (f.size > 2_000_000) { setReadErr('That file is over 2 MB; a .params file is usually under 100 KB'); return }
        const r = new FileReader()
        r.onload = () => {
            const entries = parseParams(String(r.result ?? ''))
            if (!entries.length) { setReadErr('No parameters found in that file. Expected QGroundControl .params lines: vehicle, component, name, value, type'); setDiff(null); return }
            const d: Diff[] = entries.map(({ key, value }) => {
                const p = vp.params?.[key]
                if (!p) return { key, file: value, drone: null, kind: 'unknown', problem: null }
                const m = pm.meta?.[key]
                const isFloat = p.type === 'float'
                return { key, file: value, drone: p.value, kind: sameValue(value, p.value, isFloat) ? 'same' : 'changed', problem: validate(value, m, isFloat) }
            })
            setReadErr(null); setName(f.name); setDiff(d)
            setPick(Object.fromEntries(d.filter(x => x.kind === 'changed').map(x => [x.key, !x.problem])))
        }
        r.readAsText(f)
    }

    const changed = diff?.filter(d => d.kind === 'changed') ?? []
    const unknown = diff?.filter(d => d.kind === 'unknown') ?? []
    const same = diff?.filter(d => d.kind === 'same').length ?? 0
    const chosen = changed.filter(d => pick[d.key])
    const pendingNow = writing ? writing.filter(k => vp.pending[k]).length : 0
    const failedNow = writing ? writing.filter(k => vp.failed[k]) : []
    const done = writing != null && pendingNow === 0

    const write = async () => {
        const keys = chosen.map(d => d.key)
        setWriting(keys)
        await writeParams(chosen.map(d => [d.key, d.file] as [string, number]))
    }

    return (
        <Dialog open onClose={onClose} title="Import parameters" width={680}>
            <input ref={fileRef} type="file" accept=".params,.param,.txt" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) read(f); e.target.value = '' }} />
            {!diff && (
                <>
                    <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: T.text }}>Pick a .params file. HYRAK compares it with the drone first and writes only the values you tick.</p>
                    {readErr && <Note tone="warn">{readErr}</Note>}
                    <div><Btn kind="primary" onClick={() => fileRef.current?.click()}><FileUp size={15} /> Choose file</Btn></div>
                </>
            )}
            {diff && (
                <>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <span className="font-code" style={{ fontSize: 13, color: T.muted, marginRight: 4 }}>{name}</span>
                        <Chip tone={changed.length ? 'warn' : 'ok'}>{changed.length} different</Chip>
                        <Chip tone="off">{same} same</Chip>
                        {unknown.length > 0 && <Chip tone="off">{unknown.length} not on this drone</Chip>}
                    </div>
                    {changed.length === 0 ? (
                        <Note tone="ok">Every parameter in the file already matches the drone. Nothing to write.</Note>
                    ) : (
                        <div style={{ borderRadius: 8, border: `1px solid ${T.border}`, maxHeight: 340, overflowY: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                                <thead>
                                    <tr style={{ position: 'sticky', top: 0, background: 'hsl(var(--app-raised))', textAlign: 'left', color: T.muted }}>
                                        <th style={{ padding: '8px 10px', width: 32 }}>
                                            <input type="checkbox" aria-label="Select all" checked={chosen.length === changed.length}
                                                onChange={e => setPick(Object.fromEntries(changed.map(d => [d.key, e.target.checked])))}
                                                style={{ width: 16, height: 16, accentColor: 'var(--app-accent)' }} />
                                        </th>
                                        <th style={{ padding: '8px 6px', fontWeight: 700 }}>Parameter</th>
                                        <th style={{ padding: '8px 6px', fontWeight: 700, textAlign: 'right' }}>On the drone</th>
                                        <th style={{ padding: '8px 10px', fontWeight: 700, textAlign: 'right' }}>In the file</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {changed.map(d => {
                                        const m = pm.meta?.[d.key]
                                        const isFloat = vp.params?.[d.key]?.type === 'float'
                                        const st = writing?.includes(d.key) ? (vp.pending[d.key] ? 'saving' : vp.failed[d.key] ? 'refused' : 'written') : null
                                        return (
                                            <tr key={d.key} style={{ borderTop: `1px solid ${T.border}` }}>
                                                <td style={{ padding: '6px 10px' }}>
                                                    <input type="checkbox" aria-label={`Write ${d.key}`} checked={!!pick[d.key]} disabled={!!writing}
                                                        onChange={e => setPick(p => ({ ...p, [d.key]: e.target.checked }))}
                                                        style={{ width: 16, height: 16, accentColor: 'var(--app-accent)' }} />
                                                </td>
                                                <td style={{ padding: '6px' }}>
                                                    <span className="font-code" style={{ fontWeight: 700, color: T.text }}>{d.key}</span>
                                                    {d.problem && <span style={{ display: 'block', fontSize: 12, color: T.warn }}>Out of range: {d.problem.toLowerCase()}</span>}
                                                    {st && <span style={{ display: 'block', fontSize: 12, color: st === 'refused' ? T.danger : st === 'written' ? T.ok : T.accent }}>{st === 'saving' ? 'Saving' : st === 'refused' ? 'Refused by the drone' : 'Written'}</span>}
                                                </td>
                                                <td style={{ padding: '6px', textAlign: 'right', color: T.muted, fontVariantNumeric: 'tabular-nums' }}>{d.drone == null ? '-' : fmtValue(d.drone, m, isFloat)}</td>
                                                <td style={{ padding: '6px 10px', textAlign: 'right', color: T.text, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtValue(d.file, m, isFloat)}{unitOf(m ?? null)}</td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                    {unknown.length > 0 && (
                        <p style={{ margin: 0, fontSize: 12, color: T.muted, lineHeight: 1.5 }}>
                            Skipped, not on this drone: <span className="font-code">{unknown.slice(0, 12).map(d => d.key).join(', ')}{unknown.length > 12 ? ` and ${unknown.length - 12} more` : ''}</span>
                        </p>
                    )}
                    {done && (
                        <Note tone={failedNow.length ? 'warn' : 'ok'}>
                            {writing!.length - failedNow.length} written{failedNow.length ? `, ${failedNow.length} refused (${failedNow.slice(0, 5).join(', ')})` : ''}. Some parameters only take effect after a reboot.
                        </Note>
                    )}
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        {!writing && <Btn onClick={() => { setDiff(null); setName(null) }}>Choose another file</Btn>}
                        <Btn onClick={onClose}>{done ? 'Close' : 'Cancel'}</Btn>
                        {!done && changed.length > 0 && (
                            <Btn kind="primary" onClick={write} disabled={!chosen.length || !!writing || !vp.ready}>
                                {writing ? <><Loader size={14} className="animate-spin" /> Writing {writing.length - pendingNow} of {writing.length}</> : `Write ${chosen.length} ${chosen.length === 1 ? 'parameter' : 'parameters'}`}
                            </Btn>
                        )}
                    </div>
                </>
            )}
        </Dialog>
    )
}

// ── reset all ───────────────────────────────────────────────────────────────

function ResetAllDialog({ armed, onClose }: { armed: boolean; onClose: () => void }) {
    const [mode, setMode] = useState<'airframe' | 'firmware'>('airframe')
    const [typed, setTyped] = useState('')
    const [busy, setBusy] = useState(false)
    const [err, setErr] = useState<string | null>(null)
    const [doneMode, setDoneMode] = useState<'airframe' | 'firmware' | null>(null)
    const [rebooting, setRebooting] = useState(false)

    const go = async () => {
        setBusy(true); setErr(null)
        if (mode === 'airframe') {
            writeParam('SYS_AUTOCONFIG', 1)
            const ok = await new Promise<boolean>(resolve => {
                const t0 = Date.now()
                const iv = setInterval(() => {
                    const s = useParamStore.getState()
                    if (!s.pending.SYS_AUTOCONFIG) { clearInterval(iv); resolve(!s.failed.SYS_AUTOCONFIG) }
                    else if (Date.now() - t0 > 10_000) { clearInterval(iv); resolve(false) }
                }, 150)
            })
            setBusy(false)
            if (ok) setDoneMode('airframe'); else setErr(useParamStore.getState().failed.SYS_AUTOCONFIG ?? 'The drone did not confirm SYS_AUTOCONFIG')
        } else {
            const r = await droneAction('reset_params_default', { confirm: 'RESET' }, 8000)
            setBusy(false)
            if (r.ok) setDoneMode('firmware'); else setErr(r.error ?? 'The drone refused')
        }
    }
    const reboot = async () => {
        setRebooting(true); setErr(null)
        const r = await droneAction('reboot', {}, 8000)
        setRebooting(false)
        if (r.ok) onClose(); else setErr(r.error ?? 'The reboot was refused. Power cycle the drone to apply.')
    }

    const opt = (id: 'airframe' | 'firmware', title: string, body: string) => (
        <label style={{ display: 'flex', gap: 10, padding: 12, borderRadius: 8, cursor: 'pointer', alignItems: 'flex-start',
            border: `1px solid ${mode === id ? mix(T.accent, 55) : T.border}`, background: mode === id ? mix(T.accent, 7) : 'transparent' }}>
            <input type="radio" name="reset-mode" checked={mode === id} onChange={() => setMode(id)} disabled={!!doneMode}
                style={{ width: 16, height: 16, marginTop: 2, accentColor: 'var(--app-accent)', flexShrink: 0 }} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{title}</span>
                <span style={{ fontSize: 13, color: T.muted, lineHeight: 1.5 }}>{body}</span>
            </span>
        </label>
    )

    return (
        <Dialog open onClose={onClose} title="Reset all parameters" width={540}>
            {doneMode ? (
                <>
                    <Note tone="ok">
                        {doneMode === 'airframe'
                            ? 'Done. PX4 loads the airframe defaults on its next start. Reboot now to apply.'
                            : 'Done. Every parameter is back at the firmware default. Reboot now, then set the airframe and calibrate the sensors again.'}
                    </Note>
                    {err && <Note tone="danger">{err}</Note>}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                        <Btn onClick={onClose}>Later</Btn>
                        <Btn kind="primary" onClick={reboot} disabled={rebooting || armed}>{rebooting ? <Loader size={14} className="animate-spin" /> : <Power size={14} />} Reboot now</Btn>
                    </div>
                </>
            ) : (
                <>
                    {opt('airframe', 'Airframe defaults', 'Every parameter goes back to what the airframe sets. Keeps the airframe, sensor and radio calibration and flight modes. Applies on the next reboot.')}
                    {opt('firmware', 'Firmware defaults', 'Wipes everything, calibration and airframe included, as on a new flight controller. The drone will not fly until it is set up again.')}
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span style={{ fontSize: 13, color: T.text }}>Type <b className="font-code">RESET</b> to confirm</span>
                        <input value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" spellCheck={false} className={FOCUS_RING + ' font-code'}
                            style={{ height: 38, padding: '0 10px', borderRadius: 8, outline: 'none', boxSizing: 'border-box', background: T.surface, border: `1px solid ${T.borderStrong}`, color: T.text, fontSize: 14 }} />
                    </label>
                    {armed && <Note tone="warn">Disarm first. Parameters are reset on the ground only.</Note>}
                    {err && <Note tone="danger">{err}</Note>}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                        <Btn onClick={onClose}>Cancel</Btn>
                        <Btn kind="danger" big={false} onClick={go} disabled={typed !== 'RESET' || busy || armed}>
                            {busy ? <Loader size={14} className="animate-spin" /> : <RotateCcw size={14} />} {mode === 'airframe' ? 'Reset to airframe defaults' : 'Reset to firmware defaults'}
                        </Btn>
                    </div>
                </>
            )}
        </Dialog>
    )
}
