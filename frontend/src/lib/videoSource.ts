// Where the video feed for a stream comes from - the browser's own camera
// (default), the backend reading a UDP RTP/H.265 stream directly from a
// custom RF air unit (see backend/app/webrtc/udp_video_source.py and
// communication/start-gs.sh), or the backend pulling an RTSP feed straight
// from a camera on the network - e.g. a SIYI transmission module's gimbal
// camera at rtsp://192.168.144.25:8554/video1 (see
// backend/app/webrtc/rtsp_video_source.py). Persisted like the other video
// prefs in videoSettings.ts, kept in its own file since it changes what
// gets sent in the WebRTC offer rather than just codec/resolution tuning.
// Set once in Settings, read from wherever a stream is started (Fly,
// Modules) - not a per-tab choice.

// 'rtsp_relay' is the zero-transcode path (desktop only): the app pulls the
// same RTSP URL as 'siyi_rtsp' but does it from THIS machine and forwards
// the camera's original bytes to the backend with ffmpeg -c copy, while
// serving the operator a local preview off the same process. Use it
// whenever the camera is reachable from the laptop rather than the server
// - which, off a developer's desk, is always. See
// desktop/src/bridges/rtspRelayBridge.ts and docs/video-transport-modes.md.
// 'rtsp_camera' decodes the same RTSP URL locally and sends it as an
// ORDINARY WebRTC camera track. It is deliberately NOT server-sourced: the
// backend cannot tell it from a webcam, which is the entire point - it needs
// no reachable server port and traverses NAT like any other camera.
// The two DataChannel modes are the newest transport and the only one that is
// BOTH bit-exact and NAT-traversing (docs/ARCHITECTURE.md, ADR-009). The desktop
// app opens its own WebRTC PeerConnection carrying no media track - just a
// DataChannel of raw RTP - so no codec is negotiated and H.265 passes through
// untouched. aiortc cannot negotiate H.265 on a media track, which is what
// forced a transcode in every other client-sourced mode.
//
//   'rtsp_datachannel'      SIYI/any RTSP camera. ffmpeg speaks RTSP and remuxes
//                           to RTP with -c copy. One process, no re-encode.
//   'air_unit_datachannel'  The custom RF air unit. NO ffmpeg at all: wfb_rx
//                           already delivers RTP/H.265 to udp:5600 (see
//                           communication/luckfox_pico_airunit - air_video_udp
//                           hardware-encodes and packetises to RTP itself), so
//                           the bridge only forwards datagrams. The cheapest
//                           path in the app, and bit-identical to what the
//                           drone's encoder produced.
//
// Both are ADDITIVE. Nothing about camera/air_unit_udp/siyi_rtsp/rtsp_relay/
// rtsp_camera changes; the intent is to have every transport available for
// comparison first and prune later.
export type VideoSource =
    | 'camera'
    | 'air_unit_udp'
    | 'siyi_rtsp'
    | 'rtsp_relay'
    | 'rtsp_camera'
    | 'rtsp_datachannel'
    | 'air_unit_datachannel'
    // The air unit over SRT. Same relay machinery as 'rtsp_relay' - ffmpeg
    // `-c copy` on this machine pushing MPEG-TS to a backend listener - but
    // reading wfb_rx's RTP off udp:5600 instead of pulling a camera.
    //
    // Exists because SRT and the DataChannel fail in opposite directions, and
    // only measurement on a real link decides between them:
    //   SRT          libsrt (C), an EXPLICIT latency budget inside which loss
    //                is retransmitted. UDP-only, and needs a reachable public
    //                port on the server - so a UDP-blocking firewall kills it
    //                outright.
    //   DataChannel  werift (TypeScript) SCTP, and TURN over TLS/:443 when
    //                everything else is blocked. Connects almost anywhere, but
    //                with less throughput headroom and no latency dial.
    | 'air_unit_srt'
    // The air unit through a single GStreamer pipeline on this machine.
    //
    // Structurally different from every mode above, and the reason it exists:
    // ONE process owns udp:5600 and serves both consumers off a `tee` -
    // a hardware-decoded local preview for the pilot, and a bit-exact H.265
    // SRT uplink for the server's AI. Consequences:
    //
    //   * No video packet passes through JavaScript. The DataChannel path
    //     reads RTP on Electron's single event loop, and when that loop
    //     stalls the kernel discards datagrams before any copy exists -
    //     invisible loss that corrupts the preview and the server equally.
    //   * Hardware codecs are actually reachable. The BUNDLED ffmpeg reports
    //     only `vdpau` for -hwaccels: no VAAPI, no QSV. Measured on 1080p20
    //     H.265 - ffmpeg preview ~79% of a core, GStreamer software 41%,
    //     GStreamer hardware 4.4%.
    //   * The pilot's picture never round-trips to the server, so it does not
    //     depend on the uplink being healthy.
    //
    // Requires GStreamer on the client (Linux only in practice - the air unit
    // ground station is Linux-only anyway, since wfb_rx is).
    | 'air_unit_gst'

    // The HYRAK Receiver - the ground DECODER's feed
    // (docs/PC_VIDEO_TELEMETRY_INTEGRATION.md, docs/HYRAK_RECEIVER.md).
    //
    // Different hardware from every mode above. air_unit_* assume wfb_rx runs
    // on THIS machine, which means the RTL8812EU driver, the wfb-ng build and
    // the RF keys all have to be here - Linux-only, and a support burden per
    // client. The decoder is a separate box that owns all of that and hands
    // this PC plain compressed H.265 over Ethernet.
    //
    // What that buys, and why it is a new source rather than a flag:
    //
    //   * It runs on Windows, Linux and ARM64 from one installer with nothing
    //     else installed. The picture is painted by WebCodecs, and the codec
    //     it is fed is H.264 - the one codec every Chromium decodes on every
    //     platform. Getting there costs a transcode, which is nearly free on
    //     hardware (4.4% of a core) and is what the proven air_unit_srt mode
    //     has always done. H.265 passthrough is available as a toggle but is
    //     NOT the default: Chromium reports HEVC support it cannot honour.
    //   * Three transports with genuinely different trade-offs, chosen in
    //     Settings - see ReceiverTransport below.
    //   * It is not tied to udp:5600 being local, so any PC on the network can
    //     be the ground station.
    | 'hyrak_receiver'

export type RelayTransport = 'srt' | 'tcp' | 'udp'

// How ffmpeg opens the CAMERA leg - not to be confused with RelayTransport,
// which is how the copied video reaches the SERVER. Two different hops that
// happen to offer similar choices.
//
// This is a dial rather than a constant because the two options fail in
// opposite directions and only measurement on a real link can decide:
//
//   tcp   Nothing is lost. But a retransmission stalls everything queued
//         behind it (head-of-line blocking), so on a marginal WiFi link the
//         delay ACCUMULATES rather than glitching - a plausible cause of a
//         steady ~1s lag that no amount of downstream tuning can touch.
//   udp   Late packets are simply missing. Loss shows as artifacts instead
//         of delay, which is the right trade for a pilot view.
export type RtspTransport = 'tcp' | 'udp'

// Preview fMP4 fragment length. A fragment is only written once complete, so
// this is added to the preview's delay in full. Kept switchable so the
// pre-0.1.14 behaviour stays one click away if the short fragments turn out
// to upset a decoder somewhere.
export type PreviewFragMode = 'low' | 'compatible'

const KEY = 'hyrak-video-source'
const RTSP_KEY = 'hyrak-siyi-rtsp-url'
const AIR_UNIT_PORT_KEY = 'hyrak-air-unit-video-port'
const AIR_UNIT_FANOUT_KEY = 'hyrak-air-unit-fanout-port'
const RELAY_TRANSPORT_KEY = 'hyrak-relay-transport'
const RELAY_LATENCY_KEY = 'hyrak-relay-latency-ms'
const RTSP_TRANSPORT_KEY = 'hyrak-rtsp-transport'
const PREVIEW_FRAG_KEY = 'hyrak-preview-frag-mode'
const LIVE_EDGE_KEY = 'hyrak-live-edge-clamp'
const PREVIEW_MAX_H_KEY = 'hyrak-preview-max-height'
export const DEFAULT_SIYI_RTSP_URL = 'rtsp://192.168.144.25:8554/video1'
export const DEFAULT_AIR_UNIT_VIDEO_PORT = 5600
export const DEFAULT_RELAY_TRANSPORT: RelayTransport = 'srt'
// Milliseconds. SRT's retransmit window is also a floor on glass-to-glass
// delay, so this is the single most important latency dial in relay mode.
//
// Must match DEFAULT_LATENCY_MS in backend/app/webrtc/relay_video_source.py
// and DEFAULT_SRT_LATENCY_MS in desktop/src/bridges/gstreamerBridge.ts, where
// the full reasoning lives. In short: relay is Vultr Bengaluru, measured RTT
// 41.8ms, SRT wants 2.5-4x that, so 150 sits at ~3.6x.
//
// 60 -> 300 -> 150. The 300 was an over-correction: it was chosen to explain
// corruption that actually came from the desktop pipeline shedding compressed
// frames (fixed in 0.1.49), not from the window being too small.
//
// This is a FIXED delay, not a ceiling - SRT's TSBPD releases every packet at
// a constant offset from its timestamp, so a healthy link never converges to
// something lower once the stream is stable. In air_unit_gst mode it delays
// only the server's copy; the pilot's preview is local and unaffected.
export const DEFAULT_RELAY_LATENCY_MS = 150

// TCP is the default because it is what shipped and what is known to work.
// UDP is the experiment; a failed experiment must never cost the working
// configuration, so the default is not moved until measurement says to.
export const DEFAULT_RTSP_TRANSPORT: RtspTransport = 'tcp'
export const DEFAULT_PREVIEW_FRAG_MODE: PreviewFragMode = 'low'

// Microseconds. 'low' is under one frame at 30fps, so the fragment boundary
// stops being a term at all; 'compatible' is the pre-0.1.14 value.
export const PREVIEW_FRAG_US: Record<PreviewFragMode, number> = {
    low: 20000,
    compatible: 100000,
}

const SOURCES: VideoSource[] = [
    'camera', 'air_unit_udp', 'siyi_rtsp', 'rtsp_relay', 'rtsp_camera',
    'rtsp_datachannel', 'air_unit_datachannel', 'air_unit_srt', 'air_unit_gst',
    'hyrak_receiver',
]
const RELAY_TRANSPORTS: RelayTransport[] = ['srt', 'tcp', 'udp']
const RTSP_TRANSPORTS: RtspTransport[] = ['tcp', 'udp']
const PREVIEW_FRAG_MODES: PreviewFragMode[] = ['low', 'compatible']

// Sources where the backend produces the track and the browser sends no
// camera. Single definition - five call sites used to spell this out
// inline and adding a fourth source meant finding all of them.
export function isServerSourced(v: VideoSource): boolean {
    return v === 'air_unit_udp' || v === 'siyi_rtsp' || v === 'rtsp_relay'
        // Server-sourced for the same reason rtsp_relay is: the browser sends
        // no track, the backend attaches to the relay listener.
        || v === 'air_unit_srt'
        // Same: GStreamer pushes SRT to the relay listener, the browser's
        // offer is recvonly and it never produces a track.
        || v === 'air_unit_gst'
        // Same again - the receiver's uplink branch pushes SRT to the relay
        // listener while the pilot's picture stays local.
        || v === 'hyrak_receiver'
        // The DataChannel modes ARE server-sourced from the browser's point of
        // view: the desktop pushes RTP on a SEPARATE PeerConnection, the server
        // writes it to a loopback UDP port, and the browser's own offer is
        // recvonly - it never produces a track. Contrast rtsp_camera, which is
        // deliberately NOT server-sourced because the browser really does send a
        // camera-like track there.
        || v === 'rtsp_datachannel' || v === 'air_unit_datachannel'
}

/** True for the modes where the desktop app opens its own WebRTC sender. These
 *  need an extra negotiation BEFORE the browser's offer, because the server
 *  probes the loopback port synchronously and fails on a silent one. */
export function usesDataChannelSender(v: VideoSource): boolean {
    return v === 'rtsp_datachannel' || v === 'air_unit_datachannel'
}

// Only a real webcam needs the operator to pick a device. 'rtsp_camera'
// produces a MediaStream like a camera does, but its source is a URL - so
// gating Start on a camera selection would leave the button permanently
// disabled.
export function needsCameraSelection(v: VideoSource): boolean {
    return v === 'camera'
}

export function getVideoSource(): VideoSource {
    if (typeof window === 'undefined') return 'camera'
    try {
        const v = localStorage.getItem(KEY)
        return (SOURCES as string[]).includes(v ?? '') ? (v as VideoSource) : 'camera'
    } catch {
        return 'camera'
    }
}

export function setVideoSource(v: VideoSource) {
    if (typeof window !== 'undefined') localStorage.setItem(KEY, v)
}

export function getSiyiRtspUrl(): string {
    if (typeof window === 'undefined') return DEFAULT_SIYI_RTSP_URL
    try {
        return localStorage.getItem(RTSP_KEY) || DEFAULT_SIYI_RTSP_URL
    } catch {
        return DEFAULT_SIYI_RTSP_URL
    }
}

export function setSiyiRtspUrl(url: string) {
    if (typeof window !== 'undefined') localStorage.setItem(RTSP_KEY, url)
}

export function getAirUnitVideoPort(): number {
    if (typeof window === 'undefined') return DEFAULT_AIR_UNIT_VIDEO_PORT
    try {
        const v = Number(localStorage.getItem(AIR_UNIT_PORT_KEY))
        return v > 0 && v < 65536 ? v : DEFAULT_AIR_UNIT_VIDEO_PORT
    } catch {
        return DEFAULT_AIR_UNIT_VIDEO_PORT
    }
}

export function setAirUnitVideoPort(port: number): void {
    if (typeof window !== 'undefined') localStorage.setItem(AIR_UNIT_PORT_KEY, String(port))
}

// Optional verbatim copy of the air unit's RTP to another local UDP port.
//
// Exists because exactly one process can receive a unicast UDP port. Taking
// 5600 to stream the feed necessarily takes it away from whatever local viewer
// was already reading it - a ground station running wfb-gs's gst-decode.sh
// being the case that actually came up. Pointing that viewer at the fan-out
// port instead gives both: one capture, two consumers, byte-identical (nothing
// in the path parses the payload).
//
// 0 = off, which is the default - it costs a send() per packet and most setups
// have no second viewer.
export const DEFAULT_AIR_UNIT_FANOUT_PORT = 0

export function getAirUnitFanoutPort(): number {
    if (typeof window === 'undefined') return DEFAULT_AIR_UNIT_FANOUT_PORT
    try {
        const v = Number(localStorage.getItem(AIR_UNIT_FANOUT_KEY))
        return v > 0 && v < 65536 ? v : DEFAULT_AIR_UNIT_FANOUT_PORT
    } catch {
        return DEFAULT_AIR_UNIT_FANOUT_PORT
    }
}

export function setAirUnitFanoutPort(port: number): void {
    if (typeof window !== 'undefined') localStorage.setItem(AIR_UNIT_FANOUT_KEY, String(port))
}

export function getRelayTransport(): RelayTransport {
    if (typeof window === 'undefined') return DEFAULT_RELAY_TRANSPORT
    try {
        const v = localStorage.getItem(RELAY_TRANSPORT_KEY)
        return (RELAY_TRANSPORTS as string[]).includes(v ?? '') ? (v as RelayTransport) : DEFAULT_RELAY_TRANSPORT
    } catch {
        return DEFAULT_RELAY_TRANSPORT
    }
}

export function setRelayTransport(t: RelayTransport): void {
    if (typeof window !== 'undefined') localStorage.setItem(RELAY_TRANSPORT_KEY, t)
}

export function getRelayLatencyMs(): number {
    if (typeof window === 'undefined') return DEFAULT_RELAY_LATENCY_MS
    try {
        const v = Number(localStorage.getItem(RELAY_LATENCY_KEY))
        // Floor raised 20 -> 80. A stored 20ms silently overrode the default
        // and produced a listener running at latency=20000us, which SRT
        // reported as "RCV-DROPPED N packet(s) ... delayed" followed by
        // corrupt MPEG-TS downstream. SRT needs 2.5-4x RTT for a NAK plus
        // resend, and RTT is >=35ms to anywhere real (41ms to our own relay),
        // so anything under ~80ms cannot retransmit at all - it only adds its
        // own delay. Values below the floor are treated as stale and fall back
        // to the default rather than being honoured.
        return v >= 80 && v <= 2000 ? v : DEFAULT_RELAY_LATENCY_MS
    } catch {
        return DEFAULT_RELAY_LATENCY_MS
    }
}

export function setRelayLatencyMs(ms: number): void {
    if (typeof window !== 'undefined') localStorage.setItem(RELAY_LATENCY_KEY, String(ms))
}

export function getRtspTransport(): RtspTransport {
    if (typeof window === 'undefined') return DEFAULT_RTSP_TRANSPORT
    try {
        const v = localStorage.getItem(RTSP_TRANSPORT_KEY)
        return (RTSP_TRANSPORTS as string[]).includes(v ?? '') ? (v as RtspTransport) : DEFAULT_RTSP_TRANSPORT
    } catch {
        return DEFAULT_RTSP_TRANSPORT
    }
}

export function setRtspTransport(t: RtspTransport): void {
    if (typeof window !== 'undefined') localStorage.setItem(RTSP_TRANSPORT_KEY, t)
}

export function getPreviewFragMode(): PreviewFragMode {
    if (typeof window === 'undefined') return DEFAULT_PREVIEW_FRAG_MODE
    try {
        const v = localStorage.getItem(PREVIEW_FRAG_KEY)
        return (PREVIEW_FRAG_MODES as string[]).includes(v ?? '')
            ? (v as PreviewFragMode)
            : DEFAULT_PREVIEW_FRAG_MODE
    } catch {
        return DEFAULT_PREVIEW_FRAG_MODE
    }
}

export function setPreviewFragMode(m: PreviewFragMode): void {
    if (typeof window !== 'undefined') localStorage.setItem(PREVIEW_FRAG_KEY, m)
}

export function getPreviewFragDurationUs(): number {
    return PREVIEW_FRAG_US[getPreviewFragMode()]
}

/** Max height of the locally-transcoded air-unit preview. 0 = native (no
 *  scaling), which is the default.
 *
 *  0.1.41 shipped a 720p cap on the theory that the client's i5 could not
 *  sustain the 1080p x264 encode and was overflowing its UDP buffer. Tested
 *  in the field WITH client-overlay confirmed engaged: no improvement - so
 *  the encode was not the bottleneck and the cap only cost resolution.
 *  Reverted to native, and made a frontend setting rather than a bridge
 *  constant so the next value can be tried by reloading a page instead of
 *  reinstalling the app on a remote operator's machine. */
export function getPreviewMaxHeight(): number {
    if (typeof window === 'undefined') return 0
    try {
        const v = Number(localStorage.getItem(PREVIEW_MAX_H_KEY))
        return Number.isFinite(v) && v > 0 ? v : 0
    } catch {
        return 0
    }
}

export function setPreviewMaxHeight(h: number): void {
    if (typeof window !== 'undefined') localStorage.setItem(PREVIEW_MAX_H_KEY, String(h))
}

// GStreamer rtpjitterbuffer window, milliseconds. Kept a setting because a
// lossy RF link may want more, and trading delay for smoothness is a
// per-deployment judgement.
//
// Default raised 10 -> 60, and the floor 0 -> 30. The pipeline runs this
// buffer with drop-on-latency=true, so this value is not "how long we are
// willing to wait" - it is "how late a packet may be before we THROW IT
// AWAY". At 10ms that discarded packets on a link with no actual loss,
// because ordinary Wi-Fi jitter exceeds 10ms, and a discarded packet in a
// compressed stream breaks every frame referencing it until the next IDR.
//
// The floor matters as much as the default: a value stored back when 10 was
// the default would otherwise keep overriding this, silently, forever - the
// same failure that kept relay latency pinned at 20ms (see getRelayLatencyMs).
const DEFAULT_GST_JITTER_MS = 60
const MIN_GST_JITTER_MS = 30

export function getGstJitterMs(): number {
    if (typeof window === 'undefined') return DEFAULT_GST_JITTER_MS
    try {
        const v = Number(localStorage.getItem('hyrak-gst-jitter-ms'))
        return Number.isFinite(v) && v >= MIN_GST_JITTER_MS && v <= 2000
            ? v : DEFAULT_GST_JITTER_MS
    } catch {
        return DEFAULT_GST_JITTER_MS
    }
}

export function setGstJitterMs(ms: number): void {
    if (typeof window !== 'undefined') localStorage.setItem('hyrak-gst-jitter-ms', String(ms))
}

// 'auto' prefers hardware and falls back on its own; the explicit values are
// for diagnosis - proving a fault is or isn't the GPU without guessing.
export type GstAccel = 'auto' | 'hardware' | 'software'

export function getGstAccel(): GstAccel {
    if (typeof window === 'undefined') return 'auto'
    try {
        const v = localStorage.getItem('hyrak-gst-accel')
        return v === 'hardware' || v === 'software' ? v : 'auto'
    } catch {
        return 'auto'
    }
}

export function setGstAccel(a: GstAccel): void {
    if (typeof window !== 'undefined') localStorage.setItem('hyrak-gst-accel', a)
}

// Defaults on. Stored inverted ('0' means off) so an absent key reads as
// enabled without needing a separate "has been set" check.
export function getLiveEdgeClamp(): boolean {
    if (typeof window === 'undefined') return true
    try {
        return localStorage.getItem(LIVE_EDGE_KEY) !== '0'
    } catch {
        return true
    }
}

export function setLiveEdgeClamp(on: boolean): void {
    if (typeof window !== 'undefined') localStorage.setItem(LIVE_EDGE_KEY, on ? '1' : '0')
}

// ---------------------------------------------------------------------------
// HYRAK Receiver (the ground decoder)
// ---------------------------------------------------------------------------

// The three transports are NOT redundant; each is the right answer somewhere,
// and the differences were measured on a real link rather than reasoned about
// (docs/PC_VIDEO_TELEMETRY_INTEGRATION.md):
//
//   udp    Lowest latency. Nothing is retransmitted, so RF loss that FEC could
//          not repair becomes visible macroblock corruption. The decoder
//          PUSHES, so it must be told this PC's address, and Windows Firewall
//          must allow the port inbound. Best on a direct cable you control.
//   rtsp   WE connect outward, so the decoder needs to know nothing about this
//          PC and no inbound firewall rule is involved. Over TCP the picture
//          stays clean because lost packets are retransmitted - but TCP's
//          head-of-line blocking has no ceiling, so delay can accumulate
//          rather than glitch. This is why VLC looks clean and runs ~0.5s
//          behind.
//   srt    The one that is clean AND bounded. Loss is retransmitted only
//          inside an explicit latency window and dropped outside it, so delay
//          cannot grow the way TCP's can. We still connect outward, so it
//          keeps RTSP's firewall and addressing story. Needs `srt: yes` in
//          MediaMTX on the decoder - which is the same process already serving
//          RTSP, NOT a second wfb_rx, so it costs the board almost nothing.
export type ReceiverTransport = 'udp' | 'rtsp' | 'srt'

export const DEFAULT_RECEIVER_HOST = '192.168.50.12'
// RTSP rather than UDP, deliberately, even though UDP is marginally faster.
// UDP is the only one of the three that needs the decoder to know this PC's
// address AND needs an inbound firewall exception; both are configuration a
// non-technical operator cannot be asked to do, and both fail as a black
// screen rather than as a message. Pilots chasing the last few milliseconds
// can switch in Settings.
export const DEFAULT_RECEIVER_TRANSPORT: ReceiverTransport = 'rtsp'
export const DEFAULT_RECEIVER_RTSP_PORT = 8554
export const DEFAULT_RECEIVER_RTSP_PATH = '/video'
export const DEFAULT_RECEIVER_SRT_PORT = 8890
export const DEFAULT_RECEIVER_SRT_STREAM_ID = 'read:video'

// Per-transport, because the number means something different in each: pure
// jitter absorption on udp, jitter plus a retransmit round trip on rtsp, and
// the retransmit budget itself on srt. Kept equal to DEFAULT_LATENCY_MS in
// desktop/src/bridges/receiverBridge.ts.
export const DEFAULT_RECEIVER_LATENCY_MS: Record<ReceiverTransport, number> = {
    udp: 40, rtsp: 60, srt: 80,
}

const RECEIVER_HOST_KEY = 'hyrak-receiver-host'
const RECEIVER_TRANSPORT_KEY = 'hyrak-receiver-transport'
const RECEIVER_LATENCY_KEY = 'hyrak-receiver-latency-ms'
const RECEIVER_ACCEL_KEY = 'hyrak-receiver-accel'
const RECEIVER_TRANSPORTS: ReceiverTransport[] = ['udp', 'rtsp', 'srt']

export function getReceiverHost(): string {
    if (typeof window === 'undefined') return DEFAULT_RECEIVER_HOST
    try {
        return localStorage.getItem(RECEIVER_HOST_KEY) || DEFAULT_RECEIVER_HOST
    } catch {
        return DEFAULT_RECEIVER_HOST
    }
}

export function setReceiverHost(host: string): void {
    if (typeof window !== 'undefined') localStorage.setItem(RECEIVER_HOST_KEY, host.trim())
}

export function getReceiverTransport(): ReceiverTransport {
    if (typeof window === 'undefined') return DEFAULT_RECEIVER_TRANSPORT
    try {
        const v = localStorage.getItem(RECEIVER_TRANSPORT_KEY)
        return (RECEIVER_TRANSPORTS as string[]).includes(v ?? '')
            ? (v as ReceiverTransport) : DEFAULT_RECEIVER_TRANSPORT
    } catch {
        return DEFAULT_RECEIVER_TRANSPORT
    }
}

export function setReceiverTransport(t: ReceiverTransport): void {
    if (typeof window !== 'undefined') localStorage.setItem(RECEIVER_TRANSPORT_KEY, t)
}

/** Stored per transport - switching udp<->srt otherwise carries over a number
 *  that was tuned for a different mechanism. */
export function getReceiverLatencyMs(t: ReceiverTransport = getReceiverTransport()): number {
    if (typeof window === 'undefined') return DEFAULT_RECEIVER_LATENCY_MS[t]
    try {
        const v = Number(localStorage.getItem(`${RECEIVER_LATENCY_KEY}-${t}`))
        return Number.isFinite(v) && v >= 0 && v <= 2000 ? v : DEFAULT_RECEIVER_LATENCY_MS[t]
    } catch {
        return DEFAULT_RECEIVER_LATENCY_MS[t]
    }
}

export function setReceiverLatencyMs(t: ReceiverTransport, ms: number): void {
    if (typeof window !== 'undefined') localStorage.setItem(`${RECEIVER_LATENCY_KEY}-${t}`, String(ms))
}

export function getReceiverAccel(): GstAccel {
    if (typeof window === 'undefined') return 'auto'
    try {
        const v = localStorage.getItem(RECEIVER_ACCEL_KEY)
        return v === 'hardware' || v === 'software' ? v : 'auto'
    } catch {
        return 'auto'
    }
}

export function setReceiverAccel(a: GstAccel): void {
    if (typeof window !== 'undefined') localStorage.setItem(RECEIVER_ACCEL_KEY, a)
}

// Send the decoder's H.265 straight to the screen with nothing transcoding it.
//
// DEFAULT OFF, and that is a correction rather than caution. It was the
// default, on the theory that skipping a transcode must be better - but
// Chromium's HEVC support is platform-gated and, measured on the reference
// laptop, will answer isConfigSupported() with TRUE and then fail the actual
// decode ("Decoding error", black pane). H.264 has none of that ambiguity: it
// decodes everywhere, which is exactly why the older air_unit_srt mode
// transcodes its preview to H.264 with libx264 and has always just worked.
//
// So the default path now spends a transcode - cheap on hardware (measured
// 4.4% of a core against 79% for the software equivalent) - to buy a codec
// that cannot surprise us. Passthrough stays available because on a Windows
// machine with a modern NVIDIA GPU it is genuinely the better path, and it
// costs one toggle to find out.
const RECEIVER_PASSTHROUGH_KEY = 'hyrak-receiver-hevc-passthrough'

export function getReceiverPassthrough(): boolean {
    if (typeof window === 'undefined') return false
    try {
        return localStorage.getItem(RECEIVER_PASSTHROUGH_KEY) === '1'
    } catch {
        return false
    }
}

export function setReceiverPassthrough(on: boolean): void {
    if (typeof window !== 'undefined') {
        localStorage.setItem(RECEIVER_PASSTHROUGH_KEY, on ? '1' : '0')
    }
}

// ── The video source catalogue, as DATA ─────────────────────────────────────
//
// MOVED HERE FROM settings/page.tsx, which was its only reader until the
// status bar grew a compact picker. Left where it was, the bar would have
// needed its own hand-written list of sources - and the comment three lines
// down already records what that costs: adding 'Ground decoder' silently
// dropped a whole group from a hardcoded list, so the source existed, worked,
// and could not be selected. One catalogue, next to the type it describes.
//
// Nine sources were previously a wall of chips, and each dependent control was
// gated by its own hand-written boolean. That is how `air_unit_gst` came to be
// missing from one gate while present in another - the SRT latency dial simply
// did not render on the mode that needs it most, and nothing about the code
// made that visible. Each source now declares which rows it needs, once, and
// the rows read that declaration.
//
// `needs` keys map 1:1 to the conditional rows below:
//   udpPort   local UDP port the video arrives on
//   fanout    verbatim copy to a second local port
//   rtspUrl   camera address this machine (or the server) opens
//   rtspXport TCP/UDP for the camera leg
//   relay     uplink transport + SRT latency window
//   preview   local preview tuning (fragmenting, live-edge clamp)
//   gst       GStreamer-specific (jitter buffer, decode path)
//   receiver  ground decoder address, transport, latency, decode path
//   capture   browser capture resolution/fps/feed mode
export type SourceNeed = 'udpPort' | 'fanout' | 'rtspUrl' | 'rtspXport'
    | 'relay' | 'preview' | 'gst' | 'receiver' | 'capture'

export interface SourceSpec {
    value: VideoSource
    label: string
    group: 'Browser' | 'Air unit (RF)' | 'RTSP camera' | 'Ground decoder'
    /** One line the operator can act on - what it does and what it requires. */
    blurb: string
    needs: SourceNeed[]
    /** True when the SERVER opens the stream, so the server must be able to
     *  reach the source. This is the single most common misconfiguration. */
    serverReaches?: boolean
    desktopOnly?: boolean
}

export const VIDEO_SOURCES: SourceSpec[] = [
    {
        value: 'hyrak_receiver', label: 'HYRAK Receiver', group: 'Ground decoder',
        blurb: 'The ground decoder over Ethernet. Decodes in the browser engine, so it needs nothing installed and runs the same on Windows, Linux and ARM64 - the only air-unit mode that does.',
        needs: ['receiver', 'relay'], desktopOnly: true,
    },
    {
        value: 'camera', label: 'Camera (webcam)', group: 'Browser',
        blurb: 'This device\'s webcam, sent over WebRTC. Works anywhere.',
        needs: ['capture'],
    },
    {
        value: 'rtsp_camera', label: 'RTSP as camera', group: 'RTSP camera',
        blurb: 'This machine decodes the RTSP URL and sends it as an ordinary camera track. Traverses NAT like a webcam; costs a re-encode.',
        needs: ['rtspUrl', 'rtspXport', 'capture'],
    },
    {
        value: 'siyi_rtsp', label: 'SIYI (RTSP, server pulls)', group: 'RTSP camera',
        blurb: 'The SERVER opens the camera URL. Only works when the server shares a network with the camera - off a dev machine, it never does.',
        needs: ['rtspUrl'], serverReaches: true,
    },
    {
        value: 'rtsp_relay', label: 'RTSP relay', group: 'RTSP camera',
        blurb: 'This machine pulls the camera and forwards the original bytes with no re-encode, plus a local preview. The deployment choice for an RTSP camera.',
        needs: ['rtspUrl', 'rtspXport', 'relay', 'preview'], desktopOnly: true,
    },
    {
        value: 'rtsp_datachannel', label: 'RTSP → DataChannel', group: 'RTSP camera',
        blurb: 'Bit-exact and NAT-traversing: raw RTP over a DataChannel, so H.265 survives untouched. Uses ffmpeg only to speak RTSP.',
        needs: ['rtspUrl', 'rtspXport', 'preview'], desktopOnly: true,
    },
    {
        value: 'air_unit_gst', label: 'Air unit → GStreamer', group: 'Air unit (RF)',
        blurb: 'Preferred on Linux. One GStreamer pipeline owns the UDP port and tees it: hardware-decoded local preview + bit-exact H.265 SRT uplink. Needs GStreamer installed.',
        needs: ['udpPort', 'gst', 'relay'], desktopOnly: true,
    },
    {
        value: 'air_unit_datachannel', label: 'Air unit → DataChannel', group: 'Air unit (RF)',
        blurb: 'No ffmpeg at all - wfb_rx already delivers RTP/H.265, so the app just forwards datagrams. Traverses NAT, but every packet crosses the JS event loop.',
        needs: ['udpPort', 'fanout', 'preview'], desktopOnly: true,
    },
    {
        value: 'air_unit_srt', label: 'Air unit → SRT', group: 'Air unit (RF)',
        blurb: 'ffmpeg copies the RF feed to the server over SRT with an explicit latency budget. Needs a reachable UDP port on the server.',
        needs: ['udpPort', 'relay', 'preview'], desktopOnly: true,
    },
    {
        value: 'air_unit_udp', label: 'Air unit (UDP, server reads)', group: 'Air unit (RF)',
        blurb: 'The SERVER binds the UDP port and reads RTP directly. No QGroundControl involved - but wfb_rx must be delivering to that port ON THE SERVER, so this only works when the ground station and server are the same machine.',
        needs: ['udpPort'], serverReaches: true,
    },
]

/** Group names in catalogue order, de-duplicated. Adding a source with a new
 *  group is now enough to make it appear. */
export const SOURCE_GROUPS = [...new Set(VIDEO_SOURCES.map(s => s.group))]

export function specFor(source: VideoSource): SourceSpec | undefined {
    return VIDEO_SOURCES.find(s => s.value === source)
}

export function sourceNeeds(source: VideoSource, need: SourceNeed): boolean {
    return specFor(source)?.needs.includes(need) ?? false
}
