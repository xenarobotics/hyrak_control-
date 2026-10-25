'use client'

// Setpoint against measured response, on the shared SVG line chart
// (components/config/analyze/LineChart.tsx), with the step capture's
// settling band and markers drawn underneath.

import React from 'react'
import { mix, T } from '@/components/config/kit'
import { LineChart } from '@/components/config/analyze/LineChart'
import type { Pt } from '@/lib/tuningStream'
import type { StepResult } from './stepAnalysis'

export const SP_COLOR = 'var(--app-warn)'
export const MEAS_COLOR = 'var(--app-accent)'

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
    const band = step ? Math.abs(step.after - step.before) * step.bandPct / 100 : 0
    return (
        <LineChart label={label} t1={t1} span={span} minRange={minRange} tRef={tRef} height={height} overlay={overlay}
            xStep={span <= 5 ? 1 : span <= 10 ? 2 : 5}
            extent={step ? [step.before, step.after] : undefined}
            series={[
                { id: 'sp', pts: sp, color: SP_COLOR, dash: '7 4' },
                { id: 'meas', pts: meas, color: MEAS_COLOR },
            ]}
            under={step ? ({ x, y, m, ph }) => (
                <>
                    <rect x={x(step.t0)} width={Math.max(0, x(step.tEnd) - x(step.t0))} y={y(step.after + band)} height={Math.max(1, y(step.after - band) - y(step.after + band))}
                        fill={mix('var(--app-ok)', 14)} />
                    <line x1={x(step.t0)} x2={x(step.t0)} y1={m.t} y2={m.t + ph} stroke={T.muted} strokeWidth={1} strokeDasharray="4 3" />
                    {step.settleS != null && (
                        <line x1={x(step.t0 + step.settleS)} x2={x(step.t0 + step.settleS)} y1={m.t} y2={m.t + ph} stroke="var(--app-ok)" strokeWidth={1.5} strokeDasharray="4 3" />
                    )}
                </>
            ) : undefined}
        />
    )
}
