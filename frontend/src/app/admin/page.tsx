'use client'

// /admin - HYRAK operations console for staff: anyone with a membership
// on the HYRAK workspace (docs/ACCESS_MODEL.md section 5). Founders see
// every tab; other staff see the tabs their memberships allow, and the
// server re-checks every call.
//
// Organization console (section 8a): customer owners and admins (anyone
// with members.manage on a workspace, not staff) get SPACES, ZONES (site
// layer, inside their operating area) and AUDIT for their own workspaces,
// titled "Organization console", with a way back to the app.
//
// Phase 2b (section 8b): MAP and DRONES are open to all staff, scoped by
// the server to the workspaces they can view (founders: everything; a
// manager: the customer workspaces they manage). Watching a session is view
// only. Taking control is separate: with sessions.takeover on the session's
// workspace the detail panel offers HOLD / RTL / LAND and "Take control".
//
// Left rail tabs:
//   MAP     - live map of every connected client. GPS fix = solid marker;
//             no fix = dashed marker at the client's IP-derived approximate
//             location. Full-height session column on the left; selecting a
//             drone highlights + flies the map to it and opens the right
//             detail panel (video, flight data, identity, permits).
//   DRONES  - persistent registry with dropdown + search; per-drone detail
//             shows live status, video/telemetry when online, and permits.
//   ZONES   - layered zones (regulatory / area / site), edited inside the
//             caller's area.
//   PERMITS - flight permit requests the caller may decide (permits.approve
//             covering the restricted airspace; docs/ACCESS_MODEL.md 8d).
//   SPACES  - workspaces: tree, members, invites, drones, operating areas.
//   STAFF   - founders: staff roles, account disable / reset links.
//   AUDIT   - latest access and zone events.
//
// Open this in its OWN tab: it marks its socket session as admin on the
// backend so it doesn't count as a client.

import { apiDownload, apiFetch } from '@/lib/api'
import { useCallback, useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import dynamic from 'next/dynamic'
import { Map as MapIcon, Plane, Shield, FileCheck, X, Search, Building2, Users, ScrollText, ArrowLeft, Activity, Sun, Moon, AlertTriangle, CheckCircle2, Circle } from 'lucide-react'
import { useTheme } from '@/lib/theme'
import { useHydrated } from '@/hooks/useClientValue'
import { connectSocket, getSocket } from '@/lib/socket'
import { liveAuthHeaders } from '@/lib/auth'
import { useAuthGate } from '@/hooks/useAuthGate'
import { useAccess } from '@/hooks/useAccess'
import { hasPerm, type Perm } from '@/lib/access'
import { Tag } from '@/components/admin/console'
import { FLIGHT_MODES } from '@/lib/flightModes'
import { getServerUrl } from '@/lib/server-url'
import { decidePermit as sendDecision, PERMIT_TONE, type Permit } from '@/lib/planning'
import type { MapDrone } from '@/components/admin/AdminMap'
import type { ZoneFeature } from '@/components/admin/zones'

const AdminMap = dynamic(() => import('@/components/admin/AdminMap'), { ssr: false })
const ZoneEditor = dynamic(() => import('@/components/admin/ZoneEditor'), { ssr: false })
const FlightTrackMap = dynamic(() => import('@/components/admin/FlightTrackMap'), { ssr: false })
const WorkspacesTab = dynamic(() => import('@/components/admin/WorkspacesTab'), { ssr: false })
const StaffTab = dynamic(() => import('@/components/admin/StaffTab'), { ssr: false })
const AuditTab = dynamic(() => import('@/components/admin/AuditTab'), { ssr: false })

const JSON_AUTH = liveAuthHeaders({ 'Content-Type': 'application/json' })
const AUTH = liveAuthHeaders()

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
    zone_class: 'green' | 'orange' | 'red'
} | null

type ApproxLocation = { lat: number; lng: number; city: string; country: string } | null

type TakeoverInfo = { by: string; user_id: string; staff_session_id: string; since: number } | null

type SessionInfo = {
    session_id: string
    workspace_id: string | null
    workspace_name: string
    username: string | null
    role: string | null
    staff: boolean
    link_kind: string | null
    ai_mode: string
    video: boolean
    armed: boolean
    in_air: boolean
    detached: boolean
    takeover: TakeoverInfo
    mode: string
    is_streaming: boolean
    telemetry_connected: boolean
    drone_address: string
    hardware_uid: string | null
    drone: DroneRecord | null
    live: LiveState
    approx_location: ApproxLocation
}

// Swarm SITL drones - connected server-side (UDP), not through a client
// session, so they arrive in a separate list with the same live shape.
type FleetDroneInfo = {
    drone_id: number
    db_id: string | null
    hardware_uid: string
    is_simulated: boolean
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

type FlightSummary = {
    id: string
    drone_id: string
    started_at: string | null
    ended_at: string | null
    duration_s: number
    max_alt_m: number
    distance_m: number
    samples_count: number
    in_progress: boolean
    crossed_orange: boolean
    crossed_red: boolean
}

type PermitInfo = Permit

type FlightDetail = {
    flight: FlightSummary
    track: { t: string; lat: number; lng: number; alt: number; speed: number; battery: number; mode: string }[]
}

type Tab = 'overview' | 'drones' | 'zones' | 'permits' | 'workspaces' | 'staff' | 'audit'

// Rail labels fit a 48px button at 9px mono; `full` is the tooltip.
const TABS: { key: Tab; label: string; full?: string; icon: typeof MapIcon }[] = [
    { key: 'overview',   label: 'Map',     icon: MapIcon },
    { key: 'drones',     label: 'Drones',  icon: Plane },
    { key: 'zones',      label: 'Zones',   icon: Shield },
    { key: 'permits',    label: 'Permits', icon: FileCheck },
    { key: 'workspaces', label: 'Spaces',  full: 'Workspaces', icon: Building2 },
    { key: 'staff',      label: 'Staff',   icon: Users },
    { key: 'audit',      label: 'Audit',   icon: ScrollText },
]

// Deterministic ~±30m offset so several clients geolocated to the same city
// don't stack on one pixel.
function jitter(id: string, v: number): number {
    let h = 0
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0
    return v + ((Math.abs(h) % 100) / 100 - 0.5) * 0.0006
}

export default function AdminPage() {
    const gate = useAuthGate('console')
    const { isFounder, isStaff, workspaces, user } = useAccess()
    // Not staff, yet past the gate: a customer owner or admin.
    const org = !!user && !isStaff
    // The live session map, socket mirrors and drone registry are open to
    // all staff since phase 2b; the server scopes each to the workspaces
    // the account can view.
    const monitor = isStaff
    const anyPerm = (p: Perm) => workspaces.some(w => hasPerm(w, p))
    const canTakeover = useCallback((wsId: string | null) =>
        isFounder || workspaces.some(w => w.id === wsId && hasPerm(w, 'sessions.takeover')),
    [isFounder, workspaces])
    const visibleTabs = TABS.filter(t => {
        switch (t.key) {
            case 'overview': case 'drones': return monitor
            case 'staff': return isFounder
            case 'permits': return !org && (isFounder || anyPerm('permits.approve'))
            case 'audit': return isFounder || anyPerm('audit.view')
            default: return true
        }
    })
    const permitsVisible = visibleTabs.some(t => t.key === 'permits')
    useEffect(() => {
        if (!org) return
        const before = document.title
        document.title = 'Organization console - HYRAK'
        return () => { document.title = before }
    }, [org])
    const [pickedTab, setTab] = useState<Tab | null>(null)
    const tab: Tab = visibleTabs.find(t => t.key === pickedTab)?.key ?? visibleTabs[0]?.key ?? 'workspaces'
    const [sessions, setSessions] = useState<SessionInfo[]>([])
    const [fleetDrones, setFleetDrones] = useState<FleetDroneInfo[]>([])
    const [drones, setDrones] = useState<DroneRecord[]>([])
    const [selected, setSelected] = useState<string | null>(null)
    const [selectedDroneId, setSelectedDroneId] = useState<string | null>(null)
    const [search, setSearch] = useState('')
    const [telem, setTelem] = useState<Telem | null>(null)
    const [frameUrl, setFrameUrl] = useState<string | null>(null)
    const [copiedUid, setCopiedUid] = useState<string | null>(null)
    const [zones, setZones] = useState<ZoneFeature[]>([])
    const [flights, setFlights] = useState<FlightSummary[]>([])
    const [flightDetail, setFlightDetail] = useState<FlightDetail | null>(null)
    const [permits, setPermits] = useState<PermitInfo[]>([])
    const selectedRef = useRef<string | null>(null)
    const frameUrlRef = useRef<string | null>(null)

    // Socket: announce as a console observer, subscribe to mirrors
    const [takeoverNote, setTakeoverNote] = useState<string | null>(null)
    const [mySessionId, setMySessionId] = useState<string | null>(null)
    const [lastResult, setLastResult] = useState<{ action: string; ok: boolean; error?: string } | null>(null)
    useEffect(() => {
        if (!monitor) return
        const socket = getSocket()
        const hello = () => socket.emit('admin_hello', {})
        socket.on('connect', hello)
        if (socket.connected) hello()
        else connectSocket()

        const onReady = (d: { session_id?: string }) => { if (d?.session_id) setMySessionId(d.session_id) }
        socket.on('session_ready', onReady)
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
        // Takeover and routed-command answers (section 8b "Takeover").
        const onTakeover = (d: { ok?: boolean; active?: boolean; error?: string; reason?: string }) => {
            if (d.ok === false) setTakeoverNote(d.error ?? 'Refused')
            else if (d.active === false && d.reason) setTakeoverNote(`Control released (${d.reason.replace(/_/g, ' ')})`)
            else setTakeoverNote(null)
        }
        const onResult = (d: { action: string; ok: boolean; error?: string }) => setLastResult(d)
        const onError = (d: { event?: string; msg?: string; code?: string }) => {
            if (d?.event === 'drone_action' || d?.event === 'drone_command') setTakeoverNote(d.msg ?? 'Refused')
        }
        socket.on('admin_telemetry', onTelem)
        socket.on('admin_frame', onFrame)
        socket.on('takeover_result', onTakeover)
        socket.on('action_result', onResult)
        socket.on('error', onError)

        return () => {
            socket.off('connect', hello)
            socket.off('admin_telemetry', onTelem)
            socket.off('admin_frame', onFrame)
            socket.off('session_ready', onReady)
            socket.off('takeover_result', onTakeover)
            socket.off('action_result', onResult)
            socket.off('error', onError)
            if (selectedRef.current) {
                socket.emit('unwatch_session', { session_id: selectedRef.current })
            }
            if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current)
        }
    }, [monitor])

    // Sessions + registry: poll every 2s
    useEffect(() => {
        if (!monitor) return
        let alive = true
        const poll = async () => {
            try {
                const [sRes, dRes] = await Promise.all([
                    apiFetch(`${getServerUrl()}/api/sessions`, { headers: AUTH }),
                    apiFetch(`${getServerUrl()}/api/drones`),
                ])
                const sData = await sRes.json()
                const dData = await dRes.json()
                if (alive) {
                    // Only replace state when content actually changed - a new
                    // array identity every 2s makes leaflet re-mount markers
                    // and polygons, which reads as map jitter.
                    const nextS = sData.sessions ?? []
                    const nextF = sData.fleet_drones ?? []
                    const nextD = dData.drones ?? []
                    setSessions(prev =>
                        JSON.stringify(prev) === JSON.stringify(nextS) ? prev : nextS)
                    setFleetDrones(prev =>
                        JSON.stringify(prev) === JSON.stringify(nextF) ? prev : nextF)
                    setDrones(prev =>
                        JSON.stringify(prev) === JSON.stringify(nextD) ? prev : nextD)
                }
            } catch { /* backend down - keep last data */ }
        }
        void poll()
        const id = setInterval(poll, 2000)
        return () => { alive = false; clearInterval(id) }
    }, [monitor])

    // Zones: fetch on mount + every 30s + after edits
    const refreshZones = useCallback(async () => {
        try {
            // Signed in: 2a makes zone reads "any signed-in account".
            const res = await apiFetch(`${getServerUrl()}/api/zones`, { headers: AUTH })
            const data = await res.json()
            const next = data.features ?? []
            setZones(prev =>
                JSON.stringify(prev) === JSON.stringify(next) ? prev : next)
        } catch { /* keep last */ }
    }, [])
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh sets state only after its fetch resolves; the rule does not follow the await
        void refreshZones()
        const id = setInterval(refreshZones, 30000)
        return () => clearInterval(id)
    }, [refreshZones])

    // Permits: poll while the PERMITS tab is open (plus once on mount for the badge)
    const refreshPermits = useCallback(async () => {
        try {
            const res = await apiFetch(`${getServerUrl()}/api/permits`)
            const data = await res.json()
            const next = data.permits ?? []
            setPermits(prev =>
                JSON.stringify(prev) === JSON.stringify(next) ? prev : next)
        } catch { /* keep last */ }
    }, [])
    useEffect(() => {
        if (!permitsVisible) return
        // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh sets state only after its fetch resolves; the rule does not follow the await
        void refreshPermits()
        if (tab !== 'permits') return
        const id = setInterval(refreshPermits, 5000)
        return () => clearInterval(id)
    }, [tab, refreshPermits, permitsVisible])

    const [permitNotes, setPermitNotes] = useState<Record<string, string>>({})
    const [permitError, setPermitError] = useState<string | null>(null)
    const decidePermit = async (id: string, approve: boolean) => {
        setPermitError(null)
        try {
            await sendDecision(id, approve, permitNotes[id] ?? '')
            setPermitNotes(n => {
                const next = { ...n }
                delete next[id]
                return next
            })
        } catch (e) { setPermitError((e as Error).message) }
        void refreshPermits()
    }

    // Flights: refetch when the selected drone changes; refresh while viewing
    const refreshFlights = useCallback(async (droneId: string) => {
        try {
            const res = await apiFetch(`${getServerUrl()}/api/drones/${droneId}/flights`)
            const data = await res.json()
            setFlights(data.flights ?? [])
        } catch { /* keep last */ }
    }, [])
    // The previous drone's flights are cleared on the selection edge, during
    // render, so they never show under the new drone's name.
    const [flightsFor, setFlightsFor] = useState(selectedDroneId)
    if (selectedDroneId !== flightsFor) {
        setFlightsFor(selectedDroneId)
        setFlights([])
        setFlightDetail(null)
    }
    useEffect(() => {
        if (!selectedDroneId) return
        // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh sets state only after its fetch resolves; the rule does not follow the await
        void refreshFlights(selectedDroneId)
        const id = setInterval(() => void refreshFlights(selectedDroneId), 10000)
        return () => clearInterval(id)
    }, [selectedDroneId, refreshFlights])

    const openFlight = useCallback(async (flightId: string) => {
        let close = false
        setFlightDetail(d => {
            if (d?.flight.id === flightId) { close = true; return null }
            return d
        })
        if (close) return
        try {
            const res = await apiFetch(`${getServerUrl()}/api/flights/${flightId}`)
            if (res.ok) setFlightDetail(await res.json())
        } catch { /* ignore */ }
    }, [])

    // Drop the watch if the watched session (or fleet drone) disappears
    useEffect(() => {
        if (!selected) return
        const gone = selected.startsWith('fleet-')
            ? !fleetDrones.some(f => `fleet-${f.drone_id}` === selected)
            : !sessions.some(s => s.session_id === selected)
        if (gone) {
            selectedRef.current = null
            // eslint-disable-next-line react-hooks/set-state-in-effect -- kept beside the ref reset, which must happen after commit; fires once per vanished session
            setSelected(null)
            setTelem(null)
        }
    }, [sessions, fleetDrones, selected])

    // Fleet ids ('fleet-N') are selectable but never socket-watched - SITL
    // drones have no client session to mirror video/telemetry from; their
    // live state comes from the 2s /api/sessions poll instead.
    const watch = useCallback((sessionId: string | null) => {
        const socket = getSocket()
        if (selectedRef.current === sessionId) return
        if (selectedRef.current && !selectedRef.current.startsWith('fleet-')) {
            socket.emit('unwatch_session', { session_id: selectedRef.current })
        }
        if (sessionId && !sessionId.startsWith('fleet-')) {
            socket.emit('watch_session', { session_id: sessionId })
        }
        selectedRef.current = sessionId
        setSelected(sessionId)
        setTelem(null)
        if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current)
        frameUrlRef.current = null
        setFrameUrl(null)
    }, [])

    // Staff control of a watched session (section 8b "Takeover"). Quick
    // hold / return / land need no takeover; everything else is sent only
    // while this console holds it. The server checks sessions.takeover on
    // the session's workspace for every one of them.
    const sendTo = useCallback((sessionId: string, action: string, extra: Record<string, unknown> = {}) => {
        setTakeoverNote(null)
        setLastResult(null)
        getSocket().emit('drone_action', { action, ...extra, target_session: sessionId })
    }, [])
    const takeOver = useCallback((sessionId: string) => {
        setTakeoverNote(null)
        getSocket().emit('takeover_session', { session_id: sessionId })
    }, [])
    const release = useCallback((sessionId: string) => {
        getSocket().emit('release_session', { session_id: sessionId })
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
            await apiFetch(`${getServerUrl()}/api/drones/${d.id}`, {
                method: 'PATCH',
                headers: JSON_AUTH,
                body: JSON.stringify({ name }),
            })
        } catch { /* next poll shows the truth either way */ }
    }, [])

    const watched = sessions.find(s => s.session_id === selected)
    const watchedFleet = selected?.startsWith('fleet-')
        ? fleetDrones.find(f => `fleet-${f.drone_id}` === selected) ?? null
        : null
    // Fleet drones carry a registry identity (sitl-instance-N) - show the
    // registry name (renameable in the DRONES tab) when it exists.
    const fleetName = useCallback((f: FleetDroneInfo) =>
        drones.find(d => d.id === f.db_id || d.hardware_uid === f.hardware_uid)?.name
            ?? `SITL ${f.drone_id}`, [drones])
    const bySession = (droneId: string | null) =>
        droneId ? sessions.find(s => s.drone?.id === droneId) ?? null : null

    const selectedDrone = drones.find(d => d.id === selectedDroneId) ?? null
    const selectedDroneSession = bySession(selectedDroneId)

    // Keep the watch in sync with the drone selected in the DRONES tab
    useEffect(() => {
        if (tab !== 'drones') return
        // eslint-disable-next-line react-hooks/set-state-in-effect -- watch() subscribes the socket (an external system) and resets the view state with it
        watch(selectedDroneSession?.session_id ?? null)
    }, [tab, selectedDroneSession?.session_id, watch])

    const onlineUids = new Set([
        ...sessions.filter(s => s.hardware_uid).map(s => s.hardware_uid as string),
        ...fleetDrones.map(f => f.hardware_uid),
    ])

    // The landing map only shows real drones - sessions without telemetry
    // (browser open, nothing linked) stay off the list and the map.
    const telemSessions = sessions.filter(s => s.telemetry_connected)

    const mapDrones: MapDrone[] = telemSessions.flatMap((s): MapDrone[] => {
        const name = s.drone?.name ?? 'identifying…'
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

    // Fleet SITL drones on the same map, tagged SIM
    for (const f of fleetDrones) {
        if (!f.live || (f.live.lat === 0 && f.live.lng === 0)) continue
        mapDrones.push({
            session_id: `fleet-${f.drone_id}`,
            name: fleetName(f),
            lat: f.live.lat,
            lng: f.live.lng,
            heading: f.live.heading,
            armed: f.live.armed,
            in_air: f.live.in_air,
            selected: `fleet-${f.drone_id}` === selected,
            approx: false,
            sim: true,
        })
    }

    const filteredDrones = drones.filter(d => {
        const q = search.trim().toLowerCase()
        if (!q) return true
        return d.name.toLowerCase().includes(q) || d.hardware_uid.toLowerCase().includes(q)
    })

    if (gate !== 'ok') {
        return (
            <div className="h-screen flex items-center justify-center bg-app-bg text-app-text-muted">
                <span className="text-[14px]">Checking sign-in…</span>
            </div>
        )
    }

    const liveCount = telemSessions.length + fleetDrones.length

    return (
        <div className={'h-screen flex bg-app-bg text-app-text overflow-hidden ' + FOCUS_SCOPE}>
            {/* ── Left rail: same look as the app's rail (layout.tsx) ───── */}
            <aside className="w-16 shrink-0 flex flex-col items-center py-4 gap-1 border-r border-app-border bg-app-sidebar z-10">
                <div className="mb-5 p-2" title={org ? 'Organization console' : 'HYRAK console'}>
                    <Image src="/brand/icon-dark.png" alt="HYRAK" width={26} height={26} className="dark:hidden" />
                    <Image src="/brand/icon.png" alt="HYRAK" width={26} height={26} className="hidden dark:block" />
                </div>
                {visibleTabs.map(({ key, label, full, icon: Icon }) => {
                    const pending = key === 'permits'
                        ? permits.filter(p => p.status === 'pending').length : 0
                    return (
                        <button
                            key={key}
                            title={pending > 0 ? `${full ?? label}: ${pending} waiting` : (full ?? label)}
                            aria-current={tab === key ? 'page' : undefined}
                            onClick={() => setTab(key)}
                            className={
                                'relative flex flex-col items-center gap-1 w-12 py-2 rounded-md text-[12px] font-semibold transition-colors duration-[120ms] ' +
                                (tab === key
                                    ? 'bg-app-accent-soft text-app-accent'
                                    : 'text-app-text-muted hover:text-app-text hover:bg-app-surface-2')
                            }
                        >
                            <Icon size={18} aria-hidden />
                            {label}
                            {pending > 0 && (
                                <span className="absolute top-0.5 right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-app-warn text-app-accent-ink text-[12px] font-bold tabular-nums flex items-center justify-center">
                                    {pending}
                                </span>
                            )}
                        </button>
                    )
                })}
                <div className="mt-auto flex flex-col items-center gap-1">
                    {/* The live count is founder data; the organization console
                        has its way back to the app in its header instead. */}
                    {!org && (
                        <div className={'flex flex-col items-center gap-0.5 py-2 text-[12px] font-semibold ' + (liveCount > 0 ? 'text-app-ok' : 'text-app-text-muted')}
                            title={`${liveCount} drone${liveCount === 1 ? '' : 's'} connected`}>
                            <span className="flex items-center gap-1 tabular-nums text-[14px] font-bold">
                                <Activity size={14} aria-hidden /> {liveCount}
                            </span>
                            Live
                        </div>
                    )}
                    {!org && (
                        <a href="/command" title="Back to the app"
                            className="flex flex-col items-center gap-1 w-12 py-2 rounded-md text-[12px] font-semibold text-app-text-muted hover:text-app-text hover:bg-app-surface-2 transition-colors duration-[120ms]">
                            <ArrowLeft size={18} aria-hidden />
                            App
                        </a>
                    )}
                    <ConsoleThemeToggle />
                </div>
            </aside>

            {/* ── Main area ────────────────────────────────────────────── */}
            <main className={'flex-1 relative flex flex-col md:flex-row min-w-0 overflow-y-auto md:overflow-hidden' + (org ? ' pt-12' : '')}>
                {org && (
                    <header className="absolute top-0 inset-x-0 h-12 flex items-center gap-3 px-4 border-b border-app-border bg-app-surface">
                        <h1 className="text-[18px] font-bold text-app-text whitespace-nowrap">Organization console</h1>
                        <span className="text-[13px] text-app-text-muted truncate">
                            {user?.display_name || user?.username}
                        </span>
                        <a href="/command" className="ml-auto flex items-center gap-1.5 h-8 px-3 rounded-md border border-app-border-strong text-[13px] font-semibold text-app-text hover:bg-app-surface-2 transition-colors duration-[120ms] whitespace-nowrap">
                            <ArrowLeft size={14} aria-hidden /> Back to the app
                        </a>
                    </header>
                )}
                {tab === 'overview' && (
                    <>
                        <div className="flex-1 relative min-w-0 min-h-[360px]">
                            <AdminMap drones={mapDrones} zones={zones} onSelect={toggleSelect} />

                            {/* Active drones column - mission-page panel style */}
                            <div className="absolute left-3 top-3 z-[1000] w-72 max-w-[calc(100%-24px)] max-h-[calc(100%-24px)] rounded-[10px] border border-app-border bg-app-surface shadow-[var(--app-shadow)] flex flex-col overflow-hidden">
                                <div className="px-3 h-11 flex items-center gap-2 border-b border-app-border">
                                    <h2 className="text-[16px] font-bold text-app-text">Active drones</h2>
                                    <span className="ml-auto text-[13px] font-bold tabular-nums text-app-text-muted">{liveCount}</span>
                                </div>
                                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                                    {liveCount === 0 && (
                                        <div className="flex items-center gap-2 text-[13px] text-app-text-muted p-2"
                                            title="Clients without a telemetry link don't appear here.">
                                            <Plane size={16} aria-hidden /> No drones connected
                                        </div>
                                    )}
                                    {telemSessions.map(s => (
                                        <button
                                            key={s.session_id}
                                            onClick={() => toggleSelect(s.session_id)}
                                            className={
                                                'w-full text-left border rounded-md p-2.5 transition-colors duration-[120ms] ' +
                                                (selected === s.session_id
                                                    ? 'border-app-accent bg-app-accent-soft'
                                                    : 'border-app-border hover:border-app-text-subtle')
                                            }
                                        >
                                            <div className="flex flex-wrap items-center gap-1.5 text-[14px]">
                                                <span className="font-semibold text-app-text truncate">
                                                    {s.drone?.name ?? 'IDENTIFYING…'}
                                                </span>
                                                {s.drone?.is_simulated && <Tag label="SIM" tone="amber" />}
                                                {s.live?.armed && <Tag label="ARMED" tone="red" />}
                                                {s.in_air && <Tag label="IN AIR" tone="amber" />}
                                            </div>
                                            {s.live?.zone_class === 'orange' && (
                                                <div className="mt-1 flex items-center gap-1 text-[12px] font-bold text-app-warn">
<AlertTriangle size={12} aria-hidden /> In orange zone
</div>
                                            )}
                                            {s.live?.zone_class === 'red' && (
                                                <div className="mt-1 flex items-center gap-1 text-[12px] font-bold text-app-danger">
<AlertTriangle size={12} aria-hidden /> In red zone, enforcing
</div>
                                            )}
                                            <div className="mt-0.5 text-[12px] text-app-text-muted truncate">
                                                {s.workspace_name || 'workspace ?'} · {s.username ?? '?'}{s.role ? ` (${s.role})` : ''}
                                            </div>
                                            <div className="mt-1 flex items-center gap-3 text-[12px] text-app-text-muted">
                                                <Badge on={s.is_streaming} label="VIDEO" />
                                                <Badge on={s.telemetry_connected} label="TELEM" />
                                                {s.ai_mode && s.ai_mode !== 'manual-control' && (
                                                    <span className="text-violet-700 dark:text-violet-400 truncate">{s.ai_mode}</span>
                                                )}
                                                {s.takeover && <Tag label="HYRAK CONTROL" tone="red" />}
                                            </div>
                                            <div className="mt-0.5 text-[12px] text-app-text-muted">
                                                {s.live
                                                    ? `${s.live.mode} · ${s.live.alt.toFixed(0)}m · ${s.live.battery.toFixed(0)}%`
                                                    : s.approx_location
                                                        ? `~ ${[s.approx_location.city, s.approx_location.country].filter(Boolean).join(', ')}`
                                                        : `session ${s.session_id.slice(0, 8)}`}
                                            </div>
                                        </button>
                                    ))}
                                    {/* Swarm SITL fleet - server-side connections, tagged SIM */}
                                    {fleetDrones.map(f => {
                                        const fid = `fleet-${f.drone_id}`
                                        return (
                                            <button
                                                key={fid}
                                                onClick={() => toggleSelect(fid)}
                                                className={
                                                    'w-full text-left border rounded-md p-2.5 transition-colors duration-[120ms] ' +
                                                    (selected === fid
                                                        ? 'border-violet-500 bg-violet-500/5'
                                                        : 'border-app-border hover:border-app-text-subtle')
                                                }
                                            >
                                                <div className="flex flex-wrap items-center gap-1.5 text-[14px]">
                                                    <span className="font-semibold text-app-text truncate">
                                                        {fleetName(f)}
                                                    </span>
                                                    <Tag label="SIM" tone="violet" />
                                                    {f.live?.armed && <Tag label="ARMED" tone="red" />}
                                                </div>
                                                {f.live?.zone_class === 'orange' && (
                                                    <div className="mt-1 flex items-center gap-1 text-[12px] font-bold text-app-warn">
<AlertTriangle size={12} aria-hidden /> In orange zone
</div>
                                                )}
                                                {f.live?.zone_class === 'red' && (
                                                    <div className="mt-1 flex items-center gap-1 text-[12px] font-bold text-app-danger">
<AlertTriangle size={12} aria-hidden /> In red zone
</div>
                                                )}
                                                <div className="mt-0.5 text-[12px] text-app-text-muted">
                                                    {f.live
                                                        ? `${f.live.mode} · ${f.live.alt.toFixed(0)}m · ${f.live.battery.toFixed(0)}%`
                                                        : 'connecting…'}
                                                </div>
                                            </button>
                                        )
                                    })}
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
                                onRename={isFounder ? renameDrone : null}
                                onClose={() => watch(null)}
                                control={canTakeover(watched.workspace_id) ? {
                                    mine: !!watched.takeover && (mySessionId
                                        ? watched.takeover.staff_session_id === mySessionId
                                        : watched.takeover.user_id === user?.id),
                                    note: takeoverNote,
                                    lastResult,
                                    send: (action, extra) => sendTo(watched.session_id, action, extra),
                                    takeOver: () => takeOver(watched.session_id),
                                    release: () => release(watched.session_id),
                                } : null}
                            />
                        )}
                        {!watched && watchedFleet && (
                            <FleetDetailPanel
                                drone={watchedFleet}
                                name={fleetName(watchedFleet)}
                                copiedUid={copiedUid}
                                onCopyUid={copyUid}
                                onClose={() => watch(null)}
                            />
                        )}
                    </>
                )}

                {tab === 'drones' && (
                    <div className="flex-1 flex flex-col md:flex-row min-w-0">
                        {/* Selector column */}
                        <div className="w-full md:w-80 shrink-0 border-b md:border-b-0 md:border-r border-app-border bg-app-surface flex flex-col max-h-[45vh] md:max-h-none">
                            <div className="p-3 space-y-2 border-b border-app-border">
                                <select
                                    value={selectedDroneId ?? ''}
                                    onChange={e => selectDrone(e.target.value || null)}
                                    className="w-full bg-app-surface-2 border border-app-border-strong rounded-md px-2 h-8 text-[13px] text-app-text"
                                >
                                    <option value="">Select a drone</option>
                                    {drones.map(d => (
                                        <option key={d.id} value={d.id}>
                                            {d.name} {onlineUids.has(d.hardware_uid) ? '● online' : ''}
                                        </option>
                                    ))}
                                </select>
                                <div className="flex items-center gap-2 bg-app-surface-2 border border-app-border-strong rounded-md px-2">
                                    <Search size={12} className="text-app-text-muted" />
                                    <input
                                        value={search}
                                        onChange={e => setSearch(e.target.value)}
                                        placeholder="search name / uid…"
                                        className="flex-1 bg-transparent h-8 text-[13px] text-app-text outline-none placeholder:text-app-text-subtle"
                                    />
                                </div>
                            </div>
                            <div className="flex-1 overflow-y-auto p-2 space-y-2">
                                {filteredDrones.length === 0 && (
                                    <div className="text-[12px] text-app-text-muted p-2">
                                        {drones.length === 0
                                            ? 'No drones yet. A drone is added the first time it connects.'
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
                                                'w-full text-left border rounded-md p-2.5 transition-colors duration-[120ms] ' +
                                                (selectedDroneId === d.id
                                                    ? 'border-app-accent bg-app-accent-soft'
                                                    : 'border-app-border hover:border-app-text-subtle')
                                            }
                                        >
                                            <div className="flex flex-wrap items-center gap-1.5 text-[14px]">
                                                <span className={online ? 'text-app-ok' : 'text-app-text-muted'}>●</span>
                                                <span className="font-semibold text-app-text truncate">{d.name}</span>
                                                {d.is_simulated && <Tag label="SIM" tone="amber" />}
                                            </div>
                                            <div className="mt-1 text-[12px] text-app-text-muted">
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
                                <div className="h-full flex flex-col items-center justify-center gap-2 text-[14px] text-app-text-muted">
                                    <Plane size={22} aria-hidden />
                                    Select a drone to inspect it
                                </div>
                            ) : (
                                <div className="max-w-2xl mx-auto p-5 space-y-4">
                                    <div className="flex items-center gap-3">
                                        <span className="text-[22px] font-bold text-app-text">
                                            {selectedDrone.name}
                                        </span>
                                        {selectedDrone.is_simulated && <Tag label="SIM" tone="amber" />}
                                        {selectedDroneSession
                                            ? <Tag label="Online" tone="emerald" />
                                            : <Tag label="Offline" tone="zinc" />}
                                        {selectedDroneSession?.live?.armed && <Tag label="ARMED" tone="red" />}
                                        <button
                                            onClick={() => renameDrone(selectedDrone)}
                                            className="ml-auto h-8 px-3 rounded-md border border-app-border-strong text-[13px] font-semibold transition-colors duration-[120ms] text-app-text-muted hover:border-app-text-subtle"
                                        >
                                            Rename
                                        </button>
                                        {selectedDroneSession && (
                                            <button
                                                onClick={() => { setTab('overview'); watch(selectedDroneSession.session_id) }}
                                                className="h-8 px-3 rounded-md border border-app-accent/60 text-[13px] font-semibold transition-colors duration-[120ms] text-app-accent hover:border-app-accent"
                                            >
                                                Show on map
                                            </button>
                                        )}
                                    </div>

                                    <div className="border border-app-border rounded-[10px] bg-app-surface p-3 space-y-1.5 text-[12px] text-app-text-muted">
                                        <div className="text-[12px] font-bold uppercase tracking-[0.04em]">IDENTITY</div>
                                        <Uid uid={selectedDrone.hardware_uid}
                                            copied={copiedUid === selectedDrone.hardware_uid} onCopy={copyUid} />
                                        <div className="text-app-text-muted">
                                            first seen {fmtDate(selectedDrone.first_seen)} · last seen {fmtDate(selectedDrone.last_seen)}
                                        </div>
                                        {selectedDroneSession?.approx_location && (
                                            <div className="text-app-text-muted">
                                                client near {[selectedDroneSession.approx_location.city,
                                                    selectedDroneSession.approx_location.country].filter(Boolean).join(', ')}
                                            </div>
                                        )}
                                    </div>

                                    {/* Live video + flight data when online */}
                                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                        <div className="border border-app-border rounded-[10px] bg-app-surface overflow-hidden">
                                            <div className="px-3 min-h-10 py-2 text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted border-b border-app-border flex items-center gap-2">VIDEO</div>
                                            {selectedDroneSession && frameUrl ? (
                                                // eslint-disable-next-line @next/next/no-img-element
                                                <img src={frameUrl} alt="drone video" className="w-full" />
                                            ) : (
                                                <div className="aspect-video flex items-center justify-center text-[12px] text-app-text-muted">
                                                    {!selectedDroneSession
                                                        ? 'Drone is offline'
                                                        : selectedDroneSession.is_streaming
                                                            ? 'Waiting for frames…'
                                                            : 'Client is not streaming video'}
                                                </div>
                                            )}
                                        </div>
                                        <div className="border border-app-border rounded-[10px] bg-app-surface">
                                            <div className="px-3 min-h-10 py-2 text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted border-b border-app-border flex items-center gap-2">FLIGHT DATA</div>
                                            {selectedDroneSession && telem ? (
                                                <TelemGrid telem={telem} />
                                            ) : (
                                                <div className="p-3 text-[12px] text-app-text-muted">
                                                    {!selectedDroneSession
                                                        ? 'Drone is offline'
                                                        : 'Waiting for telemetry…'}
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    {/* Flight history */}
                                    <div className="border border-app-border rounded-[10px] bg-app-surface">
                                        <div className="px-3 min-h-10 py-2 text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted border-b border-app-border flex items-center gap-2">
                                            RECENT FLIGHTS - {flights.length}
                                        </div>
                                        {flights.length === 0 ? (
                                            <div className="p-3 text-[12px] text-app-text-muted">
                                                No flights yet. Each arm-to-disarm is saved with its track.
                                            </div>
                                        ) : (
                                            <div className="divide-y divide-app-border">
                                                {flights.map(f => (
                                                    <div key={f.id}>
                                                        <button
                                                            onClick={() => void openFlight(f.id)}
                                                            className={
                                                                'w-full text-left px-3 min-h-10 py-2 text-[13px] flex items-center gap-3 tabular-nums transition-colors duration-[120ms] hover:bg-app-surface-2 ' +
                                                                (flightDetail?.flight.id === f.id ? 'bg-app-surface-2' : '')
                                                            }
                                                        >
                                                            <span className="text-app-text tabular-nums">{fmtDate(f.started_at)}</span>
                                                            {f.in_progress ? (
                                                                <Tag label="IN FLIGHT" tone="emerald" />
                                                            ) : (
                                                                <span className="text-app-text-muted">{fmtDur(f.duration_s)}</span>
                                                            )}
                                                            <span className="text-app-text-muted">
                                                                {f.max_alt_m.toFixed(0)}m max · {(f.distance_m / 1000).toFixed(2)}km
                                                            </span>
                                                            {f.crossed_orange && (
                                                                <AlertTriangle size={14} className="text-app-warn" aria-label="Passed through orange zone" />
                                                            )}
                                                            {f.crossed_red && (
                                                                <AlertTriangle size={14} className="text-app-danger" aria-label="Entered red zone" />
                                                            )}
                                                            <span className="ml-auto text-app-text-muted">
                                                                {flightDetail?.flight.id === f.id ? '▾' : '▸'}
                                                            </span>
                                                        </button>
                                                        {flightDetail?.flight.id === f.id && (
                                                            <div className="px-3 pb-3 space-y-2">
                                                                <div className="h-56 rounded-md overflow-hidden border border-app-border">
                                                                    <FlightTrackMap track={flightDetail.track} />
                                                                </div>
                                                                <div className="flex items-center gap-3 text-[12px]">
                                                                    {/* A button, not <a href>: the route needs the bearer. */}
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => { void apiDownload(`/api/flights/${f.id}/download`, `flight_${f.id}.csv`) }}
                                                                        className="px-2 py-1 rounded-md border border-app-border-strong text-app-text hover:border-app-accent hover:text-app-accent"
                                                                    >
                                                                        Download CSV
                                                                    </button>
                                                                    {f.crossed_orange && (
                                                                        <span className="flex items-center gap-1 text-app-warn"><AlertTriangle size={12} aria-hidden /> Crossed orange zone</span>
                                                                    )}
                                                                    {f.crossed_red && (
                                                                        <span className="flex items-center gap-1 text-app-danger"><AlertTriangle size={12} aria-hidden /> Entered red zone</span>
                                                                    )}
                                                                </div>
                                                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[12px] text-app-text-muted tabular-nums">
                                                                    <div>SAMPLES <span className="text-app-text">{flightDetail.flight.samples_count}</span></div>
                                                                    <div>MAX ALT <span className="text-app-text">{flightDetail.flight.max_alt_m.toFixed(1)}m</span></div>
                                                                    <div>DIST <span className="text-app-text">{(flightDetail.flight.distance_m / 1000).toFixed(2)}km</span></div>
                                                                    <div>
                                                                        MIN BATT{' '}
                                                                        <span className="text-app-text">
                                                                            {flightDetail.track.length > 0
                                                                                ? Math.min(...flightDetail.track.map(s => s.battery)).toFixed(0)
                                                                                : '-'}%
                                                                        </span>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    <PermitsBlock />
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {tab === 'zones' && (
                    <div className="flex-1 relative min-w-0">
                        <ZoneEditor zones={zones} onChanged={() => void refreshZones()} />
                    </div>
                )}

                {tab === 'workspaces' && <WorkspacesTab zones={zones} />}
                {tab === 'staff' && <StaffTab zones={zones} />}
                {tab === 'audit' && <AuditTab />}

                {tab === 'permits' && (
                    <div className="flex-1 overflow-y-auto p-5">
                        <div className="max-w-3xl mx-auto space-y-6">
                            {permitError && (
                                <div role="alert" className="text-[13px] text-app-danger bg-app-danger-soft border border-app-danger/50 rounded-[10px] p-3">{permitError}</div>
                            )}
                            <section className="space-y-2">
                                <h2 className="text-[18px] font-bold text-app-text">
                                    Waiting for a decision <span className="tabular-nums text-app-text-muted">{permits.filter(p => p.status === 'pending').length}</span>
                                </h2>
                                {permits.filter(p => p.status === 'pending').length === 0 && (
                                    <div className="flex items-center gap-2 text-[14px] text-app-text-muted border border-app-border rounded-[10px] bg-app-surface p-4"
                                        title="A pilot whose plan crosses an orange or red zone in your area asks from the Mission tab; the request appears here.">
                                        <FileCheck size={16} aria-hidden /> Nothing to decide right now
                                    </div>
                                )}
                                {permits.filter(p => p.status === 'pending').map(p => (
                                    <div key={p.id} className="border border-app-warn/50 rounded-[10px] bg-app-surface p-4 space-y-2 text-[13px]">
                                        <div className="flex items-center gap-3 flex-wrap">
                                            <span className="font-semibold text-app-text">{p.workspace_name || p.workspace_id.slice(0, 8)}</span>
                                            <span className="text-app-text-muted">{p.drone_name ?? (p.drone_id ? p.drone_id.slice(0, 8) : 'any drone')}</span>
                                            <span className="text-app-text-muted">{p.kind === 'area' ? 'area' : `${p.waypoint_count} waypoints`}</span>
                                            <span className="text-app-text-muted">by {p.requested_by_name || '-'} {fmtDate(p.requested_at)}</span>
                                        </div>
                                        <div className="text-app-text border-l-2 border-app-border-strong pl-2">
                                            &ldquo;{p.description}&rdquo;
                                        </div>
                                        <div className="text-[12px] text-app-text-muted">
                                            window {fmtDate(p.valid_from)} to {fmtDate(p.valid_until)}
                                        </div>
                                        <div className="text-[12px] flex flex-wrap gap-x-3">
                                            {p.zones.map(z => (
                                                <span key={z.id} className={z.zone_class === 'red' ? 'text-app-danger' : 'text-app-warn'}>
                                                    {z.zone_class} zone: {z.name}
                                                </span>
                                            ))}
                                        </div>
                                        {p.can_decide ? (
                                            <div className="flex items-center gap-2">
                                                <label className="sr-only" htmlFor={`note-${p.id}`}>Note to the pilot</label>
                                                <input id={`note-${p.id}`} value={permitNotes[p.id] ?? ''} maxLength={500}
                                                    onChange={e => setPermitNotes(n => ({ ...n, [p.id]: e.target.value }))}
                                                    placeholder="Note to the pilot (optional)"
                                                    className="flex-1 min-w-0 bg-app-surface-2 border border-app-border rounded-md px-2 h-8 text-[13px] text-app-text outline-none focus:border-app-accent" />
                                                <button
                                                    onClick={() => void decidePermit(p.id, true)}
                                                    className="h-8 px-3 rounded-md border border-app-ok/50 bg-app-ok-soft text-[13px] font-semibold text-app-ok hover:border-app-ok transition-colors duration-[120ms]"
                                                >
                                                    Approve
                                                </button>
                                                <button
                                                    onClick={() => void decidePermit(p.id, false)}
                                                    className="h-8 px-3 rounded-md border border-app-danger/50 text-[13px] font-semibold text-app-danger hover:bg-app-danger-soft transition-colors duration-[120ms]"
                                                >
                                                    Deny
                                                </button>
                                            </div>
                                        ) : (
                                            <div className="text-[12px] text-app-text-muted">You requested this one; another reviewer decides it.</div>
                                        )}
                                    </div>
                                ))}
                            </section>

                            <section className="space-y-2">
                                <h2 className="text-[18px] font-bold text-app-text">History</h2>
                                {permits.filter(p => p.status !== 'pending').length === 0 && (
                                    <div className="text-[13px] text-app-text-muted p-2">No decided permits yet.</div>
                                )}
                                {permits.filter(p => p.status !== 'pending').map(p => {
                                    const tone = PERMIT_TONE[p.status_effective] ?? PERMIT_TONE.pending
                                    return (
                                        <div key={p.id} className="border border-app-border rounded-[10px] bg-app-surface min-h-11 px-3 py-2 flex items-center gap-3 text-[13px]">
                                            <span className="inline-flex items-center h-6 px-2 rounded-full border text-[12px] font-bold shrink-0" style={{ color: tone.fg, borderColor: `${tone.fg}66` }}>
                                                {tone.label}
                                            </span>
                                            <span className="text-app-text shrink-0">{p.workspace_name || p.workspace_id.slice(0, 8)}</span>
                                            <span className="text-app-text-muted truncate min-w-0" title={p.decision_note || p.description}>
                                                {p.description}{p.decision_note ? ` - ${p.decided_by_name ? `${p.decided_by_name}: ` : ''}${p.decision_note}` : ''}
                                            </span>
                                            <span className="ml-auto text-app-text-muted shrink-0">until {fmtDate(p.valid_until)}</span>
                                            {p.status === 'approved' && p.can_decide && p.status_effective !== 'expired' && (
                                                <button onClick={() => void decidePermit(p.id, false)}
                                                    className="h-8 px-3 rounded-md border border-app-danger/50 text-[13px] font-semibold text-app-danger hover:bg-app-danger-soft transition-colors duration-[120ms] shrink-0">
                                                    Revoke
                                                </button>
                                            )}
                                        </div>
                                    )
                                })}
                            </section>
                        </div>
                    </div>
                )}
            </main>
        </div>
    )
}

// ── Detail panel (map tab) ───────────────────────────────────────────────
type ControlProps = {
    /** This console holds the session's takeover. */
    mine: boolean
    note: string | null
    lastResult: { action: string; ok: boolean; error?: string } | null
    send: (action: string, extra?: Record<string, unknown>) => void
    takeOver: () => void
    release: () => void
} | null

const LINK_LABELS: Record<string, string> = {
    client_relay: 'client relay', rf_bridge: 'RF bridge', server_udp: 'server sim (udp)',
    server_direct: 'server link',
}

function DetailPanel({
    session, telem, frameUrl, copiedUid, onCopyUid, onRename, onClose, control,
}: {
    session: SessionInfo
    telem: Telem | null
    frameUrl: string | null
    copiedUid: string | null
    onCopyUid: (u: string) => void
    onRename: ((d: DroneRecord) => void) | null
    onClose: () => void
    control: ControlProps
}) {
    return (
        <section className="w-full md:w-96 shrink-0 border-t md:border-t-0 md:border-l border-app-border bg-app-surface overflow-y-auto max-h-[60vh] md:max-h-none">
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-app-border sticky top-0 bg-app-surface z-10 flex-wrap">
                <span className="text-[18px] font-bold text-app-text truncate">
                    {session.drone?.name ?? session.session_id.slice(0, 8)}
                </span>
                {session.drone?.is_simulated && <Tag label="SIM" tone="amber" />}
                {session.live?.armed && <Tag label="ARMED" tone="red" />}
                {session.live?.zone_class === 'orange' && <Tag label="ORANGE ZONE" tone="amber" />}
                {session.live?.zone_class === 'red' && <Tag label="RED ZONE" tone="red" />}
                <button onClick={onClose} className="ml-auto grid place-items-center size-8 rounded-md text-app-text-muted hover:text-app-text hover:bg-app-surface-2" title="Close" aria-label="Close">
                    <X size={18} />
                </button>
            </div>

            <dl className="border-b border-app-border px-3 py-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                <dt className="text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted self-center">WORKSPACE</dt><dd className="text-app-text min-w-0 truncate">{session.workspace_name || '-'}</dd>
                <dt className="text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted self-center">USER</dt>
                <dd className="text-app-text min-w-0 truncate">{session.username ?? '-'}{session.role ? ` (${session.role})` : ''}{session.staff ? ' · staff' : ''}</dd>
                <dt className="text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted self-center">LINK</dt><dd className="text-app-text min-w-0">{session.link_kind ? (LINK_LABELS[session.link_kind] ?? session.link_kind) : 'none'}</dd>
                <dt className="text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted self-center">AI MODE</dt><dd className="text-app-text min-w-0">{session.ai_mode}</dd>
                <dt className="text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted self-center">STATE</dt>
                <dd className="text-app-text min-w-0">{session.in_air ? 'In air' : session.armed ? 'Armed' : 'On ground'}{session.detached ? ' · client away' : ''}</dd>
            </dl>

            {control && session.telemetry_connected && <ControlBlock session={session} telem={telem} control={control} />}
            {!control && session.takeover && (
                <div className="border-b border-app-border px-3 py-2 text-[12px] text-app-danger">
                    HYRAK operations ({session.takeover.by}) hold this drone.
                </div>
            )}

            <div className="border-b border-app-border">
                <div className="px-3 pt-3 pb-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted">Video</div>
                {frameUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={frameUrl} alt="session video" className="w-full" />
                ) : (
                    <div className="aspect-video flex items-center justify-center text-[12px] text-app-text-muted">
                        {session.is_streaming ? 'Waiting for frames…' : 'Client is not streaming video'}
                    </div>
                )}
            </div>

            <div className="border-b border-app-border pb-2">
                <div className="px-3 pt-3 pb-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted">Flight data</div>
                {telem ? (
                    <TelemGrid telem={telem} />
                ) : (
                    <div className="px-3 text-[12px] text-app-text-muted">
                        {session.telemetry_connected ? 'Waiting for telemetry…' : 'No telemetry connected'}
                    </div>
                )}
            </div>

            <div className="border-b border-app-border px-3 py-2 space-y-1.5 text-[12px]">
                <div className="text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted">IDENTITY</div>
                {session.hardware_uid ? (
                    <Uid uid={session.hardware_uid}
                        copied={copiedUid === session.hardware_uid} onCopy={onCopyUid} />
                ) : (
                    <div className="text-app-text-muted">UID not resolved</div>
                )}
                <div className="text-app-text-muted">session {session.session_id}</div>
                {session.approx_location && (
                    <div className="text-app-text-muted">
                        client near {[session.approx_location.city, session.approx_location.country]
                            .filter(Boolean).join(', ')}
                    </div>
                )}
                {session.drone_address && (
                    <div className="text-app-text-muted break-all">{session.drone_address}</div>
                )}
                {session.drone && onRename && (
                    <button
                        onClick={() => onRename(session.drone!)}
                        className="mt-1 h-8 px-3 rounded-md border border-app-border-strong text-[13px] font-semibold transition-colors duration-[120ms] text-app-text-muted hover:border-app-text-subtle"
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

// Staff control of a watched session (docs/ACCESS_MODEL.md 8b "Takeover").
// HOLD / RTL / LAND go straight to the drone through the session's own
// safety path. "Take control" puts the session in TAKEOVER: the customer's
// commands are refused and the flight controls below act on their drone
// until "Release". Releasing sends nothing: the drone keeps its mode.
function ControlBlock({ session, telem, control }: { session: SessionInfo; telem: Telem | null; control: NonNullable<ControlProps> }) {
    const [alt, setAlt] = useState(5)
    const [confirming, setConfirming] = useState(false)
    const heldByOther = !!session.takeover && !control.mine
    const btn = 'min-h-8 px-2 py-1 rounded-md border text-[13px] font-bold transition-colors duration-[120ms] disabled:cursor-not-allowed disabled:border-dashed disabled:border-app-border-strong disabled:text-app-text-muted'
    return (
        <div className="border-b border-app-border px-3 py-2 space-y-2">
            <div className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted">
                CONTROL
                {control.mine && <Tag label="YOU HAVE CONTROL" tone="red" />}
                {heldByOther && <Tag label={`HELD BY ${session.takeover!.by.toUpperCase()}`} tone="amber" />}
            </div>
            <div className="grid grid-cols-3 gap-1.5">
                <button className={btn + ' border-app-warn/50 text-app-warn hover:border-app-warn'}
                    disabled={heldByOther} onClick={() => control.send('hold')}>HOLD</button>
                <button className={btn + ' border-app-accent/60 text-app-accent hover:border-app-accent'}
                    disabled={heldByOther} onClick={() => control.send('return')}>RTL</button>
                <button className={btn + ' border-app-danger/50 text-app-danger hover:border-app-danger'}
                    disabled={heldByOther} onClick={() => control.send('land')}>LAND</button>
            </div>
            {!session.takeover && (confirming ? (
                <div className="flex gap-1.5">
                    <button className={btn + ' flex-1 border-app-danger/50 bg-app-danger-soft text-app-danger'}
                        onClick={() => { setConfirming(false); control.takeOver() }}>
                        Confirm: take control from {session.username ?? 'the pilot'}
                    </button>
                    <button className={btn + ' border-app-border-strong text-app-text-muted'} onClick={() => setConfirming(false)}>Cancel</button>
                </div>
            ) : (
                <button className={btn + ' w-full border-app-danger/50 text-app-danger hover:border-app-danger'}
                    onClick={() => setConfirming(true)}>Take control</button>
            ))}
            {control.mine && (
                <>
                    <div className="grid grid-cols-2 gap-1.5">
                        <button className={btn + ' border-app-border-strong text-app-text'} onClick={() => control.send('arm')}>ARM</button>
                        <button className={btn + ' border-app-border-strong text-app-text'} onClick={() => control.send('disarm')}>DISARM</button>
                        <button className={btn + ' border-app-border-strong text-app-text'} onClick={() => control.send('start_mission')}>Start mission</button>
                        <button className={btn + ' border-app-border-strong text-app-text'} onClick={() => control.send('pause_mission')}>Pause mission</button>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <label htmlFor="takeover-alt" className="text-[12px] font-bold text-app-text-muted">Takeoff alt</label>
                        <input id="takeover-alt" type="number" min={1} max={120} value={alt}
                            onChange={e => setAlt(Math.max(1, Math.min(120, Number(e.target.value) || 1)))}
                            className="w-16 h-8 bg-app-surface-2 border border-app-border-strong rounded-md px-1.5 text-[13px] tabular-nums text-app-text" />
                        <span className="text-[12px] text-app-text-muted">m</span>
                        <button className={btn + ' ml-auto border-app-border-strong text-app-text'}
                            onClick={() => control.send('takeoff', { altitude: alt })}>TAKEOFF</button>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <label htmlFor="takeover-mode" className="text-[12px] font-bold text-app-text-muted">Mode</label>
                        <select id="takeover-mode" value="" aria-label="Set flight mode"
                            onChange={e => { if (e.target.value) control.send('set_mode', { mode: e.target.value }) }}
                            className="flex-1 h-8 bg-app-surface-2 border border-app-border-strong rounded-md px-1.5 text-[13px] text-app-text">
                            <option value="">{telem?.flight_mode.mode ?? 'set mode'}</option>
                            {FLIGHT_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                        </select>
                    </div>
                    <button className={btn + ' w-full border-app-ok/50 text-app-ok hover:border-app-ok'}
                        onClick={control.release}>Release control</button>
                </>
            )}
            {control.lastResult && (
                <div className={'text-[12px] ' + (control.lastResult.ok ? 'text-app-ok' : 'text-app-danger')}>
                    {control.lastResult.action}: {control.lastResult.ok ? 'done' : (control.lastResult.error ?? 'refused')}
                </div>
            )}
            {control.note && <div className="text-[12px] text-app-warn">{control.note}</div>}
        </div>
    )
}

// Detail view for a swarm SITL drone - server-side connection, so no client
// video/session to mirror; shows live telemetry from the fleet poll instead.
function FleetDetailPanel({
    drone, name, copiedUid, onCopyUid, onClose,
}: {
    drone: FleetDroneInfo
    name: string
    copiedUid: string | null
    onCopyUid: (u: string) => void
    onClose: () => void
}) {
    const l = drone.live
    return (
        <section className="w-full md:w-96 shrink-0 border-t md:border-t-0 md:border-l border-app-border bg-app-surface overflow-y-auto max-h-[60vh] md:max-h-none">
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-app-border sticky top-0 bg-app-surface z-10 flex-wrap">
                <span className="text-[18px] font-bold text-app-text truncate">{name}</span>
                <Tag label="SIM" tone="violet" />
                {l?.armed && <Tag label="ARMED" tone="red" />}
                {l?.zone_class === 'orange' && <Tag label="ORANGE ZONE" tone="amber" />}
                {l?.zone_class === 'red' && <Tag label="RED ZONE" tone="red" />}
                <button onClick={onClose} className="ml-auto grid place-items-center size-8 rounded-md text-app-text-muted hover:text-app-text hover:bg-app-surface-2" title="Close" aria-label="Close">
                    <X size={18} />
                </button>
            </div>

            <div className="border-b border-app-border pb-2">
                <div className="px-3 pt-3 pb-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted">Flight data</div>
                {l ? (
                    <div className="px-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px] tabular-nums">
                        <span className="text-app-text-muted">MODE</span><span className="text-app-text">{l.mode}</span>
                        <span className="text-app-text-muted">ALT</span><span className="text-app-text">{l.alt.toFixed(1)} m</span>
                        <span className="text-app-text-muted">HDG</span><span className="text-app-text">{l.heading.toFixed(0)}°</span>
                        <span className="text-app-text-muted">BATT</span><span className="text-app-text">{l.battery.toFixed(0)}%</span>
                        <span className="text-app-text-muted">LAT</span><span className="text-app-text">{l.lat.toFixed(6)}</span>
                        <span className="text-app-text-muted">LNG</span><span className="text-app-text">{l.lng.toFixed(6)}</span>
                        <span className="text-app-text-muted">STATE</span>
                        <span className="text-app-text">
                            {l.in_air ? 'In air' : l.armed ? 'Armed' : 'On ground'}
                        </span>
                    </div>
                ) : (
                    <div className="px-3 text-[12px] text-app-text-muted">Waiting for telemetry…</div>
                )}
            </div>

            <div className="border-b border-app-border px-3 py-2 space-y-1.5 text-[12px]">
                <div className="text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted">IDENTITY</div>
                <Uid uid={drone.hardware_uid}
                    copied={copiedUid === drone.hardware_uid} onCopy={onCopyUid} />
                <div className="text-app-text-muted">
                    Simulated fleet drone · PX4 SITL instance {drone.drone_id}
                </div>
                <div className="text-app-text-muted">
                    Connected server-side (UDP) - no client session, no video feed.
                </div>
            </div>
        </section>
    )
}

// Permissions structure - populated once the geofencing phase lands.
function PermitsBlock() {
    return (
        <div className="border border-app-border rounded-[10px] bg-app-surface p-3 space-y-2 text-[12px]">
            <div className="text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted">Permissions</div>
            <div className="text-[13px] text-app-text-muted">
                Per-drone permits are not tracked yet. Zone permit requests are in the Permits tab.
            </div>
        </div>
    )
}

function TelemGrid({ telem }: { telem: Telem }) {
    return (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-3 py-2">
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

function fmtDur(s: number): string {
    if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
    if (s >= 60) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
    return `${Math.floor(s)}s`
}

function fmtDate(iso: string | null): string {
    if (!iso) return '-'
    const d = new Date(iso)
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

function Uid({ uid, copied, onCopy }: { uid: string; copied: boolean; onCopy: (u: string) => void }) {
    return (
        <button
            onClick={() => onCopy(uid)}
            title="Click to copy full UID"
            className="font-code text-[12px] text-app-accent hover:underline break-all text-left rounded-sm"
        >
            {copied ? 'Copied' : `UID ${uid}`}
        </button>
    )
}

function Badge({ on, label }: { on: boolean; label: string }) {
    return (
        <span className={'inline-flex items-center gap-1 font-semibold ' + (on ? 'text-app-ok' : 'text-app-text-muted')}
            title={`${label}: ${on ? 'on' : 'off'}`}>
            {on ? <CheckCircle2 size={12} aria-hidden /> : <Circle size={12} aria-hidden />} {label}
        </span>
    )
}

function Stat({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
    return (
        <div className="flex justify-between gap-2 border-b border-app-border pb-1">
            <span className="text-[12px] font-bold uppercase tracking-[0.04em] text-app-text-muted">{k}</span>
            <span className={'text-[13px] font-semibold tabular-nums ' + (accent ? 'text-app-ok' : 'text-app-text')}>{v}</span>
        </div>
    )
}

/** Every focusable control in the console gets the app's 2px accent ring. */
const FOCUS_SCOPE = '[&_:focus-visible]:outline-2 [&_:focus-visible]:outline-offset-2 [&_:focus-visible]:outline-[var(--app-accent)]'

/** Light / dark switch for the console rail, same choice as the app's rail. */
function ConsoleThemeToggle() {
    const { theme, setTheme } = useTheme()
    const mounted = useHydrated()
    if (!mounted) return <div className="w-12 h-12" />
    const isDark = theme !== 'light'
    return (
        <button onClick={() => setTheme(isDark ? 'light' : 'dark')}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="flex flex-col items-center gap-1 w-12 py-2 rounded-md text-[12px] font-semibold text-app-text-muted hover:text-app-text hover:bg-app-surface-2 transition-colors duration-[120ms]">
            {isDark ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
            {isDark ? 'Light' : 'Dark'}
        </button>
    )
}
