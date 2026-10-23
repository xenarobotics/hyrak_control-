'use client'

// One parameter as a card, in the earlier HYRAK parameter browser's style:
// the human name first, the PX4 key under it in small monospace, the plain
// description, then the control that fits the parameter (switch, two-way
// pill, dropdown, slider, number field) and a footer with the default, the
// value it had when loaded, and revert / reset. Every write goes through
// writeParam and shows what the aircraft confirmed.
//
// Inline writes are single, deliberate actions: a switch flip, a pill, a
// dropdown pick, a slider release, Enter or leaving a number field. Never
// one write per keystroke or per slider step. Parameters marked dangerous
// (circuit breakers and the like) and bitmasks open the full editor instead.

import React, { useEffect, useState } from 'react'
import { AlertTriangle, Check, Info, Loader, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { writeParam } from '@/lib/vehicleParams'
import { describeValue, fmtValue, sameValue, validate, type PMeta } from '@/lib/paramMeta'
import { OptionSelect } from '@/components/config/OptionSelect'
import { FOCUS_RING, T, Toggle, mix } from '@/components/config/kit'
import { groupStyle } from './groupStyle'

export interface Row {
    key: string
    value: number | null      // null: no drone, reference only
    isFloat: boolean
    m: PMeta | null
    group: string
    /** Human name: HYRAK's own wording, else PX4's short description. */
    name: string
    /** Plain description, or null. */
    desc: string | null
    expert: boolean
    danger: boolean
    offDefault: boolean
    session: boolean
    /** The value when the parameters were downloaded. */
    loaded: number | null
    /** Lower-case key, name and description, for search. */
    hay: string
}

type Kind = 'bool' | 'pill' | 'select' | 'bits' | 'slider' | 'number' | 'guarded'

function kindOf(r: Row): Kind {
    const m = r.m
    if (r.danger) return 'guarded'
    if (m?.v?.length) {
        if (m.v.length === 2 && m.v[0][0] === 0 && m.v[1][0] === 1 && /disable/i.test(m.v[0][1]) && /enable/i.test(m.v[1][1])) return 'bool'
        return m.v.length === 2 ? 'pill' : 'select'
    }
    if (m?.b?.length) return 'bits'
    if (m?.min != null && m?.max != null && m.max > m.min) {
        const step = m.inc ?? (r.isFloat ? (m.max - m.min) / 200 : 1)
        if ((m.max - m.min) / step <= 2000) return 'slider'
    }
    return 'number'
}

function unit(m: PMeta | null) { return m?.u ? ` ${m.u}` : '' }

function useJustSaved(savedAt: number) {
    const [now, setNow] = useState(0)
    useEffect(() => {
        if (!savedAt) return
        const t0 = setTimeout(() => setNow(Date.now()), 0)
        const t = setTimeout(() => setNow(Date.now()), 2200)
        return () => { clearTimeout(t0); clearTimeout(t) }
    }, [savedAt])
    return savedAt > 0 && now - savedAt < 2000
}

export const ParamCard = React.memo(function ParamCard({ row, live, pending, failed, savedAt, showGroup, canResetDefault, defaultsLabel, onOpen }: {
    row: Row; live: boolean; pending: boolean; failed?: string; savedAt: number; showGroup: boolean
    canResetDefault: boolean; defaultsLabel: string; onOpen: (key: string) => void
}) {
    const { m, key } = row
    const gs = groupStyle(row.group)
    const value = row.value ?? m?.d ?? null
    const justSaved = useJustSaved(savedAt)
    const kind = kindOf(row)
    const borderL = failed || row.danger ? T.danger : row.session ? T.warn : mix(gs.color, 45)
    const def = m?.d

    const commit = (v: number) => {
        if (!live || row.value == null || sameValue(v, row.value, row.isFloat)) return
        writeParam(key, v)
    }

    return (
        <article aria-label={row.name}
            style={{ borderRadius: 10, background: T.surface, border: `1px solid ${failed ? mix(T.danger, 40) : T.border}`, borderLeft: `3px solid ${borderL}`,
                display: 'flex', flexDirection: 'column', minWidth: 0, contentVisibility: 'auto', containIntrinsicSize: 'auto 190px' }}>
            {/* Header */}
            <div style={{ padding: '12px 14px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <button type="button" onClick={() => onOpen(key)} className={FOCUS_RING + ' hover:underline'}
                        style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, padding: 0, border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', textUnderlineOffset: 3, textDecorationColor: mix('hsl(var(--app-text))', 30) }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                            <span style={{ fontSize: 14, fontWeight: 650, color: T.text, lineHeight: 1.35, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{row.name}</span>
                            {row.danger && <AlertTriangle size={13} aria-label="Can make the drone unsafe" style={{ color: T.danger, flexShrink: 0 }} />}
                            {row.session && <span title="Changed since the parameters were loaded" aria-label="Changed since loading" style={{ width: 7, height: 7, borderRadius: '50%', background: T.warn, flexShrink: 0 }} />}
                        </span>
                        <span className="font-code" style={{ fontSize: 12, color: T.muted, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>{key}</span>
                    </button>
                    <span style={{ display: 'flex', flexShrink: 0 }}>
                        <button type="button" onClick={() => onOpen(key)} aria-label={`Details for ${key}`} title="Details, default and range"
                            className={FOCUS_RING + ' hover:bg-app-surface-2 transition-colors'}
                            style={{ width: 28, height: 28, marginTop: -4, marginRight: -6, borderRadius: 6, border: 'none', background: 'transparent', color: T.muted, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <Info size={15} />
                        </button>
                    </span>
                </div>
                {(showGroup || row.expert || m?.r) && (
                    <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {showGroup && <Tag color={gs.color}>{row.group}</Tag>}
                        {row.expert && <Tag color={T.warn}>Expert</Tag>}
                        {m?.r && <Tag color={T.muted}>Needs reboot</Tag>}
                    </span>
                )}
                {row.desc && (
                    <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: T.muted, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}>{row.desc}</p>
                )}
            </div>

            {/* Control */}
            <div style={{ padding: '0 14px 12px', marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {value == null ? (
                    <span style={{ fontSize: 13, color: T.muted }}>No default known</span>
                ) : !live ? (
                    <ReadOnly row={row} value={value} />
                ) : (
                    <Control kind={kind} row={row} value={value} pending={pending} commit={commit} onOpen={() => onOpen(key)} />
                )}

                {failed && !pending && <span role="alert" style={{ fontSize: 12, color: T.danger, lineHeight: 1.4 }}>{failed}</span>}

                {/* Footer */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 26, flexWrap: 'wrap' }}>
                    <span style={{ flex: '1 1 auto', minWidth: 0, fontSize: 12, color: row.offDefault ? T.warn : T.muted, fontVariantNumeric: 'tabular-nums' }}>
                        {!live
                            ? `Default in ${defaultsLabel}`
                            : def == null ? 'Default not known'
                            : row.offDefault ? `Not default (${fmtValue(def, m, row.isFloat)}${unit(m)})`
                            : 'At default'}
                        {live && row.session && row.loaded != null && <span style={{ color: T.muted }}>{`, was ${fmtValue(row.loaded, m, row.isFloat)}`}</span>}
                    </span>
                    <span aria-live="polite" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                        {pending ? <><Loader size={13} className="animate-spin" style={{ color: T.accent }} /><span style={{ color: T.accent }}>Saving</span></>
                            : failed ? <span style={{ color: T.danger, fontWeight: 700 }}>Refused</span>
                            : justSaved ? <><Check size={13} strokeWidth={3} style={{ color: T.ok }} /><span style={{ color: T.ok }}>Saved</span></> : null}
                    </span>
                    {live && row.session && row.loaded != null && !pending && (
                        <MiniBtn color={T.warn} onClick={() => writeParam(key, row.loaded!)} title={`Write back ${fmtValue(row.loaded, m, row.isFloat)}, the value when the parameters were loaded`}>
                            <RotateCcw size={12} /> Revert
                        </MiniBtn>
                    )}
                    {live && canResetDefault && row.offDefault && def != null && !row.session && !pending && (
                        <MiniBtn color={T.accent} onClick={() => writeParam(key, def)} title={`Write the firmware default, ${fmtValue(def, m, row.isFloat)}${unit(m)}`}>
                            <RotateCcw size={12} /> Default
                        </MiniBtn>
                    )}
                </div>
            </div>
        </article>
    )
})

function Tag({ color, children }: { color: string; children: React.ReactNode }) {
    return (
        <span style={{ fontSize: 12, fontWeight: 600, padding: '1px 7px', borderRadius: 6, background: mix(color, 11), color, whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {children}
        </span>
    )
}

function MiniBtn({ color, onClick, title, children }: { color: string; onClick: () => void; title: string; children: React.ReactNode }) {
    return (
        <button type="button" onClick={onClick} title={title} className={FOCUS_RING + ' transition-colors'}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 26, padding: '0 9px', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap',
                background: mix(color, 9), border: `1px solid ${mix(color, 30)}`, color, fontSize: 12, fontWeight: 700 }}>
            {children}
        </button>
    )
}

/** No drone: the reference default, drawn like a value, nothing to edit. */
function ReadOnly({ row, value }: { row: Row; value: number }) {
    const { m } = row
    const label = describeValue(value, m)
    const isBool = kindOf({ ...row, danger: false }) === 'bool'
    const boolOn = isBool && Math.round(value) === 1
    const boolOff = isBool && !boolOn
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: boolOff ? T.muted : boolOn ? T.ok : T.text, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>
                {m?.v && label ? label : `${fmtValue(value, m, row.isFloat)}${unit(m)}`}
            </span>
            {m?.b && label && <span style={{ fontSize: 12, color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>}
            {!m?.v && (m?.min != null || m?.max != null) && (
                <span style={{ fontSize: 12, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>Range {m?.min ?? 'any'} to {m?.max ?? 'any'}{unit(m)}</span>
            )}
        </div>
    )
}

function Control({ kind, row, value, pending, commit, onOpen }: {
    kind: Kind; row: Row; value: number; pending: boolean; commit: (v: number) => void; onOpen: () => void
}) {
    const { m, key } = row
    if (kind === 'bool') {
        const on = Math.round(value) === 1
        return (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 32 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: on ? T.ok : T.muted }}>{on ? 'Enabled' : 'Disabled'}</span>
                <Toggle label={row.name} value={on} disabled={pending} onChange={v => commit(v ? 1 : 0)} />
            </div>
        )
    }
    if (kind === 'pill') {
        return (
            <div role="radiogroup" aria-label={row.name} style={{ display: 'flex', gap: 4 }}>
                {m!.v!.map(([v, l]) => {
                    const on = Math.round(value) === v
                    return (
                        <button key={v} type="button" role="radio" aria-checked={on} disabled={pending} onClick={() => commit(v)}
                            className={FOCUS_RING + ' transition-colors'}
                            style={{ flex: 1, minWidth: 0, minHeight: 34, padding: '4px 8px', borderRadius: 6, cursor: pending ? 'wait' : 'pointer', fontSize: 13, lineHeight: 1.3,
                                border: `1px solid ${on ? T.accent : T.border}`, background: on ? mix(T.accent, 14) : T.surface2,
                                color: on ? T.text : T.muted, fontWeight: on ? 700 : 500 }}>
                            {l}
                        </button>
                    )
                })}
            </div>
        )
    }
    if (kind === 'select') {
        const opts = m!.v!.some(([v]) => v === Math.round(value)) ? m!.v! : [...m!.v!, [Math.round(value), `Value ${Math.round(value)}`] as [number, string]]
        return (
            <OptionSelect aria-label={row.name} value={Math.round(value)} disabled={pending} onChange={v => commit(v)}
                options={opts.map(([v, l]) => ({ value: v, label: l }))} />
        )
    }
    if (kind === 'bits' || kind === 'guarded') {
        const label = describeValue(value, m)
        return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 34 }}>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: T.text, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>{fmtValue(value, m, row.isFloat)}{unit(m)}</span>
                    {label && <span style={{ fontSize: 12, color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label}>{label}</span>}
                </span>
                <MiniBtn color={kind === 'guarded' ? T.danger : T.accent} onClick={onOpen} title={kind === 'guarded' ? `Change ${key} in the editor` : 'Pick the bits'}>
                    <SlidersHorizontal size={12} /> {kind === 'guarded' ? 'Change' : 'Choose'}
                </MiniBtn>
            </div>
        )
    }
    if (kind === 'slider') return <SliderControl row={row} value={value} pending={pending} commit={commit} />
    return <NumberControl row={row} value={value} pending={pending} commit={commit} />
}

function SliderControl({ row, value, pending, commit }: { row: Row; value: number; pending: boolean; commit: (v: number) => void }) {
    const m = row.m!
    const [draft, setDraft] = useState<number | null>(null)
    const shown = draft ?? value
    const step = m.inc ?? (row.isFloat ? Number(((m.max! - m.min!) / 200).toPrecision(2)) : 1)
    const release = () => {
        if (draft == null) return
        const v = row.isFloat ? draft : Math.round(draft)
        setDraft(null)
        if (!validate(v, m, row.isFloat)) commit(v)
    }
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 12, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>{m.min}</span>
                <span style={{ fontSize: 17, fontWeight: 700, color: T.text, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtValue(shown, m, row.isFloat)}<span style={{ fontSize: 13, fontWeight: 600, color: T.muted }}>{unit(m)}</span>
                </span>
                <span style={{ fontSize: 12, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>{m.max}{unit(m)}</span>
            </div>
            <input type="range" aria-label={row.name} min={m.min} max={m.max} step={step} value={Math.min(m.max!, Math.max(m.min!, shown))} disabled={pending}
                onChange={e => setDraft(Number(e.target.value))}
                onPointerUp={release} onKeyUp={release} onBlur={release}
                className={FOCUS_RING}
                style={{ width: '100%', accentColor: 'var(--app-accent)', cursor: pending ? 'wait' : 'pointer', margin: '4px 0' }} />
        </div>
    )
}

function NumberControl({ row, value, pending, commit }: { row: Row; value: number; pending: boolean; commit: (v: number) => void }) {
    const { m } = row
    const [draft, setDraft] = useState<string | null>(null)
    const [err, setErr] = useState<string | null>(null)
    const done = () => {
        if (draft == null) return
        const t = draft.trim()
        const v = t === '' ? NaN : Number(t)
        const why = validate(v, m, row.isFloat)
        setErr(why)
        if (why) return
        setDraft(null)
        commit(v)
    }
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input aria-label={row.name} inputMode="decimal" value={draft ?? fmtValue(value, m, row.isFloat)} disabled={pending} aria-invalid={!!err}
                    onChange={e => { setDraft(e.target.value); setErr(null) }}
                    onBlur={done}
                    onKeyDown={e => { if (e.key === 'Enter') done(); if (e.key === 'Escape') { setDraft(null); setErr(null) } }}
                    className={FOCUS_RING}
                    style={{ flex: 1, minWidth: 0, height: 36, padding: '0 10px', borderRadius: 6, boxSizing: 'border-box', outline: 'none',
                        background: T.surface2, border: `1px solid ${err ? T.danger : T.borderStrong}`, color: T.text, fontSize: 14, fontVariantNumeric: 'tabular-nums' }} />
                {m?.u && <span style={{ fontSize: 13, color: T.muted }}>{m.u}</span>}
            </div>
            {err ? <span role="alert" style={{ fontSize: 12, color: T.danger }}>{err}</span>
                : (m?.min != null || m?.max != null) && <span style={{ fontSize: 12, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>Range {m?.min ?? 'any'} to {m?.max ?? 'any'}{unit(m)}</span>}
        </div>
    )
}
