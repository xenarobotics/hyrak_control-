'use client'

// One model's detail as a slide-over from its card: preview, Settings
// (what it does, sensitivity, shown classes, small-object tiling; saved on
// change), classes, the no-code rules (ModelRules), versions, and Rename (in place), Re-test,
// Delete (named confirmation inside the panel, never a second modal) and,
// for founders, Publish to HYRAK catalogue. Technical facts sit behind a
// Details disclosure.

import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Globe, Pencil, Play, RefreshCw, Trash2, Loader } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/formatBytes'
import { useApiObjectUrl } from '@/hooks/useApiMedia'
import {
    currentVersionOf, deleteModel, getModel, labelsOf, previewPath, publishModel, retestModel, speedSentence,
    TASK_WORDS, updateModel, type ApiProblem, type CustomModel,
} from '@/lib/models'
import { useModelsStore } from '@/store/models'
import { ClassChips } from './ClassChips'
import { ModelSettingsSection, type SettingFocus } from './ModelSettings'
import { RulesSection } from './ModelRules'
import { Callout, Hint, SlideOver, StatusChip, css as s } from './ui'

// Mount with key={modelId}: each model starts with a clean panel.
export function ModelDetailPanel({ modelId, open, onOpenChange, editable, canPublish, canRun, running, onRun, onDeleted, focus }: {
    modelId: string | null
    open: boolean
    onOpenChange: (open: boolean) => void
    /** Our workspace's model and the account has models.manage. */
    editable: boolean
    canPublish: boolean
    canRun: boolean
    running: boolean
    onRun: (m: CustomModel) => void
    onDeleted: (name: string) => void
    /** Opened from a results chip: scroll to and focus this setting. */
    focus?: SettingFocus | null
}) {
    const fromStore = useModelsStore(st => modelId ? st.workspace.find(m => m.id === modelId)
        ?? (st.hyrak.find(m => (m as CustomModel).id === modelId && (m as { kind?: string }).kind !== 'builtin') as CustomModel | undefined)
        ?? null : null)
    const [full, setFull] = useState<CustomModel | null>(null)
    const [err, setErr] = useState<ApiProblem | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const [confirmDelete, setConfirmDelete] = useState(false)
    const [note, setNote] = useState<string | null>(null)

    // The full row (versions, labels) on open and whenever the status moves.
    const status = fromStore?.status
    useEffect(() => {
        if (!modelId) return
        let alive = true
        void getModel(modelId).then(r => { if (alive && r.ok) setFull(r.data) })
        return () => { alive = false }
    }, [modelId, status])

    const m: CustomModel | null = full && fromStore ? { ...full, ...pickLive(fromStore) } : full ?? fromStore

    const apply = (next: CustomModel) => {
        setFull(next)
        useModelsStore.getState().upsert(next)
    }

    const run = async (key: string, fn: () => Promise<{ ok: true; data: CustomModel } | { ok: false; error: ApiProblem }>, done?: string) => {
        setBusy(key); setErr(null); setNote(null)
        const r = await fn()
        setBusy(null)
        if (!r.ok) { setErr(r.error); return false }
        apply(r.data)
        if (done) setNote(done)
        return true
    }

    if (!m) {
        return (
            <SlideOver open={open} onOpenChange={onOpenChange} title="Model">
                <div className={s.skel} style={{ height: 30, width: '60%' }} />
                <div className={cn(s.skel, s.preview)} />
                <div className={s.skel} style={{ height: 60 }} />
            </SlideOver>
        )
    }

    const v = currentVersionOf(m)
    const labels = labelsOf(m)
    const speed = speedSentence(v?.latency_ms)
    const ready = m.status === 'ready'

    // The named confirmation takes the footer's place, right where Delete
    // was pressed, instead of stacking a second dialog on the panel.
    const foot = confirmDelete ? (
                <DeleteConfirm name={m.name} busy={busy === 'delete'}
                    onCancel={() => setConfirmDelete(false)}
                    onConfirm={async () => {
                        setBusy('delete'); setErr(null)
                        const r = await deleteModel(m.id)
                        setBusy(null)
                        if (!r.ok) { setErr(r.error); setConfirmDelete(false); return }
                        useModelsStore.getState().remove(m.id)
                        onDeleted(m.name)
                    }} />
    ) : (
        <>
            {editable && (
                <button type="button" className={s.btn} onClick={() => setConfirmDelete(true)}
                    aria-expanded={confirmDelete}
                    style={{ color: 'var(--cm-bad)', borderColor: 'color-mix(in srgb, var(--cm-bad) 45%, transparent)' }}>
                    <Trash2 size={13} aria-hidden /> Delete
                </button>
            )}
            {/* Delete stays on the far left, away from the everyday actions. */}
            <span className={s.spacer} />
            {editable && (
                <button type="button" className={s.btn} aria-busy={busy === 'retest' || undefined}
                    onClick={() => run('retest', () => retestModel(m.id), 'Testing again. This takes about a minute.')}>
                    {busy === 'retest' ? <Loader size={13} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw size={13} aria-hidden />} Re-test
                </button>
            )}
            {canRun && ready && !running && (
                <button type="button" className={cn(s.btn, s.primary)} onClick={() => onRun(m)}>
                    <Play size={13} aria-hidden /> Run
                </button>
            )}
            {running && <span className={cn(s.chip, s.chipInfo)}><span className={s.dot} aria-hidden />Running</span>}
        </>
    )

    return (
        <SlideOver open={open} onOpenChange={onOpenChange}
            title={editable ? <RenameInline value={m.name} onSave={name => run('rename', () => updateModel(m.id, { name }))} /> : m.name}
            description={m.source === 'huggingface' && m.hf_repo ? `From Hugging Face: ${m.hf_repo}` : m.published && !m.workspace_id ? 'A HYRAK catalogue model' : 'Uploaded by your team'}
            head={<div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <StatusChip status={m.status} step={m.step} progress={m.progress} source={m.source} />
                {m.task && <span className={cn(s.chip, s.chipMute)}>{TASK_WORDS[m.task].title}</span>}
                {m.published && <span className={cn(s.chip, s.chipInfo)}><Globe size={10} aria-hidden />In HYRAK catalogue</span>}
            </div>}
            foot={foot}>

            {err && <Callout tone="bad" title={err.message}><Hint text={err.hint} /></Callout>}
            {note && <Callout tone="info">{note}</Callout>}

            {m.status === 'failed' && (
                <Callout tone="bad" title={m.error ?? 'This model did not pass its check.'}
                    actions={editable ? (
                        <button type="button" className={s.btn} onClick={() => run('retest', () => retestModel(m.id), 'Testing again.')}>Test again</button>
                    ) : null}>
                    <Hint text={m.error_hint ?? 'Ask whoever added it to fix the model and test it again.'} />
                </Callout>
            )}

            {ready && (
                <div className={s.section}>
                    <span className={s.label}>Test result</span>
                    <Preview model={m} />
                    {speed && <p className={s.speed}>Runs at {speed}.</p>}
                </div>
            )}

            {m.task && (
                <ModelSettingsSection model={m} labels={labels} editable={editable} focus={focus}
                    onSaved={apply} />
            )}

            <div className={s.section}>
                <span className={s.label}>{m.task === 'classify' ? 'Answers it can give' : 'Things it finds'} ({labels.length})</span>
                {editable && <p className={s.help}>Click a name to change how it shows on the video.</p>}
                <ClassChips labels={labels} readOnly={!editable}
                    onChange={next => run('labels', () => updateModel(m.id, { labels: next }))} />
            </div>

            {labels.length > 0 && (
                <RulesSection model={m} labels={labels} editable={editable} onSaved={apply} />
            )}

            {(m.versions?.length ?? 0) > 0 && (
                <div className={s.section}>
                    <span className={s.label}>Versions</span>
                    <ul className={cn(s.inset, s.versions)} style={{ padding: '0 10px' }}>
                        {m.versions!.map(x => (
                            <li key={x.id ?? x.n}>
                                <span className={s.mono}>v{x.n}</span>
                                <span>
                                    {new Date(x.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                                    {x.size_bytes ? <span className={s.help}> - {formatBytes(x.size_bytes)}</span> : null}
                                </span>
                                <span className={s.help}>{x.n === m.current_version ? 'In use' : speedSentence(x.latency_ms) ?? ''}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {canPublish && m.workspace_id && (
                <div className={s.section}>
                    <span className={s.label}>HYRAK catalogue</span>
                    {m.published ? (
                        <p className={s.muted}>Published. Every workspace sees it under HYRAK models.</p>
                    ) : (
                        <>
                            <p className={s.muted}>Founders only. Puts this model under HYRAK models for every workspace.</p>
                            <button type="button" className={s.btn} style={{ alignSelf: 'flex-start' }}
                                onClick={() => ready
                                    ? void run('publish', () => publishModel(m.id), 'Published to the HYRAK catalogue.')
                                    : setNote('Only a Ready model can be published. Wait for the check to pass, then publish.')}>
                                <Globe size={13} aria-hidden /> Publish to HYRAK catalogue
                            </button>
                        </>
                    )}
                </div>
            )}

            <details className={s.details}>
                <summary className={s.label}><ChevronRight size={12} className={s.disclosureIcon} aria-hidden />Details</summary>
                <dl className={s.kv}>
                    <dt>Task</dt><dd>{m.task ?? '-'}</dd>
                    <dt>Input shape</dt><dd>{v?.input_shape ? `[${v.input_shape.join(', ')}]` : '-'}</dd>
                    <dt>ONNX opset</dt><dd>{v?.opset ?? '-'}</dd>
                    <dt>Latency</dt><dd>{v?.latency_ms != null ? `${v.latency_ms.toFixed(1)} ms` : '-'}</dd>
                    <dt>GPU memory</dt><dd>{v?.gpu_mem_mb != null ? `${Math.round(v.gpu_mem_mb)} MB` : '-'}</dd>
                    <dt>Size</dt><dd>{v?.size_bytes ? formatBytes(v.size_bytes) : '-'}</dd>
                    <dt>SHA-256</dt><dd>{v?.sha256 ?? '-'}</dd>
                    {m.source === 'huggingface' && <>
                        <dt>Hugging Face</dt><dd>{m.hf_repo ?? '-'}</dd>
                        <dt>File</dt><dd>{m.hf_file ?? '-'}</dd>
                        <dt>Commit</dt><dd>{m.hf_revision ?? '-'}</dd>
                    </>}
                    <dt>Model id</dt><dd>{m.id}</dd>
                </dl>
            </details>
        </SlideOver>
    )
}

/** Live fields from the store win over the fetched row (pushes are newer). */
function pickLive(x: CustomModel): Partial<CustomModel> {
    return { status: x.status, step: x.step, progress: x.progress, error: x.error, error_hint: x.error_hint, name: x.name }
}

function Preview({ model }: { model: CustomModel }) {
    const v = currentVersionOf(model)
    const url = useApiObjectUrl(previewPath(model.id, v?.id ?? model.updated_at))
    // eslint-disable-next-line @next/next/no-img-element
    return url ? <img src={url} alt={`${model.name} on a sample image, with what it found boxed`} className={s.preview} />
        : <div className={cn(s.skel, s.preview)} aria-hidden />
}

/** Rename in place: the title and its input share one box. */
function RenameInline({ value, onSave }: { value: string; onSave: (v: string) => Promise<boolean> }) {
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState(value)
    const [err, setErr] = useState<string | null>(null)
    const skip = useRef(false)
    const commit = async () => {
        if (skip.current) { skip.current = false; return }
        const t = draft.trim()
        if (!t) { setErr('Give the model a name.'); return }
        if (t.length > 60) { setErr('Keep the name under 60 characters.'); return }
        setEditing(false); setErr(null)
        if (t !== value) await onSave(t)
    }
    return (
        <span style={{ display: 'flex', flexDirection: 'column' }}>
            <span className={s.renameBox}>
                <button type="button" className={s.renameShow} onClick={() => { setDraft(value); setEditing(true) }}
                    style={{ visibility: editing ? 'hidden' : undefined }} tabIndex={editing ? -1 : 0}
                    aria-label={`Rename ${value}`} title="Rename">
                    <span>{value}</span><Pencil size={13} aria-hidden style={{ color: 'var(--cm-ink-2)', flexShrink: 0 }} />
                </button>
                {editing && (
                    <input autoFocus size={1} className={s.renameInput} value={draft} aria-label="Model name"
                        aria-invalid={err ? true : undefined}
                        onChange={e => { setDraft(e.target.value); setErr(null) }}
                        onBlur={() => void commit()}
                        onKeyDown={e => {
                            if (e.key === 'Enter') { e.preventDefault(); void commit() }
                            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); skip.current = true; setEditing(false); setErr(null) }
                        }} />
                )}
            </span>
            {err && <span className={s.fieldErr} role="alert" style={{ fontWeight: 400 }}>{err}</span>}
        </span>
    )
}

function DeleteConfirm({ name, busy, onCancel, onConfirm }: {
    name: string; busy: boolean; onCancel: () => void; onConfirm: () => void
}) {
    const cancel = useRef<HTMLButtonElement>(null)
    useEffect(() => { cancel.current?.focus() }, [])
    return (
        <div className={s.confirm} style={{ flex: 1 }} role="alertdialog" aria-labelledby="cm-del-title" aria-describedby="cm-del-body"
            onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }}>
            <strong id="cm-del-title">Delete model &quot;{name}&quot;?</strong>
            <p id="cm-del-body" className={s.muted}>
                It stops running for everyone in this workspace, and all its versions are removed. This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button ref={cancel} type="button" className={s.btn} onClick={onCancel}>Cancel</button>
                <button type="button" className={cn(s.btn, s.danger)} onClick={onConfirm} aria-busy={busy || undefined}>
                    {busy ? <Loader size={13} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Trash2 size={13} aria-hidden />} Delete model
                </button>
            </div>
        </div>
    )
}
