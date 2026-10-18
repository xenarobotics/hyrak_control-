'use client'

// Browse models: the first two ways into the Add panel's "Choose" step.
//
//   Recommended          HYRAK's hand-picked models, grouped by use case,
//                        each one click to add (then the usual check).
//   Search Hugging Face  one search box and a task filter over the Hub's
//                        vision models. Runnable cards get Add; the rest
//                        stay visible, greyed, with the plain reason and a
//                        link to the repo, so people see the library grow.
//
// Browsing is open to everyone who can see the library; Add still needs
// models.manage and the premium feature (the parent decides via `addState`).

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Download, ExternalLink, Heart, Loader, Lock, Plus, Search } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
    ago, compactCount, getRecommended, isRateLimited, searchHuggingFace, TASK_WORDS,
    type ApiProblem, type HfSearchCard, type RecommendedModel, type SearchTask,
} from '@/lib/models'
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
}

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

function AddButton({ name, added, addState, busy, onAdd, onLocked }: {
    name: string; added: string | null; addState: AddState; busy: boolean
    onAdd: () => void; onLocked: () => void
}) {
    if (added) return <span className={cn(s.chip, s.chipOk)}><span className={s.dot} aria-hidden />Added</span>
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

function LoadFailed({ error, onRetry, what }: { error: ApiProblem; onRetry: () => void; what: string }) {
    if (isRateLimited(error)) {
        return (
            <Callout tone="warn" title={error.message}
                actions={<button type="button" className={s.btn} onClick={onRetry}>Try again</button>}>
                <span>{error.hint ?? 'Wait a minute and try again.'}{what === 'Recommended models' ? '' : ' Recommended models still work.'}</span>
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

export function RecommendedTab({ workspaceId, addState, adding, onAdd, onLocked, onSearch }: Common & {
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
                <p className={s.muted}>HYRAK is still testing its picks. Search Hugging Face for a vision model in the meantime.</p>
                <button type="button" className={cn(s.btn, s.primary)} onClick={onSearch}><Search size={13} aria-hidden /> Search Hugging Face</button>
            </div>
        )
    }
    return (
        <div className={s.section}>
            <p className={s.muted}>Picked and tested by HYRAK. Add one and it runs on your drone video in about a minute.</p>
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
                                    <AddButton name={m.name} added={m.added} addState={addState}
                                        busy={adding === m.repo} onLocked={onLocked}
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

// ── Search ─────────────────────────────────────────────────────────────

const TASK_FILTERS: { value: SearchTask; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'detect', label: 'Find objects' },
    { value: 'classify', label: 'Classify pictures' },
]

type SearchState =
    | { s: 'loading' }
    | { s: 'error'; error: ApiProblem }
    | { s: 'ok'; results: HfSearchCard[]; page: number; hasMore: boolean; more: 'idle' | 'loading' | ApiProblem }

export function SearchTab({ workspaceId, addState, adding, onAdd, onLocked, inputRef }: Common & {
    inputRef: React.RefObject<HTMLInputElement | null>
}) {
    const [query, setQuery] = useState('')
    const [task, setTask] = useState<SearchTask>('all')
    const [debounced, setDebounced] = useState('')
    const [attempt, setAttempt] = useState(0)
    const key = `${debounced}|${task}|${workspaceId}|${attempt}`
    const [answer, setAnswer] = useState<({ key: string } & SearchState) | null>(null)

    useEffect(() => {
        const t = setTimeout(() => setDebounced(query.trim()), 400)
        return () => clearTimeout(t)
    }, [query])

    useEffect(() => {
        const ctl = new AbortController()
        searchHuggingFace({ q: debounced, task, workspaceId, signal: ctl.signal }).then(r => {
            if (ctl.signal.aborted) return
            setAnswer(r.ok
                ? { key, s: 'ok', results: r.data.results, page: r.data.page, hasMore: r.data.has_more, more: 'idle' }
                : { key, s: 'error', error: r.error })
        }).catch(() => { /* aborted */ })
        return () => ctl.abort()
    }, [key, debounced, task, workspaceId])
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
        const r = await searchHuggingFace({ q: debounced, task, page: state.page + 1, workspaceId })
        setAnswer(prev => {
            if (!prev || prev.s !== 'ok' || prev.key !== key) return prev
            if (!r.ok) return { ...prev, more: r.error }
            const seen = new Set(prev.results.map(c => c.repo))
            return {
                key, s: 'ok', results: [...prev.results, ...r.data.results.filter(c => !seen.has(c.repo))],
                page: r.data.page, hasMore: r.data.has_more, more: 'idle',
            }
        })
    }

    const clear = () => { setQuery(''); setTask('all'); inputRef.current?.focus() }
    const runnable = state.s === 'ok' ? state.results.filter(c => c.runnable).length : 0

    return (
        <div className={s.section}>
            <div className={s.field}>
                <label htmlFor="cm-hf-search" className={s.label}>Search Hugging Face</label>
                <div className={s.search} style={{ flex: 'none' }}>
                    <Search size={13} aria-hidden />
                    <input id="cm-hf-search" ref={inputRef} type="search" value={query}
                        placeholder="fire, vehicle, crack, solar panel" autoComplete="off" spellCheck={false}
                        aria-keyshortcuts="/" aria-describedby="cm-hf-search-help"
                        onChange={e => setQuery(e.target.value)} />
                    {showSkeleton && <Loader size={13} className="animate-spin motion-reduce:animate-none" aria-hidden />}
                </div>
                <p id="cm-hf-search-help" className={s.help}>Public vision models on Hugging Face. Press / to jump here.</p>
            </div>
            <div className={s.segment} role="group" aria-label="What the model does" style={{ alignSelf: 'flex-start' }}>
                {TASK_FILTERS.map(f => (
                    <button key={f.value} type="button" aria-pressed={task === f.value} onClick={() => setTask(f.value)}>{f.label}</button>
                ))}
            </div>

            {showSkeleton && <BrowseSkeleton rows={5} />}
            {state.s === 'error' && <LoadFailed error={state.error} onRetry={() => setAttempt(a => a + 1)} what="Search results" />}
            {state.s === 'ok' && state.results.length === 0 && (
                <div className={cn(s.inset, s.empty)}>
                    <h3>No vision models match{debounced ? ` "${debounced}"` : ''}</h3>
                    <p className={s.muted}>Try a broader word like &quot;fire&quot; or &quot;vehicle&quot;, or show every kind of model.</p>
                    <button type="button" className={s.btn} onClick={clear}>Clear search</button>
                </div>
            )}
            {state.s === 'ok' && state.results.length > 0 && (
                <>
                    <p className={s.help} role="status">
                        {runnable === 0
                            ? 'None of these can run on HYRAK yet. They are shown so you know what is coming.'
                            : `${runnable} ready to add${state.results.length > runnable ? '. The greyed ones need a later HYRAK update.' : '.'}`}
                    </p>
                    <div className={s.browseList}>
                        {state.results.map(c => (
                            <SearchCard key={c.repo} card={c} addState={addState} busy={adding === c.repo}
                                onLocked={onLocked}
                                onAdd={() => onAdd({ repo: c.repo, file: c.suggested_file })} />
                        ))}
                    </div>
                    {state.more !== 'idle' && state.more !== 'loading' && (
                        <LoadFailed error={state.more} onRetry={loadMore} what="More results" />
                    )}
                    {state.hasMore && (
                        <button type="button" className={s.btn} style={{ alignSelf: 'center' }} onClick={loadMore}
                            aria-busy={state.more === 'loading' || undefined}>
                            {state.more === 'loading' && <Loader size={13} className="animate-spin motion-reduce:animate-none" aria-hidden />}
                            Show more results
                        </button>
                    )}
                </>
            )}
        </div>
    )
}

function SearchCard({ card: c, addState, busy, onAdd, onLocked }: {
    card: HfSearchCard; addState: AddState; busy: boolean; onAdd: () => void; onLocked: () => void
}) {
    const updated = ago(c.updated)
    const taskWord = c.task === 'detect' || c.task === 'classify' ? TASK_WORDS[c.task].title
        : c.task === 'segment' ? 'Outlines objects' : null
    return (
        <div className={s.browseCard} data-runnable={c.runnable}>
            <div className={s.browseMain}>
                <span className={cn(s.cardName, s.browseRepo)}>{c.repo}</span>
                <span className={s.browseMeta}>
                    {taskWord && <span>{taskWord}</span>}
                    <span title={`${c.downloads.toLocaleString()} downloads`}><Download size={11} aria-hidden /> {compactCount(c.downloads)}</span>
                    <span title={`${c.likes.toLocaleString()} likes`}><Heart size={11} aria-hidden /> {compactCount(c.likes)}</span>
                    {updated && <span>Updated {updated}</span>}
                    <LicenceBadge license={c.license} note={c.license_note} />
                </span>
                {!c.runnable && c.reason && <span className={s.browseReason}>{c.reason}</span>}
            </div>
            <div className={s.cardActions}>
                <a href={c.url} target="_blank" rel="noopener noreferrer" className={cn(s.btn, s.ghost)}
                    aria-label={`View ${c.repo} on Hugging Face (opens in a new tab)`} title="View on Hugging Face">
                    <ExternalLink size={13} aria-hidden />{!c.runnable && <span>View</span>}
                </a>
                {c.runnable && (
                    <AddButton name={c.repo} added={c.added} addState={addState} busy={busy}
                        onAdd={onAdd} onLocked={onLocked} />
                )}
            </div>
        </div>
    )
}
