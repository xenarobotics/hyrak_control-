'use client'

// /admin — HYRAK operations console (no credentials for now; the socket
// still needs the normal app token).
//
// Left rail tabs:
//   MAP     — live map of every connected client. GPS fix = solid marker;
//             no fix = dashed marker at the client's IP-derived approximate
//             location. Full-height session column on the left; selecting a
//             drone highlights + flies the map to it and opens the right
//             detail panel (video, flight data, identity, permits).
//   DRONES  — persistent registry with dropdown + search; per-drone detail
//             shows live status, video/telemetry when online, and permits.
//   ZONES / PERMITS — arrive with the geofencing phase.
//
// Open this in its OWN tab: it marks its socket session as admin on the
// backend so it doesn't count as a client.

import { useCallback, useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import dynamic from 'next/dynamic'
import { Map as MapIcon, Plane, Shield, FileCheck, X, Search } from 'lucide-react'
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

type ApproxLocation = { lat: number; lng: number; city: string; country: string } | null

type SessionInfo = {
    session_id: string
    mode: string
    is_streaming: boolean
    telemetry_connected: boolean
    drone_address: string
    hardware_uid: string | null
    drone: DroneRecord | null
    live: LiveState
    approx_location: ApproxLocation
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

// Deterministic ~±30m offset so several clients geolocated to the same city
// don't stack on one pixel.
function jitter(id: string, v: number): number {
    let h = 0
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0
    return v + ((Math.abs(h) % 100) / 100 - 0.5) * 0.0006
}

export default function AdminPage() {
    const [tab, setTab] = useState<Tab>('overview')
    const [sessions, setSessions] = useState<SessionInfo[]>([])
    const [drones, setDrones] = useState<DroneRecord[]>([])
    const [selected, setSelected] = useState<string | null>(null)
    const [selectedDroneId, setSelectedDroneId] = useState<string | null>(null)
    const [search, setSearch] = useState('')
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

    // Drop the watch if the watched session disappears
    useEffect(() => {
        if (selected && !sessions.some(s => s.session_id === selected)) {
            selectedRef.current = null
            setSelected(null)
            setTelem(null)
        }
    }, [sessions, selected])

    const watch = useCallback((sessionId: string | null) => {
        const socket = getSocket()
        if (selectedRef.current === sessionId) return
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

    const toggleSelect = useCallback((sessionId: string) => {
        watch(selectedRef.current === sessionId ? null : sessionId)
    }, [watch])

    // Selecting a drone in the DRONES tab also watches its live session
    const selectDrone = useCallback((droneId: string | null) => {
        setSelectedDroneId(droneId)
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
    const bySession = (droneId: string | null) =>
        droneId ? sessions.find(s => s.drone?.id === droneId) ?? null : null

    const selectedDrone = drones.find(d => d.id === selectedDroneId) ?? null
    const selectedDroneSession = bySession(selectedDroneId)

    // Keep the watch in sync with the drone selected in the DRONES tab
    useEffect(() => {
        if (tab !== 'drones') return
        watch(selectedDroneSession?.session_id ?? null)
    }, [tab, selectedDroneSession?.session_id, watch])

    const onlineUids = new Set(
        sessions.filter(s => s.hardware_uid).map(s => s.hardware_uid as string)
    )

    const mapDrones: MapDrone[] = sessions.flatMap((s): MapDrone[] => {
        const name = s.drone?.name ?? (s.telemetry_connected ? 'identifying…' : 'client')
        if (s.live && (s.live.lat !== 0 || s.live.lng !== 0)) {
            return [{
                session_id: s.session_id,
                name,
                lat: s.live.lat,
                lng: s.live.lng,
                heading: s.live.heading,
                armed: s.live.armed,
                in_air: s.live.in_air,
                selected: s.session_id === selected,
                approx: false,
            }]
        }
        if (s.approx_location) {
            return [{
                session_id: s.session_id,
                name,
                lat: jitter(s.session_id, s.approx_location.lat),
                lng: jitter(s.session_id + 'x', s.approx_location.lng),
                heading: 0,
                armed: false,
                in_air: false,
                selected: s.session_id === selected,
                approx: true,
                approx_label: [s.approx_location.city, s.approx_location.country]
                    .filter(Boolean).join(', '),
            }]
        }
        return []
    })

    const filteredDrones = drones.filter(d => {
        const q = search.trim().toLowerCase()
        if (!q) return true
        return d.name.toLowerCase().includes(q) || d.hardware_uid.toLowerCase().includes(q)
    })

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
                            <AdminMap drones={mapDrones} onSelect={toggleSelect} />

                            {/* Session column — full height, translucent */}
                            <div className="absolute left-0 top-0 bottom-0 z-[1000] w-72 bg-black/60 backdrop-blur border-r border-zinc-800/80 flex flex-col">
                                <div className="px-3 py-2.5 text-[10px] tracking-widest text-zinc-500 border-b border-zinc-800/80">
                                    LIVE CLIENTS — {sessions.length}
                                </div>
                                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                                    {sessions.length === 0 && (
                                        <div className="text-[10px] text-zinc-500 p-2">
                                            No clients connected. This page doesn&apos;t count as one.
                                        </div>
                                    )}
                                    {sessions.map(s => (
                                        <button
                                            key={s.session_id}
                                            onClick={() => toggleSelect(s.session_id)}
                                            className={
                                                'w-full text-left border rounded p-2.5 transition-colors ' +
                                                (selected === s.session_id
                                                    ? 'border-cyan-500 bg-cyan-500/5'
                                                    : 'border-zinc-800 hover:border-zinc-600')
                                            }
                                        >
                                            <div className="flex items-center gap-2 text-xs">
                                                <span className="font-semibold text-zinc-100 truncate">
                                                    {s.drone?.name ??
                                                        (s.telemetry_connected ? 'IDENTIFYING…' : 'CLIENT')}
                                                </span>
                                                {s.drone?.is_simulated && <Tag label="SIM" tone="amber" />}
                                                {s.live?.armed && <Tag label="ARMED" tone="red" />}
                                            </div>
                                            {!s.drone && !s.telemetry_connected && (
                                                <div className="mt-0.5 text-[9px] text-zinc-600">
                                                    browser connected — no drone linked yet
                                                </div>
                                            )}
                                            <div className="mt-1 flex items-center gap-3 text-[10px] text-zinc-500">
                                                <Badge on={s.is_streaming} label="VIDEO" />
                                                <Badge on={s.telemetry_connected} label="TELEM" />
                                            </div>
                                            <div className="mt-0.5 text-[9px] text-zinc-600">
                                                {s.live
                                                    ? `${s.live.mode} · ${s.live.alt.toFixed(0)}m · ${s.live.battery.toFixed(0)}%`
                                                    : s.approx_location
                                                        ? `~ ${[s.approx_location.city, s.approx_location.country].filter(Boolean).join(', ')}`
                                                        : `session ${s.session_id.slice(0, 8)}`}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {/* Detail panel */}
                        {watched && (
                            <DetailPanel
                                session={watched}
                                telem={telem}
                                frameUrl={frameUrl}
                                copiedUid={copiedUid}
                                onCopyUid={copyUid}
                                onRename={renameDrone}
                                onClose={() => watch(null)}
                            />
                        )}
                    </>
                )}

                {tab === 'drones' && (
                    <div className="flex-1 flex min-w-0">
                        {/* Selector column */}
                        <div className="w-80 shrink-0 border-r border-zinc-800 flex flex-col">
                            <div className="p-3 space-y-2 border-b border-zinc-800">
                                <select
                                    value={selectedDroneId ?? ''}
                                    onChange={e => selectDrone(e.target.value || null)}
                                    className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200"
                                >
                                    <option value="">— select drone —</option>
                                    {drones.map(d => (
                                        <option key={d.id} value={d.id}>
                                            {d.name} {onlineUids.has(d.hardware_uid) ? '● online' : ''}
                                        </option>
                                    ))}
                                </select>
                                <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-700 rounded px-2">
                                    <Search size={12} className="text-zinc-500" />
                                    <input
                                        value={search}
                                        onChange={e => setSearch(e.target.value)}
                                        placeholder="search name / uid…"
                                        className="flex-1 bg-transparent py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
                                    />
                                </div>
                            </div>
                            <div className="flex-1 overflow-y-auto p-2 space-y-2">
                                {filteredDrones.length === 0 && (
                                    <div className="text-[10px] text-zinc-600 p-2">
                                        {drones.length === 0
                                            ? 'No drones registered yet — connect telemetry once and the FC’s hardware UID gets stored here permanently.'
                                            : 'No match.'}
                                    </div>
                                )}
                                {filteredDrones.map(d => {
                                    const online = onlineUids.has(d.hardware_uid)
                                    return (
                                        <button
                                            key={d.id}
                                            onClick={() => selectDrone(d.id === selectedDroneId ? null : d.id)}
                                            className={
                                                'w-full text-left border rounded p-2.5 transition-colors ' +
                                                (selectedDroneId === d.id
                                                    ? 'border-cyan-500 bg-cyan-500/5'
                                                    : 'border-zinc-800 hover:border-zinc-600')
                                            }
                                        >
                                            <div className="flex items-center gap-2 text-xs">
                                                <span className={online ? 'text-emerald-400' : 'text-zinc-700'}>●</span>
                                                <span className="font-semibold text-zinc-100 truncate">{d.name}</span>
                                                {d.is_simulated && <Tag label="SIM" tone="amber" />}
                                            </div>
                                            <div className="mt-1 text-[9px] text-zinc-600">
                                                last seen {fmtDate(d.last_seen)}
                                            </div>
                                        </button>
                                    )
                                })}
                            </div>
                        </div>

                        {/* Drone detail */}
                        <div className="flex-1 overflow-y-auto">
                            {!selectedDrone ? (
                                <div className="h-full flex items-center justify-center text-xs text-zinc-600">
                                    Select a drone to inspect it
                                </div>
                            ) : (
                                <div className="max-w-2xl mx-auto p-5 space-y-4">
                                    <div className="flex items-center gap-3">
                                        <span className="text-lg font-semibold text-zinc-100">
                                            {selectedDrone.name}
                                        </span>
                                        {selectedDrone.is_simulated && <Tag label="SIM" tone="amber" />}
                                        {selectedDroneSession
                                            ? <Tag label="ONLINE" tone="emerald" />
                                            : <Tag label="OFFLINE" tone="zinc" />}
                                        {selectedDroneSession?.live?.armed && <Tag label="ARMED" tone="red" />}
                                        <button
                                            onClick={() => renameDrone(selectedDrone)}
                                            className="ml-auto px-2 py-1 rounded border border-zinc-700 text-[10px] text-zinc-400 hover:border-zinc-500"
                                        >
                                            RENAME
                                        </button>
                                        {selectedDroneSession && (
                                            <button
                                                onClick={() => { setTab('overview'); watch(selectedDroneSession.session_id) }}
                                                className="px-2 py-1 rounded border border-cyan-700 text-[10px] text-cyan-400 hover:border-cyan-500"
                                            >
                                                SHOW ON MAP
                                            </button>
                                        )}
                                    </div>

                                    <div className="border border-zinc-800 rounded p-3 space-y-1.5 text-[10px] text-zinc-500">
                                        <div className="tracking-widest">IDENTITY</div>
                                        <Uid uid={selectedDrone.hardware_uid}
                                            copied={copiedUid === selectedDrone.hardware_uid} onCopy={copyUid} />
                                        <div className="text-zinc-600">
                                            first seen {fmtDate(selectedDrone.first_seen)} · last seen {fmtDate(selectedDrone.last_seen)}
                                        </div>
                                        {selectedDroneSession?.approx_location && (
                                            <div className="text-zinc-600">
                                                client near {[selectedDroneSession.approx_location.city,
                                                    selectedDroneSession.approx_location.country].filter(Boolean).join(', ')}
                                            </div>
                                        )}
                                    </div>

                                    {/* Live video + flight data when online */}
                                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                        <div className="border border-zinc-800 rounded overflow-hidden">
                                            <div className="px-3 py-1.5 text-[10px] text-zinc-500 border-b border-zinc-800">VIDEO</div>
                                            {selectedDroneSession && frameUrl ? (
                                                // eslint-disable-next-line @next/next/no-img-element
                                                <img src={frameUrl} alt="drone video" className="w-full" />
                                            ) : (
                                                <div className="aspect-video flex items-center justify-center text-[10px] text-zinc-600">
                                                    {!selectedDroneSession
                                                        ? 'Drone is offline'
                                                        : selectedDroneSession.is_streaming
                                                            ? 'Waiting for frames…'
                                                            : 'Client is not streaming video'}
                                                </div>
                                            )}
                                        </div>
                                        <div className="border border-zinc-800 rounded">
                                            <div className="px-3 py-1.5 text-[10px] text-zinc-500 border-b border-zinc-800">FLIGHT DATA</div>
                                            {selectedDroneSession && telem ? (
                                                <TelemGrid telem={telem} />
                                            ) : (
                                                <div className="p-3 text-[10px] text-zinc-600">
                                                    {!selectedDroneSession
                                                        ? 'Drone is offline'
                                                        : 'Waiting for telemetry…'}
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    <PermitsBlock />
                                </div>
                            )}
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

// ── Detail panel (map tab) ───────────────────────────────────────────────
function DetailPanel({
    session, telem, frameUrl, copiedUid, onCopyUid, onRename, onClose,
}: {
    session: SessionInfo
    telem: Telem | null
    frameUrl: string | null
    copiedUid: string | null
    onCopyUid: (u: string) => void
    onRename: (d: DroneRecord) => void
    onClose: () => void
}) {
    return (
        <section className="w-96 shrink-0 border-l border-zinc-800 bg-zinc-950 overflow-y-auto">
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-800 sticky top-0 bg-zinc-950 z-10">
                <span className="text-sm font-semibold text-zinc-100 truncate">
                    {session.drone?.name ?? session.session_id.slice(0, 8)}
                </span>
                {session.drone?.is_simulated && <Tag label="SIM" tone="amber" />}
                {session.live?.armed && <Tag label="ARMED" tone="red" />}
                <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200" title="Close">
                    <X size={16} />
                </button>
            </div>

            <div className="border-b border-zinc-800">
                <div className="px-3 py-1.5 text-[10px] text-zinc-500">VIDEO</div>
                {frameUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={frameUrl} alt="session video" className="w-full" />
                ) : (
                    <div className="aspect-video flex items-center justify-center text-[10px] text-zinc-600">
                        {session.is_streaming ? 'Waiting for frames…' : 'Client is not streaming video'}
                    </div>
                )}
            </div>

            <div className="border-b border-zinc-800 pb-2">
                <div className="px-3 py-1.5 text-[10px] text-zinc-500">FLIGHT DATA</div>
                {telem ? (
                    <TelemGrid telem={telem} />
                ) : (
                    <div className="px-3 text-[10px] text-zinc-600">
                        {session.telemetry_connected ? 'Waiting for telemetry…' : 'No telemetry connected'}
                    </div>
                )}
            </div>

            <div className="border-b border-zinc-800 px-3 py-2 space-y-1.5 text-[10px]">
                <div className="text-zinc-500 tracking-widest">IDENTITY</div>
                {session.hardware_uid ? (
                    <Uid uid={session.hardware_uid}
                        copied={copiedUid === session.hardware_uid} onCopy={onCopyUid} />
                ) : (
                    <div className="text-zinc-600">UID not resolved</div>
                )}
                <div className="text-zinc-600">session {session.session_id}</div>
                {session.approx_location && (
                    <div className="text-zinc-600">
                        client near {[session.approx_location.city, session.approx_location.country]
                            .filter(Boolean).join(', ')}
                    </div>
                )}
                {session.drone_address && (
                    <div className="text-zinc-700 break-all">{session.drone_address}</div>
                )}
                {session.drone && (
                    <button
                        onClick={() => onRename(session.drone!)}
                        className="mt-1 px-2 py-1 rounded border border-zinc-700 text-[10px] text-zinc-400 hover:border-zinc-500"
                    >
                        RENAME
                    </button>
                )}
            </div>

            <div className="px-3 py-2">
                <PermitsBlock />
            </div>
        </section>
    )
}

// Permissions structure — populated once the geofencing phase lands.
function PermitsBlock() {
    return (
        <div className="border border-zinc-800 rounded p-3 space-y-2 text-[10px]">
            <div className="text-zinc-500 tracking-widest">PERMISSIONS</div>
            <div className="flex justify-between text-zinc-600">
                <span>PENDING</span><span>0</span>
            </div>
            <div className="flex justify-between text-zinc-600">
                <span>GRANTED</span><span>0</span>
            </div>
            <div className="text-zinc-700">
                Zone permit requests appear here once the geofencing phase lands.
            </div>
        </div>
    )
}

function TelemGrid({ telem }: { telem: Telem }) {
    return (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-3 py-2 text-xs">
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

function Tag({ label, tone }: { label: string; tone: 'amber' | 'emerald' | 'red' | 'zinc' }) {
    const cls = {
        amber:   'text-amber-500/80 border-amber-500/30',
        emerald: 'text-emerald-400 border-emerald-500/30',
        red:     'text-red-400 border-red-500/40',
        zinc:    'text-zinc-500 border-zinc-700',
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
