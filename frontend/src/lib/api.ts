/**
 * fetch() for the HYRAK API: prefixes the server URL, attaches the bearer
 * token, and sends the browser to /login when the server answers 401.
 *
 *     const r = await apiFetch('/api/zones', { method: 'POST', json: { ... } })
 */
import { authHeaders, redirectToLogin } from './auth'
import { getServerUrl } from './server-url'

export interface ApiInit extends RequestInit {
    /** JSON body shorthand - sets Content-Type and stringifies. */
    json?: unknown
}

export async function apiFetch(path: string, init: ApiInit = {}): Promise<Response> {
    const { json, headers, ...rest } = init
    const h: Record<string, string> = authHeaders(
        Object.fromEntries(new Headers(headers ?? {}).entries()),
    )
    let body = rest.body
    if (json !== undefined) {
        h['Content-Type'] = 'application/json'
        body = JSON.stringify(json)
    }
    const url = path.startsWith('http') ? path : `${getServerUrl()}${path}`
    const res = await fetch(url, { ...rest, body, headers: h })
    if (res.status === 401) redirectToLogin()
    return res
}

/** apiFetch + JSON parse; a non-JSON reply (proxy HTML page) becomes {}. */
export async function apiJson<T = Record<string, unknown>>(path: string, init: ApiInit = {}): Promise<{ ok: boolean; status: number; data: T }> {
    const res = await apiFetch(path, init)
    let data = {} as T
    try { data = await res.json() } catch { /* empty or HTML body */ }
    return { ok: res.ok, status: res.status, data }
}
