import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import dgram from 'node:dgram'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ffmpegStaticPath from 'ffmpeg-static'
import type { NativeBridge, EmitFn } from './types'
import { trackChild, killChild } from './processGuard'
import { frameAu, splitAnnexB } from './annexb'

// The HYRAK Receiver — the ground decoder's PC-side consumer.
//
// The decoder (Luckfox Pico Ultra W, see docs/GROUND_DECODER.md and
// docs/PC_VIDEO_TELEMETRY_INTEGRATION.md) terminates the RF link, decrypts,
// runs FEC recovery, and hands this machine a plain compressed H.265 stream
// over Ethernet. Nothing about keys, wfb-ng or the RTL8812EU driver reaches
// the PC. Three ways in, all carrying the SAME bitstream:
//
//   udp    RTP/H.265 straight at udp:5600. Lowest latency, no retransmission
//          at all — RF loss that FEC could not repair shows as macroblock
//          corruption. The decoder pushes, so it must know this PC's address.
//   rtsp   rtsp://<decoder>:8554/video via MediaMTX on the board. WE pull, so
//          the decoder needs no knowledge of this PC — which is what makes
//          "any PC on the network" work. TCP retransmits and the picture
//          stays clean, at the cost of head-of-line blocking with no ceiling.
//   srt    srt://<decoder>:8890, MediaMTX again. The one that is both clean
//          AND bounded: loss is retransmitted only inside an explicit latency
//          window and dropped outside it, so delay cannot accumulate the way
//          TCP's can. See docs/HYRAK_RECEIVER.md for the board-side config —
//          it is one MediaMTX flag, NOT a second wfb_rx, which matters because
//          the decoder has one Cortex-A7 core and the integration doc measures
//          it already at ~40% with two video paths running.
//
// ---------------------------------------------------------------------------
// Why this is a new bridge and not a flag on gstreamerBridge
// ---------------------------------------------------------------------------
//
// gstreamerBridge REQUIRES a system GStreamer with working VAAPI. That is a
// reasonable ask on the Linux ground-station laptop it was written for, and it
// is the wrong shape entirely for "the client downloads one installer and
// nothing else, on Windows or Linux or ARM64". Bundling GStreamer does not
// rescue it: libgstvaapi.so links the HOST's libva/libdrm/EGL stack, so a
// bundled copy initialises into software (measured 41.3% of a core, versus
// 4.4% on the real hardware path).
//
// So this bridge inverts the design. The default path decodes on NEITHER a
// bundled library NOR a system one — it decodes in Chromium, which every
// client already has because the app IS Chromium:
//
//   decoder --H.265--> ffmpeg -c copy (demux only) --Annex-B--> WebCodecs
//
// ffmpeg never touches a pixel, so ffmpeg-static's inability to reach a GPU
// (-hwaccels reports `vdpau` and nothing else — see ADR-005) stops being a
// constraint instead of being worked around. The GPU is reached through
// Chromium's own platform decoder: D3D11/Media Foundation on Windows, VA-API
// on Linux, V4L2 on ARM SoCs. Zero installer bytes, and it is the same code
// path on all three targets.
//
// GStreamer is still used when it is present AND actually needed — that is,
// when Chromium on this particular machine cannot decode HEVC and the stream
// has to be transcoded to H.264 first. Then hardware genuinely matters, and a
// system GStreamer is the only way to get it. Everything is PROBED at runtime
// and degrades (ADR-005): nothing here assumes a GPU, a vendor, or an OS.

const GST = 'gst-launch-1.0'
const GST_INSPECT = 'gst-inspect-1.0'

// Same asar dance as rtspBridge: electron-builder cannot execute a binary from
// inside the archive, so build.asarUnpack keeps this file outside it while the
// resolved path still claims to be inside.
const FFMPEG_PATH = (ffmpegStaticPath || 'ffmpeg').replace('app.asar', 'app.asar.unpacked')

// Byte-for-byte the description used by udp_video_source.py, rtspRelayBridge's
// SDP and the decoder's own gst-decode.sh. All must agree or the payload is
// parsed as the wrong codec.
const H265_RTP_CAPS =
    'application/x-rtp,media=video,encoding-name=H265,clock-rate=90000,payload=96'

export const DEFAULT_RECEIVER_HOST = '192.168.50.12'
export const DEFAULT_UDP_PORT = 5600
export const DEFAULT_RTSP_PORT = 8554
export const DEFAULT_RTSP_PATH = '/video'
export const DEFAULT_SRT_PORT = 8890
export const DEFAULT_SRT_STREAM_ID = 'read:video'

// Jitter/retransmit window, milliseconds. Deliberately per-transport, because
// the number means something different in each and one constant would be wrong
// twice:
//
//   udp   Pure jitter absorption; there is nothing to retransmit. The
//         integration doc validated 50ms and ran 20ms cleanly on a direct
//         cable. 40 is a compromise that survives a cheap switch.
//   rtsp  Same buffer, but TCP retransmission happens BELOW it, so the buffer
//         additionally has to absorb a retransmit round trip.
//   srt   This is the retransmit budget itself, not just jitter. It has to be
//         several times the link RTT for a NAK and resend to fit. On a LAN the
//         RTT is well under 1ms, so 80ms is already generous — unlike the
//         150ms used for the public-internet uplink to the HYRAK server.
const DEFAULT_LATENCY_MS: Record<Transport, number> = { udp: 40, rtsp: 60, srt: 80 }

// Restart backoff. NOT the flat 2s the other bridges use, and that is
// deliberate: PC_VIDEO_TELEMETRY_INTEGRATION.md open item 4 records a stuck
// client driving the decoder's MediaMTX to 44% CPU through reconnect churn
// alone, which starved wfb_rx and looked exactly like RF packet loss. This box
// has no headroom to absorb an app retrying in a tight loop, so the interval
// grows and the attempts are finite.
const RESTART_BASE_MS = 1000
const RESTART_MAX_MS = 15000
const MAX_CONSECUTIVE_RESTARTS = 8
// Ran at least this long before exiting => a real stream that ended, not a
// configuration that cannot work. Resets the backoff.
const HEALTHY_RUN_MS = 8000

// No bytes for this long, while the process is still alive, means the link
// went away underneath us — the decoder's RF dongle dropping off its USB bus
// (integration doc, open item 1) does exactly this: ffmpeg sits happily on a
// socket that will never deliver again. Without a watchdog the app shows a
// frozen frame forever and reports success.
//
// Must exceed the input probe window (see buildFfmpegArgs) plus a margin, or
// the watchdog shoots a process that is still legitimately waiting for its
// first keyframe — which on this air unit is up to ~2.5s away.
const STARVATION_MS = 12000

// How long start() waits to see real video before returning. The bridge that
// preceded this one returned ok:true the instant it spawned, so a pipeline
// that failed to parse and died 80ms later still reported success, still
// published a preview URL, and surfaced as a mystery 25s later. Waiting for
// first bytes converts that into an immediate, accurate error.
//
// Sized against the same keyframe interval: reporting "nothing arrived" while
// the stream is simply mid-GOP would be a false alarm on every other start.
const READY_TIMEOUT_MS = 12000

export type Transport = 'udp' | 'rtsp' | 'srt'
export type Backend = 'auto' | 'ffmpeg' | 'gstreamer'
export type Accel = 'auto' | 'hardware' | 'software'

export interface ReceiverConfig {
    host?: string
    transport?: Transport
    udpPort?: number
    rtspPort?: number
    rtspPath?: string
    rtspTransport?: 'tcp' | 'udp'
    srtPort?: number
    srtStreamId?: string
    latencyMs?: number

    // What the RENDERER measured, not what we hope. The caller runs
    // VideoDecoder.isConfigSupported() for HEVC on this actual machine and
    // passes the answer; true means the stream can go to the screen without
    // being decoded and re-encoded anywhere in this process tree.
    //
    // Never defaulted to true. A wrong `true` produces a black pane with no
    // error at all, which is the worst possible failure to debug remotely.
    hevcOk?: boolean

    backend?: Backend
    accel?: Accel
    maxHeight?: number
    previewPort?: number

    // Optional SRT uplink to the HYRAK server, so the AI modes see the video.
    // Same tee-with-two-consumers idea as gstreamerBridge, and available on
    // BOTH backends here — which is what makes this mode usable on Windows,
    // where gstreamerBridge is not.
    //
    // Named `uplink*` rather than `srt*` because this bridge already has an
    // `srtPort`, and that one is the DECODER's port on the LAN. Two unrelated
    // SRT endpoints in one config is exactly how a value ends up in the wrong
    // one, so the direction is in the name.
    uplinkHost?: string
    uplinkPort?: number
    /** How the copied video reaches the SERVER — a different hop from
     *  `transport`, which is how video reaches THIS machine.
     *
     *  Must match what the backend allocated. relay_video_source.py opens a
     *  listener of exactly one kind, and pushing a different one is silent on
     *  both sides: the caller reports a healthy pipeline, the listener waits
     *  out its 25s and reports "no video arrived". Observed in the field with
     *  the server logging `listening udp:3478` while this bridge pushed SRT
     *  unconditionally. */
    uplinkTransport?: 'srt' | 'tcp' | 'udp'
    uplinkLatencyMs?: number
    /** Doubles as the SRT passphrase, matching relay_video_source.py. */
    uplinkStreamId?: string
}

interface Conn {
    proc: ChildProcess | null
    server: http.Server | null
    clients: Set<http.ServerResponse>
    /** Viewers that have not yet been handed a keyframe. They receive NOTHING
     *  until one arrives — see the comment in launch(). */
    pending: Set<http.ServerResponse>
    restarts: number
    stopping: boolean
    cfg: ReceiverConfig
    /** Ordered fallbacks; `rung` indexes the one currently running. */
    ladder: Plan[]
    rung: number
    emit: EmitFn
    stderrTail: string
    auTail: Buffer | null
    auSeq: number
    lastByteAt: number
    watchdog: NodeJS.Timeout | null
    onFirstBytes: (() => void) | null
    lastUplinkIssue: string
    lastUplinkIssueAt: number
    /** Set when the WATCHDOG killed the process rather than it exiting on its
     *  own. The distinction decides whether a failure is a decode problem or
     *  an input problem — see handleExit. */
    killedByWatchdog: boolean
}

/** What we decided to actually run, after probing this machine. */
interface Plan {
    backend: 'ffmpeg' | 'gstreamer'
    /** The codec that reaches the RENDERER. 'hevc' means nothing decoded it on
     *  the way — the passthrough path. */
    codec: 'hevc' | 'h264'
    transcode: boolean
    decoder: string | null
    encoder: string | null
    accel: 'hardware' | 'software' | 'none'
    /** Human-readable, surfaced in the UI. The single most useful diagnostic
     *  this bridge produces: it says which of the many paths is live. */
    why: string
}

// ---------------------------------------------------------------------------
// Runtime capability probing
// ---------------------------------------------------------------------------
//
// Ordered best-first. Presence is checked, never assumed from the platform:
// an element registers whenever its plugin is installed, which says nothing
// about whether this GPU can service it. A registered-but-broken element still
// fails at run time and is caught by the demotion in handleExit — the probe is
// an optimisation on top of the fallback, not a replacement for it (ADR-005).

const HEVC_DECODERS = [
    'nvh265dec',        // NVIDIA, Windows + Linux, binds nvcuvid from the driver
    'd3d11h265dec',     // Windows, any D3D11 GPU
    'mfh265dec',        // Windows Media Foundation, generic
    'vah265dec',        // modern VA element (GStreamer 1.20+)
    'vaapih265dec',     // older VAAPI
    'mppvideodec',      // Rockchip (RK3588 ground unit, RV1106)
    'v4l2slh265dec',    // V4L2 stateless — ARM SoCs generally
    'v4l2h265dec',
    'avdec_h265',       // software, always last, always works
]

const H264_ENCODERS = [
    'nvh264enc',
    'mfh264enc',
    'vah264enc',
    'vaapih264enc',
    'mpph264enc',
    'v4l2h264enc',
    // openh264enc before x264enc on purpose: x264enc lives in
    // gst-plugins-ugly and is GPL. We only ever spawn gst-launch as a separate
    // process so that is not a linking question, but preferring the BSD
    // encoder keeps the option of bundling open rather than closing it here.
    'openh264enc',
    'x264enc',
]

const SOFTWARE_ELEMENTS = new Set(['avdec_h265', 'openh264enc', 'x264enc'])

function hasElement(element: string): boolean {
    try {
        execFileSync(GST_INSPECT, [element], { stdio: 'ignore', timeout: 4000 })
        return true
    } catch {
        return false
    }
}

/** Actually RUNS a two-frame encode through `element`. Returns false if it
 *  cannot be configured on this machine.
 *
 *  Presence was the only test before, and presence is not capability — the
 *  exact lesson ADR-005 records for VAAPI, hit again here with NVENC:
 *  `nvh264enc` registers on this laptop and then fails with "Could not
 *  configure supporting library" the moment a real frame reaches it.
 *
 *  Checking properly matters far beyond wasting a launch. A rung that dies on
 *  arrival takes the WHOLE pipeline with it, including the SRT uplink, and the
 *  server's listener accepts exactly one caller inside a bounded window. So
 *  two doomed launches plus their backoff were enough to burn that window and
 *  leave the AI modes with no video at all — a broken encoder presenting as a
 *  broken server connection. Verified rungs mean one launch and one uplink. */
function verifyElement(element: string, props: string[] = []): boolean {
    try {
        execFileSync(GST, [
            '-q', 'videotestsrc', 'num-buffers=2',
            '!', 'video/x-raw,width=320,height=240,framerate=30/1',
            '!', 'videoconvert', '!', element, ...props, '!', 'fakesink', 'sync=false',
        ], { stdio: 'ignore', timeout: 10000 })
        return true
    } catch {
        return false
    }
}

interface Capabilities {
    gst: boolean
    decoder: string | null
    encoder: string | null
    hardware: boolean
}

let cachedCaps: Capabilities | null = null

/** What this machine can do. Cached — probing spawns a process per element,
 *  which is pure latency on the path between pressing Start and seeing video. */
export function probeCapabilities(): Capabilities {
    if (cachedCaps) return cachedCaps
    try {
        execFileSync(GST, ['--version'], { stdio: 'ignore', timeout: 4000 })
    } catch {
        cachedCaps = { gst: false, decoder: null, encoder: null, hardware: false }
        return cachedCaps
    }
    // Depayloaders are the one hard requirement; without them nothing in the
    // GStreamer backend can run regardless of codec support.
    if (!['rtph265depay', 'h265parse'].every(hasElement)) {
        cachedCaps = { gst: false, decoder: null, encoder: null, hardware: false }
        return cachedCaps
    }
    const decoder = HEVC_DECODERS.find(hasElement) ?? null
    // Encoders are VERIFIED, not merely found. Decoders are not: verifying one
    // needs encoded input to feed it, and a decoder that fails still only
    // costs a rung — whereas an unusable encoder costs the uplink.
    const encoder = H264_ENCODERS.find((e) => hasElement(e) && verifyElement(e, encoderTuning(e))) ?? null
    const hardware = !!decoder && !!encoder
        && !SOFTWARE_ELEMENTS.has(decoder) && !SOFTWARE_ELEMENTS.has(encoder)
    cachedCaps = { gst: true, decoder, encoder, hardware }
    return cachedCaps
}

/** Test hook — the probe caches for the process lifetime, which is correct in
 *  production and wrong across test cases. */
export function resetCapabilityCache(): void {
    cachedCaps = null
}

/** The converter that sits between a decoder and an encoder.
 *
 *  This is not boilerplate and `videoconvert` is not a universal answer: a
 *  hardware decoder hands downstream a GPU surface (memory:VAMemory,
 *  memory:D3D11Memory, memory:CUDAMemory), and videoconvert only understands
 *  system memory. Linking them produces `not-negotiated`, which gst-launch
 *  reports as a fatal error on the SOURCE element — so it reads as "the
 *  network stopped" and sends you looking in entirely the wrong place.
 *
 *  Each entry is existence-checked before use, because naming an element that
 *  is not installed is itself a fatal parse error that kills the whole
 *  pipeline. */
function converterFor(decoder: string): string[] {
    const candidates: Record<string, string[]> = {
        nvh265dec: ['cudadownload'],
        vah265dec: ['vapostproc'],
        vaapih265dec: ['vaapipostproc'],
        d3d11h265dec: ['d3d11convert', 'd3d11download'],
        mppvideodec: ['mppconvert'],
    }
    const chain = (candidates[decoder] ?? []).filter(hasElement)
    // videoconvert last, always: after the GPU surface has been brought back
    // to system memory the pixel format still may not match what the encoder
    // accepts, and videoconvert is a no-op when it already does.
    return [...chain, 'videoconvert']
}

/** Every pipeline this machine could plausibly run, best first.
 *
 *  A ladder rather than a single choice, because element PRESENCE does not
 *  imply the GPU can service it and the two ends fail independently. Measured
 *  on the reference laptop: `nvh265dec` decodes correctly while `nvh264enc`
 *  returns "Could not configure supporting library" — NVDEC alive, NVENC not.
 *  A design that picks one hardware plan and demotes straight to all-software
 *  throws away a working hardware decoder on that machine; a design that pairs
 *  them and gives up shows no video at all.
 *
 *  handleExit walks down this list when a rung dies on arrival, so the right
 *  combination is found by trying rather than by predicting — which is the
 *  only approach that works on hardware we cannot test. */
export function planLadder(cfg: ReceiverConfig, caps: Capabilities): Plan[] {
    const wantBackend = cfg.backend ?? 'auto'
    const wantAccel = cfg.accel ?? 'auto'
    const rungs: Plan[] = []

    // The good case, and the reason this bridge exists. Chromium decodes HEVC
    // here, so nothing in this process tree decodes anything: demux, frame,
    // hand to WebCodecs. Identical on Windows, Linux and ARM64, needs no
    // GStreamer, and reaches the GPU through the browser's own platform
    // decoder. Preferred even when GStreamer is installed.
    if (cfg.hevcOk && wantBackend !== 'gstreamer') {
        rungs.push({
            backend: 'ffmpeg', codec: 'hevc', transcode: false,
            decoder: null, encoder: null, accel: 'none',
            why: 'H.265 passthrough — Chromium decodes it on the GPU, nothing transcodes',
        })
    }
    if (cfg.hevcOk && caps.gst && wantBackend !== 'ffmpeg') {
        rungs.push({
            backend: 'gstreamer', codec: 'hevc', transcode: false,
            decoder: null, encoder: null, accel: 'none',
            why: 'H.265 passthrough via GStreamer',
        })
    }

    // Chromium here cannot decode HEVC, so the stream has to become H.264
    // before the renderer sees it. Now hardware genuinely matters — a full
    // decode plus a full encode of every frame — and a system GStreamer is the
    // only way to reach a GPU from this process.
    if (caps.gst && wantBackend !== 'ffmpeg' && wantAccel !== 'software') {
        const hwDec = caps.decoder && !SOFTWARE_ELEMENTS.has(caps.decoder) ? caps.decoder : null
        const hwEnc = caps.encoder && !SOFTWARE_ELEMENTS.has(caps.encoder) ? caps.encoder : null
        const swEnc = H264_ENCODERS.filter((e) => SOFTWARE_ELEMENTS.has(e)).find(hasElement) ?? null

        if (hwDec && hwEnc) {
            rungs.push({
                backend: 'gstreamer', codec: 'h264', transcode: true,
                decoder: hwDec, encoder: hwEnc, accel: 'hardware',
                why: `H.265 to H.264 on the GPU (${hwDec} to ${hwEnc})`,
            })
        }
        // Half a GPU is still most of the win: decode is the expensive half at
        // 1080p, and this rung is what saves a machine whose encoder is the
        // broken end.
        if (hwDec && swEnc) {
            rungs.push({
                backend: 'gstreamer', codec: 'h264', transcode: true,
                decoder: hwDec, encoder: swEnc, accel: 'hardware',
                why: `H.265 decoded on the GPU (${hwDec}), re-encoded in software (${swEnc})`,
            })
        }
    }

    if (caps.gst && wantBackend !== 'ffmpeg' && hasElement('avdec_h265')) {
        const swEnc = H264_ENCODERS.filter((e) => SOFTWARE_ELEMENTS.has(e)).find(hasElement)
        if (swEnc) {
            rungs.push({
                backend: 'gstreamer', codec: 'h264', transcode: true,
                decoder: 'avdec_h265', encoder: swEnc, accel: 'software',
                why: wantAccel === 'software'
                    ? 'H.265 to H.264 in software (forced in Settings)'
                    : 'H.265 to H.264 in software — no usable hardware codec on this machine',
            })
        }
    }

    // The floor. ffmpeg-static cannot reach a GPU (-hwaccels reports vdpau and
    // nothing else), so this is a software decode AND a software encode of
    // every frame and it will cost most of a core at 1080p30. Always present,
    // because a slow picture beats a black one — and reported loudly enough
    // that it is never mistaken for how the app is supposed to perform.
    rungs.push({
        backend: 'ffmpeg', codec: 'h264', transcode: true,
        decoder: 'ffmpeg', encoder: 'libx264', accel: 'software',
        why: 'H.265 to H.264 in software with the bundled ffmpeg — no HEVC support in '
            + 'Chromium and no usable GStreamer. This is the slow path; expect high CPU.',
    })
    return rungs
}

/** Convenience for callers that only want the preferred plan. */
export function planFor(cfg: ReceiverConfig, caps: Capabilities): Plan {
    return planLadder(cfg, caps)[0]
}

// ---------------------------------------------------------------------------
// Input URLs
// ---------------------------------------------------------------------------

function host(cfg: ReceiverConfig): string { return cfg.host || DEFAULT_RECEIVER_HOST }
function transport(cfg: ReceiverConfig): Transport { return cfg.transport ?? 'udp' }
function latency(cfg: ReceiverConfig): number {
    return cfg.latencyMs ?? DEFAULT_LATENCY_MS[transport(cfg)]
}

export function rtspUrl(cfg: ReceiverConfig): string {
    const p = cfg.rtspPath ?? DEFAULT_RTSP_PATH
    return `rtsp://${host(cfg)}:${cfg.rtspPort ?? DEFAULT_RTSP_PORT}${p.startsWith('/') ? p : `/${p}`}`
}

export function srtInputUrl(cfg: ReceiverConfig): string {
    const sid = cfg.srtStreamId ?? DEFAULT_SRT_STREAM_ID
    // ffmpeg's SRT latency is MICROSECONDS. GStreamer's srtsrc property is
    // milliseconds. Same number in the wrong unit here asks for a buffer a
    // thousand times too long, and the stream simply never starts.
    return `srt://${host(cfg)}:${cfg.srtPort ?? DEFAULT_SRT_PORT}`
        + `?mode=caller&latency=${latency(cfg) * 1000}&streamid=${encodeURIComponent(sid)}`
}

const _sdpPaths = new Map<number, string>()

/** RTP on a bare UDP port says nothing about its own codec beyond a payload
 *  type number, so ffmpeg needs an SDP to be told it is H.265.
 *
 *  `c=IN IP4 0.0.0.0`, NOT 127.0.0.1 as rtspRelayBridge writes — that bridge
 *  reads a LOCAL wfb_rx on the same machine, whereas here the packets arrive
 *  from the decoder over Ethernet. A loopback connection address binds a
 *  loopback socket and silently receives nothing from 192.168.50.12. Same
 *  reasoning as ADR-006. */
function writeReceiverSdp(port: number): string {
    const cached = _sdpPaths.get(port)
    if (cached && fs.existsSync(cached)) return cached
    const file = path.join(os.tmpdir(), `hyrak-receiver-${port}.sdp`)
    fs.writeFileSync(file, [
        'v=0',
        'o=- 0 0 IN IP4 0.0.0.0',
        's=hyrak-receiver',
        'c=IN IP4 0.0.0.0',
        't=0 0',
        `m=video ${port} RTP/AVP 96`,
        'a=rtpmap:96 H265/90000',
        '',
    ].join('\n'))
    _sdpPaths.set(port, file)
    return file
}

// ---------------------------------------------------------------------------
// GStreamer pipeline
// ---------------------------------------------------------------------------

export function buildGstArgs(cfg: ReceiverConfig, plan: Plan): string[] {
    const L = latency(cfg)
    const t = transport(cfg)

    let src: string[]
    if (t === 'rtsp') {
        // ONE jitter buffer, not two. The integration doc's pipeline sets
        // `latency=50` on rtspsrc AND puts an explicit `rtpjitterbuffer
        // latency=50` after it — but rtspsrc CONTAINS an rtpjitterbuffer and
        // that property configures it, so the two are in series and the real
        // budget is 100ms. Dropping the second element halves it for free.
        //
        // rtspsrc's own default is latency=2000. That single number, not the
        // TCP transport, is most of why a generic RTSP client looks a second
        // behind — which is what the doc observed with VLC.
        src = [
            'rtspsrc', `location=${rtspUrl(cfg)}`,
            `protocols=${cfg.rtspTransport ?? 'tcp'}`,
            `latency=${L}`,
            // Without this, `latency` is only a target: the buffer may grow
            // past it over a session and nothing pulls it back to the live
            // edge. The integration doc records this as the actual fix for
            // latency creeping back up during testing, not as tuning.
            'drop-on-latency=true',
            // We are already inside a retransmitting transport on TCP, and on
            // UDP a NAK costs a round trip we would rather spend on being
            // current. Either way the answer is no.
            'do-retransmission=false',
            // Never slave the pipeline clock to a wall clock. A live view is
            // "show me the newest frame", not "present this at its scheduled
            // time" — and clock slewing is exactly how a buffer silently grows.
            'ntp-sync=false',
            // Do not stall shutdown waiting to send TEARDOWN to a box that may
            // already be gone. Restarts have to be fast; see the watchdog.
            'teardown-timeout=0',
            '!', 'rtph265depay',
            '!', 'h265parse', 'config-interval=-1',
        ]
    } else if (t === 'srt') {
        src = [
            'srtsrc', `uri=srt://${host(cfg)}:${cfg.srtPort ?? DEFAULT_SRT_PORT}`,
            'mode=caller',
            // MILLISECONDS here (contrast srtInputUrl's microseconds).
            `latency=${L}`,
            `streamid=${cfg.srtStreamId ?? DEFAULT_SRT_STREAM_ID}`,
            'auto-reconnect=true',
            // MediaMTX serves SRT as MPEG-TS, not RTP — so this leg demuxes a
            // container instead of depayloading.
            '!', 'tsdemux', 'latency=0',
            '!', 'h265parse', 'config-interval=-1',
        ]
    } else {
        src = [
            'udpsrc', `port=${cfg.udpPort ?? DEFAULT_UDP_PORT}`, `caps=${H265_RTP_CAPS}`,
            // The kernel receive buffer. The default is well under half a
            // second of a 20 Mbps stream, and an overflow is indistinguishable
            // from a bad radio link — it looks exactly like RF loss.
            'buffer-size=4194304',
            '!', 'rtpjitterbuffer', `latency=${L}`, 'drop-on-latency=true',
            '!', 'rtph265depay',
            // config-interval=-1 repeats VPS/SPS/PPS with every keyframe. Not
            // cosmetic: anything attaching mid-stream (the server's decoder,
            // a reconnecting WebCodecs decoder) otherwise decodes nothing
            // until the air unit next happens to send parameter sets.
            '!', 'h265parse', 'config-interval=-1',
        ]
    }

    const out = plan.transcode
        ? [
            '!', plan.decoder!,
            // Bring the frame back from GPU memory before anything else looks
            // at it — see converterFor.
            ...converterFor(plan.decoder!).flatMap((e) => ['!', e]),
            ...(cfg.maxHeight ? ['!', 'videoscale', '!', `video/x-raw,height=${cfg.maxHeight}`] : []),
            '!', plan.encoder!, ...encoderTuning(plan.encoder!),
            '!', 'h264parse', 'config-interval=-1',
            '!', 'video/x-h264,stream-format=byte-stream,alignment=au',
            '!', 'fdsink', 'fd=3', 'sync=false',
        ]
        : [
            // Passthrough. alignment=au makes each WRITE one access unit; the
            // reader still has to re-split because a pipe does not preserve
            // buffer boundaries (see annexb.ts).
            '!', 'video/x-h265,stream-format=byte-stream,alignment=au',
            '!', 'fdsink', 'fd=3', 'sync=false',
        ]

    if (!cfg.uplinkHost || !cfg.uplinkPort) return [...src, ...out]

    // Two consumers, so the stream is split. Each branch needs its OWN queue —
    // mandatory with tee, not decorative: without one, a stalled branch blocks
    // the other and then the source, so a hiccup in the preview would stop the
    // AI uplink dead. leaky=downstream makes a congested branch shed its own
    // old buffers rather than backpressure a live source that cannot be slowed
    // down anyway.
    //
    // Both branches carry COMPRESSED video, where shedding a buffer corrupts
    // every frame until the next IDR — so the budgets are generous and only
    // sustained overload should ever reach them.
    const queue = (ms: number) => [
        'queue', 'leaky=downstream', 'max-size-buffers=0', 'max-size-bytes=0',
        `max-size-time=${ms * 1_000_000}`,
    ]

    return [
        ...src,
        '!', 'tee', 'name=t',
        't.', '!', ...queue(1000), ...out,
        // The uplink carries the ORIGINAL H.265 untouched — mpegtsmux only
        // containerises. The server's AI therefore sees exactly what the
        // drone's encoder produced, whatever the preview had to do locally.
        't.', '!', ...queue(3000),
        // alignment=7 packs 7x188 = 1316 bytes, the standard MPEG-TS-over-SRT
        // payload. Without it srtsink sends arbitrarily sized buffers, the
        // receiver's demuxer parses none of them, and the listener writes ZERO
        // bytes while every component reports success.
        '!', 'mpegtsmux', 'alignment=7',
        ...uplinkSink(cfg),
    ]
}

/** The sink that carries the copied video to the server, matching whatever
 *  the backend allocated. Three listeners, three callers. */
function uplinkSink(cfg: ReceiverConfig): string[] {
    const host = cfg.uplinkHost!
    const port = cfg.uplinkPort!
    switch (cfg.uplinkTransport ?? 'srt') {
        case 'tcp':
            // A failed uplink must never stall the pipeline drawing the
            // pilot's screen, hence the async/blocksize settings below on
            // every variant.
            return ['!', 'tcpclientsink', `host=${host}`, `port=${port}`, 'sync=false']
        case 'udp':
            return ['!', 'udpsink', `host=${host}`, `port=${port}`, 'sync=false', 'async=false']
        default:
            return [
                '!', 'srtsink',
                `uri=srt://${host}:${port}`,
                'mode=caller',
                `latency=${cfg.uplinkLatencyMs ?? 150}`,
                ...(cfg.uplinkStreamId
                    ? [`streamid=${cfg.uplinkStreamId}`, `passphrase=${cfg.uplinkStreamId}`, 'pbkeylen=16']
                    : []),
                // The preview keeps running even with the server unreachable.
                'wait-for-connection=false', 'sync=false',
            ]
    }
}

/** Per-encoder low-latency settings. Every one of these says the same two
 *  things in a different vocabulary: no B-frames, and no rate-control window
 *  that could hold a finished frame back. */
function encoderTuning(encoder: string): string[] {
    switch (encoder) {
        case 'nvh264enc':
            return ['preset=low-latency-hq', 'rc-mode=cbr', 'bitrate=8000', 'zerolatency=true', 'bframes=0']
        case 'mfh264enc':
            return ['low-latency=true', 'bitrate=8000']
        case 'vah264enc':
            // The `va` plugin is a rewrite of `vaapi`, not a rename, and the
            // properties differ: qpi/qpp/key-int-max/target-usage here against
            // init-qp/keyframe-period/quality-level there. Passing the wrong
            // set is a FATAL pipeline parse error ("no property init-qp in
            // element vah264enc"), which kills the preview and the uplink with
            // it — which is exactly why verifyElement now tests an element
            // together with the properties it will actually be given.
            return ['rate-control=cqp', 'qpi=26', 'qpp=26', 'key-int-max=60',
                'target-usage=7', 'b-frames=0', 'ref-frames=1']
        case 'vaapih264enc':
            // CQP, i.e. no rate control at all. A Coded Picture Buffer is a
            // promise about bitrate across a window, and honouring it means
            // DELAYING a frame that overshoots — at 8 Mbps a 120ms CPB is
            // ~120KB while a 1080p keyframe is routinely larger, so every
            // keyframe got spread over several frame times. The preview never
            // leaves this machine, so bitrate is worth nothing here and
            // predictable per-frame timing is worth everything.
            return ['rate-control=cqp', 'init-qp=26', 'keyframe-period=60',
                'quality-level=7', 'max-bframes=0']
        case 'mpph264enc':
            return ['rc-mode=cbr', 'bps=8000000', 'gop=60']
        case 'v4l2h264enc':
            return ['extra-controls=controls,h264_profile=4,video_bitrate=8000000']
        case 'openh264enc':
            // slice-mode=n-slices num-slices=1 — ONE slice per picture.
            //
            // `slice-mode=auto` means "as many slices as threads", which was
            // set here and was actively harmful: an 8-thread encode emitted 8
            // slices per frame, and a decoder handed those as separate access
            // units sees fragments of pictures rather than pictures. Measured
            // against the real air unit: 2897 "access units" and 227
            // keyframes in 6 seconds from a 24 fps source, ffmpeg reporting
            // `decode_slice_header error`, and a black pane in the app.
            //
            // annexb.ts now splits multi-slice pictures correctly regardless,
            // but a single slice is also simply the right output for a live
            // preview: slices exist for parallelism and loss resilience,
            // neither of which applies over a loopback pipe.
            return ['rate-control=bitrate', 'bitrate=8000000', 'complexity=low',
                'gop-size=30', 'slice-mode=n-slices', 'num-slices=1']
        case 'x264enc':
            return ['tune=zerolatency', 'speed-preset=ultrafast', 'bitrate=8000', 'key-int-max=30']
        default:
            return []
    }
}

// ---------------------------------------------------------------------------
// ffmpeg pipeline
// ---------------------------------------------------------------------------

/** The ffmpeg spelling of uplinkSink. Note SRT latency is MICROSECONDS here
 *  and milliseconds in GStreamer — the same number in the wrong unit asks for
 *  a buffer a thousand times too long and the stream never starts. */
function uplinkUrl(cfg: ReceiverConfig): string {
    const hostPort = `${cfg.uplinkHost}:${cfg.uplinkPort}`
    switch (cfg.uplinkTransport ?? 'srt') {
        case 'tcp': return `tcp://${hostPort}`
        case 'udp': return `udp://${hostPort}?pkt_size=1316`
        default:
            return `srt://${hostPort}?mode=caller&latency=${(cfg.uplinkLatencyMs ?? 150) * 1000}`
                + (cfg.uplinkStreamId
                    ? `&streamid=${encodeURIComponent(cfg.uplinkStreamId)}`
                    + `&passphrase=${encodeURIComponent(cfg.uplinkStreamId)}&pbkeylen=16`
                    : '')
    }
}

export function buildFfmpegArgs(cfg: ReceiverConfig, plan: Plan): string[] {
    const t = transport(cfg)

    // Applied to the INPUT, before -i, or they are silently ignored. These are
    // most of why a tuned client beats VLC on the same stream:
    //   nobuffer/low_delay   do not accumulate before emitting
    //   max_delay 0          never hold a packet waiting for a possibly
    //                        out-of-order one that may never come
    //
    // probesize/analyzeduration are deliberately NOT minimised, which is the
    // opposite of the usual low-latency advice and was arrived at by testing
    // against the real ground unit.
    //
    // Driving them to `-probesize 32 -analyzeduration 0` makes ffmpeg give up
    // before it has seen VPS/SPS/PPS and exit outright with `dimensions not
    // set` / `Could not write header (incorrect codec parameters ?)`.
    //
    // But 1 second was still wrong, and wrong in a much nastier way — it
    // FLAPPED. Measured on the air unit's real stream: 24 fps with a 60-frame
    // GOP, i.e. **a keyframe every ~2.5 seconds**. A 1s probe therefore
    // succeeded only when the stream happened to be opened within 1s of an
    // IDR, so roughly half the attempts failed, the ladder stepped down, and
    // the mode looked like an unreliable decode path when the decoding was
    // never the problem.
    //
    // The window has to comfortably exceed the source's keyframe interval.
    // 5s is 2x the measured one and leaves room for a slower GOP later. Both
    // values are CEILINGS on the startup probe, not fixed waits — it ends the
    // moment parameters are found — so this costs nothing on a healthy stream
    // and neither affects steady-state latency, which nobuffer/low_delay own.
    const lowLatency = [
        '-fflags', 'nobuffer',
        '-flags', 'low_delay',
        '-probesize', '5000000',
        '-analyzeduration', '5000000',
        '-max_delay', '0',
    ]

    let input: string[]
    if (t === 'rtsp') {
        input = [
            '-rtsp_transport', cfg.rtspTransport ?? 'tcp',
            // Bound the handshake so a decoder that is powered off fails fast
            // and hits the backoff instead of hanging Start.
            //
            // `-timeout`, NOT `-rw_timeout`. The latter is a protocol-level
            // option that the RTSP demuxer does not accept, and ffmpeg treats
            // that as fatal — `Option rw_timeout not found` / `Error opening
            // input files: Option not found`, before it ever dials the
            // decoder. Verified against the real ground unit: with it, RTSP
            // never worked at all; without it, RTSP works. `-stimeout` is the
            // old spelling and is rejected outright by this build.
            '-timeout', '5000000',
            ...lowLatency,
            '-reorder_queue_size', '0',
            '-i', rtspUrl(cfg),
        ]
    } else if (t === 'srt') {
        input = [...lowLatency, '-i', srtInputUrl(cfg)]
    } else {
        input = [
            '-protocol_whitelist', 'file,udp,rtp',
            // The socket buffer, for the same reason udpsrc gets buffer-size.
            '-buffer_size', '4194304',
            ...lowLatency,
            '-reorder_queue_size', '0',
            '-i', writeReceiverSdp(cfg.udpPort ?? DEFAULT_UDP_PORT),
        ]
    }

    const preview = plan.transcode
        ? [
            '-an',
            ...(cfg.maxHeight ? ['-vf', `scale=-2:${cfg.maxHeight}`] : []),
            '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
            '-g', '30', '-bf', '0', '-b:v', '8M',
            '-f', 'h264', 'pipe:1',
        ]
        // -c copy: ffmpeg is a DEMUXER here and nothing more. This is the
        // property that makes the bundled build's lack of GPU access
        // irrelevant rather than a problem to route around.
        //
        // No hevc_mp4toannexb bitstream filter: every source here (RTP after
        // depay, MPEG-TS from SRT) is already Annex-B and the `hevc` muxer
        // emits Annex-B anyway, so the filter is at best a no-op and at worst
        // an error on input it was not meant for.
        : ['-an', '-c:v', 'copy', '-f', 'hevc', 'pipe:1']

    const uplink = cfg.uplinkHost && cfg.uplinkPort
        // A second OUTPUT on the same process — ffmpeg's own tee, no extra
        // decode and no extra socket on the decoder. The server receives the
        // original H.265 bit-exact.
        ? ['-an', '-c:v', 'copy', '-f', 'mpegts', uplinkUrl(cfg)]
        : []

    return ['-hide_banner', '-loglevel', 'warning', ...input, ...preview, ...uplink]
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export class ReceiverBridge implements NativeBridge {
    readonly kind = 'hyrak-receiver'
    private conns = new Map<string, Conn>()

    async start(
        id: string,
        config: Record<string, unknown>,
        emit: EmitFn,
    ): Promise<{ ok: boolean; error?: string; meta?: Record<string, unknown> }> {
        const cfg = config as unknown as ReceiverConfig
        const caps = probeCapabilities()
        const ladder = planLadder(cfg, caps)
        const plan = ladder[0]

        if (cfg.backend === 'gstreamer' && !caps.gst) {
            return { ok: false, error: 'GStreamer backend requested but gst-launch-1.0 is not installed.' }
        }

        // Preflight the UDP port, because losing this race is SILENT.
        //
        // Both ffmpeg and udpsrc bind with SO_REUSEADDR, so when another
        // process already holds the port neither reports an error — the second
        // binder simply never receives a unicast datagram. Downstream that is
        // indistinguishable from the radio being off, and it is a real
        // situation rather than a hypothetical: the app's own air_unit_srt
        // mode reads the same udp:5600, so switching modes could leave the
        // previous one's ffmpeg holding it.
        if (transport(cfg) === 'udp') {
            const port = cfg.udpPort ?? DEFAULT_UDP_PORT
            const busy = await portIsBusy(port)
            if (busy) {
                return {
                    ok: false,
                    error: `udp:${port} is already in use by another program, so no video can `
                        + 'reach the receiver. Stop any other HYRAK video mode (Air unit → SRT '
                        + 'holds this same port), QGroundControl, or gst-decode.sh — or switch '
                        + 'the transport to RTSP, which connects outward and needs no port here.',
                }
            }
        }

        await this.stop(id)

        const conn: Conn = {
            proc: null, server: null, clients: new Set(), pending: new Set(),
            restarts: 0, stopping: false, cfg, ladder, rung: 0, emit, stderrTail: '',
            auTail: null, auSeq: 0, lastByteAt: 0, watchdog: null, onFirstBytes: null,
            killedByWatchdog: false, lastUplinkIssue: '', lastUplinkIssueAt: 0,
        }

        const server = http.createServer((req, res) => {
            if (req.url !== '/preview') { res.writeHead(404); res.end(); return }
            // Nagle coalesces small writes and waits for an ACK before sending
            // the next partial one, so access units leave in CLUMPS instead of
            // as they are produced. The symptom is not steady delay but delay
            // that oscillates, which reads as a decoder problem and is not.
            res.socket?.setNoDelay(true)
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Cache-Control': 'no-store',
                // The page is served from https://<site>, so this loopback
                // request is cross-origin and is rejected without this.
                'Access-Control-Allow-Origin': '*',
                Connection: 'close',
            })
            // Deliberately writes NOTHING yet.
            //
            // The obvious move — cache the first keyframe and replay it to
            // late joiners — is what the fMP4 path does, and it is wrong here.
            // There, the cached bytes are ftyp+moov: a static header. Here
            // they are a PICTURE, and the live frames that follow reference
            // whatever keyframe is current, not the one from the start of the
            // session. A decoder handed a minutes-old keyframe followed by
            // deltas that depend on a different one decodes exactly one frame
            // and then fails — observed as "Decoding error" and a black pane,
            // on both the H.264 and H.265 paths.
            //
            // So a new viewer waits for the next real keyframe instead. That
            // is bounded by the GOP, and the transcode's GOP is set to ~1s for
            // exactly this reason.
            conn.pending.add(res)
            req.on('close', () => { conn.clients.delete(res); conn.pending.delete(res) })
        })
        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject)
                server.listen(cfg.previewPort ?? 0, '127.0.0.1', () => resolve())
            })
        } catch (err) {
            return { ok: false, error: `couldn't start the preview server — ${(err as Error).message}` }
        }
        conn.server = server
        this.conns.set(id, conn)

        // Wait for real video before claiming success. See READY_TIMEOUT_MS —
        // returning ok:true on spawn is how a pipeline that died in 80ms used
        // to surface as an unexplained failure 25 seconds later.
        const ready = new Promise<boolean>((resolve) => {
            let settled = false
            const done = (v: boolean) => { if (!settled) { settled = true; resolve(v) } }
            conn.onFirstBytes = () => done(true)
            setTimeout(() => done(false), READY_TIMEOUT_MS)
        })

        this.launch(id, conn)
        const gotVideo = await ready
        // Re-read AFTER waiting: the ladder can step down during those first
        // seconds, and reporting the plan we started with would tell the
        // renderer to configure a decoder for a codec that is no longer being
        // produced — a black pane with no error.
        const live = conn.ladder[conn.rung]

        const addr = server.address()
        const previewPort = typeof addr === 'object' && addr ? addr.port : 0
        const meta: Record<string, unknown> = {
            connected: true,
            previewUrl: previewPort ? `http://127.0.0.1:${previewPort}/preview` : null,
            // The renderer MUST branch on this rather than on what it asked
            // for: it decides whether to configure an HEVC or an H.264
            // decoder, and guessing wrong is a black pane with no error.
            codec: live.codec,
            backend: live.backend,
            accel: live.accel,
            transcode: live.transcode,
            decoder: live.decoder,
            encoder: live.encoder,
            why: live.why,
            transport: transport(cfg),
            latencyMs: latency(cfg),
            source: describeSource(cfg),
            gstAvailable: caps.gst,
            hardwareAvailable: caps.hardware,
            // False means the process is alive but nothing arrived yet. Not
            // fatal — the decoder may simply not be transmitting — but the UI
            // should say "waiting for video" rather than pretending.
            receiving: gotVideo,
            uplink: cfg.uplinkHost && cfg.uplinkPort
                ? `${cfg.uplinkTransport ?? 'srt'}://${cfg.uplinkHost}:${cfg.uplinkPort}`
                + (cfg.uplinkStreamId ? ' (streamid=***, passphrase=***)' : '')
                : null,
        }
        if (!gotVideo) meta.warning = waitingMessage(cfg)

        emit({ bridge: this.kind, id, type: 'status', meta })
        return { ok: true, meta }
    }

    private launch(id: string, conn: Conn): void {
        const { cfg, emit } = conn
        const plan = conn.ladder[conn.rung]
        const isGst = plan.backend === 'gstreamer'
        const bin = isGst ? GST : FFMPEG_PATH
        const args = isGst ? buildGstArgs(cfg, plan) : buildFfmpegArgs(cfg, plan)

        // GStreamer's video leaves on fd 3, not stdout, and the pipeline is NOT
        // run with -q.
        //
        // Those two go together. -q was there because gst-launch writes its
        // progress chatter to STDOUT, which would corrupt an Annex-B stream
        // sharing that pipe. But -q also silences srtsink's warnings — and a
        // REJECTED SRT connection reports itself only as a warning:
        //
        //   WARNING ... GstSRTSink: Socket is broken or closed. Trying to reconnect
        //
        // Under -q that is completely silent. So an uplink failing
        // authentication looked identical to one working perfectly, from
        // inside the app and from the logs, which is most of why the AI
        // modes took so long to diagnose. Moving video to a dedicated fd buys
        // back stderr without giving up a clean stream.
        const proc = isGst
            ? spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })
            : spawn(bin, args)
        proc.on('error', (err) => {
            if (conn.proc !== proc || conn.stopping) return
            emit({
                bridge: this.kind, id, type: 'status',
                meta: { connected: false, error: `${isGst ? 'GStreamer' : 'ffmpeg'} failed to start — ${err.message}` },
            })
            void this.stop(id)
        })
        trackChild(proc)
        conn.proc = proc
        conn.lastByteAt = Date.now()
        conn.killedByWatchdog = false
        const spawnedAt = Date.now()

        const video = (isGst ? proc.stdio[3] : proc.stdout) as NodeJS.ReadableStream
        video.on('data', (chunk: Buffer) => {
            // First bytes of the session release start()'s readiness wait.
            const first = conn.onFirstBytes
            if (first) { conn.onFirstBytes = null; first() }
            conn.lastByteAt = Date.now()
            conn.auTail = conn.auTail ? Buffer.concat([conn.auTail, chunk]) : chunk
            const { units, rest } = splitAnnexB(conn.auTail, plan.codec)
            conn.auTail = rest
            for (const u of units) {
                // A keyframe is the only safe place to start, so it is also
                // where waiting viewers are admitted.
                if (u.key && conn.pending.size) {
                    for (const res of conn.pending) conn.clients.add(res)
                    conn.pending.clear()
                }
                const framed = frameAu(u.data, u.key, conn.auSeq++)
                for (const res of conn.clients) res.write(framed)
            }
        })

        const scanLogs = (d: Buffer) => {
            const text = d.toString()
            conn.stderrTail = (conn.stderrTail + text).slice(-4000)
            // Surface UPLINK trouble immediately instead of burying it.
            //
            // The uplink is a side branch: when it fails the preview keeps
            // playing, the process stays alive, no restart fires, and this
            // stderr is only ever read if something ELSE later goes wrong. So
            // the operator sees a perfect local picture and no AI overlays,
            // with the actual reason sitting unread in a buffer. That is
            // precisely the state the AI modes were stuck in, and it cost far
            // more time than the bug itself would have.
            if (!conn.cfg.uplinkHost) return
            for (const raw of text.split('\n')) {
                const line = raw.trim()
                if (!line) continue
                // Only genuine faults on the uplink elements. "Progress:
                // (connect) Connecting to rtsp://…" is the INPUT leg doing
                // its job and would otherwise be reported as an uplink
                // problem — a diagnostic that cries wolf is worse than none.
                if (!/(srtsink|tcpclientsink|udpsink)/i.test(line)) continue
                if (!/(WARNING|ERROR|broken|closed|refus|reject|auth|timeout)/i.test(line)) continue
                // srtsink retries per buffer, so an unreachable server emits
                // this dozens of times a second. Report the transition, not
                // the storm.
                const now = Date.now()
                if (line === conn.lastUplinkIssue && now - conn.lastUplinkIssueAt < 10000) continue
                conn.lastUplinkIssue = line
                conn.lastUplinkIssueAt = now
                emit({
                    bridge: this.kind, id, type: 'status',
                    meta: {
                        connected: true, uplinkIssue: true,
                        error: `uplink to ${conn.cfg.uplinkHost}:${conn.cfg.uplinkPort} — `
                            + line.replace(/^WARNING: from element [^:]*: /, '').slice(0, 220),
                    },
                })
            }
        }
        proc.stderr?.on('data', scanLogs)
        // ALSO stdout: gst-launch reports bus messages — including the
        // "Socket is broken or closed" that a rejected SRT connection
        // produces — through g_print, which is stdout. Watching only stderr
        // caught nothing, which is how a silently rejected uplink stayed
        // invisible even after it was supposedly instrumented. Safe to read
        // now that video has moved to fd 3.
        if (isGst) proc.stdout?.on('data', scanLogs)

        proc.on('exit', (code) => this.handleExit(id, conn, proc, spawnedAt, code))

        // Starvation watchdog. A process that is alive but delivering nothing
        // is the failure this bridge exists to catch — the decoder's RF dongle
        // dropping off its USB bus leaves ffmpeg sitting contentedly on a
        // socket that will never produce another byte.
        if (conn.watchdog) clearInterval(conn.watchdog)
        conn.watchdog = setInterval(() => {
            if (conn.stopping || conn.proc !== proc) return
            if (Date.now() - conn.lastByteAt < STARVATION_MS) return
            emit({
                bridge: this.kind, id, type: 'status',
                meta: {
                    connected: true, stalled: true,
                    error: `No video for ${Math.round(STARVATION_MS / 1000)}s — reconnecting to `
                        + `${describeSource(cfg)}.`,
                },
            })
            // Killing it routes into handleExit, which owns the backoff. Two
            // separate restart paths would race and double-spawn. The flag
            // tells handleExit this was starvation, not a decode failure.
            conn.killedByWatchdog = true
            killChild(proc)
        }, STARVATION_MS)
    }

    private handleExit(
        id: string, conn: Conn, proc: ChildProcess,
        spawnedAt: number, code: number | null,
    ): void {
        if (conn.proc !== proc || conn.stopping) return
        const emit = conn.emit
        const ranWell = Date.now() - spawnedAt >= HEALTHY_RUN_MS
        conn.restarts = ranWell ? 0 : conn.restarts + 1

        // STARVATION IS NOT A DECODE FAILURE, and conflating the two is
        // actively harmful: the pipeline is healthy, it simply has no input,
        // so walking every rung of the decode ladder changes nothing, takes
        // ~30 seconds, and ends by blaming the codec for a problem that was
        // always the source. Observed in the field doing exactly that, while
        // the real cause was another process still holding udp:5600.
        //
        // The watchdog knows which case this is, because it is the thing that
        // killed the process. On starvation: stay on this rung, say what is
        // actually wrong, and keep retrying — the input may well come back.
        // Same reasoning for a process that exited on its own because it could
        // not reach or hold the SOURCE. Observed on the real decoder: one
        // refused RTSP connect at startup stepped the ladder off passthrough
        // for no reason, and the stream then ran fine on the rung below —
        // silently costing hardware decode because of a transient handshake.
        // A network error says nothing about whether this machine can decode.
        if (conn.killedByWatchdog || isInputFailure(conn.stderrTail)) {
            conn.killedByWatchdog = false
            // Bounded like every other retry path. Waiting for an input that
            // may return is reasonable; doing so forever is how a client ends
            // up hammering a one-core decoder all afternoon with the UI
            // insisting everything is fine (integration doc, open item 4).
            if (conn.restarts > MAX_CONSECUTIVE_RESTARTS) {
                emit({
                    bridge: this.kind, id, type: 'status',
                    meta: {
                        connected: false, code,
                        error: describeFailure(conn.stderrTail, conn.cfg, conn.ladder[conn.rung]),
                        log: conn.stderrTail,
                    },
                })
                void this.stop(id)
                return
            }
            emit({
                bridge: this.kind, id, type: 'status',
                meta: {
                    connected: true, stalled: true,
                    error: waitingMessage(conn.cfg),
                },
            })
            const wait = Math.min(RESTART_BASE_MS * 2 ** Math.max(0, conn.restarts - 1), RESTART_MAX_MS)
            setTimeout(() => {
                if (!conn.stopping && this.conns.get(id) === conn) {
                    conn.auTail = null
                    this.launch(id, conn)
                }
            }, wait)
            return
        }

        // Died on arrival, twice, on a rung that has a fallback below it: this
        // is the "element registered but this machine cannot service it" case,
        // and retrying the identical pipeline five more times cannot help.
        // Step down instead. The ladder is walked, never skipped to the
        // bottom, because the failing end may be only one half of the plan —
        // see planLadder for the machine where NVDEC works and NVENC does not.
        if (!ranWell && conn.restarts >= 2 && conn.rung < conn.ladder.length - 1) {
            const failed = conn.ladder[conn.rung]
            conn.rung += 1
            conn.restarts = 0
            const next = conn.ladder[conn.rung]
            emit({
                bridge: this.kind, id, type: 'status',
                meta: {
                    connected: true, demoted: true,
                    accel: next.accel, codec: next.codec, backend: next.backend,
                    decoder: next.decoder, encoder: next.encoder, why: next.why,
                    error: `${failed.why} — failed on this machine, falling back to: ${next.why}`,
                    log: conn.stderrTail.slice(-300),
                },
            })
        } else if (conn.restarts > MAX_CONSECUTIVE_RESTARTS) {
            emit({
                bridge: this.kind, id, type: 'status',
                meta: {
                    connected: false, code,
                    error: describeFailure(conn.stderrTail, conn.cfg, conn.ladder[conn.rung]),
                    log: conn.stderrTail,
                },
            })
            void this.stop(id)
            return
        }

        // Exponential with a ceiling. The decoder has one Cortex-A7 core and a
        // client retrying in a tight loop has already been measured degrading
        // its video — backing off is a courtesy to the hardware, not just to
        // this app.
        const delay = Math.min(RESTART_BASE_MS * 2 ** Math.max(0, conn.restarts - 1), RESTART_MAX_MS)
        setTimeout(() => {
            if (!conn.stopping && this.conns.get(id) === conn) {
                conn.auTail = null
                this.launch(id, conn)
            }
        }, delay)
    }

    async stop(id: string): Promise<void> {
        const conn = this.conns.get(id)
        if (!conn) return
        conn.stopping = true
        if (conn.watchdog) clearInterval(conn.watchdog)
        killChild(conn.proc)
        for (const res of [...conn.clients, ...conn.pending]) {
            try { res.end() } catch { /* already closed */ }
        }
        conn.clients.clear()
        conn.pending.clear()
        try { conn.server?.close() } catch { /* already closed */ }
        this.conns.delete(id)
    }

    send(): void {
        // One way: video in, preview out. Telemetry is udpBridge's job.
    }
}

/** True when the failure is about REACHING the source rather than decoding it.
 *
 *  The distinction decides whether stepping down the decode ladder can
 *  possibly help. It cannot when the decoder was never given anything: a
 *  refused connection, a 404 path, a dead route and an unreachable host all
 *  fail identically on every rung, so walking them burns ~30 seconds and ends
 *  by blaming the codec. */
function isInputFailure(stderr: string): boolean {
    // A bare /timeout/ was tried and is WRONG: it matches ffmpeg's own
    // complaint about the option name `rw_timeout`, so a fatal
    // bad-arguments exit was classified as a network blip and retried
    // forever on a rung that could never work. Match the phrases, not the
    // word.
    return /Connection refused|Connection reset|No route to host|Network is unreachable|Name or service not known/i.test(stderr)
        || /404 Not Found|Server returned 4\d\d|401 Unauthorized/i.test(stderr)
        || /timed out|Operation timed out|Connection timed out/i.test(stderr)
        || /Could not open resource|Could not connect|Resource not found|Failed to connect/i.test(stderr)
        || /Immediate exit requested|End of file/i.test(stderr)
}

/** True when something else already holds this UDP port.
 *
 *  `exclusive: true` is the whole point — it disables SO_REUSEADDR for this
 *  test bind, so a port another process is using fails with EADDRINUSE
 *  instead of quietly succeeding and receiving nothing. */
function portIsBusy(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const probe = dgram.createSocket({ type: 'udp4', reuseAddr: false })
        probe.once('error', () => { try { probe.close() } catch { /* already gone */ } resolve(true) })
        probe.bind({ port, exclusive: true }, () => {
            probe.close(() => resolve(false))
        })
    })
}

function describeSource(cfg: ReceiverConfig): string {
    switch (transport(cfg)) {
        case 'rtsp': return rtspUrl(cfg)
        case 'srt': return `srt://${host(cfg)}:${cfg.srtPort ?? DEFAULT_SRT_PORT}`
        default: return `udp:${cfg.udpPort ?? DEFAULT_UDP_PORT}`
    }
}

/** Shown while the process is healthy but no video has arrived. The two
 *  transports fail for opposite reasons and the advice differs, so this does
 *  not try to give one generic answer. */
function waitingMessage(cfg: ReceiverConfig): string {
    if (transport(cfg) === 'udp') {
        return `Connected, but nothing has arrived on udp:${cfg.udpPort ?? DEFAULT_UDP_PORT} yet. `
            + 'The ground unit PUSHES on this transport, so it needs this PC\'s address '
            + `(wfb_rx -c <this-pc>) — and the firewall has to allow inbound UDP `
            + `${cfg.udpPort ?? DEFAULT_UDP_PORT}. RTSP avoids both (we connect outward instead).`
    }
    return `Connected to ${describeSource(cfg)}, but no video yet — is the air unit powered `
        + 'and transmitting?'
}

function describeFailure(stderr: string, cfg: ReceiverConfig, plan: Plan): string {
    const src = describeSource(cfg)
    if (/Address already in use|Could not bind|bind failed/i.test(stderr)) {
        return `udp:${cfg.udpPort ?? DEFAULT_UDP_PORT} is already held by another program `
            + '(QGroundControl, gst-decode.sh, or a second HYRAK window). Only one process '
            + 'can receive a UDP port.'
    }
    if (/Connection refused|No route to host|Network is unreachable|timed out|Operation timed out/i.test(stderr)) {
        return `Cannot reach the ground unit at ${src}. Check the Ethernet cable, that this PC `
            + `is on the same subnet, and that the address in Settings matches the unit.`
    }
    if (/401|Unauthorized|authentication/i.test(stderr)) {
        return `${src} rejected the connection as unauthorised — check the stream ID in Settings.`
    }
    if (/vaapi|VA-API|nvcuvid|d3d11|mpp|rockchip/i.test(stderr) && /fail|error|not.*support/i.test(stderr)) {
        return `Hardware decode failed on this machine (${plan.decoder ?? 'unknown element'}) — `
            + 'set the receiver to software decode in Settings.'
    }
    if (/not-negotiated|Internal data stream error|Invalid data found/i.test(stderr)) {
        return `Nothing decodable arriving from ${src} — the transport connected but the payload `
            + 'is not H.265 RTP. Check the transport setting matches how the ground unit is serving.'
    }
    return `HYRAK Receiver failed on ${src}. Last output: `
        + (stderr.trim().split('\n').slice(-2).join(' ') || '(none)')
}
