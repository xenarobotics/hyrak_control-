'use client'

// A model's run settings in plain words: what it does, how sure it must be
// to show a box, which classes show, and small-object tiling.
//
//   SettingsFields       the three run settings, controlled (no saving):
//                        used by the detail panel and by Add's "More options"
//   ModelSettingsSection the detail panel's Settings: saves each change on
//                        its own (the slider debounced) with a small "Saved",
//                        read-only for people who cannot manage models
//
// A change reaches sessions already running the model on their next frame.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Loader, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    passesFor, runSettingsOf, speedSentence, TASK_WORDS, TILING_WORDS, updateModel,
    type ApiProblem, type CustomModel, type ModelPatch, type ModelTask, type RunSettings, type Tiling,
} from '@/lib/models'
import { Callout, Hint, css as s } from './ui'

export type SettingFocus = 'sensitivity' | 'classes' | 'tiling'

const SAVE_DELAY_MS = 400
const INLINE_PICKER = 8

export function sensitivityHint(t: number): string {
    if (t <= 0.15) return 'Very low: expect extra boxes on things that are not there.'
    if (t >= 0.7) return 'High: shows only what it is very sure of, and may miss some.'
    return 'Lower finds more but may add mistakes. Higher shows less but is surer.'
}

/** "about 9 frames per second" for a tiling, from the test's speed. */
function tilingSpeed(tiling: Tiling, latencyMs: number | null | undefined): string | null {
    if (tiling === 'off' || !latencyMs) return null
    const s = speedSentence(latencyMs * passesFor(tiling))
    if (!s) return null
    return tiling === 'auto'
        ? `Then ${s}; smaller video runs at full speed.`
        : `With ${tiling} tiles: ${s} on our GPU.`
}

export function SettingsFields({ value, onChange, labels, task, readOnly, latencyMs, idPrefix, focus }: {
    value: RunSettings
    onChange: (patch: Partial<RunSettings>) => void
    labels: string[]
    task: ModelTask | null
    readOnly?: boolean
    /** The test's latency, for the tiling speed sentence. */
    latencyMs?: number | null
    idPrefix: string
    focus?: SettingFocus | null
}) {
    const detect = task !== 'classify'
    const pct = Math.round(value.threshold * 100)
    const tilingOn = value.tiling !== 'off'

    // Opened from a results chip: bring that setting into view.
    useEffect(() => {
        if (!focus) return
        const el = document.getElementById(`${idPrefix}-${focus}`)
        if (!el) return
        el.scrollIntoView({ block: 'center' })
        el.focus({ preventScroll: true })
    }, [focus, idPrefix])

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {detect && (
                <div className={s.field} id={readOnly ? `${idPrefix}-sensitivity` : undefined} tabIndex={readOnly ? -1 : undefined}>
                    {readOnly
                        ? <span className={s.label}>Sensitivity</span>
                        : <label htmlFor={`${idPrefix}-sensitivity`} className={s.label}>Sensitivity</label>}
                    <p style={{ margin: 0 }}>Show a box when the model is at least <strong className={s.mono}>{pct}%</strong> sure</p>
                    {readOnly ? null : (
                        <input id={`${idPrefix}-sensitivity`} type="range" min={5} max={95} step={5} value={pct}
                            aria-describedby={`${idPrefix}-sensitivity-help`}
                            aria-valuetext={`${pct}% sure`}
                            style={{ width: '100%', accentColor: 'var(--cm-accent)', minHeight: 24 }}
                            onChange={e => onChange({ threshold: Number(e.target.value) / 100 })} />
                    )}
                    <p id={`${idPrefix}-sensitivity-help`} className={s.help} aria-live="polite">{sensitivityHint(value.threshold)}</p>
                </div>
            )}

            <ClassPicker labels={labels} value={value.classes_shown} readOnly={readOnly} id={`${idPrefix}-classes`}
                startOpen={focus === 'classes'} classify={!detect}
                onChange={classes_shown => onChange({ classes_shown })} />

            {detect && (
                <div className={s.field} id={readOnly ? `${idPrefix}-tiling` : undefined} tabIndex={readOnly ? -1 : undefined}>
                    <span className={s.label} id={`${idPrefix}-tiling-label`}>Small objects</span>
                    {readOnly ? (
                        <p style={{ margin: 0 }}>{tilingOn ? `Tiling ${value.tiling === 'auto' ? 'on (Auto)' : value.tiling}` : 'Off: each frame is checked whole.'}</p>
                    ) : (
                        <label className={s.toggle} style={{ color: 'var(--cm-ink)' }}>
                            <input id={`${idPrefix}-tiling`} type="checkbox" checked={tilingOn}
                                aria-describedby={`${idPrefix}-tiling-help`}
                                onChange={e => onChange({ tiling: e.target.checked ? 'auto' : 'off' })} />
                            Find small objects (splits each frame into tiles - slower)
                        </label>
                    )}
                    {tilingOn && !readOnly && (
                        <div className={s.segment} role="group" aria-labelledby={`${idPrefix}-tiling-label`} style={{ alignSelf: 'flex-start' }}>
                            {(Object.keys(TILING_WORDS) as (keyof typeof TILING_WORDS)[]).map(k => (
                                <button key={k} type="button" aria-pressed={value.tiling === k}
                                    onClick={() => onChange({ tiling: k })}>{TILING_WORDS[k].label}</button>
                            ))}
                        </div>
                    )}
                    <p id={`${idPrefix}-tiling-help`} className={s.help}>
                        {tilingOn
                            ? <>{TILING_WORDS[value.tiling as keyof typeof TILING_WORDS].line} {tilingSpeed(value.tiling, latencyMs)}</>
                            : 'For things that are only a few pixels across, like people seen from high up.'}
                    </p>
                </div>
            )}
        </div>
    )
}

function listOf(head: string, names: string[]): string {
    return `${head}: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` and ${names.length - 6} more` : ''}.`
}

/** Which classes show. All on by default; null means all. */
function ClassPicker({ labels, value, onChange, readOnly, id, startOpen, classify }: {
    labels: string[]
    value: string[] | null
    onChange: (next: string[] | null) => void
    readOnly?: boolean
    id: string
    startOpen?: boolean
    classify?: boolean
}) {
    const [open, setOpen] = useState(!!startOpen || labels.length <= INLINE_PICKER)
    const [q, setQ] = useState('')
    const [err, setErr] = useState<string | null>(null)
    const shown = useMemo(() => new Set(value ?? labels), [value, labels])
    const count = labels.filter(l => shown.has(l)).length
    const all = value === null || count === labels.length
    const matches = useMemo(() => {
        const t = q.trim().toLowerCase()
        return t ? labels.filter(l => l.toLowerCase().includes(t)) : labels
    }, [labels, q])
    const noun = classify ? 'answers' : 'classes'

    if (labels.length === 0) return null
    const summary = all ? `All ${labels.length} ${noun} show.` : `${count} of ${labels.length} ${noun} show.`

    if (readOnly) {
        return (
            <div className={s.field} id={id} tabIndex={-1} style={{ outline: 'none' }}>
                <span className={s.label}>Only show these {noun}</span>
                <p style={{ margin: 0 }}>{all ? summary : `${summary} ${listOf(count * 2 > labels.length ? 'Hidden' : 'Shown', labels.filter(l => shown.has(l) === (count * 2 <= labels.length)))}`}</p>
            </div>
        )
    }

    const toggle = (label: string, on: boolean) => {
        const next = labels.filter(l => (l === label ? on : shown.has(l)))
        if (next.length === 0) { setErr(`Keep at least one on. To show every ${classify ? 'answer' : 'class'}, press Show all.`); return }
        setErr(null)
        onChange(next.length === labels.length ? null : next)
    }

    return (
        <div className={s.field} id={id} tabIndex={-1} style={{ outline: 'none' }}>
            <span className={s.label} id={`${id}-label`}>Only show these {noun}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span>{summary}</span>
                {labels.length > INLINE_PICKER && (
                    <button type="button" className={s.link} aria-expanded={open}
                        aria-controls={`${id}-list`} onClick={() => setOpen(o => !o)}>
                        {open ? 'Hide the list' : `Choose ${noun}`}
                    </button>
                )}
                {!all && (
                    <button type="button" className={s.link} onClick={() => { setErr(null); onChange(null) }}>Show all</button>
                )}
            </div>
            {open && (
                <div id={`${id}-list`} className={s.inset} style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {labels.length > INLINE_PICKER && (
                        <>
                            <label htmlFor={`${id}-search`} className={s.help}>Search {noun}</label>
                            <div className={s.search}>
                                <Search size={13} aria-hidden />
                                <input id={`${id}-search`} type="search" value={q} placeholder="car" autoComplete="off"
                                    onChange={e => setQ(e.target.value)} />
                            </div>
                        </>
                    )}
                    <ul role="group" aria-labelledby={`${id}-label`} style={{
                        listStyle: 'none', margin: 0, padding: 0, maxHeight: 220, overflowY: 'auto',
                        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 2,
                    }}>
                        {matches.map(l => (
                            <li key={l}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32, padding: '0 4px', cursor: 'pointer', overflowWrap: 'anywhere' }}>
                                    <input type="checkbox" checked={shown.has(l)} style={{ accentColor: 'var(--cm-accent)', width: 16, height: 16, flexShrink: 0 }}
                                        onChange={e => toggle(l, e.target.checked)} />
                                    {l}
                                </label>
                            </li>
                        ))}
                    </ul>
                    {matches.length === 0 && <p className={s.help}>No {classify ? 'answer' : 'class'} matches &quot;{q}&quot;. <button type="button" className={s.link} onClick={() => setQ('')}>Clear the search</button></p>}
                </div>
            )}
            {err && <p className={s.fieldErr} role="alert">{err}</p>}
        </div>
    )
}

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; error: ApiProblem; patch: ModelPatch }

/** The detail panel's Settings section: saves on change. */
export function ModelSettingsSection({ model, labels, editable, onSaved, focus }: {
    model: CustomModel
    labels: string[]
    editable: boolean
    onSaved: (m: CustomModel) => void
    focus?: SettingFocus | null
}) {
    const [draft, setDraft] = useState<RunSettings>(() => runSettingsOf(model))
    const [task, setTask] = useState<ModelTask | null>(model.task)
    const [state, setState] = useState<SaveState>({ kind: 'idle' })
    const [taskNote, setTaskNote] = useState<string | null>(null)
    const pending = useRef<ModelPatch>({})
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const onSavedRef = useRef(onSaved)
    useEffect(() => { onSavedRef.current = onSaved }, [onSaved])

    const save = async (patch: ModelPatch) => {
        setState({ kind: 'saving' })
        const r = await updateModel(model.id, patch)
        if (!r.ok) { setState({ kind: 'error', error: r.error, patch }); return }
        onSavedRef.current(r.data)
        setState({ kind: 'saved' })
        if (savedTimer.current) clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setState(st => st.kind === 'saved' ? { kind: 'idle' } : st), 2000)
    }
    const flush = () => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null }
        const patch = pending.current
        pending.current = {}
        if (Object.keys(patch).length) void save(patch)
    }
    // Leaving the panel mid-debounce still saves the last change.
    const flushRef = useRef(flush)
    useEffect(() => { flushRef.current = flush })
    useEffect(() => () => {
        flushRef.current()
        if (savedTimer.current) clearTimeout(savedTimer.current)
    }, [])

    const change = (patch: Partial<RunSettings>) => {
        setDraft(d => ({ ...d, ...patch }))
        pending.current = { ...pending.current, ...patch }
        if (timer.current) clearTimeout(timer.current)
        // The slider waits for a pause; a click saves almost at once.
        timer.current = setTimeout(flush, 'threshold' in patch ? SAVE_DELAY_MS : 50)
    }

    const changeTask = (t: ModelTask) => {
        setTask(t)
        setTaskNote('Checking the model again as "' + TASK_WORDS[t].title.toLowerCase() + '". This takes about a minute; the model shows Checking until then.')
        void save({ task: t })
    }

    const status = state.kind === 'saving'
        ? <span className={s.help} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Loader size={11} className="animate-spin motion-reduce:animate-none" aria-hidden />Saving</span>
        : state.kind === 'saved'
            ? <span className={s.help} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--cm-ok)' }}><Check size={12} aria-hidden />Saved</span>
            : null

    return (
        <section className={s.section} aria-labelledby="cm-settings-title">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 18 }}>
                <span className={cn(s.label, s.sectionTitle)} id="cm-settings-title">Settings</span>
                <span role="status" aria-live="polite">{status}</span>
            </div>
            {editable && <p className={s.help} style={{ marginTop: -4 }}>Changes save by themselves and apply to the running video within a second.</p>}
            {state.kind === 'error' && (
                <Callout tone="bad" title={state.error.message}
                    actions={<button type="button" className={s.btn} onClick={() => void save(state.patch)}>Try again</button>}>
                    <Hint text={state.error.hint ?? 'The last change was not saved. Try again.'} />
                </Callout>
            )}
            <div className={s.inset} style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div className={s.field}>
                    <span className={s.label} id="cm-settings-task">What it does</span>
                    {editable ? (
                        <div className={s.choices} role="radiogroup" aria-labelledby="cm-settings-task">
                            {(['detect', 'classify'] as ModelTask[]).map(t => (
                                <label key={t} className={s.choice}>
                                    <input type="radio" name="cm-settings-task" checked={task === t} onChange={() => changeTask(t)} />
                                    <span>
                                        <strong style={{ display: 'block' }}>{TASK_WORDS[t].line}</strong>
                                    </span>
                                </label>
                            ))}
                        </div>
                    ) : (
                        <p style={{ margin: 0 }}>{task ? TASK_WORDS[task].line : 'Not known yet.'}</p>
                    )}
                    <p className={s.help} aria-live="polite">{taskNote ?? (editable ? 'Changing this checks the model again (about a minute).' : '')}</p>
                </div>
                <SettingsFields value={draft} onChange={change} labels={labels} task={task} readOnly={!editable}
                    latencyMs={model.version?.latency_ms} idPrefix="cm-set" focus={focus} />
            </div>
        </section>
    )
}

/** Small chips for the active settings, each opening its setting. */
export function SettingsChips({ model, liveTiling, inferMs, onOpen }: {
    model: CustomModel
    /** What ran on the last frame ("off", "2x2", "3x3"), from cv_results. */
    liveTiling?: string | null
    inferMs?: number | null
    onOpen: (f: SettingFocus) => void
}) {
    const v = runSettingsOf(model)
    const labels = model.version?.labels ?? model.labels ?? []
    const detect = model.task !== 'classify'
    const fps = inferMs && inferMs > 0 ? Math.max(1, Math.round(1000 / inferMs)) : null
    const ran = liveTiling && liveTiling !== 'off' ? liveTiling : null
    const tilingText = v.tiling === 'off' ? null
        : `Tiling ${ran ?? (v.tiling === 'auto' ? 'auto' : v.tiling)}${v.tiling === 'auto' && !ran && liveTiling === 'off' ? ' (off at this size)' : ''}${ran && fps ? ` - about ${fps} fps` : ''}`
    return (
        <div className={s.chips} role="group" aria-label="Active settings">
            {detect && (
                <button type="button" className={cn(s.chip, s.chipMute, s.chipBtn)} onClick={() => onOpen('sensitivity')}
                    title="Change the sensitivity">{Math.round(v.threshold * 100)}% sure</button>
            )}
            <button type="button" className={cn(s.chip, s.chipMute, s.chipBtn)} onClick={() => onOpen('classes')}
                title={detect ? 'Choose which classes show' : 'Choose which answers show'}>
                {v.classes_shown
                    ? `${v.classes_shown.length} of ${labels.length || v.classes_shown.length} ${detect ? 'classes' : 'answers'}`
                    : detect ? 'All classes' : 'All answers'}
            </button>
            {detect && (
                <button type="button" className={cn(s.chip, tilingText ? s.chipInfo : s.chipMute, s.chipBtn)} onClick={() => onOpen('tiling')}
                    title="Change small-object tiling">{tilingText ?? 'No tiling'}</button>
            )}
        </div>
    )
}
