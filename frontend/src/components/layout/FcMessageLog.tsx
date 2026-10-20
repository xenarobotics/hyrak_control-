'use client'

// The autopilot's message log - what QGroundControl's vehicle-messages panel
// shows, and the single biggest reason a problem is diagnosable there.
//
// PX4 narrates itself constantly: preflight check results, EKF and GPS state
// transitions, failsafe entry and exit, calibration complaints, arming
// refusals with their exact cause. All of it arrives on the telemetry link.
//
// WHY THIS IS A MODAL AND NOT A POPOVER. The first version anchored a panel to
// its own button, which put it inside whatever container the button lived in -
// a status bar with overflow-x: auto, and on the Fly tab a collapsible
// right-hand column with overflow-y: auto. Both CLIP an absolutely positioned
// child, so the panel either scrolled the bar sideways until nothing was
// legible or simply never appeared. A log you open when something has gone
// wrong cannot be at the mercy of the layout of whatever is around the button,
// so it renders to document.body through a portal and owns the screen -
// exactly like the mission pre-flight confirmation.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDroneStore } from '@/store/drone'
import { ScrollText, X, Trash2, ChevronDown, AlertTriangle } from 'lucide-react'
import { useHydrated } from '@/hooks/useClientValue'

/** MAVSDK's StatusTextType ascends with severity - 0 DEBUG … 7 EMERGENCY -
 *  unlike MAVLink's own SEVERITY enum, which descends. Reading it the wrong
 *  way round would paint every routine line red and every emergency grey. */
const SEVERITY_COLOR = (rank: number): string =>
    rank >= 4 ? 'var(--app-danger)'      // ERROR / CRITICAL / ALERT / EMERGENCY
        : rank === 3 ? 'var(--app-warn)'     // WARNING
            : rank === 2 ? 'var(--app-accent)'   // NOTICE
                : 'hsl(var(--app-text-muted))'

/** The same scale for the trigger drawn over video: fixed overlay colours,
 *  identical in both themes (design system 9). */
const OVERLAY_SEVERITY_COLOR = (rank: number): string =>
    rank >= 4 ? 'var(--overlay-danger)'
        : rank === 3 ? 'var(--overlay-warn)'
            : rank === 2 ? 'var(--overlay-accent)'
                : 'var(--overlay-muted)'

const tint = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`

function timeOf(ts: number): string {
    return new Date(ts * 1000).toLocaleTimeString([], { hour12: false })
}

/** Where the trigger is being placed. The two hosts have nothing in common
 *  visually, and one shared button that suited neither is what buried this on
 *  the Fly tab in the first place. */
type Variant = 'bar' | 'floating'

export function FcMessageLog({ variant = 'bar' }: { variant?: Variant }) {
    const fcMessages = useDroneStore(s => s.fcMessages)
    const fcUnread = useDroneStore(s => s.fcUnread)
    const clearFcMessages = useDroneStore(s => s.clearFcMessages)
    const markFcRead = useDroneStore(s => s.markFcRead)
    const [open, setOpen] = useState(false)
    const mounted = useHydrated()

    const worst = fcMessages.reduce((a, m) => Math.max(a, m.rank), 0)
    const color = fcUnread > 0 ? SEVERITY_COLOR(worst) : undefined
    const overlayColor = fcUnread > 0 ? OVERLAY_SEVERITY_COLOR(worst) : undefined

    const trigger = variant === 'floating' ? (
        <button
            onClick={() => setOpen(true)}
            title="Messages from the drone - preflight results, warnings, failsafes"
            className="flex min-h-8 items-center gap-1.5 px-2.5 py-1 rounded-md border text-[12px] font-bold transition-colors"
            style={{
                background: 'var(--overlay-scrim)',
                borderColor: overlayColor ?? 'var(--overlay-border)',
                color: overlayColor ?? 'var(--overlay-text)',
            }}
        >
            <ScrollText size={14} />
            Messages
            {fcUnread > 0 && (
                <span style={{
                    minWidth: 18, height: 18, padding: '0 4px', borderRadius: 999,
                    background: overlayColor, color: '#0b0b0d', fontSize: 12, fontWeight: 800,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}>
                    {fcUnread > 99 ? '99+' : fcUnread}
                </span>
            )}
        </button>
    ) : (
        // ICON ONLY in the status bar. That bar scrolls horizontally once its
        // contents outgrow it, and a labelled button with a badge was enough to
        // push the controls off the end - the log made the bar unreadable,
        // which is the opposite of the point.
        <button
            onClick={() => setOpen(true)}
            title={`Drone messages${fcUnread > 0 ? ` - ${fcUnread} new` : ''}`}
            aria-label={`Drone messages${fcUnread > 0 ? `, ${fcUnread} new` : ''}`}
            style={{
                position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, borderRadius: 6, flexShrink: 0,
                background: color ? tint(color, 12) : 'transparent',
                border: `1px solid ${color ?? 'hsl(var(--app-border-strong))'}`,
                color: color ?? 'hsl(var(--app-text-muted))', cursor: 'pointer',
            }}
        >
            <ScrollText size={16} />
            {fcUnread > 0 && (
                <span style={{
                    position: 'absolute', top: -6, right: -6,
                    minWidth: 18, height: 18, padding: '0 4px', borderRadius: 999,
                    background: color, color: 'hsl(var(--app-surface))', fontSize: 12, fontWeight: 800,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                    {fcUnread > 9 ? '9+' : fcUnread}
                </span>
            )}
        </button>
    )

    return (
        <>
            {trigger}
            {mounted && open && createPortal(
                <MessageWindow
                    onClose={() => setOpen(false)}
                    onClear={clearFcMessages}
                    onRead={markFcRead}
                />,
                document.body,
            )}
        </>
    )
}

function MessageWindow({ onClose, onClear, onRead }: {
    onClose: () => void; onClear: () => void; onRead: () => void
}) {
    const fcMessages = useDroneStore(s => s.fcMessages)
    const [minSeverity, setMinSeverity] = useState(0)
    const bodyRef = useRef<HTMLDivElement | null>(null)
    const pinnedToBottom = useRef(true)
    const [atBottom, setAtBottom] = useState(true)

    const shown = fcMessages.filter(m => m.rank >= minSeverity)

    useEffect(() => { onRead() }, [onRead, fcMessages.length])

    // Follow the tail, but only while the operator is already at the tail.
    // Yanking the view back down while someone reads an earlier line is what
    // makes a live log unusable during the incident it exists for.
    useEffect(() => {
        if (!pinnedToBottom.current) return
        const el = bodyRef.current
        if (el) el.scrollTop = el.scrollHeight
    }, [shown.length])

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    return (
        <div
            // Same shape as the mission pre-flight confirmation: full-screen
            // scrim, centred card, click-outside to dismiss.
            className="fixed inset-0 z-[4000] flex items-center justify-center p-4"
            style={{ background: 'rgba(0,0,0,.6)' }}
            onClick={onClose}
        >
            <div
                onClick={e => e.stopPropagation()}
                role="dialog" aria-modal="true" aria-label="Drone messages"
                className="rounded-[14px] border overflow-hidden flex flex-col"
                style={{
                    background: 'hsl(var(--app-raised))', boxShadow: 'var(--app-shadow)',
                    borderColor: 'hsl(var(--app-border))',
                    width: 'min(760px, 100%)', height: 'min(520px, 85vh)',
                }}
            >
                <div
                    className="flex items-center gap-2.5 px-4 py-3 border-b flex-shrink-0"
                    style={{ borderColor: 'hsl(var(--app-border))', background: 'hsl(var(--app-surface))' }}
                >
                    <ScrollText size={18} style={{ color: 'var(--app-accent)' }} />
                    <h2 className="m-0 text-[18px] font-bold text-app-text">
                        Drone messages
                    </h2>
                    <span className="text-[13px] font-mono text-app-text-muted">
                        {shown.length}{minSeverity > 0 ? ` of ${fcMessages.length}` : ''}
                    </span>

                    <select
                        value={minSeverity}
                        onChange={e => setMinSeverity(Number(e.target.value))}
                        title="Hide routine chatter"
                        aria-label="Show messages from this severity up"
                        className="ml-auto h-8 text-[13px] rounded-md px-2"
                        style={{
                            background: 'hsl(var(--app-surface-2))',
                            border: '1px solid hsl(var(--app-border-strong))', color: 'hsl(var(--app-text))',
                        }}
                    >
                        <option value={0}>All</option>
                        <option value={2}>Notice +</option>
                        <option value={3}>Warnings +</option>
                        <option value={4}>Errors only</option>
                    </select>

                    <button
                        onClick={onClear}
                        title="Clear the log"
                        aria-label="Clear the log"
                        className="flex size-8 items-center justify-center rounded-md"
                        style={{ border: '1px solid hsl(var(--app-border-strong))', color: 'hsl(var(--app-text-muted))' }}
                    >
                        <Trash2 size={16} />
                    </button>
                    <button
                        onClick={onClose}
                        title="Close (Esc)"
                        aria-label="Close"
                        className="flex size-8 items-center justify-center rounded-md"
                        style={{ border: '1px solid hsl(var(--app-border-strong))', color: 'hsl(var(--app-text-muted))' }}
                    >
                        <X size={16} />
                    </button>
                </div>

                <div
                    ref={bodyRef}
                    onScroll={e => {
                        const el = e.currentTarget
                        const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
                        pinnedToBottom.current = bottom
                        setAtBottom(bottom)
                    }}
                    className="flex-1 overflow-y-auto py-1.5"
                >
                    {shown.length === 0 ? (
                        <div className="flex flex-col items-center gap-2 px-8 py-12 text-center">
                            <AlertTriangle size={24} style={{ color: 'hsl(var(--app-text-muted))' }} />
                            <p className="text-[14px] leading-relaxed max-w-[52ch]" style={{ color: 'hsl(var(--app-text-muted))' }}>
                                {fcMessages.length === 0
                                    ? 'Nothing from the drone yet. Preflight results, failsafes and the reason for any refused command show up here.'
                                    : 'Nothing at this severity. Lower the filter to see the rest.'}
                            </p>
                        </div>
                    ) : shown.map(m => (
                        <div
                            key={m.id}
                            className="flex gap-3 px-4 py-1 text-[13px] font-mono leading-relaxed items-baseline"
                        >
                            <span style={{ color: 'hsl(var(--app-text-muted))', flexShrink: 0 }}>{timeOf(m.ts)}</span>
                            <span style={{
                                color: SEVERITY_COLOR(m.rank), flexShrink: 0, width: 72,
                                fontSize: 12, fontWeight: 700,
                            }}>
                                {m.severity}
                            </span>
                            <span style={{
                                color: m.rank >= 3 ? SEVERITY_COLOR(m.rank) : 'hsl(var(--app-text))',
                                wordBreak: 'break-word',
                            }}>
                                {m.text}
                            </span>
                        </div>
                    ))}
                </div>

                {!atBottom && shown.length > 0 && (
                    <button
                        onClick={() => {
                            pinnedToBottom.current = true
                            setAtBottom(true)
                            const el = bodyRef.current
                            if (el) el.scrollTop = el.scrollHeight
                        }}
                        className="flex min-h-9 items-center justify-center gap-1.5 py-1.5 flex-shrink-0 text-[13px] font-semibold border-t"
                        style={{
                            background: 'hsl(var(--app-surface))',
                            borderColor: 'hsl(var(--app-border))', color: 'var(--app-accent)',
                        }}
                    >
                        <ChevronDown size={14} /> Jump to newest
                    </button>
                )}
            </div>
        </div>
    )
}
