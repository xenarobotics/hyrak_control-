'use client'

import {
    createContext, useContext, useState,
    useCallback, useEffect, useRef, type ReactNode
} from 'react'
import { useWebRTC, type WebRTCStats } from '@/hooks/useWebRTC'
import { useCamera } from '@/hooks/useCamera'
import { useDroneStore } from '@/store/drone'
import { getSocket } from '@/lib/socket'
import { getVideoSource, isServerSourced } from '@/lib/videoSource'
import { startRtspCameraStream, stopRtspCameraStream } from '@/lib/rtspCameraStream'

interface WebRTCContextValue {
    remoteStream: MediaStream | null
    localStream: MediaStream | null
    isStreaming: boolean
    overlayActive: boolean
    isLoading: boolean
    /** What a start is currently waiting on, for an honest button label.
     *  'connecting' covers signaling + ICE + the first frame arriving. */
    startPhase: 'idle' | 'connecting' | 'model'
    /** What the connect is currently blocked on, when the server says so. */
    startDetail: string | null
    modelLoading: boolean
    stats: WebRTCStats | null
    lastError: string | null
    cameras: Array<{ deviceId: string; label: string }>
    selectedCameraId: string
    setSelectedCameraId: (id: string) => void
    /** True once a camera scan has run (the list may still be empty). */
    camerasScanned: boolean
    scanCameras: () => Promise<Array<{ deviceId: string; label: string }>>
    startStream: () => Promise<void>
    stopStream: () => void
    /** Renegotiate the peer connection without stopping the local
     *  producers or releasing the relay port - for a session resume. */
    restartStream: () => Promise<void>
    applyVideoSettings: () => Promise<void>
}

const WebRTCContext = createContext<WebRTCContextValue | null>(null)

export function WebRTCProvider({ children }: { children: ReactNode }) {
    const {
        remoteStream, localStream,
        isStreaming, overlayActive, stats, lastError,
        startStream: startWebRTC, stopStream: stopWebRTC,
        restartStream: restartWebRTC,
        applyVideoSettings,
    } = useWebRTC()

    // Failures raised while BUILDING the local RTSP stream happen before any
    // WebRTC offer exists, so useWebRTC's lastError can't carry them.
    const [rtspCameraError, setRtspCameraError] = useState<string | null>(null)

    const {
        cameras, selectedId: selectedCameraId,
        setSelectedId: setSelectedCameraId,
        scan: scanCameras, scanned: camerasScanned,
        startStream: startCamera, stopStream: stopCamera,
    } = useCamera()

    const [isLoading, setIsLoading] = useState(false)
    const [modelLoading, setModelLoading] = useState(false)

    // Signaling finishing is NOT the stream starting.
    //
    // `isLoading` covers only the offer/answer exchange, which resolves in a
    // few hundred ms. `isStreaming` is set much later, from an EVENT -
    // pc.ontrack for a processed feed, oniceconnectionstatechange for an
    // overlay one. Between the two, both flags were false and the button
    // reverted to "Start Analysis": the operator had clicked, something was
    // clearly happening, and the control said nothing was. Then seconds later
    // it jumped to "Stop". It read as a dropped click on a broken app.
    //
    // `pending` spans the whole operation - click until the stream is
    // genuinely live - so the control is never idle while work is in flight.
    const [pending, setPending] = useState(false)

    useEffect(() => {
        if (isStreaming) setPending(false)
    }, [isStreaming])

    useEffect(() => {
        if (lastError) setPending(false)
    }, [lastError])

    // Backstop. The server gives up on an absent uplink after 25s, and a
    // control stuck spinning forever is worse than one that admits defeat -
    // it leaves no way back without a reload.
    useEffect(() => {
        if (!pending) return
        const id = setTimeout(() => setPending(false), 35_000)
        return () => clearTimeout(id)
    }, [pending])

    useEffect(() => {
        const socket = getSocket()
        const handle = (data: { status: string }) => {
            setModelLoading(data.status === 'loading')
        }
        socket.on('model_status', handle)
        return () => { socket.off('model_status', handle) }
    }, [])

    // WHY THE SPINNER IS STILL SPINNING.
    //
    // A server-sourced feed waits up to 25 s for the desktop app to push
    // video, and for that whole time the only thing on screen was the word
    // "Connecting". Twenty-five seconds of that, followed by a failure, reads
    // as the selected ANALYSIS MODE being broken - the mode is simply what the
    // operator was changing when they hit it. The wait is identical for every
    // mode, and the backend knows within a second whether anything is arriving.
    const [progress, setProgress] = useState<string | null>(null)
    useEffect(() => {
        const socket = getSocket()
        const handle = (d: { phase?: string; seconds?: number; detail?: string }) => {
            setProgress(`waiting for video from the relay - ${d.seconds ?? 0}s · ${d.detail ?? ''}`)
        }
        socket.on('stream_progress', handle)
        return () => { socket.off('stream_progress', handle) }
    }, [])
    // Cleared whenever a stream settles either way, so a stale line can never
    // describe an attempt that is already over.
    useEffect(() => { if (isStreaming || lastError) setProgress(null) }, [isStreaming, lastError])

    // One body for start and restart: the only difference is which
    // useWebRTC entry point gets the (possibly null) local stream.
    const runStream = useCallback(async (go: (s: MediaStream | null) => Promise<void>) => {
        if (isLoading || pending) return
        setPending(true)
        // Server-sourced feeds (air-unit UDP, SIYI RTSP): no browser camera
        // involved at all - the backend pulls frames directly.
        const src = getVideoSource()
        if (isServerSourced(src)) {
            setIsLoading(true)
            try {
                await go(null)
            } catch (e) {
                console.error('startStream failed:', e)
                setPending(false)
            } finally {
                setIsLoading(false)
            }
            return
        }
        // RTSP-as-webcam: same downstream path as a real camera, the stream
        // just comes from a local decode instead of getUserMedia.
        if (src === 'rtsp_camera') {
            setIsLoading(true)
            setRtspCameraError(null)
            try {
                const stream = await startRtspCameraStream()
                await go(stream)
            } catch (e) {
                console.error('RTSP camera failed:', e)
                setRtspCameraError((e as Error).message)
                setPending(false)
            } finally {
                setIsLoading(false)
            }
            return
        }
        setIsLoading(true)
        try {
            // No scan yet (the camera list is filled lazily): scan now and take
            // the first device, so the first Start is one click and not two.
            let camId = selectedCameraId
            if (!camId) camId = (await scanCameras())[0]?.deviceId ?? ''
            if (!camId) { setPending(false); return }
            const stream = await startCamera(camId)
            if (stream) {
                await go(stream)
            }
        } catch (e) {
            console.error('startStream failed:', e)
            setPending(false)
        } finally {
            setIsLoading(false)
        }
    }, [selectedCameraId, isLoading, pending, startCamera, scanCameras])

    const startStream = useCallback(() => runStream(startWebRTC), [runStream, startWebRTC])
    const restartStream = useCallback(() => runStream(restartWebRTC), [runStream, restartWebRTC])

    const stopStream = useCallback(() => {
        setPending(false)
        stopWebRTC()
        stopCamera()
        void stopRtspCameraStream()
    }, [stopWebRTC, stopCamera])

    // A RESUMED SESSION KEEPS ITS DRONE LINK BUT NOT ITS VIDEO. The server
    // closes the peer connection the moment the socket drops (media cannot be
    // parked the way a session can), so after a resume the picture would sit
    // frozen until someone pressed restart. Do that for them - but only the
    // peer connection: the local gst/receiver/datachannel processes and the
    // relay port are still fine, and a full stop/start would kill them and
    // come back with a NEW relay port (see useWebRTC.restartStream).
    const streamingRef = useRef(isStreaming)
    useEffect(() => { streamingRef.current = isStreaming }, [isStreaming])
    useEffect(() => {
        let t: ReturnType<typeof setTimeout> | null = null
        const onResumed = () => {
            if (!streamingRef.current) return
            if (t) clearTimeout(t)
            t = setTimeout(() => { t = null; void restartStream() }, 600)
        }
        window.addEventListener('hyrak-session-resumed', onResumed)
        return () => { window.removeEventListener('hyrak-session-resumed', onResumed); if (t) clearTimeout(t) }
    }, [restartStream])

    return (
        <WebRTCContext.Provider value={{
            remoteStream, localStream,
            isStreaming, overlayActive, modelLoading, stats,
            // Consumers asking "is a start in flight?" want the WHOLE
            // operation, not just the signaling leg.
            isLoading: isLoading || pending,
            startPhase: !pending ? 'idle' : modelLoading ? 'model' : 'connecting',
            startDetail: progress,
            lastError: rtspCameraError ?? lastError,
            cameras, selectedCameraId, setSelectedCameraId, camerasScanned, scanCameras,
            startStream, stopStream, restartStream, applyVideoSettings,
        }}>
            {children}
        </WebRTCContext.Provider>
    )
}

export function useWebRTCContext() {
    const ctx = useContext(WebRTCContext)
    if (!ctx) throw new Error('useWebRTCContext must be used inside WebRTCProvider')
    return ctx
}