const KEY = 'hyrak-statusbar-enabled'

// Layout mounts once for the whole route group and doesn't re-read
// localStorage on its own, so flipping the Settings toggle needs an explicit
// signal to take effect immediately instead of only on next page load.
export const STATUSBAR_CHANGE_EVENT = 'hyrak-statusbar-changed'

export function getStatusBarEnabled(): boolean {
    if (typeof window === 'undefined') return true
    try {
        const v = localStorage.getItem(KEY)
        return v ? JSON.parse(v) : true
    } catch {
        return true
    }
}

export function setStatusBarEnabled(v: boolean) {
    if (typeof window === 'undefined') return
    localStorage.setItem(KEY, JSON.stringify(v))
    window.dispatchEvent(new CustomEvent<boolean>(STATUSBAR_CHANGE_EVENT, { detail: v }))
}

// ── Link controls inside the bar ─────────────────────────────────────────────
//
// OFF BY DEFAULT, unlike the bar itself. The bar is status plus the two
// controls every operator wants everywhere (Land, Kill); the link pickers are
// setup, and setup controls sitting permanently next to a KILL button are
// clutter for most flights. Turned on for the deployments that retask a
// vehicle mid-session — changing camera or telemetry port from Mission or AI
// without walking back to Fly.
const LINKS_KEY = 'hyrak-statusbar-links-enabled'

export const STATUSBAR_LINKS_CHANGE_EVENT = 'hyrak-statusbar-links-changed'

export function getStatusBarLinksEnabled(): boolean {
    if (typeof window === 'undefined') return false
    try {
        const v = localStorage.getItem(LINKS_KEY)
        return v ? JSON.parse(v) : false
    } catch {
        return false
    }
}

export function setStatusBarLinksEnabled(v: boolean) {
    if (typeof window === 'undefined') return
    localStorage.setItem(LINKS_KEY, JSON.stringify(v))
    window.dispatchEvent(new CustomEvent<boolean>(STATUSBAR_LINKS_CHANGE_EVENT, { detail: v }))
}
