// Turns a networked RTSP camera into an ordinary MediaStream, so it can ride
// the EXACT path a webcam already uses - no backend changes, no reachable
// server port, no NAT traversal problem.
//
// Why this exists next to the direct SRT relay (rtsp_relay):
//
//   rtsp_relay   laptop pushes the camera's original bytes to the server.
//                Best quality and CPU, but needs a routable server address.
//                Dead when both ends are behind NAT, which is the norm.
//
//   rtsp_camera  (this) laptop decodes locally and sends the result as a
//                normal WebRTC camera track. Costs an encode, but WebRTC
//                traverses NAT via STUN/TURN and works on essentially any
//                network - including ones that block UDP outright, via TURN
//                over TLS:443.
//
// The chain deliberately avoids re-encoding on the ffmpeg side. ffmpeg does
// `-c copy` into fragmented MP4 on loopback; Chromium decodes that (in
// hardware where available); captureStream() lifts the decoded frames back
// out as a MediaStream. So the only encode is the one WebRTC would do for
// any camera anyway.
//
//   RTSP --ffmpeg -c copy--> loopback fMP4 --<video>--> captureStream()
//        --> MediaStream --> existing startStream(cameraStream)

import { isDesktopApp, nativeBridge, type BridgeEvent } from '@/lib/nativeBridge'
import {
    getSiyiRtspUrl,
    getRtspTransport,
    getPreviewFragDurationUs,
    getLiveEdgeClamp,
} from '@/lib/videoSource'
import { clampToLiveEdge } from '@/lib/liveEdge'

export const RTSP_CAMERA_BRIDGE_ID = 'rtsp-camera-bridge'
export const RTSP_MJPEG_BRIDGE_ID = 'rtsp-camera-mjpeg'

// Fallback frame rate for the MJPEG path. Higher costs CPU on both the
// ffmpeg encode and the canvas draw; 20 is a reasonable middle for a
// fallback that only runs when the efficient path is unavailable.
const MJPEG_FPS = 20

// Chromium has had captureStream on media elements for years, but it is
// still absent from TypeScript's DOM lib.
interface CapturableVideo extends HTMLVideoElement {
    captureStream?: () => MediaStream
    mozCaptureStream?: () => MediaStream
}

const PREVIEW_TIMEOUT_MS = 15000

let videoEl: CapturableVideo | null = null
let stopClamp: (() => void) | null = null
let mjpegImg: HTMLImageElement | null = null
let mjpegRaf: number | null = null
// Last codec the bridge reported for the camera. Recorded so a playback
// failure can say "the camera is hevc" instead of "if the camera is H.265".
let reportedCodec: string | null = null

export function getReportedCodec(): string | null {
    return reportedCodec
}

// Which rung of the fallback ladder is actually carrying video, and why the
// better ones were skipped. Kept at module scope because the ladder resolves
// inside startRtspCameraStream() and the answer is needed long afterwards -
// diagnosing "why is the feed slow" without knowing which path is live means
// guessing, which cost this project two build cycles.
let activeRung: string | null = null
let rungFailures: string[] = []

export function getActiveRung(): string | null {
    return activeRung
}

export function getRungFailures(): string[] {
    return rungFailures
}

if (typeof window !== 'undefined') {
    // Console-readable alongside __hyrakLiveEdge().
    ;(window as unknown as Record<string, unknown>).__hyrakRtspPath = () => ({
        activeRung,
        reportedCodec,
        failedRungs: rungFailures,
    })
}

// A dedicated, permanent subscription. ffmpeg only prints its input stream
// line once it has actually connected to the camera, which is AFTER the
// preview URL is known - so the short-lived listener in waitForPreviewUrl is
// already gone by then and would never see it.
if (typeof window !== 'undefined' && isDesktopApp()) {
    nativeBridge()?.onEvent((event: BridgeEvent) => {
        if (event.bridge !== 'rtsp-relay' || event.id !== RTSP_CAMERA_BRIDGE_ID) return
        const codec = event.meta?.codec
        if (codec) reportedCodec = String(codec)
    })
}

function waitForPreviewUrl(timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const bridge = nativeBridge()
        if (!bridge) { reject(new Error('Desktop bridge unavailable')); return }
        const timer = setTimeout(() => {
            off?.()
            reject(new Error('Relay did not report a preview URL in time'))
        }, timeoutMs)
        const off = bridge.onEvent((event: BridgeEvent) => {
            if (event.bridge !== 'rtsp-relay' || event.id !== RTSP_CAMERA_BRIDGE_ID) return
            const meta = event.meta ?? {}
            if (meta.codec) reportedCodec = String(meta.codec)
            if (meta.previewUrl) {
                clearTimeout(timer)
                off?.()
                resolve(String(meta.previewUrl))
            } else if (meta.error) {
                clearTimeout(timer)
                off?.()
                reject(new Error(String(meta.error)))
            }
        })
    })
}

/** Starts the local RTSP decode and returns a MediaStream suitable for
 *  handing straight to the normal WebRTC start path.
 *
 *  Tries the efficient path first (ffmpeg -c copy → fMP4 → the browser
 *  decodes), and falls back to MJPEG (ffmpeg decodes → the browser just
 *  displays JPEGs) when the browser can't play the camera's codec. The
 *  fallback costs a JPEG encode but always works, because ffmpeg's decoder
 *  is not subject to Chromium's missing software H.265 support. */
export async function startRtspCameraStream(): Promise<MediaStream> {
    if (!isDesktopApp()) {
        throw new Error('RTSP camera needs the HYRAK desktop app - a browser tab cannot open RTSP.')
    }
    await stopRtspCameraStream()
    // Three rungs, best first. The camera's codec decides which one works,
    // and we cannot know it until ffmpeg has connected - so rather than
    // probing first, just descend on failure.
    //
    //   1. -c copy       no re-encode at all. Works when the camera is H.264.
    //   2. → H.264       ffmpeg transcodes (VAAPI if available). Works for an
    //                    H.265 camera, because the BROWSER then only ever sees
    //                    H.264, which it can always decode. Efficient enough
    //                    to be the real answer, not a consolation prize.
    //   3. MJPEG         last resort: no inter-frame compression at all, so
    //                    bandwidth is high, but it cannot fail on codec.
    const attempts: { label: string; run: () => Promise<MediaStream> }[] = [
        { label: 'direct (no re-encode)', run: () => startViaFmp4(false) },
        { label: 'H.264 transcode', run: () => startViaFmp4(true) },
        { label: 'MJPEG', run: startViaMjpeg },
    ]

    const failures: string[] = []
    activeRung = null
    rungFailures = []
    for (const attempt of attempts) {
        try {
            const stream = await attempt.run()
            activeRung = attempt.label
            rungFailures = [...failures]
            if (failures.length) {
                // Loudly, and with the reasons. A silent fall to MJPEG is how
                // a ~500ms feed became ~1.5s without anyone noticing: MJPEG is
                // 20fps, has no inter-frame compression, and goes through
                // <img> -> canvas -> rAF -> captureStream. It is a safety net,
                // not an acceptable steady state, so the reasons the better
                // rungs failed must survive rather than being discarded the
                // moment something finally works.
                console.warn(
                    `RTSP camera FELL BACK to "${attempt.label}". Rungs that failed first:\n  `
                    + failures.join('\n  '),
                )
            } else {
                console.info(`RTSP camera using best path: ${attempt.label}`)
            }
            return stream
        } catch (e) {
            const msg = `${attempt.label}: ${(e as Error).message}`
            failures.push(msg)
            console.warn(`RTSP camera rung failed - ${msg}`)
            await stopRtspCameraStream()
        }
    }
    rungFailures = [...failures]
    throw new Error(`No usable path for this camera. ${failures.join(' | ')}`)
}

async function startViaFmp4(transcode: boolean): Promise<MediaStream> {

    // Subscribe BEFORE starting. The bridge emits its status event before
    // start() resolves, so subscribing afterwards misses it and then waits
    // out the full timeout for an event that already fired - which is
    // exactly what "Relay did not report a preview URL in time" was.
    // Marked handled up front: when start() returns the URL directly this
    // promise is never awaited, and an unawaited rejection 15s later would
    // surface as an unhandled promise rejection in the console.
    reportedCodec = null
    let pendingErr: Error | null = null
    const pendingUrl = waitForPreviewUrl(PREVIEW_TIMEOUT_MS)
    pendingUrl.catch((e: Error) => { pendingErr = e })

    // Preview only: no uplink, no server allocation, nothing to reach.
    const started = await nativeBridge()?.start('rtsp-relay', RTSP_CAMERA_BRIDGE_ID, {
        url: getSiyiRtspUrl(),
        uplink: false,
        preview: true,
        rtspTransport: getRtspTransport(),
        fragDurationUs: getPreviewFragDurationUs(),
        ...(transcode ? { transcodePreview: 'h264' } : {}),
    })
    if (started && !started.ok) throw new Error(started.error ?? 'Could not start RTSP camera')

    // start() returns the URL directly - the awaited promise cannot be
    // missed. The event subscription above stays only as a fallback for a
    // desktop build older than 0.1.10, which doesn't return meta yet.
    const returnedUrl = started?.meta?.previewUrl
    const previewUrl = typeof returnedUrl === 'string' && returnedUrl
        ? returnedUrl
        : await pendingUrl.catch(() => { throw pendingErr ?? new Error('No preview URL from relay') })

    const el = document.createElement('video') as CapturableVideo
    el.muted = true
    el.autoplay = true
    el.playsInline = true
    // Never attached to the DOM - this element exists only as a decoder.
    el.src = previewUrl
    videoEl = el

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error('No video decoded from the camera within 15s - is the RTSP URL right?')),
            PREVIEW_TIMEOUT_MS,
        )
        el.onloadeddata = () => { clearTimeout(timer); resolve() }
        el.onerror = () => {
            clearTimeout(timer)
            // MediaError.code distinguishes causes that look identical from
            // the outside. Guessing "probably H.265" while discarding this
            // was wrong: NETWORK and SRC_NOT_SUPPORTED have completely
            // different fixes.
            const err = el.error
            const codecNote = reportedCodec ? ` Camera codec is ${reportedCodec}.` : ''
            const detail = err ? ` [code ${err.code}${err.message ? `: ${err.message}` : ''}]` : ''
            switch (err?.code) {
                case 2: // MEDIA_ERR_NETWORK
                    reject(new Error(
                        `Could not fetch the local preview stream${detail}. The relay is running but the `
                        + 'page could not read from it - likely the loopback HTTP request being blocked.',
                    ))
                    break
                case 3: // MEDIA_ERR_DECODE
                    reject(new Error(
                        `Stream started but decoding failed${detail}. The container is readable, so this `
                        + `is a codec/profile the decoder cannot handle rather than a transport problem.${codecNote}`,
                    ))
                    break
                case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
                    // Deliberately rung-aware. This message used to blame H.265
                    // unconditionally, which was actively harmful: the real
                    // cause was a truncated fMP4 (the bridge served no
                    // ftyp/moov), and on the TRANSCODE rung the stream is
                    // H.264 - so "switch your camera to H.264" was advice for
                    // a stream that already was H.264. That sent four releases
                    // of latency work down the wrong path. Never attribute a
                    // decode failure to the INPUT codec on a rung that
                    // re-encodes.
                    reject(new Error(transcode
                        ? `Browser rejected the transcoded H.264 stream${detail}. The output codec is `
                          + 'H.264, which Chromium can always decode, so this points at a malformed '
                          + 'container rather than a codec gap - check that the preview stream begins '
                          + `with ftyp+moov (ffprobe should NOT say "no tfhd was found").${codecNote}`
                        : `This machine cannot play the camera's codec directly${detail}. Chromium ships `
                          + 'no SOFTWARE H.265 decoder, so an H.265 camera plays only where hardware '
                          + `HEVC decode exists. Falling back to a transcode.${codecNote}`,
                    ))
                    break
                default:
                    reject(new Error(`Preview playback failed${detail}.${codecNote}`))
            }
        }
        el.play().catch(() => { /* autoplay policy - muted playback should still start */ })
    })

    // Only now that frames are decoding. Chromium has by this point already
    // built up whatever standing buffer it wanted, and that buffer is the
    // biggest single term in the preview's delay - captureStream() lifts
    // frames out at the element's PLAYBACK position, so anything sitting
    // ahead of it is latency handed straight to the operator and to WebRTC.
    if (getLiveEdgeClamp()) stopClamp = clampToLiveEdge(el)

    const capture = el.captureStream ?? el.mozCaptureStream
    if (!capture) throw new Error('This browser cannot capture a stream from a video element')
    const stream = capture.call(el)
    if (stream.getVideoTracks().length === 0) {
        throw new Error('Captured stream has no video track')
    }
    return stream
}

/** Fallback: ffmpeg DECODES the camera and serves MJPEG, which every browser
 *  can display in an <img> regardless of the original codec. Costs a JPEG
 *  encode on the laptop and a decode in the browser - strictly worse than
 *  the -c copy path - but it removes the browser codec dependency entirely,
 *  which is the whole point when Chromium can't decode H.265. */
async function startViaMjpeg(): Promise<MediaStream> {
    const started = await nativeBridge()?.start('rtsp', RTSP_MJPEG_BRIDGE_ID, {
        url: getSiyiRtspUrl(),
        fps: MJPEG_FPS,
    })
    if (started && !started.ok) throw new Error(started.error ?? 'MJPEG fallback failed to start')
    const streamUrl = started?.meta?.streamUrl
    if (typeof streamUrl !== 'string' || !streamUrl) {
        throw new Error('MJPEG fallback did not report a stream URL')
    }

    const img = new Image()
    img.crossOrigin = 'anonymous'
    mjpegImg = img

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error('MJPEG fallback produced no frames within 15s')),
            PREVIEW_TIMEOUT_MS,
        )
        // A multipart MJPEG stream fires load on the FIRST frame and then
        // keeps replacing the image in place, so this resolves once video is
        // genuinely flowing.
        img.onload = () => { clearTimeout(timer); resolve() }
        img.onerror = () => {
            clearTimeout(timer)
            reject(new Error('Could not read the MJPEG fallback stream from the local relay'))
        }
        img.src = streamUrl
    })

    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth || 1280
    canvas.height = img.naturalHeight || 720
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not create a 2D canvas context')

    const draw = () => {
        if (!mjpegImg) return
        // naturalWidth changes if the camera switches resolution mid-stream.
        if (canvas.width !== mjpegImg.naturalWidth && mjpegImg.naturalWidth) {
            canvas.width = mjpegImg.naturalWidth
            canvas.height = mjpegImg.naturalHeight
        }
        try { ctx.drawImage(mjpegImg, 0, 0, canvas.width, canvas.height) } catch { /* frame mid-swap */ }
        mjpegRaf = requestAnimationFrame(draw)
    }
    mjpegRaf = requestAnimationFrame(draw)

    const stream = canvas.captureStream(MJPEG_FPS)
    if (stream.getVideoTracks().length === 0) throw new Error('Canvas capture produced no video track')
    return stream
}

export async function stopRtspCameraStream(): Promise<void> {
    if (stopClamp) { stopClamp(); stopClamp = null }
    if (videoEl) {
        try {
            videoEl.pause()
            videoEl.removeAttribute('src')
            videoEl.load()
        } catch { /* already torn down */ }
        videoEl = null
    }
    if (mjpegRaf !== null) { cancelAnimationFrame(mjpegRaf); mjpegRaf = null }
    if (mjpegImg) { mjpegImg.onload = null; mjpegImg.onerror = null; mjpegImg.src = ''; mjpegImg = null }
    if (isDesktopApp()) {
        try { await nativeBridge()?.stop('rtsp-relay', RTSP_CAMERA_BRIDGE_ID) } catch { /* not running */ }
        try { await nativeBridge()?.stop('rtsp', RTSP_MJPEG_BRIDGE_ID) } catch { /* not running */ }
    }
}
