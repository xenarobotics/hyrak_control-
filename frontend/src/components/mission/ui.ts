// Shared class strings for the Mission and map screens (docs/DESIGN_SYSTEM.md).
//
// Two families:
// - Panels, toolbars and dialogs follow the app theme (--app-* tokens).
// - Anything drawn straight on map tiles (legends, chips, map buttons) uses
//   the --overlay-* set: frosted paper in light, frosted night in the dark
//   themes (docs/DESIGN_SYSTEM.md section 11).
//
// Never use inline hex colours for text on overlays: globals.css remaps a
// set of hex colours in light mode, which is what turned "+ Pin hazard" into
// dark-on-dark.

/** 2px accent focus ring, offset 2px. */
export const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-accent'

/** Focus ring for controls on map tiles (overlay surfaces). */
export const FOCUS_OVERLAY =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--overlay-accent)]'

/** Floating panel on the map: the overlay surface (frosted paper in light,
 *  frosted night in dark), so a map has one kind of chrome. */
export const PANEL =
  'rounded-[10px] border border-overlay-border bg-overlay-scrim text-app-text shadow-[var(--app-shadow)] backdrop-blur-md'

/** Popover / menu that follows the theme. */
export const POPOVER =
  'rounded-[10px] border border-app-border bg-app-raised text-app-text shadow-[var(--app-shadow)]'

/** Dialog sheet. */
export const DIALOG =
  'rounded-[14px] border border-app-border bg-app-raised text-app-text shadow-[var(--app-shadow)]'

/** Dialog backdrop. */
export const BACKDROP = 'bg-[rgb(10_14_20/0.55)]'

/** Chip or card drawn directly on map tiles (follows the theme). */
export const OVERLAY =
  'border border-overlay-border bg-overlay-scrim text-overlay-text backdrop-blur-[6px]'

/** Hover for a control on an overlay surface. */
export const OVERLAY_HOVER = 'hover:bg-overlay-text/10 hover:text-overlay-text'

/** Option in an overlay toolbar (map view, base map, profile). */
export const ovBtn = (active: boolean) =>
  'inline-flex items-center justify-center gap-1.5 h-8 px-2.5 rounded-[6px] text-[13px] font-semibold whitespace-nowrap ' +
  'transition-colors duration-[140ms] ' + FOCUS_OVERLAY + ' ' +
  (active
    ? 'bg-[color-mix(in_srgb,var(--overlay-accent)_16%,transparent)] text-[color:var(--overlay-accent)]'
    : 'text-overlay-muted ' + OVERLAY_HOVER)

/** Panel title (18px 700). */
export const TITLE = 'text-[18px] leading-6 font-bold text-app-text'

/** Section label (13px 600, sentence case, muted). */
export const LABEL = 'text-[13px] font-semibold text-app-text-muted'

/** Small count / fact chip. */
export const CHIP =
  'inline-flex items-center gap-1 h-6 px-2 rounded-full text-xs font-bold tabular-nums bg-app-surface-2 text-app-text border border-app-border'

const BTN_BASE =
  'inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-[6px] text-[13px] font-semibold whitespace-nowrap select-none ' +
  'transition-colors duration-[140ms] ease-[var(--ease-out)] ' + FOCUS +
  ' disabled:cursor-not-allowed disabled:bg-app-surface-2 disabled:text-app-text-subtle disabled:border-dashed disabled:border-app-border'

/** Neutral outline button. */
export const BTN =
  BTN_BASE + ' border border-app-border bg-app-surface-2 text-app-text hover:bg-app-raised hover:border-app-border-strong'

/** Primary (one per panel). */
export const BTN_PRIMARY =
  BTN_BASE + ' border border-transparent bg-app-accent text-app-accent-ink hover:brightness-110'

/** Accent outline, for a selected or secondary-important action. */
export const BTN_ACCENT =
  BTN_BASE + ' border border-app-accent/50 bg-app-accent-soft text-app-accent hover:bg-app-accent/20'

/** Moves the drone or can hurt someone. */
export const BTN_WARN =
  BTN_BASE + ' border border-app-warn/50 bg-app-warn-soft text-app-warn hover:bg-app-warn/20'

/** Filled amber: the confirm step of an action that moves the drone. */
export const BTN_WARN_SOLID =
  BTN_BASE + ' border border-transparent bg-app-warn text-app-bg hover:brightness-110'

/** Destructive, outline until confirmed. */
export const BTN_DANGER =
  BTN_BASE + ' border border-app-danger/50 bg-transparent text-app-danger hover:bg-app-danger-soft'

/** Text input / select that follows the theme. */
export const INPUT =
  'h-8 rounded-[6px] border border-app-border-strong bg-app-surface-2 px-2 text-[13px] text-app-text tabular-nums ' +
  'placeholder:text-app-text-subtle ' + FOCUS + ' disabled:text-app-text-subtle disabled:border-dashed disabled:border-app-border'

/** Segmented control container + option. */
export const SEG = 'inline-flex items-center rounded-[6px] border border-app-border bg-app-surface-2 p-0.5 gap-0.5'
export const segBtn = (active: boolean) =>
  'inline-flex items-center justify-center gap-1.5 h-7 px-2.5 rounded-[5px] text-[13px] font-semibold whitespace-nowrap ' +
  'transition-colors duration-[120ms] ' + FOCUS + ' ' +
  (active ? 'bg-app-accent-soft text-app-accent shadow-sm' : 'text-app-text-muted hover:text-app-text hover:bg-app-raised')

/** Fonts for canvas labels: the body face (Nunito) resolved at draw time. */
export function bodyFont(): string {
  if (typeof document === 'undefined') return 'Nunito, system-ui, sans-serif'
  return getComputedStyle(document.body).fontFamily || 'Nunito, system-ui, sans-serif'
}
