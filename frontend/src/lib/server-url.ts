/**
 * Resolve the backend server URL at runtime.
 *
 * In order:
 *   1. window.__HYRAK_API__ - a runtime override (set by the desktop shell,
 *      an inline script, or by hand in the console) so one build can be
 *      pointed at any backend without rebuilding.
 *   2. NEXT_PUBLIC_API_URL / NEXT_PUBLIC_SERVER_URL - build-time overrides.
 *   3. The hostname table:
 *        dev.xenarobotics.com  ->  https://api.xenarobotics.com
 *        localhost / 127.0.0.1 ->  http://localhost:8001
 *        anything else         ->  same protocol + host on port 8001
 *
 * This lets the same build work on localhost AND through the Cloudflare tunnel
 * without restarting Next.js or changing .env.local.
 */

/** The backend's default port when it runs next to the page. */
export const DEFAULT_API_PORT = 8001
export const LOCAL_API_URL = `http://localhost:${DEFAULT_API_PORT}`

declare global {
  interface Window {
    /** Runtime API base override, e.g. "https://api.example.com" (no trailing slash). */
    __HYRAK_API__?: string
  }
}

function clean(url: string | undefined | null): string | null {
  const v = (url ?? '').trim().replace(/\/+$/, '')
  return /^https?:\/\//.test(v) ? v : null
}

const HOST_TABLE: Record<string, string> = {
  'dev.xenarobotics.com': 'https://api.xenarobotics.com',
  'localhost': LOCAL_API_URL,
  '127.0.0.1': `http://127.0.0.1:${DEFAULT_API_PORT}`,
}

export function getServerUrl(): string {
  // Runtime override wins over everything.
  if (typeof window !== 'undefined') {
    const rt = clean(window.__HYRAK_API__)
    if (rt) return rt
  }

  // Build-time overrides.
  const env = clean(process.env.NEXT_PUBLIC_API_URL) ?? clean(process.env.NEXT_PUBLIC_SERVER_URL)
  if (env) return env

  // SSR / Node.js - no window object
  if (typeof window === 'undefined') {
    return LOCAL_API_URL
  }

  const host = window.location.hostname
  const mapped = HOST_TABLE[host]
  if (mapped) return mapped

  // Fallback: same host, default API port
  return `${window.location.protocol}//${host}:${DEFAULT_API_PORT}`
}
