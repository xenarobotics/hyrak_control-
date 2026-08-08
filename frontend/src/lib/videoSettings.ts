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

// Detail profile ceilings. Roughly 2.5x, because the thing being preserved is
// exactly what a normal encoder throws away first: high-frequency detail in a
// small region — which is all a number plate is.
const RES_MAX_BITRATE_DETAIL: Record<VideoRes, number> = {
    '480':  6_000_000,
    '720':  12_000_000,
    '1080': 20_000_000,
}

// How the browser's encoder should spend its bitrate.
//
//   'smooth' — prioritise motion. Under congestion the resolution drops and
//              the frame rate holds. Right for flying and for watching.
//   'detail' — prioritise fine detail. Under congestion the FRAME RATE drops
//              and the resolution holds, and the encoder is told the content
//              is detail rather than motion.
//
// This matters far more than it looks for reading anything small. The two
// defaults were actively working against plate OCR: contentHint 'motion' asks
// the encoder to smear high-frequency detail (a plate is nothing BUT
// high-frequency detail in a few hundred pixels), and
// degradationPreference 'maintain-framerate' throws resolution away first —
// resolution being the one thing a 64px plate cannot spare. A dropped frame
// costs nothing here: the plate is still there on the next one.
export type CaptureProfile = 'smooth' | 'detail'

export function getCaptureProfile(): CaptureProfile {
    if (typeof window === 'undefined') return 'smooth'
    try {
        const v = JSON.parse(localStorage.getItem('hyrak-capture-profile') ?? '""')
        if (v === 'smooth' || v === 'detail') return v
    } catch { /* fall back to default */ }
    return 'smooth'
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

// MUST list every mode CvOverlayCanvas can draw — its `switch (mode)` is the
// other half of this list, and the two silently disagreeing is expensive.
//
// traffic-management was missing here while having a full draw function, a
// click handler and an entry in CLICK_TO_SELECT. Nothing errored. The mode
// simply fell through to the PROCESSED feed, so:
//
//   * CvOverlayCanvas was never mounted — no hover highlight and no
//     click-to-follow were possible at all, in any circumstance;
//   * the picture on screen was the server's re-encoded round trip, which is
//     what made it look soft and blocky next to the other modes;
//   * annotations were burned in server-side at the ANALYSIS rate, so they
//     stepped at ~20fps under 30fps video instead of being interpolated.
//
// Every one of those reads as a different bug. They were one missing string.
const OVERLAY_CAPABLE = [
    'manual-control', 'object-detection', 'human-tracking', 'person-tracking',
    'crowd-management', 'vehicle-plate-tracking', 'traffic-management',
]

export function getFeedMode(): FeedMode {
    if (typeof window === 'undefined') return 'processed'
    try {
        const v = JSON.parse(localStorage.getItem('hyrak-feed-mode') ?? '""')
        if (v === 'overlay' || v === 'processed') return v
    } catch { /* fall back to default */ }
    return 'overlay'
}

/** The canonical list, exported so CvOverlayCanvas can assert against it in
 *  dev rather than failing silently when the two drift apart. */
export function overlayCapableModes(): string[] {
    return [...OVERLAY_CAPABLE]
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

// Crowd-management density thresholds — whole-frame headcount is entirely
// FOV-dependent (how tight the drone is framed, altitude, lens), so there's
// no universally correct default. Presets, not raw numbers, keep this
// approachable for non-technical operators (Settings page).
export type CrowdPreset = 'tight' | 'default' | 'loose' | 'custom'

const CROWD_PRESETS: Record<Exclude<CrowdPreset, 'custom'>,
                            { lightMax: number; moderateMax: number }> = {
    tight:   { lightMax: 2, moderateMax: 5 },
    default: { lightMax: 4, moderateMax: 9 },
    loose:   { lightMax: 6, moderateMax: 14 },
}

export function getCrowdPreset(): CrowdPreset {
    if (typeof window === 'undefined') return 'default'
    try {
        const v = JSON.parse(localStorage.getItem('hyrak-crowd-preset') ?? '""')
        if (v === 'tight' || v === 'default' || v === 'loose' || v === 'custom') return v
    } catch { /* fall back to default */ }
    return 'default'
}

// Operator-entered thresholds, used when the preset is 'custom'.
//
// Presets keep the common case one click away, but they cannot be right for
// everyone: whole-frame headcount depends on lens, altitude and how tight the
// framing is, so a venue that has actually counted its own safe occupancy has
// better numbers than any preset here. This is where those go.
export function getCrowdCustom(): { lightMax: number; moderateMax: number } {
    const fallback = CROWD_PRESETS.default
    if (typeof window === 'undefined') return fallback
    try {
        const raw = JSON.parse(localStorage.getItem('hyrak-crowd-custom') ?? 'null')
        if (raw && Number.isFinite(raw.lightMax) && Number.isFinite(raw.moderateMax)) {
            return normaliseCrowdThresholds(raw.lightMax, raw.moderateMax)
        }
    } catch { /* fall back below */ }
    return fallback
}

/** moderateMax must stay above lightMax or the "orange" band vanishes and
 *  every count jumps green -> red with nothing in between. */
export function normaliseCrowdThresholds(light: number, moderate: number) {
    const lightMax = Math.max(1, Math.round(light))
    return { lightMax, moderateMax: Math.max(lightMax + 1, Math.round(moderate)) }
}

export function getCrowdThresholds(): { lightMax: number; moderateMax: number } {
    const p = getCrowdPreset()
    return p === 'custom' ? getCrowdCustom() : CROWD_PRESETS[p]
}

export function maxUplinkBitrate(): number {
    const { res } = getVideoSettings()
    return getCaptureProfile() === 'detail'
        ? RES_MAX_BITRATE_DETAIL[res]
        : RES_MAX_BITRATE[res]
}

// Standby uplink — what the browser sends the server while NO AI mode is
// active (manual control). The server only makes admin-dashboard previews
// from it, so full quality is pure waste on a weak machine — but a strong
// ground station may still want crisp admin previews. 'auto' picks eco
// exactly when the extra load actually exists: when the camera is the
// air-unit virtual webcam (the same laptop is then also software-decoding
// the RF H.265 feed — see air_unit_relay/video_webcam.sh, which names the
// device "HyrakAirUnit"). AI modes are never affected; they always uplink
// at full quality because the server genuinely consumes those frames.
export type StandbyUplink = 'auto' | 'full' | 'eco'

export function getStandbyUplink(): StandbyUplink {
    if (typeof window === 'undefined') return 'auto'
    try {
        const v = JSON.parse(localStorage.getItem('hyrak-standby-uplink') ?? '""')
        if (v === 'auto' || v === 'full' || v === 'eco') return v
    } catch { /* fall back to default */ }
    return 'auto'
}

export function wantsEcoUplink(cameraLabel: string): boolean {
    const pref = getStandbyUplink()
    if (pref === 'eco') return true
    if (pref === 'full') return false
    return /hyrakairunit/i.test(cameraLabel)
}

// Tell the sender to spend bandwidth on the video and, under congestion,
// keep the frame rate and lower resolution instead of stuttering.
//
// thumbnailOnly: preview-quality uplink for manual control (see the
// StandbyUplink note above — callers gate it on the mode AND on
// wantsEcoUplink). The mode can't change while streaming, so it's safe to
// hold for the whole stream; a settings change live-applies via
// applyVideoSettings, which re-evaluates it.
export async function tuneVideoSender(pc: RTCPeerConnection, thumbnailOnly = false) {
    const sender = pc.getSenders().find(s => s.track?.kind === 'video')
    if (!sender) return
    try {
        // See CaptureProfile above: for anything the SERVER has to read rather
        // than a human watch, resolution outranks smoothness and detail
        // outranks motion — the opposite of the right choice for flying.
        const detail = getCaptureProfile() === 'detail'
        sender.track!.contentHint = detail ? 'detail' : 'motion'
        const params = sender.getParameters()
        params.degradationPreference = detail
            ? 'maintain-resolution'
            : 'maintain-framerate'
        if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}]
        }
        if (thumbnailOnly) {
            params.encodings[0].maxBitrate = 400_000
            params.encodings[0].maxFramerate = 8
            params.encodings[0].scaleResolutionDownBy = 2
        } else {
            // Explicitly undo a previous eco pass — live-applying a settings
            // change reuses the same sender, so stale caps would stick.
            params.encodings[0].maxBitrate = maxUplinkBitrate()
            params.encodings[0].maxFramerate = undefined
            params.encodings[0].scaleResolutionDownBy = 1
        }
        await sender.setParameters(params)
    } catch (e) {
        console.warn('Video sender tuning failed (non-fatal):', e)
    }
}


// How the video is fitted into its container.
//
//   'fill' — object-fit: cover. Fills the panel, CROPS whatever does not fit.
//   'fit'  — object-fit: contain. Whole frame visible, letterboxed.
//
// 'fit' matters more than it sounds for a surveillance tool: with a 4:3 or
// 16:10 camera in a 16:9 panel, 'fill' silently hides a strip of frame that
// the AI is still analysing — so a detection can sit in a part of the image
// the operator cannot see. The overlay canvas MUST use the same value, or
// boxes and clicks land in the wrong place.
export type VideoFit = 'fill' | 'fit'

export function getVideoFit(): VideoFit {
    if (typeof window === 'undefined') return 'fill'
    try {
        const v = JSON.parse(localStorage.getItem('hyrak-video-fit') ?? '""')
        if (v === 'fill' || v === 'fit') return v
    } catch { /* fall back */ }
    return 'fill'
}

export function setVideoFit(v: VideoFit) {
    localStorage.setItem('hyrak-video-fit', JSON.stringify(v))
    window.dispatchEvent(new CustomEvent('hyrak-video-fit', { detail: v }))
}
