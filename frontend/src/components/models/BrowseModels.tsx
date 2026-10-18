'use client'

// Browse models: the first two ways into the Add panel's "Choose" step.
//
//   Recommended for drones  HYRAK's hand-picked models, grouped by use case,
//                           each one click to add (then the usual check).
//   All vision models       opens straight on the Hub's most downloaded
//                           vision models (find objects, classify, outline),
//                           with a search box, a task filter and a "Ready to
//                           run only" toggle on top. Runnable cards get Add
//                           and sort first on each page; the rest stay
//                           visible, greyed, with the plain reason and a
//                           link to the repo, so people see the library grow.
//
// A card for a model the workspace already has shows Run once it is ready
// (the library's run path), or its status, which opens the model.
//
// Browsing is open to everyone who can see the library; Add still needs
// models.manage and the premium feature (the parent decides via `addState`).

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Download, ExternalLink, Heart, Layers, Loader, Lock, Play, Plus, Search } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
    ago, compactCount, getRecommended, isRateLimited, searchHuggingFace, stepWords, TASK_WORDS,
    type ApiProblem, type HfSearchCard, type ModelStatus, type RecommendedModel, type SearchTask,
} from '@/lib/models'
import { useModelsStore } from '@/store/models'
import { Callout, Hint, css as s } from './ui'

/** What an Add button does here: add, explain the lock, or nothing (viewers). */
export type AddState = 'add' | 'locked' | 'none'

export interface AddTarget { repo: string; file: string | null; name?: string }

interface Common {
    workspaceId: string | null
    addState: AddState
    /** The repo being imported right now, if any. */
    adding: string | null
    onAdd: (t: AddTarget) => void
    onLocked: () => void
    /** The role may run models (Run on an added, ready card). */
    canRun: boolean
    /** Close the panel and run this model of ours, as the library's Run does. */
    onRun: (modelId: string) => void
    /** Open this model of ours (its status, how to fix it). */
    onOpenModel: (modelId: string) => void
}

type CardActions = Pick<Common, 'addState' | 'canRun' | 'onRun' | 'onOpenModel' | 'onLocked'>

// ── shared bits ────────────────────────────────────────────────────────

function LicenceBadge({ license, note }: { license: string | null; note: string | null }) {
    if (!license && !note) return null
    const label = license ? license.toUpperCase() : 'Licence'
    if (!note) return <span className={cn(s.chip, s.chipMute)} title={`Licence: ${license}`}>{label}</span>
    return (
        <Tooltip>
            <TooltipTrigger className={cn(s.chip, s.chipWarn, s.badgeBtn)} aria-label={`Licence ${license}: ${note}`}>
                <AlertTriangle size={11} aria-hidden />{label}
            </TooltipTrigger>
            <TooltipContent style={{ maxWidth: 260, lineHeight: 1.45 }}>{note}</TooltipContent>
        </Tooltip>
    )
}

/** A card for a model the workspace already has: Run when it is ready,
 *  otherwise its status, which opens the model. The live status comes from
 *  the library store (socket pushes); the list's own is the fallback. */
function AddedAction({ name, id, listed, canRun, onRun, onOpenModel }: {
    name: string; id: string; listed: ModelStatus | null | undefined
    canRun: boolean; onRun: (id: string) => void; onOpenModel: (id: string) => void
}) {
    const live = useModelsStore(st => st.workspace.find(m => m.id === id))
    const status: ModelStatus = live?.status ?? listed ?? 'checking'
    if (status === 'ready' && canRun) {
        return (
            <button type="button" className={cn(s.btn, s.primary)} onClick={() => onRun(id)}
                aria-label={`Run ${name}`} title="Close this panel and run it on the live video">
                <Play size={12} aria-hidden /> Run
            </button>
        )
    }
    const label = status === 'ready' ? 'Added' : status === 'failed' ? 'Needs attention' : stepWords(live?.step ?? null, 'huggingface')
    return (
        <button type="button" onClick={() => onOpenModel(id)}
            className={cn(s.chip, s.chipBtn, status === 'ready' ? s.chipOk : status === 'failed' ? s.chipBad : s.chipInfo)}
            aria-label={`${name}: ${label}. Open the model`} title="Open the model">
            {status === 'failed' ? <AlertTriangle size={11} aria-hidden />
                : status === 'checking' ? <Loader size={11} className="animate-spin motion-reduce:animate-none" aria-hidden />
                    : <span className={s.dot} aria-hidden />}
            {label}
        </button>
    )
}

function AddButton({ name, added, addedStatus, busy, onAdd, addState, canRun, onRun, onOpenModel, onLocked }: CardActions & {
    name: string; added: string | null; addedStatus?: ModelStatus | null; busy: boolean
    onAdd: () => void
}) {
    if (added) {
        return <AddedAction name={name} id={added} listed={addedStatus} canRun={canRun}
            onRun={onRun} onOpenModel={onOpenModel} />
    }
    if (addState === 'none') return null
    if (addState === 'locked') {
        return (
            <button type="button" className={s.btn} onClick={onLocked}
                aria-label={`Add ${name} (premium feature)`} title="Adding models is a premium feature">
                <Lock size={12} aria-hidden /> Add
            </button>
        )
    }
    return (
        <button type="button" className={cn(s.btn, s.primary)} onClick={onAdd}
            aria-label={`Add ${name}`} aria-busy={busy || undefined}>
            {busy ? <Loader size={12} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Plus size={12} aria-hidden />}
            {busy ? 'Adding' : 'Add'}
        </button>
    )
}

function BrowseSkeleton({ rows = 4 }: { rows?: number }) {
    return (
        <div className={s.browseList} aria-hidden>
            {Array.from({ length: rows }, (_, i) => (
                <div key={i} className={s.browseCard}>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <span className={s.skel} style={{ height: 13, width: '50%' }} />
                        <span className={s.skel} style={{ height: 10, width: '85%' }} />
                        <span style={{ display: 'flex', gap: 6 }}>
                            {[52, 40, 60].map((w, j) => <span key={j} className={s.skel} style={{ height: 20, width: w, borderRadius: 999 }} />)}
                        </span>
                    </span>
                    <span className={s.skel} style={{ width: 58, height: 30 }} />
                </div>
            ))}
        </div>
    )
}

function LoadFailed({ error, onRetry, what, kept }: { error: ApiProblem; onRetry: () => void; what: string; kept?: boolean }) {
    if (isRateLimited(error)) {
        return (
            <Callout tone="warn" title={error.message}
                actions={<button type="button" className={s.btn} onClick={onRetry}>Try again</button>}>
                <span>
                    {error.hint ?? 'Wait a minute and try again.'}
                    {kept ? ' The results below are from your last search.' : what === 'Recommended models' ? '' : ' Recommended models still work.'}
                </span>
            </Callout>
        )
    }
    return (
        <Callout tone="bad" title={`${what} could not be loaded.`}
            actions={<button type="button" className={s.btn} onClick={onRetry}>Try again</button>}>
            <span>{error.message} <Hint text={error.hint} /></span>
        </Callout>
    )
}

// ── Recommended ────────────────────────────────────────────────────────

export function RecommendedTab({ workspaceId, adding, onAdd, onSearch, ...act }: Common & {
    onSearch: () => void
}) {
    // The answer is stored with the request it belongs to; anything else
    // on screen is a load in flight.
    const [attempt, setAttempt] = useState(0)
    const key = `${workspaceId}|${attempt}`
    const [answer, setAnswer] = useState<{ key: string } & (
        { s: 'error'; error: ApiProblem } | { s: 'ok'; cats: { name: string; models: RecommendedModel[] }[] })
        | null>(null)
    useEffect(() => {
        let alive = true
        getRecommended(workspaceId).then(r => {
            if (!alive) return
            setAnswer(r.ok ? { key, s: 'ok', cats: r.data.categories } : { key, s: 'error', error: r.error })
        })
        return () => { alive = false }
    }, [key, workspaceId])
    const load = useCallback(() => setAttempt(a => a + 1), [])
    const state = answer && answer.key === key ? answer : { s: 'loading' as const }

    if (state.s === 'loading') return <BrowseSkeleton />
    if (state.s === 'error') return <LoadFailed error={state.error} onRetry={load} what="Recommended models" />
    if (state.cats.length === 0) {
        return (
            <div className={cn(s.inset, s.empty)}>
                <h3>No recommended models yet</h3>
                <p className={s.muted}>HYRAK is still testing its picks. Browse every vision model on Hugging Face in the meantime.</p>
                <button type="button" className={cn(s.btn, s.primary)} onClick={onSearch}><Layers size={13} aria-hidden /> All vision models</button>
            </div>
        )
    }
    return (
        <div className={s.section}>
            <p className={s.muted}>
                Picked and tested by HYRAK for drone video. Add one and it is ready to run in about a minute.
                Looking for something else? <button type="button" className={s.link} onClick={onSearch}>Browse all vision models</button>
            </p>
            {state.cats.map(cat => (
                <section key={cat.name} className={s.section} aria-label={cat.name}>
                    <h3 className={cn(s.label, s.groupLabel)}>{cat.name}</h3>
                    <div className={s.browseList}>
                        {cat.models.map(m => (
                            <div key={`${m.repo}/${m.file}`} className={s.browseCard}>
                                <div className={s.browseMain}>
                                    <span className={s.cardName}>{m.name}</span>
                                    <span className={s.cardBlurb}>{m.what}</span>
                                    {m.classes_preview.length > 0 && (
                                        <span className={s.chips} aria-label={m.task === 'classify' ? 'Example answers' : 'Example things it finds'}>
                                            {m.classes_preview.slice(0, 4).map(c => <span key={c} className={cn(s.chip, s.chipMute, s.classPreview)}>{c}</span>)}
                                        </span>
                                    )}
                                    <span className={s.browseMeta}>
                                        <span>{TASK_WORDS[m.task].title}</span>
                                        {m.fps ? <span>about {Math.round(m.fps)} fps on HYRAK</span> : null}
                                        <LicenceBadge license={m.license} note={m.license_note} />
                                    </span>
                                </div>
                                <div className={s.cardActions}>
                                    <AddButton {...act} name={m.name} added={m.added} addedStatus={m.added_status}
                                        busy={adding === m.repo}
                                        onAdd={() => onAdd({ repo: m.repo, file: m.file, name: m.name })} />
                                </div>
                            </div>
                        ))}
                    </div>
                </section>
            ))}
        </div>
    )
}

// ── All vision models ──────────────────────────────────────────────────

const TASK_FILTERS: { value: SearchTask; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'detect', label: 'Find objects' },
    { value: 'classify', label: 'Classify pictures' },
    { value: 'segment', label: 'Outline objects' },
]

type Page = { results: HfSearchCard[]; page: number; hasMore: boolean; stale: boolean; more: 'idle' | 'loading' | ApiProblem }
type SearchState = { s: 'loading' } | { s: 'error'; error: ApiProblem } | ({ s: 'ok' } & Page)

export function AllModelsTab({ workspaceId, adding, onAdd, inputRef, ...act }: Common & {
    inputRef: React.RefObject<HTMLInputElement | null>
}) {
    const [query, setQuery] = useState('')
    const [task, setTask] = useState<SearchTask>('all')
    const [readyOnly, setReadyOnly] = useState(false)
    const [debounced, setDebounced] = useState('')
    const [attempt, setAttempt] = useState(0)
    const key = `${debounced}|${task}|${readyOnly}|${workspaceId}|${attempt}`
    const [answer, setAnswer] = useState<({ key: string } & SearchState) | null>(null)
    // The last list that loaded, kept on screen when Hugging Face asks us to wait.
    const [kept, setKept] = useState<Page | null>(null)

    useEffect(() => {
        const t = setTimeout(() => setDebounced(query.trim()), 400)
        return () => clearTimeout(t)
    }, [query])

    // No typing needed: an empty query lists the most downloaded models.
    useEffect(() => {
        const ctl = new AbortController()
        searchHuggingFace({ q: debounced, task, ready: readyOnly, workspaceId, signal: ctl.signal }).then(r => {
            if (ctl.signal.aborted) return
            if (!r.ok) { setAnswer({ key, s: 'error', error: r.error }); return }
            const page: Page = { results: r.data.results, page: r.data.page, hasMore: r.data.has_more, stale: r.data.stale, more: 'idle' }
            setAnswer({ key, s: 'ok', ...page })
            setKept(page)
        }).catch(() => { /* aborted */ })
        return () => ctl.abort()
    }, [key, debounced, task, readyOnly, workspaceId])
    const state: SearchState = answer && answer.key === key ? answer : { s: 'loading' }
    // No skeleton for answers faster than 150 ms (cached searches): it would only flash.
    const [skelKey, setSkelKey] = useState<string | null>(null)
    useEffect(() => {
        const t = setTimeout(() => setSkelKey(key), 150)
        return () => clearTimeout(t)
    }, [key])
    const showSkeleton = state.s === 'loading' && skelKey === key

    const loadMore = async () => {
        if (state.s !== 'ok') return
        setAnswer({ key, ...state, more: 'loading' })
        const r = await searchHuggingFace({ q: debounced, task, ready: readyOnly, page: state.page + 1, workspaceId })
        setAnswer(prev => {
            if (!prev || prev.s !== 'ok' || prev.key !== key) return prev
            if (!r.ok) return { ...prev, more: r.error }
            // Each page keeps its runnable cards first; pages append in order.
            const seen = new Set(prev.results.map(c => c.repo))
            const next: Page = {
                results: [...prev.results, ...r.data.results.filter(c => !seen.has(c.repo))],
                page: r.data.page, hasMore: r.data.has_more, stale: prev.stale || r.data.stale, more: 'idle',
            }
            setKept(next)
            return { key, s: 'ok', ...next }
        })
    }

    const clear = () => { setQuery(''); setTask('all'); setReadyOnly(false); inputRef.current?.focus() }
    const retry = () => setAttempt(a => a + 1)
    // Rate limited with something loaded before: say so, keep the list.
    const keptOnError = state.s === 'error' && isRateLimited(state.error) && kept && kept.results.length > 0 ? kept : null
    const list: Page | null = state.s === 'ok' ? state : keptOnError
    const runnable = list ? list.results.filter(c => c.runnable).length : 0

    return (
        <div className={s.section}>
            <div className={s.field}>
                <label htmlFor="cm-hf-search" className={s.label}>Search vision models</label>
                <div className={s.search} style={{ flex: 'none' }}>
                    <Search size={13} aria-hidden />
                    <input id="cm-hf-search" ref={inputRef} type="search" value={query}
                        placeholder="fire, vehicle, crack, solar panel" autoComplete="off" spellCheck={false}
                        aria-keyshortcuts="/" aria-describedby="cm-hf-search-help"
                        onChange={e => setQuery(e.target.value)} />
                    {showSkeleton && <Loader size={13} className="animate-spin motion-reduce:animate-none" aria-hidden />}
                </div>
                <p id="cm-hf-search-help" className={s.help}>Public vision models on Hugging Face, most downloaded first. Press / to jump here.</p>
            </div>
            <div className={s.browseFilters}>
                <div className={s.segment} role="group" aria-label="What the model does">
                    {TASK_FILTERS.map(f => (
                        <button key={f.value} type="button" aria-pressed={task === f.value} onClick={() => setTask(f.value)}>{f.label}</button>
                    ))}
                </div>
                <label className={s.toggle}>
                    <input type="checkbox" role="switch" checked={readyOnly} onChange={e => setReadyOnly(e.target.checked)} />
                    Ready to run only
                </label>
            </div>

            {showSkeleton && !list && <BrowseSkeleton rows={5} />}
            {state.s === 'error' && <LoadFailed error={state.error} onRetry={retry} what="Search results" kept={!!keptOnError} />}
            {state.s === 'ok' && state.stale && (
                <Callout tone="warn" title="Hugging Face is busy right now.">
                    <span>These results are from a few minutes ago. They refresh by themselves once it answers again.</span>
                </Callout>
            )}
            {state.s === 'ok' && state.results.length === 0 && (
                <div className={cn(s.inset, s.empty)}>
                    <h3>No {readyOnly ? 'ready-to-run ' : ''}vision models match{debounced ? ` "${debounced}"` : ''}</h3>
                    <p className={s.muted}>
                        {readyOnly ? 'Turn off "Ready to run only" to see every model, ' : 'Try a broader word like "fire" or "vehicle", '}
                        or show every kind of model.
                    </p>
                    <button type="button" className={s.btn} onClick={clear}>Clear search</button>
                </div>
            )}
            {list && list.results.length > 0 && (
                <>
                    <p className={s.help} role="status">
                        {list.hasMore
                            ? `Showing ${list.results.length} of many ${readyOnly ? 'ready-to-run ' : ''}vision models on Hugging Face.`
                            : `Showing all ${list.results.length} ${readyOnly ? 'ready-to-run ' : ''}vision models${debounced ? ` matching "${debounced}"` : ''}.`}
                        {' '}
                        {readyOnly ? '' : runnable === 0
                            ? 'None of these run on HYRAK yet; they show what is coming.'
                            : `${runnable} ready to run${list.results.length > runnable ? '; the greyed ones need a later HYRAK update.' : '.'}`}
                    </p>
                    <div className={s.browseList}>
                        {list.results.map(c => (
                            <SearchCard key={c.repo} card={c} busy={adding === c.repo} {...act}
                                onAdd={() => onAdd({ repo: c.repo, file: c.suggested_file })} />
                        ))}
                    </div>
                    {state.s === 'ok' && state.more !== 'idle' && state.more !== 'loading' && (
                        <LoadFailed error={state.more} onRetry={loadMore} what="More results" kept />
                    )}
                    {state.s === 'ok' && state.hasMore && (
                        <button type="button" className={s.btn} style={{ alignSelf: 'center' }} onClick={loadMore}
                            aria-busy={state.more === 'loading' || undefined}>
                            {state.more === 'loading' && <Loader size={13} className="animate-spin motion-reduce:animate-none" aria-hidden />}
                            Show more
                        </button>
                    )}
                </>
            )}
        </div>
    )
}

function SearchCard({ card: c, busy, onAdd, ...act }: CardActions & {
    card: HfSearchCard; busy: boolean; onAdd: () => void
}) {
    const updated = ago(c.updated)
    const taskWord = c.task === 'detect' || c.task === 'classify' ? TASK_WORDS[c.task].title
        : c.task === 'segment' ? 'Outlines objects' : null
    return (
        <div className={s.browseCard} data-runnable={c.runnable || !!c.added}>
            <div className={s.browseMain}>
                <span className={cn(s.cardName, s.browseRepo)}>{c.repo}</span>
                <span className={s.browseMeta}>
                    {taskWord && <span>{taskWord}</span>}
                    <span title={`${c.downloads.toLocaleString()} downloads`}><Download size={11} aria-hidden /> {compactCount(c.downloads)}</span>
                    <span title={`${c.likes.toLocaleString()} likes`}><Heart size={11} aria-hidden /> {compactCount(c.likes)}</span>
                    {updated && <span>Updated {updated}</span>}
                    <LicenceBadge license={c.license} note={c.license_note} />
                </span>
                {!c.runnable && !c.added && c.reason && <span className={s.browseReason}>{c.reason}</span>}
            </div>
            <div className={s.cardActions}>
                <a href={c.url} target="_blank" rel="noopener noreferrer" className={cn(s.btn, s.ghost)}
                    aria-label={`View ${c.repo} on Hugging Face (opens in a new tab)`} title="View on Hugging Face">
                    <ExternalLink size={13} aria-hidden />{!c.runnable && !c.added && <span>View</span>}
                </a>
                {(c.runnable || c.added) && (
                    <AddButton {...act} name={c.repo} added={c.added} addedStatus={c.added_status} busy={busy} onAdd={onAdd} />
                )}
            </div>
        </div>
    )
}
