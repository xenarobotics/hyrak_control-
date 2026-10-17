'use client'

// Which picture goes on the <video>, in one place. The AI tab and the Command
// window's AI view both show "what the running module sees" and used to carry
// the same twelve lines each, with a comment asking to keep them in step.
//
//   wcUrl set            the picture is on a WebCodecs canvas: detach the
//                        <video> entirely
//   local preview URL    a loopback HTTP stream from the gst/receiver/air-unit
//                        preview - goes on src=, and srcObject must be cleared
//                        or it wins and the pane stays black; drained to the
//                        live edge, since a progressive stream in a <video>
//                        otherwise settles a few hundred ms behind
//   otherwise            the local webcam MediaStream (overlay) or the server's
//                        annotated stream (processed)

import { useEffect, type RefObject } from 'react'
import { getLiveEdgeClamp } from '@/lib/videoSource'
import { clampToLiveEdge } from '@/lib/liveEdge'

export interface AttachVideoSources {
    wcUrl: string | null | undefined
    overlayActive: boolean
    localPreviewUrl: string | null | undefined
    localStream: MediaStream | null
    remoteStream: MediaStream | null
    /** Clamp regardless of the setting - the GStreamer preview exists to be
     *  low latency and a stale localStorage flag must not disable the only
     *  thing keeping it live (see VideoStream.tsx). */
    forceLiveEdge?: boolean
}

export function useAttachVideo(
    videoRef: RefObject<HTMLVideoElement | null>,
    { wcUrl, overlayActive, localPreviewUrl, localStream, remoteStream, forceLiveEdge = false }: AttachVideoSources,
) {
    useEffect(() => {
        const el = videoRef.current
        if (!el) return
        if (wcUrl) { el.removeAttribute('src'); el.srcObject = null; return }
        if (overlayActive && localPreviewUrl && !localStream) {
            el.srcObject = null
            if (el.src !== localPreviewUrl) el.src = localPreviewUrl
            return (forceLiveEdge || getLiveEdgeClamp()) ? clampToLiveEdge(el) : undefined
        }
        el.removeAttribute('src')
        el.srcObject = overlayActive ? localStream : remoteStream
    }, [videoRef, overlayActive, localStream, remoteStream, localPreviewUrl, forceLiveEdge, wcUrl])
}
