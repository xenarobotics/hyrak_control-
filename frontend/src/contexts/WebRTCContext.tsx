'use client'

import {
    createContext, useContext, useState,
    useCallback, useEffect, type ReactNode
} from 'react'
import { useWebRTC, type WebRTCStats } from '@/hooks/useWebRTC'
import { useCamera } from '@/hooks/useCamera'
import { useDroneStore } from '@/store/drone'
import { getSocket } from '@/lib/socket'

interface WebRTCContextValue {
    remoteStream: MediaStream | null
    localStream: MediaStream | null
    isStreaming: boolean
    overlayActive: boolean
    isLoading: boolean
    modelLoading: boolean
    stats: WebRTCStats | null
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
        isStreaming, overlayActive, stats,
        startStream: startWebRTC, stopStream: stopWebRTC,
        applyVideoSettings,
    } = useWebRTC()

    const {
        cameras, selectedId: selectedCameraId,
        setSelectedId: setSelectedCameraId,
        scan: scanCameras,
        startStream: startCamera, stopStream: stopCamera,
    } = useCamera()

    const [isLoading, setIsLoading] = useState(false)
    const [modelLoading, setModelLoading] = useState(false)

    useEffect(() => {
        const socket = getSocket()
        const handle = (data: { status: string }) => {
            setModelLoading(data.status === 'loading')
        }
        socket.on('model_status', handle)
        return () => { socket.off('model_status', handle) }
    }, [])

    const startStream = useCallback(async () => {
        if (!selectedCameraId || isLoading) return
        setIsLoading(true)
        try {
            const stream = await startCamera(selectedCameraId)
            if (stream) {
                await startWebRTC(stream)
            }
        } catch (e) {
            console.error('startStream failed:', e)
        } finally {
            setIsLoading(false)
        }
    }, [selectedCameraId, isLoading, startCamera, startWebRTC])

    const stopStream = useCallback(() => {
        stopWebRTC()
        stopCamera()
    }, [stopWebRTC, stopCamera])

    return (
        <WebRTCContext.Provider value={{
            remoteStream, localStream,
            isStreaming, overlayActive, isLoading, modelLoading, stats,
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