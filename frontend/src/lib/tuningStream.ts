'use client'

// Setpoint vs response samples for Config > Tuning's live chart, off the
// session's OWN link (backend app/events/tuning_events.py). While the chart
// is open the backend raises the selected loop's MAVLink stream rates
// (10 Hz on a radio, 50 Hz on USB / UDP) and puts them back when it closes.
//
// Like configLive, the request is a lease the page renews every few
// seconds, so a closed tab cannot leave the stream raised.
//
// Rows are kept in a plain buffer outside React state (up to 50 rows a
// second each way); the hook publishes a copy at most ~15 times a second so
// the chart redraws at a steady pace whatever the link rate.

import { useEffect, useState } from 'react'
import { getSocket } from '@/lib/socket'
import { useDroneStore } from '@/store/drone'

export type Loop = 'rate' | 'attitude' | 'velocity' | 'position'
export type Axis = 0 | 1 | 2

/** att / att_sp: [t, roll, pitch, yaw, rollrate, pitchrate, yawrate] (deg, deg/s)
 *  pos / pos_sp: [t, x, y, z, vx, vy, vz] (m, m/s, NED) */
type Row = (number | null)[]
type Key = 'att' | 'att_sp' | 'pos' | 'pos_sp'

export interface TuningStatus { loop: Loop; hz: number; link: 'radio' | 'local'; bytes_s: number }
interface Packet extends Partial<TuningStatus> { error?: string; att?: Row[]; att_sp?: Row[]; pos?: Row[]; pos_sp?: Row[] }

export const LOOP_KEYS: Record<Loop, [Key, Key]> = {
    rate: ['att', 'att_sp'], attitude: ['att', 'att_sp'],
    velocity: ['pos', 'pos_sp'], position: ['pos', 'pos_sp'],
}
/** Column of the row for each loop's three axes. */
const COL: Record<Loop, [number, number, number]> = {
    rate: [4, 5, 6], attitude: [1, 2, 3], velocity: [4, 5, 6], position: [1, 2, 3],
}

const KEEP_S = 60          // history kept for the 20 s window and a step capture
const RENEW_MS = 8000
const DRAW_MS = 66

export class TuningBuffer {
    rows: Record<Key, Row[]> = { att: [], att_sp: [], pos: [], pos_sp: [] }
    lastT = 0

    add(key: Key, rows: Row[]) {
        for (const r of rows) {
            const t = r[0]
            if (typeof t !== 'number') continue
            // The autopilot rebooted (its clock went backwards): start over.
            if (t < this.lastT - 2) this.clear()
            this.rows[key].push(r)
            if (t > this.lastT) this.lastT = t
        }
        const cut = this.lastT - KEEP_S
        const arr = this.rows[key]
        if (arr.length && (arr[0][0] as number) < cut) {
            let i = 0
            while (i < arr.length && (arr[i][0] as number) < cut) i++
            arr.splice(0, i)
        }
    }

    clear() {
        this.rows = { att: [], att_sp: [], pos: [], pos_sp: [] }
        this.lastT = 0
    }
}

export interface Pt { t: number; v: number }
export interface Series { sp: Pt[]; meas: Pt[]; now: number }

const wrap180 = (d: number) => ((d + 540) % 360) - 180

/** Measured and setpoint for one loop and axis, oldest first. Yaw angle is
 *  unwrapped so a turn through north does not draw a 360 degree cliff, and
 *  the setpoint is drawn on the same turn as the measured value. */
export interface Snapshot { rows: Record<Key, Row[]>; lastT: number }
const EMPTY: Snapshot = { rows: { att: [], att_sp: [], pos: [], pos_sp: [] }, lastT: 0 }

export function series(buf: Snapshot, loop: Loop, axis: Axis): Series {
    const [mk, sk] = LOOP_KEYS[loop]
    const col = COL[loop][axis]
    const pick = (rows: Row[]) => {
        const out: Pt[] = []
        for (const r of rows) {
            const v = r[col]
            if (typeof v === 'number' && Number.isFinite(v)) out.push({ t: r[0] as number, v })
        }
        return out
    }
    let meas = pick(buf.rows[mk])
    let sp = pick(buf.rows[sk])
    if (loop === 'attitude' && axis === 2) {
        let off = 0
        meas = meas.map((p, i) => {
            if (i > 0) {
                const prev = meas[i - 1].v + off
                off += 360 * Math.round((prev - (p.v + off)) / 360)
            }
            return { t: p.t, v: p.v + off }
        })
        let j = 0
        sp = sp.map(p => {
            while (j + 1 < meas.length && meas[j + 1].t <= p.t) j++
            const ref = meas[j]?.v
            return ref == null ? p : { t: p.t, v: ref + wrap180(p.v - ref) }
        })
    }
    return { sp, meas, now: buf.lastT }
}

function takeSnapshot(b: TuningBuffer): Snapshot {
    return { rows: { att: b.rows.att.slice(), att_sp: b.rows.att_sp.slice(), pos: b.rows.pos.slice(), pos_sp: b.rows.pos_sp.slice() }, lastT: b.lastT }
}

/** Live rows for `loop` while `enabled` and a vehicle is linked. */
export function useTuningStream(enabled: boolean, loop: Loop) {
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    // One mutable buffer for the hook's lifetime, and an immutable copy of it
    // taken on each redraw tick for rendering.
    const [buf] = useState(() => new TuningBuffer())
    const [snap, setSnap] = useState<Snapshot>(EMPTY)
    const [status, setStatus] = useState<TuningStatus | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [lastAt, setLastAt] = useState(0)
    const [stale, setStale] = useState(false)
    const on = enabled && connected

    useEffect(() => {
        if (!on) return
        const socket = getSocket()
        let dirty = false
        let at = 0
        const onData = (p: Packet) => {
            if (!p || typeof p !== 'object') return
            if (p.error) { setError(p.error); return }
            setError(null)
            if (p.loop && p.loop !== loop) return
            if (p.hz != null) setStatus(s => (s && s.hz === p.hz && s.loop === p.loop && s.bytes_s === p.bytes_s) ? s : { loop: p.loop as Loop, hz: p.hz as number, link: p.link as 'radio' | 'local', bytes_s: p.bytes_s ?? 0 })
            for (const k of ['att', 'att_sp', 'pos', 'pos_sp'] as Key[]) {
                const rows = p[k]
                if (Array.isArray(rows) && rows.length) { buf.add(k, rows); dirty = true; at = Date.now() }
            }
        }
        socket.on('tuning_data', onData)
        const ask = () => socket.emit('tuning_stream', { on: true, loop })
        ask()
        const renew = setInterval(ask, RENEW_MS)
        const draw = setInterval(() => {
            const st = at > 0 && Date.now() - at > 3000
            setStale(prev => (prev === st ? prev : st))
            if (!dirty) return
            dirty = false
            setLastAt(at)
            setSnap(takeSnapshot(buf))
        }, DRAW_MS)
        return () => {
            clearInterval(renew)
            clearInterval(draw)
            socket.off('tuning_data', onData)
            socket.emit('tuning_stream', { on: false })
            setStatus(null)
        }
    }, [on, loop, buf])

    const clear = () => { buf.clear(); setSnap(EMPTY) }
    return { snap, status, error, lastAt, stale, connected, clear }
}
