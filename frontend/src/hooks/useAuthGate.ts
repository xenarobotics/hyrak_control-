'use client'

/**
 * Keep a page behind the login. Returns 'checking' until the stored token
 * has been confirmed with the server, then 'ok'; sends the browser to
 * /login (remembering the current URL) when there is no token, when
 * /api/auth/me says 401, or when the account is below the gate.
 *
 * Gates:
 *   a Role   the compatibility rank (docs/ACCESS_MODEL.md section 8).
 *            'member' admits any signed-in account.
 *   'live'   the platform pages (docs/ACCESS_MODEL.md section 8a): staff
 *            with a live rank as before, and customer-only accounts that
 *            can view at least one workspace.
 *   'staff'  any membership on the HYRAK workspace (section 2).
 *   'console' the /admin console: staff, and anyone who manages members
 *            on some workspace (customer owners and admins get the
 *            organization console).
 *
 * An account refused by a gate goes to the live app when it has live
 * access, else to the standalone /account page.
 */
import { useEffect, useState } from 'react'
import { fetchMe, getAccess, getToken, getUser, hasRole, isCustomer, isStaff, redirectToLogin, type AuthUser, type Role } from '@/lib/auth'
import { hasPerm, type WorkspaceInfo } from '@/lib/access'

export type GateState = 'checking' | 'ok'
export type Gate = Role | 'live' | 'staff' | 'console'

const cachedWorkspaces = (): WorkspaceInfo[] => getAccess()?.workspaces ?? []

/** Whether this account may open the platform pages (Fly, AI, Config, Settings).
 *  `workspaces` defaults to the cached /api/auth/me list. */
export function hasLiveAccess(user: AuthUser, workspaces: WorkspaceInfo[] = cachedWorkspaces()): boolean {
    if (isCustomer(user)) return workspaces.some(w => hasPerm(w, 'view'))
    return hasRole('viewer', user)
}

/** Whether this account may open /admin (HYRAK or organization console). */
export function hasConsoleAccess(user: AuthUser, workspaces: WorkspaceInfo[] = cachedWorkspaces()): boolean {
    return isStaff(user) || workspaces.some(w => hasPerm(w, 'members.manage'))
}

function passes(gate: Gate, user: AuthUser): boolean {
    if (gate === 'live') return hasLiveAccess(user)
    if (gate === 'staff') return isStaff(user)
    if (gate === 'console') return hasConsoleAccess(user)
    return hasRole(gate, user)
}

export function useAuthGate(gate: Gate = 'viewer'): GateState {
    const [state, setState] = useState<GateState>('checking')
    useEffect(() => {
        let alive = true
        if (!getToken()) { redirectToLogin(); return }
        // A browser that already signed in opens at once on its cached
        // account while /api/auth/me confirms in the background (a slow
        // tunnel must not hold the page). This is a UI gate only: the
        // server checks the token on every request and socket event, and a
        // 401 or a changed account below still redirects.
        const cached = getUser()
        // (In a microtask: the first render stays 'checking' on server and
        // client alike, so hydration matches.)
        if (cached && passes(gate, cached)) queueMicrotask(() => { if (alive) setState('ok') })
        void fetchMe().then(user => {
            if (!alive) return
            if (!user) { redirectToLogin(); return }
            if (!passes(gate, user)) {
                // Signed in, but this page is above the account: back to the
                // live app, or to /account for an account with no live access.
                window.location.assign(!hasLiveAccess(user) ? '/account'
                    : isCustomer(user) ? '/command' : '/fly')
                return
            }
            setState('ok')
        })
        return () => { alive = false }
    }, [gate])
    return state
}
