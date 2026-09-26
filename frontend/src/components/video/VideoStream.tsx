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

// 'fit' shows the WHOLE frame at the source's own aspect, letterboxed -
// distinct from the fixed presets, which force an aspect the camera may not
// have. For a 16:10 or 4:3 sensor 'fill' crops away frame the AI is still
// analysing, so a detection can sit where the operator cannot see it.
type AspectRatio = 'fill' | 'fit' | '16:9' | '4:3' | '1:1'

// `bare`: picture + OSD only, no control bar. For hosts that put Start/Stop
// and the rest in their own chrome (the Command window's top bar).
export function VideoStream({ bare = false }: { bare?: boolean } = {}) {
    const [hevcFailed, setHevcFailed] = useState(false)
    const {
        remoteStream, localStream,
        isStreaming, isLoading, stats, lastError,
        selectedCameraId, startStream, stopStream,
    } = useWebRTCContext()

    // Server-sourced feeds (air-unit UDP, SIYI RTSP) need no browser camera
    // at all. Starts false (matches the server-rendered HTML, which has no
    // localStorage to read) and is set for real after mount - reading
    // getVideoSource() straight into the initial state would make the
    // server and client's first render disagree whenever a non-default
    // source is saved, which React flags as a hydration mismatch.
    const [serverSourced, setServerSourced] = useState(false)
    const [needsCamera, setNeedsCamera] = useState(false)
    useEffect(() => {
        setServerSourced(isServerSourced(getVideoSource()))
        setNeedsCamera(needsCameraSelection(getVideoSource()))
    }, [])

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
    const isRaw = mode === 'manual-control' && !serverSourced

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

    return (
        <div
            ref={containerRef}
            className={cn(
                'relative flex flex-col rounded-xl border overflow-hidden transition-all',
                maximized && !isFullscreen ? 'fixed inset-4 z-50' : 'flex-1'
            )}
            style={{ background: '#000', borderColor: 'hsl(var(--app-border))' }}
        >
            {/* Main video - raw local feed when no AI mode is active, processed remote feed otherwise */}
            {wcUrl ? (
                <WebCodecsVideo
                    src={wcUrl}
                    codec={wcCodec}
                    onDecodeError={serverFeed ? () => setHevcFailed(true) : (wcCodec === 'hevc' ? fallbackFromHevc : undefined)}
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
                stream negotiates, so "VIDEO OFFLINE" over a working picture
                would be wrong. */}
            {!isStreaming && !localPreviewUrl && (
                <div className="flex-1 flex flex-col items-center justify-center gap-3"
                    style={{ color: 'rgba(255,255,255,0.3)' }}
                >
                    <VideoOff size={40} strokeWidth={1.5} />
                    <p className="font-mono text-sm tracking-wider">VIDEO OFFLINE</p>
                    {needsCamera && !selectedCameraId && (
                        <p className="text-xs opacity-50">Select a camera in Devices panel</p>
                    )}
                    {lastError && (
                        <p className="text-xs text-center max-w-xs px-4" style={{ color: '#f87171' }}>{lastError}</p>
                    )}
                </div>
            )}

            {/* OSD overlay - fly tab only */}
            {isStreaming && <VideoOSD stats={stats} />}

            {/* PiP local feed - only useful as a comparison while viewing the AI-processed remote feed */}
            {isStreaming && localStream && !isRaw && (
                <div className="absolute bottom-12 left-3 w-28 rounded-lg overflow-hidden border"
                    style={{ borderColor: 'rgba(255,255,255,0.15)', aspectRatio: '16/9' }}
                >
                    <video
                        ref={localVideoRef}
                        autoPlay playsInline muted
                        className="w-full h-full object-cover"
                    />
                    <div className="absolute bottom-1 left-1 text-[9px] font-mono px-1 rounded"
                        style={{ background: 'rgba(0,0,0,0.6)', color: '#fff' }}>
                        LOCAL
                    </div>
                </div>
            )}

            {/* Controls */}
            {!bare && <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between px-3 py-2"
                style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.7), transparent)' }}
            >
                <RecordingControls videoRef={mainVideoRef} isStreaming={isStreaming} />
                <div className="flex items-center gap-1.5">
                    {isStreaming && (
                        <div className="flex gap-1">
                            {(['fill', 'fit', '16:9', '4:3', '1:1'] as const).map(r => (
                                <button key={r} onClick={() => setAspectRatio(r)}
                                    className="px-2 py-1 rounded text-[10px] font-mono"
                                    style={{
                                        background: aspectRatio === r ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.5)',
                                        border: `1px solid ${aspectRatio === r ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.1)'}`,
                                        color: aspectRatio === r ? 'white' : 'rgba(255,255,255,0.5)',
                                    }}
                                >
                                    {r}
                                </button>
                            ))}
                        </div>
                    )}
                    <Button size="sm"
                        variant={isStreaming ? 'destructive' : 'default'}
                        className="font-mono text-xs gap-1.5 shadow-lg"
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
                        disabled={isLoading || (needsCamera && !selectedCameraId && !isStreaming)}
                    >
                        {isLoading
                            ? <><Loader size={12} className="animate-spin" /> Starting...</>
                            : isStreaming
                                ? <><VideoOff size={12} /> Stop</>
                                : <><Video size={12} /> Start</>
                        }
                    </Button>
                    <Button size="sm" variant="outline" className="shadow-lg" onClick={() => setMaximized(m => !m)}>
                        {maximized ? <Minimize size={14} /> : <Maximize size={14} />}
                    </Button>
                    <Button size="sm" variant="outline" className="shadow-lg" onClick={handleFullscreen}>
                        {isFullscreen ? <Shrink size={14} /> : <Expand size={14} />}
                    </Button>
                </div>
            </div>}
        </div>
    )
}