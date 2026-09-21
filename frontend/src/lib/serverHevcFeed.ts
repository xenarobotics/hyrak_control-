'use client'
// Bit-exact air-unit video: the backend streams the unit's OWN H.265 access
// units (/api/video/feeds/<port>/hevc, framed like the desktop's annexb.ts)
// and WebCodecs decodes them in the browser - no server re-encode, the same
// picture a gst window shows. Only usable where Chromium can decode HEVC
// (the desktop shell enables PlatformHEVCDecoderSupport; hardware only), so
// support is probed once and everything falls back to WebRTC without it.
import { useEffect, useState } from 'react'
import { getServerUrl } from '@/lib/server-url'
import { getAirUnitVideoPort, getVideoSource } from '@/lib/videoSource'

export const AIR_UNIT_PORT_EVENT = 'hyrak-air-unit-port'
const DISABLE_KEY = 'hyrak-server-hevc-disabled'

let supported: boolean | null = null
let probe: Promise<boolean> | null = null

export function probeHevcSupport(): Promise<boolean> {
    if (supported !== null) return Promise.resolve(supported)
    if (probe) return probe
    probe = (async () => {
        try {
            if (typeof window === 'undefined' || !('VideoDecoder' in window)) return (supported = false)
            const r = await VideoDecoder.isConfigSupported({ codec: 'hev1.1.6.L120.B0', hardwareAcceleration: 'prefer-hardware' })
            supported = !!r.supported
        } catch { supported = false }
        return supported
    })()
    return probe
}

/** Sync view of the probe result (false until probed). */
export function isServerHevcReady(): boolean {
    return supported === true && !disabled()
}

function disabled(): boolean {
    try { return localStorage.getItem(DISABLE_KEY) === '1' } catch { return false }
}
export function setServerHevcDisabled(v: boolean): void {
    try { v ? localStorage.setItem(DISABLE_KEY, '1') : localStorage.removeItem(DISABLE_KEY) } catch { /* private mode */ }
}

// THE ROUTE MATTERS MORE THAN THE CODEC. The app talks to the backend
// through api.xenarobotics.com (Cloudflare tunnel) - fine for JSON, fatal
// for a live byte stream: every chunk leaves the laptop, crosses
// Cloudflare's buffering proxy and comes back, hundreds of ms while the
// WebRTC leg was going host->host on the same machine. When the backend is
// reachable at localhost (the ground-station laptop is also the viewer),
// the feed is fetched from there directly: localhost is exempt from
// mixed-content blocking, and CORS already allows the app origin.
const LOCAL_BASES = ['http://localhost:8001', 'http://127.0.0.1:8001']
let feedBase: string | null = null
let feedBaseProbe: Promise<string> | null = null

export function resolveFeedBase(): Promise<string> {
    if (feedBase) return Promise.resolve(feedBase)
    if (feedBaseProbe) return feedBaseProbe
    feedBaseProbe = (async () => {
        const remote = getServerUrl()
        if (typeof window === 'undefined') return (feedBase = remote)
        if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(remote)) return (feedBase = remote)
        for (const base of LOCAL_BASES) {
            try {
                const r = await fetch(`${base}/api/video/feeds`, { signal: AbortSignal.timeout(800), cache: 'no-store' })
                if (r.ok) { console.info('[feed] backend reachable locally, streaming from', base); return (feedBase = base) }
            } catch { /* not local */ }
        }
        return (feedBase = remote)
    })()
    return feedBaseProbe
}

export function serverHevcUrl(port: number): string {
    return `${feedBase ?? getServerUrl()}/api/video/feeds/${port}/hevc`
}

export function serverH264Url(port: number): string {
    return `${feedBase ?? getServerUrl()}/api/video/feeds/${port}/h264`
}

export type ServerFeed = { url: string; codec: 'hevc' | 'h264' }

/** True once WebCodecs itself is known to exist (H.264 decode is universal
 *  in Chromium; only HEVC needs the probe). */
export function isServerFeedReady(): boolean {
    return typeof window !== 'undefined' && 'VideoDecoder' in window && !disabled()
}

/** The bit-exact HEVC feed when this Chromium can decode HEVC, else the
 *  once-transcoded H.264 feed (GPU on the server, colour flags preserved);
 *  null when the source is not the server-read air unit. Follows unit
 *  switches (port changes). */
export function useServerFeed(active: boolean): ServerFeed | null {
    const [probed, setProbed] = useState(supported !== null && feedBase !== null)
    const [port, setPort] = useState(() => getAirUnitVideoPort())
    useEffect(() => { Promise.all([probeHevcSupport(), resolveFeedBase()]).then(() => setProbed(true)) }, [])
    useEffect(() => {
        const on = () => setPort(getAirUnitVideoPort())
        window.addEventListener(AIR_UNIT_PORT_EVENT, on)
        return () => window.removeEventListener(AIR_UNIT_PORT_EVENT, on)
    }, [])
    if (!active || !probed || getVideoSource() !== 'air_unit_udp' || !isServerFeedReady()) return null
    return supported ? { url: serverHevcUrl(port), codec: 'hevc' } : { url: serverH264Url(port), codec: 'h264' }
}
