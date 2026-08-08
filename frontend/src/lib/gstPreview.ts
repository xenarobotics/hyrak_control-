'use client'

// Drives the GStreamer air-unit pipeline (desktop/src/bridges/gstreamerBridge.ts).
//
// Unlike every other mode, ONE process does both jobs: the pilot's local
// preview and the SRT uplink that feeds the server's AI, split with a `tee`.
// So this module starts a single bridge and the caller needs no separate
// sender — which is the point. See the `air_unit_gst` comment in
// lib/videoSource.ts for why that matters.
//
// Ordering, same constraint as the other relay modes: the backend allocates a
// listener BEFORE the client starts pushing, and the client must be pushing
// before the browser's offer, because the offer handler waits on real frames.
//
//   allocateRelay() -> startGstPipeline() -> (caller sends the offer)

import { useEffect, useState } from 'react'
import { isDesktopApp, nativeBridge, type BridgeEvent } from '@/lib/nativeBridge'
import { getAirUnitVideoPort, getGstJitterMs, getGstAccel, getPreviewMaxHeight } from '@/lib/videoSource'
import type { RelayAllocation } from '@/hooks/useRtspRelayBridge'

export const GST_BRIDGE_ID = 'air-unit-gst'

export interface GstStatus {
    /** True when the preview URL serves framed access units (WebCodecs),
     *  false when it serves fragmented MP4 for a <video> element. */
    webcodecs?: boolean
    /** 'hardware' or 'software' — what is ACTUALLY running, not what was asked
     *  for. A silent demotion to software otherwise looks like "hardware
     *  acceleration didn't help". */
    accel?: string
    hardwareAvailable?: boolean
    demoted?: boolean
    error?: string
    previewUrl?: string | null
}

let previewUrl: string | null = null
let lastStatus: GstStatus | null = null
const subscribers = new Set<(s: GstStatus | null) => void>()

function publish(s: GstStatus | null) {
    lastStatus = s
    previewUrl = s?.previewUrl ?? null
    for (const fn of subscribers) fn(s)
}

export function getGstPreviewUrl(): string | null {
    return previewUrl
}

let lastError: string | null = null
export function getLastGstError(): string | null {
    return lastError
}

if (typeof window !== 'undefined' && isDesktopApp()) {
    nativeBridge()?.onEvent((event: BridgeEvent) => {
        if (event.bridge !== 'gstreamer-preview' || event.id !== GST_BRIDGE_ID) return
        const meta = event.meta ?? {}
        // Only lifecycle events carry `connected`. Informational ones must not
        // be mistaken for a shutdown — that exact bug wiped previewUrl one
        // second after every successful start in the ffmpeg preview, and made
        // the whole local-view feature silently inert in the field.
        if (!('connected' in meta)) return
        if (meta.connected) {
            if (meta.demoted) {
                console.warn('[air-unit-gst] hardware decode failed, running software:', meta.error)
            }
            publish({
                accel: meta.accel ? String(meta.accel) : undefined,
                hardwareAvailable: !!meta.hardwareAvailable,
                demoted: !!meta.demoted,
                previewUrl: meta.previewUrl ? String(meta.previewUrl) : previewUrl,
                webcodecs: !!meta.webcodecs,
            })
            lastError = null
        } else {
            lastError = meta.error ? String(meta.error) : 'GStreamer pipeline stopped'
            console.error('[air-unit-gst] pipeline died:', lastError,
                meta.log ? String(meta.log).slice(-300) : '')
            publish(null)
        }
    })
}

/** Starts the pipeline. `alloc` comes from allocateRelay() and supplies the
 *  SRT destination; omit it for a preview-only run (no AI uplink). */
export async function startGstPipeline(alloc?: RelayAllocation): Promise<string | null> {
    if (!isDesktopApp()) {
        throw new Error('GStreamer video needs the HYRAK desktop app — a browser tab cannot run a pipeline.')
    }
    await stopGstPipeline()
    lastError = null
    const result = await nativeBridge()?.start('gstreamer-preview', GST_BRIDGE_ID, {
        udpPort: getAirUnitVideoPort(),
        jitterMs: getGstJitterMs(),
        accel: getGstAccel(),
        maxHeight: getPreviewMaxHeight(),
        // Framed access units for WebCodecs instead of fMP4 — removes the
        // browser's progressive-playback buffer entirely.
        webcodecs: true,
        ...(alloc
            ? {
                srtHost: alloc.host,
                srtPort: alloc.port,
                srtLatencyMs: alloc.latencyMs,
                streamId: alloc.streamId,
            }
            : {}),
    })
    if (!result?.ok) {
        const msg = result?.error ?? 'Could not start the GStreamer pipeline'
        lastError = msg
        throw new Error(msg)
    }
    const url = result.meta?.previewUrl
    publish({
        accel: result.meta?.accel ? String(result.meta.accel) : undefined,
        hardwareAvailable: !!result.meta?.hardwareAvailable,
        previewUrl: typeof url === 'string' && url ? url : null,
        // From the bridge, not from what we asked for — an older desktop
        // build ignores the flag and serves fMP4, and rendering that through
        // the WebCodecs parser produces a black pane with no error.
        webcodecs: !!result.meta?.webcodecs,
    })
    return previewUrl
}

export async function stopGstPipeline(): Promise<void> {
    publish(null)
    if (!isDesktopApp()) return
    try {
        await nativeBridge()?.stop('gstreamer-preview', GST_BRIDGE_ID)
    } catch { /* not running */ }
}

/** Reactive status for components. */
export function useGstPreview(): GstStatus | null {
    // Starts null to match server-rendered HTML, then syncs after mount —
    // same hydration reasoning as the other video hooks.
    const [status, setStatus] = useState<GstStatus | null>(null)
    useEffect(() => {
        setStatus(lastStatus)
        subscribers.add(setStatus)
        return () => { subscribers.delete(setStatus) }
    }, [])
    return status
}
