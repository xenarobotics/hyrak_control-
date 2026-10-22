'use client'

// The Command window's AI view: what the running AI module sees, the way the
// AI tab shows it - no second stream is opened.
//   client-overlay stream  the local picture (webcam, or the in-app preview of
//                          a server-sourced feed) with the results drawn on it
//                          by CvOverlayCanvas
//   processed stream       the server's annotated video (remoteStream) - depth
//                          and enhance always, and any feed that cannot overlay
//   3D scan                the live reconstruction view
// The video-attach rule is shared with app/(platform)/modules/page.tsx via
// hooks/useAttachVideo.ts.

import { useRef } from 'react'
import { Bot } from 'lucide-react'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { useDroneStore } from '@/store/drone'
import { CvOverlayCanvas } from '@/components/vision/CvOverlayCanvas'
import { CopilotVideoOverlay } from '@/components/copilot/CopilotVideoOverlay'
import { Recon3DView } from '@/components/vision/Recon3DView'
import { WebCodecsVideo } from '@/components/video/WebCodecsVideo'
import { innerFit } from '@/lib/videoSettings'
import { AspectFrame } from '@/components/video/AspectFrame'
import { useVideoAspect } from '@/components/video/PictureFitMenu'
import { useAirUnitPreview } from '@/lib/airUnitPreview'
import { useGstPreview } from '@/lib/gstPreview'
import { useReceiver, fallbackFromHevc } from '@/lib/hyrakReceiver'
import { useAttachVideo } from '@/hooks/useAttachVideo'
import { useServerFeed } from '@/lib/serverHevcFeed'

/** `onPickModule`: shown as the way out of the empty state while no module
 *  runs (Command opens its AI drawer). */
export function AiView({ onPickModule }: { onPickModule?: () => void } = {}) {
    const { localStream, remoteStream, isStreaming, overlayActive } = useWebRTCContext()
    const mode = useDroneStore(s => s.mode)
    // The shared picture setting (Fill, Source, 16:9, 4:3, 1:1). The video and
    // every overlay sit in one AspectFrame with the same fit, so boxes line up.
    const aspect = useVideoAspect()
    const fit = innerFit(aspect)
    const videoRef = useRef<HTMLVideoElement | null>(null)

    const airUnitPreviewUrl = useAirUnitPreview()
    const gst = useGstPreview()
    const receiver = useReceiver()
    const localPreviewUrl = gst?.previewUrl ?? receiver?.previewUrl ?? airUnitPreviewUrl
    // Server-read air unit (the sim camera too): in overlay modes the picture
    // is the server's bit-exact feed decoded here, exactly like the main
    // video - without it this view was black for every box-drawing mode.
    // The feed hands each viewer its own queue, so a second one is fine.
    const serverFeed = useServerFeed(isStreaming && overlayActive)
    const wcUrl = overlayActive
        ? (gst?.webcodecs ? gst.previewUrl : (receiver?.previewUrl ?? serverFeed?.url ?? null))
        : null
    const wcCodec = gst?.webcodecs ? 'h264' : (receiver?.codec ?? serverFeed?.codec ?? 'h264')

    useAttachVideo(videoRef, {
        wcUrl, overlayActive, localPreviewUrl, localStream, remoteStream,
        forceLiveEdge: !!gst?.previewUrl,
    })

    const objectFit = fit === 'fit' ? 'contain' : 'cover'
    return (
        <div className={isStreaming ? 'absolute inset-0 bg-[#1A2129]' : 'absolute inset-0 bg-app-surface-2'}>
            <AspectFrame aspect={aspect}>
                {wcUrl ? (
                    <WebCodecsVideo src={wcUrl} codec={wcCodec}
                        onDecodeError={wcCodec === 'hevc' ? fallbackFromHevc : undefined}
                        style={{ width: '100%', height: '100%', objectFit }} />
                ) : (
                    <video ref={videoRef} autoPlay playsInline muted
                        style={{ width: '100%', height: '100%', objectFit, display: isStreaming ? 'block' : 'none' }} />
                )}
                {isStreaming && overlayActive && mode !== '3d-reconstruction' && <CvOverlayCanvas fit={fit} />}
                {isStreaming && mode !== '3d-reconstruction' && <CopilotVideoOverlay fit={fit} />}
            </AspectFrame>
            {isStreaming && mode === '3d-reconstruction' && <Recon3DView />}
            {mode === 'manual-control' ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 pt-12 sm:pt-0 sm:pb-[12%] text-center bg-app-surface-2">
                    <span className="max-sm:hidden flex size-12 items-center justify-center rounded-full bg-app-surface text-app-text-muted border border-app-border">
                        <Bot size={22} strokeWidth={1.75} />
                    </span>
                    <p className="text-[14px] font-semibold text-app-text">No AI module running</p>
                    <p className="max-sm:hidden text-[13px] text-app-text-muted max-w-xs">The processed feed shows what a module sees, with its results drawn on.</p>
                    {onPickModule && (
                        <button onClick={onPickModule}
                            className="h-9 px-4 inline-flex items-center gap-1.5 rounded-md text-[13px] font-bold bg-app-accent text-[var(--app-accent-ink)] hover:brightness-110 transition-[filter,transform] duration-[140ms] active:scale-[.98] outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app-bg">
                            <Bot size={15} /> Pick a module
                        </button>
                    )}
                </div>
            ) : !isStreaming && (
                <div className="absolute inset-0 flex items-center justify-center text-[13px] text-app-text-muted">
                    AI view starts with the video
                </div>
            )}
        </div>
    )
}
