'use client'

import {
    createContext, useContext, useState,
    useCallback, useEffect, type ReactNode
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
    modelLoading: boolean
    stats: WebRTCStats | null
    lastError: string | null
    cameras: Array<{ deviceId: string; label: string }>
    selectedCameraId: string
    setSelectedCameraId: (id: string) => void
    scanCameras: () => void
    startStream: () => Promise<void>
    stopStream: () => void
    applyVideoSettings: () => Promise<void>
}

const WebRTCContext = createContext<WebRTCContextValue | null>(null)

export function WebRTCProvider({ children }: { children: ReactNode }) {
    const {
        remoteStream, localStream,
        isStreaming, overlayActive, stats, lastError,
        startStream: startWebRTC, stopStream: stopWebRTC,
        applyVideoSettings,
    } = useWebRTC()

    // Failures raised while BUILDING the local RTSP stream happen before any
    // WebRTC offer exists, so useWebRTC's lastError can't carry them.
    const [rtspCameraError, setRtspCameraError] = useState<string | null>(null)

    const {
        cameras, selectedId: selectedCameraId,
        setSelectedId: setSelectedCameraId,
        scan: scanCameras,
        startStream: startCamera, stopStream: stopCamera,
    } = useCamera()

    const [isLoading, setIsLoading] = useState(false)
    const [modelLoading, setModelLoading] = useState(false)

    // Signaling finishing is NOT the stream starting.
    //
    // `isLoading` covers only the offer/answer exchange, which resolves in a
    // few hundred ms. `isStreaming` is set much later, from an EVENT —
    // pc.ontrack for a processed feed, oniceconnectionstatechange for an
    // overlay one. Between the two, both flags were false and the button
    // reverted to "Start Analysis": the operator had clicked, something was
    // clearly happening, and the control said nothing was. Then seconds later
    // it jumped to "Stop". It read as a dropped click on a broken app.
    //
    // `pending` spans the whole operation — click until the stream is
    // genuinely live — so the control is never idle while work is in flight.
    const [pending, setPending] = useState(false)

    useEffect(() => {
        if (isStreaming) setPending(false)
    }, [isStreaming])

    useEffect(() => {
        if (lastError) setPending(false)
    }, [lastError])

    // Backstop. The server gives up on an absent uplink after 25s, and a
    // control stuck spinning forever is worse than one that admits defeat —
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

    const startStream = useCallback(async () => {
        if (isLoading || pending) return
        setPending(true)
        // Server-sourced feeds (air-unit UDP, SIYI RTSP): no browser camera
        // involved at all — the backend pulls frames directly.
        const src = getVideoSource()
        if (isServerSourced(src)) {
            setIsLoading(true)
            try {
                await startWebRTC(null)
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
                await startWebRTC(stream)
            } catch (e) {
                console.error('RTSP camera failed:', e)
                setRtspCameraError((e as Error).message)
                setPending(false)
            } finally {
                setIsLoading(false)
            }
            return
        }
        if (!selectedCameraId) { setPending(false); return }
        setIsLoading(true)
        try {
            const stream = await startCamera(selectedCameraId)
            if (stream) {
                await startWebRTC(stream)
            }
        } catch (e) {
            console.error('startStream failed:', e)
            setPending(false)
        } finally {
            setIsLoading(false)
        }
    }, [selectedCameraId, isLoading, pending, startCamera, startWebRTC])

    const stopStream = useCallback(() => {
        setPending(false)
        stopWebRTC()
        stopCamera()
        void stopRtspCameraStream()
    }, [stopWebRTC, stopCamera])

    return (
        <WebRTCContext.Provider value={{
            remoteStream, localStream,
            isStreaming, overlayActive, modelLoading, stats,
            // Consumers asking "is a start in flight?" want the WHOLE
            // operation, not just the signaling leg.
            isLoading: isLoading || pending,
            startPhase: !pending ? 'idle' : modelLoading ? 'model' : 'connecting',
            lastError: rtspCameraError ?? lastError,
            cameras, selectedCameraId, setSelectedCameraId, scanCameras,
            startStream, stopStream, applyVideoSettings,
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