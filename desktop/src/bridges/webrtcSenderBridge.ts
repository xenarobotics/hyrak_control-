import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import dgram from 'node:dgram'
import ffmpegStaticPath from 'ffmpeg-static'
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters } from 'werift'
import type { NativeBridge, EmitFn } from './types'
import { trackChild, killChild } from './processGuard'

// Sends a networked RTSP camera to the backend as a REAL WebRTC track, from
// this process — no browser involved in the upload path at all.
//
// Why this exists alongside rtspRelayBridge (see ADR-009 for the full
// argument). Measured on the live SIYI camera: `siyi_rtsp`, where the SERVER
// opens the camera, ran ~300ms glass-to-glass. `rtsp_camera`, where the laptop
// opens it and launders the video through Chromium to get a MediaStream, ran
// 1-1.5s on the same hardware. The gap is not buffering — it is codec steps:
//
//   siyi_rtsp     RTSP -> [server decode+encode] -> WebRTC -> [browser decode]
//                 = 3
//   rtsp_camera   RTSP -> [ffmpeg decode+encode] -> fMP4 -> [Chromium decode]
//                 -> captureStream -> [browser encode] -> [server decode]
//                 -> [server encode] -> WebRTC -> [browser decode]
//                 = 7
//   this bridge   RTSP -> ffmpeg -> RTP -> WebRTC -> [server decode]
//                 = 2-3
//
// The `<video>` + captureStream() hop only ever existed because the browser was
// the only part of the client that could speak WebRTC. werift removes that
// constraint.
//
// And unlike rtspRelayBridge's SRT uplink, this traverses NAT: it is ordinary
// WebRTC, so ICE/STUN/TURN apply, including TURN over TLS:443 on networks that
// block UDP. No relay_public_host, no forwarded ports, no VPN.
//
// Signalling deliberately lives in the RENDERER, not here: it already holds the
// authenticated socket.io connection and the session identity. This bridge
// produces an offer, emits it, and waits to be handed an answer.

const FFMPEG_PATH = (ffmpegStaticPath || 'ffmpeg').replace('app.asar', 'app.asar.unpacked')

// Loopback port range for ffmpeg -> this process. Only ever bound on 127.0.0.1.
const RTP_PORT_BASE = 5900
const RTP_PORT_LIMIT = 5960

// H.264 payload type. Must match ffmpeg's `-payload_type`.
const H264_PAYLOAD_TYPE = 96

// aiortc's is_codec_compatible() (rtcpeerconnection.py) compares
// `packetization-mode` AND the parsed H.264 profile — not just the mime type.
// aiortc advertises packetization-mode=1; werift with no `parameters` defaults
// to 0, so there is NO common codec and setRemoteDescription fails outright
// with "Failed to set remote video description send parameters". Verified
// against aiortc directly before this bridge was written.
//
// Only the profile is compared, never the level, so 42e01f (Constrained
// Baseline 3.1) is safe for libx264's actual output.
const H264_FMTP = 'packetization-mode=1;level-asymmetry-allowed=1;profile-level-id=42e01f'

const ICE_GATHER_TIMEOUT_MS = 5000

// How long the whole ICE + DTLS + SCTP handshake gets before we give up.
//
// Was 10000, which is generous on a DIRECT path and not nearly enough on a
// relay-only one. On a network that blocks UDP, every candidate on both sides
// is a TURN relay reached over TLS/TCP, and the budget is spent roughly like
// this — measured, not estimated:
//
//   server-side gathering (aiortc, relay alloc over TLS)   ~5.0s
//   signalling round trip (offer/answer through the tunnel)   ...
//   ICE connectivity checks, relay <-> relay                  ...
//   DTLS handshake (several round trips)                      ...
//   SCTP INIT                                                 ...
//
// The 5.0s figure is confirmed twice: by timing aiortc's gathering directly,
// and in the backend log, where "DataChannel ingest" at 00:42:55 is followed by
// "PC ... connecting" at 00:43:00. That single step ate half the old budget
// before the client had done anything, so the timeout fired while the
// connection was still legitimately progressing — reported as a hard failure
// with `state: connecting`, which is precisely what "still working on it" looks
// like.
//
// 30s costs nothing when the path is fast (the channel opens and this never
// fires) and is the difference between working and not on a relayed path.
const CHANNEL_OPEN_TIMEOUT_MS = 30000

// How long the source gets to produce its first RTP packet before we say so.
//
// This exists because of a real diagnostic dead end: a blanket `-max_delay 0`
// made ffmpeg read the camera and emit nothing, and the ONLY error the operator
// saw came from the server ("DataChannel forwarded 0 packets") — the client had
// nothing to say, because the bridge only reported on ffmpeg EXIT and ffmpeg was
// still happily running. A source that is alive but silent has to be its own
// reportable state, with ffmpeg's own words attached.
const FIRST_PACKET_TIMEOUT_MS = 6000

// Microseconds. ffmpeg's RTSP default is effectively unbounded.
const RTSP_CONNECT_TIMEOUT_US = 8_000_000

// Above this much queued in the DataChannel, drop rather than enqueue.
//
// This is the mitigation for the one real risk in the DataChannel design.
// SCTP's congestion control is tuned for bulk data, not realtime media: on
// loss it shrinks its window, and packets then pile up in `bufferedAmount`
// instead of going out — latency growth, which is the opposite of what a pilot
// needs. `maxRetransmits: 0` disarms retransmission, and this disarms queueing.
//
// The threshold comes from measurement, not guesswork: a healthy channel sat at
// ~32 KB while sustaining 50 Mbit/s with a flat latency trend (see
// docs/ARCHITECTURE.md). 256 KB is ~8x that, so it cannot trip in normal
// operation, and anything above it means SCTP is genuinely backing up.
//
// Dropping here is strictly better than queueing: for video, late is worse than
// missing, and H.265 already tolerates radio loss.
const MAX_BUFFERED_BYTES = 256 * 1024

// The same backstop for a RELIABLE channel, where the threshold means something
// completely different.
//
// On the unreliable channel a climbing bufferedAmount meant SCTP was genuinely
// failing to keep up, and shedding was the correct response. On a reliable one
// it is mostly the normal cost of recovery: a retransmitted chunk holds
// everything behind it until it is acknowledged, so the buffer routinely spikes
// and then drains. Shedding at 256KB there would throw away packets the
// transport was about to deliver successfully — reintroducing precisely the
// corruption that reliability exists to prevent, and doing it at the app layer
// where SCTP cannot recover it at all.
//
// 4 MB is ~10s of this 3 Mbit/s stream: far above any transient recovery spike,
// so it cannot trip in normal operation, while still bounding memory if the
// receiver stops draining altogether. If it IS hit, the stream is unusable
// anyway and dropping is the lesser harm.
const MAX_BUFFERED_BYTES_RELIABLE = 4 * 1024 * 1024

// Max RTP packet size on the DataChannel path, in bytes.
//
// Prudence, not a fix. ffmpeg's RTP muxer defaults to roughly an Ethernet MTU
// (~1472, measured), which after DTLS/SCTP overhead spans more than one SCTP
// chunk. Keeping packets under that boundary means no message ever depends on
// multi-chunk reassembly, which matters because `maxRetransmits: 0` gives
// fragments no second chance.
//
// Be clear that this was NOT the cause of the corruption hunted during
// development — that was `-bsf:v dump_extra` (see the copy branch below).
// Changing this value between 1100 and 800 produced byte-for-byte identical
// results, which is what finally ruled it out.
const DATACHANNEL_RTP_PKT_SIZE = 800

type SenderMode =
    // A real WebRTC media track. Universally interoperable, but aiortc
    // negotiates only VP8/H.264, so an H.265 source must be transcoded.
    | 'track'
    // Raw RTP packets down a DataChannel. The payload is opaque, so NO codec is
    // negotiated and H.265 passes through bit-exact. See
    // backend/app/webrtc/datachannel_video_source.py.
    | 'datachannel'

type SenderSource =
    // Pull an RTSP camera with ffmpeg, remux to RTP. ffmpeg is needed here
    // purely to speak RTSP — the camera sends nothing until the
    // DESCRIBE/SETUP/PLAY handshake completes.
    | 'rtsp'
    // Read RTP straight off a local UDP port. NO ffmpeg at all.
    //
    // This is the air unit path, and it is the cheapest in the whole app.
    // communication/luckfox_pico_airunit's `air_video_udp` already hardware-
    // encodes on the Rockchip VENC and packetises to RTP itself
    // (`venc_to_rtp_thread`), with a 1200-byte payload MTU; wfb_rx delivers it
    // to udp:127.0.0.1:5600 on the ground station. There is nothing left to do
    // but forward the datagrams: no decode, no encode, no remux, and the bytes
    // the server decodes are the bytes the drone's encoder produced.
    | 'udp'

interface WebrtcSenderConfig {
    source?: SenderSource           // default 'rtsp'
    url: string                     // rtsp://192.168.144.25:8554/video1
    udpPort?: number                // source==='udp': port RTP arrives on (5600)
    // source==='udp': re-emit every datagram verbatim to 127.0.0.1:<this>.
    //
    // Only ONE process can receive a given unicast UDP port (see
    // bindExclusive), so binding 5600 to stream it to the server necessarily
    // takes it away from any local viewer the operator was already running —
    // gst-decode.sh being the exact case. This gives that viewer somewhere
    // else to listen: the ground station is still captured once, and the
    // copy is byte-identical because nothing here parses the payload.
    udpFanoutPort?: number
    // source==='udp': a SECOND verbatim copy, for the app's OWN local preview
    // (rtsp-relay bridge in preview-only mode). Separate from udpFanoutPort
    // because only one process can receive a unicast UDP port: the operator's
    // external viewer (gst-decode, QGC video) holds the fan-out port, so the
    // in-app preview ffmpeg needs its own. Same never-gated-on-the-channel
    // semantics — the pilot's picture must survive the cloud leg dying.
    previewFanoutPort?: number
    // Restores the original PR-SCTP behaviour (maxRetransmits: 0): packets are
    // abandoned rather than retransmitted. Kept as an escape hatch for
    // comparison — see the DataChannel creation below for why it is no longer
    // the default.
    unreliable?: boolean
    mode?: SenderMode               // default 'track'
    rtspTransport?: 'tcp' | 'udp'
    // Re-encode to H.264. Required for an H.265 camera: the negotiated codec
    // here is H.264, so HEVC cannot be passed through. An H.264 camera can be
    // copied with no re-encode at all, which is the cheapest path in the app.
    transcode?: boolean
    iceServers?: { urls: string | string[]; username?: string; credential?: string }[]
}

interface SenderConn {
    pc: RTCPeerConnection
    mode: SenderMode
    track: MediaStreamTrack | null
    // werift's RTCDataChannel. Typed loosely because only send/bufferedAmount/
    // readyState are used and werift's exported type moves between versions.
    dc: { send(data: Buffer): void; bufferedAmount: number; readyState: string } | null
    socket: dgram.Socket | null
    // Verbatim local copy of the incoming RTP — see WebrtcSenderConfig.udpFanoutPort.
    fanout: dgram.Socket | null
    fanoutPort: number | null
    // Second copy for the in-app preview — see WebrtcSenderConfig.previewFanoutPort.
    preview: dgram.Socket | null
    previewPort: number | null
    proc: ChildProcessWithoutNullStreams | null
    rtpPort: number
    packets: number
    received: number         // datagrams read off the source, before any shedding
    dropped: number          // shed because bufferedAmount was too high
    droppedNotOpen: number   // arrived while the DataChannel was not open
    maxBuffered: number
    // Depends on whether the channel retransmits — see MAX_BUFFERED_BYTES_RELIABLE.
    shedThreshold: number
    stopping: boolean
    emit: EmitFn
    // Held between start() and acceptAnswer(), because ffmpeg must not run
    // until the transport can actually carry its output.
    pendingCfg?: WebrtcSenderConfig
    // Kept on the conn, not local to launchFfmpeg, so the silence watchdog can
    // quote ffmpeg's own output.
    stderrTail: string
}

// Binds a UDP port and FAILS if anyone already holds it.
//
// This deliberately does NOT set SO_REUSEADDR, and that is the whole point.
// With it set the bind succeeds even when another process is already receiving
// the port, and Linux then delivers every unicast datagram to just ONE of the
// sockets — measured as the LAST binder taking all 200 of 200 test packets
// while the first got zero. Applied to the air-unit path that meant:
//
//   app started after gst-decode.sh  -> we silently STEAL the video, and the
//                                       operator's local window freezes with
//                                       no error anywhere
//   app started before gst-decode.sh -> gst silently steals it back, and our
//                                       stream reports only "nothing arriving
//                                       on udp:5600", pointing the blame at
//                                       the ground station or the RF link
//
// Both are the same collision, neither names it, and one corrupts a working
// setup. A refused bind that says who has the port is strictly better: RTP on
// a shared port cannot be shared, so there is nothing SO_REUSEADDR can buy
// here except an unclear failure.
// Requested SO_RCVBUF for the source socket. THE critical number on a weak
// client, and it was never set — the omission that most likely explains the
// field white noise.
//
// Unlike every other transport, this path reads video in JAVASCRIPT: each of
// ~332 datagrams/s is handed to the main process, copied to the fan-outs, then
// encrypted and framed by werift (userspace SCTP + DTLS) before send. All of
// that shares ONE event loop with the rest of the app. Whenever it stalls,
// nothing is draining the socket — and Node's default receive buffer (~208 KB
// from net.core.rmem_default) is only ~0.4s of a 4 Mbps stream. Past that the
// KERNEL discards datagrams, before any copy is made, so the preview and the
// server are corrupted identically and the app's own `received` counter never
// sees the loss. That is precisely the reported symptom: clean for a few
// seconds, then white noise, on both paths at once, while gst-decode — a
// separate process doing nothing but reading — stays perfect.
//
// rtspRelayBridge already passes ffmpeg -buffer_size 425984 for this exact
// reason; the socket we bind ourselves never got the same treatment.
const SOURCE_RCVBUF_BYTES = 4 * 1024 * 1024   // ~8s at 4 Mbps

async function bindExclusive(port: number): Promise<dgram.Socket> {
    const socket = dgram.createSocket({
        type: 'udp4',
        reuseAddr: false,
        // Also as a constructor option: on some platforms this is only
        // honoured before bind.
        recvBufferSize: SOURCE_RCVBUF_BYTES,
    })
    await new Promise<void>((resolve, reject) => {
        socket.once('error', reject)
        // 0.0.0.0, not loopback: wfb_rx may deliver from another interface, and
        // a client machine may run the ground station elsewhere on the LAN.
        // Same reasoning as ADR-006.
        socket.bind(port, '0.0.0.0', () => resolve())
    })
    try {
        socket.setRecvBufferSize(SOURCE_RCVBUF_BYTES)
    } catch { /* clamped or unsupported — the read-back below is the truth */ }
    return socket
}

/** What the OS ACTUALLY gave us. Linux silently clamps SO_RCVBUF to
 *  net.core.rmem_max (commonly 212992), so the request above can be a no-op
 *  with no error at all — worth reporting rather than assuming. */
function actualRecvBuffer(socket: dgram.Socket): number {
    try {
        return socket.getRecvBufferSize()
    } catch {
        return 0
    }
}

async function bindLoopbackRtp(): Promise<{ socket: dgram.Socket; port: number }> {
    for (let port = RTP_PORT_BASE; port < RTP_PORT_LIMIT; port++) {
        const socket = dgram.createSocket('udp4')
        try {
            await new Promise<void>((resolve, reject) => {
                socket.once('error', reject)
                socket.bind(port, '127.0.0.1', () => resolve())
            })
            return { socket, port }
        } catch {
            try { socket.close() } catch { /* never bound */ }
        }
    }
    throw new Error(`no free loopback RTP port in ${RTP_PORT_BASE}-${RTP_PORT_LIMIT}`)
}

export class WebrtcSenderBridge implements NativeBridge {
    readonly kind = 'webrtc-sender'
    private conns = new Map<string, SenderConn>()

    async start(
        id: string,
        config: Record<string, unknown>,
        emit: EmitFn,
    ): Promise<{ ok: boolean; error?: string; meta?: Record<string, unknown> }> {
        const cfg = config as unknown as WebrtcSenderConfig
        await this.stop(id)

        const source: SenderSource = cfg.source ?? 'rtsp'
        if (source === 'rtsp' && !cfg.url) return { ok: false, error: 'RTSP url required' }

        let socket: dgram.Socket
        let rtpPort: number
        try {
            if (source === 'udp') {
                // Bind the port the air unit's RTP is ALREADY arriving on.
                rtpPort = cfg.udpPort ?? 5600
                socket = await bindExclusive(rtpPort)
            } else {
                ({ socket, port: rtpPort } = await bindLoopbackRtp())
            }
        } catch (err) {
            const port = cfg.udpPort ?? 5600
            const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
            return {
                ok: false,
                error: source !== 'udp'
                    ? (err as Error).message
                    : busy
                        // Named causes in the order they actually happen, because
                        // this is now a REFUSAL where it used to be a silent
                        // hijack — the operator has to know what to close.
                        ? `udp:${port} is already being received by another process — `
                          + 'most likely gst-decode.sh (its udpsrc holds this exact port), '
                          + 'a second HYRAK window, or QGroundControl. Only one program can '
                          + 'receive a UDP port, so close that viewer and let HYRAK take the '
                          + `feed — or set a fan-out port so it can watch on a different one.`
                        : `couldn't bind udp:${port} — ${(err as Error).message}`,
            }
        }

        // Verbatim copy to a local viewer, so owning 5600 does not mean the
        // operator loses their own picture. Failures here are ignored on purpose:
        // nothing may be listening yet, and a missing local preview must never
        // interrupt the stream that IS working.
        let fanout: dgram.Socket | null = null
        const fanoutPort = source === 'udp' ? cfg.udpFanoutPort : undefined
        if (fanoutPort && fanoutPort > 0 && fanoutPort !== rtpPort) {
            fanout = dgram.createSocket('udp4')
            fanout.on('error', () => { /* no listener yet — ICMP port unreachable */ })
            fanout.unref()
        }
        // The in-app preview's copy — same rules as the operator's fan-out.
        let preview: dgram.Socket | null = null
        const previewPort = source === 'udp' ? cfg.previewFanoutPort : undefined
        if (previewPort && previewPort > 0 && previewPort !== rtpPort && previewPort !== fanoutPort) {
            preview = dgram.createSocket('udp4')
            preview.on('error', () => { /* no listener yet — ICMP port unreachable */ })
            preview.unref()
        }

        const mode: SenderMode = cfg.mode ?? 'track'
        const isDataChannel = mode === 'datachannel'

        const pc = new RTCPeerConnection({
            // Codec configuration is meaningless in datachannel mode — nothing
            // is negotiated, which is precisely why H.265 works there.
            ...(isDataChannel ? {} : {
                codecs: {
                    video: [
                        new RTCRtpCodecParameters({
                            mimeType: 'video/H264',
                            clockRate: 90000,
                            payloadType: H264_PAYLOAD_TYPE,
                            rtcpFeedback: [],
                            parameters: H264_FMTP,
                        }),
                    ],
                },
            }),
            iceServers: (cfg.iceServers ?? []) as never,
        } as never)

        let track: MediaStreamTrack | null = null
        let dc: SenderConn['dc'] = null
        if (isDataChannel) {
            // ORDERED but UNRELIABLE — "partial reliability" (PR-SCTP). Both
            // halves of that are deliberate, and the combination was arrived at
            // by measurement, not preference:
            //
            //   maxRetransmits: 0  nothing is ever retransmitted, so a lost
            //                      packet is abandoned immediately rather than
            //                      stalling the stream behind a recovery
            //                      attempt. This is what keeps head-of-line
            //                      blocking bounded despite ordering.
            //
            //   ordered: true      RTP arrives in sequence. `ordered: false`
            //                      was tried first, on the theory that ordering
            //                      is pure latency for video — but it REORDERS
            //                      even on loopback (observed seq
            //                      218,219,220,222,223,224,221,...) and the
            //                      server's decoder runs with
            //                      reorder_queue_size=0, so out-of-order RTP
            //                      became "Error parsing NAL unit #0" and
            //                      decoded nothing at all. The alternative was
            //                      to add a reorder buffer server-side, which
            //                      is strictly more latency than letting SCTP
            //                      keep order it already tracks.
            //
            // ── 2026-07-30: the unreliable default was WRONG for this codec ──
            //
            // The reasoning above optimises for latency on the assumption that a
            // dropped packet costs one frame. It does not. The air unit encodes
            // H.265 with GOP 60 at ~20fps — IDR every ~3s (measured 3012-3623ms)
            // — and NORMALP IPPP with no intra-refresh. So a single abandoned
            // packet corrupts every frame until the next keyframe, up to 3
            // SECONDS of unwatchable output.
            //
            // That is exactly what was reported: gst-decode.sh reading the SAME
            // udp:5600 shows a perfect 10ms picture, while this path shows heavy
            // white noise. gst is lossless because there is no transport between
            // it and wfb_rx; we inserted a deliberately lossy one in front of a
            // loss-intolerant codec.
            //
            // Trading corruption for latency only pays when loss is rare and
            // cheap. Here it is neither. Reliable delivery costs a retransmission
            // RTT *when loss occurs* and nothing at all when it doesn't — and
            // `ordered: true` already pays the head-of-line cost regardless, so
            // this is a much smaller change than it looks.
            dc = pc.createDataChannel('media', {
                ordered: true,
                // Unreliable only if explicitly asked for, so the old behaviour
                // stays one config flag away for comparison.
                ...(cfg.unreliable ? { maxRetransmits: 0 } : {}),
            }) as unknown as SenderConn['dc']
        } else {
            track = new MediaStreamTrack({ kind: 'video' })
            pc.addTransceiver(track, { direction: 'sendonly' })
        }

        const conn: SenderConn = {
            pc, mode, track, dc, socket, proc: null, rtpPort,
            fanout, fanoutPort: fanout ? fanoutPort! : null,
            preview, previewPort: preview ? previewPort! : null,
            packets: 0, received: 0, dropped: 0, droppedNotOpen: 0,
            maxBuffered: 0,
            shedThreshold: cfg.unreliable ? MAX_BUFFERED_BYTES : MAX_BUFFERED_BYTES_RELIABLE,
            stopping: false, emit,
            stderrTail: '',
        }
        this.conns.set(id, conn)

        // Every datagram ffmpeg emits is already a well-formed RTP packet, so it
        // is forwarded unchanged in both modes. No repacketisation: ffmpeg's RTP
        // muxer and WebRTC agree on the wire format, and the DataChannel does
        // not inspect the payload at all.
        socket.on('message', (buf) => {
            if (conn.stopping) return
            // The denominator. Without it "packets sent" could not be compared to
            // anything, and the only way to tell the app was shedding was to
            // measure the source independently outside the app.
            conn.received++
            // Before anything else, and never gated on the DataChannel's state:
            // the local viewer's picture must not depend on the cloud leg being
            // up, since that is precisely when the operator needs it most.
            if (conn.fanout && conn.fanoutPort) {
                conn.fanout.send(buf, conn.fanoutPort, '127.0.0.1', () => { /* nothing listening */ })
            }
            if (conn.preview && conn.previewPort) {
                conn.preview.send(buf, conn.previewPort, '127.0.0.1', () => { /* nothing listening */ })
            }
            try {
                if (conn.dc) {
                    if (conn.dc.readyState !== 'open') {
                        // Counted, not silently discarded. These are real losses
                        // and they were invisible: only the bufferedAmount path
                        // below incremented `dropped`, so a channel that was slow
                        // to open — or that closed mid-flight — showed a perfect
                        // 0 while the server received a fraction of the stream.
                        conn.droppedNotOpen++
                        return
                    }
                    const buffered = conn.dc.bufferedAmount || 0
                    if (buffered > conn.maxBuffered) conn.maxBuffered = buffered
                    if (buffered > conn.shedThreshold) {
                        // Shed rather than queue — see MAX_BUFFERED_BYTES.
                        conn.dropped++
                        return
                    }
                    conn.dc.send(buf)
                } else {
                    conn.track?.writeRtp(buf)
                }
                conn.packets++
            } catch {
                // A malformed datagram must never take the stream down.
            }
        })

        pc.iceConnectionStateChange.subscribe((state) => {
            emit({
                bridge: this.kind, id, type: 'status',
                meta: {
                    iceState: state, mode, packets: conn.packets,
                    // Surfaced, not just counted: `dropped` climbing is the
                    // only visible symptom of SCTP backing up, and without it
                    // the operator would see degradation with no explanation.
                    // `received` is the denominator — sent/received is the loss
                    // rate, which is what actually explains a freezing picture
                    // (every lost packet costs one IDR interval of video).
                    received: conn.received,
                    dropped: conn.dropped,
                    droppedNotOpen: conn.droppedNotOpen,
                    maxBuffered: conn.maxBuffered,
                    // What the kernel actually granted. If this is ~208 KB
                    // rather than the 4 MB requested, the OS clamped it to
                    // net.core.rmem_max and the socket can still overflow
                    // during an event-loop stall — a silent, invisible loss
                    // that looks exactly like a bad radio link.
                    recvBuffer: conn.socket ? actualRecvBuffer(conn.socket) : 0,
                },
            })
        })

        let offerSdp: string
        try {
            await pc.setLocalDescription(await pc.createOffer())
            // Non-trickle: wait for gathering so the SDP carries its
            // candidates. Trickle would mean another IPC channel and another
            // socket event for no benefit at this scale — one camera, one
            // short-lived negotiation.
            const deadline = Date.now() + ICE_GATHER_TIMEOUT_MS
            while (pc.iceGatheringState !== 'complete' && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 100))
            }
            offerSdp = pc.localDescription!.sdp
        } catch (err) {
            await this.stop(id)
            return { ok: false, error: `could not create WebRTC offer — ${(err as Error).message}` }
        }

        // ffmpeg is deliberately NOT started here. Negotiation is not finished
        // until acceptAnswer(), and until the transport is up there is nowhere
        // for packets to go — the DataChannel is not `open`, so every packet
        // produced in that window is silently discarded. Pulling the camera
        // before there is a destination also wastes an RTSP session and throws
        // away the start of the stream, including its first parameter sets.
        //
        // Caught by the end-to-end test: with a fast-producing source the whole
        // stream was emitted and dropped before the channel ever opened.
        conn.pendingCfg = cfg

        emit({
            bridge: this.kind, id, type: 'status',
            meta: { connected: true, mode, rtpPort, transcode: !!cfg.transcode },
        })
        // The offer is RETURNED, not only emitted: the renderer awaits start()
        // and would otherwise race the event. Same hazard rtspRelayBridge hit.
        return { ok: true, meta: { offerSdp, rtpPort, mode } }
    }

    /** Reports a source that opened but produced nothing. Cleared as soon as the
     *  first packet arrives, so it costs nothing on a healthy stream. */
    private armSilenceWatchdog(id: string, conn: SenderConn): void {
        const timer = setTimeout(() => {
            if (conn.stopping || conn.packets > 0) return
            const tail = conn.stderrTail.trim().split('\n').slice(-3).join(' ')
            // Checked, not asserted. The previous message claimed "ffmpeg is
            // still running" without looking, which is misleading in exactly the
            // case that matters — a process that died or never started.
            const proc = conn.proc
            const alive = !!proc && proc.exitCode === null && proc.signalCode === null
            const procState = !proc
                ? 'no ffmpeg was started'
                : alive
                    ? 'ffmpeg is still running'
                    : `ffmpeg has exited (code=${proc.exitCode}, signal=${proc.signalCode})`
            conn.emit({
                bridge: this.kind, id, type: 'status',
                meta: {
                    connected: false,
                    error: conn.mode === 'datachannel' && conn.proc === null
                        ? `Nothing arriving on udp:${conn.rtpPort} after `
                          + `${FIRST_PACKET_TIMEOUT_MS / 1000}s. Is the ground station running `
                          + '(wfb_rx), and is it delivering to this machine?'
                        : `No RTP produced in ${FIRST_PACKET_TIMEOUT_MS / 1000}s — ${procState}.`
                          + (tail
                              ? ` Last ffmpeg output: ${tail}`
                              : ' ffmpeg printed NOTHING, which means it never even reached the '
                                + 'camera: either the RTSP connect is hanging, or the binary '
                                + `failed to start (tried ${FFMPEG_PATH}).`),
                    log: conn.stderrTail,
                },
            })
        }, FIRST_PACKET_TIMEOUT_MS)
        timer.unref?.()
    }

    /** Applies the backend's answer. Until this lands the PeerConnection is
     *  gathered but not connected, and ffmpeg's packets go nowhere. */
    async acceptAnswer(id: string, sdp: string): Promise<{ ok: boolean; error?: string }> {
        const conn = this.conns.get(id)
        if (!conn) return { ok: false, error: 'no sender running for this id' }
        try {
            await conn.pc.setRemoteDescription({ type: 'answer', sdp })
            // Now, and only now, start pulling the camera. In datachannel mode
            // wait for the channel to actually open first — SCTP comes up a few
            // hundred ms after DTLS, and anything emitted before that is thrown
            // away by the send path.
            if (conn.dc) {
                const deadline = Date.now() + CHANNEL_OPEN_TIMEOUT_MS
                while (conn.dc.readyState !== 'open' && Date.now() < deadline) {
                    await new Promise((r) => setTimeout(r, 50))
                }
                if (conn.dc.readyState !== 'open') {
                    // Name the ICE state as well as the channel's. They answer
                    // different questions and the old message only had the
                    // second: "connecting" alone cannot distinguish a path that
                    // is still being negotiated from one that has no route at
                    // all, and those need opposite responses from the operator.
                    const ice = String((conn.pc as unknown as { iceConnectionState?: string })
                        .iceConnectionState ?? 'unknown')
                    const diagnosis = ice === 'failed'
                        ? 'No usable network path was found. On a network that blocks UDP this '
                          + 'means the TURN relay over TLS/443 could not be reached either.'
                        : 'The connection was still being negotiated when time ran out — a '
                          + 'relayed path (no direct route) is simply slow to establish.'
                    return {
                        ok: false,
                        error: `DataChannel did not open within ${CHANNEL_OPEN_TIMEOUT_MS}ms `
                            + `(channel: ${conn.dc.readyState}, ICE: ${ice}). ${diagnosis}`,
                    }
                }
            }
            if (conn.pendingCfg) {
                // A 'udp' source needs no process at all — the air unit is
                // already sending RTP to the port we bound in start().
                if ((conn.pendingCfg.source ?? 'rtsp') !== 'udp') {
                    this.launchFfmpeg(id, conn, conn.pendingCfg)
                }
                conn.pendingCfg = undefined
                this.armSilenceWatchdog(id, conn)
            }
            return { ok: true }
        } catch (err) {
            // Overwhelmingly the likeliest cause is a codec mismatch, and the
            // raw werift message does not say so. See H264_FMTP above.
            return {
                ok: false,
                error: `server answer rejected — ${(err as Error).message}. If this mentions `
                    + 'codecs or send parameters, the H.264 fmtp no longer matches what the '
                    + 'server advertises (packetization-mode and profile must both agree).',
            }
        }
    }

    private launchFfmpeg(id: string, conn: SenderConn, cfg: WebrtcSenderConfig): void {
        // `-rtsp_transport` and friends are RTSP DEMUXER options. ffmpeg rejects
        // them outright for any other input ("Error opening input files: Option
        // not found"), so they must be conditional on the URL scheme — the
        // source here is not necessarily RTSP (a file or a plain RTP/SDP source
        // is equally valid input to this bridge).
        const isRtsp = /^rtsps?:\/\//i.test(cfg.url)
        const rtspUdp = isRtsp && cfg.rtspTransport === 'udp'
        // A local file has no inherent clock: ffmpeg will read it as fast as it
        // can (measured at 8340x realtime) and fire the entire stream at a
        // transport built for 30fps, which simply overruns it — most of the
        // packets are lost and there is nothing left to decode. `-re` paces a
        // non-live input at its native rate. Live network sources are already
        // paced by the sender and must NOT get this, or ffmpeg would throttle to
        // the stream's nominal rate and accumulate delay.
        const needsPacing = !/^[a-z][a-z0-9+.-]*:\/\//i.test(cfg.url)
        // In datachannel mode a transcode defeats the entire purpose — the
        // payload is opaque precisely so H.265 can pass through untouched. Only
        // honour `transcode` on the track path, where aiortc's VP8/H.264-only
        // codec table makes it unavoidable for an HEVC source.
        //
        // Verified: `-c copy` from an HEVC source into the rtp muxer produces
        // `a=rtpmap:96 H265/90000`, byte-identical to the SDP the server's
        // udp_video_source.py already uses. Nothing new to teach either end.
        const transcode = conn.mode === 'datachannel' ? false : !!cfg.transcode
        const args = [
            '-hide_banner', '-loglevel', 'info',
            ...(isRtsp ? [
                '-rtsp_transport', rtspUdp ? 'udp' : 'tcp',
                // Socket I/O timeout, MICROSECONDS. Without it ffmpeg blocks on
                // an unreachable camera essentially forever and prints NOTHING —
                // no banner, no error — which presents as "process alive, zero
                // packets, empty stderr" and is impossible to tell apart from a
                // spawn failure. With it, ffmpeg says "Connection timed out" and
                // exits, which describeFailure() turns into a real message.
                '-timeout', String(RTSP_CONNECT_TIMEOUT_US),
            ] : []),
            ...(rtspUdp ? ['-reorder_queue_size', '0', '-max_delay', '0'] : []),
            // NOTE: no blanket `-max_delay 0`.
            //
            // It was added here on the theory that a reorder wait is pure
            // latency, and it broke rtsp_datachannel outright — the client's
            // ffmpeg produced zero RTP and the server reported "DataChannel
            // forwarded 0 packets". These args only ever reach the RTSP leg
            // anyway: a 'udp' source runs no ffmpeg at all. And over RTSP/TCP
            // nothing can arrive out of order, so the option bought nothing even
            // in theory.
            //
            // The measured 100ms was always on the SERVER side
            // (udp_video_source's max_delay), and that change stands. Only
            // rtspUdp keeps it, where reordering is real and dropping beats
            // waiting.
            ...(needsPacing ? ['-re'] : []),
            '-fflags', 'nobuffer', '-flags', 'low_delay',
            '-i', cfg.url,
            '-map', '0:v:0',
            ...(transcode
                ? [
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
                    '-crf', '26', '-g', '30',
                    // Constrained Baseline, to match the profile advertised in
                    // H264_FMTP. libx264 -preset ultrafast already produces
                    // this, but stating it means a preset change can never
                    // silently break codec negotiation.
                    '-profile:v', 'baseline',
                    // Repeat SPS/PPS ahead of every keyframe. Without this the
                    // receiver logs "non-existing PPS 0 referenced" and shows
                    // garbage until the first keyframe, because it attached
                    // mid-stream with no parameter sets — observed in the
                    // aiortc proof of concept.
                    '-x264-params', 'repeat-headers=1',
                ]
                // NO bitstream filter. `-bsf:v dump_extra` was tried here and
                // is actively harmful: it REPLACES the mp4->AnnexB filter ffmpeg
                // inserts automatically for a copy into RTP, so the HEVC stays
                // length-prefixed, the RTP payloader cannot find NAL boundaries,
                // and it emits no FU/AP packets at all. The receiver then reports
                // "Error parsing NAL unit #0" forever and decodes nothing.
                //
                // Parameter sets are the CAMERA's responsibility: the stream must
                // carry VPS/SPS/PPS in-band (encoders call this repeat-headers),
                // because the server's SDP has no sprop-* fmtp to supply them.
                : ['-c:v', 'copy']),
            '-an',
            '-payload_type', String(H264_PAYLOAD_TYPE),
            // Only on the datachannel path — see DATACHANNEL_RTP_PKT_SIZE. The
            // track path goes out over SRTP/UDP where the normal MTU is correct.
            ...(conn.mode === 'datachannel'
                ? ['-pkt_size', String(DATACHANNEL_RTP_PKT_SIZE)]
                : []),
            '-f', 'rtp', `rtp://127.0.0.1:${conn.rtpPort}`,
        ]

        const proc = spawn(FFMPEG_PATH, args)
        trackChild(proc)
        conn.proc = proc

        proc.stderr.on('data', (d: Buffer) => {
            conn.stderrTail = (conn.stderrTail + d.toString()).slice(-4000)
        })

        // A spawn failure (missing binary, wrong path, EACCES, wrong
        // architecture) emits 'error' and NEVER touches stderr or 'exit'. With
        // no handler it was silently swallowed, leaving exactly the symptom seen
        // in the field: no output, no exit, no packets. The resolved path is
        // included because on Windows it is the thing most likely to be wrong
        // (app.asar vs app.asar.unpacked).
        proc.on('error', (err) => {
            if (conn.stopping) return
            conn.emit({
                bridge: this.kind, id, type: 'status',
                meta: {
                    connected: false,
                    error: `Could not run ffmpeg — ${err.message}. Tried: ${FFMPEG_PATH}`,
                    ffmpegPath: FFMPEG_PATH,
                },
            })
        })
        proc.on('exit', (code) => {
            if (conn.stopping || conn.proc !== proc) return
            conn.emit({
                bridge: this.kind, id, type: 'status',
                meta: {
                    connected: false, code,
                    error: /Connection refused|timed out|No route to host/i.test(conn.stderrTail)
                        ? `Can't reach the camera at ${cfg.url} — is this machine on the camera's network?`
                        : `ffmpeg exited (${code}). Last output: `
                          + conn.stderrTail.trim().split('\n').slice(-2).join(' '),
                    log: conn.stderrTail,
                },
            })
        })
    }

    async stop(id: string): Promise<void> {
        const conn = this.conns.get(id)
        if (!conn) return
        conn.stopping = true
        killChild(conn.proc)
        try { conn.socket?.close() } catch { /* already closed */ }
        try { conn.fanout?.close() } catch { /* already closed */ }
        try { conn.preview?.close() } catch { /* already closed */ }
        try { conn.track?.stop() } catch { /* already stopped */ }
        try { await conn.pc.close() } catch { /* already closed */ }
        this.conns.delete(id)
    }

    send(): void {
        // One-way: video out. Answers arrive via acceptAnswer(), not here,
        // because they need to be awaited and to report failure.
    }
}
