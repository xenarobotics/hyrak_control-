/**
 * Shared presentation classes for the flight screens (Fly, Command).
 * Design system: docs/DESIGN_SYSTEM.md sections 8 and 9.
 */

/** 2px accent focus ring, 2px offset, on themed surfaces. */
export const FOCUS =
    'outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app-bg'

/** Focus ring for controls drawn over video or map (always dark). */
export const FOCUS_OVERLAY =
    'outline-none focus-visible:ring-2 focus-visible:ring-[var(--overlay-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black'

/**
 * Readable disabled state: keeps the label at >= 4.5:1 and signals
 * "unavailable" with a muted fill and dashed border instead of opacity.
 * Wrap the control in <WhyDisabled> so the reason shows on hover.
 */
export const DISABLED =
    'disabled:opacity-100 disabled:border-dashed disabled:border-app-border-strong disabled:bg-app-surface-2 disabled:text-app-text-subtle disabled:shadow-none'

/** A control drawn over video: dark scrim, light text, fixed in both themes. */
export const OVERLAY_BTN =
    'inline-flex items-center justify-center gap-1.5 min-h-8 min-w-8 px-2.5 rounded-md border border-overlay-border bg-overlay-scrim text-overlay-text backdrop-blur-[6px] text-[12px] font-bold hover:bg-[rgba(8,12,18,0.88)] transition-colors duration-[var(--dur-fast)]'
