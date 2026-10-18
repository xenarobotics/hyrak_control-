/**
 * The model library's state: the last GET /api/models for the active
 * workspace, plus the live `model_status` pushes merged on top. Shared by
 * the AI tab and the Command window's AI drawer so both show the same
 * statuses without each keeping its own copy.
 */
import { create } from 'zustand'
import type { CustomModel, HyrakEntry, ModelStatusEvent, Premium } from '@/lib/models'

interface ModelsState {
    workspaceId: string | null
    /** null until the first answer for this workspace. */
    loadedFor: string | null
    loading: boolean
    loadError: string | null
    /** The server has no /api/models (older backend): built-ins still run. */
    unavailable: boolean
    hyrak: HyrakEntry[]
    workspace: CustomModel[]
    premium: Premium
    live: Record<string, ModelStatusEvent>

    setLoading: (workspaceId: string | null) => void
    setLoaded: (workspaceId: string | null, data: { hyrak: HyrakEntry[]; workspace: CustomModel[]; premium: Premium }) => void
    setFailed: (workspaceId: string | null, error: string, unavailable: boolean) => void
    upsert: (m: CustomModel) => void
    remove: (id: string) => void
    applyStatus: (e: ModelStatusEvent) => void
}

export const useModelsStore = create<ModelsState>((set) => ({
    workspaceId: null,
    loadedFor: null,
    loading: false,
    loadError: null,
    unavailable: false,
    hyrak: [],
    workspace: [],
    premium: { enabled: false, reason: null },
    live: {},

    setLoading: (workspaceId) => set(s => ({
        loading: true,
        workspaceId,
        // A different workspace starts clean: its models are not these.
        ...(s.workspaceId !== workspaceId ? { workspace: [], hyrak: [], live: {}, loadedFor: null } : {}),
    })),
    setLoaded: (workspaceId, data) => set(s => s.workspaceId !== workspaceId ? {} : {
        loading: false, loadError: null, unavailable: false, loadedFor: workspaceId ?? '',
        hyrak: data.hyrak, workspace: data.workspace, premium: data.premium,
        // A fresh row supersedes a push about the same model.
        live: Object.fromEntries(Object.entries(s.live).filter(([id]) =>
            !data.workspace.some(m => m.id === id && m.status !== 'checking'))),
    }),
    setFailed: (workspaceId, error, unavailable) => set(s => s.workspaceId !== workspaceId ? {} : {
        loading: false, loadError: error, unavailable, loadedFor: workspaceId ?? '',
    }),
    upsert: (m) => set(s => {
        const i = s.workspace.findIndex(x => x.id === m.id)
        const workspace = i >= 0 ? s.workspace.map(x => x.id === m.id ? { ...x, ...m } : x) : [m, ...s.workspace]
        const live = { ...s.live }
        if (m.status !== 'checking') delete live[m.id]
        return { workspace, live }
    }),
    remove: (id) => set(s => {
        const live = { ...s.live }
        delete live[id]
        return { workspace: s.workspace.filter(m => m.id !== id), live }
    }),
    applyStatus: (e) => set(s => ({
        live: { ...s.live, [e.id]: e },
        workspace: s.workspace.map(m => m.id !== e.id ? m : {
            ...m,
            status: e.status,
            step: e.step ?? m.step,
            progress: e.progress ?? null,
            error: e.status === 'failed' ? (e.error ?? m.error) : null,
            error_hint: e.status === 'failed' ? (e.hint ?? m.error_hint) : null,
        }),
    })),
}))
