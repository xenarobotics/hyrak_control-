// Settling for the AI results panels.
//
// The panels bind straight to `cvResults`, which lands at the analyzer's rate
// (~12Hz). Every tile therefore re-renders twelve times a second: the
// inference figure flickers through 11/19/14ms, counts oscillate as detections
// cross the confidence threshold, and rows in the object list pop in and out
// as they appear and vanish between frames.
//
// None of that is information a person can read at that rate. It is the same
// mistake as the overlay canvas — presenting a sampled signal at its sampling
// rate — and it makes an otherwise-working system feel unstable.
//
// The rule applied here: numbers that a human READS settle; numbers that a
// human WATCHES stay live. So counts and timings ease and hold, while the
// overlay itself keeps its full frame rate.

import { useEffect, useRef, useState } from 'react'

/** Re-publishes `value` at most every `ms`. The final value always lands —
 *  a trailing edge, so the panel never settles on a stale reading. */
export function useThrottled<T>(value: T, ms = 320): T {
    const [shown, setShown] = useState(value)
    const last = useRef(0)
    const pending = useRef<T>(value)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => {
        pending.current = value
        const now = Date.now()
        const wait = Math.max(0, ms - (now - last.current))
        if (wait === 0) {
            last.current = now
            setShown(value)
            return
        }
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
            last.current = Date.now()
            setShown(pending.current)
        }, wait)
        return () => { if (timer.current) clearTimeout(timer.current) }
    }, [value, ms])

    return shown
}

/** Eases a number toward its target so it counts rather than jumps.
 *  `settle` rounds the output, so a stat tile shows integers. */
export function useEasedNumber(value: number, tau = 260, settle = true): number {
    const [shown, setShown] = useState(value)
    const target = useRef(value)
    const current = useRef(value)

    useEffect(() => { target.current = value }, [value])

    useEffect(() => {
        let raf = 0
        let prev = performance.now()
        const tick = (now: number) => {
            raf = requestAnimationFrame(tick)
            const dt = Math.min(now - prev, 200)
            prev = now
            const k = 1 - Math.exp(-dt / tau)
            current.current += (target.current - current.current) * k
            // Snap once close enough, otherwise it creeps forever and the
            // component re-renders every frame for no visible change.
            if (Math.abs(target.current - current.current) < 0.01) {
                current.current = target.current
            }
            const out = settle ? Math.round(current.current) : current.current
            setShown(prev2 => (prev2 === out ? prev2 : out))
        }
        raf = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(raf)
    }, [tau, settle])

    return shown
}

export interface StableRow { name: string; count: number }

/** Turns `{name: count}` into a list whose MEMBERSHIP is stable.
 *
 *  A row that disappears from the payload is kept (greyed by the caller via
 *  `stale`) for `holdMs` before being removed, so a detection blinking on the
 *  confidence threshold does not make the list jump. Ordering is by count, but
 *  a row only changes position once its count has actually settled — otherwise
 *  rows swap places several times a second and the list is unreadable. */
export function useStableCounts(
    counts: Record<string, number> | undefined,
    holdMs = 900,
): (StableRow & { stale: boolean })[] {
    const seen = useRef(new Map<string, { count: number; lastSeen: number }>())
    const [rows, setRows] = useState<(StableRow & { stale: boolean })[]>([])

    useEffect(() => {
        const now = Date.now()
        for (const [name, count] of Object.entries(counts ?? {})) {
            seen.current.set(name, { count, lastSeen: now })
        }
        for (const [name, v] of seen.current) {
            if (now - v.lastSeen > holdMs) seen.current.delete(name)
        }
        setRows(
            [...seen.current.entries()]
                .map(([name, v]) => ({
                    name, count: v.count, stale: v.lastSeen !== now,
                }))
                .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
        )
    }, [counts, holdMs])

    // Sweep even when no payload arrives, so a stopped stream still drains.
    useEffect(() => {
        const id = setInterval(() => {
            const now = Date.now()
            let changed = false
            for (const [name, v] of seen.current) {
                if (now - v.lastSeen > holdMs) { seen.current.delete(name); changed = true }
            }
            if (changed) {
                setRows([...seen.current.entries()]
                    .map(([name, v]) => ({ name, count: v.count, stale: true }))
                    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)))
            }
        }, holdMs)
        return () => clearInterval(id)
    }, [holdMs])

    return rows
}

/** Same idea as useStableCounts, for lists that carry their own identity
 *  (tracker persons, plates). A row survives `holdMs` past its last sighting
 *  so the list does not reflow every time the detector blinks — which on a
 *  selectable list also means the row you are reaching for stays put. */
export function useStableById<T extends { id: number | string }>(
    items: T[] | undefined,
    holdMs = 900,
): (T & { stale: boolean })[] {
    const seen = useRef(new Map<string, { item: T; lastSeen: number }>())
    const [rows, setRows] = useState<(T & { stale: boolean })[]>([])

    useEffect(() => {
        const now = Date.now()
        for (const item of items ?? []) {
            seen.current.set(String(item.id), { item, lastSeen: now })
        }
        const out: (T & { stale: boolean })[] = []
        for (const [key, v] of [...seen.current.entries()]) {
            if (now - v.lastSeen > holdMs) { seen.current.delete(key); continue }
            out.push({ ...v.item, stale: v.lastSeen !== now })
        }
        setRows(out)
    }, [items, holdMs])

    return rows
}

/** Rolling median — for timings, where the occasional 3x outlier is noise
 *  rather than signal and a mean would drag the display around with it. */
export function useMedian(value: number, window = 12): number {
    const buf = useRef<number[]>([])
    const [shown, setShown] = useState(value)

    useEffect(() => {
        if (!Number.isFinite(value)) return
        buf.current.push(value)
        if (buf.current.length > window) buf.current.shift()
        const sorted = [...buf.current].sort((a, b) => a - b)
        setShown(sorted[Math.floor(sorted.length / 2)])
    }, [value, window])

    return shown
}
