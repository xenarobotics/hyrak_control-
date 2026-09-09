'use client'

// /deliveries - the dispatch board: every delivery order in the system,
// its lifecycle, and the levers to move it. This is the OPERATOR's view;
// client applications see the same orders through the public /v1 API and
// never reach this page.
//
// Three tabs:
//   ORDERS - live board (polled), timeline per order, lifecycle actions
//   PADS   - the named locations clients order between
//   KEYS   - client application API keys (plaintext shown exactly once)

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import {
    Package, MapPin, KeyRound, Plus, RefreshCw, X, Copy, Check,
    AlertTriangle, ChevronDown, ChevronRight, RotateCw, Play, Loader, Plane, Home,
    ChevronsRight, ChevronsLeft, Map as MapIcon, SlidersHorizontal,
} from 'lucide-react'
import { getServerUrl } from '@/lib/server-url'
import { getSocket } from '@/lib/socket'
import { claimSocket, releaseSocket, socketOwner } from '@/lib/socketClaim'
import { useDroneStore } from '@/store/drone'
import type { MapDroneLive, MapRoute, MapSelection } from '@/components/deliveries/DeliveryMap'

const RegionEditor = dynamic(() => import('@/components/deliveries/RegionEditor'), {
    ssr: false,
    loading: () => (
        <div className="h-64 flex items-center justify-center">
            <p className="text-xs font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>
                Loading editor...
            </p>
        </div>
    ),
})

// Leaflet touches `window` - client only
const DeliveryMap = dynamic(() => import('@/components/deliveries/DeliveryMap'), {
    ssr: false,
    loading: () => (
        <div className="h-full w-full rounded-lg border flex items-center justify-center"
            style={{ borderColor: 'hsl(var(--app-border))' }}>
            <p className="text-xs font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>
                Loading map...
            </p>
        </div>
    ),
})

const TOKEN = process.env.NEXT_PUBLIC_SECRET_TOKEN || ''

// Mirrors backend app/tasks/service.py ALLOWED_NEXT - which buttons an
// order offers. The backend re-checks every transition; this only decides
// what to render.
const NEXT_STATUS: Record<string, string[]> = {
    received:   ['cancelled'],
    planned:    ['assigned', 'cancelled'],
    assigned:   ['to_pickup', 'cancelled'],
    to_pickup:  ['loading', 'returned', 'failed'],
    loading:    ['to_dropoff', 'returned', 'failed'],
    to_dropoff: ['delivered', 'returned', 'failed'],
    delivered: [], returned: [], failed: [], cancelled: [],
}

const STATUS_ORDER = [
    'to_pickup', 'loading', 'to_dropoff', 'assigned', 'planned', 'received',
    'delivered', 'returned', 'failed', 'cancelled',
]

const STATUS_STYLE: Record<string, { fg: string; bg: string; label: string }> = {
    received:   { fg: '#a1a1aa', bg: '#a1a1aa22', label: 'RECEIVED' },
    planned:    { fg: '#38bdf8', bg: '#38bdf822', label: 'PLANNED' },
    assigned:   { fg: '#a78bfa', bg: '#a78bfa22', label: 'ASSIGNED' },
    to_pickup:  { fg: '#fbbf24', bg: '#fbbf2422', label: 'TO PICKUP' },
    loading:    { fg: '#fb923c', bg: '#fb923c22', label: 'LOADING' },
    to_dropoff: { fg: '#22d3ee', bg: '#22d3ee22', label: 'TO DROPOFF' },
    delivered:  { fg: '#4ade80', bg: '#4ade8022', label: 'DELIVERED' },
    returned:   { fg: '#facc15', bg: '#facc1522', label: 'RETURNED' },
    failed:     { fg: '#f87171', bg: '#f8717122', label: 'FAILED' },
    cancelled:  { fg: '#71717a', bg: '#71717a22', label: 'CANCELLED' },
}

type PadT = {
    id: string; name: string; kind: 'pad' | 'station'; lat: number; lng: number
    notes: string; active: boolean
}
type KeyT = {
    id: string; name: string; prefix: string; active: boolean
    created_at: string | null; last_used_at: string | null
}
type EventT = { t: string | null; status: string; note: string; actor: string }
type WaypointT = {
    lat: number; lng: number; altitude: number; speed: number
    hold_time: number; type: string; yaw: number | null; turn_radius: number
}
type MissionT = {
    id: string; status: string; distance_m: number; est_duration_s: number
    waypoint_count: number
    coverage: { total_m?: number; categories_m?: Record<string, number> }
    waypoints?: WaypointT[]
}
type TaskT = {
    id: string; order_no: string; client_name: string; status: string
    pickup: { name: string; lat: number; lng: number }
    dropoff: { name: string; lat: number; lng: number }
    payload: { description: string; kg: number }
    profile_name: string; mission_id: string | null; drone_id: string | null
    fail_reason: string; archived?: boolean
    created_at: string | null; updated_at: string | null
    events?: EventT[]; mission?: MissionT; mission_to_pickup?: MissionT
}
type DroneT = { id: string; name: string; is_simulated: boolean }
type ProfileT = { id: string; name: string }

function api(path: string) { return `${getServerUrl()}/api${path}` }
const AUTH = { 'X-Auth-Token': TOKEN, 'Content-Type': 'application/json' }

// Parse a response body that may not be JSON (a proxy's HTML 502, an empty
// reply). Raw r.json() throws on those, landing every error in the generic
// "Backend unreachable" catch even though the backend DID answer.
async function jsonOf(r: Response): Promise<Record<string, any>> {
    try { return await r.json() } catch { return {} }
}

// How long a socket-driven flight action may sit in 'uploading'/'starting'
// before the button is given back with an error - without this, a dropped
// link left the START button as a spinner forever.
const SOCKET_ACTION_TIMEOUT_MS = 30_000

function fmtTime(iso: string | null): string {
    if (!iso) return '--'
    const d = new Date(iso)
    return d.toLocaleString([], {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    })
}

function fmtDur(s: number): string {
    if (s < 60) return `${Math.round(s)}s`
    return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}

function StatusChip({ status }: { status: string }) {
    const s = STATUS_STYLE[status] ?? STATUS_STYLE.received
    return (
        <span
            className="font-mono text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap"
            style={{ color: s.fg, background: s.bg, border: `1px solid ${s.fg}55` }}
        >
            {s.label}
        </span>
    )
}

function SectionCard({ children }: { children: React.ReactNode }) {
    return (
        <div
            className="rounded-xl border p-4"
            style={{
                background: 'hsl(var(--app-surface))',
                borderColor: 'hsl(var(--app-border))',
            }}
        >
            {children}
        </div>
    )
}

const inputCls = 'w-full rounded-md border px-2.5 py-1.5 text-sm bg-transparent ' +
    'focus:outline-none focus:ring-1 focus:ring-cyan-500'
const inputStyle = {
    borderColor: 'hsl(var(--app-border))',
    color: 'hsl(var(--app-text))',
    background: 'hsl(var(--app-bg))',
}
const btnPrimary = 'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs ' +
    'font-mono bg-cyan-600 hover:bg-cyan-500 text-white transition-colors ' +
    'disabled:opacity-40 disabled:cursor-not-allowed'
const btnGhost = 'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs ' +
    'font-mono border transition-colors hover:bg-zinc-500/10'

export default function DeliveriesPage() {
    const [tab, setTab] = useState<'orders' | 'regions' | 'profiles' | 'pads' | 'keys'>('orders')

    return (
        <div className="h-full flex flex-col gap-3 overflow-hidden">
            <div className="flex items-center gap-2 shrink-0">
                <Package size={18} className="text-cyan-500" />
                <h1 className="text-base font-semibold tracking-wide">Deliveries</h1>
                <div className="ml-4 flex gap-1">
                    {([
                        ['orders', 'ORDERS', Package],
                        ['regions', 'REGIONS', MapIcon],
                        ['profiles', 'PROFILES', SlidersHorizontal],
                        ['pads', 'PADS', MapPin],
                        ['keys', 'CLIENT KEYS', KeyRound],
                    ] as const).map(([id, label, Icon]) => (
                        <button
                            key={id}
                            onClick={() => setTab(id)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-mono transition-colors"
                            style={tab === id
                                ? { background: '#06b6d418', color: '#06b6d4', border: '1px solid #06b6d455' }
                                : { color: 'hsl(var(--app-text-muted))', border: '1px solid transparent' }}
                        >
                            <Icon size={13} />{label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="flex-1 overflow-y-auto pr-1">
                {tab === 'orders' && <OrdersTab />}
                {tab === 'regions' && <RegionEditor />}
                {tab === 'profiles' && <ProfilesTab />}
                {tab === 'pads' && <PadsTab />}
                {tab === 'keys' && <KeysTab />}
            </div>
        </div>
    )
}

// ── ORDERS ───────────────────────────────────────────────────────────────

// One start in flight at a time - which order, and where it is in the
// upload -> arm+start -> advance sequence.
type StartState = {
    taskId: string
    leg: 'pickup' | 'delivery'
    phase: 'uploading' | 'starting' | 'need_ack'
    msg?: string
}

function OrdersTab() {
    const [tasks, setTasks] = useState<TaskT[]>([])
    const [drones, setDrones] = useState<DroneT[]>([])
    const [pads, setPads] = useState<PadT[]>([])
    const [profiles, setProfiles] = useState<ProfileT[]>([])
    const [openId, setOpenId] = useState<string | null>(null)
    const [detail, setDetail] = useState<TaskT | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [showNew, setShowNew] = useState(false)
    const [liveDrones, setLiveDrones] = useState<MapDroneLive[]>([])
    const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set())
    const [starting, setStarting] = useState<StartState | null>(null)
    const [panelOpen, setPanelOpen] = useState(true)
    const startRef = useRef<StartState | null>(null)
    startRef.current = starting
    const telemetryStatus = useDroneStore(s => s.telemetryStatus)

    const [showArchived, setShowArchived] = useState(false)
    const showArchivedRef = useRef(false)
    showArchivedRef.current = showArchived

    const refresh = useCallback(async () => {
        try {
            const r = await fetch(api(`/tasks${showArchivedRef.current ? '?archived=1' : ''}`))
            const j = await jsonOf(r)
            setTasks(j.tasks ?? [])
        } catch { /* backend away - keep the last board */ }
    }, [])

    useEffect(() => { refresh() }, [showArchived, refresh])

    const loadDetail = useCallback(async (id: string) => {
        try {
            const r = await fetch(api(`/tasks/${id}`))
            if (r.ok) setDetail((await r.json()).task)
        } catch { /* transient */ }
    }, [])

    const [fleetIds, setFleetIds] = useState<Set<string>>(new Set())
    // Waypoints for every order currently holding a drone, so the map draws
    // ALL live routes, not just the expanded row's. Keyed by task id;
    // refetched when that task's status changes (a new leg appears then).
    const [routeCache, setRouteCache] = useState<Map<string, TaskT>>(new Map())

    // Which drones are actually reachable RIGHT NOW - live sessions plus the
    // server-owned station fleet. Feeds the assign dropdown, the map's live
    // markers, and the drones side panel.
    const pollSessions = useCallback(async () => {
        try {
            const r = await fetch(api('/sessions'))
            const j = await jsonOf(r)
            const live: MapDroneLive[] = []
            const ids = new Set<string>()
            const fids = new Set<string>()
            for (const s of j.sessions ?? []) {
                if (s.drone?.id) ids.add(s.drone.id)
                if (s.live && s.drone) {
                    live.push({
                        id: s.drone.id, name: s.drone.name || s.hardware_uid?.slice(0, 8) || 'drone',
                        lat: s.live.lat, lng: s.live.lng, alt: s.live.alt, heading: s.live.heading,
                        battery: s.live.battery, mode: s.live.mode, in_air: s.live.in_air,
                        is_session: true,
                    })
                }
            }
            for (const f of j.fleet_drones ?? []) {
                if (f.db_id) { ids.add(f.db_id); fids.add(f.db_id) }
                if (f.live && f.db_id) {
                    live.push({
                        id: f.db_id, name: f.name || `Fleet ${f.drone_id}`,
                        lat: f.live.lat, lng: f.live.lng, alt: f.live.alt, heading: f.live.heading,
                        battery: f.live.battery, mode: f.live.mode, in_air: f.live.in_air,
                    })
                }
            }
            setLiveDrones(live)
            setOnlineIds(ids)
            setFleetIds(fids)
        } catch { /* keep last known */ }
    }, [])

    // Keep route waypoints fresh for every order that holds a drone.
    useEffect(() => {
        const active = tasks.filter(t =>
            ['assigned', 'to_pickup', 'loading', 'to_dropoff'].includes(t.status))
        let cancelled = false
        ;(async () => {
            for (const t of active) {
                const cached = routeCache.get(t.id)
                if (cached && cached.status === t.status) continue
                try {
                    const r = await fetch(api(`/tasks/${t.id}`))
                    if (!r.ok || cancelled) continue
                    const full = (await r.json()).task as TaskT
                    setRouteCache(prev => new Map(prev).set(t.id, full))
                } catch { /* transient */ }
            }
            setRouteCache(prev => {
                const keep = new Set(active.map(t => t.id))
                if ([...prev.keys()].every(k => keep.has(k))) return prev
                const next = new Map(prev)
                for (const k of next.keys()) if (!keep.has(k)) next.delete(k)
                return next
            })
        })()
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tasks])

    useEffect(() => {
        refresh()
        pollSessions()
        const t = setInterval(refresh, 8000)
        const s = setInterval(pollSessions, 3000)
        fetch(api('/drones')).then(r => r.json())
            .then(j => setDrones(j.drones ?? [])).catch(() => {})
        fetch(api('/pads')).then(r => r.json())
            .then(j => setPads((j.pads ?? []).filter((p: PadT) => p.active))).catch(() => {})
        fetch(api('/planner/meta')).then(r => r.json())
            .then(j => setProfiles(j.profiles ?? [])).catch(() => {})
        return () => { clearInterval(t); clearInterval(s) }
    }, [refresh, pollSessions])

    useEffect(() => {
        if (!openId) { setDetail(null); return }
        loadDetail(openId)
        const t = setInterval(() => loadDetail(openId), 8000)
        return () => clearInterval(t)
    }, [openId, loadDetail])

    async function act(taskId: string, body: Record<string, unknown>) {
        setBusy(true); setError('')
        try {
            const r = await fetch(api(`/tasks/${taskId}`), {
                method: 'PATCH', headers: AUTH, body: JSON.stringify(body),
            })
            if (!r.ok) setError((await jsonOf(r)).detail ?? 'Action failed')
            await refresh()
            await loadDetail(taskId)
        } catch { setError('Backend unreachable') }
        setBusy(false)
    }

    async function archive(taskId: string, archived: boolean) {
        setBusy(true); setError('')
        try {
            const r = await fetch(api(`/tasks/${taskId}`), {
                method: 'PATCH', headers: AUTH, body: JSON.stringify({ archived }),
            })
            if (!r.ok) setError((await jsonOf(r)).detail ?? 'Archive failed')
            await refresh()
        } catch { setError('Backend unreachable') }
        setBusy(false)
    }

    async function removeTask(taskId: string) {
        if (!window.confirm('Delete this order permanently? Flight history and missions are kept.')) return
        setBusy(true); setError('')
        try {
            const r = await fetch(api(`/tasks/${taskId}`), {
                method: 'DELETE', headers: AUTH,
            })
            if (!r.ok) setError((await jsonOf(r)).detail ?? 'Delete failed')
            if (openId === taskId) setOpenId(null)
            await refresh()
        } catch { setError('Backend unreachable') }
        setBusy(false)
    }

    async function replan(taskId: string) {
        setBusy(true); setError('')
        try {
            const r = await fetch(api(`/tasks/${taskId}/replan`), {
                method: 'POST', headers: AUTH,
            })
            const j = await jsonOf(r)
            if (!r.ok) setError(j.detail ?? 'Replan failed')
            else if (!j.ok) setError(j.msg ?? 'Replan failed')
            await refresh()
            await loadDetail(taskId)
        } catch { setError('Backend unreachable') }
        setBusy(false)
    }

    const droneName = useCallback((id: string | null) => {
        if (!id) return null
        return drones.find(d => d.id === id)?.name ?? id.slice(0, 8)
    }, [drones])

    // ── One-click mission start ──────────────────────────────────────────
    // Upload the order's planned route through THIS session's telemetry
    // link, arm + start the mission, then advance the order to to_pickup.
    // The cloud model means the radio lives with the browser, so the
    // dispatch board can only fly the drone this session is connected to.

    useEffect(() => {
        const socket = getSocket()

        const onUploadResult = (r: {
            ok: boolean; msg?: string; needs_ack?: boolean; blocked?: string
            zones?: { name: string }[]
        }) => {
            if (socketOwner() !== 'orders') return
            const pending = startRef.current
            if (!pending || pending.phase !== 'uploading') return
            if (r.ok) {
                setStarting({ ...pending, phase: 'starting' })
                socket.emit('drone_action', { action: 'arm_and_start_mission' })
            } else if (r.needs_ack) {
                releaseSocket('orders')
                const names = (r.zones ?? []).map(z => z.name).join(', ')
                setStarting({
                    ...pending, phase: 'need_ack',
                    msg: `Route crosses orange zone${names ? `: ${names}` : 's'}`,
                })
            } else {
                releaseSocket('orders')
                setStarting(null)
                setError(r.msg || 'Mission upload failed')
            }
        }

        const onActionResult = (r: { action: string; ok: boolean; msg?: string; error?: string }) => {
            if (socketOwner() !== 'orders') return
            const pending = startRef.current
            if (!pending || pending.phase !== 'starting') return
            if (r.action !== 'arm_and_start_mission') return
            releaseSocket('orders')
            setStarting(null)
            if (r.ok) {
                void act(pending.taskId, {
                    status: pending.leg === 'pickup' ? 'to_pickup' : 'to_dropoff',
                    note: pending.leg === 'pickup'
                        ? 'Pickup flight started from dispatch board'
                        : 'Delivery flight started from dispatch board',
                })
            } else {
                setError(r.msg || r.error || 'Could not arm and start the mission')
            }
        }

        socket.on('mission_upload_result', onUploadResult)
        socket.on('action_result', onActionResult)
        return () => {
            socket.off('mission_upload_result', onUploadResult)
            socket.off('action_result', onActionResult)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Give the button back if the socket result never arrives (link dropped
    // mid-upload) - a spinner with no timeout needed a page reload before.
    useEffect(() => {
        if (!starting || (starting.phase !== 'uploading' && starting.phase !== 'starting')) return
        const snap = starting
        const t = setTimeout(() => {
            if (startRef.current === snap) {
                releaseSocket('orders')
                setStarting(null)
                setError('No response from the drone link - the action timed out. Check the connection and try again.')
            }
        }, SOCKET_ACTION_TIMEOUT_MS)
        return () => clearTimeout(t)
    }, [starting])

    const startLeg = useCallback(async (task: TaskT, leg: 'pickup' | 'delivery',
                                        ackOrange: boolean) => {
        const src = detail?.id === task.id ? detail : routeCache.get(task.id)
        const m = leg === 'pickup' ? src?.mission_to_pickup : src?.mission
        const waypoints = m?.waypoints
        if (!waypoints || waypoints.length < 2) {
            setError('Route not loaded yet - try again in a moment')
            return
        }
        setError('')
        const nextStatus = leg === 'pickup' ? 'to_pickup' : 'to_dropoff'
        const note = leg === 'pickup'
            ? 'Pickup flight started from dispatch board'
            : 'Delivery flight started from dispatch board'

        // Station-fleet drones fly through the server (no browser radio in
        // the loop) - the board is fully self-contained for them.
        if (task.drone_id && fleetIds.has(task.drone_id)) {
            setStarting({ taskId: task.id, leg, phase: 'uploading' })
            try {
                const r = await fetch(api(`/fleet/${task.drone_id}/fly`), {
                    method: 'POST', headers: AUTH,
                    body: JSON.stringify({ waypoints, ack_orange: ackOrange }),
                })
                const j = await jsonOf(r)
                if (j.ok) {
                    setStarting(null)
                    void act(task.id, { status: nextStatus, note })
                } else if (j.needs_ack) {
                    setStarting({ taskId: task.id, leg, phase: 'need_ack', msg: j.msg })
                } else {
                    setStarting(null)
                    setError(j.msg || 'Fleet mission start failed')
                }
            } catch {
                setStarting(null)
                setError('Backend unreachable')
            }
            return
        }

        // A session drone flies through the browser holding its radio.
        if (telemetryStatus !== 'connected') {
            setError('No telemetry link in this session - connect the drone on the Fly tab first')
            return
        }
        setStarting({ taskId: task.id, leg, phase: 'uploading' })
        claimSocket('orders')
        getSocket().emit('upload_mission', {
            terrain_follow: false,
            waypoints,
            ...(ackOrange ? { ack_orange: true } : {}),
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [detail, routeCache, fleetIds, telemetryStatus])

    // What the map highlights: the open order's planned route, if loaded.
    const selection: MapSelection =
        openId && detail?.id === openId && detail.mission?.waypoints?.length
            ? {
                order_no: detail.order_no,
                pickup: detail.pickup, dropoff: detail.dropoff,
                waypoints: detail.mission.waypoints,
            }
            : null

    // Every live order's route for the map - positioning legs while the
    // drone heads to pickup, delivery legs from loading onward. The
    // expanded row's route renders emphasized.
    const routes: MapRoute[] = []
    for (const [id, full] of routeCache) {
        const sel = id === openId
        if (full.mission_to_pickup?.waypoints?.length
                && ['assigned', 'to_pickup'].includes(full.status)) {
            routes.push({
                key: `${id}-p`, order_no: full.order_no, leg: 'pickup',
                waypoints: full.mission_to_pickup.waypoints, selected: sel,
            })
        }
        if (full.mission?.waypoints?.length) {
            routes.push({
                key: `${id}-d`, order_no: full.order_no, leg: 'delivery',
                waypoints: full.mission.waypoints, selected: sel,
            })
        }
    }

    // Which drone is on which order, with a rough time-to-free estimate
    // (the current leg's planned duration + a loading allowance) so the
    // assign dropdown can say "busy, free in ~N min" instead of hiding it.
    const busyInfo = new Map<string, { order_no: string; eta_min: number }>()
    for (const t of tasks) {
        if (!t.drone_id || !['assigned', 'to_pickup', 'loading', 'to_dropoff'].includes(t.status)) continue
        const full = routeCache.get(t.id)
        const legS = (t.status === 'assigned' || t.status === 'to_pickup')
            ? (full?.mission_to_pickup?.est_duration_s ?? 60) + (full?.mission?.est_duration_s ?? 120) + 120
            : (full?.mission?.est_duration_s ?? 120) + 60
        busyInfo.set(t.drone_id, { order_no: t.order_no, eta_min: Math.max(1, Math.ceil(legS / 60)) })
    }

    // Drones stamped with the order they're carrying, for the map labels.
    const mapDrones: MapDroneLive[] = liveDrones.map(d => ({
        ...d,
        order_no: tasks.find(t => t.drone_id === d.id &&
            ['assigned', 'to_pickup', 'loading', 'to_dropoff'].includes(t.status)
        )?.order_no ?? null,
    }))

    const inFlight = tasks.filter(t =>
        ['to_pickup', 'loading', 'to_dropoff'].includes(t.status))

    return (
        <div className="flex flex-col xl:flex-row gap-3 xl:h-full">
            <div className="xl:flex-1 min-w-0 flex flex-col gap-3 xl:overflow-y-auto xl:pr-1">
            <div className="flex items-center gap-2">
                <button className={btnPrimary} onClick={() => setShowNew(v => !v)}>
                    <Plus size={13} /> NEW ORDER
                </button>
                <button className={btnGhost} style={{ borderColor: 'hsl(var(--app-border))' }}
                    onClick={refresh}>
                    <RefreshCw size={13} /> REFRESH
                </button>
                <button className={btnGhost}
                    style={showArchived
                        ? { borderColor: '#06b6d455', color: '#06b6d4' }
                        : { borderColor: 'hsl(var(--app-border))' }}
                    title="Include shelved orders in the list"
                    onClick={() => setShowArchived(v => !v)}>
                    ARCHIVED
                </button>
                <span className="ml-auto flex items-center gap-1.5 flex-wrap">
                    {Object.entries(
                        tasks.reduce<Record<string, number>>((acc, t) => {
                            acc[t.status] = (acc[t.status] ?? 0) + 1; return acc
                        }, {})
                    ).sort((a, b) => STATUS_ORDER.indexOf(a[0]) - STATUS_ORDER.indexOf(b[0]))
                        .map(([s, n]) => (
                            <span key={s} className="px-1.5 py-0.5 rounded text-[10px] font-mono"
                                style={{ color: STATUS_STYLE[s]?.fg, background: STATUS_STYLE[s]?.bg }}>
                                {n} {STATUS_STYLE[s]?.label ?? s}
                            </span>
                        ))}
                    <span className="text-[11px] font-mono"
                        style={{ color: 'hsl(var(--app-text-muted))' }}>
                        {onlineIds.size} drone{onlineIds.size === 1 ? '' : 's'} online
                    </span>
                </span>
            </div>

            {error && (
                <div className="flex items-center gap-2 text-xs rounded-md px-3 py-2"
                    style={{ color: '#f87171', background: '#f8717115', border: '1px solid #f8717155' }}>
                    <AlertTriangle size={14} /> {error}
                    <button className="ml-auto" onClick={() => setError('')}><X size={13} /></button>
                </div>
            )}

            {showNew && (
                <NewOrderForm pads={pads.filter(p => p.kind !== 'station')} profiles={profiles}
                    onDone={() => { setShowNew(false); refresh() }}
                    onError={setError} />
            )}

            <SectionCard>
                {tasks.length === 0 ? (
                    <p className="text-sm py-6 text-center"
                        style={{ color: 'hsl(var(--app-text-muted))' }}>
                        No orders yet. Create one here, or through the client API
                        (POST /v1/tasks).
                    </p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-[10px] font-mono"
                                    style={{ color: 'hsl(var(--app-text-muted))' }}>
                                    <th className="pb-2 pr-2 w-6"></th>
                                    <th className="pb-2 pr-3">ORDER</th>
                                    <th className="pb-2 pr-3">ROUTE</th>
                                    <th className="pb-2 pr-3">STATUS</th>
                                    <th className="pb-2">DRONE</th>
                                </tr>
                            </thead>
                            <tbody>
                                {tasks.map(t => (
                                    <OrderRow key={t.id} task={t}
                                        open={openId === t.id}
                                        detail={openId === t.id ? detail : null}
                                        droneName={droneName}
                                        drones={drones}
                                        onlineIds={onlineIds}
                                        fleetIds={fleetIds}
                                        busyInfo={busyInfo}
                                        busy={busy}
                                        starting={starting}
                                        telemetryConnected={telemetryStatus === 'connected'}
                                        onToggle={() => setOpenId(openId === t.id ? null : t.id)}
                                        onAct={act}
                                        onReplan={replan}
                                        onStart={startLeg}
                                        onArchive={archive}
                                        onDelete={removeTask}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </SectionCard>
            </div>

            {/* CENTER: the operational picture - map on top, live-mission
                strip beneath it whenever anything is airborne. */}
            <div className="shrink-0 xl:w-[38%] min-w-0 flex flex-col gap-2 h-[440px] xl:h-auto">
                <div className="flex-1 min-h-0">
                    <DeliveryMap pads={pads} selection={selection}
                        drones={mapDrones} routes={routes} />
                </div>
                {inFlight.length > 0 && (
                    <div className="shrink-0 flex gap-2 overflow-x-auto pb-1">
                        {inFlight.map(t => {
                            const d = mapDrones.find(x => x.id === t.drone_id)
                            return (
                                <button key={t.id}
                                    onClick={() => setOpenId(openId === t.id ? null : t.id)}
                                    className="shrink-0 flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-zinc-500/5"
                                    style={{
                                        background: 'hsl(var(--app-surface))',
                                        borderColor: openId === t.id ? '#06b6d4' : 'hsl(var(--app-border))',
                                    }}>
                                    <span className="font-mono text-xs text-cyan-500">{t.order_no}</span>
                                    <StatusChip status={t.status} />
                                    <span className="font-mono text-[10px]"
                                        style={{ color: 'hsl(var(--app-text-muted))' }}>
                                        {d ? `${d.name} ${Math.round(d.battery)}%${d.in_air ? ' ✈' : ''}`
                                            : 'drone offline'}
                                    </span>
                                </button>
                            )
                        })}
                    </div>
                )}
            </div>

            {/* RIGHT: the fleet, always at hand and hidable. */}
            {panelOpen ? (
                <div className="xl:w-[250px] shrink-0 flex flex-col gap-2 xl:overflow-y-auto">
                    <div className="flex items-center gap-2">
                        <Plane size={13} className="text-cyan-500" />
                        <span className="text-[11px] font-mono">DRONES</span>
                        <button className="ml-auto opacity-60 hover:opacity-100"
                            title="Hide the drones panel"
                            onClick={() => setPanelOpen(false)}>
                            <ChevronsRight size={14} />
                        </button>
                    </div>
                    <DronesPanel />
                </div>
            ) : (
                <button
                    className="shrink-0 self-start rounded-md border p-1.5"
                    title="Show the drones panel"
                    style={{ borderColor: 'hsl(var(--app-border))', color: 'hsl(var(--app-text-muted))' }}
                    onClick={() => setPanelOpen(true)}>
                    <ChevronsLeft size={14} />
                </button>
            )}
        </div>
    )
}

function OrderRow({
    task, open, detail, droneName, drones, onlineIds, fleetIds, busyInfo, busy,
    starting, telemetryConnected, onToggle, onAct, onReplan, onStart, onArchive, onDelete,
}: {
    task: TaskT
    open: boolean
    detail: TaskT | null
    droneName: (id: string | null) => string | null
    drones: DroneT[]
    onlineIds: Set<string>
    fleetIds: Set<string>
    busyInfo: Map<string, { order_no: string; eta_min: number }>
    busy: boolean
    starting: StartState | null
    telemetryConnected: boolean
    onToggle: () => void
    onAct: (id: string, body: Record<string, unknown>) => void
    onReplan: (id: string) => void
    onStart: (task: TaskT, leg: 'pickup' | 'delivery', ackOrange: boolean) => void
    onArchive: (id: string, archived: boolean) => void
    onDelete: (id: string) => void
}) {
    const [assignTo, setAssignTo] = useState('')
    const nexts = NEXT_STATUS[task.status] ?? []
    const canReplan = task.status === 'received' || task.status === 'planned'
    const onlineDrones = drones.filter(d => onlineIds.has(d.id))
    const isFleet = !!task.drone_id && fleetIds.has(task.drone_id)
    const thisStarting = starting?.taskId === task.id ? starting : null
    // Which flight leg the START button launches from the current status:
    // assigned -> the positioning flight to the pickup pad (if one was
    // planned - a drone already sitting at the pickup skips it);
    // loading  -> the delivery flight, once the payload is confirmed on.
    const startLeg: 'pickup' | 'delivery' | null =
        task.status === 'assigned' && detail?.mission_to_pickup?.waypoints?.length
            ? 'pickup'
            : task.status === 'loading' && detail?.mission?.waypoints?.length
                ? 'delivery' : null

    return (
        <>
            <tr
                className="cursor-pointer border-t transition-colors hover:bg-zinc-500/5"
                style={{ borderColor: 'hsl(var(--app-border))' }}
                onClick={onToggle}
            >
                <td className="py-2 pr-2" style={{ color: 'hsl(var(--app-text-muted))' }}>
                    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </td>
                <td className="py-2 pr-3 font-mono text-cyan-500 whitespace-nowrap">{task.order_no}</td>
                <td className="py-2 pr-3 text-xs">
                    {task.pickup.name}
                    <span style={{ color: 'hsl(var(--app-text-muted))' }}> to </span>
                    {task.dropoff.name}
                </td>
                <td className="py-2 pr-3"><StatusChip status={task.status} /></td>
                <td className="py-2 text-xs font-mono whitespace-nowrap">{droneName(task.drone_id) ?? '--'}</td>
            </tr>
            {open && (
                <tr style={{ borderColor: 'hsl(var(--app-border))' }}>
                    <td colSpan={5} className="pb-4">
                        <div className="mx-2 mt-1 rounded-lg border p-4 grid gap-4 md:grid-cols-[1fr_1fr]"
                            style={{ borderColor: 'hsl(var(--app-border))', background: 'hsl(var(--app-bg))' }}>
                            <p className="text-xs md:col-span-2" style={{ color: 'hsl(var(--app-text-muted))' }}>
                                {task.client_name}
                                {task.payload.description && <> - {task.payload.description}</>}
                                {task.payload.kg > 0 && <span className="font-mono"> {task.payload.kg} kg</span>}
                                <span className="font-mono"> - {fmtTime(task.created_at)}</span>
                            </p>
                            {/* Timeline */}
                            <div>
                                <p className="text-[10px] font-mono mb-2"
                                    style={{ color: 'hsl(var(--app-text-muted))' }}>TIMELINE</p>
                                {(detail?.events ?? []).length === 0 ? (
                                    <p className="text-xs" style={{ color: 'hsl(var(--app-text-muted))' }}>loading...</p>
                                ) : (
                                    <ol className="space-y-1.5">
                                        {(detail?.events ?? []).map((e, i) => (
                                            <li key={i} className="flex items-start gap-2 text-xs">
                                                <span className="mt-1 w-1.5 h-1.5 rounded-full shrink-0"
                                                    style={{ background: STATUS_STYLE[e.status]?.fg ?? '#a1a1aa' }} />
                                                <span className="font-mono whitespace-nowrap"
                                                    style={{ color: 'hsl(var(--app-text-muted))' }}>
                                                    {fmtTime(e.t)}
                                                </span>
                                                <span className="font-mono"
                                                    style={{ color: STATUS_STYLE[e.status]?.fg }}>
                                                    {STATUS_STYLE[e.status]?.label ?? e.status}
                                                </span>
                                                {e.note && <span style={{ color: 'hsl(var(--app-text-muted))' }}>{e.note}</span>}
                                            </li>
                                        ))}
                                    </ol>
                                )}
                                {task.fail_reason && (
                                    <p className="mt-2 text-xs flex items-center gap-1.5" style={{ color: '#f87171' }}>
                                        <AlertTriangle size={12} /> {task.fail_reason}
                                    </p>
                                )}
                            </div>

                            {/* Route + actions */}
                            <div className="flex flex-col gap-3">
                                <div>
                                    <p className="text-[10px] font-mono mb-2"
                                        style={{ color: 'hsl(var(--app-text-muted))' }}>ROUTE</p>
                                    {detail?.mission ? (
                                        <div className="text-xs space-y-1">
                                            <p><span className="font-mono">{detail.mission.distance_m.toFixed(0)} m</span>
                                                <span style={{ color: 'hsl(var(--app-text-muted))' }}> over </span>
                                                <span className="font-mono">{detail.mission.waypoint_count} waypoints</span>
                                                <span style={{ color: 'hsl(var(--app-text-muted))' }}>, about </span>
                                                <span className="font-mono">{fmtDur(detail.mission.est_duration_s)}</span>
                                                <span style={{ color: 'hsl(var(--app-text-muted))' }}> with profile </span>
                                                {task.profile_name || 'Direct'}</p>
                                            {detail.mission.coverage?.categories_m &&
                                                Object.keys(detail.mission.coverage.categories_m).length > 0 && (
                                                <p style={{ color: 'hsl(var(--app-text-muted))' }}>
                                                    Ground cover: {Object.entries(detail.mission.coverage.categories_m)
                                                        .sort((a, b) => b[1] - a[1]).slice(0, 3)
                                                        .map(([c, m]) => `${c} ${(100 * m / (detail.mission!.coverage.total_m || 1)).toFixed(0)}%`)
                                                        .join(', ')}
                                                </p>
                                            )}
                                        </div>
                                    ) : (
                                        <p className="text-xs" style={{ color: 'hsl(var(--app-text-muted))' }}>
                                            No route planned yet.
                                        </p>
                                    )}
                                </div>

                                <div>
                                    <p className="text-[10px] font-mono mb-2"
                                        style={{ color: 'hsl(var(--app-text-muted))' }}>ACTIONS</p>
                                    <div className="flex flex-wrap items-center gap-2">
                                        {task.status === 'planned' && (
                                            onlineDrones.length === 0 ? (
                                                <span className="text-xs" style={{ color: 'hsl(var(--app-text-muted))' }}>
                                                    No drones online - connect one on the Fly tab to assign.
                                                </span>
                                            ) : (
                                                <span className="flex items-center gap-1.5">
                                                    <select
                                                        className="rounded-md border px-2 py-1 text-xs bg-transparent"
                                                        style={inputStyle}
                                                        value={assignTo}
                                                        onChange={e => setAssignTo(e.target.value)}
                                                    >
                                                        <option value="">assign online drone...</option>
                                                        {onlineDrones
                                                            .filter(d => !busyInfo.has(d.id))
                                                            .map(d => (
                                                                <option key={d.id} value={d.id}>
                                                                    {d.name}{d.is_simulated ? ' (sim)' : ''} - idle
                                                                </option>
                                                            ))}
                                                        {onlineDrones
                                                            .filter(d => busyInfo.has(d.id))
                                                            .map(d => {
                                                                const b = busyInfo.get(d.id)!
                                                                return (
                                                                    <option key={d.id} value={d.id}>
                                                                        {d.name} - on {b.order_no}, free in ~{b.eta_min} min
                                                                    </option>
                                                                )
                                                            })}
                                                    </select>
                                                    <button className={btnPrimary} disabled={busy || !assignTo}
                                                        onClick={() => onAct(task.id, { status: 'assigned', drone_id: assignTo })}>
                                                        ASSIGN
                                                    </button>
                                                </span>
                                            )
                                        )}
                                        {startLeg && (
                                            thisStarting?.phase === 'need_ack' ? (
                                                <button className={btnPrimary} disabled={busy}
                                                    style={{ background: '#f59e0b', borderColor: '#f59e0b' }}
                                                    title={thisStarting.msg}
                                                    onClick={() => onStart(task, startLeg, true)}>
                                                    <AlertTriangle size={12} /> CONFIRM ORANGE &amp; START
                                                </button>
                                            ) : thisStarting ? (
                                                <span className="flex items-center gap-1.5 text-xs font-mono"
                                                    style={{ color: '#22d3ee' }}>
                                                    <Loader size={12} className="animate-spin" />
                                                    {thisStarting.phase === 'uploading' ? 'UPLOADING MISSION' : 'ARMING + STARTING'}
                                                </span>
                                            ) : (
                                                <button className={btnPrimary}
                                                    disabled={busy || (!isFleet && !telemetryConnected)}
                                                    title={isFleet || telemetryConnected
                                                        ? 'Upload this leg, arm, and start the flight'
                                                        : 'Connect the drone on the Fly tab first'}
                                                    onClick={() => onStart(task, startLeg, false)}>
                                                    <Play size={12} />
                                                    {startLeg === 'pickup' ? 'START PICKUP FLIGHT' : 'START DELIVERY FLIGHT'}
                                                </button>
                                            )
                                        )}
                                        {(task.status === 'assigned' || task.status === 'loading')
                                            && !isFleet && !telemetryConnected && !thisStarting && (
                                            <span className="text-xs" style={{ color: 'hsl(var(--app-text-muted))' }}>
                                                Telemetry not connected in this session.
                                            </span>
                                        )}
                                        {nexts
                                            .filter(s => s !== 'assigned')
                                            // A transition a FLIGHT button owns must not also exist
                                            // as a bare status click - that was how an order went
                                            // "to pickup" while its drone never left the station.
                                            .filter(s => !(startLeg === 'pickup' && s === 'to_pickup'))
                                            .filter(s => !(startLeg === 'delivery' && s === 'to_dropoff'))
                                            .map(s => (
                                            <button key={s} className={btnGhost} disabled={busy}
                                                title="Manually mark the order - does NOT fly anything"
                                                style={{
                                                    borderColor: `${STATUS_STYLE[s].fg}66`,
                                                    color: STATUS_STYLE[s].fg,
                                                }}
                                                onClick={() => onAct(task.id, { status: s })}>
                                                MARK {STATUS_STYLE[s].label}
                                            </button>
                                        ))}
                                        {canReplan && (
                                            <button className={btnGhost} disabled={busy}
                                                style={{ borderColor: 'hsl(var(--app-border))' }}
                                                onClick={() => onReplan(task.id)}>
                                                <RotateCw size={12} /> REPLAN
                                            </button>
                                        )}
                                        {nexts.length === 0 && (
                                            <>
                                                <button className={btnGhost} disabled={busy}
                                                    style={{ borderColor: 'hsl(var(--app-border))' }}
                                                    title={task.archived
                                                        ? 'Bring the order back onto the board'
                                                        : 'Shelve the order - it leaves the board but stays in the database'}
                                                    onClick={() => onArchive(task.id, !task.archived)}>
                                                    {task.archived ? 'UNARCHIVE' : 'ARCHIVE'}
                                                </button>
                                                <button className={btnGhost} disabled={busy}
                                                    style={{ borderColor: '#f8717166', color: '#f87171' }}
                                                    title="Permanently delete the order and its timeline (flight history stays)"
                                                    onClick={() => onDelete(task.id)}>
                                                    <X size={12} /> DELETE
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </td>
                </tr>
            )}
        </>
    )
}

function NewOrderForm({ pads, profiles, onDone, onError }: {
    pads: PadT[]
    profiles: ProfileT[]
    onDone: () => void
    onError: (msg: string) => void
}) {
    const [pickup, setPickup] = useState('')
    const [dropoff, setDropoff] = useState('')
    const [desc, setDesc] = useState('')
    const [kg, setKg] = useState('')
    const [profile, setProfile] = useState('')
    const [busy, setBusy] = useState(false)

    async function submit() {
        setBusy(true)
        try {
            const r = await fetch(api('/tasks'), {
                method: 'POST', headers: AUTH,
                body: JSON.stringify({
                    pickup, dropoff,
                    payload: { description: desc, kg: parseFloat(kg) || 0 },
                    profile: profile || undefined,
                }),
            })
            if (!r.ok) onError((await jsonOf(r)).detail ?? 'Order creation failed')
            else onDone()
        } catch { onError('Backend unreachable') }
        setBusy(false)
    }

    return (
        <SectionCard>
            <p className="text-[10px] font-mono mb-3" style={{ color: 'hsl(var(--app-text-muted))' }}>
                NEW ORDER (operator-created; client apps use POST /v1/tasks)
            </p>
            <div className="grid gap-2 md:grid-cols-5">
                <select className={inputCls} style={inputStyle} value={pickup}
                    onChange={e => setPickup(e.target.value)}>
                    <option value="">pickup pad...</option>
                    {pads.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <select className={inputCls} style={inputStyle} value={dropoff}
                    onChange={e => setDropoff(e.target.value)}>
                    <option value="">dropoff pad...</option>
                    {pads.filter(p => p.id !== pickup).map(p =>
                        <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input className={inputCls} style={inputStyle} placeholder="payload description"
                    value={desc} onChange={e => setDesc(e.target.value)} />
                <input className={inputCls} style={inputStyle} placeholder="kg" type="number"
                    min="0" step="0.1" value={kg} onChange={e => setKg(e.target.value)} />
                <select className={inputCls} style={inputStyle} value={profile}
                    onChange={e => setProfile(e.target.value)}>
                    <option value="">route profile: auto</option>
                    {profiles.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
                </select>
            </div>
            <div className="mt-3">
                <button className={btnPrimary} disabled={busy || !pickup || !dropoff}
                    onClick={submit}>
                    <Plus size={13} /> CREATE ORDER
                </button>
            </div>
        </SectionCard>
    )
}

// ── DRONES ───────────────────────────────────────────────────────────────
// The fleet from dispatch's point of view: who is online, where, on which
// order, and the lever to send an idle drone home to its station. Built
// entirely from data the board already speaks: /drones (registry),
// /sessions (live links), /tasks (who is busy).

type ReturnState = { droneId: string; phase: 'planning' | 'uploading' | 'starting' }

function DronesPanel() {
    const [drones, setDrones] = useState<DroneT[]>([])
    const [live, setLive] = useState<Map<string, MapDroneLive>>(new Map())
    const [tasks, setTasks] = useState<TaskT[]>([])
    const [error, setError] = useState('')
    const [ret, setRet] = useState<ReturnState | null>(null)
    const [fleetIds, setFleetIds] = useState<Set<string>>(new Set())
    const [connectingFleet, setConnectingFleet] = useState(false)
    const retRef = useRef<ReturnState | null>(null)
    retRef.current = ret
    const telemetryStatus = useDroneStore(st => st.telemetryStatus)

    const refresh = useCallback(async () => {
        try {
            const [dr, se, ta] = await Promise.all([
                fetch(api('/drones')).then(r => r.json()),
                fetch(api('/sessions')).then(r => r.json()),
                fetch(api('/tasks')).then(r => r.json()),
            ])
            setDrones(dr.drones ?? [])
            setTasks(ta.tasks ?? [])
            const m = new Map<string, MapDroneLive>()
            const fids = new Set<string>()
            for (const sess of se.sessions ?? []) {
                if (sess.live && sess.drone) {
                    m.set(sess.drone.id, {
                        id: sess.drone.id, name: sess.drone.name || '',
                        lat: sess.live.lat, lng: sess.live.lng,
                        heading: sess.live.heading, battery: sess.live.battery,
                        mode: sess.live.mode, in_air: sess.live.in_air,
                    })
                }
            }
            for (const f of se.fleet_drones ?? []) {
                if (f.db_id) fids.add(f.db_id)
                if (f.db_id && f.live) {
                    m.set(f.db_id, {
                        id: f.db_id, name: f.name || `Fleet ${f.drone_id}`,
                        lat: f.live.lat, lng: f.live.lng, heading: f.live.heading,
                        battery: f.live.battery, mode: f.live.mode, in_air: f.live.in_air,
                    })
                }
            }
            setLive(m)
            setFleetIds(fids)
        } catch { /* keep last */ }
    }, [])

    useEffect(() => {
        refresh()
        const t = setInterval(refresh, 5000)
        return () => clearInterval(t)
    }, [refresh])

    // Return-to-station: plan (REST) -> upload + arm/start (socket).
    useEffect(() => {
        const socket = getSocket()
        const onUpload = (r: { ok: boolean; msg?: string; needs_ack?: boolean }) => {
            if (socketOwner() !== 'drones-panel') return
            const pending = retRef.current
            if (!pending || pending.phase !== 'uploading') return
            if (r.ok) {
                setRet({ ...pending, phase: 'starting' })
                socket.emit('drone_action', { action: 'arm_and_start_mission' })
            } else {
                releaseSocket('drones-panel')
                setRet(null)
                setError(r.needs_ack
                    ? 'Return route crosses an orange zone - fly it from the Mission tab with an explicit ack'
                    : (r.msg || 'Return mission upload failed'))
            }
        }
        const onAction = (r: { action: string; ok: boolean; msg?: string; error?: string }) => {
            if (socketOwner() !== 'drones-panel') return
            const pending = retRef.current
            if (!pending || pending.phase !== 'starting') return
            if (r.action !== 'arm_and_start_mission') return
            releaseSocket('drones-panel')
            setRet(null)
            if (!r.ok) setError(r.msg || r.error || 'Could not start the return flight')
        }
        socket.on('mission_upload_result', onUpload)
        socket.on('action_result', onAction)
        return () => {
            socket.off('mission_upload_result', onUpload)
            socket.off('action_result', onAction)
        }
    }, [])

    async function returnToStation(droneId: string) {
        setError('')
        setRet({ droneId, phase: 'planning' })
        try {
            const r = await fetch(api(`/drones/${droneId}/return-mission`), {
                method: 'POST', headers: AUTH,
            })
            const j = await jsonOf(r)
            if (!r.ok) { setRet(null); setError(j.detail ?? 'Return planning failed'); return }
            const waypoints = j.mission?.waypoints
            if (!waypoints || waypoints.length < 2) {
                setRet(null); setError('Already at (or next to) the station'); return
            }
            setRet({ droneId, phase: 'uploading' })
            if (fleetIds.has(droneId)) {
                // Station drone - flown by the server, no browser radio needed.
                const fr = await fetch(api(`/fleet/${droneId}/fly`), {
                    method: 'POST', headers: AUTH,
                    body: JSON.stringify({ waypoints }),
                })
                const fj = await jsonOf(fr)
                setRet(null)
                if (!fj.ok) setError(fj.msg || 'Return flight failed to start')
                return
            }
            claimSocket('drones-panel')
            getSocket().emit('upload_mission', { terrain_follow: false, waypoints })
        } catch { setRet(null); setError('Backend unreachable') }
    }

    // Same no-response guard as the orders board: never leave the RETURN
    // button as a spinner because a socket result got lost.
    useEffect(() => {
        if (!ret || (ret.phase !== 'uploading' && ret.phase !== 'starting')) return
        const snap = ret
        const t = setTimeout(() => {
            if (retRef.current === snap) {
                releaseSocket('drones-panel')
                setRet(null)
                setError('No response from the drone link - the return timed out. Try again.')
            }
        }, SOCKET_ACTION_TIMEOUT_MS)
        return () => clearTimeout(t)
    }, [ret])

    const [fleetCount, setFleetCount] = useState(5)
    const [adoptPort, setAdoptPort] = useState('')

    async function connectFleet() {
        setConnectingFleet(true); setError('')
        try {
            const r = await fetch(api('/fleet/connect'), {
                method: 'POST', headers: AUTH, body: JSON.stringify({ count: fleetCount }),
            })
            if (!r.ok) setError((await jsonOf(r)).detail ?? 'Fleet connect failed')
            await refresh()
        } catch { setError('Backend unreachable') }
        setConnectingFleet(false)
    }

    const activeTaskFor = (droneId: string) =>
        tasks.find(t => t.drone_id === droneId &&
            ['assigned', 'to_pickup', 'loading', 'to_dropoff'].includes(t.status))
    const doneCount = (droneId: string) =>
        tasks.filter(t => t.drone_id === droneId && t.status === 'delivered').length

    const online = drones.filter(d => live.has(d.id))
    const offline = drones.filter(d => !live.has(d.id))

    return (
        <div className="flex flex-col gap-3">
            {error && (
                <div className="flex items-center gap-2 text-xs rounded-md px-3 py-2"
                    style={{ color: '#f87171', background: '#f8717115', border: '1px solid #f8717155' }}>
                    <AlertTriangle size={14} /> {error}
                    <button className="ml-auto" onClick={() => setError('')}><X size={13} /></button>
                </div>
            )}

            <div className="grid gap-2 grid-cols-1">
                {online.map(d => {
                    const lv = live.get(d.id)!
                    const task = activeTaskFor(d.id)
                    const returning = ret?.droneId === d.id ? ret : null
                    return (
                        <SectionCard key={d.id}>
                            <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full"
                                    style={{ background: lv.in_air ? '#fbbf24' : '#4ade80' }} />
                                <span className="font-mono text-sm">{d.name || lv.name}</span>
                                {d.is_simulated && (
                                    <span className="font-mono text-[9px] px-1.5 rounded"
                                        style={{ color: '#a78bfa', background: '#a78bfa22' }}>SIM</span>
                                )}
                                <span className="ml-auto font-mono text-[10px]"
                                    style={{ color: lv.in_air ? '#fbbf24' : '#4ade80' }}>
                                    {lv.in_air ? 'IN AIR' : 'ON GROUND'}
                                </span>
                            </div>
                            <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] font-mono">
                                <div>
                                    <p style={{ color: 'hsl(var(--app-text-muted))' }}>BATTERY</p>
                                    <p style={{ color: lv.battery < 25 ? '#f87171' : 'hsl(var(--app-text))' }}>
                                        {Math.round(lv.battery)}%
                                    </p>
                                </div>
                                <div>
                                    <p style={{ color: 'hsl(var(--app-text-muted))' }}>MODE</p>
                                    <p>{lv.mode}</p>
                                </div>
                                <div>
                                    <p style={{ color: 'hsl(var(--app-text-muted))' }}>DELIVERED</p>
                                    <p>{doneCount(d.id)}</p>
                                </div>
                            </div>
                            <div className="mt-2 text-xs">
                                {task ? (
                                    <p>
                                        <span className="font-mono text-cyan-500">{task.order_no}</span>
                                        <span style={{ color: 'hsl(var(--app-text-muted))' }}> - </span>
                                        <StatusChip status={task.status} />
                                    </p>
                                ) : (
                                    <p style={{ color: 'hsl(var(--app-text-muted))' }}>
                                        Idle - next in line for dispatch.
                                    </p>
                                )}
                            </div>
                            {!task && (
                                <div className="mt-3">
                                    {returning ? (
                                        <span className="flex items-center gap-1.5 text-xs font-mono"
                                            style={{ color: '#22d3ee' }}>
                                            <Loader size={12} className="animate-spin" />
                                            {returning.phase === 'planning' ? 'PLANNING RETURN'
                                                : returning.phase === 'uploading' ? 'UPLOADING' : 'STARTING'}
                                        </span>
                                    ) : (
                                        <button className={btnGhost}
                                            style={{ borderColor: '#fbbf2466', color: '#fbbf24' }}
                                            disabled={!fleetIds.has(d.id) && telemetryStatus !== 'connected'}
                                            title={fleetIds.has(d.id) || telemetryStatus === 'connected'
                                                ? 'Plan and fly this drone home to the nearest station'
                                                : 'Connect the drone on the Fly tab first'}
                                            onClick={() => returnToStation(d.id)}>
                                            <Home size={12} /> RETURN TO STATION
                                        </button>
                                    )}
                                </div>
                            )}
                        </SectionCard>
                    )
                })}
            </div>

            {online.length === 0 && (
                <SectionCard>
                    <p className="text-xs py-2 text-center" style={{ color: 'hsl(var(--app-text-muted))' }}>
                        No drones online.
                    </p>
                </SectionCard>
            )}

            <div className="flex items-center gap-1.5">
                <button className={`${btnGhost} flex-1`}
                    style={{ borderColor: 'hsl(var(--app-border))' }}
                    disabled={connectingFleet}
                    title="Connect station drones to the SERVER. The watchdog also re-adopts them automatically every 25 s - this button just does it now."
                    onClick={connectFleet}>
                    {connectingFleet
                        ? <><Loader size={12} className="animate-spin" /> CONNECTING</>
                        : <><Plane size={12} /> CONNECT FLEET</>}
                </button>
                <select className="rounded-md border px-1.5 py-1.5 text-xs bg-transparent font-mono"
                    style={inputStyle} value={fleetCount}
                    onChange={e => setFleetCount(parseInt(e.target.value))}>
                    {[1, 2, 3, 4, 5, 6, 7, 8].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
            </div>
            <div className="flex items-center gap-1.5">
                <input className="flex-1 rounded-md border px-2 py-1.5 text-xs bg-transparent font-mono"
                    style={inputStyle} placeholder="udp port (e.g. 14546)"
                    value={adoptPort} onChange={e => setAdoptPort(e.target.value)} />
                <button className={btnGhost}
                    style={{ borderColor: 'hsl(var(--app-border))' }}
                    disabled={!adoptPort || connectingFleet}
                    title="Manually adopt one drone by its MAVLink UDP port - new SITL instance or a real air unit's telemetry ingress"
                    onClick={async () => {
                        setError('')
                        try {
                            const r = await fetch(api('/fleet/adopt'), {
                                method: 'POST', headers: AUTH,
                                body: JSON.stringify({ port: parseInt(adoptPort) }),
                            })
                            if (!r.ok) setError((await jsonOf(r)).detail ?? 'Adopt failed')
                            else { setAdoptPort(''); await refresh() }
                        } catch { setError('Backend unreachable') }
                    }}>
                    ADD
                </button>
            </div>
            <p className="text-[9px] font-mono -mt-1" style={{ color: 'hsl(var(--app-text-muted))' }}>
                Links auto-heal: a restarted drone or server reconnects itself.
                New drones on ports 14541-14548 are adopted automatically;
                other ports via ADD. Video attaches with the air-unit ingress
                (not applicable to SITL).
            </p>

            {offline.length > 0 && (
                <SectionCard>
                    <p className="text-[10px] font-mono mb-2"
                        style={{ color: 'hsl(var(--app-text-muted))' }}>
                        OFFLINE ({offline.length})
                    </p>
                    <div className="flex flex-wrap gap-2">
                        {offline.map(d => (
                            <span key={d.id} className="px-2 py-1 rounded-md border text-xs font-mono"
                                style={{ borderColor: 'hsl(var(--app-border))',
                                         color: 'hsl(var(--app-text-muted))' }}>
                                {d.name}{d.is_simulated ? ' (sim)' : ''}
                                {doneCount(d.id) > 0 && ` - ${doneCount(d.id)} delivered`}
                            </span>
                        ))}
                    </div>
                </SectionCard>
            )}
        </div>
    )
}

// ── PROFILES ─────────────────────────────────────────────────────────────
// The tuning page for route profiles: cruise altitude, speed, and how a
// route treats orange zones. Altitude here is what every mission planned
// with that profile flies at - the "altitude ranges for the locations".

type FullProfileT = {
    id: string; name: string; description?: string; builtin?: boolean
    default_alt_m: number; default_speed_m_s: number
    rules: { orange?: { policy?: string; weight?: number };
             categories?: Record<string, { mode: string; weight?: number }> }
}

function ProfilesTab() {
    const [profiles, setProfiles] = useState<FullProfileT[]>([])
    const [edits, setEdits] = useState<Record<string, { alt: string; speed: string; orange: string }>>({})
    const [busy, setBusy] = useState('')
    const [error, setError] = useState('')
    const [saved, setSaved] = useState('')

    const refresh = useCallback(async () => {
        try {
            const r = await fetch(api('/planner/meta'))
            const j = await jsonOf(r)
            setProfiles(j.profiles ?? [])
        } catch { /* transient */ }
    }, [])
    useEffect(() => { refresh() }, [refresh])

    const editFor = (p: FullProfileT) => edits[p.id] ?? {
        alt: String(p.default_alt_m), speed: String(p.default_speed_m_s),
        orange: p.rules?.orange?.policy ?? 'penalize',
    }

    async function save(p: FullProfileT) {
        const e = editFor(p)
        const alt = parseFloat(e.alt)
        if (!(alt >= 5 && alt <= 120)) {
            setError(`${p.name}: altitude must be 5-120 m (drone rules cap at 120 m AGL)`)
            return
        }
        setBusy(p.id); setError(''); setSaved('')
        const rules = { ...(p.rules ?? {}), orange: { ...(p.rules?.orange ?? {}), policy: e.orange } }
        try {
            const r = await fetch(api(`/route-profiles/${p.id}`), {
                method: 'PATCH', headers: AUTH,
                body: JSON.stringify({
                    default_alt_m: alt,
                    default_speed_m_s: parseFloat(e.speed) || 8,
                    rules,
                }),
            })
            if (!r.ok) setError((await jsonOf(r)).detail ?? 'Save failed')
            else { setSaved(p.id); setTimeout(() => setSaved(''), 2500) }
            await refresh()
        } catch { setError('Backend unreachable') }
        setBusy('')
    }

    return (
        <div className="flex flex-col gap-3 max-w-3xl">
            {error && (
                <div className="flex items-center gap-2 text-xs rounded-md px-3 py-2"
                    style={{ color: '#f87171', background: '#f8717115', border: '1px solid #f8717155' }}>
                    <AlertTriangle size={14} /> {error}
                    <button className="ml-auto" onClick={() => setError('')}><X size={13} /></button>
                </div>
            )}
            <p className="text-xs" style={{ color: 'hsl(var(--app-text-muted))' }}>
                Every route planned with a profile flies at its cruise altitude
                and speed. Changes apply to NEW plans (replan an order to pick
                them up). Zones (flight law) are managed on /admin - regions
                (preference) on the REGIONS tab.
            </p>
            {profiles.map(p => {
                const e = editFor(p)
                return (
                    <SectionCard key={p.id}>
                        <div className="flex items-center gap-2">
                            <span className="font-mono text-sm">{p.name}</span>
                            {p.builtin && (
                                <span className="font-mono text-[9px] px-1.5 rounded"
                                    style={{ color: '#a78bfa', background: '#a78bfa22' }}>BUILTIN</span>
                            )}
                            {saved === p.id && (
                                <span className="text-[10px] font-mono text-emerald-500">saved</span>
                            )}
                        </div>
                        {p.description && (
                            <p className="mt-1 text-xs" style={{ color: 'hsl(var(--app-text-muted))' }}>
                                {p.description}
                            </p>
                        )}
                        <div className="mt-3 grid gap-2 sm:grid-cols-4 items-end">
                            <label className="text-[10px] font-mono"
                                style={{ color: 'hsl(var(--app-text-muted))' }}>
                                CRUISE ALT (m AGL)
                                <input className={inputCls + ' mt-1'} style={inputStyle}
                                    type="number" min={5} max={120} step={1} value={e.alt}
                                    onChange={ev => setEdits(prev => ({ ...prev, [p.id]: { ...e, alt: ev.target.value } }))} />
                            </label>
                            <label className="text-[10px] font-mono"
                                style={{ color: 'hsl(var(--app-text-muted))' }}>
                                SPEED (m/s)
                                <input className={inputCls + ' mt-1'} style={inputStyle}
                                    type="number" min={2} max={20} step={0.5} value={e.speed}
                                    onChange={ev => setEdits(prev => ({ ...prev, [p.id]: { ...e, speed: ev.target.value } }))} />
                            </label>
                            <label className="text-[10px] font-mono"
                                style={{ color: 'hsl(var(--app-text-muted))' }}>
                                ORANGE ZONES
                                <select className={inputCls + ' mt-1'} style={inputStyle} value={e.orange}
                                    onChange={ev => setEdits(prev => ({ ...prev, [p.id]: { ...e, orange: ev.target.value } }))}>
                                    <option value="allow">allow</option>
                                    <option value="penalize">penalize (detour if cheap)</option>
                                    <option value="block">block (never enter)</option>
                                </select>
                            </label>
                            <button className={btnPrimary} disabled={busy === p.id}
                                onClick={() => save(p)}>
                                {busy === p.id ? 'SAVING...' : 'SAVE'}
                            </button>
                        </div>
                        {p.rules?.categories && Object.keys(p.rules.categories).length > 0 && (
                            <p className="mt-2 text-[10px] font-mono"
                                style={{ color: 'hsl(var(--app-text-muted))' }}>
                                ground rules: {Object.entries(p.rules.categories)
                                    .map(([c, r]) => `${c}:${r.mode}`).join('  ')}
                            </p>
                        )}
                    </SectionCard>
                )
            })}
        </div>
    )
}

// ── PADS ─────────────────────────────────────────────────────────────────

function PadsTab() {
    const [pads, setPads] = useState<PadT[]>([])
    const [name, setName] = useState('')
    const [kind, setKind] = useState<'pad' | 'station'>('pad')
    const [lat, setLat] = useState('')
    const [lng, setLng] = useState('')
    const [notes, setNotes] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    const refresh = useCallback(async () => {
        try {
            const r = await fetch(api('/pads'))
            setPads((await r.json()).pads ?? [])
        } catch { /* transient */ }
    }, [])
    useEffect(() => { refresh() }, [refresh])

    async function create() {
        setBusy(true); setError('')
        try {
            const r = await fetch(api('/pads'), {
                method: 'POST', headers: AUTH,
                body: JSON.stringify({ name, kind, lat: parseFloat(lat), lng: parseFloat(lng), notes }),
            })
            if (!r.ok) setError((await jsonOf(r)).detail ?? 'Failed')
            else { setName(''); setLat(''); setLng(''); setNotes(''); refresh() }
        } catch { setError('Backend unreachable') }
        setBusy(false)
    }

    async function toggle(p: PadT) {
        await fetch(api(`/pads/${p.id}`), {
            method: 'PATCH', headers: AUTH,
            body: JSON.stringify({ active: !p.active }),
        }).catch(() => {})
        refresh()
    }

    async function remove(p: PadT) {
        if (!window.confirm(`Delete "${p.name}"? Orders that used it keep its name.`)) return
        const r = await fetch(api(`/pads/${p.id}`), { method: 'DELETE', headers: AUTH })
            .catch(() => null)
        if (!r || !r.ok) setError((r && (await jsonOf(r)).detail) || 'Delete failed')
        refresh()
    }

    return (
        <div className="flex flex-col gap-3">
            <SectionCard>
                <p className="text-[10px] font-mono mb-3" style={{ color: 'hsl(var(--app-text-muted))' }}>
                    NEW LOCATION - a PAD is a client-facing pickup/drop point;
                    a STATION is a drone home base (clients never see it)
                </p>
                {error && <p className="text-xs mb-2" style={{ color: '#f87171' }}>{error}</p>}
                <div className="grid gap-2 md:grid-cols-5">
                    <select className={inputCls} style={inputStyle} value={kind}
                        onChange={e => setKind(e.target.value as 'pad' | 'station')}>
                        <option value="pad">pad</option>
                        <option value="station">station</option>
                    </select>
                    <input className={inputCls} style={inputStyle} placeholder="name (Mess-A)"
                        value={name} onChange={e => setName(e.target.value)} />
                    <input className={inputCls} style={inputStyle} placeholder="latitude" type="number"
                        step="0.000001" value={lat} onChange={e => setLat(e.target.value)} />
                    <input className={inputCls} style={inputStyle} placeholder="longitude" type="number"
                        step="0.000001" value={lng} onChange={e => setLng(e.target.value)} />
                    <input className={inputCls} style={inputStyle} placeholder="notes"
                        value={notes} onChange={e => setNotes(e.target.value)} />
                </div>
                <div className="mt-3">
                    <button className={btnPrimary}
                        disabled={busy || !name || lat === '' || lng === ''}
                        onClick={create}>
                        <Plus size={13} /> ADD PAD
                    </button>
                </div>
            </SectionCard>

            <SectionCard>
                {pads.length === 0 ? (
                    <p className="text-sm py-4 text-center" style={{ color: 'hsl(var(--app-text-muted))' }}>
                        No pads yet. Orders need at least two.
                    </p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-[10px] font-mono"
                                    style={{ color: 'hsl(var(--app-text-muted))' }}>
                                    <th className="pb-2 pr-4">NAME</th>
                                    <th className="pb-2 pr-4">POSITION</th>
                                    <th className="pb-2 pr-4">NOTES</th>
                                    <th className="pb-2 pr-4">STATE</th>
                                    <th className="pb-2"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {pads.map(p => (
                                    <tr key={p.id} className="border-t"
                                        style={{ borderColor: 'hsl(var(--app-border))' }}>
                                        <td className="py-2 pr-4">
                                            {p.name}
                                            {p.kind === 'station' && (
                                                <span className="ml-2 font-mono text-[9px] px-1.5 py-0.5 rounded"
                                                    style={{ color: '#fbbf24', background: '#fbbf2422' }}>
                                                    STATION
                                                </span>
                                            )}
                                        </td>
                                        <td className="py-2 pr-4 font-mono text-xs">
                                            {p.lat.toFixed(6)}, {p.lng.toFixed(6)}
                                        </td>
                                        <td className="py-2 pr-4 text-xs"
                                            style={{ color: 'hsl(var(--app-text-muted))' }}>
                                            {p.notes || '--'}
                                        </td>
                                        <td className="py-2 pr-4">
                                            <span className="font-mono text-[10px] px-2 py-0.5 rounded-full"
                                                style={p.active
                                                    ? { color: '#4ade80', background: '#4ade8022' }
                                                    : { color: '#71717a', background: '#71717a22' }}>
                                                {p.active ? 'ACTIVE' : 'RETIRED'}
                                            </span>
                                        </td>
                                        <td className="py-2 text-right whitespace-nowrap">
                                            <button className={btnGhost}
                                                style={{ borderColor: 'hsl(var(--app-border))' }}
                                                onClick={() => toggle(p)}>
                                                {p.active ? 'RETIRE' : 'RESTORE'}
                                            </button>
                                            <button className={`${btnGhost} ml-2`}
                                                style={{ borderColor: '#f8717166', color: '#f87171' }}
                                                onClick={() => remove(p)}>
                                                <X size={12} /> DELETE
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </SectionCard>
        </div>
    )
}

// ── CLIENT KEYS ──────────────────────────────────────────────────────────

function KeysTab() {
    const [keys, setKeys] = useState<KeyT[]>([])
    const [name, setName] = useState('')
    const [minted, setMinted] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    const refresh = useCallback(async () => {
        try {
            const r = await fetch(api('/api-keys'), { headers: AUTH })
            setKeys((await r.json()).keys ?? [])
        } catch { /* transient */ }
    }, [])
    useEffect(() => { refresh() }, [refresh])

    async function mint() {
        setBusy(true); setError('')
        try {
            const r = await fetch(api('/api-keys'), {
                method: 'POST', headers: AUTH, body: JSON.stringify({ name }),
            })
            const j = await jsonOf(r)
            if (!r.ok) setError(j.detail ?? 'Failed')
            else { setMinted(j.key); setName(''); refresh() }
        } catch { setError('Backend unreachable') }
        setBusy(false)
    }

    async function setActive(k: KeyT, active: boolean) {
        if (!active && !window.confirm(
            `Revoke "${k.name}"? Its clients lose /v1 access immediately.`)) return
        const r = await fetch(api(`/api-keys/${k.id}`), {
            method: 'PATCH', headers: AUTH, body: JSON.stringify({ active }),
        }).catch(() => null)
        if (!r || !r.ok) setError((r && (await jsonOf(r)).detail) || 'Update failed')
        refresh()
    }

    return (
        <div className="flex flex-col gap-3">
            <SectionCard>
                <p className="text-[10px] font-mono mb-3" style={{ color: 'hsl(var(--app-text-muted))' }}>
                    MINT KEY - one per client application. The key appears once; only
                    its hash is stored.
                </p>
                {error && <p className="text-xs mb-2" style={{ color: '#f87171' }}>{error}</p>}
                <div className="flex gap-2">
                    <input className={`${inputCls} max-w-xs`} style={inputStyle}
                        placeholder="client name (demo storefront)"
                        value={name} onChange={e => setName(e.target.value)} />
                    <button className={btnPrimary} disabled={busy || !name.trim()} onClick={mint}>
                        <KeyRound size={13} /> MINT
                    </button>
                </div>
            </SectionCard>

            {minted && (
                <div className="rounded-xl border p-4"
                    style={{ background: '#06b6d410', borderColor: '#06b6d455' }}>
                    <p className="text-xs mb-2" style={{ color: '#06b6d4' }}>
                        Copy this key now. It will not be shown again.
                    </p>
                    <div className="flex items-center gap-2">
                        <code className="font-mono text-sm px-3 py-1.5 rounded-md border select-all"
                            style={{ borderColor: '#06b6d455', color: 'hsl(var(--app-text))' }}>
                            {minted}
                        </code>
                        <button className={btnGhost} style={{ borderColor: '#06b6d455', color: '#06b6d4' }}
                            onClick={async () => {
                                try {
                                    await navigator.clipboard.writeText(minted)
                                    setCopied(true)
                                    setTimeout(() => setCopied(false), 1500)
                                } catch { /* clipboard unavailable */ }
                            }}>
                            {copied ? <Check size={13} /> : <Copy size={13} />}
                            {copied ? 'COPIED' : 'COPY'}
                        </button>
                        <button className={btnGhost}
                            style={{ borderColor: 'hsl(var(--app-border))' }}
                            onClick={() => setMinted(null)}>
                            <X size={13} /> DISMISS
                        </button>
                    </div>
                </div>
            )}

            <SectionCard>
                {keys.length === 0 ? (
                    <p className="text-sm py-4 text-center" style={{ color: 'hsl(var(--app-text-muted))' }}>
                        No client keys yet.
                    </p>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-[10px] font-mono"
                                style={{ color: 'hsl(var(--app-text-muted))' }}>
                                <th className="pb-2 pr-4">CLIENT</th>
                                <th className="pb-2 pr-4">KEY</th>
                                <th className="pb-2 pr-4">LAST USED</th>
                                <th className="pb-2 pr-4">STATE</th>
                                <th className="pb-2"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {keys.map(k => (
                                <tr key={k.id} className="border-t"
                                    style={{ borderColor: 'hsl(var(--app-border))' }}>
                                    <td className="py-2 pr-4">{k.name}</td>
                                    <td className="py-2 pr-4 font-mono text-xs"
                                        style={{ color: 'hsl(var(--app-text-muted))' }}>
                                        {k.prefix}...
                                    </td>
                                    <td className="py-2 pr-4 font-mono text-xs"
                                        style={{ color: 'hsl(var(--app-text-muted))' }}>
                                        {fmtTime(k.last_used_at)}
                                    </td>
                                    <td className="py-2 pr-4">
                                        <span className="font-mono text-[10px] px-2 py-0.5 rounded-full"
                                            style={k.active
                                                ? { color: '#4ade80', background: '#4ade8022' }
                                                : { color: '#f87171', background: '#f8717122' }}>
                                            {k.active ? 'ACTIVE' : 'REVOKED'}
                                        </span>
                                    </td>
                                    <td className="py-2 text-right">
                                        <button className={btnGhost}
                                            style={k.active
                                                ? { borderColor: '#f8717166', color: '#f87171' }
                                                : { borderColor: 'hsl(var(--app-border))' }}
                                            onClick={() => setActive(k, !k.active)}>
                                            {k.active ? 'REVOKE' : 'RESTORE'}
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </SectionCard>
        </div>
    )
}
