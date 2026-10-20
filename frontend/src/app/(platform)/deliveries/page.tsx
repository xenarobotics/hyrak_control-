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

import { apiFetch } from '@/lib/api'
import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import {
    Package, MapPin, KeyRound, Plus, RefreshCw, X, Copy, Check,
    AlertTriangle, ChevronDown, ChevronRight, RotateCw, Play, Loader, Plane, Home,
    ChevronsRight, ChevronsLeft, Map as MapIcon, SlidersHorizontal,
} from 'lucide-react'
import { getServerUrl } from '@/lib/server-url'
import { liveAuthHeaders } from '@/lib/auth'
import { visibleInterval } from '@/lib/poll'
import { getSocket } from '@/lib/socket'
import { claimSocket, releaseSocket, socketOwner } from '@/lib/socketClaim'
import { useDroneStore } from '@/store/drone'
import type { MapDroneLive, MapRoute, MapSelection } from '@/components/deliveries/DeliveryMap'
import { BTN, BTN_ACCENT, BTN_DANGER, BTN_PRIMARY, BTN_WARN, FOCUS, INPUT, LABEL } from '@/components/mission/ui'

const RegionEditor = dynamic(() => import('@/components/deliveries/RegionEditor'), {
    ssr: false,
    loading: () => (
        <div className="h-64 flex items-center justify-center">
            <p className="text-[13px] text-app-text-muted">
                Loading editor...
            </p>
        </div>
    ),
})

// Leaflet touches `window` - client only
const DeliveryMap = dynamic(() => import('@/components/deliveries/DeliveryMap'), {
    ssr: false,
    loading: () => (
        <div className="h-full w-full rounded-[10px] border border-app-border bg-app-surface-2 flex items-center justify-center">
            <p className="text-[13px] text-app-text-muted">
                Loading map...
            </p>
        </div>
    ),
})


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

// Theme tokens (CSS variables), so each status reads in dark AND light.
// Amber = the drone is moving or about to; colour always comes with a word.
const tone = (fg: string, label: string) => ({
    fg, bg: `color-mix(in srgb, ${fg} 13%, transparent)`,
    line: `color-mix(in srgb, ${fg} 45%, transparent)`, label,
})
const T_MUTED = 'hsl(var(--app-text-muted))'
const STATUS_STYLE: Record<string, { fg: string; bg: string; line: string; label: string }> = {
    received:   tone(T_MUTED, 'Received'),
    planned:    tone('var(--app-accent)', 'Planned'),
    assigned:   tone('var(--app-accent)', 'Assigned'),
    to_pickup:  tone('var(--app-warn)', 'To pickup'),
    loading:    tone('var(--app-warn)', 'Loading'),
    to_dropoff: tone('var(--app-warn)', 'To dropoff'),
    delivered:  tone('var(--app-ok)', 'Delivered'),
    returned:   tone('var(--app-warn)', 'Returned'),
    failed:     tone('var(--app-danger)', 'Failed'),
    cancelled:  tone('hsl(var(--app-text-subtle))', 'Cancelled'),
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
const AUTH = liveAuthHeaders({ 'Content-Type': 'application/json' })

// Parse a response body that may not be JSON (a proxy's HTML 502, an empty
// reply). Raw r.json() throws on those, landing every error in the generic
// "Backend unreachable" catch even though the backend DID answer.
/** A live position as /sessions reports it for a session or a fleet drone. */
type LivePosT = { lat: number; lng: number; alt: number; heading: number; battery: number; mode: string; in_air: boolean }
type SessionsBody = {
    sessions: { drone?: { id: string; name?: string } | null; hardware_uid?: string | null; live?: LivePosT | null }[]
    fleet_drones: { db_id?: string; drone_id?: number; name?: string; live?: LivePosT | null }[]
}

/** The fields every endpoint here may answer with; the rest are per call
 *  and typed at the call site through the type argument. */
interface ApiBody { ok?: boolean; detail?: string; msg?: string }
async function jsonOf<T extends object = ApiBody>(r: Response): Promise<Partial<T> & ApiBody> {
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
            className="inline-flex items-center h-6 px-2 rounded-full text-xs font-bold whitespace-nowrap"
            style={{ color: s.fg, background: s.bg, border: `1px solid ${s.line}` }}
        >
            {s.label}
        </span>
    )
}

function SectionCard({ children }: { children: React.ReactNode }) {
    return (
        <div className="rounded-[10px] border border-app-border bg-app-surface p-4 shadow-[var(--app-shadow)]">
            {children}
        </div>
    )
}

const inputCls = `${INPUT} w-full font-normal normal-case tracking-normal`
const btnPrimary = BTN_PRIMARY
const btnGhost = BTN

export default function DeliveriesPage() {
    const [tab, setTab] = useState<'orders' | 'regions' | 'profiles' | 'pads' | 'keys'>('orders')

    return (
        <div className="h-full flex flex-col gap-3 overflow-hidden">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 shrink-0">
                <div className="flex items-center gap-2">
                    <Package size={20} className="text-app-accent" aria-hidden />
                    <h1 className="text-[22px] leading-7 font-bold">Deliveries</h1>
                </div>
                <div className="flex gap-1 overflow-x-auto max-w-full" role="tablist">
                    {([
                        ['orders', 'Orders', Package],
                        ['regions', 'Regions', MapIcon],
                        ['profiles', 'Profiles', SlidersHorizontal],
                        ['pads', 'Pads', MapPin],
                        ['keys', 'Client keys', KeyRound],
                    ] as const).map(([id, label, Icon]) => (
                        <button
                            key={id}
                            onClick={() => setTab(id)}
                            role="tab" aria-selected={tab === id}
                            className={'flex items-center gap-1.5 h-8 px-3 rounded-[6px] text-sm font-semibold whitespace-nowrap border transition-colors duration-[120ms] ' + FOCUS + ' ' +
                                (tab === id
                                    ? 'bg-app-accent-soft text-app-accent border-app-accent/40'
                                    : 'text-app-text-muted border-transparent hover:text-app-text hover:bg-app-surface-2')}
                        >
                            <Icon size={14} aria-hidden />{label}
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
    const [loaded, setLoaded] = useState(false)   // gates the empty-state flash
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
            const r = await apiFetch(api(`/tasks${showArchivedRef.current ? '?archived=1' : ''}`))
            const j = await jsonOf<{ tasks: TaskT[] }>(r)
            setTasks(j.tasks ?? [])
        } catch { /* backend away - keep the last board */ }
        finally { setLoaded(true) }
    }, [])

    useEffect(() => { refresh() }, [showArchived, refresh])

    const loadDetail = useCallback(async (id: string) => {
        try {
            const r = await apiFetch(api(`/tasks/${id}`))
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
            const r = await apiFetch(api('/sessions'))
            const j = await jsonOf<SessionsBody>(r)
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
                    const r = await apiFetch(api(`/tasks/${t.id}`))
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
        const stopRefresh = visibleInterval(refresh, 8000)
        const stopSessions = visibleInterval(pollSessions, 3000)
        apiFetch(api('/drones')).then(r => r.json())
            .then(j => setDrones(j.drones ?? [])).catch(() => {})
        apiFetch(api('/pads')).then(r => r.json())
            .then(j => setPads((j.pads ?? []).filter((p: PadT) => p.active))).catch(() => {})
        apiFetch(api('/planner/meta')).then(r => r.json())
            .then(j => setProfiles(j.profiles ?? [])).catch(() => {})
        return () => { stopRefresh(); stopSessions() }
    }, [refresh, pollSessions])

    useEffect(() => {
        if (!openId) { setDetail(null); return }
        loadDetail(openId)
        return visibleInterval(() => loadDetail(openId), 8000)
    }, [openId, loadDetail])

    async function act(taskId: string, body: Record<string, unknown>) {
        setBusy(true); setError('')
        try {
            const r = await apiFetch(api(`/tasks/${taskId}`), {
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
            const r = await apiFetch(api(`/tasks/${taskId}`), {
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
            const r = await apiFetch(api(`/tasks/${taskId}`), {
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
            const r = await apiFetch(api(`/tasks/${taskId}/replan`), {
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

        // Station-fleet drones fly through the server (no browser radio in
        // the loop) - the board is fully self-contained for them.
        if (task.drone_id && fleetIds.has(task.drone_id)) {
            setStarting({ taskId: task.id, leg, phase: 'uploading' })
            try {
                const r = await apiFetch(api(`/fleet/${task.drone_id}/fly`), {
                    method: 'POST', headers: AUTH,
                    // Couple the order advance to the flight start: the server
                    // moves the order to nextStatus in the same request, so a
                    // dropped follow-up PATCH can no longer desync flight and
                    // order. No separate act() call on success.
                    body: JSON.stringify({
                        waypoints, ack_orange: ackOrange,
                        task_id: task.id, target_status: nextStatus,
                    }),
                })
                const j = await jsonOf<{ needs_ack: boolean; zones: { name: string }[] }>(r)
                if (j.ok) {
                    setStarting(null)
                    refresh()
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
    }, [detail, routeCache, fleetIds, telemetryStatus, refresh])

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
            <div className="flex flex-wrap items-center gap-2 min-h-8">
                {/* With no orders the empty state below carries this action. */}
                {(tasks.length > 0 || !loaded || showNew) && (
                    <button className={btnPrimary} onClick={() => setShowNew(v => !v)}>
                        <Plus size={14} aria-hidden /> New order
                    </button>
                )}
                <button className={btnGhost}
                    onClick={refresh}>
                    <RefreshCw size={14} aria-hidden /> Refresh
                </button>
                <button className={btnGhost}
                    style={showArchived
                        ? { borderColor: 'color-mix(in srgb, var(--app-accent) 45%, transparent)', color: 'var(--app-accent)' }
                        : undefined}
                    aria-pressed={showArchived}
                    title="Include shelved orders in the list"
                    onClick={() => setShowArchived(v => !v)}>
                    Archived
                </button>
                <span className="ml-auto flex items-center gap-1.5 flex-wrap">
                    {Object.entries(
                        tasks.reduce<Record<string, number>>((acc, t) => {
                            acc[t.status] = (acc[t.status] ?? 0) + 1; return acc
                        }, {})
                    ).sort((a, b) => STATUS_ORDER.indexOf(a[0]) - STATUS_ORDER.indexOf(b[0]))
                        .map(([s, n]) => (
                            <span key={s} className="inline-flex items-center h-6 px-2 rounded-full text-xs font-bold tabular-nums"
                                style={{ color: STATUS_STYLE[s]?.fg, background: STATUS_STYLE[s]?.bg }}>
                                {n} {STATUS_STYLE[s]?.label ?? s}
                            </span>
                        ))}
                </span>
            </div>

            {error && (
                <div role="alert" className="flex items-center gap-2 text-[13px] rounded-[10px] px-3 py-1"
                    style={{ color: 'var(--app-danger)', background: 'color-mix(in srgb, var(--app-danger) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--app-danger) 33%, transparent)' }}>
                    <AlertTriangle size={14} /> {error}
                    <button className={'ml-auto w-8 h-8 inline-flex items-center justify-center rounded-[6px] hover:bg-app-danger-soft ' + FOCUS}
                        aria-label="Dismiss error" title="Dismiss" onClick={() => setError('')}><X size={14} /></button>
                </div>
            )}

            {showNew && (
                <NewOrderForm pads={pads.filter(p => p.kind !== 'station')} profiles={profiles}
                    onDone={() => { setShowNew(false); refresh() }}
                    onError={setError} />
            )}

            <SectionCard>
                {tasks.length === 0 ? (
                    loaded ? (
                        <div className="flex flex-col items-center gap-3 py-10 text-center">
                            <span className="w-10 h-10 rounded-[10px] flex items-center justify-center bg-app-accent-soft text-app-accent">
                                <Package size={20} aria-hidden />
                            </span>
                            <div>
                                <p className="text-[16px] font-bold text-app-text">No orders yet</p>
                                <p className="text-[13px] text-app-text-muted mt-0.5">Orders you create show up here with their route and drone.</p>
                            </div>
                            {!showNew && (
                                <button className={btnPrimary} onClick={() => setShowNew(true)}>
                                    <Plus size={14} aria-hidden /> New order
                                </button>
                            )}
                        </div>
                    ) : (
                        <p className="text-sm py-6 text-center text-app-text-muted">Loading orders...</p>
                    )
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className={'text-left ' + LABEL}>
                                    <th className="pb-2 pr-2 w-6"></th>
                                    <th className="pb-2 pr-3">Order</th>
                                    <th className="pb-2 pr-3">Route</th>
                                    <th className="pb-2 pr-3">Status</th>
                                    <th className="pb-2">Drone</th>
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
            <div className="shrink-0 xl:w-[38%] min-w-0 flex flex-col gap-3 h-[480px] xl:h-auto">
                {/* Same 32px header row as the other two columns, so the
                    orders card, the map and the drones list share a top edge. */}
                <div className="h-8 shrink-0 flex items-center gap-2">
                    <h2 className="text-[13px] font-semibold text-app-text-muted">Live map</h2>
                    <span className="ml-auto inline-flex items-center gap-1.5 text-[13px] text-app-text-muted tabular-nums">
                        <span className={'w-2 h-2 rounded-full ' + (onlineIds.size > 0 ? 'bg-app-ok' : 'bg-app-border-strong')} aria-hidden />
                        {onlineIds.size} drone{onlineIds.size === 1 ? '' : 's'} online
                    </span>
                </div>
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
                                    className={'shrink-0 flex items-center gap-2 rounded-[10px] border px-3 py-2 text-left transition-colors duration-[120ms] hover:bg-app-surface-2 ' + FOCUS}
                                    style={{
                                        background: 'hsl(var(--app-surface))',
                                        borderColor: openId === t.id ? 'var(--app-accent)' : 'hsl(var(--app-border))',
                                    }}>
                                    <span className="text-sm font-bold text-app-accent tabular-nums">{t.order_no}</span>
                                    <StatusChip status={t.status} />
                                    <span className="text-[13px] text-app-text-muted tabular-nums">
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
                <div className="xl:w-[250px] shrink-0 flex flex-col gap-3 xl:overflow-y-auto">
                    <div className="h-8 shrink-0 flex items-center gap-2">
                        <Plane size={16} className="text-app-accent" aria-hidden />
                        <h2 className="text-[16px] leading-6 font-bold">Drones</h2>
                        <button className={'ml-auto w-8 h-8 inline-flex items-center justify-center rounded-[6px] text-app-text-muted hover:text-app-text hover:bg-app-surface-2 ' + FOCUS}
                            title="Hide the drones panel" aria-label="Hide the drones panel"
                            onClick={() => setPanelOpen(false)}>
                            <ChevronsRight size={16} />
                        </button>
                    </div>
                    <DronesPanel />
                </div>
            ) : (
                <button
                    className={'shrink-0 self-start w-8 h-8 inline-flex items-center justify-center rounded-[6px] border border-app-border text-app-text-muted hover:text-app-text hover:bg-app-surface-2 ' + FOCUS}
                    title="Show the drones panel" aria-label="Show the drones panel"
                    onClick={() => setPanelOpen(true)}>
                    <ChevronsLeft size={16} />
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
                className={'cursor-pointer border-t border-app-border transition-colors duration-[120ms] hover:bg-app-surface-2 ' + FOCUS}
                tabIndex={0} aria-expanded={open}
                onClick={onToggle}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
            >
                <td className="py-2.5 pr-2 text-app-text-muted">
                    {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </td>
                <td className="py-2.5 pr-3 font-bold text-app-accent tabular-nums whitespace-nowrap">{task.order_no}</td>
                <td className="py-2.5 pr-3 text-sm">
                    {task.pickup.name}
                    <span className="text-app-text-muted"> to </span>
                    {task.dropoff.name}
                </td>
                <td className="py-2.5 pr-3"><StatusChip status={task.status} /></td>
                <td className="py-2.5 text-[13px] whitespace-nowrap">{droneName(task.drone_id) ?? '--'}</td>
            </tr>
            {open && (
                <tr>
                    <td colSpan={5} className="pb-4">
                        <div className="mx-2 mt-1 rounded-[10px] border border-app-border bg-app-surface-2 p-4 grid gap-4 md:grid-cols-[1fr_1fr]">
                            <dl className="md:col-span-2 flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
                                <div className="flex gap-1.5"><dt className="text-app-text-muted">Client</dt><dd className="font-semibold">{task.client_name}</dd></div>
                                {task.payload.description && <div className="flex gap-1.5"><dt className="text-app-text-muted">Payload</dt><dd className="font-semibold">{task.payload.description}</dd></div>}
                                {task.payload.kg > 0 && <div className="flex gap-1.5"><dt className="text-app-text-muted">Weight</dt><dd className="font-semibold tabular-nums">{task.payload.kg} kg</dd></div>}
                                <div className="flex gap-1.5"><dt className="text-app-text-muted">Created</dt><dd className="font-semibold tabular-nums">{fmtTime(task.created_at)}</dd></div>
                            </dl>
                            {/* Timeline */}
                            <div>
                                <p className={LABEL + ' mb-2'}>Timeline</p>
                                {(detail?.events ?? []).length === 0 ? (
                                    <p className="text-[13px] text-app-text-muted">Loading...</p>
                                ) : (
                                    <ol className="space-y-1.5">
                                        {(detail?.events ?? []).map((e, i) => (
                                            <li key={i} className="flex items-start gap-2 text-[13px]">
                                                <span className="mt-1 w-1.5 h-1.5 rounded-full shrink-0"
                                                    style={{ background: STATUS_STYLE[e.status]?.fg ?? 'hsl(var(--app-text-muted))' }} />
                                                <span className="tabular-nums whitespace-nowrap text-app-text-muted">
                                                    {fmtTime(e.t)}
                                                </span>
                                                <span className="font-bold whitespace-nowrap"
                                                    style={{ color: STATUS_STYLE[e.status]?.fg }}>
                                                    {STATUS_STYLE[e.status]?.label ?? e.status}
                                                </span>
                                                {e.note && <span className="text-app-text-muted">{e.note}</span>}
                                            </li>
                                        ))}
                                    </ol>
                                )}
                                {task.fail_reason && (
                                    <p className="mt-2 text-[13px] flex items-center gap-1.5 text-app-danger" role="alert">
                                        <AlertTriangle size={14} aria-hidden /> {task.fail_reason}
                                    </p>
                                )}
                            </div>

                            {/* Route + actions */}
                            <div className="flex flex-col gap-3">
                                <div>
                                    <p className={LABEL + ' mb-2'}>Route</p>
                                    {detail?.mission ? (
                                        <div className="text-[13px] space-y-1">
                                            <p><span className="font-bold tabular-nums">{detail.mission.distance_m.toFixed(0)} m</span>
                                                <span className="text-app-text-muted"> over </span>
                                                <span className="font-bold tabular-nums">{detail.mission.waypoint_count} waypoints</span>
                                                <span className="text-app-text-muted">, about </span>
                                                <span className="font-bold tabular-nums">{fmtDur(detail.mission.est_duration_s)}</span>
                                                <span className="text-app-text-muted"> with profile </span>
                                                {task.profile_name || 'Direct'}</p>
                                            {detail.mission.coverage?.categories_m &&
                                                Object.keys(detail.mission.coverage.categories_m).length > 0 && (
                                                <p className="text-app-text-muted">
                                                    Ground cover: {Object.entries(detail.mission.coverage.categories_m)
                                                        .sort((a, b) => b[1] - a[1]).slice(0, 3)
                                                        .map(([c, m]) => `${c} ${(100 * m / (detail.mission!.coverage.total_m || 1)).toFixed(0)}%`)
                                                        .join(', ')}
                                                </p>
                                            )}
                                        </div>
                                    ) : (
                                        <p className="text-[13px] text-app-text-muted">
                                            No route planned yet.
                                        </p>
                                    )}
                                </div>

                                <div>
                                    <p className={LABEL + ' mb-2'}>Actions</p>
                                    <div className="flex flex-wrap items-center gap-2">
                                        {task.status === 'planned' && (
                                            onlineDrones.length === 0 ? (
                                                <span className="text-[13px] text-app-text-muted">
                                                    No drones online. Connect one on the Fly tab to assign.
                                                </span>
                                            ) : (
                                                <span className="flex flex-wrap items-center gap-1.5">
                                                    <select
                                                        className={INPUT}
                                                        aria-label="Drone to assign"
                                                        value={assignTo}
                                                        onChange={e => setAssignTo(e.target.value)}
                                                    >
                                                        <option value="">Assign an online drone...</option>
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
                                                        title={!assignTo ? 'Pick a drone first' : undefined}
                                                        onClick={() => onAct(task.id, { status: 'assigned', drone_id: assignTo })}>
                                                        Assign
                                                    </button>
                                                </span>
                                            )
                                        )}
                                        {startLeg && (
                                            thisStarting?.phase === 'need_ack' ? (
                                                <button className={BTN_WARN} disabled={busy}
                                                    title={thisStarting.msg}
                                                    onClick={() => onStart(task, startLeg, true)}>
                                                    <AlertTriangle size={14} aria-hidden /> Confirm orange zone and start
                                                </button>
                                            ) : thisStarting ? (
                                                <span className="flex items-center gap-1.5 text-[13px] font-semibold text-app-accent" role="status">
                                                    <Loader size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
                                                    {thisStarting.phase === 'uploading' ? 'Uploading mission...' : 'Arming and starting...'}
                                                </span>
                                            ) : (
                                                <button className={BTN_WARN}
                                                    disabled={busy || (!isFleet && !telemetryConnected)}
                                                    title={isFleet || telemetryConnected
                                                        ? 'Upload this leg, arm, and start the flight'
                                                        : 'Connect the drone on the Fly tab first'}
                                                    onClick={() => onStart(task, startLeg, false)}>
                                                    <Play size={14} aria-hidden />
                                                    {startLeg === 'pickup' ? 'Start pickup flight' : 'Start delivery flight'}
                                                </button>
                                            )
                                        )}
                                        {(task.status === 'assigned' || task.status === 'loading')
                                            && !isFleet && !telemetryConnected && !thisStarting && (
                                            <span className="text-[13px] text-app-text-muted">
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
                                                title="Manually mark the order. This does not fly anything."
                                                style={{
                                                    borderColor: STATUS_STYLE[s].line,
                                                    color: STATUS_STYLE[s].fg,
                                                }}
                                                onClick={() => onAct(task.id, { status: s })}>
                                                Mark {STATUS_STYLE[s].label.toLowerCase()}
                                            </button>
                                        ))}
                                        {canReplan && (
                                            <button className={btnGhost} disabled={busy}
                                                onClick={() => onReplan(task.id)}>
                                                <RotateCw size={14} aria-hidden /> Replan
                                            </button>
                                        )}
                                        {nexts.length === 0 && (
                                            <>
                                                <button className={btnGhost} disabled={busy}
                                                    title={task.archived
                                                        ? 'Bring the order back onto the board'
                                                        : 'Shelve the order - it leaves the board but stays in the database'}
                                                    onClick={() => onArchive(task.id, !task.archived)}>
                                                    {task.archived ? 'Unarchive' : 'Archive'}
                                                </button>
                                                <button className={BTN_DANGER} disabled={busy}
                                                    title="Permanently delete the order and its timeline (flight history stays)"
                                                    onClick={() => onDelete(task.id)}>
                                                    <X size={14} aria-hidden /> Delete
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
            const r = await apiFetch(api('/tasks'), {
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
            <h2 className="text-[18px] leading-6 font-bold mb-1">New order</h2>
            <p className="text-[13px] text-app-text-muted mb-3">
                Client apps create orders with <code className="font-code">POST /v1/tasks</code>.
            </p>
            <div className="grid gap-2 md:grid-cols-5">
                <select className={inputCls} value={pickup} aria-label="Pickup pad"
                    onChange={e => setPickup(e.target.value)}>
                    <option value="">Pickup pad...</option>
                    {pads.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <select className={inputCls} value={dropoff} aria-label="Dropoff pad"
                    onChange={e => setDropoff(e.target.value)}>
                    <option value="">Dropoff pad...</option>
                    {pads.filter(p => p.id !== pickup).map(p =>
                        <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input className={inputCls} placeholder="Payload description" aria-label="Payload description"
                    value={desc} onChange={e => setDesc(e.target.value)} />
                <input className={inputCls} placeholder="kg" aria-label="Payload weight in kg" type="number"
                    min="0" step="0.1" value={kg} onChange={e => setKg(e.target.value)} />
                <select className={inputCls} value={profile} aria-label="Route profile"
                    onChange={e => setProfile(e.target.value)}>
                    <option value="">Route profile: auto</option>
                    {profiles.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
                </select>
            </div>
            <div className="mt-3">
                <button className={btnPrimary} disabled={busy || !pickup || !dropoff}
                    title={!pickup || !dropoff ? 'Pick both pads first' : undefined}
                    onClick={submit}>
                    <Plus size={14} aria-hidden /> Create order
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
    useEffect(() => { retRef.current = ret }, [ret])
    const telemetryStatus = useDroneStore(st => st.telemetryStatus)

    const refresh = useCallback(async () => {
        try {
            const [dr, se, ta] = await Promise.all([
                apiFetch(api('/drones')).then(r => r.json()),
                apiFetch(api('/sessions')).then(r => r.json()),
                apiFetch(api('/tasks')).then(r => r.json()),
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
        // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh sets state only after its fetch resolves; the rule does not follow the await
        refresh()
        return visibleInterval(refresh, 5000)
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
            const r = await apiFetch(api(`/drones/${droneId}/return-mission`), {
                method: 'POST', headers: AUTH,
            })
            const j = await jsonOf<{ mission: { waypoints: WaypointT[] } }>(r)
            if (!r.ok) { setRet(null); setError(j.detail ?? 'Return planning failed'); return }
            const waypoints = j.mission?.waypoints
            if (!waypoints || waypoints.length < 2) {
                setRet(null); setError('Already at (or next to) the station'); return
            }
            setRet({ droneId, phase: 'uploading' })
            if (fleetIds.has(droneId)) {
                // Station drone - flown by the server, no browser radio needed.
                const fr = await apiFetch(api(`/fleet/${droneId}/fly`), {
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
            const r = await apiFetch(api('/fleet/connect'), {
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
                <div role="alert" className="flex items-center gap-2 text-[13px] rounded-[10px] px-3 py-1"
                    style={{ color: 'var(--app-danger)', background: 'color-mix(in srgb, var(--app-danger) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--app-danger) 33%, transparent)' }}>
                    <AlertTriangle size={14} /> {error}
                    <button className={'ml-auto w-8 h-8 inline-flex items-center justify-center rounded-[6px] hover:bg-app-danger-soft ' + FOCUS}
                        aria-label="Dismiss error" title="Dismiss" onClick={() => setError('')}><X size={14} /></button>
                </div>
            )}

            <div className="grid gap-2 grid-cols-1 empty:hidden">
                {online.map(d => {
                    const lv = live.get(d.id)!
                    const task = activeTaskFor(d.id)
                    const returning = ret?.droneId === d.id ? ret : null
                    return (
                        <SectionCard key={d.id}>
                            <div className="flex items-center gap-2">
                                <span className={'w-2 h-2 rounded-full shrink-0 ' + (lv.in_air ? 'bg-app-warn' : 'bg-app-ok')} aria-hidden />
                                <span className="text-base font-bold truncate">{d.name || lv.name}</span>
                                {d.is_simulated && (
                                    <span className="inline-flex items-center h-5 px-1.5 rounded-full text-xs font-bold text-app-accent bg-app-accent-soft"
                                        title="Simulated drone">Sim</span>
                                )}
                                <span className={'ml-auto text-xs font-bold whitespace-nowrap ' + (lv.in_air ? 'text-app-warn' : 'text-app-ok')}>
                                    {lv.in_air ? 'In air' : 'On ground'}
                                </span>
                            </div>
                            <dl className="mt-3 grid grid-cols-3 gap-2">
                                <div>
                                    <dt className={LABEL}>Battery</dt>
                                    <dd className={'text-base font-bold tabular-nums ' + (lv.battery < 25 ? 'text-app-danger' : 'text-app-text')}>
                                        {Math.round(lv.battery)}<span className="text-xs font-semibold text-app-text-muted">%</span>
                                    </dd>
                                </div>
                                <div className="min-w-0">
                                    <dt className={LABEL}>Mode</dt>
                                    <dd className="text-sm font-semibold truncate" title={lv.mode}>{lv.mode}</dd>
                                </div>
                                <div>
                                    <dt className={LABEL}>Delivered</dt>
                                    <dd className="text-base font-bold tabular-nums">{doneCount(d.id)}</dd>
                                </div>
                            </dl>
                            <div className="mt-2 text-[13px]">
                                {task ? (
                                    <p className="flex flex-wrap items-center gap-2">
                                        <span className="font-bold text-app-accent tabular-nums">{task.order_no}</span>
                                        <StatusChip status={task.status} />
                                    </p>
                                ) : (
                                    <p className="text-app-text-muted">
                                        Idle, next in line for dispatch.
                                    </p>
                                )}
                            </div>
                            {!task && (
                                <div className="mt-3">
                                    {returning ? (
                                        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-app-accent" role="status">
                                            <Loader size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
                                            {returning.phase === 'planning' ? 'Planning return...'
                                                : returning.phase === 'uploading' ? 'Uploading...' : 'Starting...'}
                                        </span>
                                    ) : (
                                        <button className={BTN_WARN + ' w-full'}
                                            disabled={!fleetIds.has(d.id) && telemetryStatus !== 'connected'}
                                            title={fleetIds.has(d.id) || telemetryStatus === 'connected'
                                                ? 'Plan and fly this drone home to the nearest station'
                                                : 'Connect the drone on the Fly tab first'}
                                            onClick={() => returnToStation(d.id)}>
                                            <Home size={14} aria-hidden /> Return to station
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
                    <p className="text-[13px] py-2 text-center text-app-text-muted">
                        No drones online.
                    </p>
                </SectionCard>
            )}

            <div className="flex items-center gap-1.5">
                <button className={`${btnGhost} flex-1`}
                    disabled={connectingFleet}
                    title="Connect station drones to the server. The watchdog also re-adopts them every 25 s; this does it now."
                    onClick={connectFleet}>
                    {connectingFleet
                        ? <><Loader size={14} className="animate-spin motion-reduce:animate-none" aria-hidden /> Connecting...</>
                        : <><Plane size={14} aria-hidden /> Connect fleet</>}
                </button>
                <select className={INPUT} aria-label="How many fleet drones to connect"
                    value={fleetCount}
                    onChange={e => setFleetCount(parseInt(e.target.value))}>
                    {[1, 2, 3, 4, 5, 6, 7, 8].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
            </div>
            <div className="flex items-center gap-1.5">
                <input className={INPUT + ' flex-1 min-w-0'}
                    aria-label="MAVLink UDP port to adopt"
                    placeholder="UDP port, e.g. 14546"
                    value={adoptPort} onChange={e => setAdoptPort(e.target.value)} />
                <button className={btnGhost}
                    disabled={!adoptPort || connectingFleet}
                    title="Manually adopt one drone by its MAVLink UDP port - new SITL instance or a real air unit's telemetry ingress"
                    onClick={async () => {
                        setError('')
                        try {
                            const r = await apiFetch(api('/fleet/adopt'), {
                                method: 'POST', headers: AUTH,
                                body: JSON.stringify({ port: parseInt(adoptPort) }),
                            })
                            if (!r.ok) setError((await jsonOf(r)).detail ?? 'Adopt failed')
                            else { setAdoptPort(''); await refresh() }
                        } catch { setError('Backend unreachable') }
                    }}>
                    Add
                </button>
            </div>
            <p className="text-[13px] -mt-1 text-app-text-muted"
                title="A restarted drone or server reconnects itself. Video attaches with the air-unit ingress (not for SITL).">
                Links heal themselves. Ports 14541-14548 join automatically; others via Add.
            </p>

            {offline.length > 0 && (
                <SectionCard>
                    <p className={LABEL + ' mb-2'}>
                        Offline ({offline.length})
                    </p>
                    <div className="flex flex-wrap gap-2">
                        {offline.map(d => (
                            <span key={d.id} className="px-2 py-1 rounded-[6px] border border-app-border text-[13px] text-app-text-muted">
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
            const r = await apiFetch(api('/planner/meta'))
            const j = await jsonOf<{ profiles: FullProfileT[] }>(r)
            setProfiles(j.profiles ?? [])
        } catch { /* transient */ }
    }, [])
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh sets state only after its fetch resolves; the rule does not follow the await
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
            const r = await apiFetch(api(`/route-profiles/${p.id}`), {
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
                <div role="alert" className="flex items-center gap-2 text-[13px] rounded-[10px] px-3 py-1"
                    style={{ color: 'var(--app-danger)', background: 'color-mix(in srgb, var(--app-danger) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--app-danger) 33%, transparent)' }}>
                    <AlertTriangle size={14} /> {error}
                    <button className={'ml-auto w-8 h-8 inline-flex items-center justify-center rounded-[6px] hover:bg-app-danger-soft ' + FOCUS}
                        aria-label="Dismiss error" title="Dismiss" onClick={() => setError('')}><X size={14} /></button>
                </div>
            )}
            <p className="text-[13px] text-app-text-muted"
                title="Zones (flight law) are managed in Admin; regions (preference) on the Regions tab.">
                Routes fly at their profile&apos;s altitude and speed. Changes apply to new plans; replan an order to pick them up.
            </p>
            {profiles.map(p => {
                const e = editFor(p)
                return (
                    <SectionCard key={p.id}>
                        <div className="flex items-center gap-2">
                            <h3 className="text-base font-bold">{p.name}</h3>
                            {p.builtin && (
                                <span className="inline-flex items-center h-5 px-1.5 rounded-full text-xs font-bold text-app-accent bg-app-accent-soft">Built-in</span>
                            )}
                            {saved === p.id && (
                                <span className="inline-flex items-center gap-1 text-xs font-bold text-app-ok" role="status"><Check size={14} aria-hidden /> Saved</span>
                            )}
                        </div>
                        {p.description && (
                            <p className="mt-1 text-[13px] text-app-text-muted">
                                {p.description}
                            </p>
                        )}
                        <div className="mt-3 grid gap-2 sm:grid-cols-4 items-end">
                            <label className={LABEL + ' normal-case'}>
                                Cruise alt (m AGL)
                                <input className={inputCls + ' mt-1'}
                                    type="number" min={5} max={120} step={1} value={e.alt}
                                    onChange={ev => setEdits(prev => ({ ...prev, [p.id]: { ...e, alt: ev.target.value } }))} />
                            </label>
                            <label className={LABEL + ' normal-case'}>
                                Speed (m/s)
                                <input className={inputCls + ' mt-1'}
                                    type="number" min={2} max={20} step={0.5} value={e.speed}
                                    onChange={ev => setEdits(prev => ({ ...prev, [p.id]: { ...e, speed: ev.target.value } }))} />
                            </label>
                            <label className={LABEL + ' normal-case'}>
                                Orange zones
                                <select className={inputCls + ' mt-1'} value={e.orange}
                                    onChange={ev => setEdits(prev => ({ ...prev, [p.id]: { ...e, orange: ev.target.value } }))}>
                                    <option value="allow">Allow</option>
                                    <option value="penalize">Penalize (detour if cheap)</option>
                                    <option value="block">Block (never enter)</option>
                                </select>
                            </label>
                            <button className={btnPrimary} disabled={busy === p.id}
                                onClick={() => save(p)}>
                                {busy === p.id ? 'Saving...' : 'Save'}
                            </button>
                        </div>
                        {p.rules?.categories && Object.keys(p.rules.categories).length > 0 && (
                            <p className="mt-2 text-[13px] text-app-text-muted">
                                Ground rules: {Object.entries(p.rules.categories)
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
            const r = await apiFetch(api('/pads'))
            setPads((await r.json()).pads ?? [])
        } catch { /* transient */ }
    }, [])
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh sets state only after its fetch resolves; the rule does not follow the await
    useEffect(() => { refresh() }, [refresh])

    async function create() {
        setBusy(true); setError('')
        try {
            const r = await apiFetch(api('/pads'), {
                method: 'POST', headers: AUTH,
                body: JSON.stringify({ name, kind, lat: parseFloat(lat), lng: parseFloat(lng), notes }),
            })
            if (!r.ok) setError((await jsonOf(r)).detail ?? 'Failed')
            else { setName(''); setLat(''); setLng(''); setNotes(''); refresh() }
        } catch { setError('Backend unreachable') }
        setBusy(false)
    }

    async function toggle(p: PadT) {
        await apiFetch(api(`/pads/${p.id}`), {
            method: 'PATCH', headers: AUTH,
            body: JSON.stringify({ active: !p.active }),
        }).catch(() => {})
        refresh()
    }

    async function remove(p: PadT) {
        if (!window.confirm(`Delete "${p.name}"? Orders that used it keep its name.`)) return
        const r = await apiFetch(api(`/pads/${p.id}`), { method: 'DELETE', headers: AUTH })
            .catch(() => null)
        if (!r || !r.ok) setError((r && (await jsonOf(r)).detail) || 'Delete failed')
        refresh()
    }

    return (
        <div className="flex flex-col gap-3">
            <SectionCard>
                <h2 className="text-[18px] leading-6 font-bold mb-1">New location</h2>
                <p className="text-[13px] text-app-text-muted mb-3">
                    A pad is a pickup or drop point clients see. A station is a drone home base.
                </p>
                {error && <p className="text-[13px] mb-2 text-app-danger" role="alert">{error}</p>}
                <div className="grid gap-2 md:grid-cols-5">
                    <select className={inputCls} value={kind} aria-label="Kind"
                        onChange={e => setKind(e.target.value as 'pad' | 'station')}>
                        <option value="pad">Pad</option>
                        <option value="station">Station</option>
                    </select>
                    <input className={inputCls} placeholder="Name, e.g. Mess-A" aria-label="Name"
                        value={name} onChange={e => setName(e.target.value)} />
                    <input className={inputCls} placeholder="Latitude" aria-label="Latitude" type="number"
                        step="0.000001" value={lat} onChange={e => setLat(e.target.value)} />
                    <input className={inputCls} placeholder="Longitude" aria-label="Longitude" type="number"
                        step="0.000001" value={lng} onChange={e => setLng(e.target.value)} />
                    <input className={inputCls} placeholder="Notes" aria-label="Notes"
                        value={notes} onChange={e => setNotes(e.target.value)} />
                </div>
                <div className="mt-3">
                    <button className={btnPrimary}
                        disabled={busy || !name || lat === '' || lng === ''}
                        title={!name || lat === '' || lng === '' ? 'Enter a name, latitude and longitude first' : undefined}
                        onClick={create}>
                        <Plus size={14} aria-hidden /> Add {kind === 'station' ? 'station' : 'pad'}
                    </button>
                </div>
            </SectionCard>

            <SectionCard>
                {pads.length === 0 ? (
                    <p className="text-sm py-4 text-center text-app-text-muted">
                        No pads yet. Orders need at least two.
                    </p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className={'text-left ' + LABEL}>
                                    <th className="pb-2 pr-4">Name</th>
                                    <th className="pb-2 pr-4">Position</th>
                                    <th className="pb-2 pr-4">Notes</th>
                                    <th className="pb-2 pr-4">State</th>
                                    <th className="pb-2"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {pads.map(p => (
                                    <tr key={p.id} className="border-t border-app-border">
                                        <td className="py-2 pr-4">
                                            {p.name}
                                            {p.kind === 'station' && (
                                                <span className="ml-2 inline-flex items-center h-5 px-1.5 rounded-full text-xs font-bold text-app-warn bg-app-warn-soft">
                                                    Station
                                                </span>
                                            )}
                                        </td>
                                        <td className="py-2 pr-4 text-[13px] tabular-nums whitespace-nowrap">
                                            {p.lat.toFixed(6)}, {p.lng.toFixed(6)}
                                        </td>
                                        <td className="py-2 pr-4 text-[13px] text-app-text-muted">
                                            {p.notes || '--'}
                                        </td>
                                        <td className="py-2 pr-4">
                                            <span className={'inline-flex items-center h-6 px-2 rounded-full text-xs font-bold ' +
                                                (p.active ? 'text-app-ok bg-app-ok-soft' : 'text-app-text-muted bg-app-surface-2')}>
                                                {p.active ? 'Active' : 'Retired'}
                                            </span>
                                        </td>
                                        <td className="py-2 text-right whitespace-nowrap">
                                            <button className={btnGhost}
                                                onClick={() => toggle(p)}>
                                                {p.active ? 'Retire' : 'Restore'}
                                            </button>
                                            <button className={`${BTN_DANGER} ml-2`}
                                                onClick={() => remove(p)}>
                                                <X size={14} aria-hidden /> Delete
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
            const r = await apiFetch(api('/api-keys'), { headers: AUTH })
            setKeys((await r.json()).keys ?? [])
        } catch { /* transient */ }
    }, [])
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh sets state only after its fetch resolves; the rule does not follow the await
    useEffect(() => { refresh() }, [refresh])

    async function mint() {
        setBusy(true); setError('')
        try {
            const r = await apiFetch(api('/api-keys'), {
                method: 'POST', headers: AUTH, body: JSON.stringify({ name }),
            })
            const j = await jsonOf<{ key: string }>(r)
            if (!r.ok) setError(j.detail ?? 'Failed')
            else { setMinted(j.key ?? null); setName(''); refresh() }
        } catch { setError('Backend unreachable') }
        setBusy(false)
    }

    async function setActive(k: KeyT, active: boolean) {
        if (!active && !window.confirm(
            `Revoke "${k.name}"? Its clients lose /v1 access immediately.`)) return
        const r = await apiFetch(api(`/api-keys/${k.id}`), {
            method: 'PATCH', headers: AUTH, body: JSON.stringify({ active }),
        }).catch(() => null)
        if (!r || !r.ok) setError((r && (await jsonOf(r)).detail) || 'Update failed')
        refresh()
    }

    return (
        <div className="flex flex-col gap-3">
            <SectionCard>
                <h2 className="text-[18px] leading-6 font-bold mb-1">New client key</h2>
                <p className="text-[13px] text-app-text-muted mb-3">
                    One per client app. The key shows once; only its hash is stored.
                </p>
                {error && <p className="text-[13px] mb-2 text-app-danger" role="alert">{error}</p>}
                <div className="flex flex-wrap gap-2">
                    <input className={`${inputCls} max-w-xs`}
                        aria-label="Client name"
                        placeholder="Client name, e.g. demo storefront"
                        value={name} onChange={e => setName(e.target.value)} />
                    <button className={btnPrimary} disabled={busy || !name.trim()} onClick={mint}
                        title={!name.trim() ? 'Enter a client name first' : undefined}>
                        <KeyRound size={14} aria-hidden /> Create key
                    </button>
                </div>
            </SectionCard>

            {minted && (
                <div className="rounded-[10px] border border-app-accent/40 bg-app-accent-soft p-4">
                    <p className="text-sm font-bold mb-2 text-app-accent">
                        Copy this key now. It will not be shown again.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                        <code className="font-code text-sm px-3 py-1.5 rounded-[6px] border border-app-accent/40 bg-app-surface text-app-text select-all break-all">
                            {minted}
                        </code>
                        <button className={BTN_ACCENT}
                            onClick={async () => {
                                try {
                                    await navigator.clipboard.writeText(minted)
                                    setCopied(true)
                                    setTimeout(() => setCopied(false), 1500)
                                } catch { /* clipboard unavailable */ }
                            }}>
                            {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
                            {copied ? 'Copied' : 'Copy'}
                        </button>
                        <button className={btnGhost}
                            onClick={() => setMinted(null)}>
                            <X size={14} aria-hidden /> Dismiss
                        </button>
                    </div>
                </div>
            )}

            <SectionCard>
                {keys.length === 0 ? (
                    <p className="text-sm py-4 text-center text-app-text-muted">
                        No client keys yet.
                    </p>
                ) : (
                    <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className={'text-left ' + LABEL}>
                                <th className="pb-2 pr-4">Client</th>
                                <th className="pb-2 pr-4">Key</th>
                                <th className="pb-2 pr-4">Last used</th>
                                <th className="pb-2 pr-4">State</th>
                                <th className="pb-2"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {keys.map(k => (
                                <tr key={k.id} className="border-t border-app-border">
                                    <td className="py-2 pr-4">{k.name}</td>
                                    <td className="py-2 pr-4 font-code text-[13px] text-app-text-muted">
                                        {k.prefix}...
                                    </td>
                                    <td className="py-2 pr-4 text-[13px] tabular-nums text-app-text-muted whitespace-nowrap">
                                        {fmtTime(k.last_used_at)}
                                    </td>
                                    <td className="py-2 pr-4">
                                        <span className={'inline-flex items-center h-6 px-2 rounded-full text-xs font-bold ' +
                                            (k.active ? 'text-app-ok bg-app-ok-soft' : 'text-app-danger bg-app-danger-soft')}>
                                            {k.active ? 'Active' : 'Revoked'}
                                        </span>
                                    </td>
                                    <td className="py-2 text-right">
                                        <button className={k.active ? BTN_DANGER : btnGhost}
                                            onClick={() => setActive(k, !k.active)}>
                                            {k.active ? 'Revoke' : 'Restore'}
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
