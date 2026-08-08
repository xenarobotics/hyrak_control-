import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import http from 'node:http'
import ffmpegStaticPath from 'ffmpeg-static'
import type { NativeBridge, EmitFn } from './types'
import { trackChild, killChild } from './processGuard'

// ffmpeg-static resolves a real binary for the CURRENT platform at install
// time (Windows/Mac/Linux each get their own on `npm install`, including
// in CI) — no user-installed ffmpeg required. electron-builder's asar
// packing can't execute a binary from inside the archive, so
// package.json's build.asarUnpack keeps this one file outside it; the path
// it hands back still says ".asar" even though the real file lives next to
// it in "<name>.asar.unpacked", so that swap has to happen here.
const FFMPEG_PATH = (ffmpegStaticPath || 'ffmpeg').replace('app.asar', 'app.asar.unpacked')

// RTSP is the protocol no browser has ever spoken (the exact wall that
// blocked the SIYI transmission-module camera earlier in this project) —
// this is what a desktop app gets that a browser tab structurally cannot.
// ffmpeg does the actual RTSP decode (the one thing genuinely impossible
// without a native process); this bridge re-serves its output as a plain
// multipart MJPEG HTTP stream on loopback. That format is deliberately
// boring: a <img src="http://127.0.0.1:PORT/stream"> or a canvas draw loop
// consumes it with zero special support, and canvas.captureStream() turns
// it into a real MediaStream — which plugs straight into the EXISTING
// startStream(cameraStream) WebRTC path used for every other camera
// source, no backend changes needed. See desktop/README.md for the
// renderer-side glue.

interface RtspStartConfig {
    url: string
    httpPort?: number
    fps?: number
}

interface RtspConn {
    proc: ChildProcessWithoutNullStreams
    server: http.Server
    clients: Set<http.ServerResponse>
}

const BOUNDARY = 'hyrakrtspframe'
const SOI = Buffer.from([0xff, 0xd8]) // JPEG start-of-image marker
const EOI = Buffer.from([0xff, 0xd9]) // JPEG end-of-image marker

export class RtspBridge implements NativeBridge {
    readonly kind = 'rtsp'
    private conns = new Map<string, RtspConn>()

    async start(id: string, config: Record<string, unknown>, emit: EmitFn): Promise<{ ok: boolean; error?: string; meta?: Record<string, unknown> }> {
        const { url, httpPort, fps } = config as unknown as RtspStartConfig
        if (!url) return { ok: false, error: 'RTSP url required' }
        await this.stop(id)

        const proc = spawn(FFMPEG_PATH, [
            '-rtsp_transport', 'tcp',
            '-i', url,
            '-f', 'mjpeg',
            '-q:v', '5',
            '-r', String(fps ?? 15),
            'pipe:1',
        ])
        trackChild(proc)

        const conn: RtspConn = { proc, server: null as unknown as http.Server, clients: new Set() }
        let buf = Buffer.alloc(0)

        proc.stdout.on('data', (chunk: Buffer) => {
            buf = Buffer.concat([buf, chunk])
            for (;;) {
                const start = buf.indexOf(SOI)
                if (start < 0) break
                const end = buf.indexOf(EOI, start + 2)
                if (end < 0) break
                const frame = buf.subarray(start, end + 2)
                buf = buf.subarray(end + 2)
                for (const res of conn.clients) {
                    res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`)
                    res.write(frame)
                    res.write('\r\n')
                }
                emit({ bridge: 'rtsp', id, type: 'frame', meta: { size: frame.length } })
            }
        })

        let stderrTail = ''
        proc.stderr.on('data', (d: Buffer) => {
            stderrTail = (stderrTail + d.toString()).slice(-2000) // keep only the tail, for the exit-failure message
        })
        proc.on('exit', (code) => {
            emit({ bridge: 'rtsp', id, type: 'status', meta: { connected: false, code, log: stderrTail } })
            void this.stop(id)
        })

        const server = http.createServer((req, res) => {
            if (req.url !== '/stream') { res.writeHead(404); res.end(); return }
            res.writeHead(200, {
                'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
                'Cache-Control': 'no-cache',
                // Required: the consuming page is https://<site>, so this is a
                // cross-origin load, and a canvas drawing an <img> without CORS
                // is tainted and cannot be captureStream()'d.
                'Access-Control-Allow-Origin': '*',
                Connection: 'close',
            })
            conn.clients.add(res)
            req.on('close', () => conn.clients.delete(res))
        })
        conn.server = server

        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject)
                server.listen(httpPort ?? 0, '127.0.0.1', () => resolve())
            })
        } catch (err) {
            killChild(proc)
            return { ok: false, error: `couldn't start local MJPEG server — ${(err as Error).message}` }
        }

        const addr = server.address()
        const boundPort = typeof addr === 'object' && addr ? addr.port : 0
        this.conns.set(id, conn)
        const streamUrl = `http://127.0.0.1:${boundPort}/stream`
        emit({ bridge: 'rtsp', id, type: 'status', meta: { connected: true, streamUrl } })
        // Also returned, not only emitted — a caller that subscribes after
        // awaiting start() would miss the event above. Same hazard the
        // rtsp-relay bridge hit; see types.ts.
        return { ok: true, meta: { streamUrl } }
    }

    async stop(id: string): Promise<void> {
        const conn = this.conns.get(id)
        if (!conn) return
        // SIGTERM alone is what leaked: orphans were observed having ignored
        // it entirely. killChild escalates to SIGKILL — see processGuard.ts.
        killChild(conn.proc)
        for (const res of conn.clients) {
            try { res.end() } catch { /* already closed */ }
        }
        try { conn.server.close() } catch { /* already closed */ }
        this.conns.delete(id)
    }

    send(): void {
        // One-way: RTSP here is video-in only, there's no uplink to send.
    }
}
