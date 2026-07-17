'use client'

// /admin — quick observer view of live client sessions (no credentials for
// now; the socket still needs the normal app token). Lists connected clients
// and can mirror one session's video (low-rate JPEG snapshots from the
// server's vision pipeline) and drone telemetry.
//
// Open this in its OWN tab: it marks its socket session as admin on the
// backend so it doesn't count as a client.

import { useCallback, useEffect, useRef, useState } from 'react'
import { connectSocket, getSocket } from '@/lib/socket'
import { getServerUrl } from '@/lib/server-url'

type SessionInfo = {
    session_id: string
    mode: string
    is_streaming: boolean
    telemetry_connected: boolean
    drone_address: string
}

type Telem = {
    attitude: { roll_deg: number; pitch_deg: number; yaw_deg: number }
    position: { latitude_deg: number; longitude_deg: number; relative_altitude_m: number }
    battery: { voltage_v: number; remaining_percent: number }
    gps: { fix_type: number; satellites_visible: number }
    flight_mode: { mode: string; is_armed: boolean; is_in_air: boolean }
    groundspeed_m_s: number
    heading_deg: number
    home_distance_m: number
}

export default function AdminPage() {
    const [sessions, setSessions] = useState<SessionInfo[]>([])
    const [watching, setWatching] = useState<string | null>(null)
    const [telem, setTelem] = useState<Telem | null>(null)
    const [frameUrl, setFrameUrl] = useState<string | null>(null)
    const watchingRef = useRef<string | null>(null)
    const frameUrlRef = useRef<string | null>(null)

    // Socket: announce as admin, subscribe to mirrors
    useEffect(() => {
        const socket = getSocket()
        const hello = () => socket.emit('admin_hello', {})
        socket.on('connect', hello)
        if (socket.connected) hello()
        else connectSocket()

        const onTelem = (d: { session_id: string; data: Telem }) => {
            if (d.session_id === watchingRef.current) setTelem(d.data)
        }
        const onFrame = (d: { session_id: string; jpeg: ArrayBuffer }) => {
            if (d.session_id !== watchingRef.current) return
            const url = URL.createObjectURL(new Blob([d.jpeg], { type: 'image/jpeg' }))
            if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current)
            frameUrlRef.current = url
            setFrameUrl(url)
        }
        socket.on('admin_telemetry', onTelem)
        socket.on('admin_frame', onFrame)

        return () => {
            socket.off('connect', hello)
            socket.off('admin_telemetry', onTelem)
            socket.off('admin_frame', onFrame)
            if (watchingRef.current) {
                socket.emit('unwatch_session', { session_id: watchingRef.current })
            }
            if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current)
        }
    }, [])

    // Session list: poll every 2s
    useEffect(() => {
        let alive = true
        const poll = async () => {
            try {
                const res = await fetch(`${getServerUrl()}/api/sessions`)
                const data = await res.json()
                if (alive) setSessions(data.sessions ?? [])
            } catch { /* backend down — keep last list */ }
        }
        void poll()
        const id = setInterval(poll, 2000)
        return () => { alive = false; clearInterval(id) }
    }, [])

    const view = useCallback((sessionId: string) => {
        const socket = getSocket()
        if (watchingRef.current === sessionId) {
            socket.emit('unwatch_session', { session_id: sessionId })
            watchingRef.current = null
            setWatching(null)
        } else {
            if (watchingRef.current) {
                socket.emit('unwatch_session', { session_id: watchingRef.current })
            }
            socket.emit('watch_session', { session_id: sessionId })
            watchingRef.current = sessionId
            setWatching(sessionId)
        }
        setTelem(null)
        if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current)
        frameUrlRef.current = null
        setFrameUrl(null)
    }, [])

    const watched = sessions.find(s => s.session_id === watching)

    return (
        <div className="min-h-screen bg-zinc-950 text-zinc-200 font-mono p-6">
            <div className="max-w-5xl mx-auto space-y-6">
                <div className="flex items-baseline gap-3">
                    <h1 className="text-lg text-zinc-100">ADMIN — LIVE SESSIONS</h1>
                    <span className="text-sm text-zinc-500">
                        {sessions.length} client{sessions.length === 1 ? '' : 's'} connected
                    </span>
                </div>

                {/* Session list */}
                <div className="space-y-2">
                    {sessions.length === 0 && (
                        <div className="text-xs text-zinc-600 border border-zinc-800 rounded p-4">
                            No clients connected. This page doesn&apos;t count as one.
                        </div>
                    )}
                    {sessions.map(s => (
                        <div
                            key={s.session_id}
                            className="flex items-center gap-4 border border-zinc-800 rounded p-3 text-xs"
                        >
                            <span className="text-zinc-400">{s.session_id.slice(0, 8)}</span>
                            <span className="text-zinc-500">{s.mode}</span>
                            <Badge on={s.is_streaming} label="VIDEO" />
                            <Badge on={s.telemetry_connected} label="TELEM" />
                            {s.drone_address && (
                                <span className="text-zinc-600 truncate max-w-[200px]">{s.drone_address}</span>
                            )}
                            <button
                                onClick={() => view(s.session_id)}
                                className={
                                    'ml-auto px-3 py-1 rounded border text-xs transition-colors ' +
                                    (watching === s.session_id
                                        ? 'border-emerald-600 text-emerald-400'
                                        : 'border-zinc-700 text-zinc-300 hover:border-zinc-500')
                                }
                            >
                                {watching === s.session_id ? 'VIEWING — STOP' : 'VIEW'}
                            </button>
                        </div>
                    ))}
                </div>

                {/* Viewer */}
                {watching && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        <div className="border border-zinc-800 rounded overflow-hidden">
                            <div className="px-3 py-2 text-xs text-zinc-500 border-b border-zinc-800">
                                VIDEO — {watching.slice(0, 8)}
                            </div>
                            {frameUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={frameUrl} alt="session video" className="w-full" />
                            ) : (
                                <div className="aspect-video flex items-center justify-center text-xs text-zinc-600">
                                    {watched?.is_streaming
                                        ? 'Waiting for frames…'
                                        : 'Client is not streaming video'}
                                </div>
                            )}
                        </div>

                        <div className="border border-zinc-800 rounded">
                            <div className="px-3 py-2 text-xs text-zinc-500 border-b border-zinc-800">
                                FLIGHT DATA
                            </div>
                            {telem ? (
                                <div className="grid grid-cols-2 gap-x-4 gap-y-2 p-3 text-xs">
                                    <Stat k="MODE" v={telem.flight_mode.mode} />
                                    <Stat k="ARMED" v={telem.flight_mode.is_armed ? 'YES' : 'NO'}
                                        accent={telem.flight_mode.is_armed} />
                                    <Stat k="IN AIR" v={telem.flight_mode.is_in_air ? 'YES' : 'NO'} />
                                    <Stat k="BATTERY" v={`${telem.battery.remaining_percent.toFixed(0)}% (${telem.battery.voltage_v.toFixed(1)}V)`} />
                                    <Stat k="REL ALT" v={`${telem.position.relative_altitude_m.toFixed(1)} m`} />
                                    <Stat k="GND SPEED" v={`${telem.groundspeed_m_s.toFixed(1)} m/s`} />
                                    <Stat k="HEADING" v={`${telem.heading_deg.toFixed(0)}°`} />
                                    <Stat k="HOME DIST" v={`${telem.home_distance_m.toFixed(0)} m`} />
                                    <Stat k="LAT" v={telem.position.latitude_deg.toFixed(6)} />
                                    <Stat k="LNG" v={telem.position.longitude_deg.toFixed(6)} />
                                    <Stat k="SATS" v={`${telem.gps.satellites_visible} (fix ${telem.gps.fix_type})`} />
                                    <Stat k="ROLL/PITCH" v={`${telem.attitude.roll_deg.toFixed(0)}° / ${telem.attitude.pitch_deg.toFixed(0)}°`} />
                                </div>
                            ) : (
                                <div className="p-4 text-xs text-zinc-600">
                                    {watched?.telemetry_connected
                                        ? 'Waiting for telemetry…'
                                        : 'Client has no telemetry connected'}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}

function Badge({ on, label }: { on: boolean; label: string }) {
    return (
        <span className={on ? 'text-emerald-400' : 'text-zinc-700'}>
            ● {label}
        </span>
    )
}

function Stat({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
    return (
        <div className="flex justify-between gap-2 border-b border-zinc-900 pb-1">
            <span className="text-zinc-600">{k}</span>
            <span className={accent ? 'text-emerald-400' : 'text-zinc-200'}>{v}</span>
        </div>
    )
}
