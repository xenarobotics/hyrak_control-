'use client'

// The AI tab's model library (Pattern 1, List / Index): heading, one line,
// Add model in the header; a filter (All, HYRAK models, Our models) and a
// search in the toolbar; then one framed list of model cards. Each card has
// an icon, a plain name, one line, a status chip and Run. Clicking a model
// of ours (or a catalogue model) opens its detail slide-over.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Eye, Lock, Play, Plus, Search, Square, Upload, Wand2, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LibraryEntry } from './useModelLibrary'
import { css as s, StatusChip, Callout } from './ui'

export type LibraryFilter = 'all' | 'hyrak' | 'ours'

const FILTERS: { value: LibraryFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'hyrak', label: 'HYRAK models' },
    { value: 'ours', label: 'Our models' },
]

export interface LibraryProps {
    entries: LibraryEntry[]
    loading: boolean
    loadError: string | null
    onRetryLoad: () => void
    runningMode: string
    /** The mode that is starting (Run pressed, video not up yet). */
    startingMode: string | null
    canRun: boolean
    canManage: boolean
    premiumEnabled: boolean
    onRun: (e: LibraryEntry) => void
    onStop: () => void
    onAdd: () => void
    onOpen: (e: LibraryEntry) => void
    /** Briefly highlight a card (just added). */
    highlightKey?: string | null
}

export function ModelLibrary(p: LibraryProps) {
    const [filter, setFilter] = useState<LibraryFilter>('all')
    const [query, setQuery] = useState('')
    const searchRef = useRef<HTMLInputElement>(null)

    // "/" focuses search, as on every list in the product.
    useEffect(() => {
        const key = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null
            if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
            if (document.querySelector('[role="dialog"]')) return
            e.preventDefault()
            searchRef.current?.focus()
        }
        window.addEventListener('keydown', key)
        return () => window.removeEventListener('keydown', key)
    }, [])

    const counts = useMemo(() => ({
        all: p.entries.length,
        hyrak: p.entries.filter(e => e.group === 'hyrak').length,
        ours: p.entries.filter(e => e.group === 'ours').length,
    }), [p.entries])

    const q = query.trim().toLowerCase()
    const shown = p.entries.filter(e => (filter === 'all' || e.group === filter)
        && (!q || e.name.toLowerCase().includes(q) || e.blurb.toLowerCase().includes(q)))
    const hyrak = shown.filter(e => e.group === 'hyrak')
    const ours = shown.filter(e => e.group === 'ours')
    const showAdd = p.canManage

    const card = (e: LibraryEntry) => (
        <ModelCard key={e.key} entry={e} running={p.runningMode === e.mode}
            starting={p.startingMode === e.mode} canRun={p.canRun}
            onRun={() => p.onRun(e)} onStop={p.onStop}
            onOpen={e.model ? () => p.onOpen(e) : undefined}
            highlight={p.highlightKey === e.key} />
    )

    return (
        <section className={cn(s.panel, s.library)} aria-labelledby="cm-lib-title">
            <div className={s.libHead}>
                <div className={s.libTitleRow}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <h2 id="cm-lib-title" className={s.title}>Models</h2>
                        <p className={s.muted}>Pick a model and press Run. It watches the live video and marks what it finds.</p>
                    </div>
                    {showAdd && (
                        <button type="button" className={cn(s.btn, p.premiumEnabled && s.primary)} onClick={p.onAdd}
                            title={p.premiumEnabled ? 'Add a model of your own' : 'Custom models are a premium feature'}>
                            {p.premiumEnabled ? <Plus size={14} aria-hidden /> : <Lock size={13} aria-hidden />}
                            Add model
                        </button>
                    )}
                </div>
                {!p.canRun && (
                    <p role="note" className={cn(s.callout, s.calloutInfo)}>
                        <Eye size={15} aria-hidden style={{ color: 'var(--cm-accent)' }} />
                        <span>View only. Your role in this workspace can see the models but not run them.</span>
                    </p>
                )}
                <div className={s.toolbar}>
                    <div className={s.segment} role="group" aria-label="Show">
                        {FILTERS.map(f => (
                            <button key={f.value} type="button" aria-pressed={filter === f.value}
                                onClick={() => setFilter(f.value)}>
                                {f.label}<span className={s.count}>{counts[f.value]}</span>
                            </button>
                        ))}
                    </div>
                    <label className={s.search}>
                        <Search size={13} aria-hidden />
                        <span className="sr-only">Search models</span>
                        <input ref={searchRef} type="search" value={query} placeholder="Search"
                            onChange={e => setQuery(e.target.value)} aria-keyshortcuts="/" />
                    </label>
                </div>
            </div>

            <div className={s.list}>
                {p.loadError && (
                    <Callout tone="warn" title="Your own models could not be loaded."
                        actions={<button type="button" className={s.btn} onClick={p.onRetryLoad}>Try again</button>}>
                        HYRAK models still work. {p.loadError}
                    </Callout>
                )}

                {q && shown.length === 0 ? (
                    <div className={s.empty}>
                        <h3>No models match &quot;{query.trim()}&quot;</h3>
                        <p className={s.muted}>Try a shorter word, or clear the search to see every model.</p>
                        <button type="button" className={s.btn} onClick={() => { setQuery(''); setFilter('all') }}>Clear search</button>
                    </div>
                ) : (
                    <>
                        {filter !== 'ours' && hyrak.length > 0 && (
                            <>
                                {filter === 'all' && <p className={cn(s.label, s.groupLabel)}>HYRAK models</p>}
                                {hyrak.map(card)}
                            </>
                        )}
                        {filter !== 'hyrak' && (
                            <>
                                {filter === 'all' && (ours.length > 0 || !q) && <p className={cn(s.label, s.groupLabel)}>Our models</p>}
                                {p.loading && ours.length === 0 ? <CardSkeleton /> : ours.map(card)}
                                {!p.loading && !p.loadError && ours.length === 0 && !q && (
                                    <OursEmpty compact={filter === 'all'} canManage={p.canManage}
                                        premiumEnabled={p.premiumEnabled} onAdd={p.onAdd} />
                                )}
                            </>
                        )}
                    </>
                )}
            </div>
        </section>
    )
}

function ModelCard({ entry: e, running, starting, canRun, onRun, onStop, onOpen, highlight }: {
    entry: LibraryEntry; running: boolean; starting: boolean; canRun: boolean
    onRun: () => void; onStop: () => void; onOpen?: () => void; highlight?: boolean
}) {
    const Icon = e.icon
    const ref = useRef<HTMLDivElement>(null)
    useEffect(() => { if (highlight) ref.current?.scrollIntoView({ block: 'nearest' }) }, [highlight])
    const text = (
        <>
            <span className={s.cardName}>
                <span>{e.name}</span>
                {running && <span className={cn(s.chip, s.chipInfo)}><span className={s.dot} aria-hidden />Running</span>}
            </span>
            <span className={s.cardBlurb}>{e.blurb}</span>
            {e.group === 'ours' || e.status !== 'ready' ? (
                <StatusChip status={e.status} step={e.step} progress={e.progress} source={e.model?.source} />
            ) : null}
        </>
    )
    return (
        <div ref={ref} className={s.card} data-running={running} data-clickable={!!onOpen}
            style={highlight ? { boxShadow: '0 0 0 2px var(--cm-accent)' } : undefined}>
            <span className={s.iconTile} style={{ background: `${e.color}1f`, color: e.color }} aria-hidden>
                <Icon size={18} />
            </span>
            {onOpen ? (
                <button type="button" className={s.cardOpen} onClick={onOpen}
                    aria-label={`${e.name}: open details`}>{text}</button>
            ) : (
                <div className={s.cardMain}>{text}</div>
            )}
            <div className={s.cardActions}>
                {canRun && e.status === 'ready' && (running ? (
                    <button type="button" className={s.btn} onClick={onStop} aria-label={`Stop ${e.name}`}>
                        <Square size={12} aria-hidden /> Stop
                    </button>
                ) : (
                    <button type="button" className={cn(s.btn, s.primary)} onClick={onRun}
                        aria-label={`Run ${e.name}`} aria-busy={starting || undefined}>
                        <Play size={12} aria-hidden /> {starting ? 'Starting' : 'Run'}
                    </button>
                ))}
                {e.status === 'failed' && onOpen && (
                    <button type="button" className={s.btn} onClick={onOpen}>See how to fix</button>
                )}
                {onOpen && <ChevronRight size={16} className={s.chev} aria-hidden />}
            </div>
            {e.status === 'failed' && e.error && (
                <div className={s.attention}>{e.error}</div>
            )}
        </div>
    )
}

function CardSkeleton() {
    return (
        <div className={s.card} aria-hidden>
            <span className={cn(s.iconTile, s.skel)} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className={s.skel} style={{ height: 12, width: '45%' }} />
                <span className={s.skel} style={{ height: 10, width: '80%' }} />
            </span>
            <span className={s.skel} style={{ width: 56, height: 28 }} />
        </div>
    )
}

/** "Our models" with nothing in it: one sentence, the action, and three
 *  steps in text and icons. In the All view a slimmer version. */
function OursEmpty({ compact, canManage, premiumEnabled, onAdd }: {
    compact: boolean; canManage: boolean; premiumEnabled: boolean; onAdd: () => void
}) {
    return (
        <div className={cn(s.inset, s.empty)} style={compact ? { padding: '14px 14px' } : undefined}>
            <h3>No models of your own yet</h3>
            <p className={s.muted}>
                Add a model trained for your job, like spotting cracks or counting crops, and run it here like any HYRAK model.
            </p>
            {!compact && (
                <ol className={s.howto} aria-label="How adding a model works">
                    <li><span><Upload size={14} aria-hidden /></span>Drop an .onnx file or paste a Hugging Face link</li>
                    <li><span><Wand2 size={14} aria-hidden /></span>Check what it finds and give it a name</li>
                    <li><span><CheckCircle2 size={14} aria-hidden /></span>HYRAK tests it, then it is ready to run</li>
                </ol>
            )}
            {canManage ? (
                <button type="button" className={cn(s.btn, premiumEnabled && s.primary)} onClick={onAdd}>
                    {premiumEnabled ? <Plus size={14} aria-hidden /> : <Lock size={13} aria-hidden />}
                    Add your first model
                </button>
            ) : (
                <p className={s.muted}>Ask a workspace admin to add one.</p>
            )}
        </div>
    )
}
