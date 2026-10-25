'use client'

// MAVLink Inspector feed for Config > Analyze, off the session's OWN link
// (backend app/events/inspector_events.py). Twice a second the backend sends
// every message it has seen (name, ids, count, rate), the fields of the
// messages this page has opened, and every sample of the plotted fields.
//
// Reading is passive. `fast` asks the backend to speed up the plotted
// messages (MAV_CMD_SET_MESSAGE_INTERVAL), which it does only for a session
// that may fly the drone and is not taken over, and puts back afterwards.
//
// Like the other Config feeds the request is a lease renewed every few
// seconds, so a closed tab cannot leave anything running.

import { useEffect, useMemo, useRef, useState } from 'react'
import { getSocket } from '@/lib/socket'
import { useDroneStore } from '@/store/drone'
import type { Pt } from '@/components/config/analyze/LineChart'

export type FieldValue = number | string | null | (number | string | null)[]

export interface InspMsg {
    key: string
    name: string
    sys: number
    comp: number
    n: number
    hz: number
    age: number
    fields?: Record<string, FieldValue>
}

export interface FastStatus { allowed: boolean; hz: number; raised: string[]; skipped: string[]; bytes_s: number }
export interface PlotRef { key: string; field: string }

interface Packet {
    error?: string
    t?: number
    msgs?: InspMsg[]
    plot?: Record<string, [number, number][]>
    fast?: FastStatus
    link?: 'radio' | 'local'
    dropped?: number
}

export const MAX_PLOT = 6
const RENEW_MS = 8000
const KEEP_S = 120

export const plotId = (p: PlotRef) => `${p.key}|${p.field}`

export function useInspectorStream(enabled: boolean, open: string[], plot: PlotRef[], fast: boolean) {
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const on = enabled && connected
    const [msgs, setMsgs] = useState<InspMsg[]>([])
    const [series, setSeries] = useState<Record<string, Pt[]>>({})
    const [now, setNow] = useState(0)
    const [fastStatus, setFastStatus] = useState<FastStatus | null>(null)
    const [link, setLink] = useState<'radio' | 'local' | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [at, setAt] = useState(0)
    const buf = useRef<Record<string, Pt[]>>({})
    const lastT = useRef(0)

    // The request, as one stable string so a new array with the same
    // content does not re-send.
    const req = useMemo(() => JSON.stringify({ open: open.slice(0, 12), plot: plot.slice(0, MAX_PLOT), fast }), [open, plot, fast])
    const reqRef = useRef(req)

    // Forget the last aircraft when the feed turns off (render-time).
    const [wasOn, setWasOn] = useState(on)
    if (wasOn !== on) {
        setWasOn(on)
        if (!on) { setMsgs([]); setSeries({}); setFastStatus(null); setAt(0) }
    }

    useEffect(() => {
        if (!on) return
        const socket = getSocket()
        const onData = (p: Packet) => {
            if (!p || typeof p !== 'object') return
            if (p.error) { setError(p.error); return }
            setError(null)
            if (typeof p.t === 'number') {
                // A new feed restarts its clock: start the plot over.
                if (p.t < lastT.current - 1) buf.current = {}
                lastT.current = p.t
                setNow(p.t)
            }
            if (Array.isArray(p.msgs)) setMsgs(p.msgs)
            if (p.fast) setFastStatus(p.fast)
            if (p.link) setLink(p.link)
            let changed = false
            for (const [id, rows] of Object.entries(p.plot ?? {})) {
                if (!Array.isArray(rows) || !rows.length) continue
                const arr = buf.current[id] ?? (buf.current[id] = [])
                for (const r of rows) if (typeof r?.[0] === 'number' && typeof r?.[1] === 'number') arr.push({ t: r[0], v: r[1] })
                changed = true
            }
            const cut = lastT.current - KEEP_S
            for (const arr of Object.values(buf.current)) {
                if (arr.length && arr[0].t < cut) {
                    let i = 0
                    while (i < arr.length && arr[i].t < cut) i++
                    arr.splice(0, i)
                }
            }
            if (changed) setSeries({ ...buf.current })
            setAt(Date.now())
        }
        socket.on('inspector_data', onData)
        const ask = () => socket.emit('inspector_stream', { on: true, ...JSON.parse(reqRef.current) })
        ask()
        const renew = setInterval(ask, RENEW_MS)
        return () => {
            clearInterval(renew)
            socket.off('inspector_data', onData)
            socket.emit('inspector_stream', { on: false })
        }
    }, [on])

    // A changed selection goes out at once, not at the next renewal.
    useEffect(() => {
        reqRef.current = req
        if (on) getSocket().emit('inspector_stream', { on: true, ...JSON.parse(req) })
    }, [req, on])

    // Unplotted fields drop out of the buffer.
    useEffect(() => {
        const keep = new Set(plot.map(plotId))
        let changed = false
        for (const id of Object.keys(buf.current)) if (!keep.has(id)) { delete buf.current[id]; changed = true }
        if (changed) setSeries({ ...buf.current })
    }, [plot])

    const clear = () => { buf.current = {}; setSeries({}) }
    return { msgs, series, now, fast: fastStatus, link, error, at, connected, clear }
}
