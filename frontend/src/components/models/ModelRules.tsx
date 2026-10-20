'use client'

// The detail panel's Rules: each rule is one sentence you edit in place,
//   "When [person] is seen above [60%] for [1 s], then [Alert me]."
// Saved by itself a moment after each change, like Settings. Up to 6 rules,
// at most one Follow switched on. Hover and Follow move the drone, so they
// also need the pilot to allow model control during the flight, and by
// default they ask first.
//
// A model that only has the old single alert shows it here as an alert
// rule; the first save writes `rules` and clears `alert`.

import { useEffect, useRef, useState } from 'react'
import { Check, Loader, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { updateModel, type ApiProblem, type CustomModel, type ModelPatch, type ModelRule, type RuleAction } from '@/lib/models'
import {
    ACTION_WORDS, ACTIONS, MAX_RULES, movesDrone, needsBox, newRule, pct, rulesOf, seconds,
} from '@/lib/modelRules'
import { Callout, Hint, css as s } from './ui'

const SAVE_DELAY_MS = 400
const SCORES = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
const FOR_S = [0, 1, 2, 3, 5, 10, 20, 30]
const COOLDOWNS = [5, 10, 30, 60, 120, 300, 600]

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; error: ApiProblem; patch: ModelPatch }

/** Keep a value that is not in the preset list selectable. */
function withValue(list: number[], v: number): number[] {
    return list.includes(v) ? list : [...list, v].sort((a, b) => a - b)
}

export function sentenceOf(r: ModelRule): string {
    const when = r.for_s > 0 ? ` for ${seconds(r.for_s)}` : ''
    return `When ${r.label} is seen above ${pct(r.min_score)}${when}, then ${ACTION_WORDS[r.action].label.toLowerCase()}.`
}

export function RulesSection({ model, labels, editable, onSaved }: {
    model: CustomModel
    labels: string[]
    editable: boolean
    onSaved: (m: CustomModel) => void
}) {
    const classify = model.task === 'classify'
    const [init] = useState(() => rulesOf(model))
    const [rules, setRules] = useState<ModelRule[]>(init.rules)
    const legacy = useRef(init.legacy)
    const [state, setState] = useState<SaveState>({ kind: 'idle' })
    const [note, setNote] = useState<string | null>(null)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const pending = useRef<ModelRule[] | null>(null)
    const onSavedRef = useRef(onSaved)
    useEffect(() => { onSavedRef.current = onSaved }, [onSaved])

    const save = async (patch: ModelPatch) => {
        setState({ kind: 'saving' })
        const r = await updateModel(model.id, patch)
        if (!r.ok) { setState({ kind: 'error', error: r.error, patch }); return }
        legacy.current = false
        onSavedRef.current(r.data)
        setState({ kind: 'saved' })
        if (savedTimer.current) clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setState(st => st.kind === 'saved' ? { kind: 'idle' } : st), 2000)
    }
    const flush = () => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null }
        const next = pending.current
        pending.current = null
        if (next) void save(legacy.current ? { rules: next, alert: null } : { rules: next })
    }
    // Leaving the panel mid-wait still saves the last change.
    const flushRef = useRef(flush)
    useEffect(() => { flushRef.current = flush })
    useEffect(() => () => {
        flushRef.current()
        if (savedTimer.current) clearTimeout(savedTimer.current)
    }, [])

    const commit = (next: ModelRule[]) => {
        setRules(next)
        setNote(null)
        pending.current = next
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(flush, SAVE_DELAY_MS)
    }

    const followOnElsewhere = (id: string) => rules.some(r => r.id !== id && r.enabled && r.action === 'follow')

    const change = (id: string, patch: Partial<ModelRule>) => {
        const cur = rules.find(r => r.id === id)
        if (!cur) return
        const next = { ...cur, ...patch }
        if (next.enabled && next.action === 'follow' && followOnElsewhere(id)) {
            setNote('Only one Follow rule can be on at a time. Turn the other one off first.')
            return
        }
        // Asking first only means something for hover and follow.
        if ('action' in patch && patch.action !== cur.action) next.confirm = movesDrone(next.action)
        commit(rules.map(r => (r.id === id ? next : r)))
    }

    const add = () => {
        if (rules.length >= MAX_RULES) return
        commit([...rules, newRule(labels[0] ?? '')])
    }

    const remove = (id: string) => commit(rules.filter(r => r.id !== id))

    const status = state.kind === 'saving'
        ? <span className={s.help} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Loader size={11} className="animate-spin motion-reduce:animate-none" aria-hidden />Saving</span>
        : state.kind === 'saved'
            ? <span className={s.help} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--cm-ok)' }}><Check size={12} aria-hidden />Saved</span>
            : null

    if (!editable) {
        return (
            <section className={s.section} aria-labelledby="cm-rules-title">
                <span className={s.label} id="cm-rules-title">Rules</span>
                {rules.length === 0 ? <p className={s.muted}>No rules set.</p> : (
                    <ul className={s.rules}>
                        {rules.map(r => (
                            <li key={r.id} className={s.help} style={{ color: r.enabled ? 'var(--cm-ink)' : undefined }}>
                                {sentenceOf(r)}{r.enabled ? '' : ' (off)'}
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        )
    }

    return (
        <section className={s.section} aria-labelledby="cm-rules-title">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 18 }}>
                <span className={s.label} id="cm-rules-title">Rules</span>
                <span role="status" aria-live="polite">{status}</span>
            </div>
            <p className={s.help} style={{ marginTop: -4 }}>
                Tell the drone what to do when the model sees something. Rules work while this model runs, and save by themselves.
            </p>
            {state.kind === 'error' && (
                <Callout tone="bad" title={state.error.message}
                    actions={<button type="button" className={s.btn} onClick={() => void save(state.patch)}>Try again</button>}>
                    <Hint text={state.error.hint ?? 'The last change was not saved. Try again.'} />
                </Callout>
            )}
            {rules.length > 0 && (
                <ul className={s.rules}>
                    {rules.map((r, i) => (
                        <RuleRow key={r.id} rule={r} n={i + 1} labels={labels} classify={classify}
                            followTaken={followOnElsewhere(r.id)}
                            onChange={p => change(r.id, p)} onDelete={() => remove(r.id)} />
                    ))}
                </ul>
            )}
            {note && <p className={s.fieldErr} role="alert">{note}</p>}
            {rules.length < MAX_RULES ? (
                <button type="button" className={s.btn} style={{ alignSelf: 'flex-start' }} onClick={add} disabled={labels.length === 0}>
                    <Plus size={13} aria-hidden /> Add a rule
                </button>
            ) : (
                <p className={s.help}>That is the most rules a model can have ({MAX_RULES}). Delete one to add another.</p>
            )}
        </section>
    )
}

function RuleRow({ rule: r, n, labels, classify, followTaken, onChange, onDelete }: {
    rule: ModelRule
    n: number
    labels: string[]
    classify: boolean
    /** Another rule already follows: Follow cannot be picked here. */
    followTaken: boolean
    onChange: (patch: Partial<ModelRule>) => void
    onDelete: () => void
}) {
    const id = `cm-rule-${r.id}`
    // Match the model's class names case-insensitively; keep an unknown one visible.
    const known = labels.find(l => l.toLowerCase() === r.label.toLowerCase())
    const labelValue = known ?? r.label
    const options = known || !r.label ? labels : [...labels, r.label]
    const moves = movesDrone(r.action)
    const noBox = classify && needsBox(r.action)

    return (
        <li className={cn(s.inset, s.rule)} data-off={!r.enabled} aria-label={`Rule ${n}`}>
            <div className={s.ruleHead}>
                <p className={s.ruleSentence} style={{ margin: 0 }}>
                    <span>When</span>
                    <select className={s.ruleSelect} value={labelValue} aria-label={`Rule ${n}: what to look for`}
                        onChange={e => onChange({ label: e.target.value })}>
                        {options.map(l => <option key={l} value={l}>{l}{l === labelValue && !known ? ' (not in this model)' : ''}</option>)}
                    </select>
                    <span>is seen above</span>
                    <select className={s.ruleSelect} value={r.min_score} aria-label={`Rule ${n}: how sure the model must be`}
                        onChange={e => onChange({ min_score: Number(e.target.value) })}>
                        {withValue(SCORES, r.min_score).map(x => <option key={x} value={x}>{pct(x)}</option>)}
                    </select>
                    <span>for</span>
                    <select className={s.ruleSelect} value={r.for_s} aria-label={`Rule ${n}: how long it must be seen`}
                        onChange={e => onChange({ for_s: Number(e.target.value) })}>
                        {withValue(FOR_S, r.for_s).map(x => <option key={x} value={x}>{x === 0 ? '0 s (right away)' : `${x} s`}</option>)}
                    </select>
                    <span style={{ marginLeft: -5 }}>, then</span>
                    <select className={s.ruleSelect} value={r.action} aria-label={`Rule ${n}: what to do`}
                        aria-describedby={`${id}-hint`}
                        onChange={e => onChange({ action: e.target.value as RuleAction })}>
                        {ACTIONS.filter(a => !classify || !needsBox(a) || a === r.action).map(a => (
                            <option key={a} value={a}
                                disabled={(a === 'follow' && followTaken && r.enabled && r.action !== 'follow') || (classify && needsBox(a))}>
                                {ACTION_WORDS[a].label}
                                {a === 'follow' && followTaken && r.enabled && r.action !== 'follow' ? ' - another rule already follows' : ''}
                                {classify && needsBox(a) ? ' - needs a box' : ''}
                            </option>
                        ))}
                    </select>
                </p>
                <label className={s.toggle} title={r.enabled ? 'Rule is on' : 'Rule is off'}>
                    <input type="checkbox" checked={r.enabled} aria-label={`Rule ${n} on`}
                        onChange={e => onChange({ enabled: e.target.checked })} />
                </label>
                <button type="button" className={s.iconBtn} onClick={onDelete}
                    aria-label={`Delete rule ${n}`} title="Delete rule" style={{ marginTop: -4 }}>
                    <Trash2 size={14} aria-hidden />
                </button>
            </div>
            <div className={s.ruleMeta}>
                <p id={`${id}-hint`} className={s.help} style={{ margin: 0 }}>
                    {noBox ? 'This model answers with a name, not a box, so there is nothing to pin or follow. Pick another action.' : ACTION_WORDS[r.action].hint}
                </p>
                {moves && (
                    <>
                        <div className={s.ruleMetaRow}>
                            <label className={s.toggle} style={{ color: 'var(--cm-ink)' }}>
                                <input type="checkbox" checked={r.confirm}
                                    onChange={e => onChange({ confirm: e.target.checked })} />
                                Ask me first
                            </label>
                            <span>{r.confirm ? 'You get 10 s to accept. Nothing moves unless you do.' : 'It acts without asking.'}</span>
                        </div>
                        <div className={s.moves}>
                            <TriangleAlert size={13} aria-hidden />
                            <span>This moves the drone. It only works after the pilot turns on <strong>Allow model control</strong> during the flight.</span>
                        </div>
                    </>
                )}
                <div className={s.ruleMetaRow}>
                    <label htmlFor={`${id}-cool`}>Then wait</label>
                    <select id={`${id}-cool`} className={s.ruleSelect} value={r.cooldown_s} style={{ fontWeight: 500 }}
                        onChange={e => onChange({ cooldown_s: Number(e.target.value) })}>
                        {withValue(COOLDOWNS, r.cooldown_s).map(x => <option key={x} value={x}>{seconds(x)}</option>)}
                    </select>
                    <span>before doing it again</span>
                </div>
            </div>
        </li>
    )
}
