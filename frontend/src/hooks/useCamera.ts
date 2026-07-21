'use client'

import { useState, useEffect, useCallback } from 'react'
import { videoConstraints } from '@/lib/videoSettings'

export interface CameraDevice {
    deviceId: string
    label: string
}

export function useCamera() {
    const [cameras, setCameras] = useState<CameraDevice[]>([])
    const [selectedId, setSelectedId] = useState<string>('')
    const [stream, setStream] = useState<MediaStream | null>(null)
    const [permissionGranted, setPermission] = useState<boolean | null>(null)
    const [isLoading, setIsLoading] = useState(false)

    const scan = useCallback(async () => {
        setIsLoading(true)
        try {
            // Request permission first — this populates device labels
            const tempStream = await navigator.mediaDevices.getUserMedia({ video: true })
            setPermission(true)
            tempStream.getTracks().forEach(t => t.stop())

            const devices = await navigator.mediaDevices.enumerateDevices()
            const videoDevices = devices
                .filter(d => d.kind === 'videoinput')
                .map((d, i) => ({
                    deviceId: d.deviceId,
                    label: d.label || `Camera ${i + 1}`,
                }))

            setCameras(videoDevices)

            // Auto-select first if nothing selected yet
            if (videoDevices.length > 0 && !selectedId) {
                setSelectedId(videoDevices[0].deviceId)
            }
        } catch {
            setPermission(false)
        } finally {
            setIsLoading(false)
        }
    }, [selectedId])

    // Scan on mount
    useEffect(() => { scan() }, [])

    const startStream = useCallback(async (deviceId: string) => {
        // Stop existing stream first
        if (stream) {
            stream.getTracks().forEach(t => t.stop())
            setStream(null)
        }
        try {
            // Resolution and frame rate come from the user's video settings
            // (settings page — 480/720/1080, 12–30 fps). The vision pipeline
            // still downscales to 640px wide for inference; capture size only
            // affects what the operator sees.
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: videoConstraints(deviceId),
                audio: false,
            })
            setStream(newStream)
            setSelectedId(deviceId)
            return newStream
        } catch (e) {
            console.error('Camera start failed:', e)
            return null
        }
    }, [stream])

    const stopStream = useCallback(() => {
        if (stream) {
            stream.getTracks().forEach(t => t.stop())
            setStream(null)
        }
    }, [stream])

    return {
        cameras,
        selectedId,
        setSelectedId,
        stream,
        permissionGranted,
        isLoading,
        scan,
        startStream,
        stopStream,
    }
}