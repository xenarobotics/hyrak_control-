import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import dgram from 'node:dgram'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import ffmpegStaticPath from 'ffmpeg-static'
import type { NativeBridge, EmitFn } from './types'
import { trackChild, killChild } from './processGuard'

// Relays a networked RTSP camera (a SIYI ground unit at
// rtsp://192.168.144.25:8554/video1, or any other) up to the backend
// WITHOUT re-encoding, and simultaneously serves a local preview to this
// machine's own operator.
//
// Why this exists alongside rtspBridge.ts rather than replacing it:
// rtspBridge DECODES to MJPEG so the frames can enter the normal
// getUserMedia/WebRTC path — that works on any network (TURN over TLS:443)
// but costs a decode + a JPEG encode on what is typically an Intel i5.
// This bridge instead does `-c copy`: not one pixel is re-encoded, so the
// laptop spends ~2% CPU and the server receives bytes bit-identical to what
// the camera produced. The tradeoff is that the uplink needs a reachable
// SRT/TCP port on the server, which rtspBridge does not. Both are kept —
// see docs/video-transport-modes.md and ADR-003.
//
// One ffmpeg, one RTSP pull, two outputs via the tee muxer:
//
//   SIYI ---RTSP/TCP---> ffmpeg -c copy --+--> mpegts over SRT  -> server
//                                         +--> fragmented MP4   -> loopback
//                                              HTTP -> <video> in the renderer
//
// The preview branch is free: it's the same copied packets, so putting a
// picture on the operator's screen costs one decode in Chromium (which it
// would need anyway to display anything) and no encode at all.

const FFMPEG_PATH = (ffmpegStaticPath || 'ffmpeg').replace('app.asar', 'app.asar.unpacked')

// SRT's `latency` is in MICROSECONDS (ffmpeg default 120000 = 120ms) — it
// is the window within which lost packets can still be retransmitted, so it
// is also a floor on glass-to-glass delay. 60ms keeps the retransmit
// benefit while staying inside the project's sub-150ms round-trip budget;
// raise it on a genuinely lossy link, lower it on a clean one.
const DEFAULT_SRT_LATENCY_MS = 60

// A tee slave that fails must not take the other one down with it: if the
// uplink drops, the operator should keep seeing video, and vice versa.
// ffmpeg's `onfail=ignore` does exactly that per-slave.
const RESTART_DELAY_MS = 2000
const RESTART_WINDOW_MS = 5000   // exits sooner than this count as "failing", not "finished"
const MAX_CONSECUTIVE_RESTARTS = 5

// MICROSECONDS. A fragmented-MP4 fragment is only written once it is complete,
// so this value is added to the preview's delay in full — it was 100000 (100ms)
// and that was a tenth of the entire glass-to-glass budget spent for nothing.
// 20ms is under one frame at 30fps, so the fragment boundary stops being a
// meaningful term at all. The cost is muxer overhead: more, smaller `moof`
// boxes, which on a loopback pipe is free.
const PREVIEW_FRAG_DURATION_US = 20000

// UDP socket receive buffer for the camera leg. ffmpeg's default is small
// enough that a burst can overflow the kernel buffer and be dropped before
// ffmpeg ever reads it — which looks exactly like a bad radio link. 416 KB is
// the value ffmpeg's own low-latency docs use.
const RTSP_UDP_BUFFER_BYTES = 425984

type RelayTransport = 'srt' | 'tcp' | 'udp'

/** Writes (once per port) the SDP that tells ffmpeg what the air unit's bare
 *  RTP stream is, and returns its path.
 *
 *  RTP on a plain UDP port is self-describing only up to the payload TYPE
 *  number — nothing in the datagrams says "H.265". The SDP supplies that. This
 *  is deliberately byte-for-byte the same description the server uses in
 *  backend/app/webrtc/udp_video_source.py, and the same caps string
 *  gst-decode.sh passes to udpsrc; all three must agree or the payload is
 *  parsed as the wrong codec. Payload type 96 was confirmed on the live stream.
 *
 *  Cached by port because the port is user-configurable — a single cached path
 *  would keep serving a stale port's SDP after a change. */
const _sdpPaths = new Map<number, string>()
function writeAirUnitSdp(port: number): string {
    const cached = _sdpPaths.get(port)
    if (cached && fs.existsSync(cached)) return cached
    const file = path.join(os.tmpdir(), `hyrak-air-unit-${port}.sdp`)
    fs.writeFileSync(file, [
        'v=0',
        'o=- 0 0 IN IP4 127.0.0.1',
        's=hyrak-air-unit',
        'c=IN IP4 127.0.0.1',
        't=0 0',
        `m=video ${port} RTP/AVP 96`,
        'a=rtpmap:96 H265/90000',
        '',
    ].join('\n'))
    _sdpPaths.set(port, file)
    return file
}

interface RtspRelayConfig {
    // Where the video comes IN. Everything downstream — `-c copy`, the tee,
    // the SRT uplink, the local preview — is identical for both, which is why
    // this is a flag here rather than a second bridge: only the input leg
    // differs, and duplicating the rest would mean two copies of the tee and
    // reconnect logic to keep in step.
    //
    //   'rtsp'  pull a camera with RTSP (SIYI). ffmpeg speaks the handshake.
    //   'udp'   read the air unit's RTP/H.265 straight off a local UDP port.
    //           wfb_rx already delivers it there (see wfb-gs's start-gs.sh),
    //           so there is nothing to negotiate — but RTP on a bare UDP port
    //           carries no format description, so an SDP has to be written to
    //           tell ffmpeg what the payload is. Same SDP the server uses in
    //           backend/app/webrtc/udp_video_source.py.
    source?: 'rtsp' | 'udp'
    udpPort?: number               // source==='udp': defaults to 5600
    // source==='udp': treat udpPort as a PREFERENCE and probe-bind for a free
    // one near it (up to +20), returning the choice in meta.udpPort. Only
    // sane when the caller controls BOTH ends (the preview fan-out case,
    // where the same frontend then points the sender's copy at the returned
    // port). Never set it for a real source like the air unit's 5600 — that
    // port is where the packets already are.
    udpPortAutoPick?: boolean
    url: string                    // rtsp://192.168.144.25:8554/video1 (source==='rtsp')
    host?: string                  // backend host for the uplink
    port?: number                  // backend listener port (allocate_video_relay)
    transport?: RelayTransport
    latencyMs?: number
    streamId?: string
    preview?: boolean
    previewPort?: number           // 0 / omitted = OS-assigned
    // Preview WITHOUT an uplink. This is the "make the RTSP camera look like
    // a webcam" mode: ffmpeg still does `-c copy` (no transcode), but the
    // only output is the loopback fMP4 the renderer turns into a MediaStream
    // via <video>.captureStream(), which then rides the ORDINARY WebRTC
    // path. Slower than the direct SRT uplink — WebRTC re-encodes — but it
    // traverses NAT and UDP-blocking networks, needing no reachable address
    // on the server at all. See ADR-003 on why both must exist.
    uplink?: boolean
    // Re-encode the preview branch to H.264. Needed when the camera is H.265:
    // Chromium ships NO software HEVC decoder, so an H.265 preview fails with
    // MEDIA_ERR_SRC_NOT_SUPPORTED on any machine lacking hardware HEVC decode.
    // H.264 is decodable everywhere. Encoded with libx264
    // -preset ultrafast -tune zerolatency.
    // The UPLINK branch is never transcoded — it stays bit-exact.
    transcodePreview?: 'h264'
    // Max HEIGHT of the transcoded preview; source is scaled down to fit
    // (never up). Default 720, 0 = native resolution.
    //
    // This is a CPU ceiling, not a quality knob. The field failure: on an
    // i5-8350U the 1080p20 libx264 encode cannot sustain realtime, ffmpeg
    // falls behind, stops draining its UDP socket, the kernel buffer
    // overflows, and every dropped packet is up to 3s of white noise (H.265
    // GOP 60, no intra-refresh) — appearing "after a few seconds", once the
    // buffer first fills. 720p halves the encode cost (0.79 → 0.56 core
    // measured on the reference machine; proportionally on weaker ones).
    // Display-only: the AI uplink still carries the original bytes, and the
    // overlay canvas scales by CSS so box geometry is unaffected.
    previewMaxHeight?: number
    // How to open the CAMERA leg — independent of `transport`, which is the
    // uplink to the server. 'tcp' (default) loses nothing but converts loss
    // into accumulating delay via head-of-line blocking; 'udp' converts loss
    // into artifacts and cannot accumulate. On a marginal hotspot link that
    // difference can be hundreds of milliseconds, so it is a dial, not a
    // constant. Omitted = tcp, i.e. the behaviour that shipped.
    rtspTransport?: 'tcp' | 'udp'
    // fMP4 fragment length in microseconds. Omitted = 20000. Overridable so
    // the pre-0.1.14 100000 stays reachable without a rebuild.
    fragDurationUs?: number
}

interface RelayConn {
    proc: ChildProcessWithoutNullStreams | null
    server: http.Server | null
    clients: Set<http.ServerResponse>
    initSegment: Buffer | null     // fMP4 ftyp+moov, replayed to late-joining viewers
    sawMoof: boolean
    restarts: number
    stopping: boolean
    cfg: RtspRelayConfig
    emit: EmitFn
}

/** Finds a bindable loopback UDP port at or above `preferred`. Exclusive
 *  bind (no SO_REUSEADDR — a second binder silently steals every packet, see
 *  webrtcSenderBridge.bindExclusive), closed again before returning; the gap
 *  between close and ffmpeg's own bind is a real but tiny race, and losing it
 *  just means the ffmpeg restart path picks it up. */
async function findFreeUdpPort(preferred: number, tries = 20): Promise<number | null> {
    for (let port = preferred; port < preferred + tries; port++) {
        const ok = await new Promise<boolean>((resolve) => {
            const probe = dgram.createSocket('udp4')
            probe.once('error', () => resolve(false))
            probe.bind({ port, address: '127.0.0.1', exclusive: true }, () => {
                probe.close(() => resolve(true))
            })
        })
        if (ok) return port
    }
    return null
}

function uplinkUrl(cfg: RtspRelayConfig): string {
    const transport: RelayTransport = cfg.transport ?? 'srt'
    const { host, port } = cfg
    if (transport === 'srt') {
        const latencyUs = Math.round((cfg.latencyMs ?? DEFAULT_SRT_LATENCY_MS) * 1000)
        const params = [`mode=caller`, `latency=${latencyUs}`]
        if (cfg.streamId) {
            params.push(`streamid=${encodeURIComponent(cfg.streamId)}`)
            // The same per-session secret, used as the SRT crypto passphrase.
            //
            // `streamid` alone authenticated NOTHING: the server's listener
            // never inspected it, so any caller reaching the port was accepted.
            // That matters because this listener is the one component that must
            // sit on a raw public UDP port — it cannot go through the tunnel.
            // With a passphrase the handshake itself fails for anyone without
            // the secret, and the media is AES-encrypted in transit.
            //
            // Must match backend/app/webrtc/relay_video_source.py's _listen_url:
            // pbkeylen 16 and enforced_encryption there, passphrase here.
            params.push(`passphrase=${encodeURIComponent(cfg.streamId)}`)
            params.push('pbkeylen=16')
        }
        return `srt://${host}:${port}?${params.join('&')}`
    }
    if (transport === 'tcp') return `tcp://${host}:${port}`
    // Plain UDP has no retransmission at all — only sensible on a LAN.
    return `udp://${host}:${port}?pkt_size=1316`
}

export class RtspRelayBridge implements NativeBridge {
    readonly kind = 'rtsp-relay'
    private conns = new Map<string, RelayConn>()

    async start(id: string, config: Record<string, unknown>, emit: EmitFn): Promise<{ ok: boolean; error?: string; meta?: Record<string, unknown> }> {
        const cfg = config as unknown as RtspRelayConfig
        // Only the RTSP source has a url to require. The air unit's input is a
        // local UDP port described by a generated SDP, so it legitimately
        // passes url: '' — and this check rejected it, which is what "Relay
        // start failed: RTSP url required" was.
        if (cfg.source !== 'udp' && !cfg.url) {
            return { ok: false, error: 'RTSP url required' }
        }
        if (cfg.source === 'udp' && !(cfg.udpPort ?? 5600)) {
            return { ok: false, error: 'air unit UDP port required' }
        }
        const wantUplink = cfg.uplink !== false
        if (wantUplink && (!cfg.host || !cfg.port)) {
            return { ok: false, error: 'relay host and port required' }
        }
        if (!wantUplink && cfg.preview === false) {
            return { ok: false, error: 'nothing to do — uplink and preview both disabled' }
        }
        if (cfg.source === 'udp' && cfg.udpPortAutoPick) {
            const free = await findFreeUdpPort(cfg.udpPort ?? 5600)
            if (free === null) {
                return { ok: false, error: `no free UDP port near ${cfg.udpPort ?? 5600} for the preview source` }
            }
            cfg.udpPort = free
        }
        await this.stop(id)

        const conn: RelayConn = {
            proc: null, server: null, clients: new Set(),
            initSegment: null, sawMoof: false,
            restarts: 0, stopping: false, cfg, emit,
        }

        if (cfg.preview !== false) {
            const server = http.createServer((req, res) => {
                if (req.url !== '/preview') { res.writeHead(404); res.end(); return }
                res.writeHead(200, {
                    'Content-Type': 'video/mp4',
                    'Cache-Control': 'no-store',
                    // The page is served from https://<site>, so a request to
                    // this loopback server is cross-origin. Without this the
                    // fetch is rejected outright whenever the consumer sets
                    // crossOrigin — which it must, to keep a canvas untainted
                    // and therefore captureStream-able.
                    'Access-Control-Allow-Origin': '*',
                    Connection: 'close',
                })
                // A viewer that connects mid-stream has missed ftyp+moov and
                // would see nothing but undecodable fragments without them.
                if (conn.initSegment) res.write(conn.initSegment)
                // See gstreamerBridge: Nagle coalesces small writes and holds
                // them for an ACK, so fragments leave in clumps and the
                // viewer's drift oscillates instead of settling. Same defect
                // was present here; fixed in both.
                res.socket?.setNoDelay(true)
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
        }

        this.conns.set(id, conn)
        this.launch(id, conn)

        const addr = conn.server?.address()
        const previewPort = typeof addr === 'object' && addr ? addr.port : 0
        const previewUrl = previewPort ? `http://127.0.0.1:${previewPort}/preview` : null
        emit({
            bridge: this.kind, id, type: 'status',
            meta: {
                connected: true,
                uplink: cfg.uplink === false
                    ? null
                    // Both secrets redacted. The passphrase is the SAME value as
                    // streamid and is now the actual admission credential, so
                    // leaking it into a log or an emitted status would hand over
                    // the ability to push into this session.
                    : uplinkUrl(cfg)
                        .replace(/streamid=[^&]*/, 'streamid=***')
                        .replace(/passphrase=[^&]*/, 'passphrase=***'),
                transport: cfg.uplink === false ? 'none' : (cfg.transport ?? 'srt'),
                // Echoed back so a latency measurement can never be attributed
                // to the wrong configuration.
                rtspTransport: cfg.rtspTransport ?? 'tcp',
                fragDurationUs: cfg.fragDurationUs ?? PREVIEW_FRAG_DURATION_US,
                previewUrl,
                // The port actually chosen (≠ the preference when auto-pick
                // stepped past a busy one) — the caller must aim its fan-out
                // copy here, not at what it asked for.
                ...(cfg.source === 'udp' ? { udpPort: cfg.udpPort ?? 5600 } : {}),
            },
        })
        // Returned as well as emitted: the caller awaits this promise, so it
        // cannot miss the value the way it can miss the event above.
        return {
            ok: true,
            meta: {
                previewUrl,
                ...(cfg.source === 'udp' ? { udpPort: cfg.udpPort ?? 5600 } : {}),
            },
        }
    }

    private launch(id: string, conn: RelayConn): void {
        const { cfg, emit } = conn
        const wantPreview = !!conn.server

        // -c copy on BOTH branches: no decode, no encode, no generation loss.
        // The preview is fragmented MP4 so a plain <video> element can play it
        // progressively over loopback HTTP — frag_keyframe alone would delay
        // the first picture by a whole GOP, so cap fragment duration too.
        const fragUs = cfg.fragDurationUs ?? PREVIEW_FRAG_DURATION_US
        const outputs: string[] = []
        if (cfg.uplink !== false) outputs.push(`[f=mpegts:onfail=ignore]${uplinkUrl(cfg)}`)
        if (wantPreview) {
            outputs.push(
                '[f=mp4:onfail=ignore:'
                + 'movflags=+frag_keyframe+empty_moov+default_base_moof:'
                + `frag_duration=${fragUs}]pipe:1`,
            )
        }

        // Transcoding and tee don't combine usefully: tee fans out ONE encoded
        // stream, so a transcoded preview is its own single-output pipeline.
        // That's fine — transcoding is only used in preview-only mode, where
        // there is no uplink to share with.
        const transcoding = cfg.transcodePreview === 'h264'

        // The camera leg. TCP was the original choice on the theory that this
        // is a short local link where reliability is cheap — but "short local
        // link" is wrong for a SIYI hotspot at range, and over TCP a marginal
        // link spends its loss budget on delay instead of artifacts.
        const fromUdp = cfg.source === 'udp'
        const inputUrl = fromUdp ? writeAirUnitSdp(cfg.udpPort ?? 5600) : cfg.url
        const rtspUdp = cfg.rtspTransport === 'udp'
        const inputArgs = fromUdp ? [
            '-hide_banner', '-loglevel', 'info',
            // The SDP references a file path, so `file` must be whitelisted
            // alongside the transport protocols or ffmpeg refuses to open it.
            '-protocol_whitelist', 'file,udp,rtp',
            // Same trade as the RTSP/UDP branch below: a reorder window is
            // pure latency on a link that wfb-ng has already FEC-corrected.
            '-reorder_queue_size', '0',
            '-max_delay', '0',
            '-buffer_size', String(RTSP_UDP_BUFFER_BYTES),
            '-fflags', 'nobuffer', '-flags', 'low_delay',
        ] : [
            // 'info', not 'warning': ffmpeg prints the input stream line
            // ("Stream #0:0: Video: hevc ...") at info level, and knowing the
            // camera's real codec is the difference between diagnosing a
            // playback failure and guessing at it. Only the tail is kept.
            '-hide_banner', '-loglevel', 'info',
            '-rtsp_transport', rtspUdp ? 'udp' : 'tcp',
            ...(rtspUdp
                ? [
                    // Only meaningful over UDP — TCP delivers in order, so
                    // there is nothing to reorder and no datagram to drop.
                    // reorder_queue_size defaults to -1 (auto), which keeps a
                    // packet buffer whose whole purpose is to WAIT. Zero
                    // trades that wait for occasional artifacts, which is the
                    // right trade for a pilot view.
                    '-reorder_queue_size', '0',
                    '-max_delay', '0',
                    '-buffer_size', String(RTSP_UDP_BUFFER_BYTES),
                ]
                : []),
            '-fflags', 'nobuffer', '-flags', 'low_delay',
        ]
        const previewMaxH = cfg.previewMaxHeight ?? 720
        const args = transcoding
            ? [
                ...inputArgs,
                '-i', inputUrl,
                '-map', '0:v:0',
                // Downscale-only (`min(ih,N)`): a 720p camera stays native.
                // fast_bilinear: the cheapest scaler — this filter exists to
                // SAVE CPU, so spending it on scaling quality would be silly.
                ...(previewMaxH > 0
                    ? ['-vf', `scale=-2:'min(ih,${previewMaxH})':flags=fast_bilinear`]
                    : []),
                // Software encode deliberately. VAAPI would be cheaper, but
                // the BUNDLED ffmpeg does not accept -vaapi_device at all
                // ("Unrecognized option") — airUnitVideoBridge only gets away
                // with it by shelling out to the SYSTEM ffmpeg, which clients
                // may not have. ultrafast/zerolatency keeps this affordable;
                // revisit with -init_hw_device once the bundled build's
                // hardware syntax is confirmed on real client machines.
                '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '26',
                '-g', '30',
                '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
                '-frag_duration', String(fragUs),
                // Without this, ffmpeg holds finished fragments in its 32KB
                // AVIO buffer until it fills — so a low frag_duration alone
                // buys nothing, because the fragments still leave in batches.
                // The two changes only work together.
                '-flush_packets', '1',
                '-f', 'mp4', 'pipe:1',
            ]
            : [
                ...inputArgs,
                '-i', inputUrl,
                '-map', '0:v:0',
                '-c', 'copy',
                '-flush_packets', '1',
                '-f', 'tee', outputs.join('|'),
            ]

        const proc = spawn(FFMPEG_PATH, args)
        // A spawn failure (ENOENT and kin) emits 'error' on the child, and an
        // unhandled 'error' event THROWS — in Electron's main process that is
        // an uncaught exception, found the hard way when a repro harness fed
        // a bad ffmpeg path. Report it like any other bridge failure instead.
        proc.on('error', (err) => {
            if (conn.proc !== proc || conn.stopping) return
            emit({
                bridge: this.kind, id, type: 'status',
                meta: { connected: false, error: `ffmpeg failed to start — ${err.message}` },
            })
            void this.stop(id)
        })
        // Tracked so app quit kills it. This bridge is the one that leaked
        // nine orphaned transcodes and pinned a 24-core machine at 98%.
        trackChild(proc)
        conn.proc = proc
        const spawnedAt = Date.now()

        if (wantPreview) {
            proc.stdout.on('data', (chunk: Buffer) => {
                // Everything before the first `moof` box is the init segment
                // (ftyp + moov). Cache it once, then treat the rest as live.
                if (!conn.sawMoof) {
                    conn.initSegment = conn.initSegment ? Buffer.concat([conn.initSegment, chunk]) : chunk
                    const idx = conn.initSegment.indexOf('moof', 0, 'ascii')
                    if (idx > 4) {
                        conn.sawMoof = true
                        const boundary = idx - 4          // back up over the box's length field
                        const live = conn.initSegment.subarray(boundary)
                        conn.initSegment = conn.initSegment.subarray(0, boundary)
                        // The init segment must go to clients ALREADY connected,
                        // not just to late joiners.
                        //
                        // This one missing write is why the fMP4 preview never
                        // worked. The <video> element connects while ffmpeg is
                        // still doing its ~1s RTSP handshake — so it is ALWAYS
                        // attached before the first moof arrives, and used to
                        // receive the stream starting at `live`, with no ftyp
                        // and no moov. Chromium reported that as
                        // MEDIA_ERR_SRC_NOT_SUPPORTED (code 4), which reads
                        // exactly like "this machine can't decode H.265" — so
                        // the ladder fell through to MJPEG every single time
                        // and the real cause was masked for four releases.
                        // ffprobe on the served stream says it plainly:
                        // "trun track id unknown, no tfhd was found".
                        const opening = Buffer.concat([conn.initSegment, live])
                        for (const res of conn.clients) res.write(opening)
                    }
                    return
                }
                for (const res of conn.clients) res.write(chunk)
            })
        }

        let stderrTail = ''
        let reportedCodec = false
        proc.stderr.on('data', (d: Buffer) => {
            stderrTail = (stderrTail + d.toString()).slice(-4000)
            if (!reportedCodec) {
                // e.g. "Stream #0:0: Video: hevc (Main), yuv420p, 1920x1080, 30 fps"
                const m = stderrTail.match(/Stream #\d+:\d+.*?: Video: (\w+)[^\n]*/)
                if (m) {
                    reportedCodec = true
                    emit({
                        bridge: this.kind, id, type: 'status',
                        meta: { codec: m[1], streamInfo: m[0].trim() },
                    })
                }
            }
        })

        proc.on('exit', (code) => {
            if (conn.proc !== proc) return          // superseded by a newer launch
            if (conn.stopping) return
            const ranBriefly = Date.now() - spawnedAt < RESTART_WINDOW_MS
            conn.restarts = ranBriefly ? conn.restarts + 1 : 0

            if (conn.restarts > MAX_CONSECUTIVE_RESTARTS) {
                emit({
                    bridge: this.kind, id, type: 'status',
                    meta: {
                        connected: false, code,
                        error: describeFailure(stderrTail, cfg),
                        log: stderrTail,
                    },
                })
                void this.stop(id)
                return
            }
            // A live relay is expected to run indefinitely; any exit is a
            // fault (camera power-cycled, WiFi blipped, server restarted).
            // Reconnect rather than making the operator re-arm it by hand.
            emit({
                bridge: this.kind, id, type: 'status',
                meta: { connected: false, reconnecting: true, code, log: stderrTail },
            })
            setTimeout(() => {
                if (!conn.stopping && this.conns.get(id) === conn) {
                    conn.sawMoof = false
                    conn.initSegment = null
                    this.launch(id, conn)
                }
            }, RESTART_DELAY_MS)
        })
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
        // One-way: video in, relayed out. There is no uplink to the camera.
    }
}

function describeFailure(stderr: string, cfg: RtspRelayConfig): string {
    if (/Connection refused|Connection timed out|No route to host/i.test(stderr)) {
        // The air unit has no camera to reach — its input is a local UDP port,
        // so "check the hotspot" would send the operator after the wrong thing.
        return cfg.source === 'udp'
            ? `Nothing readable on udp:${cfg.udpPort ?? 5600} — is the ground station `
              + 'running (start-gs.sh) and delivering RTP to this machine?'
            : `Can't reach the camera at ${cfg.url} — is the laptop on the SIYI hotspot?`
    }
    if (/401|Unauthorized/i.test(stderr)) return 'Camera rejected the credentials in the RTSP URL.'
    if (/Connection setup failure|srt|SRT/i.test(stderr) && /fail|refus|timeout/i.test(stderr)) {
        return `Can't reach the relay server at ${cfg.host}:${cfg.port} over ${cfg.transport ?? 'srt'}`
            + ' — some networks block UDP entirely; try the TCP transport, or the WebRTC video mode.'
    }
    return `Relay failed repeatedly. Last ffmpeg output: ${stderr.trim().split('\n').slice(-2).join(' ')}`
}
