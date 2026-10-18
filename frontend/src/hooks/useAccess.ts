'use client'

/**
 * Who is signed in and what they can reach, live across components: the
 * cached /api/auth/me reply (user, memberships, visible workspaces), re-read
 * whenever lib/auth announces a change. Empty on the server render.
 *
 * The active workspace (the one the customer app is "in") lives here too:
 * persisted per browser (lib/activeWorkspace), defaulting to the first
 * workspace the person holds a direct membership on. For customers it also
 * scopes the live socket session (docs/ACCESS_MODEL.md section 8a).
 */
import { useCallback, useMemo } from 'react'
import { AUTH_CHANGE_EVENT, authStorageKey, getAccess, getUser, isCustomer, isFounder, isStaff, type AuthUser } from '@/lib/auth'
import { ACTIVE_WORKSPACE_EVENT, readActiveWorkspaceId, resolveActiveWorkspace, viewableWorkspaces } from '@/lib/activeWorkspace'
import { switchActiveWorkspace } from '@/lib/workspaceSwitch'
import type { Membership, WorkspaceInfo } from '@/lib/access'
import { useClientValueOn } from '@/hooks/useClientValue'

export interface AccessSnapshot {
    user: AuthUser | null
    memberships: Membership[]
    workspaces: WorkspaceInfo[]
    isFounder: boolean
    isStaff: boolean
    /** Customer-only account (is_staff === false from the server). */
    isCustomer: boolean
}

const EMPTY: AccessSnapshot = { user: null, memberships: [], workspaces: [], isFounder: false, isStaff: false, isCustomer: false }

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
        isCustomer: isCustomer(user),
    }
    return lastSnap
}

export function useAccess(): AccessSnapshot {
    return useClientValueOn(AUTH_CHANGE_EVENT, readSnapshot, EMPTY)
}

/**
 * The active workspace and a setter. For a customer-only account the choice
 * scopes the live session, so only viewable workspaces are offered and
 * `setActive` ends the running session and reconnects (lib/workspaceSwitch).
 */
export function useActiveWorkspace(): {
    workspace: WorkspaceInfo | null
    workspaces: WorkspaceInfo[]
    setActive: (id: string) => void
} {
    const { workspaces: all, isCustomer } = useAccess()
    const stored = useClientValueOn(ACTIVE_WORKSPACE_EVENT, readActiveWorkspaceId, null)
    // A customer with nothing viewable (only disabled workspaces) still sees
    // them on /account; the live app sends such an account there.
    const viewable = useMemo(() => viewableWorkspaces(all), [all])
    const scoped = isCustomer && viewable.length > 0
    const workspaces = scoped ? viewable : all
    const workspace = resolveActiveWorkspace(all, stored, scoped)
    const setActive = useCallback((id: string) => { void switchActiveWorkspace(id) }, [])
    return { workspace, workspaces, setActive }
}
