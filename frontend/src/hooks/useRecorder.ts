'use client'

import { useRef, useState, useCallback } from 'react'

export type RecordingState = 'idle' | 'recording' | 'paused'

export function useRecorder(videoRef: React.RefObject<HTMLVideoElement | null>) {
    const mediaRecorderRef = useRef<MediaRecorder | null>(null)
    const chunksRef = useRef<Blob[]>([])
    const startTimeRef = useRef<number>(0)
    const [state, setState] = useState<RecordingState>('idle')
    const [elapsed, setElapsed] = useState(0)
    const intervalRef = useRef<NodeJS.Timeout | null>(null)

    const start = useCallback(() => {
        const video = videoRef.current
        if (!video || !video.srcObject) return

        const stream = video.srcObject as MediaStream
        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
            ? 'video/webm;codecs=vp9'
            : 'video/webm'

        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 })
        chunksRef.current = []

        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunksRef.current.push(e.data)
        }

        recorder.onstop = () => {
            const blob = new Blob(chunksRef.current, { type: mimeType })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
            a.href = url
            a.download = `verocore-${ts}.webm`
            a.click()
            URL.revokeObjectURL(url)
            setState('idle')
            setElapsed(0)
            if (intervalRef.current) clearInterval(intervalRef.current)
        }

        recorder.start(1000) // collect chunks every 1s
        mediaRecorderRef.current = recorder
        startTimeRef.current = Date.now()
        setState('recording')

        intervalRef.current = setInterval(() => {
            setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000))
        }, 1000)
    }, [videoRef])

    const pause = useCallback(() => {
        if (mediaRecorderRef.current?.state === 'recording') {
            mediaRecorderRef.current.pause()
            setState('paused')
            if (intervalRef.current) clearInterval(intervalRef.current)
        }
    }, [])

    const resume = useCallback(() => {
        if (mediaRecorderRef.current?.state === 'paused') {
            mediaRecorderRef.current.resume()
            setState('recording')
            const pausedElapsed = elapsed
            startTimeRef.current = Date.now() - pausedElapsed * 1000
            intervalRef.current = setInterval(() => {
                setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000))
            }, 1000)
        }
    }, [elapsed])

    const stop = useCallback(() => {
        mediaRecorderRef.current?.stop()
        if (intervalRef.current) clearInterval(intervalRef.current)
    }, [])

    const snapshot = useCallback(() => {
        const video = videoRef.current
        if (!video) return
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        canvas.getContext('2d')?.drawImage(video, 0, 0)
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const a = document.createElement('a')
        a.href = canvas.toDataURL('image/png')
        a.download = `verocore-snap-${ts}.png`
        a.click()
    }, [videoRef])

    const formatElapsed = (s: number) => {
        const m = Math.floor(s / 60).toString().padStart(2, '0')
        const sec = (s % 60).toString().padStart(2, '0')
        return `${m}:${sec}`
    }

    return { state, elapsed, formatElapsed, start, pause, resume, stop, snapshot }
}