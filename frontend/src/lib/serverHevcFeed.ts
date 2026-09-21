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

export function serverHevcUrl(port: number): string {
    return `${getServerUrl()}/api/video/feeds/${port}/hevc`
}

/** The feed URL when the source is the server-read air unit AND the browser
 *  can decode HEVC; null otherwise. Follows unit switches (port changes). */
export function useServerHevcFeed(active: boolean): string | null {
    const [ready, setReady] = useState(isServerHevcReady())
    const [port, setPort] = useState(() => getAirUnitVideoPort())
    useEffect(() => { probeHevcSupport().then(() => setReady(isServerHevcReady())) }, [])
    useEffect(() => {
        const on = () => setPort(getAirUnitVideoPort())
        window.addEventListener(AIR_UNIT_PORT_EVENT, on)
        return () => window.removeEventListener(AIR_UNIT_PORT_EVENT, on)
    }, [])
    if (!active || !ready || getVideoSource() !== 'air_unit_udp') return null
    return serverHevcUrl(port)
}
