'use client'

/**
 * One list of runnable models for the AI tab and the Command drawer: the
 * HYRAK built-in modes, HYRAK catalogue models and this workspace's own
 * models, each with a plain name, one line, a status and the mode string
 * that runs it (`custom:<id>` for anything that is not built in).
 *
 * Built-ins never depend on the server answering: if /api/models is down or
 * missing, the HYRAK models still list and run.
 */
import { useCallback, useEffect, useMemo } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
    Box, Boxes, Layers, ScanFace, ScanLine, ScanSearch, Sparkles, TrafficCone, Users, UsersRound, Tags,
} from 'lucide-react'
import { AVAILABLE_MODES } from '@/components/vision/ModeSelector'
import { useActiveWorkspace, useAccess } from '@/hooks/useAccess'
import { useLiveScope } from '@/hooks/useLiveScope'
import { getSocket } from '@/lib/socket'
import {
    blurbFor, customMode, getModel, listModels,
    type BuiltinEntry, type CustomModel, type HyrakEntry, type ModelStatus, type ModelStatusEvent,
} from '@/lib/models'
import { useModelsStore } from '@/store/models'

export interface LibraryEntry {
    /** Stable React key. */
    key: string
    /** What set_analysis_mode is sent. */
    mode: string
    group: 'hyrak' | 'ours'
    name: string
    blurb: string
    icon: LucideIcon
    color: string
    status: ModelStatus
    step: string | null
    progress: number | null
    error: string | null
    hint: string | null
    /** The model row for anything that is not built in. */
    model: CustomModel | null
}

/** Built-in modes in plain words, in the order a newcomer meets them. The
 *  mode strings and colours match ModeSelector.MODES. */
const BUILTINS: { mode: string; name: string; blurb: string; icon: LucideIcon; color: string }[] = [
    { mode: 'object-detection', name: 'Objects', blurb: 'Finds everyday objects like people, cars and bikes, and draws boxes', icon: ScanSearch, color: '#60a5fa' },
    { mode: 'human-tracking', name: 'People', blurb: 'Finds people and follows the one you pick', icon: Users, color: '#4ade80' },
    { mode: 'person-tracking', name: 'Find a person', blurb: 'Recognises one chosen person and keeps them in view', icon: ScanFace, color: '#22d3ee' },
    { mode: 'crowd-management', name: 'Crowd', blurb: 'Counts people and warns when an area gets crowded', icon: UsersRound, color: '#38bdf8' },
    { mode: 'vehicle-plate-tracking', name: 'Number plates', blurb: 'Reads vehicle number plates', icon: ScanLine, color: '#a3e635' },
    { mode: 'traffic-management', name: 'Traffic', blurb: 'Counts vehicles, reads plates and measures speed', icon: TrafficCone, color: '#38bdf8' },
    { mode: 'depth-mapping', name: 'Depth', blurb: 'Shows how far away things are', icon: Layers, color: '#f59e0b' },
    { mode: 'enhance', name: 'Clearer picture', blurb: 'Cleans up noise and sharpens the video', icon: Sparkles, color: '#fbbf24' },
    { mode: '3d-reconstruction', name: '3D scan', blurb: 'Builds a 3D map of what the camera sees', icon: Box, color: '#34d399' },
]

const CUSTOM_COLOR = '#22d3ee'

function entryFromModel(m: CustomModel, group: 'hyrak' | 'ours'): LibraryEntry {
    return {
        key: `${group}:${m.id}`,
        mode: customMode(m.id),
        group,
        name: m.name,
        blurb: blurbFor(m),
        icon: m.task === 'classify' ? Tags : Boxes,
        color: CUSTOM_COLOR,
        status: m.status,
        step: m.step ?? null,
        progress: m.progress ?? null,
        error: m.error,
        hint: m.error_hint,
        model: m,
    }
}

function builtinEntries(fromServer: HyrakEntry[]): LibraryEntry[] {
    const server = new Map(
        fromServer.filter((e): e is BuiltinEntry => (e as BuiltinEntry).kind === 'builtin')
            .map(e => [e.mode, e]),
    )
    return BUILTINS
        .filter(b => AVAILABLE_MODES.includes(b.mode))
        // When the server lists built-ins, it decides which exist here.
        .filter(b => server.size === 0 || server.has(b.mode))
        .map(b => ({
            key: `builtin:${b.mode}`, mode: b.mode, group: 'hyrak' as const,
            name: b.name, blurb: b.blurb, icon: b.icon, color: b.color,
            status: server.get(b.mode)?.status ?? 'ready',
            step: null, progress: null, error: null, hint: null, model: null,
        }))
}

/** Whether the current account may run / manage models on the active
 *  workspace. UI only; the server checks every call. */
export function useModelAccess() {
    const { isStaff, isFounder, user } = useAccess()
    const { customer, perms, workspace } = useLiveScope()
    const staffCan = isStaff && user?.role !== 'viewer'
    return {
        workspace,
        canRun: customer ? perms.includes('models.run') : true,
        canManage: customer ? perms.includes('models.manage') : staffCan,
        canPublish: isFounder,
    }
}

const POLL_MS = 2_000

/** Load the library for the active workspace, keep it live, and return the
 *  merged entries. Safe to mount in more than one place. */
export function useModelLibrary() {
    const { workspace } = useActiveWorkspace()
    const wsId = workspace?.id ?? null
    const st = useModelsStore()

    const reload = useCallback(async () => {
        const s = useModelsStore.getState()
        s.setLoading(wsId)
        const r = await listModels(wsId)
        if (r.ok) s.setLoaded(wsId, r.data)
        else s.setFailed(wsId, r.error.message, r.error.status === 404 || r.error.status === 405)
    }, [wsId])

    useEffect(() => { void reload() }, [reload])

    // Live progress pushes. The socket's older model_status (built-in model
    // loading, { status, mode }) has no id and is ignored here.
    useEffect(() => {
        const socket = getSocket()
        const on = (e: ModelStatusEvent) => {
            if (!e || typeof e.id !== 'string') return
            useModelsStore.getState().applyStatus(e)
        }
        socket.on('model_status', on)
        return () => { socket.off('model_status', on) }
    }, [])

    // Poll models that are checking, so progress shows even when the push
    // is missed (socket reconnecting, another tab added the model).
    const checkingIds = st.workspace.filter(m => m.status === 'checking').map(m => m.id).join(',')
    useEffect(() => {
        if (!checkingIds) return
        const ids = checkingIds.split(',')
        const t = setInterval(() => {
            for (const id of ids) {
                void getModel(id).then(r => { if (r.ok) useModelsStore.getState().upsert(r.data) })
            }
        }, POLL_MS)
        return () => clearInterval(t)
    }, [checkingIds])

    const entries = useMemo(() => {
        const catalogue = st.hyrak.filter((e): e is CustomModel => (e as BuiltinEntry).kind !== 'builtin' && 'status' in e)
        return [
            ...builtinEntries(st.hyrak),
            ...catalogue.map(m => entryFromModel(m, 'hyrak')),
            ...st.workspace.map(m => entryFromModel(m, 'ours')),
        ]
    }, [st.hyrak, st.workspace])

    return {
        entries,
        premium: st.premium,
        loading: st.loading && st.loadedFor === null,
        loadError: st.unavailable ? null : st.loadError,
        unavailable: st.unavailable,
        reload,
        workspace,
    }
}

/** The library entry for a running mode (built-in or `custom:<id>`), read
 *  from the store without loading it; null for manual-control. */
export function useLibraryEntry(mode: string): LibraryEntry | null {
    const workspace = useModelsStore(s => s.workspace)
    const hyrak = useModelsStore(s => s.hyrak)
    return useMemo(() => {
        if (mode.startsWith('custom:')) {
            const id = mode.slice(7)
            const ours = workspace.find(x => x.id === id)
            if (ours) return entryFromModel(ours, 'ours')
            const cat = hyrak.find((x): x is CustomModel => (x as CustomModel).id === id && (x as BuiltinEntry).kind !== 'builtin')
            if (cat) return entryFromModel(cat, 'hyrak')
            return {
                key: mode, mode, group: 'ours', name: 'Custom model', blurb: '', icon: Boxes, color: CUSTOM_COLOR,
                status: 'ready', step: null, progress: null, error: null, hint: null, model: null,
            }
        }
        return builtinEntries([]).find(e => e.mode === mode) ?? null
    }, [mode, workspace, hyrak])
}

/** A display name for any mode string, including `custom:<id>`. */
export function useModeName(mode: string): string {
    const workspace = useModelsStore(s => s.workspace)
    const hyrak = useModelsStore(s => s.hyrak)
    if (mode.startsWith('custom:')) {
        const id = mode.slice(7)
        const m = workspace.find(x => x.id === id)
            ?? hyrak.find((x): x is CustomModel => (x as CustomModel).id === id && (x as BuiltinEntry).kind !== 'builtin')
        return m?.name ?? 'Custom model'
    }
    return BUILTINS.find(b => b.mode === mode)?.name ?? mode.replace(/-/g, ' ')
}
