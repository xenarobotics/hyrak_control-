/**
 * Typed client for the access-model API (docs/ACCESS_MODEL.md section 7):
 * account, devices, invites, password resets, workspaces, members, drones,
 * staff, audit and layered zones.
 *
 * Every call resolves to an ApiResult instead of throwing, and a failure
 * carries the server's own message: the server is the final check on every
 * rule (last owner, area outside, who may grant what), so the UI shows its
 * words rather than guessing. Calls made from the public pages (/invite,
 * /reset) never redirect to /login on a 401.
 */
import { apiFetch } from './api'
import { authHeaders, type AuthUser } from './auth'
import { getServerUrl } from './server-url'
import type { GeoPolygon, MemberRole, Membership, WorkspaceInfo, WorkspaceKind, ZoneLayer } from './access'
import type { ZoneClass, ZoneFeature } from '@/components/admin/zones'

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string }

type Mode = 'app' | 'public'

function messageFor(status: number, body: unknown): string {
    const detail = (body as { detail?: unknown } | null)?.detail
    if (typeof detail === 'string' && detail) return detail
    // FastAPI validation errors: [{loc, msg}, ...]
    if (Array.isArray(detail) && detail.length) {
        return detail.map(d => (d as { msg?: string }).msg ?? '').filter(Boolean).join('; ')
            || 'The server rejected that request.'
    }
    if (status === 401) return 'You are signed out. Sign in and try again.'
    if (status === 403) return 'You do not have permission to do that.'
    if (status === 404) return 'Not found, or you do not have access to it.'
    if (status === 409) return 'That conflicts with a rule on the server.'
    if (status === 429) return 'Too many attempts. Wait a few minutes and try again.'
    if (status === 503) return 'The database is unavailable right now. Try again shortly.'
    return `The server answered ${status}.`
}

async function call<T>(path: string, init: RequestInit & { json?: unknown } = {}, mode: Mode = 'app'): Promise<ApiResult<T>> {
    let res: Response
    try {
        if (mode === 'app') {
            res = await apiFetch(path, init)
        } else {
            const { json, headers, ...rest } = init
            const h = authHeaders(Object.fromEntries(new Headers(headers ?? {}).entries()))
            if (json !== undefined) h['Content-Type'] = 'application/json'
            res = await fetch(`${getServerUrl()}${path}`, {
                ...rest, headers: h, body: json !== undefined ? JSON.stringify(json) : rest.body,
            })
        }
    } catch {
        return { ok: false, status: 0, error: 'Could not reach the server. Check the connection and try again.' }
    }
    let body: unknown = null
    try { body = await res.json() } catch { /* empty or non-JSON body */ }
    if (!res.ok) return { ok: false, status: res.status, error: messageFor(res.status, body) }
    return { ok: true, data: body as T }
}

/** Accept `[...]` or `{key: [...]}`: the contract writes lists bare, older
 *  endpoints in this API wrap them. */
function asList<T>(data: unknown, key: string): T[] {
    if (Array.isArray(data)) return data as T[]
    const inner = (data as Record<string, unknown> | null)?.[key]
    return Array.isArray(inner) ? (inner as T[]) : []
}

async function list<T>(path: string, key: string, mode: Mode = 'app'): Promise<ApiResult<T[]>> {
    const r = await call<unknown>(path, {}, mode)
    return r.ok ? { ok: true, data: asList<T>(r.data, key) } : r
}

/** Links come back as a full URL or a path; either way, make it pasteable. */
export function absoluteUrl(u: string): string {
    if (/^https?:\/\//.test(u)) return u
    if (typeof window === 'undefined') return u
    return window.location.origin + (u.startsWith('/') ? u : `/${u}`)
}

// ── Types ────────────────────────────────────────────────────────────────

export interface UserRef { id: string; username: string; email: string | null; display_name: string | null }

export interface AccountRow extends UserRef {
    disabled?: boolean
    created_at?: string | null
    last_login_at?: string | null
    is_founder?: boolean
    is_staff?: boolean
}

export interface SessionRow { id: string; label: string; created_at: string | null; last_seen_at: string | null; current: boolean }

export interface InvitePreview {
    workspace_name: string
    workspace_kind: WorkspaceKind
    role: MemberRole
    title: string | null
    email_locked: boolean
    expires_at: string | null
    invited_by: string | null
}

export interface IssuedSession { token: string; user: AuthUser; expires_at: string }

export interface Member {
    id: string
    user: UserRef
    role: MemberRole
    area: GeoPolygon | null
    title: string | null
    workspace_id: string
    /** Set when the membership is held on an ancestor (a workspace id). */
    inherited_from?: string | null
}

export interface Invite {
    id: string
    workspace_id: string
    role: MemberRole
    area: GeoPolygon | null
    title: string | null
    email: string | null
    created_by?: string | null
    created_at: string | null
    expires_at: string | null
    accepted_at?: string | null
    revoked_at?: string | null
}

export interface WorkspaceDrone {
    id: string
    hardware_uid: string
    name: string
    is_simulated: boolean
    last_seen: string | null
    workspace_id?: string | null
}

export interface StaffAccount { user: AccountRow; memberships: Membership[] }

export interface AuditEvent {
    id: string
    at: string
    actor_id: string | null
    actor_name: string | null
    workspace_id: string | null
    action: string
    target_type: string | null
    target_id: string | null
    detail: Record<string, unknown> | null
    ip: string | null
}

// ── Account ──────────────────────────────────────────────────────────────

export const updateMe = (body: { display_name?: string; email?: string }) =>
    call<{ user?: AuthUser }>('/api/auth/me', { method: 'PATCH', json: body })

export const changePassword = (current_password: string, new_password: string) =>
    call<unknown>('/api/auth/me/password', { method: 'POST', json: { current_password, new_password } })

export const listSessions = () => list<SessionRow>('/api/auth/sessions', 'sessions')

export const revokeSession = (id: string) =>
    call<unknown>(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const revokeOtherSessions = () =>
    call<unknown>('/api/auth/sessions/revoke-others', { method: 'POST' })

// ── Invites and resets (public pages) ────────────────────────────────────

const tok = (t: string) => encodeURIComponent(t)

export const previewInvite = (token: string) =>
    call<InvitePreview>(`/api/auth/invites/${tok(token)}`, {}, 'public')

/** Signed in: empty body, adds the membership to the current account. */
export const acceptInviteSignedIn = (token: string) =>
    call<unknown>(`/api/auth/invites/${tok(token)}/accept`, { method: 'POST', json: {} }, 'public')

/** Signed out: creates the account and returns a session like login does. */
export const acceptInviteSignUp = (token: string, body: { display_name: string; email: string; password: string; username?: string }) =>
    call<IssuedSession>(`/api/auth/invites/${tok(token)}/accept`, { method: 'POST', json: body }, 'public')

export const resetPassword = (token: string, password: string) =>
    call<unknown>(`/api/auth/reset/${tok(token)}`, { method: 'POST', json: { password } }, 'public')

// ── Accounts (founders) ──────────────────────────────────────────────────

export const listUsers = () => list<AccountRow>('/api/auth/users', 'users')

export const updateUser = (id: string, body: { disabled?: boolean; display_name?: string }) =>
    call<unknown>(`/api/auth/users/${encodeURIComponent(id)}`, { method: 'PATCH', json: body })

export const deleteUser = (id: string) =>
    call<unknown>(`/api/auth/users/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const issueResetLink = (id: string) =>
    call<{ url: string; expires_at: string | null }>(`/api/auth/users/${encodeURIComponent(id)}/reset-link`, { method: 'POST' })

// ── Workspaces ───────────────────────────────────────────────────────────

const ws = (id: string) => `/api/workspaces/${encodeURIComponent(id)}`

export const listWorkspaces = () => list<WorkspaceInfo>('/api/workspaces', 'workspaces')

export const createWorkspace = (body: { name: string; kind: WorkspaceKind; parent_id: string | null; operating_area?: GeoPolygon | null }) =>
    call<WorkspaceInfo | { workspace: WorkspaceInfo }>('/api/workspaces', { method: 'POST', json: body })

export const getWorkspace = (id: string) => call<WorkspaceInfo>(ws(id))

export const updateWorkspace = (id: string, body: { name?: string; operating_area?: GeoPolygon | null; disabled?: boolean }) =>
    call<unknown>(ws(id), { method: 'PATCH', json: body })

export const deleteWorkspace = (id: string) => call<unknown>(ws(id), { method: 'DELETE' })

export const listMembers = (id: string) => list<Member>(`${ws(id)}/members`, 'members')

export const addMember = (id: string, body: { login: string; role: MemberRole; area?: GeoPolygon | null; title?: string }) =>
    call<unknown>(`${ws(id)}/members`, { method: 'POST', json: body })

export const updateMember = (id: string, mid: string, body: { role?: MemberRole; area?: GeoPolygon | null; title?: string }) =>
    call<unknown>(`${ws(id)}/members/${encodeURIComponent(mid)}`, { method: 'PATCH', json: body })

export const removeMember = (id: string, mid: string) =>
    call<unknown>(`${ws(id)}/members/${encodeURIComponent(mid)}`, { method: 'DELETE' })

export const listInvites = (id: string) => list<Invite>(`${ws(id)}/invites`, 'invites')

export const createInvite = (id: string, body: { role: MemberRole; email?: string; area?: GeoPolygon | null; title?: string; expires_days?: number }) =>
    call<{ invite: Invite; url: string }>(`${ws(id)}/invites`, { method: 'POST', json: body })

export const revokeInvite = (id: string, iid: string) =>
    call<unknown>(`${ws(id)}/invites/${encodeURIComponent(iid)}`, { method: 'DELETE' })

export const listWorkspaceDrones = (id: string) => list<WorkspaceDrone>(`${ws(id)}/drones`, 'drones')

export const moveDrone = (droneId: string, workspace_id: string) =>
    call<unknown>(`/api/drones/${encodeURIComponent(droneId)}/workspace`, { method: 'POST', json: { workspace_id } })

/** Staff accounts with every membership. Rows may come as {user, memberships}
 *  or as a flat account carrying `memberships`; both normalise to the first. */
export async function listStaff(): Promise<ApiResult<StaffAccount[]>> {
    const r = await list<Record<string, unknown>>('/api/staff', 'staff')
    if (!r.ok) return r
    return {
        ok: true,
        data: r.data.map(row => {
            const memberships = (Array.isArray(row.memberships) ? row.memberships : []) as Membership[]
            const user = (row.user && typeof row.user === 'object' ? row.user : row) as AccountRow
            return { user, memberships }
        }),
    }
}

export async function listAudit(q: { workspace_id?: string; limit?: number; before?: string } = {}): Promise<ApiResult<AuditEvent[]>> {
    const p = new URLSearchParams()
    if (q.workspace_id) p.set('workspace_id', q.workspace_id)
    if (q.limit) p.set('limit', String(q.limit))
    if (q.before) p.set('before', q.before)
    const qs = p.toString()
    return list<AuditEvent>(`/api/audit${qs ? `?${qs}` : ''}`, 'events')
}

// ── Zones (layered) ──────────────────────────────────────────────────────

export interface ZoneBody {
    name?: string
    zone_class?: ZoneClass
    geometry?: GeoPolygon
    ceiling_m?: number | null
    active?: boolean
    layer?: ZoneLayer
    workspace_id?: string | null
}

export const createZone = (body: ZoneBody) =>
    call<ZoneFeature>('/api/zones', { method: 'POST', json: body })

export const updateZone = (id: string, body: ZoneBody) =>
    call<unknown>(`/api/zones/${encodeURIComponent(id)}`, { method: 'PATCH', json: body })

export const deleteZone = (id: string) =>
    call<unknown>(`/api/zones/${encodeURIComponent(id)}`, { method: 'DELETE' })

// ── Small shared formatting ──────────────────────────────────────────────

export function personName(u: { display_name?: string | null; username: string } | null | undefined): string {
    if (!u) return '-'
    return u.display_name?.trim() || u.username
}

export function fmtWhen(iso: string | null | undefined): string {
    if (!iso) return '-'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '-'
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

/** An invite still waiting for someone: not accepted, revoked or expired. */
export function isPendingInvite(i: Invite, now = Date.now()): boolean {
    if (i.accepted_at || i.revoked_at) return false
    return !i.expires_at || new Date(i.expires_at).getTime() > now
}

/**
 * Copy text from inside a click handler. The clipboard API needs the user
 * gesture, so writeText is started synchronously; when it is missing or
 * refused (plain http, an old webview) the text in `fallback` is selected so
 * Ctrl+C works. Resolves to 'copied' or 'selected'.
 */
export async function copyText(text: string, fallback?: HTMLInputElement | null): Promise<'copied' | 'selected'> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text)
            return 'copied'
        }
    } catch { /* fall through to selection */ }
    if (fallback) { fallback.focus(); fallback.select() }
    return 'selected'
}
