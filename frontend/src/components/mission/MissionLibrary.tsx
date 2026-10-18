'use client'

// The workspace's saved missions (docs/ACCESS_MODEL.md 8b): open one into
// the planner, save the current plan as new or over the one it came from,
// rename, delete. A viewer only opens. Lives in a popover on the Mission
// tab toolbar, QGroundControl's "Plan > Open / Save" in one place.

import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, Save, Trash2, Loader2, Pencil, X } from 'lucide-react'
import { useMissionStore } from '@/store/mission'
import {
    deleteMission, fmtWhen, fromWire, getMission, listMissions, saveMission, updateMission,
    type SavedMission,
} from '@/lib/planning'

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

    return (
        <div className="w-80 rounded-xl border shadow-2xl overflow-hidden font-mono"
            style={{ background: 'rgba(17,19,24,.97)', borderColor: 'rgba(255,255,255,.1)' }}
            onMouseDown={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: 'rgba(255,255,255,.08)' }}>
                <span className="text-[10px] tracking-widest font-bold text-gray-400">SAVED MISSIONS</span>
                <button onClick={onClose} title="Close" aria-label="Close" className="p-1 rounded text-gray-500 hover:text-gray-200">
                    <X size={12} />
                </button>
            </div>

            {canPlan && (
                <div className="px-3 py-2 space-y-1.5 border-b" style={{ borderColor: 'rgba(255,255,255,.08)' }}>
                    <label className="block text-[9px] tracking-wider text-gray-500" htmlFor="mission-save-name">
                        SAVE CURRENT PLAN AS
                    </label>
                    <div className="flex gap-1.5">
                        <input id="mission-save-name" value={name} onChange={e => setName(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') void saveNew() }}
                            maxLength={120} placeholder="e.g. North field survey"
                            className="flex-1 min-w-0 text-[11px] rounded px-2 py-1 outline-none"
                            style={{ background: 'rgba(255,255,255,.06)', color: '#fff', border: '1px solid rgba(255,255,255,.12)' }} />
                        <button onClick={() => void saveNew()}
                            disabled={!name.trim() || waypoints.length === 0 || busy !== null}
                            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold disabled:opacity-30"
                            style={{ background: 'rgba(59,130,246,.2)', color: '#93c5fd' }}>
                            {busy === 'save' ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />} Save
                        </button>
                    </div>
                    {loaded && (
                        <button onClick={() => void saveOver()} disabled={waypoints.length === 0 || busy !== null}
                            className="w-full text-left text-[10px] px-2 py-1 rounded disabled:opacity-30"
                            style={{ background: 'rgba(255,255,255,.05)', color: '#d1d5db' }}
                            title="Replace the saved waypoints with the plan on the map">
                            {busy === 'over' ? 'Saving…' : `Save changes to "${loaded.name}"`}
                        </button>
                    )}
                    {waypoints.length === 0 && (
                        <p className="text-[9px] text-gray-600">Add waypoints on the map to save a plan.</p>
                    )}
                </div>
            )}

            {error && (
                <div className="px-3 py-1.5 text-[10px]" style={{ color: '#fca5a5', background: 'rgba(127,29,29,.25)' }}>{error}</div>
            )}

            <div className="max-h-72 overflow-y-auto">
                {missions === null ? (
                    <div className="px-3 py-3 text-[10px] text-gray-500 flex items-center gap-2">
                        <Loader2 size={11} className="animate-spin" /> Loading
                    </div>
                ) : missions.length === 0 ? (
                    <div className="px-3 py-4 text-[10px] text-gray-500">
                        No saved missions in this workspace yet.
                        {canPlan ? ' Plan on the map, name it above and save it.' : ''}
                    </div>
                ) : missions.map(m => (
                    <div key={m.id} className="px-3 py-2 border-b group" style={{ borderColor: 'rgba(255,255,255,.04)' }}>
                        {renaming?.id === m.id ? (
                            <div className="flex gap-1.5">
                                <label className="sr-only" htmlFor={`rename-${m.id}`}>New name</label>
                                <input id={`rename-${m.id}`} autoFocus value={renaming.name} maxLength={120}
                                    onChange={e => setRenaming({ id: m.id, name: e.target.value })}
                                    onKeyDown={e => { if (e.key === 'Enter') void rename(); if (e.key === 'Escape') setRenaming(null) }}
                                    className="flex-1 min-w-0 text-[11px] rounded px-2 py-0.5 outline-none"
                                    style={{ background: 'rgba(255,255,255,.06)', color: '#fff', border: '1px solid rgba(255,255,255,.12)' }} />
                                <button onClick={() => void rename()} className="text-[10px] px-2 rounded" style={{ color: '#93c5fd' }}>Rename</button>
                            </div>
                        ) : (
                            <div className="flex items-center gap-2">
                                <button onClick={() => void open(m)} disabled={busy !== null}
                                    className="flex-1 min-w-0 text-left" title="Open in the planner">
                                    <div className="text-[11px] text-gray-100 truncate flex items-center gap-1.5">
                                        {busy === m.id ? <Loader2 size={10} className="animate-spin" /> : <FolderOpen size={10} className="text-gray-500" />}
                                        {m.name || <span className="text-gray-500">Untitled {m.profile_name !== 'Manual' ? `(${m.profile_name})` : ''}</span>}
                                        {loaded?.id === m.id && <span className="text-[8px] px-1 rounded" style={{ background: 'rgba(59,130,246,.25)', color: '#93c5fd' }}>OPEN</span>}
                                    </div>
                                    <div className="text-[9px] text-gray-500 mt-0.5">
                                        {m.waypoint_count} wp · {fmtDist(m.distance_m)} · {m.status} · {fmtWhen(m.updated_at ?? m.created_at)}
                                        {m.zones.some(z => z.zone_class !== 'green') && (
                                            <span style={{ color: m.zones.some(z => z.zone_class === 'red') ? '#f87171' : '#fbbf24' }}>
                                                {' '}· {m.zones.some(z => z.zone_class === 'red') ? 'red zone' : 'orange zone'}
                                            </span>
                                        )}
                                    </div>
                                </button>
                                {canPlan && m.editable !== false && (
                                    <div className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100">
                                        <button onClick={() => setRenaming({ id: m.id, name: m.name })} title="Rename" aria-label={`Rename ${m.name}`}
                                            className="p-1 rounded text-gray-400 hover:text-gray-100"><Pencil size={11} /></button>
                                        <button onClick={() => setConfirmDelete(m.id)} title="Delete" aria-label={`Delete ${m.name}`}
                                            className="p-1 rounded text-red-300/80 hover:text-red-300"><Trash2 size={11} /></button>
                                    </div>
                                )}
                            </div>
                        )}
                        {confirmDelete === m.id && (
                            <div className="mt-1.5 flex items-center gap-2 text-[10px]">
                                <span className="flex-1 text-red-200">Delete &ldquo;{m.name || 'Untitled'}&rdquo;?</span>
                                <button onClick={() => setConfirmDelete(null)} className="px-2 py-0.5 rounded text-gray-300" style={{ background: 'rgba(255,255,255,.06)' }}>Keep</button>
                                <button onClick={() => void remove(m.id)} className="px-2 py-0.5 rounded font-bold text-red-200" style={{ background: 'rgba(185,28,28,.5)' }}>
                                    Delete mission</button>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    )
}
