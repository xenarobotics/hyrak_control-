'use client'

// A time-series line chart drawn as SVG, so the theme's CSS variables colour
// it directly (true light and dark mode, no canvas repaint on theme change).
// Shared by Config > Tuning (setpoint against response), the MAVLink
// Inspector's live plot and the log viewer.
//
// Optional extras: a hover readout of every line at the pointer, and
// drag-to-zoom (onSelectRange) for charts over a whole log.

import React, { useEffect, useId, useRef, useState } from 'react'
import { T } from '@/components/config/kit'

export interface Pt { t: number; v: number }

export interface ChartSeries {
    id: string
    pts: Pt[]
    color: string
    label?: string
    dash?: string
    width?: number
}

/** Pixel mapping handed to `under` so callers can draw bands and markers. */
export interface ChartScale {
    x: (t: number) => number
    y: (v: number) => number
    m: { l: number; r: number; t: number; b: number }
    pw: number
    ph: number
    t0: number
    t1: number
    lo: number
    hi: number
}

export function niceStep(range: number, target: number): number {
    const raw = range / Math.max(1, target)
    if (!(raw > 0) || !Number.isFinite(raw)) return 1
    const mag = Math.pow(10, Math.floor(Math.log10(raw)))
    const n = raw / mag
    return (n >= 5 ? 10 : n >= 2 ? 5 : n >= 1 ? 2 : 1) * mag
}

export function fmtTick(v: number, step: number): string {
    const d = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)))
    const s = v.toFixed(d)
    return s === '-0' || /^-0\.0*$/.test(s) ? s.slice(1) : s
}

/** A short, readable number for readouts. */
export function fmtValue(v: number): string {
    const a = Math.abs(v)
    if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(3)
    if (a >= 1000) return v.toFixed(1)
    if (a >= 10) return v.toFixed(2)
    return v.toFixed(4).replace(/\.?0+$/, '') || '0'
}

function path(pts: Pt[], t0: number, t1: number, gapS: number, x: (t: number) => number, y: (v: number) => number): string {
    let d = ''
    let prevT = -Infinity
    const pad = (t1 - t0) * 0.05
    for (const p of pts) {
        if (p.t < t0 - pad || p.t > t1 + pad) continue
        d += (p.t - prevT > gapS ? 'M' : 'L') + x(p.t).toFixed(1) + ' ' + y(p.v).toFixed(1)
        prevT = p.t
    }
    return d
}

/** Index of the point nearest `t` in a time-sorted array, or -1. */
function nearest(pts: Pt[], t: number): number {
    if (!pts.length) return -1
    let lo = 0, hi = pts.length - 1
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (pts[mid].t < t) lo = mid; else hi = mid
    }
    return Math.abs(pts[lo].t - t) <= Math.abs(pts[hi].t - t) ? lo : hi
}

export function LineChart({ series, t1, span, minRange = 0, tRef, xStep: xStepIn, xUnit = 's', gapS = 0.5, height, label,
    overlay, extent, under, hover = false, onSelectRange }: {
    series: ChartSeries[]
    /** Right edge time and window length, in the series' own time unit. */
    t1: number; span: number
    /** Smallest y range drawn, so a still signal's noise is not blown up. */
    minRange?: number
    /** Time labelled as 0 on the x axis (default: none, raw times). */
    tRef?: number
    /** Fixed x tick spacing; by default a round step for the width. */
    xStep?: number
    xUnit?: string
    /** A gap in a line longer than this breaks it. */
    gapS?: number
    height?: number
    label: string
    overlay?: React.ReactNode
    /** Extra values the y range must include. */
    extent?: number[]
    under?: (sc: ChartScale) => React.ReactNode
    hover?: boolean
    onSelectRange?: (t0: number, t1: number) => void
}) {
    const wrapRef = useRef<HTMLDivElement>(null)
    const [w, setW] = useState(640)
    const [hx, setHx] = useState<number | null>(null)
    const [sel, setSel] = useState<{ a: number; b: number } | null>(null)
    useEffect(() => {
        const el = wrapRef.current
        if (!el) return
        const ro = new ResizeObserver(e => setW(Math.max(240, Math.round(e[0].contentRect.width))))
        ro.observe(el)
        return () => ro.disconnect()
    }, [])
    const h = height ?? (w < 480 ? 210 : 260)
    const m = { l: 52, r: 12, t: 10, b: 26 }
    const t0 = t1 - span
    const ref = tRef ?? 0

    let lo = Infinity, hi = -Infinity
    for (const s of series) for (const p of s.pts) {
        if (p.t < t0 || p.t > t1) continue
        if (p.v < lo) lo = p.v
        if (p.v > hi) hi = p.v
    }
    for (const v of extent ?? []) { if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v) } }
    if (!Number.isFinite(lo)) { const e0 = minRange > 0 ? minRange : 1; lo = -e0 / 2; hi = e0 / 2 }
    const floor = Math.max(minRange, Math.abs(hi + lo) * 1e-6, 1e-9)
    if (hi - lo < floor) { const c = (hi + lo) / 2; lo = c - floor / 2; hi = c + floor / 2 }
    const pad = (hi - lo) * 0.08
    lo -= pad; hi += pad
    const yStep = niceStep(hi - lo, h < 230 ? 4 : 5)
    const yTicks: number[] = []
    for (let v = Math.ceil(lo / yStep) * yStep; v <= hi + 1e-9 && yTicks.length < 20; v += yStep) yTicks.push(v)
    const xStep = xStepIn ?? niceStep(span, w < 480 ? 3 : 7)

    const pw = w - m.l - m.r, ph = h - m.t - m.b
    const x = (t: number) => m.l + ((t - t0) / span) * pw
    const y = (v: number) => m.t + (1 - (v - lo) / (hi - lo)) * ph
    const tAt = (px: number) => t0 + ((px - m.l) / pw) * span
    const xTicks: number[] = []
    for (let s = Math.ceil((t0 - ref) / xStep) * xStep; s <= t1 - ref + 1e-9 && xTicks.length < 30; s += xStep) xTicks.push(s)

    const clipId = 'chart-clip-' + useId().replace(/:/g, '')
    const sc: ChartScale = { x, y, m, pw, ph, t0, t1, lo, hi }
    const interactive = hover || !!onSelectRange

    const localX = (e: React.PointerEvent) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
        return Math.min(m.l + pw, Math.max(m.l, e.clientX - r.left))
    }
    const hoverT = hx != null ? tAt(hx) : null
    const readout = hover && hoverT != null ? series.map(s => {
        const i = nearest(s.pts, hoverT)
        const p = i >= 0 ? s.pts[i] : null
        return p && Math.abs(p.t - hoverT) <= Math.max(span / 50, gapS) ? { s, p } : { s, p: null }
    }) : null

    return (
        <div ref={wrapRef} style={{ position: 'relative', width: '100%', minWidth: 0 }}>
            <svg width={w} height={h} role="img" aria-label={label}
                style={{ display: 'block', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums', touchAction: onSelectRange ? 'pan-y' : undefined, cursor: onSelectRange ? 'crosshair' : undefined }}
                onPointerMove={interactive ? e => {
                    const px = localX(e)
                    if (hover) setHx(px)
                    if (sel) setSel({ ...sel, b: px })
                } : undefined}
                onPointerLeave={interactive ? () => { setHx(null); setSel(null) } : undefined}
                onPointerDown={onSelectRange ? e => { const px = localX(e); setSel({ a: px, b: px }) } : undefined}
                onPointerUp={onSelectRange ? () => {
                    if (sel && Math.abs(sel.b - sel.a) > 8) {
                        const a = tAt(Math.min(sel.a, sel.b)), b = tAt(Math.max(sel.a, sel.b))
                        onSelectRange(a, b)
                    }
                    setSel(null)
                } : undefined}>
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
                        <line x1={x(s + ref)} x2={x(s + ref)} y1={m.t} y2={m.t + ph} stroke={T.border} strokeWidth={1} strokeDasharray="2 4" />
                        <text x={x(s + ref)} y={h - 8} textAnchor="middle" fontSize={12} fill={T.muted}>{fmtTick(s, xStep)}{s === xTicks[xTicks.length - 1] ? ' ' + xUnit : ''}</text>
                    </g>
                ))}
                <g clipPath={`url(#${clipId})`}>
                    {under?.(sc)}
                    {series.map(s => (
                        <path key={s.id} d={path(s.pts, t0, t1, gapS, x, y)} fill="none" stroke={s.color} strokeWidth={s.width ?? 2}
                            strokeDasharray={s.dash} strokeLinejoin="round" strokeLinecap="round" />
                    ))}
                    {sel && (
                        <rect x={Math.min(sel.a, sel.b)} width={Math.abs(sel.b - sel.a)} y={m.t} height={ph}
                            fill="color-mix(in srgb, var(--app-accent) 14%, transparent)" stroke="var(--app-accent)" strokeWidth={1} />
                    )}
                    {readout && hx != null && (
                        <>
                            <line x1={hx} x2={hx} y1={m.t} y2={m.t + ph} stroke={T.borderStrong} strokeWidth={1} />
                            {readout.map(r => r.p && <circle key={r.s.id} cx={x(r.p.t)} cy={y(r.p.v)} r={3.5} fill={r.s.color} stroke={T.surface} strokeWidth={1.5} />)}
                        </>
                    )}
                </g>
            </svg>
            {readout && hx != null && hoverT != null && readout.some(r => r.p) && (
                <div role="status" style={{
                    position: 'absolute', top: m.t + 6, pointerEvents: 'none', zIndex: 2,
                    ...(hx > m.l + pw / 2 ? { right: w - hx + 10 } : { left: hx + 10 }),
                    background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: '6px 10px',
                    boxShadow: '0 4px 14px rgba(0,0,0,0.12)', fontSize: 12, lineHeight: 1.5, color: T.text, maxWidth: 260,
                    fontVariantNumeric: 'tabular-nums',
                }}>
                    <div style={{ color: T.muted, fontWeight: 600 }}>{fmtTick(hoverT - ref, xStep / 10)} {xUnit}</div>
                    {readout.map(r => r.p && (
                        <div key={r.s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: r.s.color, flexShrink: 0 }} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{r.s.label ?? r.s.id}</span>
                            <b style={{ marginLeft: 8 }}>{fmtValue(r.p.v)}</b>
                        </div>
                    ))}
                </div>
            )}
            {overlay && (
                <div style={{ position: 'absolute', left: m.l, top: m.t, width: pw, height: ph, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, boxSizing: 'border-box' }}>
                    {overlay}
                </div>
            )}
        </div>
    )
}

/** Up to six distinguishable line colours from the theme. */
export const SERIES_COLORS = [
    'var(--app-accent)', 'var(--app-warn)', 'hsl(265 60% 62%)', 'hsl(330 62% 58%)',
    'hsl(215 70% 58%)', 'hsl(85 45% 45%)',
]
