'use client'

// Shared look and motion for the app's toasts and banners (refusal, zone,
// takeover, rule notices). They follow the theme: a solid raised card tinted
// by its tone, with theme ink, so light mode never shows a dark box. They
// fade in with an 8px rise over 240ms and out over 180ms (usePresence keeps
// the last value on screen while it leaves).

import { useEffect, useState } from 'react'

export type ToastTone = 'danger' | 'warn' | 'ok' | 'accent' | 'info'

const TONE_VAR: Record<ToastTone, string> = {
    danger: 'var(--app-danger)', warn: 'var(--app-warn)', ok: 'var(--app-ok)',
    accent: 'var(--app-accent)', info: 'hsl(var(--app-border-strong))',
}

/** Card colours for a tone: tinted raised surface, toned edge, theme ink. */
export function toastStyle(tone: ToastTone, strength = 12): React.CSSProperties {
    const c = TONE_VAR[tone]
    return {
        background: tone === 'info'
            ? 'hsl(var(--app-raised))'
            : `color-mix(in srgb, ${c} ${strength}%, hsl(var(--app-raised)))`,
        border: `1px solid ${tone === 'info' ? 'hsl(var(--app-border))' : `color-mix(in srgb, ${c} 55%, transparent)`}`,
        color: 'hsl(var(--app-text))',
        boxShadow: 'var(--app-shadow)',
    }
}
export const toneColor = (tone: ToastTone) => tone === 'info' ? 'var(--app-accent)' : TONE_VAR[tone]

export const TOAST_IN = 'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-2 motion-safe:duration-[240ms] motion-safe:ease-[var(--ease-out)]'
export const TOAST_OUT = 'motion-safe:animate-out motion-safe:fade-out-0 motion-safe:slide-out-to-top-2 motion-safe:duration-[180ms] motion-safe:ease-[var(--ease-in)] motion-safe:fill-mode-forwards'

/** Keeps the last non-null value for `exitMs` after it goes null, so the
 *  toast can play its exit. Returns the value to show and whether it is
 *  leaving. */
export function usePresence<T>(value: T | null, exitMs = 180): { shown: T | null; leaving: boolean } {
    const [last, setLast] = useState<T | null>(value)
    const [leaving, setLeaving] = useState(false)
    // Adjusted during render: a new value replaces the old at once.
    if (value != null && value !== last) { setLast(value); setLeaving(false) }
    if (value == null && last != null && !leaving) setLeaving(true)
    useEffect(() => {
        if (!leaving) return
        const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        const id = setTimeout(() => { setLast(null); setLeaving(false) }, reduce ? 0 : exitMs)
        return () => clearTimeout(id)
    }, [leaving, exitMs])
    return { shown: value ?? last, leaving: value == null && last != null }
}
