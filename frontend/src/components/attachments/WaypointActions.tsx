'use client'

// Mission editor, waypoint panel: "At this waypoint", up to 3 attachment
// actions as chips, added with a small picker (attachment -> action -> level
// for a sprayer). Stored on the waypoint as actions[] and uploaded with the
// mission. Uses the session drone's attachments; actions that can hurt
// someone are amber and need "Allow attachment actions" at upload.

import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import {
    KIND_META, MAX_WAYPOINT_ACTIONS, actionText, isLevel, useSessionAttachments,
    type Attachment, type WaypointAction,
} from '@/lib/attachments'
import a from './attachments.module.css'

/** Can this waypoint action hurt someone? Unknown attachments count as yes. */
export function waypointActionHazard(wa: WaypointAction, list: Attachment[]): boolean {
    const att = list.find(x => x.id === wa.attachment_id)
    const act = att?.actions.find(x => x.id === wa.action_id)
    return act ? act.hazard : true
}

export function WaypointActions({ actions, onChange }: {
    actions: WaypointAction[]
    onChange: (next: WaypointAction[]) => void
}) {
    const { droneId, attachments } = useSessionAttachments()
    const list = attachments.filter(x => x.enabled)
    const [picking, setPicking] = useState(false)
    const [attId, setAttId] = useState<string | null>(null)
    const [actId, setActId] = useState<string | null>(null)
    const [level, setLevel] = useState(50)

    const att = list.find(x => x.id === attId) ?? null
    const act = att?.actions.find(x => x.id === actId) ?? null
    const full = actions.length >= MAX_WAYPOINT_ACTIONS

    const close = () => { setPicking(false); setAttId(null); setActId(null); setLevel(50) }
    const add = () => {
        if (!att || !act || full) return
        onChange([...actions, { attachment_id: att.id, action_id: act.id, ...(isLevel(act) ? { value: level } : {}) }])
        close()
    }

    const label = (wa: WaypointAction) => {
        const x = attachments.find(t => t.id === wa.attachment_id)
        const y = x?.actions.find(t => t.id === wa.action_id)
        if (!x || !y) return { text: `Unknown attachment: ${wa.action_id}`, Icon: KIND_META.custom.icon }
        return { text: `${x.name}: ${actionText(y, isLevel(y) ? wa.value ?? 50 : null)}`, Icon: (KIND_META[x.kind] ?? KIND_META.custom).icon }
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
                <span className="text-[9px] font-mono tracking-wider font-bold" style={{ color: '#9ca3af' }}>
                    AT THIS WAYPOINT
                </span>
                {!picking && !full && list.length > 0 && (
                    <button type="button" onClick={() => setPicking(true)}
                        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9.5px] font-mono font-bold"
                        style={{ color: '#22d3ee', background: 'rgba(34,211,238,.08)', border: '1px solid rgba(34,211,238,.3)' }}>
                        <Plus size={11} aria-hidden /> Add
                    </button>
                )}
            </div>

            {actions.length > 0 && (
                <div className={a.wpChips}>
                    {actions.map((wa, i) => {
                        const { text, Icon } = label(wa)
                        return (
                            <div key={`${wa.attachment_id}-${wa.action_id}-${i}`} className={a.wpChip}
                                data-hazard={waypointActionHazard(wa, attachments)} title={text}>
                                <Icon size={12} aria-hidden />
                                <span>{text}</span>
                                <button type="button" className={a.wpX} aria-label={`Remove ${text}`}
                                    onClick={() => onChange(actions.filter((_, j) => j !== i))}>
                                    <X size={11} aria-hidden />
                                </button>
                            </div>
                        )
                    })}
                </div>
            )}

            {picking && (
                <div className={a.wpPick}>
                    <div className={a.wpGrid} role="group" aria-label="Which attachment">
                        {list.map(x => {
                            const I = (KIND_META[x.kind] ?? KIND_META.custom).icon
                            return (
                                <button key={x.id} type="button"
                                    aria-pressed={attId === x.id} className={a.wpBtn} title={x.name}
                                    onClick={() => { setAttId(x.id); setActId(x.actions[0]?.id ?? null) }}>
                                    <I size={12} aria-hidden /><span>{x.name}</span>
                                </button>
                            )
                        })}
                    </div>
                    {att && (
                        <div className={a.wpGrid} role="group" aria-label="What it does">
                            {att.actions.map(y => (
                                <button key={y.id} type="button" aria-pressed={actId === y.id} className={a.wpBtn}
                                    data-hazard={y.hazard} title={y.hazard ? 'Can hurt someone: needs Allow attachment actions at upload' : y.label}
                                    onClick={() => setActId(y.id)}>
                                    <span>{y.label}</span>
                                </button>
                            ))}
                        </div>
                    )}
                    {isLevel(act) && (
                        <div className="flex items-center gap-2">
                            <input type="range" min={0} max={100} step={5} value={level}
                                aria-label="Spray level" aria-valuetext={`${level}%`}
                                onChange={e => setLevel(Number(e.target.value))}
                                className="w-full h-1.5 rounded-full cursor-pointer" style={{ accentColor: '#fbbf24' }} />
                            <span className="text-[10px] font-mono font-bold tabular-nums w-9 text-right" style={{ color: '#fde68a' }}>{level}%</span>
                        </div>
                    )}
                    <div className="flex gap-1.5">
                        <button type="button" onClick={add} disabled={!att || !act}
                            className="flex-1 rounded-md py-1 text-[10px] font-mono font-bold disabled:opacity-30"
                            style={{ background: 'rgba(34,211,238,.15)', border: '1px solid rgba(34,211,238,.4)', color: '#67e8f9' }}>
                            {act ? `Add ${actionText(act, isLevel(act) ? level : null)}` : 'Pick an action'}
                        </button>
                        <button type="button" onClick={close}
                            className="rounded-md px-2 py-1 text-[10px] font-mono font-bold"
                            style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)', color: '#9ca3af' }}>
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {actions.length === 0 && !picking && (
                <p className={a.wpMuted}>
                    {!droneId ? 'Connect the drone to use its attachments here.'
                        : list.length === 0 ? 'This drone has no attachments. Add them in Config.'
                            : 'Nothing. Add a drop, light or spray here.'}
                </p>
            )}
            {full && <p className={a.wpMuted}>Up to {MAX_WAYPOINT_ACTIONS} per waypoint.</p>}
        </div>
    )
}
