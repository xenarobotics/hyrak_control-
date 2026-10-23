'use client'

// Setpoint against measured response, drawn as SVG so the theme's CSS
// variables colour it directly (true light and dark mode, no canvas
// repaint on theme change). Up to ~1000 points per line at 50 Hz over 20 s.

import React, { useEffect, useId, useRef, useState } from 'react'
import { T, mix } from '@/components/config/kit'
import type { Pt } from '@/lib/tuningStream'
import type { StepResult } from './stepAnalysis'

export const SP_COLOR = 'var(--app-warn)'
export const MEAS_COLOR = 'var(--app-accent)'

const GAP_S = 0.5          // break the line across a gap this long

function niceStep(range: number, target: number): number {
    const raw = range / Math.max(1, target)
    const mag = Math.pow(10, Math.floor(Math.log10(raw)))
    const n = raw / mag
    return (n >= 5 ? 10 : n >= 2 ? 5 : n >= 1 ? 2 : 1) * mag
}

function fmtTick(v: number, step: number): string {
    const d = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)))
    const s = v.toFixed(d)
    return s === '-0' || /^-0\.0*$/.test(s) ? s.slice(1) : s
}

function path(pts: Pt[], t0: number, t1: number, x: (t: number) => number, y: (v: number) => number): string {
    let d = ''
    let prevT = -Infinity
    for (const p of pts) {
        if (p.t < t0 - 1 || p.t > t1 + 1) continue
        d += (p.t - prevT > GAP_S ? 'M' : 'L') + x(p.t).toFixed(1) + ' ' + y(p.v).toFixed(1)
        prevT = p.t
    }
    return d
}

export function TuningChart({ sp, meas, t1, span, minRange, tRef, step, overlay, height, label }: {
    sp: Pt[]; meas: Pt[]
    /** Right edge time (s, autopilot clock) and window length. */
    t1: number; span: number
    /** Smallest y range drawn, so a still aircraft's noise is not blown up. */
    minRange: number
    /** Time labelled as 0 on the x axis. */
    tRef: number
    step?: StepResult | null
    overlay?: React.ReactNode
    height?: number
    label: string
}) {
    const wrapRef = useRef<HTMLDivElement>(null)
    const [w, setW] = useState(640)
    useEffect(() => {
        const el = wrapRef.current
        if (!el) return
        const ro = new ResizeObserver(e => setW(Math.max(240, Math.round(e[0].contentRect.width))))
        ro.observe(el)
        return () => ro.disconnect()
    }, [])
    const h = height ?? (w < 480 ? 210 : 260)
    const m = { l: 46, r: 10, t: 10, b: 26 }
    const t0 = t1 - span

    let lo = Infinity, hi = -Infinity
    for (const arr of [sp, meas]) for (const p of arr) {
        if (p.t < t0 || p.t > t1) continue
        if (p.v < lo) lo = p.v
        if (p.v > hi) hi = p.v
    }
    if (step) { lo = Math.min(lo, step.before, step.after); hi = Math.max(hi, step.before, step.after) }
    if (!Number.isFinite(lo)) { lo = -minRange / 2; hi = minRange / 2 }
    if (hi - lo < minRange) { const c = (hi + lo) / 2; lo = c - minRange / 2; hi = c + minRange / 2 }
    const pad = (hi - lo) * 0.08
    lo -= pad; hi += pad
    const yStep = niceStep(hi - lo, h < 230 ? 4 : 5)
    const yTicks: number[] = []
    for (let v = Math.ceil(lo / yStep) * yStep; v <= hi + 1e-9; v += yStep) yTicks.push(v)
    const xStep = span <= 5 ? 1 : span <= 10 ? (w < 480 ? 5 : 2) : 5

    const pw = w - m.l - m.r, ph = h - m.t - m.b
    const x = (t: number) => m.l + ((t - t0) / span) * pw
    const y = (v: number) => m.t + (1 - (v - lo) / (hi - lo)) * ph
    const xTicks: number[] = []
    for (let s = Math.ceil((t0 - tRef) / xStep) * xStep; s <= t1 - tRef + 1e-9; s += xStep) xTicks.push(s)

    const band = step ? Math.abs(step.after - step.before) * step.bandPct / 100 : 0
    const clipId = 'tuning-clip-' + useId().replace(/:/g, '')

    return (
        <div ref={wrapRef} style={{ position: 'relative', width: '100%', minWidth: 0 }}>
            <svg width={w} height={h} role="img" aria-label={label}
                style={{ display: 'block', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums' }}>
                <defs><clipPath id={clipId}><rect x={m.l} y={m.t} width={pw} height={ph} /></clipPath></defs>
                <rect x={m.l} y={m.t} width={pw} height={ph} rx={4} fill={T.surface2} />
                {yTicks.map(v => (
                    <g key={'y' + v}>
                        <line x1={m.l} x2={m.l + pw} y1={y(v)} y2={y(v)} stroke={Math.abs(v) < yStep / 1e6 ? T.borderStrong : T.border} strokeWidth={1} />
                        <text x={m.l - 6} y={y(v)} dy="0.35em" textAnchor="end" fontSize={12} fill={T.muted}>{fmtTick(v, yStep)}</text>
                    </g>
                ))}
                {xTicks.map(s => (
                    <g key={'x' + s}>
                        <line x1={x(s + tRef)} x2={x(s + tRef)} y1={m.t} y2={m.t + ph} stroke={T.border} strokeWidth={1} strokeDasharray="2 4" />
                        <text x={x(s + tRef)} y={h - 8} textAnchor="middle" fontSize={12} fill={T.muted}>{fmtTick(s, xStep)}{s === xTicks[xTicks.length - 1] ? ' s' : ''}</text>
                    </g>
                ))}
                <g clipPath={`url(#${clipId})`}>
                    {step && (
                        <>
                            <rect x={x(step.t0)} width={Math.max(0, x(step.tEnd) - x(step.t0))} y={y(step.after + band)} height={Math.max(1, y(step.after - band) - y(step.after + band))}
                                fill={mix('var(--app-ok)', 14)} />
                            <line x1={x(step.t0)} x2={x(step.t0)} y1={m.t} y2={m.t + ph} stroke={T.muted} strokeWidth={1} strokeDasharray="4 3" />
                            {step.settleS != null && (
                                <line x1={x(step.t0 + step.settleS)} x2={x(step.t0 + step.settleS)} y1={m.t} y2={m.t + ph} stroke="var(--app-ok)" strokeWidth={1.5} strokeDasharray="4 3" />
                            )}
                        </>
                    )}
                    <path d={path(sp, t0, t1, x, y)} fill="none" stroke={SP_COLOR} strokeWidth={2} strokeDasharray="7 4" strokeLinejoin="round" strokeLinecap="round" />
                    <path d={path(meas, t0, t1, x, y)} fill="none" stroke={MEAS_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                </g>
            </svg>
            {overlay && (
                <div style={{ position: 'absolute', left: m.l, top: m.t, width: pw, height: ph, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, boxSizing: 'border-box' }}>
                    {overlay}
                </div>
            )}
        </div>
    )
}
