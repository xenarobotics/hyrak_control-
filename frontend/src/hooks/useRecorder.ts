'use client'

import { useRef, useState, useCallback, useEffect } from 'react'

export type RecordingState = 'idle' | 'recording' | 'paused'

function saveBlobUrl(url: string, filename: string) {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    // Safari ignores a click on an anchor that is not in the document.
    document.body.appendChild(a)
    a.click()
    a.remove()
}

function stamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

/** Record and snapshot the picture in a <video> whose srcObject is a
 *  MediaStream. Hosts hide the controls when the picture is elsewhere (a
 *  WebCodecs canvas, or a src= preview URL) - those have no stream to
 *  capture and used to record black or nothing. */
export function useRecorder(videoRef: React.RefObject<HTMLVideoElement | null>) {
    const mediaRecorderRef = useRef<MediaRecorder | null>(null)
    const chunksRef = useRef<Blob[]>([])
    const startTimeRef = useRef<number>(0)
    const [state, setState] = useState<RecordingState>('idle')
    const [elapsed, setElapsed] = useState(0)
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

    const stopTicking = useCallback(() => {
        if (intervalRef.current) {
            clearInterval(intervalRef.current)
            intervalRef.current = null
        }
    }, [])

    const startTicking = useCallback(() => {
        stopTicking()
        intervalRef.current = setInterval(() => {
            setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000))
        }, 1000)
    }, [stopTicking])

    // Unmounting mid-recording (navigating away) must not leave the ticker
    // or the recorder running against a detached element.
    useEffect(() => () => {
        stopTicking()
        const r = mediaRecorderRef.current
        if (r && r.state !== 'inactive') { try { r.stop() } catch { /* already gone */ } }
    }, [stopTicking])

    const start = useCallback(() => {
        const video = videoRef.current
        const stream = video?.srcObject
        if (!(stream instanceof MediaStream) || stream.getVideoTracks().length === 0) return

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
            saveBlobUrl(url, `hyrak-${stamp()}.webm`)
            // Revoking synchronously can cancel the download in some browsers.
            setTimeout(() => URL.revokeObjectURL(url), 10_000)
            setState('idle')
            setElapsed(0)
            stopTicking()
        }

        recorder.start(1000) // collect chunks every 1s
        mediaRecorderRef.current = recorder
        startTimeRef.current = Date.now()
        setState('recording')
        startTicking()
    }, [videoRef, startTicking, stopTicking])

    const pause = useCallback(() => {
        if (mediaRecorderRef.current?.state === 'recording') {
            mediaRecorderRef.current.pause()
            setState('paused')
            stopTicking()
        }
    }, [stopTicking])

    const resume = useCallback(() => {
        if (mediaRecorderRef.current?.state === 'paused') {
            mediaRecorderRef.current.resume()
            setState('recording')
            startTimeRef.current = Date.now() - elapsed * 1000
            startTicking()
        }
    }, [elapsed, startTicking])

    const stop = useCallback(() => {
        mediaRecorderRef.current?.stop()
        stopTicking()
    }, [stopTicking])

    const snapshot = useCallback(() => {
        const video = videoRef.current
        if (!video || !video.videoWidth) return
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        canvas.getContext('2d')?.drawImage(video, 0, 0)
        saveBlobUrl(canvas.toDataURL('image/png'), `hyrak-snap-${stamp()}.png`)
    }, [videoRef])

    const formatElapsed = (s: number) => {
        const m = Math.floor(s / 60).toString().padStart(2, '0')
        const sec = (s % 60).toString().padStart(2, '0')
        return `${m}:${sec}`
    }

    return { state, elapsed, formatElapsed, start, pause, resume, stop, snapshot }
}
