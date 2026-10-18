/**
 * The active workspace: the one the live app is "in" (docs/ACCESS_MODEL.md
 * section 8a). Persisted per browser, readable outside React so the socket
 * handshake can send it.
 *
 * For a customer-only account it decides what the live session may reach:
 * the socket sends it as `workspace_id`, and the server stamps the session
 * with the account's perms on it. Staff sessions stay on HYRAK whatever is
 * picked here, so for staff it remains a UI choice (Settings > Workspace).
 */
import { getAccess, getUser, isCustomer } from './auth'
import { hasPerm, type WorkspaceInfo } from './access'

const ACTIVE_KEY = 'hyrak-active-workspace'
/** Fired on window whenever the stored choice changes. */
export const ACTIVE_WORKSPACE_EVENT = 'hyrak-active-workspace-change'

// Kept in memory too, so switching still works when storage is blocked.
let memActive: string | null = null

export function readActiveWorkspaceId(): string | null {
    if (typeof window === 'undefined') return null
    try { return localStorage.getItem(ACTIVE_KEY) ?? memActive } catch { return memActive }
}

export function canView(ws: WorkspaceInfo | null | undefined): boolean {
    return hasPerm(ws, 'view')
}

/** Workspaces a customer can open live sessions in, in the server's order. */
export function viewableWorkspaces(list: WorkspaceInfo[]): WorkspaceInfo[] {
    return list.filter(canView)
}

/**
 * Which workspace to be in. The stored choice wins while it is still visible
 * (and, when `requireView`, still viewable); otherwise the first workspace
 * held directly, preferring ones with `view`.
 */
export function resolveActiveWorkspace(
    list: WorkspaceInfo[],
    storedId: string | null,
    requireView: boolean,
): WorkspaceInfo | null {
    const stored = list.find(w => w.id === storedId)
    if (stored && (!requireView || canView(stored))) return stored
    const viewable = viewableWorkspaces(list)
    const preferred = viewable.find(w => !w.inherited) ?? viewable[0]
    if (preferred) return preferred
    if (requireView) return null
    return list.find(w => !w.inherited) ?? list[0] ?? null
}

/** The active workspace from the cached /api/auth/me reply. */
export function getActiveWorkspace(): WorkspaceInfo | null {
    const list = getAccess()?.workspaces ?? []
    return resolveActiveWorkspace(list, readActiveWorkspaceId(), isCustomer(getUser()))
}

/** Store the choice. Does not touch the socket: see switchActiveWorkspace. */
export function setActiveWorkspaceId(id: string): void {
    memActive = id
    try { localStorage.setItem(ACTIVE_KEY, id) } catch { /* lasts until reload */ }
    try { window.dispatchEvent(new Event(ACTIVE_WORKSPACE_EVENT)) } catch { /* no window */ }
}
