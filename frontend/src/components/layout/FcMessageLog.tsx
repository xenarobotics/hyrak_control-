'use client'

// The autopilot's message log — what QGroundControl's vehicle-messages panel
// shows, and the single biggest reason a problem is diagnosable there and was
// not here.
//
// PX4 narrates itself constantly: preflight check results, EKF and GPS state
// transitions, failsafe entry and exit, calibration complaints, arming
// refusals with their exact cause. All of it was arriving on this session's
// telemetry link and being dropped on the floor — the subscription existed,
// but only the last line was ever read, and only at the instant a command
// happened to fail.
//
// Deliberately a popover over the status bar rather than a tab: the moment you
// want this is the moment something just went wrong, which is never a moment
// to navigate away from the flight controls.

import { useEffect, useRef, useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { ScrollText, X, Trash2, ChevronDown } from 'lucide-react'

/** MAVSDK's StatusTextType ascends with severity — 0 DEBUG … 7 EMERGENCY —
 *  unlike MAVLink's own SEVERITY enum, which descends. Reading it the wrong
 *  way round would paint every routine line red and every emergency grey. */
const SEVERITY_COLOR = (rank: number): string =>
    rank >= 5 ? '#f87171'          // CRITICAL / ALERT / EMERGENCY
        : rank === 4 ? '#fb923c'   // ERROR
            : rank === 3 ? '#fbbf24'   // WARNING
                : rank === 2 ? '#60a5fa'   // NOTICE
                    : 'hsl(var(--app-text-muted))'

function timeOf(ts: number): string {
    const d = new Date(ts * 1000)
    return d.toLocaleTimeString([], { hour12: false })
}

export function FcMessageLog() {
    const { fcMessages, fcUnread, clearFcMessages, markFcRead } = useDroneStore()
    const [open, setOpen] = useState(false)
    const [minSeverity, setMinSeverity] = useState(0)
    const bodyRef = useRef<HTMLDivElement | null>(null)
    const pinnedToBottom = useRef(true)

    const shown = fcMessages.filter(m => m.rank >= minSeverity)
    const worst = fcMessages.reduce((a, m) => Math.max(a, m.rank), 0)

    // Follow the tail, but only while the operator is already at the tail.
    // Yanking the view back down while someone is reading an earlier line is
    // exactly what makes a live log unusable during the incident it is for.
    useEffect(() => {
        if (!open || !pinnedToBottom.current) return
        const el = bodyRef.current
        if (el) el.scrollTop = el.scrollHeight
    }, [shown.length, open])

    useEffect(() => { if (open) markFcRead() }, [open, fcMessages.length, markFcRead])

    // Escape closes, because this sits over the flight controls.
    useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [open])

    const badgeColor = SEVERITY_COLOR(worst)

    return (
        <div style={{ position: 'relative' }}>
            <button
                onClick={() => setOpen(v => !v)}
                title="Messages from the drone — preflight results, warnings, failsafes"
                style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '5px 9px', borderRadius: 7, fontSize: 11,
                    fontFamily: 'monospace', fontWeight: 600, whiteSpace: 'nowrap',
                    background: 'transparent',
                    border: `1px solid ${fcUnread > 0 ? badgeColor + '80' : 'hsl(var(--app-border))'}`,
                    color: fcUnread > 0 ? badgeColor : 'hsl(var(--app-text-muted))',
                    cursor: 'pointer',
                }}
            >
                <ScrollText size={12} />
                MSGS
                {fcUnread > 0 && (
                    <span style={{
                        minWidth: 15, height: 15, padding: '0 4px', borderRadius: 8,
                        background: badgeColor, color: '#0b0b0d',
                        fontSize: 9.5, fontWeight: 800,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                        {fcUnread > 99 ? '99+' : fcUnread}
                    </span>
                )}
            </button>

            {open && (
                <div
                    style={{
                        position: 'absolute', top: 'calc(100% + 8px)', left: 0,
                        width: 'min(620px, calc(100vw - 32px))',
                        maxHeight: 380, display: 'flex', flexDirection: 'column',
                        background: 'hsl(var(--app-surface))',
                        border: '1px solid hsl(var(--app-border))',
                        borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
                        zIndex: 60, overflow: 'hidden',
                    }}
                >
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '8px 10px', flexShrink: 0,
                        borderBottom: '1px solid hsl(var(--app-border))',
                    }}>
                        <span style={{
                            fontSize: 11, fontFamily: 'monospace', fontWeight: 700,
                            color: 'hsl(var(--app-text))',
                        }}>
                            DRONE MESSAGES
                        </span>
                        <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>
                            {shown.length}{minSeverity > 0 ? ` of ${fcMessages.length}` : ''}
                        </span>

                        <select
                            value={minSeverity}
                            onChange={e => setMinSeverity(Number(e.target.value))}
                            title="Hide routine chatter"
                            style={{
                                marginLeft: 'auto', fontSize: 10, fontFamily: 'monospace',
                                padding: '3px 5px', borderRadius: 5,
                                background: 'hsl(var(--app-surface-2))',
                                border: '1px solid hsl(var(--app-border))',
                                color: 'hsl(var(--app-text-muted))', outline: 'none',
                            }}
                        >
                            <option value={0}>All</option>
                            <option value={2}>Notice +</option>
                            <option value={3}>Warnings +</option>
                            <option value={4}>Errors only</option>
                        </select>

                        <button
                            onClick={clearFcMessages}
                            title="Clear the log"
                            style={{
                                display: 'flex', alignItems: 'center', padding: 4, borderRadius: 5,
                                background: 'transparent', border: '1px solid hsl(var(--app-border))',
                                color: 'hsl(var(--app-text-muted))', cursor: 'pointer',
                            }}
                        >
                            <Trash2 size={11} />
                        </button>
                        <button
                            onClick={() => setOpen(false)}
                            title="Close (Esc)"
                            style={{
                                display: 'flex', alignItems: 'center', padding: 4, borderRadius: 5,
                                background: 'transparent', border: '1px solid hsl(var(--app-border))',
                                color: 'hsl(var(--app-text-muted))', cursor: 'pointer',
                            }}
                        >
                            <X size={11} />
                        </button>
                    </div>

                    <div
                        ref={bodyRef}
                        onScroll={e => {
                            const el = e.currentTarget
                            pinnedToBottom.current =
                                el.scrollHeight - el.scrollTop - el.clientHeight < 24
                        }}
                        style={{ overflowY: 'auto', padding: '6px 4px', flex: 1 }}
                    >
                        {shown.length === 0 ? (
                            <div style={{
                                padding: '18px 12px', fontSize: 11, fontFamily: 'monospace',
                                color: 'hsl(var(--app-text-muted))', lineHeight: 1.7,
                            }}>
                                {fcMessages.length === 0
                                    ? 'Nothing from the drone yet. Messages appear here as the autopilot sends them — preflight results, GPS and EKF changes, failsafes, and the exact reason behind any refused command.'
                                    : 'Nothing at this severity. Lower the filter to see the rest.'}
                            </div>
                        ) : shown.map(m => (
                            <div
                                key={m.id}
                                style={{
                                    display: 'flex', gap: 8, padding: '3px 8px',
                                    fontSize: 11, fontFamily: 'monospace', lineHeight: 1.55,
                                    alignItems: 'baseline',
                                }}
                            >
                                <span style={{ color: 'hsl(var(--app-text-muted))', opacity: 0.7, flexShrink: 0 }}>
                                    {timeOf(m.ts)}
                                </span>
                                <span style={{
                                    color: SEVERITY_COLOR(m.rank), flexShrink: 0,
                                    width: 62, fontSize: 9.5, fontWeight: 700, letterSpacing: 0.3,
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

                    {!pinnedToBottom.current && shown.length > 0 && (
                        <button
                            onClick={() => {
                                pinnedToBottom.current = true
                                const el = bodyRef.current
                                if (el) el.scrollTop = el.scrollHeight
                            }}
                            style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                                padding: '4px 0', flexShrink: 0, fontSize: 10, fontFamily: 'monospace',
                                background: 'hsl(var(--app-surface-2))',
                                borderTop: '1px solid hsl(var(--app-border))', border: 'none',
                                color: 'hsl(var(--app-text-muted))', cursor: 'pointer',
                            }}
                        >
                            <ChevronDown size={11} /> jump to newest
                        </button>
                    )}
                </div>
            )}
        </div>
    )
}
