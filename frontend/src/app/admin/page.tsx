'use client'

// /admin — HYRAK operations console (no credentials for now; the socket
// still needs the normal app token).
//
// Left rail tabs:
//   OVERVIEW — live map of every connected drone + session list; clicking a
//              drone (marker or card) opens the right-side detail panel with
//              mirrored video + flight data.
//   DRONES   — persistent registry: every drone ever seen, keyed by the FC's
//              hardware UID. Same drone from any PC = same row.
//   ZONES / PERMITS — arrive with the geofencing phase.
//
// Open this in its OWN tab: it marks its socket session as admin on the
// backend so it doesn't count as a client.

import { useCallback, useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import dynamic from 'next/dynamic'
import { Map as MapIcon, Plane, Shield, FileCheck, X } from 'lucide-react'
import { connectSocket, getSocket } from '@/lib/socket'
import { getServerUrl } from '@/lib/server-url'
import type { MapDrone } from '@/components/admin/AdminMap'

const AdminMap = dynamic(() => import('@/components/admin/AdminMap'), { ssr: false })

const TOKEN = process.env.NEXT_PUBLIC_SECRET_TOKEN || 'change_this_to_a_random_string'

type DroneRecord = {
    id: string
    hardware_uid: string
    name: string
    is_simulated: boolean
    first_seen: string | null
    last_seen: string | null
}

type LiveState = {
    lat: number
    lng: number
    alt: number
    heading: number
    armed: boolean
    in_air: boolean
    mode: string
    battery: number
} | null

type SessionInfo = {
    session_id: string
    mode: string
    is_streaming: boolean
    telemetry_connected: boolean
    drone_address: string
    hardware_uid: string | null
    drone: DroneRecord | null
    live: LiveState
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

type Tab = 'overview' | 'drones' | 'zones' | 'permits'

const TABS: { key: Tab; label: string; icon: typeof MapIcon }[] = [
    { key: 'overview', label: 'MAP',     icon: MapIcon },
    { key: 'drones',   label: 'DRONES',  icon: Plane },
    { key: 'zones',    label: 'ZONES',   icon: Shield },
    { key: 'permits',  label: 'PERMITS', icon: FileCheck },
]

export default function AdminPage() {
    const [tab, setTab] = useState<Tab>('overview')
    const [sessions, setSessions] = useState<SessionInfo[]>([])
    const [drones, setDrones] = useState<DroneRecord[]>([])
    const [selected, setSelected] = useState<string | null>(null)
    const [telem, setTelem] = useState<Telem | null>(null)
    const [frameUrl, setFrameUrl] = useState<string | null>(null)
    const [copiedUid, setCopiedUid] = useState<string | null>(null)
    const selectedRef = useRef<string | null>(null)
    const frameUrlRef = useRef<string | null>(null)

    // Socket: announce as admin, subscribe to mirrors
    useEffect(() => {
        const socket = getSocket()
        const hello = () => socket.emit('admin_hello', {})
        socket.on('connect', hello)
        if (socket.connected) hello()
        else connectSocket()

        const onTelem = (d: { session_id: string; data: Telem }) => {
            if (d.session_id === selectedRef.current) setTelem(d.data)
        }
        const onFrame = (d: { session_id: string; jpeg: ArrayBuffer }) => {
            if (d.session_id !== selectedRef.current) return
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
            if (selectedRef.current) {
                socket.emit('unwatch_session', { session_id: selectedRef.current })
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

    // Drop the panel if the watched session disappears
    useEffect(() => {
        if (selected && !sessions.some(s => s.session_id === selected)) {
            selectedRef.current = null
            setSelected(null)
            setTelem(null)
        }
    }, [sessions, selected])

    const select = useCallback((sessionId: string | null) => {
        const socket = getSocket()
        if (selectedRef.current === sessionId) sessionId = null   // toggle off
        if (selectedRef.current) {
            socket.emit('unwatch_session', { session_id: selectedRef.current })
        }
        if (sessionId) {
            socket.emit('watch_session', { session_id: sessionId })
        }
        selectedRef.current = sessionId
        setSelected(sessionId)
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

    const watched = sessions.find(s => s.session_id === selected)
    const onlineUids = new Set(
        sessions.filter(s => s.hardware_uid).map(s => s.hardware_uid as string)
    )
    const mapDrones: MapDrone[] = sessions
        .filter(s => s.live && (s.live.lat !== 0 || s.live.lng !== 0))
        .map(s => ({
            session_id: s.session_id,
            name: s.drone?.name ?? s.session_id.slice(0, 8),
            lat: s.live!.lat,
            lng: s.live!.lng,
            heading: s.live!.heading,
            armed: s.live!.armed,
            in_air: s.live!.in_air,
            selected: s.session_id === selected,
        }))

    return (
        <div className="h-screen flex bg-zinc-950 text-zinc-200 font-mono overflow-hidden">
            {/* ── Left rail ────────────────────────────────────────────── */}
            <aside className="w-16 shrink-0 flex flex-col items-center py-4 gap-1 border-r border-zinc-800 bg-zinc-950 z-10">
                <div className="mb-5" title="HYRAK OPS">
                    <Image src="/brand/icon.png" alt="HYRAK" width={26} height={26} />
                </div>
                {TABS.map(({ key, label, icon: Icon }) => (
                    <button
                        key={key}
                        onClick={() => setTab(key)}
                        className={
                            'flex flex-col items-center gap-1 w-12 py-2 rounded text-[9px] transition-colors ' +
                            (tab === key
                                ? 'bg-cyan-500/10 text-cyan-400'
                                : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900')
                        }
                    >
                        <Icon size={17} />
                        {label}
                    </button>
                ))}
                <div className="mt-auto text-center text-[9px] text-zinc-600">
                    <div className={sessions.length > 0 ? 'text-emerald-400' : ''}>
                        ● {sessions.length}
                    </div>
                    LIVE
                </div>
            </aside>

            {/* ── Main area ────────────────────────────────────────────── */}
            <main className="flex-1 relative flex min-w-0">
                {tab === 'overview' && (
                    <>
                        <div className="flex-1 relative min-w-0">
                            <AdminMap drones={mapDrones} onSelect={select} />

                            {/* Session list overlay */}
                            <div className="absolute top-3 left-3 z-[1000] w-72 space-y-2 max-h-[calc(100%-1.5rem)] overflow-y-auto">
                                {sessions.length === 0 && (
                                    <div className="border border-zinc-800 bg-zinc-950/85 backdrop-blur rounded p-3 text-[10px] text-zinc-500">
                                        No clients connected. This page doesn&apos;t count as one.
                                    </div>
                                )}
                                {sessions.map(s => (
                                    <button
                                        key={s.session_id}
                                        onClick={() => select(s.session_id)}
                                        className={
                                            'w-full text-left border rounded p-2.5 bg-zinc-950/85 backdrop-blur transition-colors ' +
                                            (selected === s.session_id
                                                ? 'border-cyan-600'
                                                : 'border-zinc-800 hover:border-zinc-600')
                                        }
                                    >
                                        <div className="flex items-center gap-2 text-xs">
                                            <span className="font-semibold text-zinc-100 truncate">
                                                {s.drone?.name ??
                                                    (s.telemetry_connected ? 'IDENTIFYING…' : 'NO DRONE')}
                                            </span>
                                            {s.drone?.is_simulated && <Tag label="SIM" tone="amber" />}
                                            {s.live?.armed && <Tag label="ARMED" tone="red" />}
                                        </div>
                                        <div className="mt-1 flex items-center gap-3 text-[10px] text-zinc-500">
                                            <Badge on={s.is_streaming} label="VIDEO" />
                                            <Badge on={s.telemetry_connected} label="TELEM" />
                                            {s.live && (
                                                <span>
                                                    {s.live.mode} · {s.live.alt.toFixed(0)}m ·{' '}
                                                    {s.live.battery.toFixed(0)}%
                                                </span>
                                            )}
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Detail panel */}
                        {watched && (
                            <section className="w-96 shrink-0 border-l border-zinc-800 bg-zinc-950 overflow-y-auto">
                                <div className="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-800 sticky top-0 bg-zinc-950 z-10">
                                    <span className="text-sm font-semibold text-zinc-100 truncate">
                                        {watched.drone?.name ?? watched.session_id.slice(0, 8)}
                                    </span>
                                    {watched.drone?.is_simulated && <Tag label="SIM" tone="amber" />}
                                    {watched.live?.armed && <Tag label="ARMED" tone="red" />}
                                    <button
                                        onClick={() => select(null)}
                                        className="ml-auto text-zinc-500 hover:text-zinc-200"
                                        title="Close"
                                    >
                                        <X size={16} />
                                    </button>
                                </div>

                                {/* Video */}
                                <div className="border-b border-zinc-800">
                                    <div className="px-3 py-1.5 text-[10px] text-zinc-500">VIDEO</div>
                                    {frameUrl ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={frameUrl} alt="session video" className="w-full" />
                                    ) : (
                                        <div className="aspect-video flex items-center justify-center text-[10px] text-zinc-600">
                                            {watched.is_streaming
                                                ? 'Waiting for frames…'
                                                : 'Client is not streaming video'}
                                        </div>
                                    )}
                                </div>

                                {/* Flight data */}
                                <div className="border-b border-zinc-800 pb-2">
                                    <div className="px-3 py-1.5 text-[10px] text-zinc-500">FLIGHT DATA</div>
                                    {telem ? (
                                        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-3 text-xs">
                                            <Stat k="MODE" v={telem.flight_mode.mode} />
                                            <Stat k="ARMED" v={telem.flight_mode.is_armed ? 'YES' : 'NO'}
                                                accent={telem.flight_mode.is_armed} />
                                            <Stat k="IN AIR" v={telem.flight_mode.is_in_air ? 'YES' : 'NO'} />
                                            <Stat k="BATTERY" v={`${telem.battery.remaining_percent.toFixed(0)}% (${telem.battery.voltage_v.toFixed(1)}V)`} />
                                            <Stat k="REL ALT" v={`${telem.position.relative_altitude_m.toFixed(1)} m`} />
                                            <Stat k="GND SPD" v={`${telem.groundspeed_m_s.toFixed(1)} m/s`} />
                                            <Stat k="HEADING" v={`${telem.heading_deg.toFixed(0)}°`} />
                                            <Stat k="HOME" v={`${telem.home_distance_m.toFixed(0)} m`} />
                                            <Stat k="LAT" v={telem.position.latitude_deg.toFixed(6)} />
                                            <Stat k="LNG" v={telem.position.longitude_deg.toFixed(6)} />
                                            <Stat k="SATS" v={`${telem.gps.satellites_visible} (fix ${telem.gps.fix_type})`} />
                                            <Stat k="R/P" v={`${telem.attitude.roll_deg.toFixed(0)}° / ${telem.attitude.pitch_deg.toFixed(0)}°`} />
                                        </div>
                                    ) : (
                                        <div className="px-3 text-[10px] text-zinc-600">
                                            {watched.telemetry_connected
                                                ? 'Waiting for telemetry…'
                                                : 'No telemetry connected'}
                                        </div>
                                    )}
                                </div>

                                {/* Identity */}
                                <div className="px-3 py-2 space-y-1.5 text-[10px] text-zinc-500">
                                    <div className="text-zinc-500">IDENTITY</div>
                                    {watched.hardware_uid ? (
                                        <Uid uid={watched.hardware_uid}
                                            copied={copiedUid === watched.hardware_uid} onCopy={copyUid} />
                                    ) : (
                                        <div className="text-zinc-600">UID not resolved</div>
                                    )}
                                    <div className="text-zinc-600">session {watched.session_id}</div>
                                    {watched.drone_address && (
                                        <div className="text-zinc-700 break-all">{watched.drone_address}</div>
                                    )}
                                    {watched.drone && (
                                        <button
                                            onClick={() => renameDrone(watched.drone!)}
                                            className="mt-1 px-2 py-1 rounded border border-zinc-700 text-[10px] text-zinc-400 hover:border-zinc-500"
                                        >
                                            RENAME
                                        </button>
                                    )}
                                </div>
                            </section>
                        )}
                    </>
                )}

                {tab === 'drones' && (
                    <div className="flex-1 overflow-y-auto p-5">
                        <div className="max-w-4xl mx-auto space-y-2">
                            <h2 className="text-xs tracking-widest text-zinc-500 mb-3">
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
                                            first seen {fmtDate(d.first_seen)} · last seen {fmtDate(d.last_seen)}
                                        </span>
                                        <button
                                            onClick={() => renameDrone(d)}
                                            className="ml-auto px-2 py-1 rounded border border-zinc-700 text-[10px] text-zinc-400 hover:border-zinc-500"
                                        >
                                            RENAME
                                        </button>
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                )}

                {(tab === 'zones' || tab === 'permits') && (
                    <div className="flex-1 flex items-center justify-center">
                        <div className="border border-zinc-800 rounded p-6 text-center text-xs text-zinc-500 max-w-sm">
                            <div className="text-zinc-300 mb-1">
                                {tab === 'zones' ? 'FLIGHT ZONES' : 'FLIGHT PERMITS'}
                            </div>
                            {tab === 'zones'
                                ? 'Green / orange / red zone editor arrives with the geofencing phase.'
                                : 'Time-windowed zone permissions and the approval queue arrive with the geofencing phase.'}
                        </div>
                    </div>
                )}
            </main>
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
            className="text-[10px] tracking-wide text-cyan-600/80 hover:text-cyan-400 transition-colors break-all text-left"
        >
            {copied ? 'COPIED ✓' : `UID ${uid}`}
        </button>
    )
}

function Tag({ label, tone }: { label: string; tone: 'amber' | 'emerald' | 'red' }) {
    const cls = {
        amber:   'text-amber-500/80 border-amber-500/30',
        emerald: 'text-emerald-400 border-emerald-500/30',
        red:     'text-red-400 border-red-500/40',
    }[tone]
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
