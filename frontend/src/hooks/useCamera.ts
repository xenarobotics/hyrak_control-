'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { videoConstraints } from '@/lib/videoSettings'
import { getVideoSource, needsCameraSelection } from '@/lib/videoSource'

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
    // Whether a scan has run at all - lets Start proceed on a fresh page
    // (it scans first) while a scan that found nothing still disables it.
    const [scanned, setScanned] = useState(false)
    const streamRef = useRef<MediaStream | null>(null)

    const scan = useCallback(async (): Promise<CameraDevice[]> => {
        setIsLoading(true)
        try {
            // Request permission first - this populates device labels
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
            if (videoDevices.length > 0) {
                setSelectedId(prev => prev || videoDevices[0].deviceId)
            }
            return videoDevices
        } catch {
            setPermission(false)
            return []
        } finally {
            setScanned(true)
            setIsLoading(false)
        }
    }, [])

    // Scan on mount ONLY for a webcam source. getUserMedia prompts and lights
    // the camera LED, and it ran on every route for every setup - including
    // server-sourced ones with no browser camera in the picture at all. For
    // webcam sources the list is wanted up front so the picker has something
    // to show; everyone else scans on the first Start or the refresh button.
    useEffect(() => {
        if (needsCameraSelection(getVideoSource())) void scan()
    }, [scan])

    const startStream = useCallback(async (deviceId: string) => {
        // Stop existing stream first
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop())
            streamRef.current = null
            setStream(null)
        }
        try {
            // Resolution and frame rate come from the user's video settings
            // (settings page - 480/720/1080, 12-30 fps). The vision pipeline
            // still downscales to 640px wide for inference; capture size only
            // affects what the operator sees.
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: videoConstraints(deviceId),
                audio: false,
            })
            streamRef.current = newStream
            setStream(newStream)
            setSelectedId(deviceId)
            return newStream
        } catch (e) {
            console.error('Camera start failed:', e)
            return null
        }
    }, [])

    const stopStream = useCallback(() => {
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop())
            streamRef.current = null
            setStream(null)
        }
    }, [])

    return {
        cameras,
        selectedId,
        setSelectedId,
        stream,
        permissionGranted,
        isLoading,
        scanned,
        scan,
        startStream,
        stopStream,
    }
}
