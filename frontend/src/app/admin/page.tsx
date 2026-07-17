'use client'

// /admin — operations view (no credentials for now; the socket still needs
// the normal app token).
//
// LIVE SESSIONS  — connected clients; a session is one browser + one drone.
// DRONE REGISTRY — every drone the platform has ever seen, keyed by the
//                  flight controller's hardware UID. The same physical drone
//                  connecting from any PC maps back to the same row here.
//
// Open this in its OWN tab: it marks its socket session as admin on the
// backend so it doesn't count as a client.

import { useCallback, useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { connectSocket, getSocket } from '@/lib/socket'
import { getServerUrl } from '@/lib/server-url'

const TOKEN = process.env.NEXT_PUBLIC_SECRET_TOKEN || 'change_this_to_a_random_string'

type DroneRecord = {
    id: string
    hardware_uid: string
    name: string
    is_simulated: boolean
    first_seen: string | null
    last_seen: string | null
}

type SessionInfo = {
    session_id: string
    mode: string
    is_streaming: boolean
    telemetry_connected: boolean
    drone_address: string
    hardware_uid: string | null
    drone: DroneRecord | null
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
    const [drones, setDrones] = useState<DroneRecord[]>([])
    const [watching, setWatching] = useState<string | null>(null)
    const [telem, setTelem] = useState<Telem | null>(null)
    const [frameUrl, setFrameUrl] = useState<string | null>(null)
    const [copiedUid, setCopiedUid] = useState<string | null>(null)
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

    // Sessions + registry: poll every 2s
    useEffect(() => {
        let alive = true
        const poll = async () => {
            try {
                const [sRes, dRes] = await Promise.all([
                    fetch(`${getServerUrl()}/api/sessions`),
                    fetch(`${getServerUrl()}/api/drones`),
                ])
                const sData = await sRes.json()
                const dData = await dRes.json()
                if (alive) {
                    setSessions(sData.sessions ?? [])
                    setDrones(dData.drones ?? [])
                }
            } catch { /* backend down — keep last data */ }
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

    const copyUid = useCallback((uid: string) => {
        void navigator.clipboard?.writeText(uid)
        setCopiedUid(uid)
        setTimeout(() => setCopiedUid(c => (c === uid ? null : c)), 1200)
    }, [])

    const renameDrone = useCallback(async (d: DroneRecord) => {
        const name = window.prompt(`Rename ${d.name}`, d.name)?.trim()
        if (!name || name === d.name) return
        try {
            await fetch(`${getServerUrl()}/api/drones/${d.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'X-Auth-Token': TOKEN },
                body: JSON.stringify({ name }),
            })
        } catch { /* next poll shows the truth either way */ }
    }, [])

    const watched = sessions.find(s => s.session_id === watching)
    const onlineUids = new Set(
        sessions.filter(s => s.hardware_uid).map(s => s.hardware_uid as string)
    )

    return (
        <div className="min-h-screen bg-zinc-950 text-zinc-200 font-mono p-6">
            <div className="max-w-5xl mx-auto space-y-8">
                <div className="flex items-center gap-3">
                    <Image src="/brand/icon.png" alt="HYRAK" width={26} height={26} />
                    <h1 className="text-lg tracking-widest text-zinc-100">HYRAK OPS</h1>
                    <span className="text-sm text-zinc-500">
                        {sessions.length} client{sessions.length === 1 ? '' : 's'} live
                    </span>
                </div>

                {/* ── Live sessions ─────────────────────────────────────── */}
                <section className="space-y-2">
                    <h2 className="text-xs tracking-widest text-zinc-500">LIVE SESSIONS</h2>
                    {sessions.length === 0 && (
                        <div className="text-xs text-zinc-600 border border-zinc-800 rounded p-4">
                            No clients connected. This page doesn&apos;t count as one.
                        </div>
                    )}
                    {sessions.map(s => (
                        <div
                            key={s.session_id}
                            className="border border-zinc-800 rounded p-3 space-y-2"
                        >
                            <div className="flex items-center gap-3 text-xs">
                                <span className="text-sm font-semibold text-zinc-100">
                                    {s.drone?.name ??
                                        (s.telemetry_connected ? 'IDENTIFYING…' : 'NO DRONE')}
                                </span>
                                {s.drone?.is_simulated && <Tag label="SIM" tone="amber" />}
                                <Badge on={s.is_streaming} label="VIDEO" />
                                <Badge on={s.telemetry_connected} label="TELEM" />
                                <span className="text-zinc-600">{s.mode}</span>
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
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-zinc-500">
                                {s.hardware_uid && (
                                    <Uid uid={s.hardware_uid} copied={copiedUid === s.hardware_uid}
                                        onCopy={copyUid} />
                                )}
                                <span className="text-zinc-600">
                                    session {s.session_id.slice(0, 8)}
                                </span>
                                {s.drone_address && (
                                    <span className="text-zinc-700 truncate max-w-[220px]">
                                        {s.drone_address}
                                    </span>
                                )}
                            </div>
                        </div>
                    ))}
                </section>

                {/* ── Viewer ────────────────────────────────────────────── */}
                {watching && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        <div className="border border-zinc-800 rounded overflow-hidden">
                            <div className="px-3 py-2 text-xs text-zinc-500 border-b border-zinc-800">
                                VIDEO — {watched?.drone?.name ?? watching.slice(0, 8)}
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

                {/* ── Drone registry ────────────────────────────────────── */}
                <section className="space-y-2">
                    <h2 className="text-xs tracking-widest text-zinc-500">
                        DRONE REGISTRY
                        <span className="ml-2 text-zinc-700">
                            {drones.length} known · same UID = same drone, from any PC
                        </span>
                    </h2>
                    {drones.length === 0 && (
                        <div className="text-xs text-zinc-600 border border-zinc-800 rounded p-4">
                            No drones registered yet — connect telemetry once and the FC&apos;s
                            hardware UID gets stored here permanently.
                        </div>
                    )}
                    {drones.map(d => {
                        const online = onlineUids.has(d.hardware_uid)
                        return (
                            <div
                                key={d.id}
                                className="border border-zinc-800 rounded p-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs"
                            >
                                <span className={online ? 'text-emerald-400' : 'text-zinc-700'}>●</span>
                                <span className="text-sm font-semibold text-zinc-100">{d.name}</span>
                                {d.is_simulated && <Tag label="SIM" tone="amber" />}
                                {online && <Tag label="ONLINE" tone="emerald" />}
                                <Uid uid={d.hardware_uid} copied={copiedUid === d.hardware_uid}
                                    onCopy={copyUid} />
                                <span className="text-[10px] text-zinc-600">
                                    last seen {fmtDate(d.last_seen)}
                                </span>
                                <button
                                    onClick={() => renameDrone(d)}
                                    className="ml-auto px-2 py-1 rounded border border-zinc-700 text-[10px] text-zinc-400 hover:border-zinc-500"
                                    title="Rename drone"
                                >
                                    RENAME
                                </button>
                            </div>
                        )
                    })}
                </section>
            </div>
        </div>
    )
}

function fmtDate(iso: string | null): string {
    if (!iso) return '—'
    const d = new Date(iso)
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

function Uid({ uid, copied, onCopy }: { uid: string; copied: boolean; onCopy: (u: string) => void }) {
    return (
        <button
            onClick={() => onCopy(uid)}
            title="Click to copy full UID"
            className="text-[10px] tracking-wide text-cyan-600/80 hover:text-cyan-400 transition-colors"
        >
            {copied ? 'COPIED ✓' : `UID ${uid}`}
        </button>
    )
}

function Tag({ label, tone }: { label: string; tone: 'amber' | 'emerald' }) {
    const cls = tone === 'amber'
        ? 'text-amber-500/80 border-amber-500/30'
        : 'text-emerald-400 border-emerald-500/30'
    return <span className={`border rounded px-1 text-[10px] ${cls}`}>{label}</span>
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
