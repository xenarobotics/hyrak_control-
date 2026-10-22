'use client'

// Building blocks for the Config setup pages that read and write the
// aircraft's own parameters (Power, Actuators, Safety, Tuning, ...).
// Same look as the rest of Config: quiet surfaces, sentence-case titles,
// tabular numerals, 12 px floor, theme tokens only.

import React, { useEffect, useRef, useState } from 'react'
import { Check, Info, Loader, RefreshCw, WifiOff, AlertTriangle, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { OptionSelect } from '@/components/config/OptionSelect'
import { reloadParams, useVehicleParams, writeParam } from '@/lib/vehicleParams'

export const FOCUS_RING = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-accent)]'
export const mix = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`

export const T = {
    text: 'hsl(var(--app-text))',
    muted: 'hsl(var(--app-text-muted))',
    subtle: 'hsl(var(--app-text-subtle))',
    surface: 'hsl(var(--app-surface))',
    surface2: 'hsl(var(--app-surface-2))',
    border: 'hsl(var(--app-border))',
    borderStrong: 'hsl(var(--app-border-strong))',
    accent: 'var(--app-accent)',
    ok: 'var(--app-ok)',
    warn: 'var(--app-warn)',
    danger: 'var(--app-danger)',
}

export function Tip({ text }: { text: string }) {
    return (
        <Tooltip>
            <TooltipTrigger aria-label="More info" className={'rounded-full bg-transparent text-app-text-muted hover:bg-app-surface-2 hover:text-app-text transition-colors ' + FOCUS_RING} style={{ border: 'none', padding: 5, margin: -3, cursor: 'help', display: 'flex' }}><Info size={14} /></TooltipTrigger>
            <TooltipContent style={{ maxWidth: 280, fontSize: 13, lineHeight: 1.45 }}>{text}</TooltipContent>
        </Tooltip>
    )
}

export function Panel({ title, hint, right, children, pad = 16, gap = 12, style }: {
    title?: React.ReactNode; hint?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode
    pad?: number; gap?: number; style?: React.CSSProperties
}) {
    return (
        <section style={{ borderRadius: 10, background: T.surface, border: `1px solid ${T.border}`, minWidth: 0, ...style }}>
            {(title || right) && (
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 10px', padding: `14px ${pad}px 0` }}>
                    {title && <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0, color: T.text }}>{title}</h3>}
                    {hint && <span style={{ fontSize: 13, color: T.muted }}>{hint}</span>}
                    {right && <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>{right}</span>}
                </div>
            )}
            <div style={{ padding: pad, display: 'flex', flexDirection: 'column', gap }}>{children}</div>
        </section>
    )
}

export function Grid({ children, min = 300, gap = 16 }: { children: React.ReactNode; min?: number; gap?: number }) {
    return <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${min}px), 1fr))`, gap, alignItems: 'start' }}>{children}</div>
}

export type Tone = 'ok' | 'warn' | 'danger' | 'off' | 'accent'
const TONE: Record<Tone, string> = { ok: T.ok, warn: T.warn, danger: T.danger, off: T.muted, accent: T.accent }

export function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
    const c = TONE[tone]
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 999, flexShrink: 0,
            background: mix(c, 9), border: `1px solid ${mix(c, 26)}`, fontSize: 12, fontWeight: 700, color: c,
            whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
        }}>
            {tone === 'ok' ? <Check size={12} strokeWidth={3} aria-hidden /> : tone === 'warn' || tone === 'danger' ? <AlertTriangle size={12} aria-hidden /> : null}
            {children}
        </span>
    )
}

/** A short note in a tinted box. */
export function Note({ tone = 'off', children, icon }: { tone?: Tone; children: React.ReactNode; icon?: React.ReactNode }) {
    const c = TONE[tone]
    return (
        <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', borderRadius: 8,
            background: tone === 'off' ? T.surface2 : mix(c, 8), border: `1px solid ${tone === 'off' ? T.border : mix(c, 30)}`,
            fontSize: 13, lineHeight: 1.5, color: T.text,
        }}>
            {icon ?? (tone === 'warn' || tone === 'danger' ? <AlertTriangle size={15} style={{ color: c, flexShrink: 0, marginTop: 2 }} /> : <Info size={15} style={{ color: c, flexShrink: 0, marginTop: 2 }} />)}
            <div style={{ minWidth: 0, flex: 1 }}>{children}</div>
        </div>
    )
}

type BtnKind = 'primary' | 'quiet' | 'danger' | 'ok'
export function Btn({ kind = 'quiet', onClick, disabled, children, title, type = 'button', style, big }: {
    kind?: BtnKind; onClick?: () => void; disabled?: boolean; children: React.ReactNode; title?: string
    type?: 'button' | 'submit'; style?: React.CSSProperties; big?: boolean
}) {
    const solid = kind === 'primary' || (kind === 'danger' && big)
    const c = kind === 'danger' ? T.danger : kind === 'ok' ? T.ok : T.accent
    return (
        <button type={type} onClick={disabled ? undefined : onClick} disabled={disabled} title={title}
            className={FOCUS_RING + ' transition-colors'}
            style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                minHeight: big ? 48 : 34, padding: big ? '0 22px' : '0 14px', borderRadius: 8,
                fontSize: big ? 16 : 13, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
                background: disabled ? T.surface2 : solid ? (kind === 'danger' ? T.danger : 'var(--app-accent)') : kind === 'quiet' ? 'transparent' : mix(c, 8),
                color: disabled ? T.muted : solid ? (kind === 'danger' ? '#fff' : 'var(--app-accent-ink)') : kind === 'quiet' ? T.text : c,
                border: `1px solid ${disabled ? T.border : solid ? 'transparent' : kind === 'quiet' ? T.borderStrong : mix(c, 45)}`,
                opacity: disabled ? 0.75 : 1,
                ...style,
            }}>
            {children}
        </button>
    )
}

export function Toggle({ value, onChange, disabled, label }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
    return (
        <button type="button" role="switch" aria-checked={value} aria-label={label} disabled={disabled} onClick={disabled ? undefined : () => onChange(!value)}
            className={FOCUS_RING}
            style={{ width: 40, height: 24, borderRadius: 999, cursor: disabled ? 'not-allowed' : 'pointer', flexShrink: 0, padding: 0,
                background: value ? (disabled ? mix('var(--app-accent)', 45) : 'var(--app-accent)') : 'hsl(var(--app-border-strong))', border: 'none',
                position: 'relative', transition: 'background-color var(--dur) var(--ease-out)', opacity: disabled && !value ? 0.6 : 1 }}>
            <span style={{ position: 'absolute', top: 4, left: 4, width: 16, height: 16, borderRadius: '50%', background: '#fff',
                transform: `translateX(${value ? 16 : 0}px)`, transition: 'transform var(--dur) var(--ease-out)' }} />
        </button>
    )
}

/** Where the page's numbers come from: no drone, downloading, failed, or live. */
export function ParamSourceBar({ what = 'these settings' }: { what?: string }) {
    const { connected, loading, error, params, has } = useVehicleParams()
    if (!connected) {
        return (
            <Note icon={<WifiOff size={15} style={{ color: T.muted, flexShrink: 0, marginTop: 2 }} />}>
                <b>No drone connected.</b> Connect one from the Fly tab to read and change {what}. Values shown are PX4 defaults, for reference.
            </Note>
        )
    }
    if (loading && !params) {
        return (
            <Note icon={<Loader size={15} className="animate-spin" style={{ color: T.accent, flexShrink: 0, marginTop: 2 }} />}>
                Reading parameters from the drone. About 5 s on SITL, up to 30 s over a telemetry radio.
            </Note>
        )
    }
    if (error && !params) {
        return (
            <Note tone="warn">
                <span>{error}. </span>
                <button type="button" onClick={reloadParams} className={FOCUS_RING} style={{ background: 'none', border: 'none', padding: 0, color: T.accent, fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>Try again</button>
            </Note>
        )
    }
    if (params && !has('SYS_AUTOSTART')) {
        return <Note tone="warn">This aircraft does not look like PX4 (no SYS_AUTOSTART). These pages follow PX4 parameter names.</Note>
    }
    return null
}

export function ReloadButton() {
    const { connected, loading } = useVehicleParams()
    return (
        <button type="button" onClick={reloadParams} disabled={!connected || loading} title="Read every parameter from the drone again"
            className={FOCUS_RING + ' transition-colors hover:bg-app-surface-2'}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 32, padding: '0 10px', borderRadius: 6, background: 'transparent',
                border: `1px solid ${T.border}`, color: connected ? T.text : T.muted, fontSize: 13, fontWeight: 600, cursor: connected && !loading ? 'pointer' : 'not-allowed' }}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} /> Reload
        </button>
    )
}

// ── Parameter rows ──────────────────────────────────────────────────────────

export interface ParamSpec {
    key: string
    label: string
    tip?: string
    /** PX4's default, shown when no drone is connected. */
    def?: number
    unit?: string
    min?: number
    max?: number
    step?: number
    /** Shown value = stored * scale (BAT_LOW_THR 0.15 shown as 15 %). */
    scale?: number
    decimals?: number
    options?: { value: number; label: string }[]
    /** 0/1 parameter drawn as a switch. */
    bool?: boolean
    /** Keys tried in order; the first the aircraft has wins (BAT1_* vs BAT_*). */
    alt?: string[]
}

/** Which key the aircraft actually has for a spec, or the spec key. */
export function resolveKey(spec: ParamSpec, has: (k: string) => boolean): string {
    if (has(spec.key)) return spec.key
    for (const a of spec.alt ?? []) if (has(a)) return a
    return spec.key
}

function fmt(v: number, decimals?: number): string {
    if (decimals != null) return v.toFixed(decimals)
    if (Number.isInteger(v)) return String(v)
    return String(Number(v.toFixed(4)))
}

/** One parameter: label and tip on the left, its control on the right, and
 *  the aircraft's acknowledgement (saving, saved, refused) beside it. */
export function ParamRow({ spec, disabled, compact, onWrite }: {
    spec: ParamSpec; disabled?: boolean; compact?: boolean
    /** Replace the write (to add a confirmation, say). */
    onWrite?: (key: string, stored: number) => void
}) {
    const vp = useVehicleParams()
    const key = resolveKey(spec, vp.has)
    const live = vp.get(key)
    const missing = vp.ready && live === null
    const scale = spec.scale ?? 1
    const stored = live ?? spec.def ?? null
    const shown = stored == null ? null : stored * scale
    const canEdit = vp.ready && !missing && !disabled
    const isDefault = !vp.ready
    const pending = !!vp.pending[key]
    const failed = vp.failed[key]
    const savedAt = vp.saved[key] ?? 0
    const [now, setNow] = useState(0)
    useEffect(() => {
        if (!savedAt) return
        const t0 = setTimeout(() => setNow(Date.now()), 0)
        const t = setTimeout(() => setNow(Date.now()), 2200)
        return () => { clearTimeout(t0); clearTimeout(t) }
    }, [savedAt])
    const justSaved = savedAt > 0 && now - savedAt < 2000

    const commit = (displayValue: number) => {
        const v = displayValue / scale
        if (onWrite) onWrite(key, v); else writeParam(key, v)
    }

    let control: React.ReactNode
    if (spec.bool) {
        control = <Toggle label={spec.label} value={(shown ?? 0) !== 0} disabled={!canEdit} onChange={on => commit(on ? 1 : 0)} />
    } else if (spec.options) {
        const opts = spec.options.some(o => o.value === stored) || stored == null ? spec.options : [...spec.options, { value: stored, label: `Value ${fmt(stored)}` }]
        control = (
            <OptionSelect size="sm" aria-label={spec.label} className="w-auto min-w-[150px] max-w-[260px] text-[13px] data-[size=sm]:h-8"
                value={stored} disabled={!canEdit} placeholder={missing ? 'Not on this drone' : '...'}
                onChange={v => commit(v * scale)}
                options={opts.map(o => ({ value: o.value, label: o.label }))} />
        )
    } else {
        control = <NumberBox value={shown} decimals={spec.decimals} min={spec.min} max={spec.max} step={spec.step} unit={spec.unit}
            disabled={!canEdit} label={spec.label} onCommit={commit} placeholder={missing ? 'n/a' : undefined} />
    }

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: compact ? 34 : 38, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 160px', minWidth: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: missing ? T.muted : T.text }}>{spec.label}</span>
                {spec.tip && <Tip text={`${spec.tip} (${key})`} />}
                {isDefault && <span style={{ fontSize: 12, color: T.subtle }}>default</span>}
                {missing && <span style={{ fontSize: 12, color: T.muted }}>not on this drone</span>}
            </div>
            <span aria-live="polite" style={{ width: 18, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
                {pending ? <Loader size={14} className="animate-spin" style={{ color: T.accent }} aria-label="Saving" />
                    : failed ? <span title={failed}><X size={15} style={{ color: T.danger }} aria-label="Refused" /></span>
                    : justSaved ? <Check size={15} strokeWidth={3} style={{ color: T.ok }} aria-label="Saved" /> : null}
            </span>
            {control}
            {failed && <p style={{ flexBasis: '100%', margin: 0, fontSize: 12, color: T.danger }}>{failed}</p>}
        </div>
    )
}

/** A number field that commits on Enter or blur, never on every keystroke:
 *  each commit is a write to the aircraft. */
export function NumberBox({ value, onCommit, disabled, min, max, step, unit, decimals, label, placeholder, width = 96 }: {
    value: number | null; onCommit: (v: number) => void; disabled?: boolean
    min?: number; max?: number; step?: number; unit?: string; decimals?: number; label: string; placeholder?: string; width?: number
}) {
    const [draft, setDraft] = useState<string | null>(null)
    const [err, setErr] = useState<string | null>(null)
    const ref = useRef<HTMLInputElement>(null)
    const text = draft ?? (value == null ? '' : fmt(value, decimals))
    const done = () => {
        if (draft == null) return
        const v = Number(draft)
        if (draft.trim() === '' || !Number.isFinite(v)) { setErr('Enter a number'); return }
        if (min != null && v < min) { setErr(`At least ${min}`); return }
        if (max != null && v > max) { setErr(`At most ${max}`); return }
        setErr(null)
        setDraft(null)
        if (value == null || Math.abs(v - value) > 1e-9) onCommit(v)
    }
    return (
        <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input ref={ref} aria-label={label} inputMode="decimal" value={text} disabled={disabled} placeholder={placeholder}
                    step={step}
                    onChange={e => { setDraft(e.target.value); setErr(null) }}
                    onBlur={done}
                    onKeyDown={e => { if (e.key === 'Enter') { done(); ref.current?.blur() } if (e.key === 'Escape') { setDraft(null); setErr(null) } }}
                    className={FOCUS_RING}
                    style={{
                        width, height: 32, padding: '0 9px', borderRadius: 6, boxSizing: 'border-box', outline: 'none', textAlign: 'right',
                        background: disabled ? T.surface2 : T.surface, border: `1px solid ${err ? T.danger : disabled ? T.border : T.borderStrong}`,
                        color: disabled ? T.muted : T.text, fontSize: 14, fontVariantNumeric: 'tabular-nums', cursor: disabled ? 'not-allowed' : undefined,
                    }} />
                {unit && <span style={{ fontSize: 13, color: T.muted, minWidth: 22 }}>{unit}</span>}
            </span>
            {err && <span role="alert" style={{ fontSize: 12, color: T.danger }}>{err}</span>}
        </span>
    )
}

/** A centred dialog. Escape and the backdrop close it. */
export function Dialog({ open, onClose, title, children, width = 480 }: {
    open: boolean; onClose: () => void; title: string; children: React.ReactNode; width?: number
}) {
    const ref = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (!open) return
        const prev = document.activeElement as HTMLElement | null
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        setTimeout(() => ref.current?.querySelector<HTMLElement>('input, button, select')?.focus(), 0)
        return () => { window.removeEventListener('keydown', onKey); prev?.focus?.() }
    }, [open, onClose])
    if (!open) return null
    return (
        <div role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
            style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgb(8 12 18 / 0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="animate-in fade-in-0 zoom-in-95 duration-150"
                style={{ width: '100%', maxWidth: width, maxHeight: '90vh', overflowY: 'auto', borderRadius: 12, background: 'hsl(var(--app-raised))', border: `1px solid ${T.border}`, boxShadow: 'var(--app-shadow)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: `1px solid ${T.border}` }}>
                    <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: T.text, flex: 1 }}>{title}</h3>
                    <button type="button" aria-label="Close" onClick={onClose} className={FOCUS_RING + ' hover:bg-app-surface-2 transition-colors'}
                        style={{ width: 32, height: 32, borderRadius: 6, border: 'none', background: 'transparent', color: T.muted, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={16} /></button>
                </div>
                <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
            </div>
        </div>
    )
}

/** Tabs drawn as a row of buttons, for sub-pages inside one section. */
export function SubTabs<T extends string>({ value, onChange, tabs, label }: {
    value: T; onChange: (v: T) => void; tabs: { id: T; label: React.ReactNode; badge?: React.ReactNode }[]; label: string
}) {
    return (
        <div role="tablist" aria-label={label} style={{ display: 'flex', gap: 2, borderBottom: `1px solid ${T.border}`, overflowX: 'auto' }}>
            {tabs.map(t => {
                const on = t.id === value
                return (
                    <button key={t.id} role="tab" aria-selected={on} type="button" onClick={() => onChange(t.id)}
                        className={FOCUS_RING + ' transition-colors ' + (on ? '' : 'hover:text-app-text')}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 14px', minHeight: 38, border: 'none', background: 'transparent', cursor: 'pointer',
                            fontSize: 14, fontWeight: on ? 700 : 600, color: on ? T.text : T.muted, whiteSpace: 'nowrap',
                            boxShadow: on ? 'inset 0 -2px 0 var(--app-accent)' : 'none' }}>
                        {t.label}{t.badge}
                    </button>
                )
            })}
        </div>
    )
}

/** Label and value on one line, value in tabular numerals. */
export function Readout({ label, value, unit, tone }: { label: string; value: React.ReactNode; unit?: string; tone?: Tone }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: T.muted }}>{label}</span>
            <span style={{ fontSize: 20, fontWeight: 700, color: tone ? TONE[tone] : T.text, fontVariantNumeric: 'tabular-nums', lineHeight: 1.2, whiteSpace: 'nowrap' }}>
                {value}{unit && <span style={{ fontSize: 13, fontWeight: 600, color: T.muted, marginLeft: 3 }}>{unit}</span>}
            </span>
        </div>
    )
}
