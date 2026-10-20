'use client'

// Add or edit one attachment, in a slide-over:
//   kind tiles -> name -> wiring (Output 1-6 / Gripper / Winch) ->
//   positions (actuator only: a -1..1 slider per action; custom names its
//   2-4 states and flags the ones that can hurt someone) -> safety -> Save.

import { useState } from 'react'
import { Info, Loader, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    ACTUATOR_OUTPUTS, KINDS, KIND_META, QGC_HELP, STROBE_ACTION, WIRING_WORDS, cleanDraft, createAttachment,
    defaultWiring, draftFor, hasHazard, isLevel, newActionId, updateAttachment,
    type Attachment, type AttachmentAction, type AttachmentDraft, type AttachmentKind, type WiringType,
} from '@/lib/attachments'
import type { ApiProblem } from '@/lib/models'
import { Callout, Hint, SlideOver, css as s } from '@/components/models/ui'
import a from './attachments.module.css'

const MIN_STATES = 2
const MAX_STATES = 4

function draftOf(att: Attachment): AttachmentDraft {
    const { id: _id, ...rest } = att
    void _id
    return {
        ...rest,
        actions: rest.actions.map(x => ({ ...x })),
        limits: { ...rest.limits },
    }
}

function signed(v: number | undefined): string {
    const n = typeof v === 'number' ? v : 0
    return `${n > 0 ? '+' : ''}${n.toFixed(2)}`
}

export function AttachmentEditor({ open, droneId, initial, onClose, onSaved }: {
    open: boolean
    droneId: string
    /** null: add a new one. */
    initial: Attachment | null
    onClose: () => void
    onSaved: (att: Attachment) => void
}) {
    const [draft, setDraft] = useState<AttachmentDraft>(() => (initial ? draftOf(initial) : draftFor('release')))
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<ApiProblem | null>(null)
    const [touched, setTouched] = useState(false)
    const adding = !initial
    const meta = KIND_META[draft.kind] ?? KIND_META.custom
    const actuator = draft.wiring.type === 'actuator'

    const patch = (p: Partial<AttachmentDraft>) => { setDraft(d => ({ ...d, ...p })); setError(null) }
    const setAction = (id: string, p: Partial<AttachmentAction>) =>
        patch({ actions: draft.actions.map(x => (x.id === id ? { ...x, ...p } : x)) })

    const pickKind = (k: AttachmentKind) => {
        if (k === draft.kind) return
        const next = draftFor(k)
        // Keep a name the person typed; a default name follows the kind.
        const typed = draft.name.trim() && draft.name !== KIND_META[draft.kind].defaultName
        setDraft(typed ? { ...next, name: draft.name } : next)
        setError(null)
    }

    const pickWiring = (t: WiringType) => {
        if (t === draft.wiring.type) return
        patch({ wiring: defaultWiring(t) })
    }

    const hasStrobe = draft.actions.some(x => x.id === STROBE_ACTION.id)
    const toggleStrobe = () => patch({
        actions: hasStrobe ? draft.actions.filter(x => x.id !== STROBE_ACTION.id) : [...draft.actions, { ...STROBE_ACTION }],
    })

    const addState = () => {
        if (draft.actions.length >= MAX_STATES) return
        const id = newActionId(draft.actions.map(x => x.id))
        patch({ actions: [...draft.actions, { id, label: '', value: 0, hazard: true }] })
    }
    const removeState = (id: string) => {
        if (draft.actions.length <= MIN_STATES) return
        patch({ actions: draft.actions.filter(x => x.id !== id) })
    }

    // What stops a save, in plain words.
    const labels = draft.actions.map(x => x.label.trim().toLowerCase())
    const problem = !draft.name.trim() ? 'Give it a name.'
        : draft.kind === 'custom' && labels.some(l => !l) ? 'Name every state.'
            : draft.kind === 'custom' && new Set(labels).size !== labels.length ? 'Each state needs its own name.'
                : null

    const save = async () => {
        setTouched(true)
        if (problem) return
        setSaving(true)
        setError(null)
        const body = cleanDraft(draft)
        const r = initial ? await updateAttachment(droneId, initial.id, body) : await createAttachment(droneId, body)
        setSaving(false)
        if (!r.ok) { setError(r.error); return }
        onSaved(r.data)
    }

    const hazard = hasHazard(draft)
    const valueActions = draft.actions.filter(x => !isLevel(x))

    return (
        <SlideOver open={open} onOpenChange={o => { if (!o) onClose() }}
            title={adding ? 'Add attachment' : `Edit ${initial?.name ?? 'attachment'}`}
            foot={(
                <>
                    {touched && problem && <span className={s.fieldErr} role="alert">{problem}</span>}
                    <span className={s.spacer} />
                    <button type="button" className={cn(s.btn, s.ghost)} onClick={onClose}>Cancel</button>
                    <button type="button" className={cn(s.btn, s.primary)} onClick={() => void save()} disabled={saving}>
                        {saving && <Loader size={13} className="animate-spin motion-reduce:animate-none" aria-hidden />}
                        {adding ? 'Add attachment' : 'Save changes'}
                    </button>
                </>
            )}>
            {error && (
                <Callout tone="bad" title={error.message}>
                    <Hint text={error.hint ?? 'Nothing was saved. Check the fields and try again.'} />
                </Callout>
            )}

            {/* 1. what it is */}
            <section className={a.step} aria-labelledby="att-kind">
                <span className={s.label} id="att-kind">What is it</span>
                <div className={a.kinds} role="radiogroup" aria-labelledby="att-kind">
                    {KINDS.map(k => {
                        const I = KIND_META[k].icon
                        const locked = !adding && k !== draft.kind
                        if (locked) return null
                        return (
                            <button key={k} type="button" role="radio" aria-checked={draft.kind === k}
                                className={a.kind} data-hazard={KIND_META[k].actions.some(x => x.hazard)}
                                disabled={!adding} title={KIND_META[k].hint} onClick={() => pickKind(k)}>
                                <I size={18} aria-hidden />
                                <span>{KIND_META[k].word}</span>
                            </button>
                        )
                    })}
                </div>
                <span className={s.factRow}>
                    {draft.actions.map(x => (
                        <span key={x.id} className={s.fact} style={x.hazard ? { color: 'var(--cm-warn)' } : undefined}>
                            {x.label || 'unnamed'}{x.hazard ? ': can hurt' : ''}
                        </span>
                    ))}
                </span>
            </section>

            {/* 2. name */}
            <div className={s.field}>
                <label className={s.label} htmlFor="att-name">Name</label>
                <input id="att-name" className={s.input} value={draft.name} maxLength={40}
                    aria-invalid={touched && !draft.name.trim()}
                    onChange={e => patch({ name: e.target.value })} onBlur={() => setTouched(true)} />
            </div>

            {/* 3. wiring */}
            <section className={a.step} aria-labelledby="att-wire">
                <span className={s.label} id="att-wire">Wired to</span>
                <div className={a.wireRow}>
                    {meta.wirings.length > 1 && (
                        <span className={s.segment} role="group" aria-label="How the flight controller drives it">
                            {meta.wirings.map(t => (
                                <button key={t} type="button" aria-pressed={draft.wiring.type === t}
                                    title={WIRING_WORDS[t].hint} onClick={() => pickWiring(t)}>
                                    {WIRING_WORDS[t].label}
                                </button>
                            ))}
                        </span>
                    )}
                    {draft.wiring.type === 'actuator' && (
                        <span className={s.segment} role="group" aria-label="Output number">
                            {ACTUATOR_OUTPUTS.map(n => (
                                <button key={n} type="button" aria-pressed={draft.wiring.type === 'actuator' && draft.wiring.index === n}
                                    title={QGC_HELP(n)} onClick={() => patch({ wiring: { type: 'actuator', index: n } })}>
                                    {n}
                                </button>
                            ))}
                        </span>
                    )}
                </div>
                {draft.wiring.type === 'actuator' ? (
                    <span className={a.hint} title={QGC_HELP(draft.wiring.index)}>
                        <Info size={13} aria-hidden />
                        In QGroundControl: Peripheral via Actuator Set {draft.wiring.index}
                        <span className="sr-only">. {QGC_HELP(draft.wiring.index)}</span>
                    </span>
                ) : (
                    <span className={a.hint}>
                        <Info size={13} aria-hidden />
                        {WIRING_WORDS[draft.wiring.type].hint}
                    </span>
                )}
            </section>

            {/* 4. positions (actuator), or the custom states */}
            {draft.kind === 'custom' ? (
                <section className={a.step} aria-labelledby="att-states">
                    <div className={a.stepHead}>
                        <span className={s.label} id="att-states">States</span>
                        <span className={s.mono} style={{ fontSize: 10, color: 'var(--cm-ink-2)' }}>{draft.actions.length}/{MAX_STATES}</span>
                        {draft.actions.length < MAX_STATES && (
                            <button type="button" className={cn(s.btn, s.ghost)} style={{ marginLeft: 'auto', height: 26 }} onClick={addState}>
                                <Plus size={13} aria-hidden /> Add state
                            </button>
                        )}
                    </div>
                    {draft.actions.map((x, i) => (
                        <div key={x.id} className={cn(s.inset, a.stateBox)}>
                            <div className={a.stateRow}>
                                <input className={s.input} value={x.label} maxLength={24}
                                    aria-label={`State ${i + 1} name`} placeholder="e.g. Open"
                                    aria-invalid={touched && !x.label.trim()}
                                    onChange={e => setAction(x.id, { label: e.target.value })} />
                                <label className={s.toggle} title="Can hurt someone: it asks to confirm and only runs in flight"
                                    style={x.hazard ? { color: 'var(--cm-warn)' } : undefined}>
                                    <input type="checkbox" checked={x.hazard}
                                        onChange={e => setAction(x.id, { hazard: e.target.checked })} />
                                    Can hurt
                                </label>
                                <button type="button" className={s.iconBtn} onClick={() => removeState(x.id)}
                                    disabled={draft.actions.length <= MIN_STATES}
                                    aria-label={`Remove state ${x.label || i + 1}`} title="Remove state">
                                    <Trash2 size={14} aria-hidden />
                                </button>
                            </div>
                            <div className={a.stateRange}>
                                <input type="range" min={-1} max={1} step={0.05} value={x.value ?? 0}
                                    className={cn(a.range, !x.hazard && a.rangeCyan)}
                                    aria-label={`${x.label || `State ${i + 1}`} position`} aria-valuetext={signed(x.value)}
                                    onChange={e => setAction(x.id, { value: Number(e.target.value) })} />
                                <span className={a.value}>{signed(x.value)}</span>
                            </div>
                        </div>
                    ))}
                </section>
            ) : actuator && (
                <section className={a.step} aria-labelledby="att-pos">
                    <div className={a.stepHead}>
                        <span className={s.label} id="att-pos">Positions</span>
                        <span className={a.hint} title="The output value for each button: -1 is one end, +1 the other.">
                            <Info size={13} aria-hidden /> -1 to +1
                        </span>
                        {draft.kind === 'light' && (
                            <label className={s.toggle} style={{ marginLeft: 'auto' }}>
                                <input type="checkbox" checked={hasStrobe} onChange={toggleStrobe} />
                                Strobe
                            </label>
                        )}
                    </div>
                    <div className={a.values}>
                        {valueActions.map(x => (
                            <div key={x.id} className={a.valueRow}>
                                <span className={a.valueName} data-hazard={x.hazard}>{x.label}</span>
                                <input type="range" min={-1} max={1} step={0.05} value={x.value ?? 0}
                                    className={cn(a.range, !x.hazard && a.rangeCyan)}
                                    aria-label={`${x.label} position`} aria-valuetext={signed(x.value)}
                                    onChange={e => setAction(x.id, { value: Number(e.target.value) })} />
                                <span className={a.value}>{signed(x.value)}</span>
                            </div>
                        ))}
                    </div>
                    {draft.kind === 'sprayer' && (
                        <span className={s.factRow}>
                            <span className={s.fact}>Spray level: picked in flight</span>
                            <span className={s.fact}>0% = -1, 100% = +1</span>
                        </span>
                    )}
                </section>
            )}

            {/* 5. safety */}
            <section className={a.step} aria-labelledby="att-safe">
                <span className={s.label} id="att-safe">Safety</span>
                <div className={a.limitRow}>
                    <label htmlFor="att-minalt" title="Actions that can hurt someone are refused below this height.">
                        Lowest height to use it
                    </label>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <input id="att-minalt" type="number" min={0} max={500} step={0.5} className={cn(s.input, a.num)}
                            value={draft.limits.min_alt_m}
                            onChange={e => {
                                const v = Number(e.target.value)
                                if (Number.isFinite(v)) patch({ limits: { ...draft.limits, min_alt_m: Math.max(0, Math.min(500, v)) } })
                            }} />
                        <span className={s.muted}>m</span>
                    </span>
                </div>
                {hazard && (
                    <label className={a.limitRow} style={{ cursor: 'pointer' }}>
                        <span title="When an AI mode is running and sees a person below, actions that can hurt someone are refused.">
                            Refuse if the AI sees a person
                        </span>
                        <span className={s.toggle}>
                            <input type="checkbox" checked={draft.limits.people_check}
                                onChange={e => patch({ limits: { ...draft.limits, people_check: e.target.checked } })} />
                        </span>
                    </label>
                )}
                {!adding && (
                    <label className={a.limitRow} style={{ cursor: 'pointer' }}>
                        <span>Switched on</span>
                        <span className={s.toggle}>
                            <input type="checkbox" checked={draft.enabled} onChange={e => patch({ enabled: e.target.checked })} />
                        </span>
                    </label>
                )}
            </section>
        </SlideOver>
    )
}
