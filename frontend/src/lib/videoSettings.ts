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
