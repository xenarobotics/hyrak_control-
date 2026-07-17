/**
 * Resolve the backend server URL at runtime.
 *
 * - If NEXT_PUBLIC_SERVER_URL is set explicitly, use it (build-time override).
 * - Otherwise, detect from browser location:
 *     - dev.xenarobotics.com  →  https://api.xenarobotics.com
 *     - localhost / 127.0.0.1 →  http://localhost:8001
 *     - anything else         →  same protocol + host on port 8001
 *
 * This lets the same build work on localhost AND through the Cloudflare tunnel
 * without restarting Next.js or changing .env.local.
 */
export function getServerUrl(): string {
  // Build-time override always wins
  if (process.env.NEXT_PUBLIC_SERVER_URL) {
    return process.env.NEXT_PUBLIC_SERVER_URL
  }

  // SSR / Node.js — no window object
  if (typeof window === 'undefined') {
    return 'http://localhost:8001'
  }

  const host = window.location.hostname

  // Tunnel: dev.xenarobotics.com → api.xenarobotics.com
  if (host === 'dev.xenarobotics.com') {
    return 'https://api.xenarobotics.com'
  }

  // Local development
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:8001'
  }

  // Fallback: same host, port 8001
  return `${window.location.protocol}//${host}:8001`
}
