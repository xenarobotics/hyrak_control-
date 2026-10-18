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
import type { Membership, WorkspaceInfo } from './access'

const TOKEN_KEY = 'hyrak-auth-token'
const USER_KEY = 'hyrak-auth-user'
// Memberships and visible workspaces from /api/auth/me, cached beside the
// user so the sidebar and settings can render before the next round trip.
const ACCESS_KEY = 'hyrak-auth-access'
export const LOGIN_PATH = '/login'
/** Fired on window whenever the stored user or access changes. */
export const AUTH_CHANGE_EVENT = 'hyrak-auth-change'

/**
 * The compatibility role (docs/ACCESS_MODEL.md section 8): computed by the
 * server from memberships so the live control paths keep their rank check.
 * founder -> admin, HYRAK pilot or any manager -> operator, other HYRAK
 * memberships -> viewer, customer-only -> member. Since phase 2a a member
 * reaches the live app through workspace permissions instead (isCustomer and
 * the active workspace's perms); with no viewable workspace it gets /account.
 */
export type Role = 'member' | 'viewer' | 'operator' | 'admin'
export interface AuthUser {
    id: string
    username: string
    role: Role
    email?: string | null
    email_verified?: boolean
    display_name?: string | null
    is_founder?: boolean
    is_staff?: boolean
}
export interface AuthAccess { memberships: Membership[]; workspaces: WorkspaceInfo[] }

const ROLE_RANK: Record<Role, number> = { member: -1, viewer: 0, operator: 1, admin: 2 }

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

export function getAccess(): AuthAccess | null {
    if (typeof window === 'undefined') return null
    try {
        const raw = localStorage.getItem(ACCESS_KEY)
        return raw ? (JSON.parse(raw) as AuthAccess) : null
    } catch { return null }
}

/** Staff = any membership on the HYRAK workspace. An older server without
 *  the flag only knows roles, and there admin meant the console. */
export function isStaff(user: AuthUser | null = getUser()): boolean {
    if (!user) return false
    return user.is_staff ?? user.role === 'admin'
}

/**
 * A customer-only account: no membership on the HYRAK workspace. Read from
 * the server's explicit flag only, so an older server that sends no flag
 * keeps every account on the staff path it had before.
 */
export function isCustomer(user: AuthUser | null = getUser()): boolean {
    return !!user && user.is_staff === false
}

export function isFounder(user: AuthUser | null = getUser()): boolean {
    if (!user) return false
    return user.is_founder ?? user.role === 'admin'
}

/** Changes whenever the stored user or access changes (for snapshot caches). */
export function authStorageKey(): string {
    try { return (localStorage.getItem(USER_KEY) ?? '') + '|' + (localStorage.getItem(ACCESS_KEY) ?? '') } catch { return '' }
}

function announce(): void {
    try { window.dispatchEvent(new Event(AUTH_CHANGE_EVENT)) } catch { /* no window */ }
}

function store(token: string | null, user: AuthUser | null, access?: AuthAccess | null): void {
    try {
        if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY)
        if (user) localStorage.setItem(USER_KEY, JSON.stringify(user)); else localStorage.removeItem(USER_KEY)
        // undefined = leave the cached access alone; null = clear it.
        if (access) localStorage.setItem(ACCESS_KEY, JSON.stringify(access))
        else if (access === null || !token) localStorage.removeItem(ACCESS_KEY)
    } catch { /* storage blocked: the session lasts until reload */ }
    announce()
}

/** Keep a token the server just issued (login, invite sign-up). */
export function storeSession(token: string, user: AuthUser): void {
    store(token, user, null)
}

/** Update the cached user after a profile edit, without touching the token. */
export function storeUser(user: AuthUser): void {
    const token = getToken()
    if (token) store(token, { ...getUser(), ...user })
}

/** A short name for this browser, shown in "My devices": "Chrome on Linux". */
export function deviceLabel(): string {
    if (typeof navigator === 'undefined') return ''
    const ua = navigator.userAgent
    const browser = /Electron\//.test(ua) ? 'HYRAK desktop'
        : /Edg\//.test(ua) ? 'Edge'
        : /Firefox\//.test(ua) ? 'Firefox'
        : /Chrome\//.test(ua) ? 'Chrome'
        : /Safari\//.test(ua) ? 'Safari'
        : 'Browser'
    const os = /Android/.test(ua) ? 'Android'
        : /iPhone|iPad/.test(ua) ? 'iOS'
        : /Windows/.test(ua) ? 'Windows'
        : /Mac OS X/.test(ua) ? 'macOS'
        : /Linux/.test(ua) ? 'Linux'
        : ''
    return os ? `${browser} on ${os}` : browser
}

/**
 * THE TOKEN GOES ONLY TO THE CONFIGURED API BASE (getServerUrl()). Never
 * attach it to another host: a localhost probe, a desktop preview server, a
 * relay or an air-unit address. On a page served from dev.xenarobotics.com,
 * "localhost:8001" is whatever process the viewer happens to run there, not
 * necessarily our backend. apiFetch enforces this; a hand-built fetch to an
 * absolute URL should use authHeadersFor(url). A different host that must
 * reach a protected stream gets a path-bound URL ticket instead (urlTicket
 * in src/lib/api.ts).
 */
export function isApiUrl(url: string): boolean {
    try {
        const base = new URL(getServerUrl())
        const u = new URL(url, base)
        return u.origin === base.origin
    } catch {
        return false
    }
}

/** Bearer header for a REST call: `fetch(url, { headers: authHeaders() })`.
 *  Only for URLs on the API base (see isApiUrl). */
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const token = getToken()
    return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra }
}

/** authHeaders() when `url` is on the API base, otherwise just `extra`. */
export function authHeadersFor(url: string, extra: Record<string, string> = {}): Record<string, string> {
    return isApiUrl(url) ? authHeaders(extra) : { ...extra }
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

/** Sign in with an email or a username. Memberships load right after. */
export async function login(loginName: string, password: string): Promise<AuthUser> {
    let res: Response
    try {
        res = await fetch(`${getServerUrl()}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ login: loginName, password, label: deviceLabel() }),
        })
    } catch {
        throw new Error('Could not reach the server. Check the connection and try again.')
    }
    let body: { token?: string; user?: AuthUser; detail?: string } = {}
    try { body = await res.json() } catch { /* non-JSON reply (proxy page) */ }
    if (!res.ok || !body.token || !body.user) {
        throw new Error(body.detail || (res.status === 429
            ? 'Too many attempts. Try again in 15 minutes.'
            : 'Invalid email, username or password'))
    }
    storeSession(body.token, body.user)
    return (await fetchMe()) ?? body.user
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
// The Cloudflare tunnel stalls some requests for 20-40 s; an unbounded
// /api/auth/me held every page on "CHECKING SIGN-IN" for that long. Each
// attempt is capped and a stalled one is retried once (a fresh request
// usually rides a healthy tunnel connection).
const ME_TIMEOUT_MS = 8000
const ME_ATTEMPTS = 2

export async function fetchMe(): Promise<AuthUser | null> {
    const token = getToken()
    if (!token) return null
    try {
        let res: Response | null = null
        for (let i = 0; i < ME_ATTEMPTS && !res; i++) {
            try {
                res = await fetch(`${getServerUrl()}/api/auth/me`, {
                    headers: authHeaders(), signal: AbortSignal.timeout(ME_TIMEOUT_MS),
                })
            } catch (e) {
                if (i === ME_ATTEMPTS - 1) throw e
            }
        }
        if (!res) return getUser()
        if (res.status === 401) { store(null, null); return null }
        if (!res.ok) return getUser()
        const body = await res.json() as {
            user: AuthUser; memberships?: Membership[]; workspaces?: WorkspaceInfo[]
        }
        store(token, body.user, {
            memberships: Array.isArray(body.memberships) ? body.memberships : [],
            workspaces: Array.isArray(body.workspaces) ? body.workspaces : [],
        })
        return body.user
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
