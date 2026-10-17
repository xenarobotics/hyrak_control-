/**
 * Who is signed in, and how every request proves it.
 *
 * The backend issues a per-user bearer token from POST /api/auth/login
 * (backend/app/auth). It lives in localStorage under hyrak-auth-token and
 * goes out as `Authorization: Bearer ...` on REST calls and as the socket's
 * auth payload. There is no shared secret in this bundle any more.
 *
 * localStorage can be unavailable (private window, blocked site data): every
 * read and write is wrapped, and a missing token simply means "signed out".
 */
import { getServerUrl } from './server-url'

const TOKEN_KEY = 'hyrak-auth-token'
const USER_KEY = 'hyrak-auth-user'
export const LOGIN_PATH = '/login'

export type Role = 'viewer' | 'operator' | 'admin'
export interface AuthUser { id: string; username: string; role: Role }

const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 }

export function getToken(): string | null {
    if (typeof window === 'undefined') return null
    try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
}

export function getUser(): AuthUser | null {
    if (typeof window === 'undefined') return null
    try {
        const raw = localStorage.getItem(USER_KEY)
        return raw ? (JSON.parse(raw) as AuthUser) : null
    } catch { return null }
}

export function hasRole(min: Role, user: AuthUser | null = getUser()): boolean {
    return !!user && ROLE_RANK[user.role] >= ROLE_RANK[min]
}

function store(token: string | null, user: AuthUser | null): void {
    try {
        if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY)
        if (user) localStorage.setItem(USER_KEY, JSON.stringify(user)); else localStorage.removeItem(USER_KEY)
    } catch { /* storage blocked: the session lasts until reload */ }
}

/** Bearer header for a REST call: `fetch(url, { headers: authHeaders() })`. */
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const token = getToken()
    return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra }
}

/**
 * The same, for a module-level `const AUTH = ...` that fetch reads later:
 * the Authorization property is a getter, so a login after the module was
 * evaluated still shows up on the next request.
 */
export function liveAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const obj: Record<string, string> = { ...extra }
    Object.defineProperty(obj, 'Authorization', {
        enumerable: true,
        get: () => `Bearer ${getToken() ?? ''}`,
    })
    return obj
}

export async function login(username: string, password: string): Promise<AuthUser> {
    let res: Response
    try {
        res = await fetch(`${getServerUrl()}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        })
    } catch {
        throw new Error('Could not reach the server. Check the connection and try again.')
    }
    let body: { token?: string; user?: AuthUser; detail?: string } = {}
    try { body = await res.json() } catch { /* non-JSON reply (proxy page) */ }
    if (!res.ok || !body.token || !body.user) {
        throw new Error(body.detail || (res.status === 429
            ? 'Too many attempts. Try again in 15 minutes.'
            : 'Invalid username or password'))
    }
    store(body.token, body.user)
    return body.user
}

export async function logout(): Promise<void> {
    const token = getToken()
    store(null, null)
    if (!token) return
    try {
        await fetch(`${getServerUrl()}/api/auth/logout`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` },
        })
    } catch { /* the token is gone locally either way */ }
}

/**
 * Confirm the stored token with the server. Returns the user, or null when
 * the server said 401 (token revoked or expired). A network failure keeps
 * the cached user: the backend may be restarting and the token is still
 * good.
 */
export async function fetchMe(): Promise<AuthUser | null> {
    const token = getToken()
    if (!token) return null
    try {
        const res = await fetch(`${getServerUrl()}/api/auth/me`, { headers: authHeaders() })
        if (res.status === 401) { store(null, null); return null }
        if (!res.ok) return getUser()
        const user = (await res.json()).user as AuthUser
        store(token, user)
        return user
    } catch {
        return getUser()
    }
}

/** Drop the token and send the browser to the login page, remembering where it was. */
export function redirectToLogin(): void {
    if (typeof window === 'undefined') return
    store(null, null)
    const here = window.location.pathname + window.location.search
    if (here.startsWith(LOGIN_PATH)) return
    const next = here === '/' ? '' : `?next=${encodeURIComponent(here)}`
    window.location.assign(`${LOGIN_PATH}${next}`)
}
