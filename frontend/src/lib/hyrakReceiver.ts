'use client'

// Drives the HYRAK Receiver bridge (desktop/src/bridges/receiverBridge.ts) —
// the PC side of the ground decoder.
//
// Two things make this different from gstPreview.ts, and both are here rather
// than in the bridge because only the renderer can answer them:
//
// 1. WHETHER H.265 CAN BE PASSED THROUGH. Only Chromium knows whether it can
//    decode HEVC on this machine, and the answer decides the entire pipeline:
//    passthrough (nothing decodes outside the GPU) or a full transcode to
//    H.264 (roughly a core at 1080p30). So the capability is measured here and
//    handed down, never guessed by the bridge.
//
// 2. WHICH CODEC ACTUALLY ARRIVED. The bridge can step DOWN mid-session — a
//    hardware element that registered but cannot run gets found out only when
//    it dies — so the codec is republished on every status event and the video
//    component re-configures. Trusting the codec we asked for produces a black
//    pane with no error, which is the worst thing to debug on a client's
//    machine.
//
// Ordering matches the other relay modes: the backend allocates a listener
// BEFORE the client pushes, and the client must be pushing before the browser
// offers, because the offer handler waits on real frames.
//
//   allocateRelay() -> startReceiver() -> (caller sends the offer)

import { useEffect, useState } from 'react'
import { isDesktopApp, nativeBridge, type BridgeEvent } from '@/lib/nativeBridge'
import { canDecodeHevc } from '@/lib/codecString'
import {
    getReceiverHost, getReceiverTransport, getReceiverLatencyMs, getReceiverAccel,
    getReceiverPassthrough,
    getPreviewMaxHeight,
    DEFAULT_RECEIVER_RTSP_PORT, DEFAULT_RECEIVER_RTSP_PATH,
    DEFAULT_RECEIVER_SRT_PORT, DEFAULT_RECEIVER_SRT_STREAM_ID,
    DEFAULT_AIR_UNIT_VIDEO_PORT,
} from '@/lib/videoSource'
import type { RelayAllocation } from '@/hooks/useRtspRelayBridge'

export const RECEIVER_BRIDGE = 'hyrak-receiver'
export const RECEIVER_BRIDGE_ID = 'hyrak-receiver'

export interface ReceiverStatus {
    previewUrl?: string | null
    /** What the preview stream ACTUALLY carries. Drives VideoDecoder.configure. */
    codec?: 'h264' | 'hevc'
    backend?: string
    accel?: string
    transcode?: boolean
    decoder?: string | null
    encoder?: string | null
    /** One line naming the live path, for the UI and for support. */
    why?: string
    transport?: string
    source?: string
    latencyMs?: number
    /** Process is up but nothing has arrived yet — "waiting", not "working". */
    receiving?: boolean
    stalled?: boolean
    demoted?: boolean
    hardwareAvailable?: boolean
    gstAvailable?: boolean
    warning?: string
    error?: string
}

let lastStatus: ReceiverStatus | null = null
const subscribers = new Set<(s: ReceiverStatus | null) => void>()

function publish(s: ReceiverStatus | null) {
    lastStatus = s
    for (const fn of subscribers) fn(s)
}

export function getReceiverPreviewUrl(): string | null {
    return lastStatus?.previewUrl ?? null
}

let lastError: string | null = null
export function getLastReceiverError(): string | null {
    return lastError
}

// Remembered so the codec fallback below can restart with the same uplink
// rather than tearing the whole stream down and renegotiating.
let lastAlloc: RelayAllocation | undefined
// Latched once the renderer proves HEVC does not really work here, so the
// fallback cannot loop: isConfigSupported would still say yes on the retry.
let hevcRejected = false

/** Called when the renderer's VideoDecoder actually FAILS on the passthrough
 *  path, as opposed to declining it up front.
 *
 *  This exists because `isConfigSupported` is a claim, not a guarantee — a
 *  driver can advertise HEVC and then fault on a real stream, and that is
 *  precisely the class of machine we cannot test on. The bridge's own ladder
 *  cannot catch it: its pipeline is healthy, the bytes are flowing, and the
 *  failure is happening one process away in the GPU. Without this the pane
 *  stays black on those machines with a decoder error and nothing else.
 *
 *  Restarts once, with hevcOk forced false, which lands on the transcode rung. */
export async function fallbackFromHevc(reason: string): Promise<void> {
    if (hevcRejected) return
    if (lastStatus?.codec !== 'hevc') return
    hevcRejected = true
    console.warn('[hyrak-receiver] H.265 was advertised but failed to decode — '
        + `restarting as H.264. Reason: ${reason}`)
    try {
        await startReceiver(lastAlloc)
    } catch (e) {
        console.error('[hyrak-receiver] fallback restart failed:', (e as Error).message)
    }
}

if (typeof window !== 'undefined' && isDesktopApp()) {
    nativeBridge()?.onEvent((event: BridgeEvent) => {
        if (event.bridge !== RECEIVER_BRIDGE || event.id !== RECEIVER_BRIDGE_ID) return
        const meta = event.meta ?? {}
        // Only lifecycle events carry `connected`. Informational ones must not
        // be mistaken for a shutdown — that exact bug wiped the preview URL one
        // second after every successful start in an earlier bridge and made the
        // whole local-view feature silently inert in the field.
        if (!('connected' in meta)) return

        if (meta.connected) {
            if (meta.demoted) {
                console.warn('[hyrak-receiver] stepped down a rung:', meta.error)
            }
            if (meta.stalled) {
                console.warn('[hyrak-receiver] stalled:', meta.error)
            }
            // The AI uplink failing is invisible locally — the preview plays
            // on regardless — so it gets its own loud line rather than being
            // folded into general status.
            if (meta.uplinkIssue) {
                console.error('[hyrak-receiver]', meta.error)
            }
            publish({
                ...lastStatus,
                // Carried forward when a status event omits it: demotion events
                // report the new plan, not the preview server, which has not
                // moved.
                previewUrl: meta.previewUrl ? String(meta.previewUrl) : lastStatus?.previewUrl ?? null,
                codec: meta.codec === 'hevc' ? 'hevc' : (meta.codec === 'h264' ? 'h264' : lastStatus?.codec),
                backend: meta.backend ? String(meta.backend) : lastStatus?.backend,
                accel: meta.accel ? String(meta.accel) : lastStatus?.accel,
                transcode: 'transcode' in meta ? !!meta.transcode : lastStatus?.transcode,
                decoder: 'decoder' in meta ? (meta.decoder as string | null) : lastStatus?.decoder,
                encoder: 'encoder' in meta ? (meta.encoder as string | null) : lastStatus?.encoder,
                why: meta.why ? String(meta.why) : lastStatus?.why,
                demoted: !!meta.demoted,
                stalled: !!meta.stalled,
                receiving: meta.stalled ? false : lastStatus?.receiving,
                warning: meta.error && (meta.demoted || meta.stalled) ? String(meta.error) : undefined,
            })
            lastError = null
        } else {
            lastError = meta.error ? String(meta.error) : 'HYRAK Receiver stopped'
            console.error('[hyrak-receiver] stopped:', lastError,
                meta.log ? String(meta.log).slice(-300) : '')
            publish(null)
        }
    })
}

/** Starts the receiver. `alloc` comes from allocateRelay() and supplies the
 *  SRT uplink to the server's AI; omit it for a preview-only run. */
export async function startReceiver(alloc?: RelayAllocation): Promise<ReceiverStatus> {
    if (!isDesktopApp()) {
        throw new Error(
            'The HYRAK Receiver needs the desktop app — a browser tab cannot open a '
            + 'UDP socket or speak RTSP/SRT.')
    }
    await stopReceiver()
    lastError = null
    lastAlloc = alloc

    const transport = getReceiverTransport()
    // Passthrough is opt-in. Chromium answering "yes I support HEVC" is not
    // evidence that it will decode this stream — see getReceiverPassthrough —
    // so the capability query only runs when the operator has asked for it,
    // and a previous real failure latches it off for the session.
    const hevcOk = getReceiverPassthrough() && !hevcRejected && await canDecodeHevc()

    const result = await nativeBridge()?.start(RECEIVER_BRIDGE, RECEIVER_BRIDGE_ID, {
        host: getReceiverHost(),
        transport,
        latencyMs: getReceiverLatencyMs(transport),
        udpPort: DEFAULT_AIR_UNIT_VIDEO_PORT,
        rtspPort: DEFAULT_RECEIVER_RTSP_PORT,
        rtspPath: DEFAULT_RECEIVER_RTSP_PATH,
        rtspTransport: 'tcp',
        srtPort: DEFAULT_RECEIVER_SRT_PORT,
        srtStreamId: DEFAULT_RECEIVER_SRT_STREAM_ID,
        hevcOk,
        accel: getReceiverAccel(),
        maxHeight: getPreviewMaxHeight(),
        ...(alloc
            ? {
                uplinkHost: alloc.host,
                uplinkPort: alloc.port,
                // From the ALLOCATION, not from a local setting — the backend
                // has already opened a listener of exactly one kind, and
                // pushing a different one fails silently on both sides.
                uplinkTransport: alloc.transport,
                uplinkLatencyMs: alloc.latencyMs,
                uplinkStreamId: alloc.streamId,
            }
            : {}),
    })

    if (!result?.ok) {
        const msg = result?.error ?? 'Could not start the HYRAK Receiver'
        lastError = msg
        throw new Error(msg)
    }

    const m = result.meta ?? {}
    const status: ReceiverStatus = {
        previewUrl: typeof m.previewUrl === 'string' && m.previewUrl ? m.previewUrl : null,
        // From the bridge, never from `hevcOk` — the bridge may have had to
        // pick a different rung than the one we implied.
        codec: m.codec === 'hevc' ? 'hevc' : 'h264',
        backend: m.backend ? String(m.backend) : undefined,
        accel: m.accel ? String(m.accel) : undefined,
        transcode: !!m.transcode,
        decoder: (m.decoder as string | null) ?? null,
        encoder: (m.encoder as string | null) ?? null,
        why: m.why ? String(m.why) : undefined,
        transport: m.transport ? String(m.transport) : transport,
        source: m.source ? String(m.source) : undefined,
        latencyMs: typeof m.latencyMs === 'number' ? m.latencyMs : undefined,
        receiving: !!m.receiving,
        hardwareAvailable: !!m.hardwareAvailable,
        gstAvailable: !!m.gstAvailable,
        warning: m.warning ? String(m.warning) : undefined,
    }
    publish(status)
    return status
}

export async function stopReceiver(): Promise<void> {
    publish(null)
    if (!isDesktopApp()) return
    try {
        await nativeBridge()?.stop(RECEIVER_BRIDGE, RECEIVER_BRIDGE_ID)
    } catch { /* not running */ }
}

/** Reactive status for components. */
export function useReceiver(): ReceiverStatus | null {
    // Starts null to match server-rendered HTML, then syncs after mount — same
    // hydration reasoning as the other video hooks.
    const [status, setStatus] = useState<ReceiverStatus | null>(null)
    useEffect(() => {
        setStatus(lastStatus)
        subscribers.add(setStatus)
        return () => { subscribers.delete(setStatus) }
    }, [])
    return status
}
