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
