/**
 * Custom Models step 1: the typed client for /api/models
 * (docs/custom_models/DESIGN.md section 0) plus the plain-word helpers the
 * library, the add-model panel and the Command drawer share.
 *
 * The server is the final check on every call. Errors come back as
 * { message, hint } so the UI can always say what happened and what to do.
 */
import { apiFetch, apiJson } from './api'
import { authHeaders, redirectToLogin } from './auth'
import { getServerUrl } from './server-url'
import type { RuleAction } from '@/types/vision'

export type ModelTask = 'detect' | 'classify'
export type ModelStatus = 'checking' | 'ready' | 'failed'
export type ModelSource = 'upload' | 'huggingface'

export interface ModelVersion {
    id: string
    n: number
    sha256: string | null
    size_bytes: number | null
    input_shape: number[] | null
    labels: string[]
    latency_ms: number | null
    gpu_mem_mb: number | null
    preview_path?: string | null
    created_at: string
    /** Not in the table spec; shown in Details when the server sends it. */
    opset?: number | null
    status?: ModelStatus
}

/** "Alert me when [label] is seen above [min_score]". */
export interface AlertRule {
    label: string
    /** 0..1 */
    min_score: number
    cooldown_s?: number
}

/** What a rule does when it fires. hover and follow move the drone. */
export type { RuleAction }

/** A no-code rule: "When [label] is seen above [min_score] for [for_s] s,
 *  then [action]". The server is the final check (service.py). */
export interface ModelRule {
    /** 8-16 chars [a-z0-9], made here and kept stable. */
    id: string
    enabled: boolean
    label: string
    /** 0.05..0.99 */
    min_score: number
    /** Seen this long without a break, 0..30 s. */
    for_s: number
    action: RuleAction
    /** Ask the pilot first (hover and follow only). */
    confirm: boolean
    /** After firing it waits this long before it can fire again, 5..600 s. */
    cooldown_s: number
}

export const MAX_RULES = 6

export interface CustomModel {
    id: string
    workspace_id: string | null
    name: string
    description: string | null
    task: ModelTask | null
    source: ModelSource
    hf_repo: string | null
    hf_revision: string | null
    hf_file: string | null
    status: ModelStatus
    error: string | null
    error_hint: string | null
    current_version: number | null
    published: boolean
    created_by: string | null
    created_at: string
    updated_at: string
    /** The current version, when the server inlines it. */
    version?: ModelVersion | null
    /** All versions, newest first (GET /{id}). */
    versions?: ModelVersion[]
    /** Model-level labels, when the server keeps them outside the version. */
    labels?: string[]
    /** The check's current step while status is checking. */
    step?: string | null
    progress?: number | null
    alert?: AlertRule | null
    /** No-code rules; when missing, a legacy `alert` shows as one rule. */
    rules?: ModelRule[] | null
    /** Sensitivity: show a box from this score (0..1). Default 0.25. */
    threshold?: number
    /** Only these class names show; null or missing: all. */
    classes_shown?: string[] | null
    /** Small objects: split each frame into tiles. Default off. */
    tiling?: Tiling
}

export type Tiling = 'off' | 'auto' | '2x2' | '3x3'

/** The three run settings, as the Settings section and Add's More options edit them. */
export interface RunSettings {
    threshold: number
    classes_shown: string[] | null
    tiling: Tiling
}

export const DEFAULT_THRESHOLD = 0.25

export function runSettingsOf(m: CustomModel | null | undefined): RunSettings {
    const t = m?.threshold
    return {
        threshold: typeof t === 'number' && Number.isFinite(t) ? t : DEFAULT_THRESHOLD,
        classes_shown: Array.isArray(m?.classes_shown) ? m!.classes_shown : null,
        tiling: m?.tiling ?? 'off',
    }
}

/** Model passes per frame for a tiling (the full frame plus the tiles). */
export function passesFor(tiling: Tiling | string | null | undefined, frameWidth?: number): number {
    if (tiling === '2x2') return 5
    if (tiling === '3x3') return 10
    if (tiling === 'auto') return frameWidth != null && frameWidth <= 1280 ? 1 : 5
    return 1
}

export const TILING_WORDS: Record<Exclude<Tiling, 'off'>, { label: string; line: string }> = {
    auto: { label: 'Auto', line: 'Splits into 4 tiles only when the video is wider than 1280 px.' },
    '2x2': { label: '2x2', line: '4 tiles plus the whole frame: about 5 times the work.' },
    '3x3': { label: '3x3', line: '9 tiles plus the whole frame: about 10 times the work. For tiny objects.' },
}

/** A built-in mode as the server lists it under `hyrak`. Catalogue models
 *  published by HYRAK are full CustomModel rows in the same list. */
export interface BuiltinEntry {
    id: string
    kind: 'builtin'
    mode: string
    name?: string
    description?: string
    status?: ModelStatus
}

export type HyrakEntry = BuiltinEntry | (CustomModel & { kind?: 'catalogue' })

export interface Premium { enabled: boolean; reason: string | null }

export interface ModelList {
    hyrak: HyrakEntry[]
    workspace: CustomModel[]
    premium: Premium
}

export interface HfOnnxFile { path: string; size_bytes: number | null }

export interface HfInspect {
    repo: string
    sha: string
    onnx_files: HfOnnxFile[]
    labels: string[] | null
    task: ModelTask | null
    /** Optional extras when the server has them. */
    description?: string | null
    downloads?: number | null
}

/** model_status socket push while a model is checked. */
export interface ModelStatusEvent {
    id: string
    status: ModelStatus
    step?: string | null
    error?: string | null
    hint?: string | null
    progress?: number | null
}

export interface ApiProblem { message: string; hint: string | null; status: number; code?: string | null }

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiProblem }

// ── errors ─────────────────────────────────────────────────────────────

/** FastAPI sends { detail: "..." } or { detail: { error, hint } }; our own
 *  routes may send { error, hint }. Any of them becomes { message, hint }. */
export function problemFrom(data: unknown, status: number): ApiProblem {
    const fallback = status === 0
        ? 'The HYRAK server could not be reached. Check the connection and try again.'
        : status === 403
            ? 'Your role in this workspace cannot do this. Ask a workspace admin.'
            : status === 413
                ? 'This file is larger than the upload limit. Export a smaller model or ask HYRAK to raise the limit.'
                : 'Something went wrong on the HYRAK server. Try again in a moment.'
    const d = (data ?? {}) as Record<string, unknown>
    const detail = d.detail
    // FastAPI request validation (422): a list of {loc, msg}. Say which field.
    if (Array.isArray(detail) && detail.length) {
        const first = detail[0] as { loc?: unknown[]; msg?: string }
        const field = Array.isArray(first.loc) ? String(first.loc[first.loc.length - 1]) : 'request'
        return { message: `HYRAK could not accept this request (${field}: ${first.msg ?? 'invalid'}).`,
            hint: 'Try again. If it keeps happening, tell HYRAK what you clicked.', status }
    }
    const obj = (detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : d) as Record<string, unknown>
    const pick = (...keys: string[]) => {
        for (const k of keys) {
            const v = obj[k]
            if (typeof v === 'string' && v.trim()) return v.trim()
        }
        return null
    }
    const message = (typeof detail === 'string' && detail.trim()) ? detail.trim()
        : pick('error', 'message', 'detail') ?? fallback
    return { message, hint: pick('hint', 'error_hint'), status, code: pick('code') }
}

async function call<T>(path: string, init: Parameters<typeof apiJson>[1] = {}): Promise<Result<T>> {
    try {
        const r = await apiJson<T>(path, init)
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: problemFrom(r.data, r.status) }
    } catch {
        return { ok: false, error: problemFrom(null, 0) }
    }
}

function unwrap(m: unknown): CustomModel {
    const o = m as { model?: CustomModel }
    return (o && typeof o === 'object' && o.model ? o.model : m) as CustomModel
}

// ── REST: /api/models ──────────────────────────────────────────────────

export async function listModels(workspaceId: string | null): Promise<Result<ModelList>> {
    const q = workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : ''
    const r = await call<Partial<ModelList>>(`/api/models${q}`)
    if (!r.ok) return r
    return {
        ok: true,
        data: {
            hyrak: Array.isArray(r.data.hyrak) ? r.data.hyrak : [],
            workspace: Array.isArray(r.data.workspace) ? r.data.workspace : [],
            premium: { enabled: !!r.data.premium?.enabled, reason: r.data.premium?.reason ?? null },
        },
    }
}

export async function getModel(id: string): Promise<Result<CustomModel>> {
    const r = await call<unknown>(`/api/models/${encodeURIComponent(id)}`)
    return r.ok ? { ok: true, data: unwrap(r.data) } : r
}

export interface ModelPatch {
    name?: string
    description?: string | null
    labels?: string[]
    task?: ModelTask
    /** Beyond section 0: the optional alert rule, null to clear it. */
    alert?: AlertRule | null
    rules?: ModelRule[]
    threshold?: number
    /** null shows every class again. */
    classes_shown?: string[] | null
    tiling?: Tiling
}

export async function updateModel(id: string, patch: ModelPatch): Promise<Result<CustomModel>> {
    const r = await call<unknown>(`/api/models/${encodeURIComponent(id)}`, { method: 'PATCH', json: patch })
    return r.ok ? { ok: true, data: unwrap(r.data) } : r
}

export async function deleteModel(id: string): Promise<Result<unknown>> {
    return call(`/api/models/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function retestModel(id: string): Promise<Result<CustomModel>> {
    const r = await call<unknown>(`/api/models/${encodeURIComponent(id)}/retest`, { method: 'POST' })
    return r.ok ? { ok: true, data: unwrap(r.data) } : r
}

export async function publishModel(id: string): Promise<Result<CustomModel>> {
    const r = await call<unknown>(`/api/models/${encodeURIComponent(id)}/publish`, { method: 'POST' })
    return r.ok ? { ok: true, data: unwrap(r.data) } : r
}

/** The preview image's path, for useApiObjectUrl (bearer fetch into a blob).
 *  `v` busts the cache after a re-test. */
export function previewPath(id: string, v?: string | number | null): string {
    return `/api/models/${encodeURIComponent(id)}/preview${v != null ? `?v=${encodeURIComponent(String(v))}` : ''}`
}

export async function inspectHuggingFace(repo: string, signal?: AbortSignal): Promise<Result<HfInspect>> {
    try {
        const res = await apiFetch(`/api/models/huggingface/inspect?repo=${encodeURIComponent(repo)}`, { signal })
        let data: unknown = {}
        try { data = await res.json() } catch { /* non-JSON */ }
        if (!res.ok) return { ok: false, error: problemFrom(data, res.status) }
        const d = data as Partial<HfInspect> & { onnx_files?: (HfOnnxFile | string)[] }
        return {
            ok: true,
            data: {
                repo: d.repo ?? repo,
                sha: d.sha ?? '',
                onnx_files: (d.onnx_files ?? []).map(f => typeof f === 'string' ? { path: f, size_bytes: null } : f),
                labels: Array.isArray(d.labels) ? d.labels : null,
                task: d.task ?? null,
                description: d.description ?? null,
                downloads: d.downloads ?? null,
            },
        }
    } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e
        return { ok: false, error: problemFrom(null, 0) }
    }
}

export async function importHuggingFace(body: {
    workspace_id: string | null; repo: string; file?: string | null; name?: string | null
}): Promise<Result<CustomModel>> {
    const r = await call<unknown>('/api/models/huggingface', { method: 'POST', json: body })
    return r.ok ? { ok: true, data: unwrap(r.data) } : r
}

// ── browse: recommended list and Hugging Face search ──────────────────

/** One HYRAK-curated model (GET /api/models/huggingface/recommended). */
export interface RecommendedModel {
    repo: string
    file: string
    name: string
    category: string
    task: ModelTask
    /** One plain sentence. */
    what: string
    license: string
    /** Set for licences with commercial strings attached. */
    license_note: string | null
    classes_preview: string[]
    /** Frames per second measured on HYRAK, when verified. */
    fps: number | null
    verified_at: string | null
    url: string
    /** This workspace's model id when it already has this one. */
    added: string | null
    /** That model's status when the list was made (the store has the live one). */
    added_status?: ModelStatus | null
}

export interface RecommendedList {
    premium: Premium
    can_manage: boolean
    categories: { name: string; models: RecommendedModel[] }[]
}

export type SearchTask = 'all' | 'detect' | 'classify' | 'segment'

/** One search result card (GET /api/models/huggingface/search). */
export interface HfSearchCard {
    repo: string
    name: string
    url: string
    task: ModelTask | 'segment' | null
    downloads: number
    likes: number
    updated: string | null
    license: string | null
    license_note: string | null
    onnx_files: string[]
    suggested_file: string | null
    /** HYRAK can add it today. */
    runnable: boolean
    /** Why not, in plain words, when not runnable. */
    reason: string | null
    added: string | null
    added_status?: ModelStatus | null
}

export interface HfSearchResult {
    query: string
    task: SearchTask
    page: number
    has_more: boolean
    /** "Ready to run only" was on. */
    ready: boolean
    /** An earlier answer, served because Hugging Face asked us to wait. */
    stale: boolean
    results: HfSearchCard[]
    premium: Premium
    can_manage: boolean
}

export async function getRecommended(workspaceId: string | null): Promise<Result<RecommendedList>> {
    const q = workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : ''
    const r = await call<Partial<RecommendedList>>(`/api/models/huggingface/recommended${q}`)
    if (!r.ok) return r
    return {
        ok: true,
        data: {
            premium: { enabled: !!r.data.premium?.enabled, reason: r.data.premium?.reason ?? null },
            can_manage: !!r.data.can_manage,
            categories: Array.isArray(r.data.categories) ? r.data.categories : [],
        },
    }
}

export async function searchHuggingFace(opts: {
    q: string; task: SearchTask; page?: number; ready?: boolean; workspaceId: string | null; signal?: AbortSignal
}): Promise<Result<HfSearchResult>> {
    const params = new URLSearchParams({ q: opts.q, task: opts.task, page: String(opts.page ?? 1) })
    if (opts.ready) params.set('ready', 'true')
    if (opts.workspaceId) params.set('workspace_id', opts.workspaceId)
    try {
        const res = await apiFetch(`/api/models/huggingface/search?${params}`, { signal: opts.signal })
        let data: unknown = {}
        try { data = await res.json() } catch { /* non-JSON */ }
        if (!res.ok) return { ok: false, error: problemFrom(data, res.status) }
        const d = data as Partial<HfSearchResult>
        return {
            ok: true,
            data: {
                query: d.query ?? opts.q, task: d.task ?? opts.task, page: d.page ?? 1,
                has_more: !!d.has_more, ready: !!d.ready, stale: !!d.stale,
                results: Array.isArray(d.results) ? d.results : [],
                premium: { enabled: !!d.premium?.enabled, reason: d.premium?.reason ?? null },
                can_manage: !!d.can_manage,
            },
        }
    } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e
        return { ok: false, error: problemFrom(null, 0) }
    }
}

/** True for "Hugging Face is busy" and "too many searches": wait and retry. */
export const isRateLimited = (e: ApiProblem) =>
    e.status === 429 || e.code === 'hf_rate_limited' || e.code === 'search_rate_limited'

/** 12345 -> "12.3k". */
export function compactCount(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
    return String(n)
}

/** ISO date -> "3 days ago" / "5 months ago". */
export function ago(iso: string | null): string | null {
    if (!iso) return null
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) return null
    const days = Math.max(0, Math.round((Date.now() - t) / 86_400_000))
    if (days < 1) return 'today'
    if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
    const months = Math.round(days / 30)
    if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`
    const years = Math.round(days / 365)
    return `${years} year${years === 1 ? '' : 's'} ago`
}

/** POST /api/models as multipart, with upload progress and a cancel.
 *  XHR rather than fetch: fetch has no upload progress. */
export function uploadModel(file: File, opts: {
    workspaceId: string | null
    name?: string | null
    onProgress?: (fraction: number) => void
}): { promise: Promise<Result<CustomModel> | { ok: false; cancelled: true }>; cancel: () => void } {
    const xhr = new XMLHttpRequest()
    const promise = new Promise<Result<CustomModel> | { ok: false; cancelled: true }>(resolve => {
        const form = new FormData()
        form.append('file', file)
        if (opts.name) form.append('name', opts.name)
        if (opts.workspaceId) form.append('workspace_id', opts.workspaceId)
        xhr.open('POST', `${getServerUrl()}/api/models`)
        for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v)
        xhr.upload.onprogress = e => { if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total) }
        xhr.onload = () => {
            let data: unknown = {}
            try { data = JSON.parse(xhr.responseText) } catch { /* non-JSON */ }
            if (xhr.status === 401) { redirectToLogin(); return }
            if (xhr.status >= 200 && xhr.status < 300) resolve({ ok: true, data: unwrap(data) })
            else resolve({ ok: false, error: problemFrom(data, xhr.status) })
        }
        xhr.onerror = () => resolve({ ok: false, error: problemFrom(null, 0) })
        xhr.onabort = () => resolve({ ok: false, cancelled: true })
        xhr.send(form)
    })
    return { promise, cancel: () => xhr.abort() }
}

// ── plain words ────────────────────────────────────────────────────────

export const CUSTOM_PREFIX = 'custom:'
export const customMode = (id: string) => `${CUSTOM_PREFIX}${id}`
export const isCustomMode = (mode: string) => mode.startsWith(CUSTOM_PREFIX)
export const customIdOf = (mode: string) => isCustomMode(mode) ? mode.slice(CUSTOM_PREFIX.length) : null

export const TASK_WORDS: Record<ModelTask, { title: string; line: string }> = {
    detect: { title: 'Finds objects', line: 'Finds objects and draws boxes around them' },
    classify: { title: 'Names the picture', line: 'Looks at the whole picture and says what it shows' },
}

/** The check's steps in the order the user sees them. Server step names
 *  map onto these; an unknown step shows as its own words. */
export const CHECK_STEPS = [
    { key: 'receive', label: 'Receive the file' },
    { key: 'inspect', label: 'Read the model' },
    { key: 'test', label: 'Test on sample images' },
] as const
export type CheckStepKey = typeof CHECK_STEPS[number]['key']

export function checkStepOf(step: string | null | undefined): CheckStepKey | 'done' | null {
    if (!step) return null
    const s = step.toLowerCase()
    if (/(upload|receiv|download|fetch|store)/.test(s)) return 'receive'
    if (/(inspect|read|pars|analy|load)/.test(s)) return 'inspect'
    if (/(test|bench|preview|run)/.test(s)) return 'test'
    if (/(done|ready|complete)/.test(s)) return 'done'
    return null
}

export function stepWords(step: string | null | undefined, source?: ModelSource): string {
    const k = checkStepOf(step)
    if (k === 'receive') return source === 'huggingface' ? 'Downloading' : 'Receiving'
    if (k === 'inspect') return 'Reading the model'
    if (k === 'test') return 'Testing'
    if (k === 'done') return 'Finishing'
    if (!step) return 'Checking'
    return step.charAt(0).toUpperCase() + step.slice(1).replace(/[_-]+/g, ' ')
}

/** 23.8 -> "about 40 frames per second". */
export function speedSentence(latencyMs: number | null | undefined): string | null {
    if (!latencyMs || !Number.isFinite(latencyMs) || latencyMs <= 0) return null
    const fps = 1000 / latencyMs
    if (fps < 1) {
        const s = Math.round(latencyMs / 1000)
        return `about one picture every ${s} second${s === 1 ? '' : 's'}`
    }
    const rounded = fps >= 20 ? Math.round(fps / 5) * 5 : Math.round(fps)
    return `about ${rounded} frame${rounded === 1 ? '' : 's'} per second`
}

export function labelsOf(m: CustomModel | null | undefined): string[] {
    if (!m) return []
    return m.version?.labels ?? m.versions?.[0]?.labels ?? m.labels ?? []
}

export function currentVersionOf(m: CustomModel | null | undefined): ModelVersion | null {
    if (!m) return null
    if (m.version) return m.version
    const vs = m.versions ?? []
    return vs.find(v => v.n === m.current_version) ?? vs[0] ?? null
}

/** One line for a card: the description, else what the task does with the
 *  first few class names. */
export function blurbFor(m: CustomModel): string {
    if (m.description?.trim()) return m.description.trim()
    const labels = labelsOf(m)
    if (m.task === 'classify') {
        return labels.length ? `Says which of ${labels.length} kinds of picture it sees` : TASK_WORDS.classify.line
    }
    if (m.task === 'detect' && labels.length) {
        const shown = labels.slice(0, 3).join(', ')
        return `Finds ${shown}${labels.length > 3 ? ` and ${labels.length - 3} more` : ''}`
    }
    if (m.status === 'checking') return 'Being checked - this takes about a minute'
    return m.source === 'huggingface' && m.hf_repo ? `From Hugging Face: ${m.hf_repo}` : 'Your uploaded model'
}

/** File checks done before any byte leaves the browser, each with the fix. */
export function preflightFile(file: File, maxBytes = 500 * 1024 * 1024): ApiProblem | null {
    const name = file.name.toLowerCase()
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''
    if (ext === '.pt' || ext === '.pth') {
        return {
            message: `"${file.name}" is a PyTorch model. HYRAK runs ONNX models for now.`,
            hint: 'Export it to ONNX first, for example: yolo export model=best.pt format=onnx',
            status: 0,
        }
    }
    if (ext === '.safetensors' || ext === '.bin' || ext === '.ckpt' || ext === '.h5' || ext === '.tflite' || ext === '.engine') {
        return {
            message: `"${file.name}" is not an ONNX file. HYRAK runs ONNX models for now.`,
            hint: 'Export the model to ONNX (.onnx) and drop that file here.',
            status: 0,
        }
    }
    if (ext !== '.onnx') {
        return { message: `"${file.name}" is not an .onnx file.`, hint: 'Pick a file that ends in .onnx.', status: 0 }
    }
    if (file.size > maxBytes) {
        return {
            message: `This file is ${Math.round(file.size / 1024 / 1024)} MB; the limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`,
            hint: 'Export a smaller model, or ask HYRAK to raise the limit for your workspace.',
            status: 0,
        }
    }
    if (file.size === 0) return { message: 'This file is empty.', hint: 'Pick the exported .onnx file again.', status: 0 }
    return null
}

/** "https://huggingface.co/owner/name/blob/main/model.onnx" -> { repo, file }.
 *  Also takes hf.co links and a bare "owner/name". Null when it is not a
 *  Hugging Face model link. */
export function parseHfLink(raw: string): { repo: string; file: string | null } | null {
    const s = raw.trim()
    if (!s) return null
    const bare = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+)$/.exec(s)
    if (bare) return { repo: `${bare[1]}/${bare[2]}`, file: null }
    let url: URL
    try { url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`) } catch { return null }
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (host !== 'huggingface.co' && host !== 'hf.co') return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] === 'datasets' || parts[0] === 'spaces') return null
    if (parts[0] === 'models') parts.shift()
    if (parts.length < 2) return null
    const repo = `${parts[0]}/${parts[1]}`
    // /blob/<rev>/<path> or /resolve/<rev>/<path> names one file.
    let file: string | null = null
    if ((parts[2] === 'blob' || parts[2] === 'resolve') && parts.length > 4) {
        const p = parts.slice(4).join('/')
        if (p.toLowerCase().endsWith('.onnx')) file = decodeURIComponent(p)
    }
    return { repo, file }
}

/** Text a customer can send to HYRAK to ask for the premium feature. */
export function accessRequestText(workspaceName: string | null, workspaceId: string | null): string {
    return [
        'Hello HYRAK,',
        '',
        `Please turn on Custom models for our workspace${workspaceName ? ` "${workspaceName}"` : ''}${workspaceId ? ` (id ${workspaceId})` : ''}.`,
        'We would like to run our own ONNX models on the drone video.',
    ].join('\n')
}
