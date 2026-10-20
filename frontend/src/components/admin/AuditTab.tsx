'use client'

// AUDIT tab of the HYRAK console: the latest access and zone events, newest
// first, optionally for one workspace. Founders see everything; others see
// the workspaces where they hold audit.view (the server filters).

import { useEffect, useState } from 'react'
import { useAccess } from '@/hooks/useAccess'
import { hasPerm, type WorkspaceInfo } from '@/lib/access'
import { fmtWhen, listAudit, listWorkspaces, type AuditEvent } from '@/lib/workspaces'
import { Btn, Empty, INPUT_CLS, Notice, TH_CLS, TR_CLS } from '@/components/admin/console'

const PAGE = 100

function detailText(d: AuditEvent['detail']): string {
    if (!d) return ''
    return Object.entries(d)
        .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' ')
}

export default function AuditTab() {
    const { isFounder } = useAccess()
    const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
    const [wsId, setWsId] = useState('')
    const [events, setEvents] = useState<AuditEvent[] | null>(null)
    const [error, setError] = useState('')
    const [more, setMore] = useState(false)
    const [loadingMore, setLoadingMore] = useState(false)

    useEffect(() => {
        void listWorkspaces().then(r => { if (r.ok) setWorkspaces(r.data) })
    }, [])

    const options = workspaces.filter(w => isFounder || hasPerm(w, 'audit.view'))
    // Non-founders must name a workspace: the server answers 403 to "all".
    const effective = wsId || (isFounder ? '' : options[0]?.id ?? '')

    const [tick, setTick] = useState(0)
    useEffect(() => {
        if (!isFounder && !effective) return
        let alive = true
        void listAudit({ workspace_id: effective || undefined, limit: PAGE }).then(r => {
            if (!alive) return
            if (r.ok) { setEvents(r.data); setMore(r.data.length >= PAGE); setError('') }
            else setError(r.error)
        })
        return () => { alive = false }
    }, [effective, isFounder, tick])

    async function older() {
        const last = events?.[events.length - 1]
        if (!last) return
        setLoadingMore(true)
        // `before` is an event id (docs/ACCESS_MODEL.md section 7, Audit).
        const r = await listAudit({ workspace_id: effective || undefined, limit: PAGE, before: last.id })
        setLoadingMore(false)
        if (!r.ok) { setError(r.error); return }
        setEvents(e => [...(e ?? []), ...r.data])
        setMore(r.data.length >= PAGE)
    }

    const wsName = (id: string | null) => (id ? workspaces.find(w => w.id === id)?.name ?? id.slice(0, 8) : '-')

    return (
        <div className="flex-1 overflow-y-auto p-5">
            <div className="max-w-5xl mx-auto space-y-3">
                <div className="flex items-center gap-3">
                    <h2 className="text-[18px] font-bold text-app-text">Audit log</h2>
                    <select value={effective} onChange={e => { setWsId(e.target.value); setEvents(null) }}
                        aria-label="Filter by workspace" className={`${INPUT_CLS} ml-auto`}>
                        {isFounder && <option value="">all workspaces</option>}
                        {options.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                    <Btn onClick={() => setTick(t => t + 1)}>Refresh</Btn>
                </div>
                <Notice error={error} />
                {!isFounder && options.length === 0 && <Empty>None of your workspaces lets you view its audit log.</Empty>}
                {events === null && !error && (isFounder || options.length > 0) && <Empty>Loading events…</Empty>}
                {events?.length === 0 && <Empty>No events yet.</Empty>}
                {events && events.length > 0 && (
                    <div className="border border-app-border rounded-[10px] bg-app-surface overflow-x-auto">
                        <table className="w-full text-[13px]">
                            <thead>
                                <tr className="border-b border-app-border bg-app-surface-2">
                                    <th className={TH_CLS}>When</th>
                                    <th className={TH_CLS}>Who</th>
                                    <th className={TH_CLS}>Action</th>
                                    <th className={TH_CLS}>Workspace</th>
                                    <th className={TH_CLS}>Target</th>
                                    <th className={TH_CLS}>Detail</th>
                                </tr>
                            </thead>
                            <tbody>
                                {events.map(ev => (
                                    <tr key={ev.id} className={`${TR_CLS} align-top`}>
                                        <td className="px-3 py-2 text-app-text-muted whitespace-nowrap tabular-nums">{fmtWhen(ev.at)}</td>
                                        <td className="px-3 py-2 text-app-text whitespace-nowrap">{ev.actor_name ?? '-'}</td>
                                        <td className="px-3 py-2 font-code text-[12px] text-app-text whitespace-nowrap">{ev.action}</td>
                                        <td className="px-3 py-2 text-app-text-muted whitespace-nowrap">{wsName(ev.workspace_id)}</td>
                                        <td className="px-3 py-2 text-app-text-muted whitespace-nowrap">
                                            {ev.target_type ?? ''}{ev.target_id ? ` ${ev.target_id.slice(0, 8)}` : ''}
                                        </td>
                                        <td className="px-3 py-2 text-app-text-muted break-all" title={ev.ip ? `from ${ev.ip}` : undefined}>
                                            {detailText(ev.detail)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {more && (
                    <Btn onClick={() => void older()} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load older'}</Btn>
                )}
            </div>
        </div>
    )
}
