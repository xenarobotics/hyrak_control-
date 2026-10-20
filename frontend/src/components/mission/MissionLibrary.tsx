'use client'

// The workspace's saved missions (docs/ACCESS_MODEL.md 8d): open one into
// the planner, save the current plan as new or over the one it came from,
// rename, delete. A viewer only opens. Lives in a popover on the Mission
// tab toolbar, QGroundControl's "Plan > Open / Save" in one place.

import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, Save, Trash2, Loader2, Pencil, X } from 'lucide-react'
import { useMissionStore } from '@/store/mission'
import {
    deleteMission, fmtWhen, fromWire, getMission, listMissions, requestPlanFit, saveMission, updateMission,
    type SavedMission,
} from '@/lib/planning'
import { cn } from '@/lib/utils'
import { BTN, BTN_DANGER, BTN_PRIMARY, FOCUS, INPUT, LABEL, POPOVER } from './ui'

function fmtDist(m: number): string {
    return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`
}

export interface LoadedPlan { id: string; name: string }

export default function MissionLibrary({ workspaceId, canPlan, droneId, loaded, onLoaded, onClose }: {
    workspaceId: string | null
    canPlan: boolean
    droneId: string | null
    /** The saved mission the planner currently holds, if it came from here. */
    loaded: LoadedPlan | null
    onLoaded: (p: LoadedPlan | null) => void
    onClose: () => void
}) {
    const waypoints = useMissionStore(s => s.waypoints)
    const importWaypoints = useMissionStore(s => s.importWaypoints)
    const [missions, setMissions] = useState<SavedMission[] | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [name, setName] = useState('')
    const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

    const refresh = useCallback(async () => {
        setError(null)
        try { setMissions(await listMissions(workspaceId)) }
        catch (e) { setError((e as Error).message); setMissions([]) }
    }, [workspaceId])

    // Load the list when the popover opens (it mounts on open).
    useEffect(() => {
        let alive = true
        listMissions(workspaceId)
            .then(m => { if (alive) setMissions(m) })
            .catch(e => { if (alive) { setError((e as Error).message); setMissions([]) } })
        return () => { alive = false }
    }, [workspaceId])

    const open = async (m: SavedMission) => {
        setBusy(m.id); setError(null)
        try {
            const full = await getMission(m.id)
            importWaypoints(fromWire(full.waypoints ?? [], `saved_${m.id.slice(0, 8)}`))
            onLoaded({ id: m.id, name: m.name || 'Untitled' })
            requestPlanFit()
            onClose()
        } catch (e) { setError((e as Error).message) }
        finally { setBusy(null) }
    }

    const saveNew = async () => {
        const n = name.trim()
        if (!n || waypoints.length === 0) return
        setBusy('save'); setError(null)
        try {
            const m = await saveMission(workspaceId, n, waypoints, droneId)
            onLoaded({ id: m.id, name: m.name })
            setName('')
            await refresh()
        } catch (e) { setError((e as Error).message) }
        finally { setBusy(null) }
    }

    const saveOver = async () => {
        if (!loaded || waypoints.length === 0) return
        setBusy('over'); setError(null)
        try {
            await updateMission(loaded.id, { waypoints })
            await refresh()
        } catch (e) { setError((e as Error).message) }
        finally { setBusy(null) }
    }

    const rename = async () => {
        if (!renaming || !renaming.name.trim()) return
        setBusy(renaming.id); setError(null)
        try {
            const m = await updateMission(renaming.id, { name: renaming.name.trim() })
            if (loaded?.id === m.id) onLoaded({ id: m.id, name: m.name })
            setRenaming(null)
            await refresh()
        } catch (e) { setError((e as Error).message) }
        finally { setBusy(null) }
    }

    const remove = async (id: string) => {
        setBusy(id); setError(null)
        try {
            await deleteMission(id)
            if (loaded?.id === id) onLoaded(null)
            setConfirmDelete(null)
            await refresh()
        } catch (e) { setError((e as Error).message) }
        finally { setBusy(null) }
    }

    const ICON_BTN = cn('w-8 h-8 rounded-[6px] flex items-center justify-center text-app-text-muted hover:text-app-text hover:bg-app-surface-2 transition-colors duration-[120ms]', FOCUS)
    const saveBlocked = !name.trim() ? 'Type a name first' : waypoints.length === 0 ? 'Add waypoints on the map first' : busy !== null ? 'Busy' : undefined

    return (
        <div className={cn(POPOVER, 'w-80 max-w-[calc(100vw-32px)] overflow-hidden')}
            onMouseDown={e => e.stopPropagation()}>
            <div className="flex items-center justify-between pl-4 pr-2 py-2 border-b border-app-border">
                <span className="text-base font-bold text-app-text">Saved missions</span>
                <button onClick={onClose} title="Close" aria-label="Close" className={ICON_BTN}>
                    <X size={14} />
                </button>
            </div>

            {canPlan && (
                <div className="px-4 py-3 space-y-2 border-b border-app-border">
                    <label className={cn(LABEL, 'block')} htmlFor="mission-save-name">
                        Save current plan as
                    </label>
                    <div className="flex gap-2">
                        <input id="mission-save-name" value={name} onChange={e => setName(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') void saveNew() }}
                            maxLength={120} placeholder="e.g. North field survey"
                            className={cn(INPUT, 'flex-1 min-w-0')} />
                        <button onClick={() => void saveNew()}
                            disabled={!name.trim() || waypoints.length === 0 || busy !== null}
                            title={saveBlocked ?? 'Save as a new mission'}
                            className={BTN_PRIMARY}>
                            {busy === 'save' ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save
                        </button>
                    </div>
                    {loaded && (
                        <button onClick={() => void saveOver()} disabled={waypoints.length === 0 || busy !== null}
                            className={cn(BTN, 'w-full justify-start')}
                            title={waypoints.length === 0 ? 'Add waypoints on the map first' : 'Replace the saved waypoints with the plan on the map'}>
                            <Save size={13} />
                            <span className="truncate">{busy === 'over' ? 'Saving…' : `Update "${loaded.name}"`}</span>
                        </button>
                    )}
                    {waypoints.length === 0 && (
                        <p className="text-[13px] text-app-text-muted">Add waypoints on the map to save a plan.</p>
                    )}
                </div>
            )}

            {error && (
                <div className="px-4 py-2 text-[13px] text-app-danger bg-app-danger-soft" role="alert">{error}</div>
            )}

            <div className="max-h-72 overflow-y-auto">
                {missions === null ? (
                    <div className="px-4 py-3 text-[13px] text-app-text-muted flex items-center gap-2" role="status">
                        <Loader2 size={13} className="animate-spin" /> Loading
                    </div>
                ) : missions.length === 0 ? (
                    <div className="px-4 py-5 flex flex-col items-center gap-1.5 text-center">
                        <FolderOpen size={18} className="text-app-text-muted" />
                        <p className="text-[13px] text-app-text-muted">No saved missions yet.</p>
                    </div>
                ) : missions.map(m => {
                    const red = m.zones.some(z => z.zone_class === 'red')
                    const orange = m.zones.some(z => z.zone_class !== 'green')
                    return (
                    <div key={m.id} className="px-4 py-2 border-b border-app-border last:border-b-0 group">
                        {renaming?.id === m.id ? (
                            <div className="flex gap-2">
                                <label className="sr-only" htmlFor={`rename-${m.id}`}>New name</label>
                                <input id={`rename-${m.id}`} autoFocus value={renaming.name} maxLength={120}
                                    onChange={e => setRenaming({ id: m.id, name: e.target.value })}
                                    onKeyDown={e => { if (e.key === 'Enter') void rename(); if (e.key === 'Escape') setRenaming(null) }}
                                    className={cn(INPUT, 'flex-1 min-w-0')} />
                                <button onClick={() => void rename()} className={BTN}>Rename</button>
                            </div>
                        ) : (
                            <div className="flex items-center gap-2">
                                <button onClick={() => void open(m)} disabled={busy !== null}
                                    className={cn('flex-1 min-w-0 text-left rounded-[6px] py-0.5 disabled:cursor-wait', FOCUS)} title="Open in the planner">
                                    <div className="text-[14px] font-semibold text-app-text truncate flex items-center gap-1.5">
                                        {busy === m.id ? <Loader2 size={13} className="animate-spin shrink-0" /> : <FolderOpen size={13} className="text-app-text-muted shrink-0" />}
                                        <span className="truncate">{m.name || <span className="text-app-text-muted">Untitled {m.profile_name !== 'Manual' ? `(${m.profile_name})` : ''}</span>}</span>
                                        {loaded?.id === m.id && <span className="shrink-0 text-xs font-bold px-1.5 rounded-full bg-app-accent-soft text-app-accent">Open</span>}
                                    </div>
                                    <div className="text-[13px] text-app-text-muted mt-0.5 tabular-nums">
                                        {m.waypoint_count} wp · {fmtDist(m.distance_m)} · {m.status} · {fmtWhen(m.updated_at ?? m.created_at)}
                                        {orange && (
                                            <span className={red ? 'text-app-danger font-semibold' : 'text-app-warn font-semibold'}>
                                                {' '}· {red ? 'red zone' : 'orange zone'}
                                            </span>
                                        )}
                                    </div>
                                </button>
                                {canPlan && m.editable !== false && (
                                    <div className="flex items-center gap-0.5">
                                        <button onClick={() => setRenaming({ id: m.id, name: m.name })} title="Rename" aria-label={`Rename ${m.name}`}
                                            className={ICON_BTN}><Pencil size={14} /></button>
                                        <button onClick={() => setConfirmDelete(m.id)} title="Delete" aria-label={`Delete ${m.name}`}
                                            className={cn(ICON_BTN, 'hover:text-app-danger')}><Trash2 size={14} /></button>
                                    </div>
                                )}
                            </div>
                        )}
                        {confirmDelete === m.id && (
                            <div className="mt-2 flex items-center gap-2 text-[13px]">
                                <span className="flex-1 min-w-0 truncate text-app-text">Delete &ldquo;{m.name || 'Untitled'}&rdquo;?</span>
                                <button onClick={() => setConfirmDelete(null)} className={BTN}>Keep</button>
                                <button onClick={() => void remove(m.id)} className={BTN_DANGER}>
                                    Delete mission</button>
                            </div>
                        )}
                    </div>
                    )
                })}
            </div>
        </div>
    )
}
