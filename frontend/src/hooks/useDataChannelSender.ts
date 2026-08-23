'use client'

// Start/stop for the desktop app's WebRTC DataChannel video sender
// (desktop/src/bridges/webrtcSenderBridge.ts, mode: 'datachannel').
//
// This is the only transport that is both bit-exact AND NAT-traversing, which is
// why it exists alongside the others - see docs/ARCHITECTURE.md and ADR-009.
// H.265 survives untouched because a DataChannel negotiates no codec at all;
// aiortc's video codec table is VP8/H.264 only, so every other client-sourced
// mode has to transcode an HEVC source.
//
// Ordering is the whole reason this is a hook rather than two calls at the
// stream site. There are TWO negotiations and they are not interchangeable:
//
//   1. bridge.start()            -> desktop produces an SDP offer (no ffmpeg yet)
//   2. socket 'datachannel_video_offer' -> server answers, returns loopbackPort
//   3. bridge.acceptAnswer()     -> channel opens, and ONLY THEN ffmpeg starts
//   4. (caller sends the browser's own offer, videoSource='..._datachannel')
//
// Step 4 must come last: the server opens the loopback port with a synchronous
// probe (udp_video_source.open_air_unit_video) and fails outright on a silent
// port, so packets have to already be flowing before the browser's offer.

import { useEffect, useState } from 'react'
import { isDesktopApp, nativeBridge, type BridgeEvent } from '@/lib/nativeBridge'
import { getSocket } from '@/lib/socket'
import { getServerUrl } from '@/lib/server-url'
import {
    getVideoSource,
    getSiyiRtspUrl,
    getRtspTransport,
    getAirUnitVideoPort,
    getAirUnitFanoutPort,
    type VideoSource,
} from '@/lib/videoSource'
import { startAirUnitPreview, stopAirUnitPreview, getAirUnitPreviewActualPort } from '@/lib/airUnitPreview'

export const DC_SENDER_BRIDGE_ID = 'webrtc-dc-sender'

const OFFER_TIMEOUT_MS = 15000

export interface DataChannelSenderStatus {
    msg: string
    error?: boolean
    packets?: number
    dropped?: number
    received?: number
    droppedNotOpen?: number
    /** sent/received as a percentage. Below ~100 means the picture WILL freeze:
     *  each lost RTP packet costs one IDR interval of video, and the air unit's
     *  is ~3s (measured), so even a few percent is very visible. */
    deliveredPct?: number
}

// Recorded at module scope because the interesting failures arrive on the bridge
// event channel asynchronously, well after start() has returned ok - spawning
// ffmpeg succeeds long before it manages to reach a camera.
let lastSenderError: string | null = null

export function getLastSenderError(): string | null {
    return lastSenderError
}

export function clearLastSenderError(): void {
    lastSenderError = null
}

if (typeof window !== 'undefined' && isDesktopApp()) {
    nativeBridge()?.onEvent((event: BridgeEvent) => {
        if (event.bridge !== 'webrtc-sender') return
        const meta = event.meta ?? {}
        if (meta.error) lastSenderError = String(meta.error)
        else if (meta.connected) lastSenderError = null
    })
}

interface SenderIceServer {
    urls: string | string[]
    username?: string
    credential?: string
}

/** ICE servers for the DESKTOP's PeerConnection.
 *
 *  The real bug this fixes is that the sender previously got NO ice servers at
 *  all, so it gathered host candidates only - fine on a LAN, dead everywhere
 *  else, which is the exact NAT problem this transport exists to solve.
 *
 *  An earlier version flattened `urls` arrays to one entry each on the theory
 *  that werift ignores arrays; that was tested against the live endpoint and is
 *  FALSE - both forms gather an identical `{host: 1, relay: 1}`. The flattening
 *  was removed rather than left in with a wrong justification.
 *
 *  The urls ARE reordered though, and must be. werift's parseIceServers() takes
 *  the FIRST `turn:` url it sees and reads the transport straight off that url's
 *  `?transport=` parameter:
 *
 *      if (!options.turnServer && parsed.kind === "turn") {
 *          options.turnServer = parsed.address
 *          options.turnTransport = parsed.transport
 *
 *  Cloudflare returns `turn:...:3478?transport=udp` first, so werift committed
 *  to UDP TURN. On a network that blocks outbound UDP that allocation cannot
 *  complete - verified with a raw STUN binding request to both
 *  stun.cloudflare.com:3478 and stun.l.google.com:19302, which TIMED OUT - and
 *  every DataChannel attempt died as "did not open within 10000ms (state:
 *  connecting)" with the server logging connecting -> failed and 0 packets.
 *
 *  werift does have a UDP->TCP fallback, but only when the UDP allocation
 *  REJECTS; a silently-dropped datagram just times out, and our 10s deadline
 *  fires first. `forceTurnTCP` does not help either - resolveTurnTransport()
 *  returns the url-parsed transport BEFORE consulting it. Ordering the urls is
 *  the only lever that actually decides this.
 *
 *  Mirrors _sort_relay_urls() in backend/app/webrtc/signaling.py, which already
 *  did exactly this for aiortc (same first-url-wins behaviour). The backend
 *  protected itself and the sender was left on the raw provider order. */
function sortRelayUrls(urls: string | string[]): string[] {
    const list = Array.isArray(urls) ? [...urls] : [urls]
    const rank = (u: string): number => {
        // turns: (TLS over TCP) first, :443 ahead of :5349 - 443 traverses
        // essentially any firewall, including ones that block 5349.
        if (u.startsWith('turns:')) return u.includes(':443') ? 0 : 1
        if (u.startsWith('turn:') && u.includes('transport=tcp')) return 2
        if (u.startsWith('turn:')) return 3
        return 4   // stun - irrelevant to turn selection
    }
    return list.sort((a, b) => rank(a) - rank(b))
}
async function fetchIceServersForSender(): Promise<SenderIceServer[]> {
    try {
        const res = await fetch(`${getServerUrl()}/api/webrtc/ice-servers`, {
            signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        const servers = data.iceServers as SenderIceServer[] | undefined
        if (Array.isArray(servers) && servers.length) {
            return servers.map(s => ({ ...s, urls: sortRelayUrls(s.urls) }))
        }
    } catch (e) {
        console.warn('Sender ICE fetch failed, falling back to STUN only:', e)
    }
    return [{ urls: 'stun:stun.cloudflare.com:3478' }]
}

interface ServerAnswer {
    sdp?: string
    type?: string
    loopbackPort?: number
    error?: string
}

/** Runs steps 1-3. Returns once RTP is flowing to the server, so the caller can
 *  safely send the browser's offer. Throws with a specific message otherwise. */
export async function startDataChannelSender(source: VideoSource): Promise<number> {
    if (!isDesktopApp()) {
        throw new Error(
            'DataChannel video needs the HYRAK desktop app - a browser tab cannot open '
            + 'a raw RTP source or an RTSP camera.',
        )
    }
    const bridge = nativeBridge()
    if (!bridge?.acceptWebrtcAnswer) {
        throw new Error(
            'This desktop build has no WebRTC sender. Update the app to use DataChannel video.',
        )
    }
    clearLastSenderError()
    await stopDataChannelSender()

    // Without these the sender gathers HOST candidates only, which works on a
    // LAN and silently fails everywhere else - the exact NAT problem this
    // transport exists to solve. Same short-lived Cloudflare TURN credentials
    // the browser's own PeerConnection uses; the backend mints them so none live
    // in client code.
    const iceServers = await fetchIceServersForSender()

    const isAirUnit = source === 'air_unit_datachannel'
    // The pilot's own picture, decoded locally - started BEFORE the sender so
    // its ffmpeg is already listening when the first fan-out copy arrives.
    // Best-effort by design: if it fails, the stream falls back to the
    // server's return feed, which is worse (round-trip latency) but works.
    if (isAirUnit) await startAirUnitPreview()
    const started = await bridge.start('webrtc-sender', DC_SENDER_BRIDGE_ID, {
        mode: 'datachannel',
        iceServers,
        // The air unit needs no ffmpeg: wfb_rx already puts RTP/H.265 on the
        // port. The RTSP camera needs ffmpeg only to speak RTSP.
        source: isAirUnit ? 'udp' : 'rtsp',
        ...(isAirUnit
            ? {
                udpPort: getAirUnitVideoPort(),
                udpFanoutPort: getAirUnitFanoutPort() || undefined,
                // AFTER startAirUnitPreview: the preview may have auto-picked
                // a different port than the preference, and this copy must
                // land where its ffmpeg actually listens.
                previewFanoutPort: getAirUnitPreviewActualPort(),
            }
            : { url: getSiyiRtspUrl(), rtspTransport: getRtspTransport() }),
    })
    if (!started?.ok) {
        throw new Error(started?.error ?? 'Could not start the DataChannel sender')
    }
    const offerSdp = started.meta?.offerSdp
    if (typeof offerSdp !== 'string' || !offerSdp) {
        throw new Error('Sender did not produce an SDP offer')
    }

    // Over the socket, not HTTP: the backend keys sessions by socket id and the
    // browser never learns its own session_id, so an HTTP endpoint would have
    // nothing to identify itself with. Same reasoning as allocate_video_relay.
    const answer = await new Promise<ServerAnswer>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error('Server did not answer the DataChannel offer')),
            OFFER_TIMEOUT_MS,
        )
        getSocket().emit('datachannel_video_offer', { sdp: offerSdp }, (res: ServerAnswer) => {
            clearTimeout(timer)
            resolve(res)
        })
    })
    if (!answer || answer.error || !answer.sdp) {
        await stopDataChannelSender()
        throw new Error(answer?.error || 'Server rejected the DataChannel offer')
    }

    // Applying the answer is what opens the channel and starts ffmpeg.
    const accepted = await bridge.acceptWebrtcAnswer(DC_SENDER_BRIDGE_ID, answer.sdp)
    if (!accepted?.ok) {
        await stopDataChannelSender()
        throw new Error(accepted?.error ?? 'Sender rejected the server answer')
    }

    // The server probes the loopback port synchronously. Give the source a
    // moment to actually put packets on it, or the browser's offer races the
    // first frame and fails with "no video frames arrived".
    await new Promise((r) => setTimeout(r, 1200))

    return answer.loopbackPort ?? 0
}

export async function stopDataChannelSender(): Promise<void> {
    if (!isDesktopApp()) return
    await stopAirUnitPreview()
    try {
        await nativeBridge()?.stop('webrtc-sender', DC_SENDER_BRIDGE_ID)
    } catch {
        /* not running */
    }
}

/** Live status for the UI. Separate from the imperative start/stop above so
 *  Settings can observe a sender that Fly started. */
export function useDataChannelSender() {
    const [mounted, setMounted] = useState(false)
    const [status, setStatus] = useState<DataChannelSenderStatus | null>(null)

    useEffect(() => {
        setMounted(true)
        if (!isDesktopApp()) return
        return nativeBridge()?.onEvent((event: BridgeEvent) => {
            if (event.bridge !== 'webrtc-sender' || event.id !== DC_SENDER_BRIDGE_ID) return
            const meta = event.meta ?? {}
            if (meta.error) {
                setStatus({ msg: String(meta.error), error: true })
            } else if (meta.iceState) {
                const sent = typeof meta.packets === 'number' ? meta.packets : undefined
                const got = typeof meta.received === 'number' ? meta.received : undefined
                setStatus({
                    msg: `ICE ${String(meta.iceState)}`,
                    packets: sent,
                    // Surfaced because a climbing `dropped` is the only visible
                    // symptom of SCTP backing up under congestion.
                    dropped: typeof meta.dropped === 'number' ? meta.dropped : undefined,
                    droppedNotOpen: typeof meta.droppedNotOpen === 'number' ? meta.droppedNotOpen : undefined,
                    received: got,
                    // The number that actually explains a freezing picture.
                    deliveredPct: got && got > 0 && sent !== undefined
                        ? Math.round((sent / got) * 1000) / 10
                        : undefined,
                })
            } else if (meta.connected) {
                setStatus({ msg: 'Sender started' })
            }
        })
    }, [])

    return {
        supported: mounted && isDesktopApp(),
        status,
        active: usesSender(getVideoSource()),
    }
}

function usesSender(v: VideoSource): boolean {
    return v === 'rtsp_datachannel' || v === 'air_unit_datachannel'
}
