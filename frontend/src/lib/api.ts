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

/** How long a download's object URL outlives the click. Revoking at once
 *  can cancel the save in some browsers; a minute is plenty to start it. */
const DOWNLOAD_URL_TTL_MS = 60_000

function filenameFrom(res: Response): string | null {
    const cd = res.headers.get('Content-Disposition') ?? ''
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd)
    if (star) { try { return decodeURIComponent(star[1].trim()) } catch { /* fall through */ } }
    const plain = /filename="?([^";]+)"?/i.exec(cd)
    return plain ? plain[1].trim() : null
}

/**
 * Download a file that needs the bearer: an <a href> cannot send the
 * header, so fetch it into a blob and click an object URL. The server's
 * Content-Disposition name wins over `fallbackName`. Returns false on a
 * non-OK answer (401 already went to /login through apiFetch).
 */
export async function apiDownload(path: string, fallbackName: string): Promise<boolean> {
    const res = await apiFetch(path)
    if (!res.ok) return false
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filenameFrom(res) ?? fallbackName
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_TTL_MS)
    return true
}

/**
 * A short-lived URL for a GET route that must load without a header (an
 * MJPEG stream in an <img>): POST /api/auth/url-ticket, then `?ticket=`.
 * The ticket is bound to this exact path and lasts 60 s, but may be used
 * again within that window, so an <img> reconnect can reuse it; after that
 * ask for a new URL. Null when the server refused (no access, or the route
 * does not take tickets).
 */
export async function ticketedUrl(path: string): Promise<string | null> {
    const { ok, data } = await apiJson<{ ticket?: string }>('/api/auth/url-ticket', {
        method: 'POST', json: { path },
    })
    if (!ok || !data.ticket) return null
    return `${getServerUrl()}${path}?ticket=${encodeURIComponent(data.ticket)}`
}
