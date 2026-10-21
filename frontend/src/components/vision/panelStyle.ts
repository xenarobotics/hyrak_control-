// Shared look for the built-in result panels (AI tab results column and the
// Command window's AI panel). Every colour is an app token, so the panels
// follow dark, light and Normal mode (which re-points --app-* inside .cm).
// Over video or maps use OVERLAY instead: those surfaces are always dark.

import type { CSSProperties } from 'react'
import focusCss from './panel.module.css'

/** className for every interactive element in a panel: 2px accent ring. */
export const FOCUS = focusCss.focus
/** Same, for controls drawn over video or maps. */
export const FOCUS_OVERLAY = focusCss.focusOverlay

export type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'muted'

/** Status colours: fg passes 4.5:1 on surface in both themes; bg is the soft
 *  tint; border a 45% mix for chips and tiles. */
export const TONE: Record<Tone, { fg: string; bg: string; border: string }> = {
    ok:     { fg: 'var(--app-ok)',     bg: 'var(--app-ok-soft)',     border: 'color-mix(in srgb, var(--app-ok) 45%, transparent)' },
    warn:   { fg: 'var(--app-warn)',   bg: 'var(--app-warn-soft)',   border: 'color-mix(in srgb, var(--app-warn) 45%, transparent)' },
    danger: { fg: 'var(--app-danger)', bg: 'var(--app-danger-soft)', border: 'color-mix(in srgb, var(--app-danger) 45%, transparent)' },
    accent: { fg: 'var(--app-accent)', bg: 'var(--app-accent-soft)', border: 'color-mix(in srgb, var(--app-accent) 45%, transparent)' },
    muted:  { fg: 'hsl(var(--app-text-muted))', bg: 'hsl(var(--app-surface-2))', border: 'hsl(var(--app-border))' },
}

export const TEXT = 'hsl(var(--app-text))'
export const MUTED = 'hsl(var(--app-text-muted))'
export const SUBTLE = 'hsl(var(--app-text-subtle))'
export const SURFACE = 'hsl(var(--app-surface))'
export const SURFACE_2 = 'hsl(var(--app-surface-2))'
export const BORDER = 'hsl(var(--app-border))'
export const BORDER_STRONG = 'hsl(var(--app-border-strong))'

/** Section label: 13px 600, sentence case, no tracking. */
export const LABEL: CSSProperties = {
    fontSize: 13, fontWeight: 600, lineHeight: '18px', color: MUTED,
}

/** Key readout: big tabular number. Pair with UNIT for the unit. */
export const READOUT: CSSProperties = {
    fontSize: 24, fontWeight: 700, lineHeight: 1.1,
    fontVariantNumeric: 'tabular-nums', color: TEXT,
}
export const UNIT: CSSProperties = { fontSize: 13, fontWeight: 600, color: MUTED, marginLeft: 3 }

/** Body 14 / secondary 13. */
export const BODY: CSSProperties = { fontSize: 14, lineHeight: '20px', color: TEXT }
export const SECONDARY: CSSProperties = { fontSize: 13, lineHeight: '18px', color: MUTED }
export const NUM: CSSProperties = { fontVariantNumeric: 'tabular-nums' }

/** Card / tile on the panel. */
export const TILE: CSSProperties = {
    background: SURFACE_2, border: `1px solid ${BORDER}`, borderRadius: 10,
}

/** Pill chip in a tone. */
export function chip(t: Tone): CSSProperties {
    return {
        display: 'inline-flex', alignItems: 'center', gap: 5,
        minHeight: 24, padding: '2px 8px', borderRadius: 999,
        fontSize: 12, fontWeight: 700, lineHeight: '16px', whiteSpace: 'nowrap',
        color: TONE[t].fg, background: TONE[t].bg, border: `1px solid ${TONE[t].border}`,
        fontVariantNumeric: 'tabular-nums',
    }
}

/** A panel button: 32px, radius 6, token colours. `primary` = filled accent,
 *  `danger` = red outline. Pair with className={FOCUS} for the ring. */
export function btn(kind: 'default' | 'primary' | 'danger' | 'warn' = 'default'): CSSProperties {
    const base: CSSProperties = {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        minHeight: 32, padding: '0 12px', borderRadius: 6,
        fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
        transition: 'background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
    }
    if (kind === 'primary') return { ...base, background: 'var(--app-accent)', color: 'var(--app-accent-ink)', border: '1px solid var(--app-accent)' }
    if (kind === 'danger') return { ...base, background: 'transparent', color: TONE.danger.fg, border: `1px solid ${TONE.danger.border}` }
    if (kind === 'warn') return { ...base, background: TONE.warn.bg, color: TONE.warn.fg, border: `1px solid ${TONE.warn.border}` }
    return { ...base, background: SURFACE, color: TEXT, border: `1px solid ${BORDER_STRONG}` }
}

/** Disabled look that keeps the label readable (no opacity-only). */
export const DISABLED: CSSProperties = {
    background: SURFACE_2, color: SUBTLE, border: `1px solid ${BORDER}`, cursor: 'not-allowed',
}

/** Always-dark surfaces (video, map): fixed overlay set, same in both themes. */
export const OVERLAY = {
    scrim: 'var(--overlay-scrim)',
    text: 'var(--overlay-text)',
    muted: 'var(--overlay-muted)',
    border: 'var(--overlay-border)',
    accent: 'var(--overlay-accent)',
    ok: 'var(--overlay-ok)',
    warn: 'var(--overlay-warn)',
    danger: 'var(--overlay-danger)',
} as const
