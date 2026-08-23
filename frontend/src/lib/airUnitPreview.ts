'use client'

// Local preview of the air unit INSIDE the app - the pilot's picture without
// the round trip.
//
// With air_unit_datachannel, the video the operator used to watch had been to
// the server and back: uplink + server H.265 decode + server H.264 re-encode +
// downlink + two jitter buffers, ~300-500ms on a good network and worse
// through TURN-over-TCP - while gst-decode.sh reading the SAME udp:5600 shows
// a 10ms picture. This module closes that gap in-app: the rtsp-relay bridge
// runs in preview-only mode (uplink: false) against a private fan-out copy of
// the RTP, decodes it one hop from the radio, and serves fMP4 over loopback
// HTTP to a <video> element. The DataChannel keeps feeding the server for AI;
// this is only about where the operator's EYES get their frames.
//
// The preview branch is transcoded to H.264 (transcodePreview) because the air
// unit is H.265 and Chromium ships no software HEVC decoder - an H.265 preview
// dies with MEDIA_ERR_SRC_NOT_SUPPORTED on any machine without hardware HEVC.
// The DataChannel uplink is untouched by this: it still carries the original
// H.265 bytes.
//
// Port: the sender bridge owns udp:5600 exclusively (bindExclusive - two
// listeners on one unicast port silently fight, measured 200/0). The
// operator's EXTERNAL viewer (gst-decode, QGC video) gets the fan-out port;
// this preview needs its own third copy, previewFanoutPort, because it is a
// second listener with the same one-port-one-listener constraint.

import { useEffect, useState } from 'react'
import { isDesktopApp, nativeBridge, type BridgeEvent } from '@/lib/nativeBridge'
import { getAirUnitVideoPort, getAirUnitFanoutPort, getPreviewMaxHeight } from '@/lib/videoSource'

// Distinct from RTSP_RELAY_BRIDGE_ID on purpose: the SIYI relay and this
// preview are both rtsp-relay bridge instances (the bridge keeps a Map by id)
// and must be able to coexist - and Settings' relay status display must not
// light up because a preview started.
export const AIR_UNIT_PREVIEW_BRIDGE_ID = 'air-unit-preview'

/** The loopback port the preview ffmpeg listens on. 5602 by convention
 *  (5600 source, 5601 default fan-out), stepped past any collision with the
 *  user's configured ports. Deterministic: the sender bridge and the preview
 *  are started by different call sites and must agree without negotiating. */
export function getAirUnitPreviewPort(): number {
    const main = getAirUnitVideoPort()
    const fanout = getAirUnitFanoutPort()
    let port = 5602
    while (port === main || port === fanout) port++
    return port
}

// Module scope, not hook state: the preview outlives any one component (Fly
// and Modules both show it, Settings may observe it) and the value must be
// readable synchronously by useWebRTC when it decides on clientOverlay.
let previewUrl: string | null = null
// The UDP port the preview ffmpeg ACTUALLY bound. A 0.1.41+ bridge may step
// past a busy port (udpPortAutoPick) and reports its choice in meta.udpPort;
// the sender's fan-out copy must aim here, not at the preference.
let actualPreviewPort: number | null = null
const subscribers = new Set<(url: string | null) => void>()

function setPreviewUrl(url: string | null): void {
    if (url === previewUrl) return
    previewUrl = url
    for (const fn of subscribers) fn(url)
}

export function getAirUnitPreviewUrl(): string | null {
    return previewUrl
}

/** Where the sender's fan-out copy must go: the port the preview ffmpeg
 *  actually bound (only known after startAirUnitPreview resolves), falling
 *  back to the deterministic preference for bridges that don't report it. */
export function getAirUnitPreviewActualPort(): number {
    return actualPreviewPort ?? getAirUnitPreviewPort()
}

if (typeof window !== 'undefined' && isDesktopApp()) {
    nativeBridge()?.onEvent((event: BridgeEvent) => {
        if (event.bridge !== 'rtsp-relay' || event.id !== AIR_UNIT_PREVIEW_BRIDGE_ID) return
        const meta = event.meta ?? {}
        // Only LIFECYCLE events carry a `connected` field. The bridge also
        // emits informational ones - notably {codec, streamInfo} about a
        // second after ffmpeg reads the stream - and treating those as a
        // shutdown wiped previewUrl right after every successful start:
        // that was exactly the field failure ("preview=none" with the bridge
        // healthy), and it never appeared locally because the repro drove
        // the bridge without this listener.
        if (!('connected' in meta)) return
        if (meta.connected) {
            setPreviewUrl(meta.previewUrl ? String(meta.previewUrl) : null)
        } else if (meta.reconnecting) {
            // Keep the URL: the bridge restarts its own ffmpeg and the HTTP
            // server survives, so the <video> recovers in place.
            console.error('[air-unit-preview] ffmpeg exited, bridge is retrying:',
                meta.log ? String(meta.log).slice(-300) : '(no output)')
        } else {
            // Gave up (5 fast failures). Loud, with ffmpeg's own words -
            // this is the only way the cause reaches server-side logs.
            console.error('[air-unit-preview] preview died:',
                meta.error ? String(meta.error) : '(no error text)',
                meta.log ? String(meta.log).slice(-300) : '')
            setPreviewUrl(null)
        }
    })
}

/** Starts the preview-only relay. Failure is deliberately non-fatal - a
 *  missing preview must never take down the stream that IS working; the
 *  caller falls back to the server's return feed exactly as before. */
export async function startAirUnitPreview(): Promise<string | null> {
    if (!isDesktopApp()) return null
    const requestedPort = getAirUnitPreviewPort()
    actualPreviewPort = null
    try {
        const result = await nativeBridge()?.start('rtsp-relay', AIR_UNIT_PREVIEW_BRIDGE_ID, {
            source: 'udp',
            udpPort: requestedPort,
            // 0.1.41+: probe for a free port near the preference instead of
            // dying in a silent restart loop when something holds it.
            // Older bridges ignore the flag and just use udpPort.
            udpPortAutoPick: true,
            url: '',
            uplink: false,
            preview: true,
            transcodePreview: 'h264',
            // 0 = native. Explicit so it overrides the bridge's own default
            // without a rebuild - see getPreviewMaxHeight().
            previewMaxHeight: getPreviewMaxHeight(),
        })
        if (!result?.ok) {
            // console.error, not warn: Next's dev server forwards browser
            // errors into frontend.log with a [browser] prefix, which is the
            // only way a remote client's failure reaches server-side logs.
            console.error('[air-unit-preview] failed to start:', result?.error ?? 'no result from bridge')
            return null
        }
        const url = result.meta?.previewUrl
        setPreviewUrl(typeof url === 'string' && url ? url : null)
        if (!previewUrl) console.error('[air-unit-preview] bridge started but returned no previewUrl')
        const bound = result.meta?.udpPort
        actualPreviewPort = typeof bound === 'number' && bound > 0 ? bound : requestedPort
        return previewUrl
    } catch (e) {
        console.error('[air-unit-preview] failed to start:', e)
        return null
    }
}

export async function stopAirUnitPreview(): Promise<void> {
    setPreviewUrl(null)
    if (!isDesktopApp()) return
    try {
        await nativeBridge()?.stop('rtsp-relay', AIR_UNIT_PREVIEW_BRIDGE_ID)
    } catch { /* not running */ }
}

/** Reactive view of the preview URL for components. */
export function useAirUnitPreview(): string | null {
    // Starts null to match server-rendered HTML (same hydration reasoning as
    // VideoStream's serverSourced state), then syncs after mount.
    const [url, setUrl] = useState<string | null>(null)
    useEffect(() => {
        setUrl(previewUrl)
        subscribers.add(setUrl)
        return () => { subscribers.delete(setUrl) }
    }, [])
    return url
}
