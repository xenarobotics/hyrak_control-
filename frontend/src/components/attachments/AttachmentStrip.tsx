'use client'

// The attachment buttons for Fly and Command: one small group per switched-on
// attachment of the session's drone (icon, name, the last command as a dot),
// then its actions. Hazard actions take two presses. The sprayer's Spray
// opens a level slider. Hidden when the drone has no attachments, and for
// viewers (no fly permission). The server runs every guard again.

import { useState, type ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import { cn } from '@/lib/utils'
import { useDroneStore } from '@/store/drone'
import { useLiveScope } from '@/hooks/useLiveScope'
import {
    ATTACHMENT_REASON, KIND_META, actionText, hasHazard, isLevel, sendAttachmentAction,
    useAttachmentStore, useSessionAttachments, type Attachment, type AttachmentAction,
} from '@/lib/attachments'
import { useCmClass } from '@/components/models/ui'
import { ActionButton } from './ActionButton'
import a from './attachments.module.css'

export function AttachmentStrip({ variant = 'panel', frame }: {
    variant?: 'panel' | 'rail'
    /** Wraps the strip (a titled card); not called when there is nothing to show. */
    frame?: (strip: ReactNode) => ReactNode
}) {
    const { root } = useCmClass()
    const { attachments } = useSessionAttachments()
    const { viewOnly } = useLiveScope()
    const linked = useDroneStore(s => s.telemetryStatus === 'connected')
    const inAir = useDroneStore(s => s.telemetry?.flight_mode.is_in_air ?? false)
    const takeover = useDroneStore(s => s.takeover ?? s.session?.takeover ?? null)
    const staff = useDroneStore(s => !!s.session?.staff)

    const on = attachments.filter(x => x.enabled)
    if (viewOnly || on.length === 0) return null

    const why = (act: AttachmentAction): string | null => {
        if (!linked) return ATTACHMENT_REASON.no_link
        if (takeover && !staff) return ATTACHMENT_REASON.taken_over
        if (act.hazard && !inAir) return ATTACHMENT_REASON.not_flying
        return null
    }

    const strip = (
        <div className={cn(root, a.strip, variant === 'rail' && a.rail)} role="group" aria-label="Attachments">
            {on.map(att => <Group key={att.id} att={att} why={why} rail={variant === 'rail'} root={root} />)}
        </div>
    )
    return <>{frame ? frame(strip) : strip}</>
}

function Group({ att, why, rail, root }: {
    att: Attachment
    why: (act: AttachmentAction) => string | null
    rail: boolean
    root: string
}) {
    const meta = KIND_META[att.kind] ?? KIND_META.custom
    const Icon = meta.icon
    const last = useAttachmentStore(s => s.last[att.id])
    const lastAct = last?.last_action_id ? att.actions.find(x => x.id === last.last_action_id) : null
    const ago = last?.last_at ? Math.max(0, Math.round(Date.now() / 1000 - last.last_at)) : null
    const lastTip = lastAct
        ? `Last command: ${lastAct.label}${ago != null ? `, ${ago < 60 ? `${ago} s` : `${Math.round(ago / 60)} min`} ago` : ''}${last?.ok === false ? ' (not done)' : ''}. There is no feedback from the attachment itself.`
        : null

    return (
        <div className={a.group}>
            <span className={a.groupHead} title={`${att.name}${lastTip ? `\n${lastTip}` : ''}`}>
                <Icon size={rail ? 12 : 14} className={a.groupIcon} data-hazard={hasHazard(att)} aria-hidden />
                <span>{att.name}</span>
                {lastAct && (
                    <span className={a.last} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span className={a.dot} data-ok={last?.ok !== false} aria-hidden />
                        {!rail && <span style={{ fontSize: 12 }}>{lastAct.label}</span>}
                        <span className="sr-only">{lastTip}</span>
                    </span>
                )}
            </span>
            {att.actions.map(act => isLevel(act)
                ? <SprayLevel key={act.id} att={att} act={act} why={why(act)} root={root} rail={rail} />
                : (
                    <ActionButton key={act.id} hazard={act.hazard} label={act.label}
                        armedLabel={rail ? 'Again' : 'Press again'}
                        title={`${att.name}: ${act.label}${act.hazard ? '. Can hurt someone: press twice.' : ''}`}
                        disabledReason={why(act)}
                        onFire={confirm => sendAttachmentAction({ attachment_id: att.id, action_id: act.id, ...(confirm ? { confirm: true } : {}) })} />
                ))}
        </div>
    )
}

const QUICK = [25, 50, 100]

/** Spray: a button that opens the level slider; Spray N% inside takes two presses. */
function SprayLevel({ att, act, why, root, rail }: {
    att: Attachment
    act: AttachmentAction
    why: string | null
    root: string
    rail: boolean
}) {
    const [open, setOpen] = useState(false)
    const [level, setLevel] = useState(50)
    const trigger = (
        <Popover.Trigger className={a.act} data-hazard={act.hazard} disabled={!!why}
            title={why ? undefined : `${att.name}: pick a level`}>
            <span>{act.label}</span>
        </Popover.Trigger>
    )
    return (
        <Popover.Root open={open} onOpenChange={o => setOpen(o)}>
            {why ? <span title={why} className={a.tipWrap}>{trigger}</span> : trigger}
            <Popover.Portal>
                <Popover.Positioner side={rail ? 'right' : 'bottom'} sideOffset={8} style={{ zIndex: 3000 }}>
                    <Popover.Popup className={cn(root, a.pop)} aria-label={`${att.name}: spray level`}>
                        <div className={a.popRow}>
                            <input type="range" min={0} max={100} step={5} value={level}
                                className={a.range} aria-label="Spray level" aria-valuetext={`${level}%`}
                                onChange={e => setLevel(Number(e.target.value))} />
                            <span className={a.value}>{level}%</span>
                        </div>
                        <div className={a.levels}>
                            {QUICK.map(q => (
                                <button key={q} type="button" className={a.act} aria-pressed={level === q}
                                    onClick={() => setLevel(q)}>{q}%</button>
                            ))}
                        </div>
                        <ActionButton hazard={act.hazard} label={actionText(act, level)}
                            title={`${att.name}: spray at ${level}%`}
                            disabledReason={why}
                            onFire={confirm => {
                                sendAttachmentAction({
                                    attachment_id: att.id, action_id: act.id, value: level, ...(confirm ? { confirm: true } : {}),
                                })
                                setOpen(false)
                            }} />
                    </Popover.Popup>
                </Popover.Positioner>
            </Popover.Portal>
        </Popover.Root>
    )
}
