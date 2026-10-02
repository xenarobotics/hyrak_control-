'use client'

// A button that acts only after it has been held for `holdMs`. For the one
// action that cannot be undone (stopping the motors in the air): a stray tap
// does nothing, a deliberate press is unmistakable. The ring fills while held;
// letting go early cancels. Keyboard: hold Space or Enter.

import { useCallback, useEffect, useRef, useState } from 'react'

export function HoldButton({ onConfirm, holdMs = 1500, label, hint, disabled }: {
    onConfirm: () => void
    holdMs?: number
    label: string
    hint: string
    disabled?: boolean
}) {
    const [p, setP] = useState(0)                  // 0..1
    const start = useRef<number | null>(null)
    const raf = useRef(0)
    const done = useRef(false)

    const stop = useCallback(() => {
        start.current = null
        cancelAnimationFrame(raf.current)
        if (!done.current) setP(0)
    }, [])

    const frame = useCallback(() => {
        if (start.current == null) return
        const f = Math.min(1, (performance.now() - start.current) / holdMs)
        setP(f)
        if (f >= 1) {
            done.current = true
            start.current = null
            onConfirm()
            setTimeout(() => { done.current = false; setP(0) }, 1200)
            return
        }
        raf.current = requestAnimationFrame(frame)
    }, [holdMs, onConfirm])

    const begin = useCallback(() => {
        if (disabled || start.current != null || done.current) return
        start.current = performance.now()
        raf.current = requestAnimationFrame(frame)
    }, [disabled, frame])

    useEffect(() => () => cancelAnimationFrame(raf.current), [])

    const r = 15, c = 2 * Math.PI * r
    return (
        <button type="button" disabled={disabled}
            onPointerDown={begin} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}
            onKeyDown={e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); begin() } }}
            onKeyUp={e => { if (e.key === ' ' || e.key === 'Enter') stop() }}
            onContextMenu={e => e.preventDefault()}
            aria-label={`${label}. ${hint}`}
            className="w-full flex items-center gap-3 rounded-[var(--s-radius)] border-2 px-4 py-3 text-left select-none touch-none disabled:opacity-40"
            style={{ borderColor: 'var(--s-red)', background: p > 0 ? 'var(--s-red-soft)' : 'var(--s-panel)', color: 'var(--s-red)' }}>
            <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true" className="shrink-0">
                <circle cx="20" cy="20" r={r} fill="none" stroke="var(--s-red-soft)" strokeWidth="5" />
                <circle cx="20" cy="20" r={r} fill="none" stroke="var(--s-red)" strokeWidth="5" strokeLinecap="round"
                    strokeDasharray={c} strokeDashoffset={c * (1 - p)} transform="rotate(-90 20 20)" />
                <rect x="14.5" y="14.5" width="11" height="11" rx="2" fill="var(--s-red)" />
            </svg>
            <span className="flex flex-col leading-tight">
                <span className="text-[18px] font-bold">{p >= 1 ? 'Motors stopped' : label}</span>
                <span className="text-[14px]" style={{ color: 'var(--s-ink-2)' }}>{hint}</span>
            </span>
        </button>
    )
}
