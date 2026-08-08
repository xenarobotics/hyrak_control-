'use client'

// Start/stop for the zero-transcode RTSP relay
// (desktop/src/bridges/rtspRelayBridge.ts). Desktop-only: it needs a native
// ffmpeg process, which a browser tab structurally cannot have.
//
// Order matters and is the reason this is a hook rather than two calls at
// the stream site: the backend has to allocate a listener BEFORE the laptop
// starts pushing, and the laptop has to be pushing before the WebRTC offer
// goes out, because the offer handler waits on real frames arriving. So:
//
//   allocate() -> bridge.start() -> (caller sends the offer)
//
// Shared bridge id, same convention as useAirUnitVideoBridge: there is only
// ever one relay running, so Settings and Fly observe the same one.

import { useEffect, useState } from 'react'
import { isDesktopApp, nativeBridge, type BridgeEvent } from '@/lib/nativeBridge'
import { getSocket } from '@/lib/socket'
import {
    getSiyiRtspUrl,
    getRelayTransport,
    getRelayLatencyMs,
    getRtspTransport,
    getPreviewFragDurationUs,
    type RelayTransport,
} from '@/lib/videoSource'

export const RTSP_RELAY_BRIDGE_ID = 'rtsp-relay-bridge'

export interface RtspRelayStatus {
    msg: string
    error?: boolean
    reconnecting?: boolean
    log?: string
}

export interface RelayAllocation {
    host: string
    port: number
    transport: RelayTransport
    latencyMs: number
    streamId: string
    hostConfigured: boolean
}

// Allocation goes over the socket, not HTTP: the backend keys sessions by
// socket id and the browser never learns its own session_id, so an HTTP
// endpoint would have nothing to identify itself with.
const ALLOCATE_TIMEOUT_MS = 10000

export async function allocateRelay(): Promise<RelayAllocation> {
    const socket = getSocket()
    const reply = await new Promise<RelayAllocation & { error?: string }>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error('Server did not answer the relay allocation request')),
            ALLOCATE_TIMEOUT_MS,
        )
        socket.emit(
            'allocate_video_relay',
            { transport: getRelayTransport(), latencyMs: getRelayLatencyMs() },
            (res: RelayAllocation & { error?: string }) => {
                clearTimeout(timer)
                resolve(res)
            },
        )
    })
    if (!reply || reply.error) throw new Error(reply?.error || 'Relay allocation failed')
    return reply
}

// The laptop's ffmpeg knows within ~a second that it can't reach the relay
// host; the server only finds out when its 25s wait expires. Without this,
// the operator is shown the slow, vague server-side timeout instead of the
// fast, specific client-side cause ("can't reach 10.x.x.x:9000 — some
// networks block UDP"). Recorded at module scope because the failure arrives
// on the bridge event channel, asynchronously, after start() has returned ok
// (spawning ffmpeg succeeds long before connecting does).
let lastRelayError: string | null = null

export function getLastRelayError(): string | null {
    return lastRelayError
}

export function clearLastRelayError(): void {
    lastRelayError = null
}

if (typeof window !== 'undefined' && isDesktopApp()) {
    nativeBridge()?.onEvent((event: BridgeEvent) => {
        if (event.bridge !== 'rtsp-relay') return
        const meta = event.meta ?? {}
        if (meta.error) lastRelayError = String(meta.error)
        else if (meta.connected) lastRelayError = null
    })
}

export function releaseRelay(): void {
    // Best-effort: the socket disconnect path releases it anyway, this just
    // frees the port and its ffmpeg sooner.
    try {
        getSocket().emit('release_video_relay')
    } catch { /* socket already gone */ }
}

export function useRtspRelayBridge() {
    const [mounted, setMounted] = useState(false)
    const [running, setRunning] = useState(false)
    const [busy, setBusy] = useState(false)
    const [status, setStatus] = useState<RtspRelayStatus | null>(null)
    const [previewUrl, setPreviewUrl] = useState<string | null>(null)

    useEffect(() => {
        setMounted(true)
        if (!isDesktopApp()) return
        return nativeBridge()?.onEvent((event: BridgeEvent) => {
            if (event.bridge !== 'rtsp-relay' || event.id !== RTSP_RELAY_BRIDGE_ID) return
            const meta = event.meta ?? {}
            // Informational events ({codec, streamInfo}) carry no `connected`
            // field. Falling through to the else-branch on those wiped
            // previewUrl and showed "Stopped" a second after every start —
            // same defect as lib/airUnitPreview.ts, fixed the same day.
            if (!('connected' in meta)) return
            if (meta.connected) {
                setRunning(true)
                setPreviewUrl(meta.previewUrl ? String(meta.previewUrl) : null)
                setStatus({ msg: `Relaying via ${String(meta.transport ?? 'srt').toUpperCase()}` })
            } else if (meta.reconnecting) {
                // Still "running" from the operator's point of view — the
                // bridge is retrying on its own, and flipping the UI to
                // stopped would invite them to restart something that is
                // already recovering.
                setStatus({ msg: 'Link dropped — reconnecting…', reconnecting: true, log: meta.log ? String(meta.log) : undefined })
            } else {
                setRunning(false)
                setPreviewUrl(null)
                setStatus(meta.error
                    ? { msg: String(meta.error), error: true, log: meta.log ? String(meta.log) : undefined }
                    : { msg: 'Stopped' })
            }
        })
    }, [])

    /** Allocates a server listener, then starts relaying. Returns the
     *  allocation so the caller can include it in the WebRTC offer. */
    const start = async (): Promise<RelayAllocation | null> => {
        setBusy(true)
        setStatus(null)
        try {
            const alloc = await allocateRelay()
            if (!alloc.hostConfigured) {
                setStatus({
                    msg: 'Server has no relay_public_host configured — the uplink address is a guess '
                        + 'and will fail behind a tunnel. Set it in the backend config.',
                    error: true,
                })
                return null
            }
            const result = await nativeBridge()?.start('rtsp-relay', RTSP_RELAY_BRIDGE_ID, {
                url: getSiyiRtspUrl(),
                host: alloc.host,
                port: alloc.port,
                transport: alloc.transport,
                latencyMs: alloc.latencyMs,
                streamId: alloc.streamId,
                preview: true,
                rtspTransport: getRtspTransport(),
                fragDurationUs: getPreviewFragDurationUs(),
            })
            if (result && !result.ok) {
                setStatus({ msg: result.error ?? 'Could not start relay', error: true })
                return null
            }
            return alloc
        } catch (err) {
            setStatus({ msg: (err as Error).message, error: true })
            return null
        } finally {
            setBusy(false)
        }
    }

    const stop = async () => {
        setBusy(true)
        try {
            await nativeBridge()?.stop('rtsp-relay', RTSP_RELAY_BRIDGE_ID)
            releaseRelay()
            setRunning(false)
            setPreviewUrl(null)
            setStatus({ msg: 'Stopped' })
        } finally {
            setBusy(false)
        }
    }

    return { supported: mounted && isDesktopApp(), running, busy, status, previewUrl, start, stop }
}
