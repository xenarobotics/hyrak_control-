'use client'

// A horizontal level bar with "fine" and "bad" marks, for vibration levels
// and estimator test ratios. The fill takes the colour of the band it ends
// in, and the number is always printed beside it, so the bar never carries
// meaning by colour alone.

import React from 'react'
import { T, mix } from '@/components/config/kit'

export type Level = 'ok' | 'warn' | 'danger' | 'none' | 'unused'

export function levelOf(v: number | null | undefined, warnAt: number, badAt: number): Level {
    if (v == null || !Number.isFinite(v)) return 'none'
    return v > badAt ? 'danger' : v >= warnAt ? 'warn' : 'ok'
}

const COLOR: Record<Level, string> = { ok: T.ok, warn: T.warn, danger: T.danger, none: T.muted, unused: T.muted }
export const LEVEL_WORD: Record<Level, string> = { ok: 'Good', warn: 'High', danger: 'Too high', none: 'No data', unused: 'Not used' }

export function LevelBar({ label, value, max, warnAt, badAt, unit, decimals = 1, hint, zeroUnused }: {
    label: string
    value: number | null | undefined
    /** Right end of the bar; bigger values pin to the end. */
    max: number
    warnAt: number
    badAt: number
    unit?: string
    decimals?: number
    hint?: string
    /** A value of exactly 0 means the input is not in use (estimator ratios). */
    zeroUnused?: boolean
}) {
    const lvl: Level = zeroUnused && value === 0 ? 'unused' : levelOf(value, warnAt, badAt)
    const c = COLOR[lvl]
    const pct = value == null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(100, (value / max) * 100))
    const mark = (at: number) => `${Math.min(100, (at / max) * 100)}%`
    return (
        <div className="grid grid-cols-[1fr_auto] sm:grid-cols-[minmax(84px,140px)_1fr_auto]" style={{ alignItems: 'center', gap: '4px 12px' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: T.text, minWidth: 0 }}>
                {label}
                {hint && <span style={{ display: 'block', fontSize: 12, fontWeight: 500, color: T.muted }}>{hint}</span>}
            </span>
            <div className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value ?? undefined}
                aria-valuetext={value == null ? 'No data' : `${value.toFixed(decimals)}${unit ? ' ' + unit : ''}, ${LEVEL_WORD[lvl]}`}
                style={{ position: 'relative', height: 12, borderRadius: 999, background: T.surface2, border: `1px solid ${T.border}`, overflow: 'hidden' }}>
                <div style={{ position: 'absolute', top: 0, bottom: 0, left: mark(warnAt), width: `calc(${mark(badAt)} - ${mark(warnAt)})`, background: mix('var(--app-warn)', 10) }} />
                <div style={{ position: 'absolute', top: 0, bottom: 0, left: mark(badAt), right: 0, background: mix('var(--app-danger)', 10) }} />
                <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${pct}%`, background: c, borderRadius: 999, transition: 'width 240ms var(--ease-out)' }} />
                <div aria-hidden style={{ position: 'absolute', top: 0, bottom: 0, left: mark(warnAt), width: 1, background: T.borderStrong }} />
                <div aria-hidden style={{ position: 'absolute', top: 0, bottom: 0, left: mark(badAt), width: 1, background: T.borderStrong }} />
            </div>
            <span style={{ minWidth: 92, textAlign: 'right', fontSize: 14, fontWeight: 700, color: lvl === 'none' || lvl === 'unused' ? T.muted : T.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {value == null || !Number.isFinite(value) ? '-' : value.toFixed(decimals)}
                {unit && value != null && <span style={{ fontSize: 12, fontWeight: 600, color: T.muted, marginLeft: 3 }}>{unit}</span>}
                <span style={{ display: 'block', fontSize: 12, fontWeight: 700, color: c }}>{LEVEL_WORD[lvl]}</span>
            </span>
        </div>
    )
}

/** The scale under a group of bars: where the marks are, in words. */
export function LevelScale({ max, warnAt, badAt, unit, decimals = 0 }: { max: number; warnAt: number; badAt: number; unit?: string; decimals?: number }) {
    const pos = (v: number) => `${(v / max) * 100}%`
    return (
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(84px,140px)_1fr_auto]" style={{ gap: '0 12px' }}>
            <span className="max-sm:hidden" />
            <div style={{ position: 'relative', height: 16, fontSize: 12, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>
                <span style={{ position: 'absolute', left: 0 }}>0</span>
                <span style={{ position: 'absolute', left: pos(warnAt), transform: 'translateX(-50%)' }}>{warnAt.toFixed(decimals)}</span>
                <span style={{ position: 'absolute', left: pos(badAt), transform: 'translateX(-50%)' }}>{badAt.toFixed(decimals)}</span>
                <span style={{ position: 'absolute', right: 0 }}>{unit}</span>
            </div>
            <span className="max-sm:hidden" style={{ minWidth: 92 }} />
        </div>
    )
}
