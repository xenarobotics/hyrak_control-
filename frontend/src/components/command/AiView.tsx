'use client'

// The Command window's AI view: what the running AI module sees, the way the
// AI tab shows it - no second stream is opened.
//   client-overlay stream  the local picture (webcam, or the in-app preview of
//                          a server-sourced feed) with the results drawn on it
//                          by CvOverlayCanvas
//   processed stream       the server's annotated video (remoteStream) - depth
//                          and enhance always, and any feed that cannot overlay
//   3D scan                the live reconstruction view
// Mirrors the video-attach logic of app/(platform)/modules/page.tsx; keep the
// two in step.

import { useEffect, useRef, useState } from 'react'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { useDroneStore } from '@/store/drone'
import { CvOverlayCanvas } from '@/components/vision/CvOverlayCanvas'
import { Recon3DView } from '@/components/vision/Recon3DView'
import { WebCodecsVideo } from '@/components/video/WebCodecsVideo'
import { getVideoFit, type VideoFit } from '@/lib/videoSettings'
import { getLiveEdgeClamp } from '@/lib/videoSource'
import { useAirUnitPreview } from '@/lib/airUnitPreview'
import { useGstPreview } from '@/lib/gstPreview'
import { useReceiver, fallbackFromHevc } from '@/lib/hyrakReceiver'
import { clampToLiveEdge } from '@/lib/liveEdge'
import { useServerFeed } from '@/lib/serverHevcFeed'

export function AiView() {
    const { localStream, remoteStream, isStreaming, overlayActive } = useWebRTCContext()
    const mode = useDroneStore(s => s.mode)
    const [fit, setFit] = useState<VideoFit>('fill')
    useEffect(() => { setFit(getVideoFit()) }, [])
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

    useEffect(() => {
        const el = videoRef.current
        if (!el) return
        if (wcUrl) { el.removeAttribute('src'); el.srcObject = null; return }
        if (overlayActive && localPreviewUrl && !localStream) {
            el.srcObject = null
            if (el.src !== localPreviewUrl) el.src = localPreviewUrl
            return (gst?.previewUrl || getLiveEdgeClamp()) ? clampToLiveEdge(el) : undefined
        }
        el.removeAttribute('src')
        el.srcObject = overlayActive ? localStream : remoteStream
    }, [overlayActive, localStream, remoteStream, localPreviewUrl, gst?.previewUrl, wcUrl])

    const objectFit = fit === 'fit' ? 'contain' : 'cover'
    return (
        <div className="absolute inset-0 bg-black">
            {wcUrl ? (
                <WebCodecsVideo src={wcUrl} codec={wcCodec}
                    onDecodeError={wcCodec === 'hevc' ? fallbackFromHevc : undefined}
                    style={{ width: '100%', height: '100%', objectFit }} />
            ) : (
                <video ref={videoRef} autoPlay playsInline muted
                    style={{ width: '100%', height: '100%', objectFit, display: isStreaming ? 'block' : 'none' }} />
            )}
            {isStreaming && overlayActive && mode !== '3d-reconstruction' && <CvOverlayCanvas fit={fit} />}
            {isStreaming && mode === '3d-reconstruction' && <Recon3DView />}
            {!isStreaming && (
                <div className="absolute inset-0 flex items-center justify-center text-[11px] font-mono text-zinc-500">
                    AI view starts with the video
                </div>
            )}
        </div>
    )
}
