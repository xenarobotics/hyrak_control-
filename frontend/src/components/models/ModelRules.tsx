'use client'

// The detail panel's Rules. Each rule is a card that reads at a glance,
//   [pedestrian] -> [Alert]   (50% sure) (for 1 s) (again after 30 s)
// and opens to edit: what it looks for (class, how sure, for how long) and
// what it does (four action tiles). Saved by itself a moment after each
// change, like Settings. Up to 6 rules, at most one Follow switched on.
// Hover and Follow move the drone: they are drawn amber, ask first by
// default, and need the pilot to allow model control during the flight.
//
// A model that only has the old single alert shows it here as an alert
// rule; the first save writes `rules` and clears `alert`.

import { useEffect, useRef, useState } from 'react'
import {
    ArrowRight, BellRing, Check, ChevronDown, Crosshair, Hand, Loader, MapPin, MessageCircleQuestion,
    Plug, Plus, ShieldCheck, Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { updateModel, type ApiProblem, type CustomModel, type ModelPatch, type ModelRule, type RuleAction } from '@/lib/models'
import {
    ACTION_WORDS, ACTIONS, MAX_RULES, movesDrone, needsBox, newRule, pct, rulesOf, seconds,
} from '@/lib/modelRules'
import {
    KINDS, KIND_META, actionText, isLevel, ruleActionsFor, ruleHazard, type AttachmentKind,
} from '@/lib/attachments'
import { Callout, Hint, css as s } from './ui'

const SAVE_DELAY_MS = 400
const FOR_S = [0, 1, 3, 5, 10]
const COOLDOWNS = [10, 30, 60, 300]

export const ACTION_ICON: Record<RuleAction, typeof BellRing> = { alert: BellRing, mark: MapPin, hover: Hand, follow: Crosshair, attachment: Plug }

/** An attachment rule's action, as the drone's button would say it ("Drop",
 *  "Spray 50%"), and its kind's icon. */
export function attachmentWords(r: ModelRule): { icon: typeof BellRing; short: string; long: string } {
    const kind = r.attachment_kind && KIND_META[r.attachment_kind] ? r.attachment_kind : null
    if (!kind) return { icon: Plug, short: 'Attachment', long: 'use an attachment' }
    const act = ruleActionsFor(kind).find(a => a.id === r.attachment_action)
    const short = act ? actionText(act, isLevel(act) ? r.value ?? 50 : null) : 'Attachment'
    return { icon: KIND_META[kind].icon, short, long: `${KIND_META[kind].defaultName.toLowerCase()}: ${short.toLowerCase()}` }
}

/** The action's icon and short word, attachment rules included. */
export function actionFace(r: ModelRule): { icon: typeof BellRing; short: string } {
    if (r.action === 'attachment') return attachmentWords(r)
    return { icon: ACTION_ICON[r.action], short: ACTION_WORDS[r.action].short }
}

/** What the action does, as short facts instead of a paragraph. */
const ACTION_FACTS: Record<RuleAction, string[]> = {
    alert: ['Message and sound', 'Staff see it too'],
    mark: ['Pin on the map', 'Saved with the flight'],
    hover: ['Stops and holds', 'Pauses a mission'],
    follow: ['Up to 3 m/s', 'Keeps its height', 'Lost 3 s: hovers'],
    attachment: ['First one of that kind', 'Set up in Config'],
}

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; error: ApiProblem; patch: ModelPatch }

export function sentenceOf(r: ModelRule): string {
    const when = r.for_s > 0 ? ` for ${seconds(r.for_s)}` : ''
    const then = r.action === 'attachment' ? attachmentWords(r).long : ACTION_WORDS[r.action].label.toLowerCase()
    return `When ${r.label} is seen above ${pct(r.min_score)}${when}, then ${then}.`
}

/** The numbers as small separate facts: "50% sure", "for 1 s", "again after 30 s". */
function summaryOf(r: ModelRule): string[] {
    return [`${pct(r.min_score)} sure`, r.for_s > 0 ? `for ${r.for_s} s` : 'at once', `again after ${seconds(r.cooldown_s)}`]
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
    const [open, setOpen] = useState<string | null>(null)
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
        // Asking first only means something for hover, follow and attachments.
        if ('action' in patch && patch.action !== cur.action) {
            next.confirm = movesDrone(next.action)
            if (next.action === 'attachment') {
                next.attachment_kind = next.attachment_kind ?? 'release'
                next.attachment_action = next.attachment_action ?? 'drop'
            } else {
                delete next.attachment_kind
                delete next.attachment_action
                delete next.value
            }
        }
        if (next.action === 'attachment') {
            const lvl = next.attachment_action === 'level'
            if (lvl && next.value == null) next.value = 50
            if (!lvl) delete next.value
            // It can hurt someone: it always asks first.
            if (ruleHazard(next.attachment_kind, next.attachment_action)) next.confirm = true
        }
        commit(rules.map(r => (r.id === id ? next : r)))
    }

    const add = () => {
        if (rules.length >= MAX_RULES) return
        const r = newRule(labels[0] ?? '')
        commit([...rules, r])
        setOpen(r.id)
    }

    const remove = (id: string) => commit(rules.filter(r => r.id !== id))

    const status = state.kind === 'saving'
        ? <span className={s.rulesStatus}><Loader size={11} className="animate-spin motion-reduce:animate-none" aria-hidden />Saving</span>
        : state.kind === 'saved'
            ? <span className={s.rulesStatus} style={{ color: 'var(--cm-ok)' }}><Check size={12} aria-hidden />Saved</span>
            : null

    if (!editable) {
        return (
            <section className={s.section} aria-labelledby="cm-rules-title">
                <span className={s.label} id="cm-rules-title">Rules</span>
                {rules.length === 0 ? <p className={s.muted}>No rules set.</p> : (
                    <ul className={s.rules}>
                        {rules.map(r => (
                            <li key={r.id} className={cn(s.inset, s.ruleCard)} data-off={!r.enabled} title={sentenceOf(r)}>
                                <RuleSummary rule={r} />
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        )
    }

    return (
        <section className={s.section} aria-labelledby="cm-rules-title">
            <div className={s.rulesHead}>
                <span className={s.label} id="cm-rules-title">Rules</span>
                {rules.length > 0 && <span className={s.mono} style={{ fontSize: 12, color: 'var(--cm-ink-2)' }}>{rules.length}/{MAX_RULES}</span>}
                <span role="status" aria-live="polite">{status}</span>
                {rules.length > 0 && rules.length < MAX_RULES && (
                    <button type="button" className={cn(s.btn, s.ghost)} style={{ marginLeft: 'auto', height: 26 }}
                        onClick={add} disabled={labels.length === 0}>
                        <Plus size={13} aria-hidden /> Add
                    </button>
                )}
            </div>
            {state.kind === 'error' && (
                <Callout tone="bad" title={state.error.message}
                    actions={<button type="button" className={s.btn} onClick={() => void save(state.patch)}>Try again</button>}>
                    <Hint text={state.error.hint ?? 'The last change was not saved. Try again.'} />
                </Callout>
            )}
            {rules.length === 0 ? (
                <div className={cn(s.inset, s.rulesEmpty)}>
                    <span className={s.rulesEmptyIcons} aria-hidden>
                        {ACTIONS.map(a => { const I = ACTION_ICON[a]; return <I key={a} size={16} /> })}
                    </span>
                    <span>Make the drone react to what the model sees.</span>
                    <button type="button" className={cn(s.btn, s.primary)} onClick={add} disabled={labels.length === 0}>
                        <Plus size={13} aria-hidden /> Add a rule
                    </button>
                </div>
            ) : (
                <ul className={s.rules}>
                    {rules.map((r, i) => (
                        <RuleCard key={r.id} rule={r} n={i + 1} labels={labels} classify={classify}
                            open={open === r.id} onToggle={() => setOpen(o => (o === r.id ? null : r.id))}
                            followTaken={followOnElsewhere(r.id)}
                            onChange={p => change(r.id, p)} onDelete={() => remove(r.id)} />
                    ))}
                </ul>
            )}
            {note && <p className={s.fieldErr} role="alert">{note}</p>}
        </section>
    )
}

/** The card's face: class -> action, and the numbers underneath. */
function RuleSummary({ rule: r }: { rule: ModelRule }) {
    const { icon: Icon, short } = actionFace(r)
    const moves = movesDrone(r.action)
    return (
        <span className={s.ruleFace}>
            <span className={s.ruleFlow}>
                <span className={s.ruleClass}>{r.label || 'pick a class'}</span>
                <ArrowRight size={13} aria-hidden style={{ color: 'var(--cm-ink-2)', flexShrink: 0 }} />
                <span className={s.ruleAction} data-moves={moves}>
                    <Icon size={12} aria-hidden /> {short}
                </span>
                {moves && r.confirm && (
                    <MessageCircleQuestion size={13} aria-label="Asks first" style={{ color: 'var(--cm-ink-2)', flexShrink: 0 }} />
                )}
            </span>
            <span className={s.factRow}>
                {summaryOf(r).map(f => <span key={f} className={s.fact}>{f}</span>)}
            </span>
        </span>
    )
}

function RuleCard({ rule: r, n, labels, classify, open, onToggle, followTaken, onChange, onDelete }: {
    rule: ModelRule
    n: number
    labels: string[]
    classify: boolean
    open: boolean
    onToggle: () => void
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
    const forcedAsk = r.action === 'attachment' && ruleHazard(r.attachment_kind, r.attachment_action)

    return (
        <li className={cn(s.inset, s.ruleCard)} data-off={!r.enabled} data-open={open} aria-label={`Rule ${n}`}>
            <div className={s.ruleTop}>
                <button type="button" className={s.ruleOpen} onClick={onToggle}
                    aria-expanded={open} aria-controls={`${id}-edit`} title={sentenceOf(r)}>
                    <RuleSummary rule={r} />
                    <ChevronDown size={14} aria-hidden className={s.ruleChev} />
                </button>
                <label className={s.toggle} title={r.enabled ? 'On' : 'Off'}>
                    <input type="checkbox" checked={r.enabled} aria-label={`Rule ${n} on`}
                        onChange={e => onChange({ enabled: e.target.checked })} />
                </label>
            </div>

            {open && (
                <div id={`${id}-edit`} className={s.ruleEdit}>
                    <div className={s.ruleBlock}>
                        <span className={s.ruleBlockTag}>When</span>
                        <div className={s.ruleField}>
                            <label htmlFor={`${id}-label`} className={s.ruleFieldName}>Sees</label>
                            <select id={`${id}-label`} className={s.ruleSelect} value={labelValue}
                                onChange={e => onChange({ label: e.target.value })}>
                                {options.map(l => <option key={l} value={l}>{l}{l === labelValue && !known ? ' (not in this model)' : ''}</option>)}
                            </select>
                        </div>
                        <div className={s.ruleField}>
                            <label htmlFor={`${id}-score`} className={s.ruleFieldName}>Sure</label>
                            <input id={`${id}-score`} type="range" min={30} max={95} step={5}
                                value={Math.round(r.min_score * 100)} aria-valuetext={`${pct(r.min_score)} sure`}
                                className={s.ruleRange}
                                onChange={e => onChange({ min_score: Number(e.target.value) / 100 })} />
                            <span className={s.ruleValue}>{pct(r.min_score)}</span>
                        </div>
                        <div className={s.ruleField}>
                            <span className={s.ruleFieldName} id={`${id}-for`}>For</span>
                            <Segment label={`${id}-for`} values={FOR_S} value={r.for_s}
                                show={x => (x === 0 ? 'Now' : `${x} s`)} onPick={x => onChange({ for_s: x })} />
                        </div>
                    </div>

                    <div className={s.ruleBlock}>
                        <span className={s.ruleBlockTag}>Then</span>
                        <div className={s.actionTiles} role="radiogroup" aria-label={`Rule ${n}: what to do`}>
                            {ACTIONS.map(a => {
                                const I = ACTION_ICON[a]
                                const noBox = classify && needsBox(a)
                                const taken = a === 'follow' && followTaken && r.enabled && r.action !== 'follow'
                                const why = noBox ? 'This model answers with a name, not a box' : taken ? 'Another rule already follows' : undefined
                                return (
                                    <button key={a} type="button" role="radio" aria-checked={r.action === a}
                                        className={s.actionTile} data-moves={movesDrone(a)}
                                        disabled={!!why} title={why ?? ACTION_WORDS[a].hint}
                                        onClick={() => onChange({ action: a })}>
                                        <I size={17} aria-hidden />
                                        <span>{ACTION_WORDS[a].short}</span>
                                    </button>
                                )
                            })}
                        </div>
                        {r.action === 'attachment' && <AttachmentPicker id={id} rule={r} onChange={onChange} />}
                        <span className={s.factRow}>
                            {ACTION_FACTS[r.action].map(f => <span key={f} className={s.fact}>{f}</span>)}
                        </span>
                        {moves && (
                            <div className={s.movesRow}>
                                <label className={s.toggle} style={{ color: 'var(--cm-ink)' }}
                                    title={forcedAsk ? 'Always asks first: it can hurt someone' : undefined}>
                                    <input type="checkbox" checked={r.confirm || forcedAsk} disabled={forcedAsk}
                                        onChange={e => onChange({ confirm: e.target.checked })} />
                                    Ask me first
                                </label>
                                <span className={s.movesNote} title="Hover, Follow and Attachment rules only work after the pilot turns on Allow model control during the flight.">
                                    <ShieldCheck size={12} aria-hidden /> Pilot allows in flight
                                </span>
                            </div>
                        )}
                    </div>

                    <div className={s.ruleFoot}>
                        <span className={s.ruleFieldName} id={`${id}-cool`}>Again after</span>
                        <Segment label={`${id}-cool`} values={COOLDOWNS} value={r.cooldown_s}
                            show={seconds} onPick={x => onChange({ cooldown_s: x })} />
                        <button type="button" className={s.iconBtn} onClick={onDelete} style={{ marginLeft: 'auto' }}
                            aria-label={`Delete rule ${n}`} title="Delete rule">
                            <Trash2 size={14} aria-hidden />
                        </button>
                    </div>
                </div>
            )}
        </li>
    )
}

/** A small segmented picker; a saved value outside the presets stays shown. */
function Segment({ label, values, value, show, onPick }: {
    label: string
    values: number[]
    value: number
    show: (v: number) => string
    onPick: (v: number) => void
}) {
    const list = values.includes(value) ? values : [...values, value].sort((a, b) => a - b)
    return (
        <span className={cn(s.segment, s.ruleSegment)} role="group" aria-labelledby={label}>
            {list.map(v => (
                <button key={v} type="button" aria-pressed={v === value} onClick={() => onPick(v)}>{show(v)}</button>
            ))}
        </span>
    )
}

/** Which attachment and what it does: kind tiles, then the kind's actions;
 *  a sprayer adds its level. */
function AttachmentPicker({ id, rule: r, onChange }: {
    id: string
    rule: ModelRule
    onChange: (patch: Partial<ModelRule>) => void
}) {
    const kind: AttachmentKind = r.attachment_kind && KIND_META[r.attachment_kind] ? r.attachment_kind : 'release'
    const actions = ruleActionsFor(kind)
    const current = actions.find(a => a.id === r.attachment_action) ?? null
    const pick = (k: AttachmentKind) => {
        const first = ruleActionsFor(k)[0]
        onChange({ attachment_kind: k, attachment_action: first?.id })
    }
    return (
        <div className={s.attPick}>
            <div className={s.attKinds} role="radiogroup" aria-label="Which attachment">
                {KINDS.map(k => {
                    const I = KIND_META[k].icon
                    return (
                        <button key={k} type="button" role="radio" aria-checked={kind === k}
                            className={s.attKind} title={KIND_META[k].hint} onClick={() => pick(k)}>
                            <I size={15} aria-hidden />
                            <span>{KIND_META[k].word}</span>
                        </button>
                    )
                })}
            </div>
            <div className={s.ruleField}>
                <span className={s.ruleFieldName} id={`${id}-att`}>Does</span>
                <span className={cn(s.segment, s.ruleSegment)} role="group" aria-labelledby={`${id}-att`}>
                    {actions.map(a => (
                        <button key={a.id} type="button" aria-pressed={current?.id === a.id}
                            data-hazard={a.hazard} title={a.hazard ? 'Can hurt someone: always asks first' : undefined}
                            onClick={() => onChange({ attachment_action: a.id })}>{a.label}</button>
                    ))}
                </span>
            </div>
            {isLevel(current) && (
                <div className={s.ruleField}>
                    <label htmlFor={`${id}-lvl`} className={s.ruleFieldName}>Level</label>
                    <input id={`${id}-lvl`} type="range" min={0} max={100} step={5}
                        value={r.value ?? 50} aria-valuetext={`${r.value ?? 50}%`} className={s.ruleRange}
                        onChange={e => onChange({ value: Number(e.target.value) })} />
                    <span className={s.ruleValue}>{r.value ?? 50}%</span>
                </div>
            )}
        </div>
    )
}
