// Interface preferences that are not the colour theme: font family and UI
// scale. Both are DOM-level (an attribute and a zoom style on <html>), so
// they apply to every page without threading a context through the tree -
// and both are re-applied before first paint by the inline script in
// app/layout.tsx, so a reload doesn't flash the defaults.

export type UiFont = 'default' | 'system' | 'ubuntu' | 'inter' | 'nunito'
export const UI_FONTS: { value: UiFont; label: string }[] = [
    { value: 'default', label: 'Geist (default)' },
    { value: 'system', label: 'System sans' },
    { value: 'ubuntu', label: 'Ubuntu' },
    { value: 'inter', label: 'Inter' },
    { value: 'nunito', label: 'Nunito' },
]

/** Percent. 100 = as designed. The whole interface scales - the request
 *  behind this was "the text is too small", and scaling only the text
 *  breaks every panel that was sized around it. */
export const UI_ZOOMS = [90, 100, 110, 120, 135] as const

export type UiTextSize = 'default' | 'large' | 'xlarge'
export const UI_TEXT_SIZES: { value: UiTextSize; label: string }[] = [
    { value: 'default', label: 'Default' },
    { value: 'large', label: 'Large (+15%)' },
    { value: 'xlarge', label: 'Extra large (+30%)' },
]

const FONT_KEY = 'hyrak-ui-font'
const ZOOM_KEY = 'hyrak-ui-zoom'
const TEXTSIZE_KEY = 'hyrak-ui-textsize'

export function getUiFont(): UiFont {
    if (typeof window === 'undefined') return 'default'
    const v = localStorage.getItem(FONT_KEY)
    return (UI_FONTS.some(f => f.value === v) ? v : 'default') as UiFont
}

export function setUiFont(font: UiFont) {
    localStorage.setItem(FONT_KEY, font)
    applyUiFont(font)
}

export function applyUiFont(font: UiFont) {
    const d = document.documentElement
    if (font === 'default') delete d.dataset.font
    else d.dataset.font = font
}

export function getUiZoom(): number {
    if (typeof window === 'undefined') return 100
    const v = Number(localStorage.getItem(ZOOM_KEY))
    return UI_ZOOMS.includes(v as (typeof UI_ZOOMS)[number]) ? v : 100
}

export function setUiZoom(pct: number) {
    localStorage.setItem(ZOOM_KEY, String(pct))
    applyUiZoom(pct)
}

export function applyUiZoom(pct: number) {
    // CSS zoom on the root: standardised in 2024, supported by Chromium,
    // Firefox 126+ and Safari - and unlike a font-size hack it scales the
    // panels WITH the text, which is what "make everything bigger" means.
    document.documentElement.style.zoom = pct === 100 ? '' : String(pct / 100)
}

export function getUiTextSize(): UiTextSize {
    if (typeof window === 'undefined') return 'default'
    const v = localStorage.getItem(TEXTSIZE_KEY)
    return (UI_TEXT_SIZES.some(t => t.value === v) ? v : 'default') as UiTextSize
}

export function setUiTextSize(size: UiTextSize) {
    localStorage.setItem(TEXTSIZE_KEY, size)
    applyUiTextSize(size)
}

export function applyUiTextSize(size: UiTextSize) {
    const d = document.documentElement
    if (size === 'default') delete d.dataset.fontsize
    else d.dataset.fontsize = size
}


// -- Interface mode ------------------------------------------------------------
// normal: the plain-language flight screen anyone can use (default).
// dev:    the full engineering interface (every tab, panel and readout).
export type UiMode = 'normal' | 'dev'
const MODE_KEY = 'hyrak-ui-mode'
export const UI_MODE_EVENT = 'hyrak-ui-mode-change'

export function getUiMode(): UiMode {
    if (typeof window === 'undefined') return 'normal'
    return localStorage.getItem(MODE_KEY) === 'dev' ? 'dev' : 'normal'
}

export function setUiMode(mode: UiMode) {
    try { localStorage.setItem(MODE_KEY, mode) } catch { /* not critical */ }
    window.dispatchEvent(new CustomEvent(UI_MODE_EVENT, { detail: mode }))
}
