import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import http from 'node:http'
import type { NativeBridge, EmitFn } from './types'
import { trackChild, killChild } from './processGuard'
import { frameAu, splitAnnexB } from './annexb'

// Local air-unit preview built on GStreamer instead of ffmpeg.
//
// Why this exists alongside rtspRelayBridge's preview:
//
// 1. HARDWARE. The BUNDLED ffmpeg (ffmpeg-static) reports only `vdpau` for
//    -hwaccels — no VAAPI, no QSV, no NVENC. It CANNOT touch a GPU, so its
//    preview is software decode + software encode on whatever laptop the
//    operator has. On the reference client (i5-8350U) that is the whole CPU
//    budget, and gst-decode.sh on the SAME machine shows a flawless ~10ms
//    picture using vaapih265dec. The gap is hardware access, not tuning.
//
// 2. THE SOCKET. GStreamer's udpsrc owns udp:5600 directly, so no video
//    packet passes through Electron's single JS event loop. That loop is
//    what silently dropped datagrams in the DataChannel path (see
//    webrtcSenderBridge's SOURCE_RCVBUF_BYTES): while it stalls, nothing
//    drains the socket and the KERNEL discards, before any copy exists.
//    A separate multi-threaded process cannot be starved that way.
//
// 3. PROVENANCE. The air unit is a GStreamer stack end to end, and
//    gst-decode.sh is the known-good reference on the client's machine.
//
// This is deliberately a NEW bridge rather than a rewrite of the ffmpeg
// preview: every shipped mode keeps working exactly as it does today, and a
// machine without GStreamer falls back to what it has now.
//
// Pipeline (hardware path):
//
//   udpsrc ! rtpjitterbuffer ! rtph265depay ! h265parse
//          ! vaapih265dec ! vapostproc ! vaapih264enc      <- GPU, both ends
//          ! h264parse ! mp4mux(fragmented) ! fdsink       -> loopback HTTP
//
// H.264 out, not H.265: Chromium ships no software HEVC decoder, so an H.265
// preview dies with MEDIA_ERR_SRC_NOT_SUPPORTED on any machine lacking
// hardware HEVC. This re-encode is display-only — the AI uplink still carries
// the original bytes untouched.

const GST = 'gst-launch-1.0'
const GST_INSPECT = 'gst-inspect-1.0'

// RTP caps for the air unit. Byte-for-byte the same description used by
// udp_video_source.py, rtspRelayBridge's SDP and gst-decode.sh — all four
// must agree or the payload is parsed as the wrong codec.
const AIR_UNIT_CAPS =
    'application/x-rtp,media=video,encoding-name=H265,clock-rate=90000,payload=96'

// Default jitter buffer. gst-decode.sh uses 50ms. This was 20ms (and the
// frontend's own default was 10ms), chosen to minimise the largest latency
// term we control — which was a mistake, because it is paired with
// drop-on-latency=true.
//
// That combination does not merely delay a late packet, it DISCARDS it. Over
// Wi-Fi, RTP inter-arrival jitter routinely exceeds 20ms, so the pipeline was
// throwing away packets on a link that had not actually lost any. And a
// dropped packet in a COMPRESSED stream is not one lost frame: the NAL it
// belonged to is broken, and every frame that references it stays broken
// until the next IDR. The server's decoder logged exactly that, continuously
// — "Could not find ref with POC …", "cu_qp_delta … outside the valid range",
// "CABAC_MAX_BIN" — and delivered 1.0 fps of decodable video out of ~19 fps
// arriving, because it could only emit around keyframes.
//
// 60ms is the smallest window that survives ordinary Wi-Fi jitter. It costs
// real latency, and that is the correct trade: 60ms of delay is worth less
// than a stream the AI modes cannot decode.
const DEFAULT_JITTER_MS = 60

// Must equal frontend DEFAULT_RELAY_LATENCY_MS and backend DEFAULT_LATENCY_MS.
const DEFAULT_SRT_LATENCY_MS = 150

// A finished fMP4 fragment is only emitted once complete, so this is added to
// the preview's delay in full. 20ms is under one frame at 30fps.
const FRAGMENT_MS = 20

const RESTART_DELAY_MS = 2000
const RESTART_WINDOW_MS = 5000
const MAX_CONSECUTIVE_RESTARTS = 5

export interface GstPreviewConfig {
    udpPort?: number            // where wfb_rx delivers RTP (default 5600)
    previewPort?: number        // loopback HTTP port; 0/omitted = OS-assigned
    jitterMs?: number
    // Force a path instead of probing. 'auto' (default) prefers hardware and
    // silently falls back; the ACTIVE choice is always reported in meta.
    accel?: 'auto' | 'hardware' | 'software'
    // Cap the encoded height. 0 = native. Display-only.
    maxHeight?: number

    // Emit framed H.264 access units for WebCodecs instead of fragmented MP4.
    //
    // The fMP4 path hands Chromium a progressive <video>, which buffers on its
    // own schedule and cannot be told not to. Everything downstream of that —
    // the live-edge controller, playbackRate draining, the drift that swung
    // 128-444ms and spiked to 3s — exists only to fight that buffer. WebCodecs
    // removes the buffer instead of fighting it: each access unit becomes an
    // EncodedVideoChunk, decodes, and is painted immediately. There is no
    // queue to grow, so latency stops being a control problem.
    webcodecs?: boolean

    // ---- optional SRT uplink branch (tee) ----
    // When these are set the SAME process that draws the local preview also
    // pushes the ORIGINAL H.265 to the server. That is the whole point of the
    // mode: one owner of udp:5600, two consumers, and the AI uplink is never
    // transcoded (only remuxed into MPEG-TS, which SRT requires).
    //
    // Without this the preview would have to read a fan-out copy made by
    // webrtcSenderBridge — which means every packet passes through Electron's
    // single JS event loop first, and the loss that motivated this bridge
    // survives untouched.
    srtHost?: string
    srtPort?: number
    srtLatencyMs?: number
    // Doubles as the SRT passphrase, matching relay_video_source.py's
    // _listen_url (pbkeylen 16, enforced encryption). streamid alone
    // authenticates nothing — the listener never inspected it.
    streamId?: string
}

interface GstConn {
    proc: ChildProcessWithoutNullStreams | null
    server: http.Server | null
    clients: Set<http.ServerResponse>
    initSegment: Buffer | null
    sawMoof: boolean
    restarts: number
    stopping: boolean
    cfg: GstPreviewConfig
    accel: 'hardware' | 'software'
    emit: EmitFn
    stderrTail: string
    // WebCodecs path only: leftover bytes that did not yet close an access
    // unit, and the monotonic chunk counter handed to the decoder.
    auTail: Buffer | null
    auSeq: number
}

// Annex-B splitting and framing now live in ./annexb — receiverBridge needs
// the same wire format for H.265, and H.265 needs different boundary rules
// rather than a wider NAL type mask. This bridge's behaviour is unchanged:
// splitAnnexB defaults to 'h264', which is all this pipeline ever emits.

/** True when `element` exists in this machine's GStreamer installation. */
function hasElement(element: string): boolean {
    try {
        execFileSync(GST_INSPECT, [element], { stdio: 'ignore', timeout: 4000 })
        return true
    } catch {
        return false
    }
}

let cachedProbe: { gst: boolean; hw: boolean } | null = null

/** What this machine can actually do. Cached — spawning gst-inspect four
 *  times per stream start is pure latency on the critical path. */
export function probeGstreamer(): { gst: boolean; hw: boolean } {
    if (cachedProbe) return cachedProbe
    let gst = false
    try {
        execFileSync(GST, ['--version'], { stdio: 'ignore', timeout: 4000 })
        gst = true
    } catch {
        cachedProbe = { gst: false, hw: false }
        return cachedProbe
    }
    // Presence is necessary but NOT sufficient: vaapi elements register even
    // on machines whose GPU cannot actually service them (the same trap
    // airUnitVideoBridge documents for ffmpeg's -hwaccels, which reports
    // compile-time support). A real init failure surfaces at run time and is
    // handled by the software fallback on restart.
    const hw = ['vaapih265dec', 'vaapih264enc'].every(hasElement)
        && ['rtph265depay', 'h265parse'].every(hasElement)
    cachedProbe = { gst, hw }
    return cachedProbe
}

function buildPipeline(cfg: GstPreviewConfig, accel: 'hardware' | 'software'): string[] {
    const port = cfg.udpPort ?? 5600
    const jitter = cfg.jitterMs ?? DEFAULT_JITTER_MS
    const maxH = cfg.maxHeight ?? 0

    const src = [
        'udpsrc', `port=${port}`, `caps=${AIR_UNIT_CAPS}`,
        // The kernel receive buffer. Same lesson as the DataChannel path: the
        // default is under half a second of a 4 Mbps stream, and an overflow
        // is indistinguishable from a bad radio link.
        'buffer-size=4194304',
        '!', 'rtpjitterbuffer', `latency=${jitter}`, 'drop-on-latency=true',
        '!', 'rtph265depay',
        // config-interval=-1 re-sends SPS/PPS/VPS with every keyframe. Not
        // cosmetic: the server's decoder attaches mid-stream and without
        // repeated parameter sets it logs "PPS id out of range" and decodes
        // nothing until the air unit happens to send them again. That was a
        // visible symptom in the field logs.
        '!', 'h265parse', 'config-interval=-1',
    ]

    // videorate/scale only when asked: every element in a live path costs
    // something, and the common case is native resolution.
    const scale = maxH > 0
        ? (accel === 'hardware'
            ? ['!', 'vapostproc', '!', `video/x-raw,height=${maxH}`]
            : ['!', 'videoscale', '!', `video/x-raw,height=${maxH}`])
        : []

    const codec = accel === 'hardware'
        ? [
            '!', 'vaapih265dec',
            ...scale,
            // CQP — constant quantiser, NO rate control at all.
            //
            // This replaced `rate-control=cbr bitrate=8000 cpb-length=120`,
            // which was a mistake of mine and measurably worse. A Coded
            // Picture Buffer is a promise about bitrate over a time window,
            // and honouring it means DELAYING output when a frame overshoots.
            // At 8 Mbps a 120ms CPB is ~120KB, while a 1080p keyframe is
            // routinely larger — so every keyframe forced the encoder to
            // spread itself across several frame times. Observed as drift
            // spiking to ~3s and then decaying, over and over.
            //
            // The preview never leaves this machine: it crosses a loopback
            // pipe into the same process. Bitrate is therefore worth nothing
            // and predictable per-frame timing is worth everything, which is
            // exactly the trade CQP makes — encode each frame to a fixed
            // quality, emit it immediately, never hold one back to satisfy a
            // budget.
            //
            //   quality-level=7  fastest preset (1 = slowest/best). Quality is
            //                    irrelevant for a local monitor.
            //   max-bframes=0    default, stated explicitly: any B-frame
            //                    forces reordering, and reordering is
            //                    unconditional latency.
            //   keyframe-period  60. Keyframes are the largest, slowest frames
            //                    in the stream; halving how often they occur
            //                    halves their contribution to jitter. A local
            //                    viewer never needs a fast join point — it
            //                    attaches once, at startup.
            '!', 'vaapih264enc', 'rate-control=cqp', 'init-qp=26',
            'keyframe-period=60', 'quality-level=7', 'max-bframes=0',
        ]
        : [
            '!', 'avdec_h265',
            ...scale,
            '!', 'videoconvert',
            // ultrafast + zerolatency: no B-frames, no lookahead. On a weak
            // CPU this is the difference between realtime and falling behind,
            // and falling behind means the udpsrc socket overflows.
            '!', 'x264enc', 'tune=zerolatency', 'speed-preset=ultrafast',
            'bitrate=8000', 'key-int-max=30',
        ]

    const previewBranch = cfg.webcodecs
        ? [
            ...codec,
            // byte-stream + alignment=au: Annex-B, one access unit per buffer.
            // No container at all — the renderer feeds these straight to a
            // VideoDecoder. Node re-splits on start codes because a pipe does
            // not preserve buffer boundaries (see splitAnnexB).
            '!', 'h264parse', 'config-interval=-1',
            '!', 'video/x-h264,stream-format=byte-stream,alignment=au',
            '!', 'fdsink', 'fd=1', 'sync=false',
        ]
        : [
            ...codec,
            '!', 'h264parse',
            // fragment-duration keeps fragments short; without it the muxer
            // buffers a whole GOP and the preview starts a second late.
            '!', 'mp4mux', `fragment-duration=${FRAGMENT_MS}`, 'streamable=true', 'faststart=false',
            '!', 'fdsink', 'fd=1', 'sync=false',
        ]

    const wantUplink = !!(cfg.srtHost && cfg.srtPort)
    if (!wantUplink) return ['-q', ...src, ...previewBranch]

    // Two consumers, so the stream is split. Each branch gets its own queue —
    // mandatory with tee, not decorative: without one, a branch that stalls
    // blocks the OTHER branch and then the source, so a hiccup in the preview
    // would stop the AI uplink dead (and vice versa). leaky=downstream makes a
    // congested branch drop its own old frames instead of applying
    // backpressure to a live source that cannot be slowed down anyway.
    // Both branches carry COMPRESSED H.265, so "shed a buffer" means "corrupt
    // every frame until the next IDR" — the tee is upstream of any decoder.
    // Leaking is still the right failure mode (a stalled branch must not stop
    // the other, and a live source cannot be slowed down), but the budget has
    // to be large enough that only genuine sustained overload reaches it.
    // 500ms did not clear that bar: one Wi-Fi retransmit burst or one SRT
    // congestion window was enough to shed frames, and the receiver then
    // decoded garbage for as long as the air unit's keyframe interval.
    const queue = (ms: number) =>
        ['queue', 'leaky=downstream', 'max-size-buffers=0', 'max-size-bytes=0',
            `max-size-time=${ms * 1_000_000}`]

    // Preview drains into a loopback pipe in this same process; if it is
    // congested the renderer is wedged and dropping is genuinely correct.
    const previewQ = queue(1000)
    // The uplink crosses Wi-Fi, a WireGuard tunnel and the public internet.
    // Transient stalls there are normal and recoverable — SRT retransmits
    // within its own latency window — so this must absorb them rather than
    // destroy the stream trying to stay current.
    const uplinkQ = queue(3000)

    return [
        '-q',
        ...src,
        '!', 'tee', 'name=t',
        // Preview branch
        't.', '!', ...previewQ, ...previewBranch,
        // Uplink branch — NOT transcoded. mpegtsmux only containerises; the
        // H.265 the air unit produced reaches the server bit-exact, which is
        // the property the DataChannel mode was built for and the reason the
        // server can run its own analysis on full-quality video.
        't.', '!', ...uplinkQ,
        // alignment=7 is REQUIRED, not tuning. It packs 7x188 = 1316 bytes per
        // buffer, the standard MPEG-TS-over-SRT payload. Without it the muxer
        // emits arbitrarily sized buffers, srtsink sends them verbatim, and
        // the receiver's TS demuxer gets nothing it can parse: the connection
        // establishes, GStreamer reports no error, and the listener writes
        // ZERO bytes forever. Measured: 0 bytes without, 1.79 MB with, same
        // pipeline otherwise.
        '!', 'mpegtsmux', 'alignment=7',
        // Settings are PROPERTIES, not URI query parameters. srtsink's uri is
        // documented as "srt://address:port" and appending ?mode=…&latency=…
        // (the ffmpeg form) makes it fail to connect with no error at all —
        // the pipeline runs, the preview plays, and the uplink silently never
        // opens. Found by testing against a real listener; it would have been
        // invisible in production.
        //
        // Units differ too: GStreamer's latency is MILLISECONDS, ffmpeg's is
        // microseconds. Passing the ffmpeg value here would have asked for a
        // two-minute buffer.
        '!', 'srtsink',
        `uri=srt://${cfg.srtHost}:${cfg.srtPort}`,
        'mode=caller',
        // Falls back to the SAME value as the frontend's DEFAULT_RELAY_LATENCY_MS
        // and the backend listener's DEFAULT_LATENCY_MS. It was 120 here while
        // both of those were 300, so any path that did not explicitly pass a
        // value asked for a window under 3x the measured 41ms RTT — too short
        // for SRT to NAK and receive a resend, which shows up as RCV-DROPPED
        // and then corrupt MPEG-TS. Three constants describing one number is
        // how they drift; keep them equal.
        `latency=${cfg.srtLatencyMs ?? DEFAULT_SRT_LATENCY_MS}`,
        ...(cfg.streamId
            ? [
                `streamid=${cfg.streamId}`,
                // Must match relay_video_source.py's listener: passphrase +
                // pbkeylen 16, enforced encryption. streamid alone
                // authenticates nothing — the listener never inspected it.
                `passphrase=${cfg.streamId}`,
                'pbkeylen=16',
            ]
            : []),
        // false: a stalled or failed uplink must never block the pipeline,
        // because the same pipeline is drawing the pilot's screen. The
        // preview keeps running even with the server unreachable.
        'wait-for-connection=false', 'sync=false',
    ]
}

/** Redacted uplink description for status/logs. streamId IS the passphrase. */
function srtUri(cfg: GstPreviewConfig): string {
    return `srt://${cfg.srtHost}:${cfg.srtPort} (mode=caller, latency=${cfg.srtLatencyMs ?? DEFAULT_SRT_LATENCY_MS}ms`
        + (cfg.streamId ? ', streamid=***, passphrase=***)' : ')')
}

export class GstreamerBridge implements NativeBridge {
    readonly kind = 'gstreamer-preview'
    private conns = new Map<string, GstConn>()

    async start(
        id: string,
        config: Record<string, unknown>,
        emit: EmitFn,
    ): Promise<{ ok: boolean; error?: string; meta?: Record<string, unknown> }> {
        const cfg = config as unknown as GstPreviewConfig
        const probe = probeGstreamer()
        if (!probe.gst) {
            // Explicit, not silent: the caller falls back to the ffmpeg
            // preview, and the operator should know why they are on the
            // slower path rather than wondering.
            return {
                ok: false,
                error: 'GStreamer not installed on this machine (gst-launch-1.0 not found) '
                    + '— install gstreamer1.0-tools and the libav/vaapi plugins, '
                    + 'or use the ffmpeg preview.',
            }
        }

        const want = cfg.accel ?? 'auto'
        if (want === 'hardware' && !probe.hw) {
            return { ok: false, error: 'hardware decode requested but vaapi elements are unavailable' }
        }
        const accel: 'hardware' | 'software' =
            want === 'software' ? 'software' : (probe.hw ? 'hardware' : 'software')

        await this.stop(id)

        const conn: GstConn = {
            proc: null, server: null, clients: new Set(),
            initSegment: null, sawMoof: false,
            restarts: 0, stopping: false, cfg, accel, emit, stderrTail: '',
            auTail: null, auSeq: 0,
        }

        const server = http.createServer((req, res) => {
            if (req.url !== '/preview') { res.writeHead(404); res.end(); return }
            // Nagle's algorithm is the enemy of a live stream. It coalesces
            // small writes and waits for an ACK before sending the next
            // partial segment, so fMP4 fragments leave in CLUMPS instead of
            // as they are produced. The symptom is not steady delay — it is
            // drift that oscillates (measured 74-494ms swinging) while the
            // producing pipeline itself buffers nothing, which looks like a
            // decoder problem and is not.
            res.socket?.setNoDelay(true)
            res.writeHead(200, {
                'Content-Type': 'video/mp4',
                'Cache-Control': 'no-store',
                // The page is served from https://<site>, so this loopback
                // request is cross-origin and is rejected without this.
                'Access-Control-Allow-Origin': '*',
                Connection: 'close',
            })
            // A viewer joining mid-stream has missed ftyp+moov and would see
            // nothing but undecodable fragments. Same trap that cost four
            // releases in rtspRelayBridge.
            if (conn.initSegment) res.write(conn.initSegment)
            conn.clients.add(res)
            req.on('close', () => conn.clients.delete(res))
        })
        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject)
                server.listen(cfg.previewPort ?? 0, '127.0.0.1', () => resolve())
            })
        } catch (err) {
            return { ok: false, error: `couldn't start preview server — ${(err as Error).message}` }
        }
        conn.server = server

        this.conns.set(id, conn)
        this.launch(id, conn)

        const addr = server.address()
        const previewPort = typeof addr === 'object' && addr ? addr.port : 0
        const previewUrl = previewPort ? `http://127.0.0.1:${previewPort}/preview` : null
        const meta = {
            connected: true,
            previewUrl,
            // Reported, never assumed: a silent fall back to software is
            // exactly the kind of thing that gets mistaken for "hardware
            // acceleration didn't help".
            accel,
            hardwareAvailable: probe.hw,
            udpPort: cfg.udpPort ?? 5600,
            jitterMs: cfg.jitterMs ?? DEFAULT_JITTER_MS,
            // REPORTED, never assumed by the caller. A bridge older than
            // 0.1.47 ignores the `webcodecs` request and serves fragmented
            // MP4 — if the renderer assumed its request was honoured it would
            // parse fMP4 as framed access units and show nothing. The client
            // must branch on what actually happened.
            webcodecs: !!cfg.webcodecs,
            // Both secrets redacted: streamId IS the passphrase, so leaking
            // it into a status event or a log would hand over the ability to
            // push into this session.
            uplink: cfg.srtHost && cfg.srtPort ? srtUri(cfg) : null,
        }
        emit({ bridge: this.kind, id, type: 'status', meta })
        return { ok: true, meta }
    }

    private launch(id: string, conn: GstConn): void {
        const { cfg, emit } = conn
        const args = buildPipeline(cfg, conn.accel)
        const proc = spawn(GST, args)
        proc.on('error', (err) => {
            if (conn.proc !== proc || conn.stopping) return
            emit({
                bridge: this.kind, id, type: 'status',
                meta: { connected: false, error: `GStreamer failed to start — ${err.message}` },
            })
            void this.stop(id)
        })
        trackChild(proc)
        conn.proc = proc
        const spawnedAt = Date.now()

        if (conn.cfg.webcodecs) {
            proc.stdout.on('data', (chunk: Buffer) => {
                conn.auTail = conn.auTail ? Buffer.concat([conn.auTail, chunk]) : chunk
                const { units, rest } = splitAnnexB(conn.auTail)
                conn.auTail = rest
                for (const u of units) {
                    // The first keyframe (with its parameter sets) is cached
                    // and replayed to late joiners — a decoder handed a
                    // delta frame first cannot start, and would sit black
                    // until the next keyframe.
                    if (u.key && !conn.initSegment) conn.initSegment = frameAu(u.data, true, 0)
                    const framed = frameAu(u.data, u.key, conn.auSeq++)
                    for (const res of conn.clients) res.write(framed)
                }
            })
            proc.stderr.on('data', (d: Buffer) => {
                conn.stderrTail = (conn.stderrTail + d.toString()).slice(-4000)
            })
            proc.on('exit', (code) => this.handleExit(id, conn, proc, spawnedAt, code))
            return
        }

        proc.stdout.on('data', (chunk: Buffer) => {
            if (!conn.sawMoof) {
                conn.initSegment = conn.initSegment ? Buffer.concat([conn.initSegment, chunk]) : chunk
                const idx = conn.initSegment.indexOf('moof', 0, 'ascii')
                if (idx > 4) {
                    conn.sawMoof = true
                    const boundary = idx - 4          // back over the box length field
                    const live = conn.initSegment.subarray(boundary)
                    conn.initSegment = conn.initSegment.subarray(0, boundary)
                    // Must also go to clients ALREADY connected — the <video>
                    // attaches before the first fragment exists, so without
                    // this it receives a headerless stream and reports
                    // MEDIA_ERR_SRC_NOT_SUPPORTED.
                    const opening = Buffer.concat([conn.initSegment, live])
                    for (const res of conn.clients) res.write(opening)
                }
                return
            }
            for (const res of conn.clients) res.write(chunk)
        })

        proc.stderr.on('data', (d: Buffer) => {
            conn.stderrTail = (conn.stderrTail + d.toString()).slice(-4000)
        })

        proc.on('exit', (code) => this.handleExit(id, conn, proc, spawnedAt, code))
    }

    private handleExit(id: string, conn: GstConn, proc: ChildProcessWithoutNullStreams, spawnedAt: number, code: number | null): void {
        const emit = conn.emit
        {
            if (conn.proc !== proc || conn.stopping) return
            const ranBriefly = Date.now() - spawnedAt < RESTART_WINDOW_MS
            conn.restarts = ranBriefly ? conn.restarts + 1 : 0

            // A hardware pipeline that dies immediately is the classic
            // "vaapi element exists but this GPU can't service it" case —
            // demote to software rather than retrying the same failure five
            // times and giving up on a machine that could have shown video.
            if (ranBriefly && conn.accel === 'hardware' && conn.restarts >= 2) {
                conn.accel = 'software'
                conn.restarts = 0
                emit({
                    bridge: this.kind, id, type: 'status',
                    meta: {
                        connected: true, accel: 'software', demoted: true,
                        error: 'hardware decode failed on this GPU — fell back to software',
                        log: conn.stderrTail.slice(-300),
                    },
                })
            } else if (conn.restarts > MAX_CONSECUTIVE_RESTARTS) {
                emit({
                    bridge: this.kind, id, type: 'status',
                    meta: {
                        connected: false, code,
                        error: describeFailure(conn.stderrTail, conn.cfg),
                        log: conn.stderrTail,
                    },
                })
                void this.stop(id)
                return
            }

            setTimeout(() => {
                if (!conn.stopping && this.conns.get(id) === conn) {
                    conn.sawMoof = false
                    conn.initSegment = null
                    conn.auTail = null
                    this.launch(id, conn)
                }
            }, RESTART_DELAY_MS)
        }
    }

    async stop(id: string): Promise<void> {
        const conn = this.conns.get(id)
        if (!conn) return
        conn.stopping = true
        killChild(conn.proc)
        for (const res of conn.clients) {
            try { res.end() } catch { /* already closed */ }
        }
        conn.clients.clear()
        try { conn.server?.close() } catch { /* already closed */ }
        this.conns.delete(id)
    }

    send(): void {
        // One-way: video in, preview out. Nothing to send upstream.
    }
}

function describeFailure(stderr: string, cfg: GstPreviewConfig): string {
    if (/Address already in use|Could not bind/i.test(stderr)) {
        return `udp:${cfg.udpPort ?? 5600} is already held by another program `
            + '(gst-decode.sh, QGroundControl, or a second HYRAK window). Only one '
            + 'process can receive a UDP port.'
    }
    if (/vaapi|VA-API/i.test(stderr) && /fail|error|no.*driver/i.test(stderr)) {
        return 'VAAPI hardware decode failed to initialise on this GPU — '
            + 'set the preview to software decode in Settings.'
    }
    if (/not-negotiated|Internal data stream error/i.test(stderr)) {
        return `Nothing decodable on udp:${cfg.udpPort ?? 5600} — is the ground station `
            + 'running (start-gs.sh) and delivering H.265 RTP to this machine?'
    }
    return `GStreamer preview failed. Last output: ${stderr.trim().split('\n').slice(-2).join(' ')}`
}
