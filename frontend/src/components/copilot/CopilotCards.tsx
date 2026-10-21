'use client'

// Plan cards (confirm) and target cards (choose) in the Copilot conversation.
// Confirm is amber when the plan moves the drone (docs/DESIGN_SYSTEM.md 11);
// candidates are numbered the same as the boxes drawn over the video.

import { useEffect, useState } from 'react'
import { Check, X, Navigation, Crosshair, MapPinned, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUS } from '@/components/controls/flightStyles'
import {
    useCopilotStore, confirmCard, chooseCandidate, toMs, type CopilotCard, type CardStatus,
} from '@/lib/copilot'

/** Seconds left on a card, ticking. */
function useSecondsLeft(expiresAt: number, live: boolean): number {
    const end = toMs(expiresAt)
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        if (!live) return
        const t = setInterval(() => setNow(Date.now()), 250)
        return () => clearInterval(t)
    }, [live])
    return Math.max(0, (end - now) / 1000)
}

const STATUS_TEXT: Record<CardStatus, string> = {
    accepted: 'Confirmed', declined: 'Cancelled', expired: 'Expired', done: 'Done', refused: 'Refused',
}
const STATUS_TONE: Record<CardStatus, string> = {
    accepted: 'text-app-ok', declined: 'text-app-text-muted', expired: 'text-app-text-muted',
    done: 'text-app-ok', refused: 'text-app-danger',
}

function Countdown({ left, total }: { left: number; total: number }) {
    const pct = Math.max(0, Math.min(1, left / total))
    return (
        <div className="flex items-center gap-2">
            <div aria-hidden className="flex-1 h-1 rounded-full bg-app-surface-2 overflow-hidden">
                <div className={cn('h-full rounded-full transition-[width] duration-[250ms] ease-linear motion-reduce:transition-none',
                    left <= 5 ? 'bg-app-warn' : 'bg-app-text-subtle')} style={{ width: `${pct * 100}%` }} />
            </div>
            <span className="text-[12px] font-semibold tabular-nums text-app-text-muted min-w-[26px] text-right whitespace-nowrap">{Math.ceil(left)} s</span>
        </div>
    )
}

function StatusLine({ status, message }: { status: CardStatus; message?: string }) {
    return (
        <p className="text-[13px]">
            <span className={cn('font-bold', STATUS_TONE[status])}>{STATUS_TEXT[status]}</span>
            {message ? <span className="text-app-text-muted">. {message}</span> : null}
        </p>
    )
}

function PreviewToggle() {
    const on = useCopilotStore(s => s.showPreview)
    const set = useCopilotStore(s => s.setShowPreview)
    return (
        <button onClick={() => set(!on)} aria-pressed={on} title="Draw the planned route on the Command map"
            className={cn('h-8 px-2.5 rounded-md border flex items-center gap-1.5 text-[12px] font-semibold transition-colors duration-[140ms]', FOCUS,
                on ? 'border-app-magenta bg-app-magenta-soft text-app-text' : 'border-app-border-strong text-app-text-muted hover:text-app-text')}>
            <MapPinned size={14} className={on ? 'text-app-magenta' : undefined} />
            Show on map
        </button>
    )
}

export function CopilotCardView({ card }: { card: CopilotCard }) {
    const final = useCopilotStore(s => s.cardStatus[card.token])
    const answered = useCopilotStore(s => s.answered[card.token])
    const enabled = useCopilotStore(s => s.enabled)
    // Cards last 15 s (contract); the bar is drawn against that.
    const total = 15
    const leftRaw = useSecondsLeft(card.expires_at, !final)
    const answeredHere = answered !== undefined
    // Past expiry with an answer in flight: the server decides, wait for it.
    const late = !final && leftRaw <= 0 && answeredHere
    const expired = !final && leftRaw <= 0 && !answeredHere
    const open = !final && leftRaw > 0
    const waiting = open && answeredHere
    const canAct = open && !waiting && enabled
    const hasPreview = !!(card.preview && (card.preview.waypoints?.length || card.preview.area))
    const Icon = card.kind === 'choose' ? Crosshair : card.moves ? Navigation : Info

    return (
        <div className={cn('rounded-[10px] border p-3 flex flex-col gap-2.5 bg-app-surface transition-colors duration-[140ms]',
            !open ? 'border-app-border' : card.moves ? 'border-app-warn' : 'border-app-border-strong')}>
            <div className="flex items-start gap-2">
                <Icon size={16} className={cn('shrink-0 mt-0.5', card.kind === 'choose' ? 'text-app-magenta' : card.moves ? 'text-app-warn' : 'text-app-text-muted')} />
                <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-bold text-app-text leading-snug">{card.title}</p>
                    {card.moves && open && <p className="text-[12px] font-semibold text-app-warn">Moves the drone</p>}
                </div>
            </div>
            {card.lines?.length > 0 && (
                <ul className="flex flex-col gap-1 text-[13px] text-app-text-muted">
                    {card.lines.map((l, i) => <li key={i} className="leading-snug">{l}</li>)}
                </ul>
            )}

            {card.kind === 'choose' && (card.candidates?.length ?? 0) > 0 && (
                <div className="flex flex-wrap gap-2" role="group" aria-label="Which target">
                    {card.candidates!.map(c => {
                        const picked = answered === c.index
                        return (
                            <button key={c.index} disabled={!canAct} onClick={() => chooseCandidate(card.token, c.index)}
                                title={`Choose number ${c.index}`}
                                className={cn('h-11 pl-1.5 pr-3 rounded-[10px] border flex items-center gap-2 max-w-full transition-colors duration-[140ms] active:scale-[.98]', FOCUS,
                                    'disabled:cursor-not-allowed',
                                    picked ? 'border-app-accent bg-app-accent-soft'
                                        : 'border-app-border-strong hover:border-app-accent hover:bg-app-surface-2 disabled:hover:bg-transparent disabled:hover:border-app-border-strong')}>
                                <span className="size-8 shrink-0 rounded-md flex items-center justify-center bg-app-accent text-[var(--app-accent-ink)] text-[17px] font-extrabold tabular-nums">
                                    {c.index}</span>
                                <span className="min-w-0 text-left">
                                    <span className="block text-[13px] font-semibold text-app-text truncate">{c.label}</span>
                                    {Number.isFinite(c.score) && (
                                        <span className="block text-[12px] text-app-text-muted tabular-nums">{Math.round(c.score * 100)}% match</span>
                                    )}
                                </span>
                            </button>
                        )
                    })}
                </div>
            )}

            {hasPreview && open && <div><PreviewToggle /></div>}

            {open && <Countdown left={leftRaw} total={total} />}

            {open && (
                <div className="flex gap-2">
                    {card.kind === 'confirm' && (
                        <button disabled={!canAct} onClick={() => confirmCard(card.token, true)}
                            className={cn('flex-1 h-10 rounded-md flex items-center justify-center gap-1.5 text-[14px] font-bold transition-[filter,transform] duration-[140ms] active:scale-[.98] hover:brightness-110', FOCUS,
                                'disabled:cursor-not-allowed disabled:hover:brightness-100 disabled:bg-app-surface-2 disabled:text-app-text-subtle disabled:border disabled:border-app-border',
                                card.moves ? 'border border-app-warn bg-app-warn-soft text-app-warn hover:bg-[color-mix(in_srgb,var(--app-warn)_24%,transparent)] hover:brightness-100'
                                    : 'bg-app-accent text-[var(--app-accent-ink)]')}>
                            <Check size={16} /> {waiting && answered === 'accept' ? 'Confirming' : 'Confirm'}
                        </button>
                    )}
                    <button disabled={!canAct} onClick={() => confirmCard(card.token, false)}
                        className={cn('h-10 px-4 rounded-md border border-app-border-strong flex items-center justify-center gap-1.5 text-[14px] font-semibold text-app-text hover:bg-app-surface-2 transition-colors duration-[140ms] active:scale-[.98]', FOCUS,
                            card.kind === 'choose' && 'flex-1',
                            'disabled:cursor-not-allowed disabled:text-app-text-subtle disabled:border-app-border disabled:hover:bg-transparent')}>
                        <X size={16} /> Cancel
                    </button>
                </div>
            )}
            {open && canAct && (
                <p className="text-[12px] text-app-text-muted">
                    {card.kind === 'choose' ? 'Or say "number two".' : 'Or say "confirm" or "cancel".'}</p>
            )}

            {final && <StatusLine status={final.status} message={final.message} />}
            {late && <p className="text-[13px] text-app-text-muted">Waiting for HYRAK</p>}
            {expired && <StatusLine status="expired" message="Nothing was sent to the drone" />}
        </div>
    )
}
