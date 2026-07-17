'use client'

import { useState, useEffect, useCallback } from 'react'

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
            // 720p is plenty: the vision pipeline downscales to 640px wide for
            // inference anyway, and 1080p capture noticeably slows down camera
            // init (the "Start Analysis" delay) plus encode/decode CPU load
            // throughout the WebRTC round trip.
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
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