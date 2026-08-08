import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ffmpegStaticPath from 'ffmpeg-static'
import type { NativeBridge, EmitFn } from './types'
import { trackChild } from './processGuard'

// Absorbs air_unit_relay/video_webcam.sh's job into the app itself — same
// proven technique, one fewer moving part for the client (no separate
// script to run, no system GStreamer dependency). Reuses the EXACT SDP +
// low-latency ffmpeg options already proven server-side in
// backend/app/webrtc/udp_video_source.py (tuned there to fix a real
// ~1s-of-lag bug from ffmpeg's file-playback-tuned buffering defaults) —
// same input side, this bridge just writes the decoded output to a local
// v4l2loopback device instead of handing frames to aiortc.
//
// Hardware decode: the bundled ffmpeg-static binary does NOT have VAAPI
// compiled in (checked — only vdpau, which Intel iGPUs don't use). VAAPI
// also can't be "bundled" in any meaningful sense regardless of which
// ffmpeg binary is used — it always depends on the SYSTEM's own GPU driver
// stack (libva + i915/iHD) being present, the exact thing that was already
// required for video_webcam.sh's hardware path to work. So: prefer a
// SYSTEM ffmpeg with VAAPI if one exists (most distro ffmpeg packages
// build it in, unlike portable/static builds), fall back to the bundled
// binary — always present, guaranteed to work, but software-decode-only —
// if not. Never a hard failure; the fallback is just slower on a weak CPU,
// exactly the class of tradeoff already understood from earlier tuning.
const BUNDLED_FFMPEG = (ffmpegStaticPath || 'ffmpeg').replace('app.asar', 'app.asar.unpacked')

// A hardware attempt that dies faster than this never produced video — it
// failed during device/decoder setup, so it's safe to treat as "hw is not
// actually usable here" and retry in software. A LIVE feed that has been
// running longer than this and then exits is a real stream ending (air unit
// powered down, RF link lost), which must surface as an error, not a silent
// software restart.
const HW_SETUP_WINDOW_MS = 4000

// `ffmpeg -hwaccels` reports COMPILE-time support only — it lists vaapi on
// every distro build whether or not this machine has a GPU that can do
// anything with it. That distinction cost a real bug: on a laptop whose
// first DRM render node is a firmware-disabled dGPU, ffmpeg's VAAPI
// auto-init defaults to /dev/dri/renderD128 (the dead one) and dies with
// "Failed to initialise VAAPI connection" the instant it tries to set up the
// hevc decoder — while the working iGPU sat on renderD129, untried. So:
// probe each render node for real, and pass the winner explicitly with
// -vaapi_device rather than trusting ffmpeg's choice of default.
let cachedVaapiNode: { node: string | null } | null = null

function vaapiRenderNode(): string | null {
    if (cachedVaapiNode) return cachedVaapiNode.node
    cachedVaapiNode = { node: null }

    try {
        const out = execFileSync('ffmpeg', ['-hide_banner', '-hwaccels'], { encoding: 'utf8', timeout: 3000 })
        if (!/vaapi/i.test(out)) return null
    } catch {
        return null // no system ffmpeg on PATH, or it errored — bundled/software it is
    }

    let nodes: string[]
    try {
        nodes = fs.readdirSync('/dev/dri')
            .filter((n) => n.startsWith('renderD'))
            .sort()
            .map((n) => path.join('/dev/dri', n))
    } catch {
        return null // no /dev/dri at all (no GPU, or a container without it passed through)
    }

    for (const node of nodes) {
        try {
            // Cheapest possible real VAAPI handshake: open the device, init a
            // hw context, exit. Needs no input stream and no display.
            execFileSync('ffmpeg', [
                '-hide_banner', '-loglevel', 'error',
                '-init_hw_device', `vaapi=va:${node}`,
                '-f', 'lavfi', '-i', 'nullsrc', '-frames:v', '1', '-f', 'null', '-',
            ], { timeout: 5000, stdio: 'ignore' })
            cachedVaapiNode.node = node
            return node
        } catch {
            // Dead or driverless node — keep looking. This is the normal case
            // for a disabled/absent dGPU sitting ahead of the real one.
        }
    }
    return null
}

const SDP_TEMPLATE = (port: number) => `v=0
o=- 0 0 IN IP4 127.0.0.1
s=hyrak-air-unit
c=IN IP4 127.0.0.1
t=0 0
m=video ${port} RTP/AVP 96
a=rtpmap:96 H265/90000
`

interface AirUnitVideoConfig {
    port?: number          // wfb_rx's video UDP port — see start-gs.sh (default 5600)
    device?: string        // v4l2loopback device — see setup.sh (default /dev/video10)
    mode?: 'auto' | 'hw' | 'sw'
}

interface Conn {
    proc: ChildProcessWithoutNullStreams
    sdpPath: string
}

export class AirUnitVideoBridge implements NativeBridge {
    readonly kind = 'air-unit-video'
    private conns = new Map<string, Conn>()

    async start(id: string, config: Record<string, unknown>, emit: EmitFn): Promise<{ ok: boolean; error?: string }> {
        const { port = 5600, device = '/dev/video10', mode = 'auto' } = config as AirUnitVideoConfig
        await this.stop(id)

        if (!fs.existsSync(device)) {
            return {
                ok: false,
                error: `${device} doesn't exist. One-time setup needed first: ` +
                    `sudo modprobe v4l2loopback video_nr=10 card_label="HyrakAirUnit" exclusive_caps=1 ` +
                    `(see air_unit_relay/setup.sh for the full one-time setup this app assumes is already done).`,
            }
        }

        const sdpPath = path.join(os.tmpdir(), `hyrak-air-unit-${port}.sdp`)
        fs.writeFileSync(sdpPath, SDP_TEMPLATE(port))

        let vaapiNode: string | null = null
        if (mode === 'hw' || mode === 'auto') {
            vaapiNode = vaapiRenderNode()
            if (!vaapiNode && mode === 'hw') {
                return {
                    ok: false,
                    error: 'No usable VAAPI device — either no system ffmpeg with VAAPI on PATH, ' +
                        'or every /dev/dri/renderD* node failed to initialise. Try mode "sw".',
                }
            }
        }

        // Live RTP options mirror udp_video_source.py exactly — ffmpeg's
        // defaults are tuned for smooth file/VOD playback (buffer +
        // reorder for robustness), which on a LIVE feed just adds fixed,
        // permanent glass-to-glass delay instead of helping.
        const liveInputArgs = [
            '-protocol_whitelist', 'file,udp,rtp',
            '-fflags', 'nobuffer',
            '-flags', 'low_delay',
            '-max_delay', '100000',
            '-reorder_queue_size', '0',
        ]

        // Recursive so an `auto` hardware attempt that fails at decoder-setup
        // time can hand off to software in place, without the operator seeing
        // a failed Start they have to retry by hand.
        const launch = (hwNode: string | null): void => {
            const args = hwNode
                ? [
                    ...liveInputArgs,
                    '-vaapi_device', hwNode,
                    '-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi',
                    '-i', sdpPath,
                    '-vf', 'hwdownload,format=nv12',
                    '-pix_fmt', 'yuyv422',
                    '-f', 'v4l2', device,
                ]
                : [
                    ...liveInputArgs,
                    '-i', sdpPath,
                    '-pix_fmt', 'yuyv422',
                    '-f', 'v4l2', device,
                ]

            const proc = spawn(hwNode ? 'ffmpeg' : BUNDLED_FFMPEG, args)
            // This bridge's own stop() already escalates to SIGKILL and waits
            // for the port to be released, so it keeps that logic — tracking
            // is only so app QUIT reaches it too, which nothing did before.
            trackChild(proc)
            const spawnedAt = Date.now()
            let stderrTail = ''
            proc.stderr.on('data', (d: Buffer) => {
                stderrTail = (stderrTail + d.toString()).slice(-2000)
            })
            proc.on('exit', (code) => {
                // Superseded — a deliberate stop() (which drops the conn entry
                // before killing, and whose UI state the caller sets itself) or
                // a fallback that already replaced this process.
                if (this.conns.get(id)?.proc !== proc) return

                // Probing the render node proves VAAPI initialises; it does NOT
                // prove the driver exposes an hevc decode profile, or that it
                // won't fault on this particular stream. Both show up as an
                // immediate exit, so retry once in software rather than
                // reporting a dead Start.
                if (hwNode && mode === 'auto' && Date.now() - spawnedAt < HW_SETUP_WINDOW_MS) {
                    launch(null)
                    return
                }

                // A bind failure on THIS specific port is almost always a stale
                // ffmpeg from a previous Start still holding it (crash, force-quit,
                // or a Stop immediately followed by Start) — name it plainly
                // instead of leaving the operator to parse a raw ffmpeg banner.
                const addrInUse = /address already in use/i.test(stderrTail)
                const hwSetupFailed = /failed to initialise vaapi|hardware device setup failed|no device available for decoder/i.test(stderrTail)
                let error: string | undefined
                if (addrInUse) {
                    error = `Port ${port} is already in use by another process — fully quit and reopen the app, then try Start again.`
                } else if (hwSetupFailed) {
                    error = `Hardware decode failed to start on ${hwNode ?? 'this GPU'} — set video decode mode to "sw" to force software decode.`
                }
                emit({
                    bridge: 'air-unit-video', id, type: 'status',
                    meta: { connected: false, code, log: stderrTail, usingHw: !!hwNode, error },
                })
                this.conns.delete(id)
            })

            this.conns.set(id, { proc, sdpPath })
            emit({
                bridge: 'air-unit-video', id, type: 'status',
                meta: {
                    connected: true, device, port, usingHw: !!hwNode,
                    note: hwNode
                        ? `hardware decode (VAAPI on ${hwNode})`
                        : 'software decode — install a VAAPI-capable ffmpeg for lower CPU use on weak hardware',
                },
            })
        }

        launch(vaapiNode)
        return { ok: true }
    }

    async stop(id: string): Promise<void> {
        const conn = this.conns.get(id)
        if (!conn) return
        this.conns.delete(id)
        try { fs.unlinkSync(conn.sdpPath) } catch { /* already gone */ }

        // Wait for the process to actually release the UDP port before
        // returning — otherwise a Stop immediately followed by Start races
        // the OS into handing the new ffmpeg "Address already in use" for
        // a port the old one hasn't let go of yet (SIGTERM is not instant).
        if (conn.proc.exitCode !== null || conn.proc.signalCode !== null) return
        await new Promise<void>((resolve) => {
            conn.proc.once('exit', () => resolve())
            try { conn.proc.kill('SIGTERM') } catch { resolve(); return }
            const killTimer = setTimeout(() => {
                try { conn.proc.kill('SIGKILL') } catch { /* already dead */ }
            }, 1500)
            const giveUpTimer = setTimeout(resolve, 2500)
            conn.proc.once('exit', () => { clearTimeout(killTimer); clearTimeout(giveUpTimer) })
        })
    }

    send(): void {
        // One-way: this bridge is video-in only. The air unit's MAVLink
        // telemetry goes through the generic `udp` bridge separately.
    }
}
