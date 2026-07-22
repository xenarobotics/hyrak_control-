// User-tunable capture quality for the WebRTC pipeline. Persisted in
// localStorage (same convention as the settings page) and read at stream
// start; the settings page can also live-apply to a running stream.

export type VideoRes = '480' | '720' | '1080'
export type VideoFps = 12 | 15 | 20 | 25 | 30

export const RES_OPTIONS: VideoRes[] = ['480', '720', '1080']
export const FPS_OPTIONS: VideoFps[] = [12, 15, 20, 25, 30]

const RES_DIMS: Record<VideoRes, { width: number; height: number }> = {
    '480':  { width: 854,  height: 480 },
    '720':  { width: 1280, height: 720 },
    '1080': { width: 1920, height: 1080 },
}

// Uplink bitrate the browser is allowed to spend per resolution. Browsers
// default to ~2.5 Mbps regardless of resolution, which crushes 1080p.
const RES_MAX_BITRATE: Record<VideoRes, number> = {
    '480':  2_500_000,
    '720':  5_000_000,
    '1080': 8_000_000,
}

// How AI-mode video reaches the screen:
//   'overlay'   — show the LOCAL camera directly and draw AI results on a
//                 canvas from cv_results. Sharpest video, lowest latency,
//                 ~half the bandwidth (no return video stream); the boxes
//                 lag the video by one inference (~100 ms).
//   'processed' — show the server-rendered feed. Video and annotations are
//                 perfectly in sync, but quality is capped by the server
//                 re-encode and everything lags together.
// Depth and enhance transform the frame itself, so they always use the
// processed feed regardless of this setting.
export type FeedMode = 'overlay' | 'processed'

const OVERLAY_CAPABLE = [
    'manual-control', 'object-detection', 'human-tracking', 'person-tracking',
]

export function getFeedMode(): FeedMode {
    if (typeof window === 'undefined') return 'processed'
    try {
        const v = JSON.parse(localStorage.getItem('hyrak-feed-mode') ?? '""')
        if (v === 'overlay' || v === 'processed') return v
    } catch { /* fall back to default */ }
    return 'overlay'
}

export function wantsClientOverlay(mode: string): boolean {
    return getFeedMode() === 'overlay' && OVERLAY_CAPABLE.includes(mode)
}

export function getVideoSettings(): { res: VideoRes; fps: VideoFps } {
    if (typeof window === 'undefined') return { res: '720', fps: 30 }
    let res: VideoRes = '720'
    let fps: VideoFps = 30
    try {
        const r = JSON.parse(localStorage.getItem('hyrak-video-res') ?? '""')
        if (RES_OPTIONS.includes(r)) res = r
        const f = JSON.parse(localStorage.getItem('hyrak-video-fps') ?? '0')
        if (FPS_OPTIONS.includes(f)) fps = f
    } catch { /* fall back to defaults */ }
    return { res, fps }
}

export function videoConstraints(deviceId: string): MediaTrackConstraints {
    const { res, fps } = getVideoSettings()
    const { width, height } = RES_DIMS[res]
    return {
        deviceId: { exact: deviceId },
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: fps, max: fps },
    }
}

export function maxUplinkBitrate(): number {
    return RES_MAX_BITRATE[getVideoSettings().res]
}

// Tell the sender to spend bandwidth on the video and, under congestion,
// keep the frame rate and lower resolution instead of stuttering.
export async function tuneVideoSender(pc: RTCPeerConnection) {
    const sender = pc.getSenders().find(s => s.track?.kind === 'video')
    if (!sender) return
    try {
        sender.track!.contentHint = 'motion'
        const params = sender.getParameters()
        params.degradationPreference = 'maintain-framerate'
        if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}]
        }
        params.encodings[0].maxBitrate = maxUplinkBitrate()
        await sender.setParameters(params)
    } catch (e) {
        console.warn('Video sender tuning failed (non-fatal):', e)
    }
}
