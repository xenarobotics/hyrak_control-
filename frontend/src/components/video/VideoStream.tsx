'use client'

import { useRef, useState, useEffect, useCallback } from 'react'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { useDroneStore } from '@/store/drone'
import { useServerFeed } from '@/lib/serverHevcFeed'
import { VideoOSD } from '@/components/osd/VideoOSD'
import { RecordingControls } from './RecordingControls'
import { Button } from '@/components/ui/button'
import { Video, VideoOff, Maximize, Minimize, Expand, Shrink, Loader } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getVideoSource, isServerSourced, needsCameraSelection, getLiveEdgeClamp } from '@/lib/videoSource'
import { useRtspRelayBridge } from '@/hooks/useRtspRelayBridge'
import { useAirUnitPreview } from '@/lib/airUnitPreview'
import { useGstPreview } from '@/lib/gstPreview'
import { useReceiver, fallbackFromHevc } from '@/lib/hyrakReceiver'
import { clampToLiveEdge } from '@/lib/liveEdge'
import { WebCodecsVideo } from './WebCodecsVideo'
import { useClientValue } from '@/hooks/useClientValue'
import { FOCUS_OVERLAY, OVERLAY_BTN } from '@/components/controls/flightStyles'
import { WhyDisabled } from '@/components/controls/WhyDisabled'

// 'fit' shows the WHOLE frame at the source's own aspect, letterboxed -
// distinct from the fixed presets, which force an aspect the camera may not
// have. For a 16:10 or 4:3 sensor 'fill' crops away frame the AI is still
// analysing, so a detection can sit where the operator cannot see it.
type AspectRatio = 'fill' | 'fit' | '16:9' | '4:3' | '1:1'

// `bare`: picture + OSD only, no control bar. For hosts that put Start/Stop
// and the rest in their own chrome (the Command window's top bar).
// `cleanFeed`: always show the unprocessed picture when a local one exists,
// even while an AI mode runs - for hosts that show the AI view separately
// (Command). Without it an overlay-mode stream, which has no return video,
// leaves this pane black.
// `noOsd`: the picture only, no flight overlay (Normal mode draws its own,
// plainer readouts outside the picture).
export function VideoStream({ bare = false, cleanFeed = false, noOsd = false }: { bare?: boolean; cleanFeed?: boolean; noOsd?: boolean } = {}) {
    const [hevcFailed, setHevcFailed] = useState(false)
    const {
        remoteStream, localStream,
        isStreaming, isLoading, stats, lastError,
        selectedCameraId, camerasScanned, startStream, stopStream,
    } = useWebRTCContext()

    // Server-sourced feeds (air-unit UDP, SIYI RTSP) need no browser camera
    // at all. Read hydration-safely: the server has no localStorage, so its
    // render (and the hydrating one) sees the default source.
    const videoSource = useClientValue(getVideoSource, 'camera')
    const serverSourced = isServerSourced(videoSource)
    const needsCamera = needsCameraSelection(videoSource)

    // Relay mode serves the operator a local preview straight off the same
    // ffmpeg that feeds the server, so the picture on this screen never
    // makes the round trip to the backend and back. The air-unit DataChannel
    // source has the same arrangement via its own preview-only relay instance
    // (lib/airUnitPreview.ts) - at most one of the two is ever non-null,
    // since they belong to mutually exclusive video sources.
    const { previewUrl: relayPreviewUrl } = useRtspRelayBridge()
    const airUnitPreviewUrl = useAirUnitPreview()
    const gst = useGstPreview()
    const receiver = useReceiver()
    // At most one is ever non-null - they belong to mutually exclusive sources.
    const localPreviewUrl = relayPreviewUrl ?? gst?.previewUrl ?? receiver?.previewUrl ?? airUnitPreviewUrl
    // WebCodecs renders to a canvas and needs neither the <video> element nor
    // the live-edge controller - there is no playback buffer to clamp.
    // Server-read air unit: the backend's bit-exact H.265 stream, decoded here
    // with WebCodecs, replaces the VP8 re-encode whenever this Chromium can
    // decode HEVC (probed once). A decode failure disables it for the session
    // and the pane falls back to the WebRTC track on the next start.
    const serverFeed = useServerFeed(isStreaming && !hevcFailed)
    const serverHevcUrl = serverFeed?.url ?? null
    // Stable identity: WebCodecsVideo lists onDecodeError in its effect deps,
    // and this component re-renders every second with stats, so an inline
    // arrow tore the decoder down and reopened the feed once a second.
    const onServerFeedFail = useCallback(() => setHevcFailed(true), [])
    const wcUrl = gst?.webcodecs ? gst.previewUrl : (receiver?.previewUrl ?? serverHevcUrl ?? null)
    // The receiver decides between H.265 passthrough and an H.264 transcode at
    // run time, and can change its mind mid-session, so this is read from its
    // status rather than assumed. gst mode always transcodes to H.264.
    const wcCodec = gst?.webcodecs ? 'h264' : (receiver?.codec ?? (serverFeed?.codec ?? 'h264'))

    const mode = useDroneStore(s => s.mode)
    // manual-control has nothing to process - bypassing the backend WebRTC
    // round-trip (browser encode -> backend software decode/encode -> browser
    // decode) and rendering the local getUserMedia stream directly removes
    // both software transcode hops, which is what was causing the jitter
    // vs. a native camera app. AI modes still need the processed remote feed.
    // Doesn't apply to server-sourced feeds - there's no local camera
    // stream to fall back to (localStream stays null), so that path would
    // just render blank instead of the real remote video.
    const isRaw = !serverSourced && (mode === 'manual-control' || (cleanFeed && !!localStream))

    const mainVideoRef = useRef<HTMLVideoElement | null>(null)
    const localVideoRef = useCallback((el: HTMLVideoElement | null) => {
        if (el && localStream) {
            el.srcObject = localStream
        }
    }, [localStream])
    const containerRef = useRef<HTMLDivElement | null>(null)
    const [maximized, setMaximized] = useState(false)
    const [isFullscreen, setIsFullscreen] = useState(false)
    const [aspectRatio, setAspectRatio] = useState<AspectRatio>('fill')

    // Attach whichever stream should currently be visible to the main video
    // element. Relay mode is the exception: its preview is a loopback HTTP
    // URL rather than a MediaStream, so it goes on `src` and srcObject must
    // be cleared - setting both leaves srcObject winning and the pane black.
    useEffect(() => {
        const el = mainVideoRef.current
        if (!el) return
        if (wcUrl) { el.removeAttribute('src'); el.srcObject = null; return }
        if (localPreviewUrl) {
            el.srcObject = null
            if (el.src !== localPreviewUrl) el.src = localPreviewUrl
            // A live progressive stream in a <video> settles behind its own
            // newest frame and STAYS there - frames arrive at exactly the rate
            // they are consumed, so the startup backlog is permanent. Drain it
            // back to the live edge; see lib/liveEdge.ts for why a seek can't
            // be used here.
            //
            // Forced on for the GStreamer preview, not left to the setting: a
            // stale `hyrak-live-edge-clamp=0` in localStorage silently disables
            // the only thing keeping this feed live, and the symptom is a
            // multi-second delay with a pipeline that measures ZERO buffering -
            // which sends you hunting upstream where nothing is wrong. This
            // mode exists specifically to be low latency, so it does not get an
            // off switch.
            return (gst?.previewUrl || getLiveEdgeClamp()) ? clampToLiveEdge(el) : undefined
        }
        el.removeAttribute('src')
        el.srcObject = isRaw ? localStream : remoteStream
    }, [isRaw, localStream, remoteStream, localPreviewUrl, gst?.previewUrl, wcUrl])

    useEffect(() => {
        const handler = () => setIsFullscreen(!!document.fullscreenElement)
        document.addEventListener('fullscreenchange', handler)
        return () => document.removeEventListener('fullscreenchange', handler)
    }, [])

    const handleFullscreen = useCallback(async () => {
        if (!document.fullscreenElement) {
            await containerRef.current?.requestFullscreen()
        } else {
            await document.exitFullscreen()
        }
    }, [])

    const videoStyle: React.CSSProperties =
        aspectRatio === 'fill' ? {}
        : aspectRatio === 'fit' ? { maxHeight: '100%', maxWidth: '100%' }
        : { aspectRatio: aspectRatio.replace(':', '/'), maxHeight: '100%', maxWidth: '100%' }

    const startBlocked = needsCamera && camerasScanned && !selectedCameraId && !isStreaming

    // Live picture: slate surround (the same in every theme). No picture:
    // the theme's inset colour with an icon, one line and one action, never
    // a black box in light mode (docs/DESIGN_SYSTEM.md section 11).
    const live = isStreaming || !!localPreviewUrl
    const pickCamera = needsCamera && camerasScanned && !selectedCameraId

    return (
        <div
            ref={containerRef}
            className={cn(
                'relative flex flex-col rounded-[10px] border overflow-hidden transition-colors duration-[180ms]',
                live ? 'bg-[#1A2129] border-[#1A2129]' : 'bg-app-surface-2 border-app-border',
                maximized && !isFullscreen ? 'fixed inset-4 z-50' : 'flex-1'
            )}
        >
            {/* Main video - raw local feed when no AI mode is active, processed remote feed otherwise */}
            {wcUrl ? (
                <WebCodecsVideo
                    src={wcUrl}
                    codec={wcCodec}
                    onDecodeError={serverFeed ? onServerFeedFail : (wcCodec === 'hevc' ? fallbackFromHevc : undefined)}
                    className={aspectRatio === 'fill'
                        ? 'w-full h-full object-cover'
                        : 'h-full object-contain mx-auto'}
                    style={videoStyle}
                />
            ) : (
                <video
                    ref={mainVideoRef}
                    autoPlay playsInline muted
                    className={cn(
                        aspectRatio === 'fill' ? 'w-full h-full object-cover' : 'h-full object-contain mx-auto',
                        !isStreaming && !localPreviewUrl && 'hidden'
                    )}
                    style={videoStyle}
                />
            )}

            {/* Offline state - the relay preview is live before the backend
                stream negotiates, so "Video offline" over a working picture
                would be wrong. */}
            {!live && !noOsd && (
                <div className={cn("flex-1 flex flex-col items-center justify-center gap-3 px-4 text-center animate-in fade-in-0 duration-200", bare && "pt-10")}>
                    <span className="flex size-12 items-center justify-center rounded-full bg-app-surface text-app-text-muted border border-app-border">
                        {isLoading ? <Loader size={22} className="animate-spin" /> : <VideoOff size={22} strokeWidth={1.75} />}
                    </span>
                    <p className="text-[14px] font-semibold text-app-text">
                        {isLoading ? 'Starting video' : pickCamera ? 'Pick a camera to start the video' : 'Video offline'}
                    </p>
                    {!isLoading && (
                        <WhyDisabled reason={startBlocked ? 'Pick a camera first' : null} className="inline-block">
                            <Button size="sm" onClick={startStream} disabled={startBlocked}
                                className="h-9 px-4 gap-1.5 rounded-md text-[13px] font-bold bg-app-accent text-[var(--app-accent-ink)] hover:bg-app-accent hover:brightness-110 transition-[filter,transform] duration-[140ms] active:scale-[.98] disabled:opacity-100 disabled:bg-app-surface-2 disabled:text-app-text-subtle disabled:border disabled:border-app-border">
                                <Video size={15} /> Start video
                            </Button>
                        </WhyDisabled>
                    )}
                    {lastError && (
                        <p role="alert" className="text-[13px] font-semibold max-w-xs text-app-danger">{lastError}</p>
                    )}
                </div>
            )}

            {/* OSD overlay - fly tab only */}
            {isStreaming && !noOsd && <VideoOSD stats={stats} />}

            {/* PiP local feed - only useful as a comparison while viewing the AI-processed remote feed */}
            {isStreaming && localStream && !isRaw && (
                <div className="absolute bottom-14 left-3 w-28 rounded-md overflow-hidden border border-overlay-border"
                    style={{ aspectRatio: '16/9' }}
                >
                    <video
                        ref={localVideoRef}
                        autoPlay playsInline muted
                        className="w-full h-full object-cover"
                    />
                    <div className="absolute bottom-1 left-1 text-[12px] font-bold px-1.5 rounded bg-overlay-scrim text-overlay-text">
                        Local
                    </div>
                </div>
            )}

            {/* Controls */}
            {!bare && live && <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between px-3 py-2"
                style={{ background: 'linear-gradient(to top, rgba(26,33,41,0.8), transparent)' }}
            >
                {/* The recorder captures the <video>'s MediaStream. A WebCodecs
                    canvas has no <video>, and a local preview URL plays via
                    src= (no srcObject) - both recorded black or nothing. */}
                {!wcUrl && !localPreviewUrl
                    ? <RecordingControls videoRef={mainVideoRef} isStreaming={isStreaming} />
                    : <span />}
                <div className="flex items-center gap-1.5">
                    {isStreaming && (
                        <div className="hidden sm:flex gap-0.5 p-0.5 rounded-md border border-overlay-border bg-overlay-scrim backdrop-blur-[6px]" role="group" aria-label="Picture fit">
                            {(['fill', 'fit', '16:9', '4:3', '1:1'] as const).map(r => (
                                <button key={r} onClick={() => setAspectRatio(r)} aria-pressed={aspectRatio === r}
                                    className={cn('h-8 min-w-8 px-2 rounded text-[12px] font-bold capitalize transition-colors duration-[var(--dur-fast)]', FOCUS_OVERLAY,
                                        aspectRatio === r ? 'bg-[color-mix(in_srgb,var(--overlay-accent)_18%,transparent)] text-[var(--overlay-accent)]' : 'text-overlay-muted hover:text-overlay-text')}
                                >
                                    {r}
                                </button>
                            ))}
                        </div>
                    )}
                    <WhyDisabled reason={isLoading ? 'Starting the video' : startBlocked ? 'Pick a camera in Devices first' : null} className="inline-block">
                    <Button size="sm"
                        variant={isStreaming ? 'ghost' : 'default'}
                        className={cn(OVERLAY_BTN, FOCUS_OVERLAY, 'h-8 text-[13px] shadow-none disabled:opacity-100 disabled:text-overlay-muted',
                            isStreaming ? 'border-[var(--overlay-danger)] text-[var(--overlay-danger)] hover:text-[var(--overlay-danger)]'
                                : 'bg-[var(--overlay-accent)] border-[var(--overlay-accent)] text-[var(--overlay-scrim)] hover:bg-[var(--overlay-accent)] hover:brightness-110 disabled:bg-overlay-scrim')}
                        onClick={isStreaming ? stopStream : startStream}
                        // `needsCamera`, NOT `!serverSourced`. Only a real webcam
                        // requires the operator to pick a device. 'rtsp_camera'
                        // produces a MediaStream from a URL and is deliberately
                        // not server-sourced, so the old test disabled Start
                        // permanently on any machine with no webcam selected -
                        // which is the normal state on a dedicated ground-station
                        // PC. needsCameraSelection() exists for this and was
                        // already used correctly for the hint above; this call
                        // site was missed.
                        disabled={isLoading || startBlocked}
                    >
                        {isLoading
                            ? <><Loader size={14} className="animate-spin" /> Starting...</>
                            : isStreaming
                                ? <><VideoOff size={14} /> Stop</>
                                : <><Video size={14} /> Start</>
                        }
                    </Button>
                    </WhyDisabled>
                    <Button size="sm" variant="ghost" className={cn(OVERLAY_BTN, FOCUS_OVERLAY, 'h-8 w-8 px-0 hover:text-overlay-text')} onClick={() => setMaximized(m => !m)}
                        aria-label={maximized ? 'Restore video size' : 'Maximize video'}
                        title={maximized ? 'Restore video size' : 'Maximize video'}>
                        {maximized ? <Minimize size={14} /> : <Maximize size={14} />}
                    </Button>
                    <Button size="sm" variant="ghost" className={cn(OVERLAY_BTN, FOCUS_OVERLAY, 'h-8 w-8 px-0 hover:text-overlay-text')} onClick={handleFullscreen}
                        aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                        title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}>
                        {isFullscreen ? <Shrink size={14} /> : <Expand size={14} />}
                    </Button>
                </div>
            </div>}
        </div>
    )
}