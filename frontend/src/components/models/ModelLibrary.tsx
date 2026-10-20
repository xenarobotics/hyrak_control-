'use client'

// The AI tab's model library: a compact list to pick from. Header: title,
// Browse (everyone; opens the panel on All vision models) and Add (roles
// that can add; opens it on HYRAK's recommendations); then search and a
// filter (All, HYRAK, Ours); then one row per model: icon, name, one line,
// a status chip only when it is not simply ready, and a details button for
// models that have one. Pressing a row selects it; Run lives once, in the
// live view, for the selected model.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Compass, Eye, Plus, Search, Square, Upload, Wand2, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LibraryEntry } from './useModelLibrary'
import { css as s, StatusChip, Callout } from './ui'

export type LibraryFilter = 'all' | 'hyrak' | 'ours'

const FILTERS: { value: LibraryFilter; label: string; short: string }[] = [
    { value: 'all', label: 'All', short: 'All' },
    { value: 'hyrak', label: 'HYRAK', short: 'HYRAK' },
    { value: 'ours', label: 'Ours', short: 'Ours' },
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
    /** The model the live view would run. */
    selectedKey: string | null
    onSelect: (e: LibraryEntry) => void
    onStop: () => void
    onAdd: () => void
    /** Open the panel on "All vision models". */
    onBrowse: () => void
    onOpen: (e: LibraryEntry) => void
    /** Briefly highlight a row (just added). */
    highlightKey?: string | null
    /** Shown in a sheet (phones): no outer frame. */
    bare?: boolean
}

export function ModelLibrary(p: LibraryProps) {
    const [filter, setFilter] = useState<LibraryFilter>('all')
    const [query, setQuery] = useState('')
    const searchRef = useRef<HTMLInputElement>(null)

    // "/" focuses search, as on every list in the product.
    useEffect(() => {
        if (p.bare) return
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
    }, [p.bare])

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

    const row = (e: LibraryEntry) => (
        <ModelRow key={e.key} entry={e} selected={p.selectedKey === e.key}
            running={p.runningMode === e.mode} starting={p.startingMode === e.mode}
            canRun={p.canRun} canManage={p.canManage}
            onSelect={() => p.onSelect(e)} onStop={p.onStop}
            onOpen={e.model ? () => p.onOpen(e) : undefined}
            highlight={p.highlightKey === e.key} />
    )

    const oursBlock = (
        <>
            {filter === 'all' && (ours.length > 0 || !q) && <h3 className={cn(s.label, s.groupLabel)}>Our models</h3>}
            {p.loading && ours.length === 0 ? <RowSkeleton /> : ours.length > 0 && <ul className={s.rows}>{ours.map(row)}</ul>}
            {!p.loading && !p.loadError && ours.length === 0 && !q && (
                <OursEmpty compact={filter === 'all'} canManage={p.canManage}
                    onAdd={p.onAdd} onBrowse={p.onBrowse} />
            )}
        </>
    )

    return (
        <section className={cn(!p.bare && s.panel, s.library, p.bare && s.libraryBare)} aria-labelledby={p.bare ? undefined : 'cm-lib-title'} aria-label={p.bare ? 'Models' : undefined}>
            <div className={s.libHead}>
                <div className={s.libTitleRow}>
                    {!p.bare && <h2 id="cm-lib-title" className={s.title} style={{ flex: 1, minWidth: 0 }}>Models</h2>}
                    <button type="button" className={cn(s.btn, s.ghost)} onClick={p.onBrowse}
                        title="Every vision model on Hugging Face, most downloaded first">
                        <Compass size={14} aria-hidden /> Browse
                    </button>
                    {showAdd && (
                        <button type="button" className={cn(s.btn, s.primary)} onClick={p.onAdd}
                            aria-label="Add model"
                            title="Pick a model recommended for drones, browse Hugging Face, or upload your own">
                            <Plus size={14} aria-hidden /> Add
                        </button>
                    )}
                </div>
                {!p.canRun && (
                    <p role="note" className={cn(s.callout, s.calloutInfo)}>
                        <Eye size={15} aria-hidden style={{ color: 'var(--cm-accent)' }} />
                        <span>View only. Your role in this workspace can see the models but not run them.</span>
                    </p>
                )}
                <label className={s.search}>
                    <Search size={14} aria-hidden />
                    <span className="sr-only">Search models</span>
                    <input ref={searchRef} type="search" value={query} placeholder="Search models"
                        onChange={e => setQuery(e.target.value)} aria-keyshortcuts={p.bare ? undefined : '/'} />
                </label>
                <div className={cn(s.segment, s.libFilter)} role="group" aria-label="Show">
                    {FILTERS.map(f => (
                        <button key={f.value} type="button" aria-pressed={filter === f.value}
                            aria-label={`${f.label}, ${counts[f.value]}`}
                            onClick={() => setFilter(f.value)}>
                            {f.label}
                            <span className={s.count} aria-hidden>{counts[f.value]}</span>
                        </button>
                    ))}
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
                        {/* Our own models lead once there are any: they are
                            why someone comes back. Until then HYRAK's lead,
                            with the add prompt after them. */}
                        {ours.length > 0 && filter !== 'hyrak' && oursBlock}
                        {filter !== 'ours' && hyrak.length > 0 && (
                            <>
                                {filter === 'all' && <h3 className={cn(s.label, s.groupLabel)}>HYRAK models</h3>}
                                <ul className={s.rows}>{hyrak.map(row)}</ul>
                            </>
                        )}
                        {ours.length === 0 && filter !== 'hyrak' && oursBlock}
                    </>
                )}
            </div>
        </section>
    )
}

function ModelRow({ entry: e, selected, running, starting, canRun, canManage, onSelect, onStop, onOpen, highlight }: {
    entry: LibraryEntry; selected: boolean; running: boolean; starting: boolean; canRun: boolean; canManage: boolean
    onSelect: () => void; onStop: () => void; onOpen?: () => void; highlight?: boolean
}) {
    const Icon = e.icon
    const ref = useRef<HTMLLIElement>(null)
    useEffect(() => { if (highlight) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [highlight])
    const failed = e.status === 'failed'
    return (
        <li ref={ref} className={cn(s.row, highlight && s.cardNew)} data-selected={selected} data-running={running}>
            <span className={s.rowIcon} style={{ background: `${e.color}1f`, color: e.color }} aria-hidden>
                <Icon size={16} />
            </span>
            <button type="button" className={s.rowMain} onClick={onSelect} aria-pressed={selected}
                title={e.blurb}>
                <span className={s.rowName}>{e.name}</span>
                {/* Not ready yet: its status in place of the line. */}
                {e.status !== 'ready' && !running
                    ? <StatusChip status={e.status} step={e.step} progress={e.progress} source={e.model?.source} />
                    : <span className={s.rowBlurb}>{e.blurb}</span>}
            </button>
            <span className={s.rowSide}>
                {running && (
                    <span className={cn(s.chip, s.chipInfo)}><span className={s.dot} aria-hidden />{starting ? 'Starting' : 'Running'}</span>
                )}
                {running && canRun && (
                    <button type="button" className={s.iconBtn} onClick={onStop}
                        aria-label={`Stop ${e.name}`} title={`Stop ${e.name}`}>
                        <Square size={13} aria-hidden />
                    </button>
                )}
                {onOpen && (
                    <button type="button" className={s.iconBtn} onClick={onOpen}
                        aria-label={`${e.name}: open details`} title="Details and settings">
                        <ChevronRight size={16} aria-hidden />
                    </button>
                )}
            </span>
            {failed && e.error && (
                <div className={s.attention}>
                    {e.error}{' '}
                    {onOpen && <button type="button" className={s.link} onClick={onOpen}>{canManage && e.group === 'ours' ? 'See how to fix' : 'See details'}</button>}
                </div>
            )}
        </li>
    )
}

function RowSkeleton() {
    return (
        <div className={s.row} aria-hidden>
            <span className={cn(s.rowIcon, s.skel)} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className={s.skel} style={{ height: 12, width: '45%' }} />
                <span className={s.skel} style={{ height: 10, width: '80%' }} />
            </span>
        </div>
    )
}

/** "Our models" with nothing in it: one sentence, the action, and three
 *  steps in text and icons. In the All view a slimmer version. */
function OursEmpty({ compact, canManage, onAdd, onBrowse }: {
    compact: boolean; canManage: boolean; onAdd: () => void; onBrowse: () => void
}) {
    return (
        <div className={cn(s.inset, s.empty)} style={compact ? { padding: '14px 14px' } : undefined}>
            <h3>No models of your own yet</h3>
            <p className={s.muted}>
                Add a model trained for your job, like spotting cracks or counting crops, and run it here like any HYRAK model.
            </p>
            {!compact && (
                <ol className={s.howto} aria-label="How adding a model works">
                    <li><span><Upload size={14} aria-hidden /></span>Pick a model recommended for drones, browse Hugging Face, or drop an .onnx file</li>
                    <li><span><Wand2 size={14} aria-hidden /></span>Check what it finds and give it a name</li>
                    <li><span><CheckCircle2 size={14} aria-hidden /></span>HYRAK tests it, then it is ready to run</li>
                </ol>
            )}
            {canManage ? (
                <button type="button" className={cn(s.btn, s.primary)} onClick={onAdd}>
                    <Plus size={14} aria-hidden /> Add your first model
                </button>
            ) : (
                <button type="button" className={s.btn} onClick={onBrowse}>
                    <Compass size={14} aria-hidden /> Browse models
                </button>
            )}
        </div>
    )
}
