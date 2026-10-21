/**
 * Shared presentation classes for the flight screens (Fly, Command).
 * Design system: docs/DESIGN_SYSTEM.md sections 8 and 9.
 */

/** 2px accent focus ring, 2px offset, on themed surfaces. */
export const FOCUS =
    'outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app-bg'

/** Focus ring for controls drawn over video or map. */
export const FOCUS_OVERLAY =
    'outline-none focus-visible:ring-2 focus-visible:ring-[var(--overlay-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-transparent'

/**
 * Readable disabled state: keeps the label at >= 4.5:1 and signals
 * "unavailable" with a quiet solid edge (border, not border-strong), the
 * surface-2 fill and subtle ink instead of opacity. Dashes are kept for
 * drop zones only (design audit 3, 4.0).
 * Wrap the control in <WhyDisabled> so the reason shows on hover.
 */
export const DISABLED =
    'disabled:opacity-100 disabled:border-app-border disabled:bg-app-surface-2 disabled:text-app-text-subtle disabled:shadow-none'

/** A control drawn over video or a map: the theme's frosted overlay (paper in
 *  light, night in dark) with matching ink. */
export const OVERLAY_BTN =
    'inline-flex items-center justify-center gap-1.5 min-h-8 min-w-8 px-2.5 rounded-md border border-overlay-border bg-overlay-scrim text-overlay-text backdrop-blur-[6px] text-[12px] font-bold hover:bg-[color-mix(in_srgb,var(--overlay-text)_10%,var(--overlay-scrim))] transition-colors duration-[140ms] active:scale-[.98]'
