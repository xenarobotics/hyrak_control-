'use client'

/**
 * Who is signed in and what they can reach, live across components: the
 * cached /api/auth/me reply (user, memberships, visible workspaces), re-read
 * whenever lib/auth announces a change. Empty on the server render.
 *
 * The active workspace (the one the customer app is "in") lives here too:
 * persisted per browser, defaulting to the first workspace the person holds
 * a direct membership on. Phase 1 sends workspace ids explicitly in request
 * bodies, so this is only a UI choice, not a header.
 */
import { useCallback } from 'react'
import { AUTH_CHANGE_EVENT, authStorageKey, getAccess, getUser, isFounder, isStaff, type AuthUser } from '@/lib/auth'
import type { Membership, WorkspaceInfo } from '@/lib/access'
import { useClientValueOn } from '@/hooks/useClientValue'

export interface AccessSnapshot {
    user: AuthUser | null
    memberships: Membership[]
    workspaces: WorkspaceInfo[]
    isFounder: boolean
    isStaff: boolean
}

const EMPTY: AccessSnapshot = { user: null, memberships: [], workspaces: [], isFounder: false, isStaff: false }

// useSyncExternalStore needs a stable reference while nothing changed: the
// snapshot is rebuilt only when the stored JSON differs.
let lastKey = ''
let lastSnap: AccessSnapshot = EMPTY

function readSnapshot(): AccessSnapshot {
    const key = authStorageKey()
    if (key === lastKey) return lastSnap
    lastKey = key
    const user = getUser()
    const access = getAccess()
    lastSnap = {
        user,
        memberships: access?.memberships ?? [],
        workspaces: access?.workspaces ?? [],
        isFounder: isFounder(user),
        isStaff: isStaff(user),
    }
    return lastSnap
}

export function useAccess(): AccessSnapshot {
    return useClientValueOn(AUTH_CHANGE_EVENT, readSnapshot, EMPTY)
}

const ACTIVE_KEY = 'hyrak-active-workspace'
const ACTIVE_EVENT = 'hyrak-active-workspace-change'

// Kept in memory too, so switching still works when storage is blocked.
let memActive: string | null = null

function readActiveId(): string | null {
    try { return localStorage.getItem(ACTIVE_KEY) ?? memActive } catch { return memActive }
}

export function useActiveWorkspace(): {
    workspace: WorkspaceInfo | null
    workspaces: WorkspaceInfo[]
    setActive: (id: string) => void
} {
    const { workspaces } = useAccess()
    const stored = useClientValueOn(ACTIVE_EVENT, readActiveId, null)
    const fallback = workspaces.find(w => !w.inherited) ?? workspaces[0] ?? null
    const workspace = workspaces.find(w => w.id === stored) ?? fallback
    const setActive = useCallback((id: string) => {
        memActive = id
        try { localStorage.setItem(ACTIVE_KEY, id) } catch { /* lasts until reload */ }
        try { window.dispatchEvent(new Event(ACTIVE_EVENT)) } catch { /* no window */ }
    }, [])
    return { workspace, workspaces, setActive }
}
