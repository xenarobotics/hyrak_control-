'use client'

/**
 * Keep a page behind the login. Returns 'checking' until the stored token
 * has been confirmed with the server, then 'ok'; sends the browser to
 * /login (remembering the current URL) when there is no token, when
 * /api/auth/me says 401, or when the role is below `minRole`.
 */
import { useEffect, useState } from 'react'
import { fetchMe, getToken, hasRole, redirectToLogin, type Role } from '@/lib/auth'

export type GateState = 'checking' | 'ok'

export function useAuthGate(minRole: Role = 'viewer'): GateState {
    const [state, setState] = useState<GateState>('checking')
    useEffect(() => {
        let alive = true
        if (!getToken()) { redirectToLogin(); return }
        void fetchMe().then(user => {
            if (!alive) return
            if (!user) { redirectToLogin(); return }
            if (!hasRole(minRole, user)) {
                // Signed in, but this page is above the role: back to Fly.
                window.location.assign('/fly')
                return
            }
            setState('ok')
        })
        return () => { alive = false }
    }, [minRole])
    return state
}
