'use client'

// Start / stop an AI module from the Command window.
//
// Same mechanism as the AI tab's ModeSelector (useDrone.setMode: the store's
// mode + socket 'set_analysis_mode'), with one difference. The AI tab only
// lets the mode change while the stream is stopped, because the stream's
// transport is decided at start: client-overlay (local picture + boxes drawn
// here) or processed (the server's annotated video). Command switches modules
// mid-flight, so a running stream is restarted around the change - the same
// stop / wait / start the LinkCluster source menus do. Tapping a module while
// the video is off starts the video too: a module without frames does nothing.

import { useCallback, useEffect, useRef } from 'react'
import { useDrone } from '@/hooks/useDrone'
import { useDroneStore } from '@/store/drone'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { getVideoSource, needsCameraSelection } from '@/lib/videoSource'

export function useAiModule() {
    const { setMode } = useDrone()
    const mode = useDroneStore(s => s.mode)
    const setCvResults = useDroneStore(s => s.setCvResults)
    const { isStreaming, startStream, stopStream, selectedCameraId } = useWebRTCContext()

    // One restart at a time: a second tap cancels the first restart instead
    // of racing two offers at a half-torn-down session.
    const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(() => () => { if (restartTimer.current) clearTimeout(restartTimer.current) }, [])

    const apply = useCallback((next: string) => {
        if (next === mode) return
        setMode(next)
        setCvResults(null)
        if (isStreaming) {
            if (restartTimer.current) clearTimeout(restartTimer.current)
            stopStream()
            restartTimer.current = setTimeout(() => { restartTimer.current = null; void startStream() }, 600)
        } else if (next !== 'manual-control'
            && !(needsCameraSelection(getVideoSource()) && !selectedCameraId)) {
            void startStream()
        }
    }, [mode, setMode, setCvResults, isStreaming, stopStream, startStream, selectedCameraId])

    const running = mode !== 'manual-control'
    return {
        mode, running,
        start: apply,
        stop: useCallback(() => apply('manual-control'), [apply]),
        toggle: useCallback((m: string) => apply(m === mode ? 'manual-control' : m), [apply, mode]),
    }
}
