'use client'

// Add model: one slide-over, three steps (DESIGN.md section 0, rule 2).
//
//   1. Choose        three ways in, as tabs: Recommended for drones (HYRAK's
//                    picks, one click), All vision models (the Hub's most
//                    downloaded, searchable, one click on the runnable
//                    ones; an added one shows Run), or Upload a file (drop an
//                    .onnx file, or paste a Hugging Face link; it is
//                    inspected as you paste; an ONNX picker only when the
//                    repo has several)
//   2. Confirm       what the server detected, in plain words: the task, the
//                    class names (editable chips) and a name, plus "More
//                    options" (sensitivity, shown classes, small-object
//                    tiling) closed, with defaults new users can ignore
//   3. Test and save the automatic check's progress, then a preview with
//                    boxes and a speed sentence, then Save or Run now
//
// The model exists on the server from the moment it is uploaded, so closing
// the panel never loses it: it stays in Our models with its status. Without
// the premium feature (or without models.manage) the panel still browses,
// so people see what they would get; Add explains the lock instead.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    ArrowLeft, Check, CheckCircle2, ChevronRight, Circle, Copy, FileBox, Layers, Link2, Loader, Lock, Play, Search, Sparkles, Upload, X, Boxes, ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/formatBytes'
import { useApiObjectUrl } from '@/hooks/useApiMedia'
import {
    accessRequestText, CHECK_STEPS, checkStepOf, currentVersionOf, deleteModel, getModel, importHuggingFace,
    inspectHuggingFace, labelsOf, parseHfLink, preflightFile, previewPath, retestModel, speedSentence,
    runSettingsOf, TASK_WORDS, updateModel, uploadModel,
    type ApiProblem, type CustomModel, type HfInspect, type ModelTask, type Premium, type RunSettings,
} from '@/lib/models'
import { useModelsStore } from '@/store/models'
import { ClassChips } from './ClassChips'
import { SettingsFields } from './ModelSettings'
import { AllModelsTab, RecommendedTab, type AddState, type AddTarget } from './BrowseModels'
import { Callout, Hint, SlideOver, css as s } from './ui'

type Stage = 'choose' | 'confirm' | 'test'
const STAGES: { key: Stage; label: string }[] = [
    { key: 'choose', label: '1. Choose' },
    { key: 'confirm', label: '2. Confirm' },
    { key: 'test', label: '3. Test and save' },
]

export type AddSource = 'recommended' | 'all' | 'upload'
const SOURCES: { key: AddSource; label: string; short: string; icon: typeof Search }[] = [
    { key: 'recommended', label: 'Recommended for drones', short: 'Recommended', icon: Sparkles },
    { key: 'all', label: 'All vision models', short: 'All models', icon: Layers },
    { key: 'upload', label: 'Upload a file', short: 'Upload', icon: Upload },
]

/** What the page does for the panel: run a model of ours (closing the
 *  panel first), open one, and mark one in the library. */
export interface PanelRunProps {
    /** The tab the Choose step opens on. */
    initialSource?: AddSource
    canRun?: boolean
    /** Run this model through the library's run path (`custom:<id>`). */
    onRun?: (m: { id: string; name?: string }) => void
    /** Open this model's detail. */
    onOpenModel?: (id: string) => void
    /** The panel closed with a model it created: show where it went. */
    onAdded?: (m: CustomModel) => void
}

type Inspect =
    | { state: 'idle' }
    | { state: 'loading'; repo: string }
    | { state: 'ok'; data: HfInspect }
    | { state: 'error'; repo: string; error: ApiProblem }

export function AddModelPanel({ open, onOpenChange, premium, workspaceId, workspaceName, onSaved, canManage = true, ...run }: PanelRunProps & {
    open: boolean
    onOpenChange: (open: boolean) => void
    premium: Premium
    workspaceId: string | null
    workspaceName: string | null
    onSaved: (m: CustomModel) => void
    /** models.manage on the workspace; without it the panel only browses. */
    canManage?: boolean
}) {
    const addState: AddState = !canManage ? 'none' : premium.enabled ? 'add' : 'locked'
    return <AddFlow open={open} onOpenChange={onOpenChange} workspaceId={workspaceId} onSaved={onSaved}
        addState={addState} reason={premium.reason} workspaceName={workspaceName} {...run} />
}

// ── premium lock ───────────────────────────────────────────────────────

function LockedContent({ reason, workspaceId, workspaceName, onBack }: {
    reason: string | null; workspaceId: string | null; workspaceName: string | null; onBack?: () => void
}) {
    const [copied, setCopied] = useState<'ok' | 'failed' | null>(null)
    const text = accessRequestText(workspaceName, workspaceId)
    const copy = async () => {
        try { await navigator.clipboard.writeText(text); setCopied('ok') } catch { setCopied('failed') }
    }
    return (
        <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Lock size={16} aria-hidden style={{ color: 'var(--cm-accent)' }} />
                <strong style={{ color: 'var(--cm-ink)' }}>Adding models is a premium feature</strong>
            </div>
            <ul className={s.lockList}>
                <li><Boxes size={16} aria-hidden /><span>Run a model trained for your job, like spotting cracks, counting crops or finding your equipment.</span></li>
                <li><Upload size={16} aria-hidden /><span>Pick one HYRAK recommends, search Hugging Face, or upload an .onnx file. HYRAK checks and tests it for you.</span></li>
                <li><ShieldCheck size={16} aria-hidden /><span>It runs on the HYRAK server like the built-in models, with the same boxes on the video.</span></li>
            </ul>
            <Callout tone="info" title="How to get it">
                <span>
                    {reason ?? 'Custom models are not turned on for this workspace yet.'} Send HYRAK the request below and we switch it on.
                    The HYRAK models keep working in the meantime.
                </span>
            </Callout>
            <div className={s.field}>
                <span className={s.label}>Request</span>
                <pre className={s.inset} style={{ padding: 10, whiteSpace: 'pre-wrap', fontSize: 'var(--cm-small)', margin: 0, fontFamily: 'inherit' }}>{text}</pre>
                {copied === 'ok' && <p className={s.help} role="status">Copied. Paste it in an email or message to your HYRAK contact.</p>}
                {copied === 'failed' && <p className={s.help} role="status">Copying is blocked in this browser. Select the text above and copy it by hand.</p>}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className={cn(s.btn, s.primary)} onClick={copy}>
                    <Copy size={13} aria-hidden /> Copy request for HYRAK
                </button>
                {onBack && (
                    <button type="button" className={s.btn} onClick={onBack}>
                        <ArrowLeft size={13} aria-hidden /> Back to models
                    </button>
                )}
            </div>
        </>
    )
}

// ── the add flow ───────────────────────────────────────────────────────

function AddFlow({ open, onOpenChange, workspaceId, onSaved, addState, reason, workspaceName,
    initialSource = 'recommended', canRun = false, onRun, onOpenModel, onAdded }: PanelRunProps & {
    open: boolean; onOpenChange: (o: boolean) => void; workspaceId: string | null
    onSaved: (m: CustomModel) => void
    addState: AddState; reason: string | null; workspaceName: string | null
}) {
    const [stage, setStage] = useState<Stage>('choose')
    // Step 1: where the model comes from
    const [source, setSource] = useState<AddSource>('recommended')
    const [lockAsk, setLockAsk] = useState(false)
    const [adding, setAdding] = useState<string | null>(null)
    const [browseErr, setBrowseErr] = useState<ApiProblem | null>(null)
    const searchInput = useRef<HTMLInputElement>(null)
    // Step 1
    const [file, setFile] = useState<File | null>(null)
    const [fileErr, setFileErr] = useState<ApiProblem | null>(null)
    const [link, setLink] = useState('')
    const [linkErr, setLinkErr] = useState<string | null>(null)
    const [inspect, setInspect] = useState<Inspect>({ state: 'idle' })
    const [hfFile, setHfFile] = useState<string | null>(null)
    const [chooseErr, setChooseErr] = useState<string | null>(null)
    const [upload, setUpload] = useState<{ pct: number } | null>(null)
    const [importing, setImporting] = useState(false)
    const [submitErr, setSubmitErr] = useState<ApiProblem | null>(null)
    const cancelUpload = useRef<(() => void) | null>(null)
    const fileInput = useRef<HTMLInputElement>(null)
    const linkInput = useRef<HTMLInputElement>(null)
    // Created model
    const [model, setModel] = useState<CustomModel | null>(null)
    // Step 2
    const [name, setName] = useState('')
    const [nameErr, setNameErr] = useState<string | null>(null)
    const [labels, setLabels] = useState<string[]>([])
    const [task, setTask] = useState<ModelTask>('detect')
    const [detectedTask, setDetectedTask] = useState<ModelTask | null>(null)
    const [runSettings, setRunSettings] = useState<RunSettings>(() => runSettingsOf(null))
    const [filled, setFilled] = useState(false)
    const [busy, setBusy] = useState(false)
    const [stepErr, setStepErr] = useState<ApiProblem | null>(null)
    const [saveNote, setSaveNote] = useState<string | null>(null)

    const reset = useCallback(() => {
        setStage('choose'); setFile(null); setFileErr(null); setLink(''); setLinkErr(null)
        setInspect({ state: 'idle' }); setHfFile(null); setChooseErr(null); setUpload(null)
        setImporting(false); setSubmitErr(null); setModel(null); setName(''); setNameErr(null)
        setLabels([]); setTask('detect'); setDetectedTask(null); setFilled(false); setBusy(false)
        setRunSettings(runSettingsOf(null))
        setStepErr(null); setSaveNote(null)
        setSource(initialSource); setLockAsk(false); setAdding(null); setBrowseErr(null)
    }, [initialSource])

    // A fresh panel every time it opens; an upload in flight stops on close.
    const close = (o: boolean) => {
        if (!o) {
            cancelUpload.current?.()
            if (model) {
                useModelsStore.getState().upsert(model)
                onAdded?.(live ?? model)
            }
        }
        onOpenChange(o)
    }
    // Run from a card or from step 3: close the panel, then the page runs it
    // the way the library's Run does (which also starts the video).
    const runModel = (id: string, name?: string) => {
        cancelUpload.current?.()
        if (model && model.id !== id) onAdded?.(live ?? model)
        onOpenChange(false)
        onRun?.({ id, name })
    }
    const openModel = (id: string) => {
        if (model) onAdded?.(live ?? model)
        onOpenChange(false)
        onOpenModel?.(id)
    }
    useEffect(() => { if (open) reset() }, [open, reset])

    // Live model: socket pushes land in the store; poll here as well so the
    // panel has labels and versions (the list row may not carry them).
    const live = useModelsStore(st => model ? st.workspace.find(m => m.id === model.id) ?? null : null)
    const status = live?.status ?? model?.status ?? 'checking'
    const step = live?.step ?? model?.step ?? null
    useEffect(() => {
        if (!model || !open) return
        let alive = true
        const tick = async () => {
            const r = await getModel(model.id)
            if (!alive || !r.ok) return
            setModel(r.data)
            useModelsStore.getState().upsert(r.data)
        }
        void tick()
        if (status !== 'checking') return () => { alive = false }
        const t = setInterval(tick, 1500)
        return () => { alive = false; clearInterval(t) }
        // Keyed on the id and status only: every tick replaces `model`.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [model?.id, open, status])

    // Fill step 2 once the server has read the model.
    useEffect(() => {
        if (!model || filled || !model.task) return
        setName(model.name ?? '')
        setLabels(labelsOf(model))
        setTask(model.task)
        setDetectedTask(model.task)
        setRunSettings(runSettingsOf(model))
        setFilled(true)
    }, [model, filled])

    // "/" jumps to the Hugging Face search, wherever the panel is in step 1.
    useEffect(() => {
        if (!open || stage !== 'choose') return
        const key = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null
            if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
            e.preventDefault()
            setLockAsk(false)
            setSource('all')
            setTimeout(() => searchInput.current?.focus(), 0)
        }
        window.addEventListener('keydown', key)
        return () => window.removeEventListener('keydown', key)
    }, [open, stage])

    // ── step 1: one click from Recommended or Search ──
    const addFromHub = async (t: AddTarget) => {
        if (adding) return
        setBrowseErr(null)
        setAdding(t.repo)
        const r = await importHuggingFace({ workspace_id: workspaceId, repo: t.repo, file: t.file, name: t.name ?? null })
        setAdding(null)
        if (!r.ok) { setBrowseErr(r.error); return }
        created(r.data)
    }

    const pickSource = (k: AddSource) => { setSource(k); setLockAsk(false); setBrowseErr(null) }
    const onTabKey = (e: React.KeyboardEvent) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
        e.preventDefault()
        const i = SOURCES.findIndex(x => x.key === source)
        const next = SOURCES[(i + (e.key === 'ArrowRight' ? 1 : SOURCES.length - 1)) % SOURCES.length].key
        pickSource(next)
        setTimeout(() => document.getElementById(`cm-src-${next}`)?.focus(), 0)
    }

    // ── step 1: Hugging Face link, inspected as it is pasted ──
    const parsed = useMemo(() => parseHfLink(link), [link])
    useEffect(() => {
        if (!parsed) { setInspect({ state: 'idle' }); return }
        const ac = new AbortController()
        setInspect({ state: 'loading', repo: parsed.repo })
        const t = setTimeout(() => {
            inspectHuggingFace(parsed.repo, ac.signal).then(r => {
                if (ac.signal.aborted) return
                if (!r.ok) { setInspect({ state: 'error', repo: parsed.repo, error: r.error }); return }
                setInspect({ state: 'ok', data: r.data })
                const files = r.data.onnx_files.map(f => f.path)
                setHfFile(parsed.file && files.includes(parsed.file) ? parsed.file : files[0] ?? null)
            }).catch(() => { /* aborted */ })
        }, 450)
        return () => { clearTimeout(t); ac.abort() }
    }, [parsed])

    const pickFile = (f: File | null | undefined) => {
        if (!f) return
        setChooseErr(null); setSubmitErr(null)
        setLink(''); setLinkErr(null)
        setFile(f)
        setFileErr(preflightFile(f))
    }

    const onLinkBlur = () => {
        if (link.trim() && !parsed) setLinkErr('Paste a Hugging Face model link, like huggingface.co/owner/model-name.')
    }

    const hfReady = inspect.state === 'ok' && inspect.data.onnx_files.length > 0
    const primaryLabel = file ? 'Upload model' : link.trim() ? 'Import model' : 'Add model'

    // A failed draft is replaced, not left behind, when the user tries again.
    const discardDraft = async () => {
        if (!model) return
        const id = model.id
        setModel(null); setFilled(false)
        await deleteModel(id)
        useModelsStore.getState().remove(id)
    }

    const startOver = async (focus: 'file' | 'link') => {
        await discardDraft()
        setStage('choose'); setSubmitErr(null); setStepErr(null)
        if (focus === 'file') { setFile(null); setFileErr(null); setTimeout(() => fileInput.current?.click(), 0) }
        else { setTimeout(() => linkInput.current?.focus(), 0) }
    }

    const submit = async () => {
        setSubmitErr(null)
        if (!file && !link.trim()) {
            setChooseErr('Drop an .onnx file or paste a Hugging Face link first.')
            return
        }
        if (file) {
            if (fileErr) return
            const job = uploadModel(file, { workspaceId, onProgress: pct => setUpload({ pct }) })
            cancelUpload.current = job.cancel
            setUpload({ pct: 0 })
            const r = await job.promise
            cancelUpload.current = null
            setUpload(null)
            if (!r.ok) {
                if ('cancelled' in r) { setSubmitErr({ message: 'Upload cancelled. Nothing was saved.', hint: null, status: 0 }); return }
                setSubmitErr(r.error); return
            }
            created(r.data)
            return
        }
        if (!parsed) { setLinkErr('Paste a Hugging Face model link, like huggingface.co/owner/model-name.'); linkInput.current?.focus(); return }
        if (inspect.state === 'loading') return
        if (!hfReady) { linkInput.current?.focus(); return }
        setImporting(true)
        const r = await importHuggingFace({ workspace_id: workspaceId, repo: inspect.data.repo, file: hfFile })
        setImporting(false)
        if (!r.ok) { setSubmitErr(r.error); return }
        created(r.data)
    }

    const created = (m: CustomModel) => {
        setModel(m)
        useModelsStore.getState().upsert(m)
        setStage('confirm')
    }

    // ── step 2 -> 3 ──
    const validateName = (v: string) => {
        const t = v.trim()
        if (!t) return 'Give the model a name, like "Crack finder".'
        if (t.length > 60) return 'Keep the name under 60 characters.'
        return null
    }
    const toTest = async () => {
        if (!model) return
        const err = validateName(name)
        if (err) { setNameErr(err); document.getElementById('cm-add-name')?.focus(); return }
        setBusy(true); setStepErr(null)
        const shown = runSettings.classes_shown?.filter(l => labels.includes(l)) ?? null
        const r = await updateModel(model.id, {
            name: name.trim(), labels, task,
            threshold: runSettings.threshold, tiling: runSettings.tiling,
            classes_shown: shown && shown.length && shown.length < labels.length ? shown : null,
        })
        if (!r.ok) { setBusy(false); setStepErr(r.error); return }
        let m = r.data
        if (detectedTask && task !== detectedTask) {
            const rt = await retestModel(model.id)
            if (rt.ok) m = rt.data
        }
        setBusy(false)
        setModel(m)
        useModelsStore.getState().upsert(m)
        setStage('test')
    }

    const retest = async () => {
        if (!model) return
        setBusy(true); setStepErr(null)
        const r = await retestModel(model.id)
        setBusy(false)
        if (!r.ok) { setStepErr(r.error); return }
        setModel(r.data); useModelsStore.getState().upsert(r.data)
    }

    const runNow = () => {
        if (!model || status !== 'ready') return
        runModel(model.id, (live ?? model).name)
    }

    const save = () => {
        if (!model) return
        if (status === 'checking') {
            setSaveNote('The test is still running. You can close this panel: the model appears in Our models and turns Ready by itself.')
            return
        }
        if (status === 'failed') {
            setSaveNote('This model did not pass the test. Fix it with the steps above, or close the panel and come back to it later.')
            return
        }
        onSaved(live ?? model)
        onOpenChange(false)
    }

    const failed = status === 'failed'
    const failure: ApiProblem | null = failed
        ? { message: live?.error ?? model?.error ?? 'The check did not pass.', hint: live?.error_hint ?? model?.error_hint ?? null, status: 0 }
        : null
    // A failure before the model was read belongs to step 1: wrong file.
    const earlyFailure = failed && !model?.task

    const stageIdx = STAGES.findIndex(x => x.key === stage)
    const stepper = (
        <ol className={s.steps} aria-label="Steps">
            {STAGES.map((x, i) => (
                <li key={x.key} data-state={i < stageIdx ? 'done' : i === stageIdx ? 'now' : 'next'}
                    aria-current={i === stageIdx ? 'step' : undefined}>{x.label}</li>
            ))}
        </ol>
    )

    // ── footers ──
    let foot: React.ReactNode
    const browsing = source !== 'upload' || addState !== 'add' || lockAsk
    if (stage === 'choose' && browsing) {
        foot = (
            <>
                <span className={s.help} style={{ flex: 1 }}>
                    {addState === 'none' ? 'Ask a workspace admin to add a model you like.' : null}
                </span>
                <button type="button" className={s.btn} onClick={() => close(false)}>Close</button>
            </>
        )
    } else if (stage === 'choose') {
        foot = upload ? (
            <>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }} role="status">
                    <span className={s.help}>Uploading {Math.round(upload.pct * 100)}%</span>
                    <div className={s.bar}><i style={{ width: `${upload.pct * 100}%` }} /></div>
                </div>
                <button type="button" className={s.btn} onClick={() => cancelUpload.current?.()}>Cancel upload</button>
            </>
        ) : (
            <>
                <span className={s.spacer} />
                <button type="button" className={s.btn} onClick={() => close(false)}>Cancel</button>
                <button type="button" className={cn(s.btn, s.primary)} onClick={submit}
                    aria-busy={importing || (!!link.trim() && inspect.state === 'loading') || undefined}>
                    {importing || (!file && inspect.state === 'loading')
                        ? <><Loader size={13} className="animate-spin motion-reduce:animate-none" aria-hidden /> {importing ? 'Importing' : 'Checking the link'}</>
                        : <>{file ? <Upload size={13} aria-hidden /> : link.trim() ? <Link2 size={13} aria-hidden /> : null} {primaryLabel}</>}
                </button>
            </>
        )
    } else if (stage === 'confirm') {
        foot = (
            <>
                <span className={s.help} style={{ flex: 1 }}>
                    {earlyFailure ? 'This file cannot run as it is. Fix it with the step above.' : 'The check keeps running if you close this.'}
                </span>
                {!earlyFailure && filled && (
                    <button type="button" className={cn(s.btn, s.primary)} onClick={toTest} aria-busy={busy || undefined}>
                        {busy ? <Loader size={13} className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
                        Test model
                    </button>
                )}
            </>
        )
    } else {
        const canRunNow = canRun && !!onRun
        foot = (
            <>
                <button type="button" className={s.btn} onClick={() => setStage('confirm')}>Back</button>
                <span className={s.spacer} />
                <button type="button" className={cn(s.btn, !canRunNow && s.primary)} onClick={save}>
                    <Check size={13} aria-hidden /> Save model
                </button>
                {canRunNow && (
                    <button type="button" className={cn(s.btn, s.primary)} onClick={runNow}
                        disabled={status !== 'ready'} aria-describedby={status !== 'ready' ? 'cm-run-now-help' : undefined}
                        title={status === 'ready' ? 'Save it and run it on the live video' : status === 'failed' ? 'Fix the test first' : 'Ready when the test finishes'}>
                        <Play size={13} aria-hidden /> Run now
                    </button>
                )}
                {canRunNow && status !== 'ready' && (
                    <span id="cm-run-now-help" className="sr-only">
                        {status === 'failed' ? 'Run now needs the test to pass.' : 'Run now is ready when the test finishes.'}
                    </span>
                )}
            </>
        )
    }

    return (
        <SlideOver open={open} onOpenChange={close} title={addState === 'none' ? 'Browse models' : 'Add a model'}
            description={addState === 'none'
                ? 'Models HYRAK recommends for drones, and every vision model on Hugging Face.'
                : 'Pick one HYRAK recommends, browse every vision model on Hugging Face, or bring your own. HYRAK checks it and runs it on the live video.'}
            head={addState === 'add' ? stepper : undefined} foot={foot}>
            {stage === 'choose' && (
                <div className={s.tabs} role="tablist" aria-label="Where the model comes from" onKeyDown={onTabKey}>
                    {SOURCES.map(x => {
                        const Icon = x.icon
                        return (
                            <button key={x.key} id={`cm-src-${x.key}`} type="button" role="tab"
                                aria-selected={source === x.key} aria-controls="cm-src-panel"
                                tabIndex={source === x.key ? 0 : -1} onClick={() => pickSource(x.key)}>
                                <Icon size={13} aria-hidden />
                                <span className={s.tabLong}>{x.label}</span>
                                <span className={s.tabShort} aria-hidden>{x.short}</span>
                            </button>
                        )
                    })}
                </div>
            )}
            {stage === 'choose' && (
                <div id="cm-src-panel" role="tabpanel" aria-labelledby={`cm-src-${source}`}
                    style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                    {lockAsk || (source === 'upload' && addState === 'locked') ? (
                        <LockedContent reason={reason} workspaceId={workspaceId} workspaceName={workspaceName}
                            onBack={lockAsk ? () => setLockAsk(false) : undefined} />
                    ) : source === 'upload' && addState === 'none' ? (
                        <div className={cn(s.inset, s.empty)}>
                            <h3>Uploading needs a workspace admin</h3>
                            <p className={s.muted}>Your role can browse and run models. Ask an owner or admin of the workspace to upload one.</p>
                            <button type="button" className={s.btn} onClick={() => pickSource('recommended')}>
                                <Sparkles size={13} aria-hidden /> Browse recommended models
                            </button>
                        </div>
                    ) : source === 'upload' ? (
                <ChooseStep {...{
                    file, fileErr, link, linkErr, inspect, hfFile, chooseErr, submitErr, upload,
                    fileInput, linkInput,
                    onPick: pickFile,
                    onClearFile: () => { setFile(null); setFileErr(null) },
                    onLink: (v: string) => { setLink(v); setLinkErr(null); setChooseErr(null); setSubmitErr(null); if (v) { setFile(null); setFileErr(null) } },
                    onLinkBlur, onLinkFocus: () => setLinkErr(null), onHfFile: setHfFile,
                }} />
                    ) : (
                        <>
                            {addState === 'locked' && (
                                <Callout tone="info" title="Browse freely. Adding models is a premium feature."
                                    actions={<button type="button" className={s.btn} onClick={() => setLockAsk(true)}>
                                        <Lock size={13} aria-hidden /> See how to get it
                                    </button>}>
                                    <span>Ask HYRAK to turn on Custom models for this workspace. The HYRAK models keep working.</span>
                                </Callout>
                            )}
                            {browseErr && (
                                <Callout tone={browseErr.status === 429 ? 'warn' : 'bad'} title={browseErr.message}>
                                    <Hint text={browseErr.hint} />
                                </Callout>
                            )}
                            {source === 'recommended' ? (
                                <RecommendedTab workspaceId={workspaceId} addState={addState} adding={adding}
                                    onAdd={addFromHub} onLocked={() => setLockAsk(true)}
                                    canRun={canRun && !!onRun} onRun={id => runModel(id)} onOpenModel={openModel}
                                    onSearch={() => pickSource('all')} />
                            ) : (
                                <AllModelsTab workspaceId={workspaceId} addState={addState} adding={adding}
                                    onAdd={addFromHub} onLocked={() => setLockAsk(true)} inputRef={searchInput}
                                    canRun={canRun && !!onRun} onRun={id => runModel(id)} onOpenModel={openModel} />
                            )}
                        </>
                    )}
                </div>
            )}

            {stage === 'confirm' && (earlyFailure && failure ? (
                <Callout tone="bad" title={failure.message}
                    actions={model?.source === 'huggingface' ? (
                        <button type="button" className={s.btn} onClick={() => startOver('link')}>Edit the link</button>
                    ) : (
                        <button type="button" className={s.btn} onClick={() => startOver('file')}>Pick another file</button>
                    )}>
                    <Hint text={failure.hint} />
                </Callout>
            ) : !filled ? (
                <ReadingModel step={step} source={model?.source} />
            ) : (
                <>
                    <div className={s.section}>
                        <span className={s.label}>What it does</span>
                        <div className={s.choices} role="radiogroup" aria-label="What the model does">
                            {(['detect', 'classify'] as ModelTask[]).map(t => (
                                <label key={t} className={s.choice}>
                                    <input type="radio" name="cm-task" checked={task === t} onChange={() => setTask(t)} />
                                    <span>
                                        <strong style={{ display: 'block' }}>{TASK_WORDS[t].title}</strong>
                                        <span className={s.help}>{TASK_WORDS[t].line}</span>
                                    </span>
                                    {detectedTask === t && <span className={cn(s.chip, s.chipOk)}>Detected</span>}
                                </label>
                            ))}
                        </div>
                        {detectedTask && task !== detectedTask && (
                            <p className={s.help}>HYRAK read this model as &quot;{TASK_WORDS[detectedTask].title.toLowerCase()}&quot;. Changing it runs the test again.</p>
                        )}
                    </div>

                    <div className={s.section}>
                        <span className={s.label}>{task === 'classify' ? 'Answers it can give' : 'Things it finds'} ({labels.length})</span>
                        <p className={s.help}>Click a name to change how it shows on the video.</p>
                        <ClassChips labels={labels} onChange={next => {
                            // A renamed class keeps its on/off state in More options.
                            setRunSettings(v => v.classes_shown ? {
                                ...v, classes_shown: v.classes_shown.map(n => { const i = labels.indexOf(n); return i >= 0 ? next[i] : n }),
                            } : v)
                            setLabels(next)
                        }} />
                    </div>

                    <div className={s.field}>
                        <label htmlFor="cm-add-name" className={s.label}>Name</label>
                        <input id="cm-add-name" className={s.input} value={name} maxLength={80}
                            aria-invalid={nameErr ? true : undefined}
                            aria-describedby={nameErr ? 'cm-add-name-err' : 'cm-add-name-help'}
                            onChange={e => { setName(e.target.value); if (nameErr) setNameErr(null) }}
                            onFocus={() => setNameErr(null)}
                            onBlur={() => setNameErr(validateName(name))} />
                        {nameErr
                            ? <p id="cm-add-name-err" className={s.fieldErr} role="alert">{nameErr}</p>
                            : <p id="cm-add-name-help" className={s.help}>Shown on the model card and on the video.</p>}
                    </div>

                    <details className={s.details}>
                        <summary className={s.label}><ChevronRight size={12} className={s.disclosureIcon} aria-hidden />More options</summary>
                        <p className={s.help} style={{ margin: '6px 0 12px' }}>Optional. The defaults suit most models, and you can change these later on the model.</p>
                        <SettingsFields value={runSettings} task={task} labels={labels} idPrefix="cm-add-set"
                            latencyMs={null}
                            onChange={p => setRunSettings(v => ({ ...v, ...p }))} />
                    </details>

                    {stepErr && (
                        <Callout tone="bad" title={stepErr.message}
                            actions={<button type="button" className={s.btn} onClick={toTest}>Try again</button>}>
                            <Hint text={stepErr.hint} />
                        </Callout>
                    )}
                </>
            ))}

            {stage === 'test' && model && (
                <TestStep model={live ?? model} status={status} step={step} failure={failure}
                    busy={busy} stepErr={stepErr} saveNote={saveNote}
                    onRetest={retest}
                    onStartOver={() => startOver(model.source === 'huggingface' ? 'link' : 'file')} />
            )}
        </SlideOver>
    )
}

// ── step 1 ─────────────────────────────────────────────────────────────

function ChooseStep({ file, fileErr, link, linkErr, inspect, hfFile, chooseErr, submitErr, upload, fileInput, linkInput, onPick, onClearFile, onLink, onLinkBlur, onLinkFocus, onHfFile }: {
    file: File | null; fileErr: ApiProblem | null
    link: string; linkErr: string | null; inspect: Inspect; hfFile: string | null
    chooseErr: string | null; submitErr: ApiProblem | null; upload: { pct: number } | null
    fileInput: React.RefObject<HTMLInputElement | null>; linkInput: React.RefObject<HTMLInputElement | null>
    onPick: (f: File | null | undefined) => void; onClearFile: () => void
    onLink: (v: string) => void; onLinkBlur: () => void; onLinkFocus: () => void; onHfFile: (f: string) => void
}) {
    const [over, setOver] = useState(false)
    const locked = !!upload
    return (
        <>
            <div className={s.section}>
                <span className={s.label} id="cm-file-label">Model file</span>
                {file ? (
                    <div className={cn(s.inset, s.picked)}>
                        <FileBox size={22} aria-hidden style={{ color: 'var(--cm-accent)' }} />
                        <span style={{ minWidth: 0 }}>
                            <strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</strong>
                            <span className={s.help}>{formatBytes(file.size)}</span>
                        </span>
                        {!locked && (
                            <button type="button" className={s.iconBtn} onClick={onClearFile} aria-label="Remove this file" title="Remove this file">
                                <X size={15} />
                            </button>
                        )}
                    </div>
                ) : (
                    <div role="button" tabIndex={0} className={s.drop} data-over={over}
                        aria-labelledby="cm-file-label" aria-describedby="cm-file-help"
                        onClick={() => fileInput.current?.click()}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.current?.click() } }}
                        onDragOver={e => { e.preventDefault(); setOver(true) }}
                        onDragLeave={() => setOver(false)}
                        onDrop={e => { e.preventDefault(); setOver(false); onPick(e.dataTransfer.files?.[0]) }}>
                        <Upload size={22} aria-hidden />
                        <strong>Drop an .onnx file here</strong>
                        <span id="cm-file-help" className={s.help}>or click to choose one. Up to 500 MB.</span>
                    </div>
                )}
                <input ref={fileInput} type="file" accept=".onnx" hidden
                    onChange={e => { onPick(e.target.files?.[0]); e.target.value = '' }} />
                {fileErr && (
                    <Callout tone="bad" title={fileErr.message}
                        actions={<button type="button" className={s.btn} onClick={() => fileInput.current?.click()}>Pick another file</button>}>
                        <Hint text={fileErr.hint} />
                    </Callout>
                )}
            </div>

            <div className={s.or}>or</div>

            <div className={s.field}>
                <label htmlFor="cm-hf-link" className={s.label}>Hugging Face link</label>
                <input id="cm-hf-link" ref={linkInput} className={s.input} value={link} disabled={locked}
                    placeholder="huggingface.co/owner/model-name" inputMode="url" autoComplete="off" spellCheck={false}
                    aria-invalid={linkErr ? true : undefined}
                    aria-describedby={linkErr ? 'cm-hf-err' : 'cm-hf-help'}
                    onChange={e => onLink(e.target.value)} onBlur={onLinkBlur} onFocus={onLinkFocus} />
                {linkErr
                    ? <p id="cm-hf-err" className={s.fieldErr} role="alert">{linkErr}</p>
                    : <p id="cm-hf-help" className={s.help}>A public model repo that contains an .onnx file. HYRAK pins the exact version.</p>}
                <HfSummary inspect={inspect} hfFile={hfFile} onHfFile={onHfFile}
                    onEdit={() => linkInput.current?.focus()} />
            </div>

            {chooseErr && <p className={s.fieldErr} role="alert">{chooseErr}</p>}
            {submitErr && (
                <Callout tone={submitErr.status === 0 && submitErr.message.startsWith('Upload cancelled') ? 'info' : 'bad'}
                    title={submitErr.message}
                    actions={file
                        ? <button type="button" className={s.btn} onClick={() => fileInput.current?.click()}>Pick another file</button>
                        : link ? <button type="button" className={s.btn} onClick={() => linkInput.current?.focus()}>Edit the link</button> : null}>
                    <Hint text={submitErr.hint} />
                </Callout>
            )}
        </>
    )
}

function HfSummary({ inspect, hfFile, onHfFile, onEdit }: {
    inspect: Inspect; hfFile: string | null; onHfFile: (f: string) => void; onEdit: () => void
}) {
    if (inspect.state === 'idle') return null
    if (inspect.state === 'loading') {
        return (
            <div className={cn(s.inset, s.picked)} role="status">
                <Loader size={18} className="animate-spin motion-reduce:animate-none" aria-hidden style={{ color: 'var(--cm-accent)' }} />
                <span><strong style={{ display: 'block' }}>{inspect.repo}</strong><span className={s.help}>Looking inside the repo...</span></span>
                <span />
            </div>
        )
    }
    if (inspect.state === 'error') {
        return (
            <Callout tone="bad" title={inspect.error.message}
                actions={<button type="button" className={s.btn} onClick={onEdit}>Edit the link</button>}>
                <Hint text={inspect.error.hint ?? (inspect.error.status === 404 ? 'Check the spelling, and that the repo is public.' : null)} />
            </Callout>
        )
    }
    const d = inspect.data
    if (d.onnx_files.length === 0) {
        return (
            <Callout tone="bad" title={`${d.repo} has no .onnx file.`}
                actions={<button type="button" className={s.btn} onClick={onEdit}>Edit the link</button>}>
                <span>Look for a version of this model exported to ONNX (often a repo ending in -onnx), or export it and upload the file.</span>
            </Callout>
        )
    }
    return (
        <div className={s.inset} style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <CheckCircle2 size={18} aria-hidden style={{ color: 'var(--cm-ok)', flexShrink: 0 }} />
                <span style={{ minWidth: 0 }}>
                    <strong style={{ display: 'block', overflowWrap: 'anywhere' }}>{d.repo}</strong>
                    <span className={s.help}>
                        {d.labels?.length ? `${d.labels.length} classes found. ` : ''}
                        {d.sha ? <>Version <span className={s.mono}>{d.sha.slice(0, 7)}</span></> : null}
                    </span>
                </span>
            </div>
            {d.onnx_files.length > 1 && (
                <fieldset style={{ border: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <legend className={s.label} style={{ marginBottom: 6 }}>This repo has {d.onnx_files.length} ONNX files. Pick one</legend>
                    {d.onnx_files.map(f => (
                        <label key={f.path} className={s.choice} style={{ gridTemplateColumns: '18px 1fr auto' }}>
                            <input type="radio" name="cm-hf-file" checked={hfFile === f.path} onChange={() => onHfFile(f.path)} />
                            <span className={s.mono} style={{ overflowWrap: 'anywhere', fontSize: 'var(--cm-small)' }}>{f.path}</span>
                            <span className={s.help}>{f.size_bytes ? formatBytes(f.size_bytes) : ''}</span>
                        </label>
                    ))}
                </fieldset>
            )}
        </div>
    )
}

// ── step 2 waiting / step 3 ────────────────────────────────────────────

function ReadingModel({ step, source }: { step: string | null; source?: string }) {
    const k = checkStepOf(step)
    return (
        <div className={s.section} role="status" aria-live="polite">
            <p className={s.muted}>
                {k === 'receive' && source === 'huggingface' ? 'Downloading the model from Hugging Face...' : 'Reading the model to see what it does...'}
            </p>
            <div className={s.skel} style={{ height: 54 }} />
            <div className={s.skel} style={{ height: 54 }} />
            <div className={s.chips}>
                {[60, 44, 72, 52, 38].map((w, i) => <span key={i} className={s.skel} style={{ width: w, height: 26, borderRadius: 999 }} />)}
            </div>
            <div className={s.skel} style={{ height: 36 }} />
        </div>
    )
}

function TestStep({ model, status, step, failure, busy, stepErr, saveNote, onRetest, onStartOver }: {
    model: CustomModel; status: string; step: string | null; failure: ApiProblem | null
    busy: boolean; stepErr: ApiProblem | null; saveNote: string | null
    onRetest: () => void; onStartOver: () => void
}) {
    const v = currentVersionOf(model)
    const ready = status === 'ready'
    const preview = useApiObjectUrl(ready ? previewPath(model.id, v?.id ?? model.updated_at) : null)
    const now = ready ? 'done' : checkStepOf(step) ?? 'test'
    const nowIdx = now === 'done' ? CHECK_STEPS.length : CHECK_STEPS.findIndex(x => x.key === now)
    const speed = speedSentence(v?.latency_ms)
    const labels = labelsOf(model)
    return (
        <>
            <div className={s.section}>
                <span className={s.label}>Automatic check</span>
                <ol className={s.checklist} aria-live="polite">
                    {CHECK_STEPS.map((x, i) => {
                        const state = i < nowIdx ? 'done' : i === nowIdx ? (failure ? 'failed' : 'now') : 'next'
                        return (
                            <li key={x.key} data-state={state}>
                                {state === 'done' ? <CheckCircle2 size={18} aria-hidden style={{ color: 'var(--cm-ok)' }} />
                                    : state === 'now' ? <Loader size={18} className="animate-spin motion-reduce:animate-none" aria-hidden style={{ color: 'var(--cm-accent)' }} />
                                        : state === 'failed' ? <X size={18} aria-hidden />
                                            : <Circle size={18} aria-hidden style={{ opacity: 0.4 }} />}
                                <span>{x.label}</span>
                                <span className={s.help}>{state === 'done' ? 'Done' : state === 'now' ? 'Working' : state === 'failed' ? 'Stopped' : ''}</span>
                            </li>
                        )
                    })}
                </ol>
                {!ready && !failure && model.progress != null && (
                    <div className={s.bar}><i style={{ width: `${Math.round(model.progress * 100)}%` }} /></div>
                )}
            </div>

            {failure && (
                <Callout tone="bad" title={failure.message}
                    actions={<>
                        <button type="button" className={s.btn} onClick={onRetest} aria-busy={busy || undefined}>Test again</button>
                        <button type="button" className={s.btn} onClick={onStartOver}>
                            {model.source === 'huggingface' ? 'Edit the link' : 'Pick another file'}
                        </button>
                    </>}>
                    <Hint text={failure.hint} />
                </Callout>
            )}

            {ready && (
                <div className={s.section}>
                    <span className={s.label}>Test result</span>
                    {preview
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={preview} alt={`${model.name} on a sample image, with what it found boxed`} className={s.preview} />
                        : <div className={cn(s.skel, s.preview)} aria-hidden />}
                    {speed && <p className={s.speed}>Runs at {speed}.</p>}
                    <p className={s.muted}>
                        {model.task === 'classify' ? 'Names' : 'Finds'} {labels.length} {labels.length === 1 ? 'class' : 'classes'}
                        {labels.length ? `: ${labels.slice(0, 5).join(', ')}${labels.length > 5 ? ', ...' : ''}` : ''}.
                    </p>
                </div>
            )}

            {stepErr && <Callout tone="bad" title={stepErr.message}><Hint text={stepErr.hint} /></Callout>}
            {saveNote && <Callout tone="info">{saveNote}</Callout>}
        </>
    )
}
