'use client'

// A workspace's Activity in the console's SPACES detail (docs/ACCESS_MODEL.md
// 8b): its live sessions, recent flights and, for those with audit.view,
// recent audit events, for this workspace and the ones below it. The server
// scopes all three; this only lays them out. Refreshes every 10 s.

import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'
import { getServerUrl } from '@/lib/server-url'
import { Empty, Section, Tag } from '@/components/admin/console'

type ActivitySession = {
    session_id: string
    workspace_name: string
    username: string | null
    role: string | null
    drone: { name?: string } | null
    telemetry_connected: boolean
    video: boolean
    ai_mode: string
    armed: boolean
    in_air: boolean
    takeover: { by: string } | null
}

type ActivityFlight = {
    id: string
    drone_name?: string | null
    drone_id: string
    started_at: string | null
    duration_s: number
    max_alt_m: number
    distance_m: number
    in_progress: boolean
}

type ActivityAudit = {
    id: number
    at: string
    actor_name: string
    action: string
    target_type: string
    target_id: string
}

type Activity = {
    sessions: ActivitySession[]
    flights: ActivityFlight[]
    audit: ActivityAudit[] | null
}

function when(iso: string | null): string {
    if (!iso) return '-'
    const d = new Date(iso)
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

export function ActivitySection({ workspaceId }: { workspaceId: string }) {
    const [data, setData] = useState<Activity | null>(null)
    const [error, setError] = useState('')

    const load = useCallback(async () => {
        try {
            const r = await apiFetch(`${getServerUrl()}/api/workspaces/${encodeURIComponent(workspaceId)}/activity`)
            if (!r.ok) { setError(`Activity could not be loaded (HTTP ${r.status})`); return }
            setData(await r.json())
            setError('')
        } catch {
            setError('Activity could not be loaded: the server did not answer')
        }
    }, [workspaceId])
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- load sets state only after its fetch resolves
        void load()
        const id = setInterval(() => void load(), 10000)
        return () => clearInterval(id)
    }, [load])

    return (
        <Section title="ACTIVITY">
            {error && <Empty>{error}</Empty>}
            {!data && !error && <Empty>Loading activity</Empty>}
            {data && (
                <div className="divide-y divide-zinc-900 text-[10px]">
                    <div className="p-3 space-y-1.5">
                        <div className="tracking-widest text-zinc-500">LIVE SESSIONS - {data.sessions.length}</div>
                        {data.sessions.length === 0 && <div className="text-zinc-600">Nobody is connected right now.</div>}
                        {data.sessions.map(s => (
                            <div key={s.session_id} className="flex items-center gap-2 text-zinc-300">
                                <span className="truncate">{s.username ?? '?'}{s.role ? ` (${s.role})` : ''}</span>
                                <span className="text-zinc-600 truncate">{s.workspace_name}</span>
                                <span className="truncate">{s.drone?.name ?? (s.telemetry_connected ? 'identifying' : 'no drone')}</span>
                                {s.in_air ? <Tag label="IN AIR" tone="amber" /> : s.armed ? <Tag label="ARMED" tone="red" /> : null}
                                {s.video && <Tag label="VIDEO" tone="emerald" />}
                                {s.ai_mode !== 'manual-control' && <Tag label={s.ai_mode} tone="violet" />}
                                {s.takeover && <Tag label={`HYRAK CONTROL (${s.takeover.by})`} tone="red" />}
                            </div>
                        ))}
                    </div>
                    <div className="p-3 space-y-1.5">
                        <div className="tracking-widest text-zinc-500">RECENT FLIGHTS - {data.flights.length}</div>
                        {data.flights.length === 0 && <div className="text-zinc-600">No flights recorded yet.</div>}
                        {data.flights.map(f => (
                            <div key={f.id} className="flex items-center gap-3 text-zinc-300">
                                <span>{when(f.started_at)}</span>
                                <span className="text-zinc-500 truncate">{f.drone_name ?? f.drone_id.slice(0, 8)}</span>
                                <span className="text-zinc-500">
                                    {f.in_progress ? 'in flight' : `${Math.round(f.duration_s)} s`} · {f.max_alt_m.toFixed(0)} m · {(f.distance_m / 1000).toFixed(2)} km
                                </span>
                            </div>
                        ))}
                    </div>
                    {data.audit && (
                        <div className="p-3 space-y-1.5">
                            <div className="tracking-widest text-zinc-500">RECENT AUDIT - {data.audit.length}</div>
                            {data.audit.length === 0 && <div className="text-zinc-600">No audit events yet.</div>}
                            {data.audit.map(a => (
                                <div key={a.id} className="flex items-center gap-3 text-zinc-300">
                                    <span className="text-zinc-500">{when(a.at)}</span>
                                    <span className={a.action.startsWith('session.') ? 'text-red-400' : ''}>{a.action}</span>
                                    <span className="text-zinc-500 truncate">{a.actor_name}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </Section>
    )
}
