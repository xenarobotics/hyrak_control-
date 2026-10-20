'use client'

// Config > Attachments: what is fitted to the session's drone. One card per
// attachment (icon, name, kind and wiring chips, Test buttons per action,
// edit, delete with a named confirm). Owners and admins add and edit in a
// slide-over; everyone else reads. Test runs the real command on the bench:
// only while the drone is linked and disarmed.

import { useEffect, useState } from 'react'
import { Check, Loader, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDroneStore } from '@/store/drone'
import {
    ATTACHMENT_REASON, KINDS, KIND_META, MAX_ATTACHMENTS, actionText, attachmentReason, deleteAttachment, hasHazard,
    isLevel, testAttachment, updateAttachment, useAttachmentStore, useSessionAttachments, wiringLabel,
    type Attachment, type AttachmentAction,
} from '@/lib/attachments'
import type { ApiProblem } from '@/lib/models'
import { Callout, Hint, css as s, useCmClass } from '@/components/models/ui'
import { ActionButton } from './ActionButton'
import { AttachmentEditor } from './AttachmentEditor'
import a from './attachments.module.css'

/** A test at this level for a sprayer. */
const TEST_LEVEL = 50

type Editing = { att: Attachment | null; key: number } | null
type TestNote = { attId: string; ok: boolean; text: string; at: number }

export function AttachmentsSection() {
    const { root } = useCmClass()
    const { droneId, droneName, attachments, canManage, loading, error, loaded, reload } = useSessionAttachments()
    const setList = useAttachmentStore(s => s.setList)
    const linked = useDroneStore(s => s.telemetryStatus === 'connected')
    const armed = useDroneStore(s => s.telemetry?.flight_mode.is_armed ?? false)
    const [editing, setEditing] = useState<Editing>(null)
    const [asking, setAsking] = useState<string | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const [problem, setProblem] = useState<ApiProblem | null>(null)
    const [note, setNote] = useState<TestNote | null>(null)

    useEffect(() => {
        if (!note) return
        const id = setTimeout(() => setNote(n => (n === note ? null : n)), 6000)
        return () => clearTimeout(id)
    }, [note])

    if (!droneId) {
        return (
            <div className={cn(root, a.section)}>
                <div className={cn(s.inset, a.empty)}>
                    <KindIcons />
                    <strong style={{ color: 'var(--cm-ink)' }}>No drone connected</strong>
                    <span>Connect a drone to set up what is fitted to it.</span>
                </div>
            </div>
        )
    }

    const replace = (att: Attachment) => {
        const has = attachments.some(x => x.id === att.id)
        setList(droneId, has ? attachments.map(x => (x.id === att.id ? att : x)) : [...attachments, att])
    }

    const remove = async (att: Attachment) => {
        setBusy(att.id)
        setProblem(null)
        const r = await deleteAttachment(droneId, att.id)
        setBusy(null)
        if (!r.ok) { setProblem(r.error); return }
        setAsking(null)
        setList(droneId, attachments.filter(x => x.id !== att.id))
    }

    const toggle = async (att: Attachment, enabled: boolean) => {
        setProblem(null)
        replace({ ...att, enabled })
        const r = await updateAttachment(droneId, att.id, { enabled })
        if (!r.ok) { replace(att); setProblem(r.error); return }
        replace(r.data)
    }

    const test = async (att: Attachment, act: AttachmentAction) => {
        setBusy(`${att.id}:${act.id}`)
        const r = await testAttachment(droneId, att.id, act.id, isLevel(act) ? TEST_LEVEL : undefined)
        setBusy(null)
        if (!r.ok) { setNote({ attId: att.id, ok: false, text: r.error.message, at: Date.now() }); return }
        setNote({ attId: att.id, ok: r.data.ok, text: attachmentReason(r.data.reason_code, r.data.message), at: Date.now() })
    }

    const testWhy = (att: Attachment): string | null =>
        !linked ? ATTACHMENT_REASON.not_linked
            : armed ? ATTACHMENT_REASON.armed
                : !att.enabled ? 'Switch it on first.'
                    : null

    const full = attachments.length >= MAX_ATTACHMENTS

    return (
        <div className={cn(root, a.section)}>
            <div className={a.head}>
                <span className={s.label}>Fitted to</span>
                <span className={a.headDrone}>{droneName ?? droneId}</span>
                {attachments.length > 0 && <span className={s.mono} style={{ fontSize: 12, color: 'var(--cm-ink-2)' }}>{attachments.length}/{MAX_ATTACHMENTS}</span>}
                {loading && <Loader size={12} className="animate-spin motion-reduce:animate-none" aria-label="Loading" />}
                {!canManage && loaded && !error && <span className={cn(s.chip, s.chipMute)} title="Only a workspace owner or admin can change attachments.">View only</span>}
                {canManage && attachments.length > 0 && (
                    <button type="button" className={cn(s.btn, s.primary)} style={{ marginLeft: 'auto' }}
                        disabled={full} title={full ? `Up to ${MAX_ATTACHMENTS} per drone` : undefined}
                        onClick={() => setEditing({ att: null, key: Date.now() })}>
                        <Plus size={13} aria-hidden /> Add attachment
                    </button>
                )}
            </div>

            {error && (
                <Callout tone="bad" title={error.message}
                    actions={<button type="button" className={s.btn} onClick={reload}>Try again</button>}>
                    <Hint text={error.hint} />
                </Callout>
            )}
            {problem && (
                <Callout tone="bad" title={problem.message}>
                    <Hint text={problem.hint ?? 'Nothing was changed. Try again.'} />
                </Callout>
            )}

            {!loaded && loading ? (
                <div className={s.skel} style={{ height: 72 }} aria-hidden />
            ) : !error && attachments.length === 0 ? (
                <div className={cn(s.inset, a.empty)}>
                    <KindIcons />
                    <span>{canManage ? 'Nothing fitted yet. Add a drop hook, gripper, light and more.' : 'Nothing fitted to this drone.'}</span>
                    {canManage && (
                        <button type="button" className={cn(s.btn, s.primary)} onClick={() => setEditing({ att: null, key: Date.now() })}>
                            <Plus size={13} aria-hidden /> Add attachment
                        </button>
                    )}
                </div>
            ) : (
                <ul className={a.list}>
                    {attachments.map(att => {
                        const meta = KIND_META[att.kind] ?? KIND_META.custom
                        const Icon = meta.icon
                        const hz = hasHazard(att)
                        const why = testWhy(att)
                        const myNote = note?.attId === att.id ? note : null
                        return (
                            <li key={att.id} className={a.card} data-off={!att.enabled}>
                                <span className={a.tile} data-hazard={hz} aria-hidden><Icon size={18} /></span>
                                <div className={a.main}>
                                    <span className={a.name} title={att.name}>{att.name}</span>
                                    <span className={a.chips}>
                                        <span className={cn(s.chip, s.chipMute)}>{meta.word}</span>
                                        <span className={cn(s.chip, s.chipInfo)}
                                            title={att.wiring.type === 'actuator' ? `Actuator Set ${att.wiring.index}` : undefined}>
                                            {wiringLabel(att.wiring)}
                                        </span>
                                        {hz && (
                                            <span className={cn(s.chip, s.chipWarn)}
                                                title={`Asks to confirm, only in flight${att.limits.min_alt_m > 0 ? `, above ${att.limits.min_alt_m} m` : ''}${att.limits.people_check ? ', not over people the AI sees' : ''}`}>
                                                <TriangleAlert size={10} aria-hidden /> Can hurt
                                            </span>
                                        )}
                                        {att.limits.min_alt_m > 0 && <span className={cn(s.chip, s.chipMute)} title="Lowest height to use it">{att.limits.min_alt_m} m+</span>}
                                        {!att.enabled && <span className={cn(s.chip, s.chipMute)}>Off</span>}
                                    </span>
                                </div>
                                {canManage && (
                                    <div className={a.tools}>
                                        <label className={s.toggle} title={att.enabled ? 'On: shows on Fly, Command and in missions' : 'Off: hidden everywhere'}>
                                            <input type="checkbox" checked={att.enabled} aria-label={`${att.name} on`}
                                                onChange={e => void toggle(att, e.target.checked)} />
                                        </label>
                                        <button type="button" className={s.iconBtn} aria-label={`Edit ${att.name}`} title="Edit"
                                            onClick={() => setEditing({ att, key: Date.now() })}>
                                            <Pencil size={14} aria-hidden />
                                        </button>
                                        <button type="button" className={s.iconBtn} aria-label={`Delete ${att.name}`} title="Delete"
                                            onClick={() => setAsking(att.id)}>
                                            <Trash2 size={14} aria-hidden />
                                        </button>
                                    </div>
                                )}
                                {canManage && (
                                    <div className={a.testRow}>
                                        <span className={a.testTag} title="Runs the real command on the bench. The drone must be connected and disarmed.">Test</span>
                                        {att.actions.map(act => (
                                            <ActionButton key={act.id} hazard={act.hazard}
                                                label={busy === `${att.id}:${act.id}` ? 'Testing' : actionText(act, isLevel(act) ? TEST_LEVEL : null)}
                                                title={`Test ${act.label}${isLevel(act) ? ` at ${TEST_LEVEL}%` : ''} on the bench${act.hazard ? '. Press twice.' : ''}`}
                                                disabledReason={why ?? (busy ? 'Waiting for the last test' : null)}
                                                onFire={() => void test(att, act)} />
                                        ))}
                                        {myNote && (
                                            <span className={cn(s.chip, myNote.ok ? s.chipOk : s.chipWarn, s.whyChip)} role="status" title={myNote.text}
                                                style={{ maxWidth: 260 }}>
                                                {myNote.ok ? <Check size={11} aria-hidden /> : <TriangleAlert size={11} aria-hidden />}
                                                {myNote.text}
                                            </span>
                                        )}
                                    </div>
                                )}
                                {asking === att.id && (
                                    <div className={cn(s.confirm, a.confirmRow)} role="alertdialog" aria-label={`Delete ${att.name}?`}>
                                        <span>Delete <strong>{att.name}</strong>? Its buttons go from Fly, Command and missions.</span>
                                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                            <button type="button" className={cn(s.btn, s.danger)} disabled={busy === att.id}
                                                onClick={() => void remove(att)}>
                                                {busy === att.id && <Loader size={13} className="animate-spin motion-reduce:animate-none" aria-hidden />}
                                                Delete {att.name}
                                            </button>
                                            <button type="button" className={s.btn} onClick={() => setAsking(null)}>Keep it</button>
                                        </div>
                                    </div>
                                )}
                            </li>
                        )
                    })}
                </ul>
            )}

            {editing && (
                <AttachmentEditor key={editing.key} open droneId={droneId} initial={editing.att}
                    onClose={() => setEditing(null)}
                    onSaved={att => { replace(att); setEditing(null) }} />
            )}
        </div>
    )
}

function KindIcons() {
    return (
        <span className={a.emptyIcons} aria-hidden>
            {KINDS.map(k => { const I = KIND_META[k].icon; return <I key={k} size={17} /> })}
        </span>
    )
}
