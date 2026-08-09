'use client'

// The autopilot's message log — what QGroundControl's vehicle-messages panel
// shows, and the single biggest reason a problem is diagnosable there.
//
// PX4 narrates itself constantly: preflight check results, EKF and GPS state
// transitions, failsafe entry and exit, calibration complaints, arming
// refusals with their exact cause. All of it arrives on the telemetry link.
//
// WHY THIS IS A MODAL AND NOT A POPOVER. The first version anchored a panel to
// its own button, which put it inside whatever container the button lived in —
// a status bar with overflow-x: auto, and on the Fly tab a collapsible
// right-hand column with overflow-y: auto. Both CLIP an absolutely positioned
// child, so the panel either scrolled the bar sideways until nothing was
// legible or simply never appeared. A log you open when something has gone
// wrong cannot be at the mercy of the layout of whatever is around the button,
// so it renders to document.body through a portal and owns the screen —
// exactly like the mission pre-flight confirmation.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDroneStore } from '@/store/drone'
import { ScrollText, X, Trash2, ChevronDown, AlertTriangle } from 'lucide-react'

/** MAVSDK's StatusTextType ascends with severity — 0 DEBUG … 7 EMERGENCY —
 *  unlike MAVLink's own SEVERITY enum, which descends. Reading it the wrong
 *  way round would paint every routine line red and every emergency grey. */
const SEVERITY_COLOR = (rank: number): string =>
    rank >= 5 ? '#f87171'          // CRITICAL / ALERT / EMERGENCY
        : rank === 4 ? '#fb923c'   // ERROR
            : rank === 3 ? '#fbbf24'   // WARNING
                : rank === 2 ? '#60a5fa'   // NOTICE
                    : '#a1a1aa'

function timeOf(ts: number): string {
    return new Date(ts * 1000).toLocaleTimeString([], { hour12: false })
}

/** Where the trigger is being placed. The two hosts have nothing in common
 *  visually, and one shared button that suited neither is what buried this on
 *  the Fly tab in the first place. */
type Variant = 'bar' | 'floating'

export function FcMessageLog({ variant = 'bar' }: { variant?: Variant }) {
    const { fcMessages, fcUnread, clearFcMessages, markFcRead } = useDroneStore()
    const [open, setOpen] = useState(false)
    const [mounted, setMounted] = useState(false)
    useEffect(() => { setMounted(true) }, [])

    const worst = fcMessages.reduce((a, m) => Math.max(a, m.rank), 0)
    const color = fcUnread > 0 ? SEVERITY_COLOR(worst) : undefined

    const trigger = variant === 'floating' ? (
        <button
            onClick={() => setOpen(true)}
            title="Messages from the drone — preflight results, warnings, failsafes"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[10px] font-mono font-bold transition-colors"
            style={{
                background: 'rgba(0,0,0,.55)',
                borderColor: color ? color + '80' : 'hsl(var(--app-border))',
                color: color ?? '#a1a1aa',
            }}
        >
            <ScrollText size={11} />
            MSGS
            {fcUnread > 0 && (
                <span style={{
                    minWidth: 14, height: 14, padding: '0 4px', borderRadius: 7,
                    background: color, color: '#0b0b0d', fontSize: 9, fontWeight: 800,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}>
                    {fcUnread > 99 ? '99+' : fcUnread}
                </span>
            )}
        </button>
    ) : (
        // ICON ONLY in the status bar. That bar scrolls horizontally once its
        // contents outgrow it, and a labelled button with a badge was enough to
        // push the controls off the end — the log made the bar unreadable,
        // which is the opposite of the point.
        <button
            onClick={() => setOpen(true)}
            title={`Drone messages${fcUnread > 0 ? ` — ${fcUnread} new` : ''}`}
            style={{
                position: 'relative', display: 'flex', alignItems: 'center',
                padding: '5px 7px', borderRadius: 7, flexShrink: 0,
                background: 'transparent',
                border: `1px solid ${color ? color + '80' : 'hsl(var(--app-border))'}`,
                color: color ?? 'hsl(var(--app-text-muted))', cursor: 'pointer',
            }}
        >
            <ScrollText size={13} />
            {fcUnread > 0 && (
                <span style={{
                    position: 'absolute', top: -5, right: -5,
                    minWidth: 14, height: 14, padding: '0 3px', borderRadius: 7,
                    background: color, color: '#0b0b0d', fontSize: 9, fontWeight: 800,
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
            style={{ background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(3px)' }}
            onClick={onClose}
        >
            <div
                onClick={e => e.stopPropagation()}
                className="rounded-2xl border shadow-2xl overflow-hidden flex flex-col"
                style={{
                    background: 'rgba(17,19,24,.98)',
                    borderColor: 'hsl(var(--app-border))',
                    width: 'min(760px, 100%)', height: 'min(520px, 85vh)',
                }}
            >
                <div
                    className="flex items-center gap-2.5 px-4 py-3 border-b flex-shrink-0"
                    style={{ borderColor: 'hsl(var(--app-border))', background: 'rgba(255,255,255,.03)' }}
                >
                    <ScrollText size={15} color="#22d3ee" />
                    <span className="text-[12px] font-mono font-bold" style={{ color: '#e4e4e7' }}>
                        DRONE MESSAGES
                    </span>
                    <span className="text-[10px] font-mono" style={{ color: '#71717a' }}>
                        {shown.length}{minSeverity > 0 ? ` of ${fcMessages.length}` : ''}
                    </span>

                    <select
                        value={minSeverity}
                        onChange={e => setMinSeverity(Number(e.target.value))}
                        title="Hide routine chatter"
                        className="ml-auto text-[10px] font-mono rounded px-1.5 py-1 outline-none"
                        style={{
                            background: 'rgba(255,255,255,.06)',
                            border: '1px solid hsl(var(--app-border))', color: '#a1a1aa',
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
                        className="flex items-center p-1.5 rounded"
                        style={{ border: '1px solid hsl(var(--app-border))', color: '#a1a1aa' }}
                    >
                        <Trash2 size={12} />
                    </button>
                    <button
                        onClick={onClose}
                        title="Close (Esc)"
                        className="flex items-center p-1.5 rounded"
                        style={{ border: '1px solid hsl(var(--app-border))', color: '#a1a1aa' }}
                    >
                        <X size={12} />
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
                            <AlertTriangle size={20} color="#52525b" />
                            <p className="text-[11px] font-mono leading-relaxed" style={{ color: '#71717a' }}>
                                {fcMessages.length === 0
                                    ? 'Nothing from the drone yet. Messages appear here as the autopilot sends them — preflight results, GPS and EKF changes, failsafes, and the exact reason behind any refused command.'
                                    : 'Nothing at this severity. Lower the filter to see the rest.'}
                            </p>
                        </div>
                    ) : shown.map(m => (
                        <div
                            key={m.id}
                            className="flex gap-3 px-4 py-[3px] text-[11.5px] font-mono leading-relaxed items-baseline"
                        >
                            <span style={{ color: '#52525b', flexShrink: 0 }}>{timeOf(m.ts)}</span>
                            <span style={{
                                color: SEVERITY_COLOR(m.rank), flexShrink: 0, width: 66,
                                fontSize: 9.5, fontWeight: 700, letterSpacing: 0.3,
                            }}>
                                {m.severity}
                            </span>
                            <span style={{
                                color: m.rank >= 3 ? SEVERITY_COLOR(m.rank) : '#d4d4d8',
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
                        className="flex items-center justify-center gap-1.5 py-1.5 flex-shrink-0 text-[10px] font-mono border-t"
                        style={{
                            background: 'rgba(255,255,255,.04)',
                            borderColor: 'hsl(var(--app-border))', color: '#a1a1aa',
                        }}
                    >
                        <ChevronDown size={11} /> jump to newest
                    </button>
                )}
            </div>
        </div>
    )
}
