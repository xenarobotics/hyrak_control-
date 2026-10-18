'use client'

/**
 * Keep a page behind the login. Returns 'checking' until the stored token
 * has been confirmed with the server, then 'ok'; sends the browser to
 * /login (remembering the current URL) when there is no token, when
 * /api/auth/me says 401, or when the role is below `minRole`.
 *
 * 'staff' gates the HYRAK console: any membership on the HYRAK workspace
 * (docs/ACCESS_MODEL.md section 2). What a staff member can do inside it is
 * decided per tab from their memberships.
 *
 * 'member' admits any signed-in account. A customer-only account (role
 * member, phase 1) has no live access, so every higher gate sends it to the
 * standalone /account page instead of /fly.
 */
import { useEffect, useState } from 'react'
import { fetchMe, getToken, hasRole, isStaff, redirectToLogin, type Role } from '@/lib/auth'

export type GateState = 'checking' | 'ok'

export function useAuthGate(minRole: Role | 'staff' = 'viewer'): GateState {
    const [state, setState] = useState<GateState>('checking')
    useEffect(() => {
        let alive = true
        if (!getToken()) { redirectToLogin(); return }
        void fetchMe().then(user => {
            if (!alive) return
            if (!user) { redirectToLogin(); return }
            if (minRole === 'staff' ? !isStaff(user) : !hasRole(minRole, user)) {
                // Signed in, but this page is above the role: back to Fly,
                // or to /account for an account with no live access.
                window.location.assign(user.role === 'member' ? '/account' : '/fly')
                return
            }
            setState('ok')
        })
        return () => { alive = false }
    }, [minRole])
    return state
}
