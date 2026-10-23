// Step response numbers for Config > Tuning's "Capture step": find the most
// recent large setpoint change and measure how the aircraft followed it.
// Heuristic by design: stick flicks are not perfect steps, so the target is
// the setpoint's own settled level after the change, not its peak.

import type { Pt } from '@/lib/tuningStream'

export interface StepResult {
    t0: number          // when the setpoint started to move
    tEnd: number        // end of the analysed window
    before: number      // setpoint level before the change
    after: number       // setpoint level it settled at
    overshootPct: number
    riseS: number | null    // 10 % to 90 % of the step, null if it never got to 90 %
    settleS: number | null  // from t0 until it stays within the band, null if it never settled
    bandPct: number
}

const JUMP_DT = 0.2       // a step is this much setpoint change within this many seconds
const MIN_HOLD_S = 0.6    // the new level must be held this long to be analysed
const MAX_WIN_S = 3
const BAND = 0.05

/** Index of the last point at or before t (binary search), or -1. */
function atOrBefore(pts: Pt[], t: number): number {
    let lo = 0, hi = pts.length - 1, ans = -1
    while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (pts[mid].t <= t) { ans = mid; lo = mid + 1 } else hi = mid - 1
    }
    return ans
}

function median(vs: number[]): number {
    const s = [...vs].sort((a, b) => a - b)
    const m = s.length >> 1
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Start times of setpoint jumps of at least `thr`, newest first. */
export function findJumps(sp: Pt[], thr: number, max = 4): number[] {
    const out: number[] = []
    let i = sp.length - 1
    while (i > 0 && out.length < max) {
        const j = atOrBefore(sp, sp[i].t - JUMP_DT)
        if (j < 0) break
        const d = sp[i].v - sp[j].v
        if (Math.abs(d) >= thr) {
            // The change began at the first sample past 10 % of it.
            let k = j + 1
            while (k < i && Math.abs(sp[k].v - sp[j].v) < 0.1 * Math.abs(d)) k++
            const t0 = sp[Math.max(j, k - 1)].t
            out.push(t0)
            const back = atOrBefore(sp, t0 - JUMP_DT)
            if (back < 0) break
            i = back
        } else {
            i--
        }
    }
    return out
}

export function analyzeStep(sp: Pt[], meas: Pt[], thr: number): StepResult | null {
    if (sp.length < 4 || meas.length < 4) return null
    const lastT = Math.min(sp[sp.length - 1].t, meas[meas.length - 1].t)
    const jumps = findJumps(sp, thr)
    for (let n = 0; n < jumps.length; n++) {
        const t0 = jumps[n]
        const next = n > 0 ? jumps[n - 1] : Infinity
        const tEnd = Math.min(t0 + MAX_WIN_S, next, lastT)
        if (tEnd - t0 < MIN_HOLD_S) continue
        const b = atOrBefore(sp, t0)
        if (b < 0) continue
        const before = sp[b].v
        // Settled level: the setpoint over the second half of the window.
        const tail = sp.filter(p => p.t >= t0 + (tEnd - t0) / 2 && p.t <= tEnd).map(p => p.v)
        if (tail.length < 2) continue
        const after = median(tail)
        const A = after - before
        if (Math.abs(A) < 0.6 * thr) continue
        const win = meas.filter(p => p.t >= t0 && p.t <= tEnd)
        if (win.length < 4) continue
        const sign = Math.sign(A)
        let t10: number | null = null, t90: number | null = null, peak = 0
        for (const p of win) {
            const frac = (p.v - before) / A
            if (t10 == null && frac >= 0.1) t10 = p.t
            if (t90 == null && frac >= 0.9) t90 = p.t
            peak = Math.max(peak, (p.v - after) * sign)
        }
        const band = BAND * Math.abs(A)
        let lastOut = t0
        for (const p of win) if (Math.abs(p.v - after) > band) lastOut = p.t
        const settled = lastOut < tEnd - 0.1
        return {
            t0, tEnd, before, after,
            overshootPct: Math.round((peak / Math.abs(A)) * 1000) / 10,
            riseS: t10 != null && t90 != null ? Math.max(0, t90 - t10) : null,
            settleS: settled ? lastOut - t0 : null,
            bandPct: BAND * 100,
        }
    }
    return null
}
