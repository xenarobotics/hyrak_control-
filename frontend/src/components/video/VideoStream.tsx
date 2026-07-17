'use client'

import { useRef, useState, useEffect, useCallback } from 'react'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { useDroneStore } from '@/store/drone'
import { VideoOSD } from '@/components/osd/VideoOSD'
import { RecordingControls } from './RecordingControls'
import { Button } from '@/components/ui/button'
import { Video, VideoOff, Maximize, Minimize, Expand, Shrink, Loader } from 'lucide-react'
import { cn } from '@/lib/utils'

type AspectRatio = 'fill' | '16:9' | '4:3' | '1:1'

export function VideoStream() {
    const {
        remoteStream, localStream,
        isStreaming, isLoading, stats,
        selectedCameraId, startStream, stopStream,
    } = useWebRTCContext()

    const mode = useDroneStore(s => s.mode)
    // manual-control has nothing to process — bypassing the backend WebRTC
    // round-trip (browser encode -> backend software decode/encode -> browser
    // decode) and rendering the local getUserMedia stream directly removes
    // both software transcode hops, which is what was causing the jitter
    // vs. a native camera app. AI modes still need the processed remote feed.
    const isRaw = mode === 'manual-control'

    const mainVideoRef = useRef<HTMLVideoElement | null>(null)
    const localVideoRef = useCallback((el: HTMLVideoElement | null) => {
        if (el && localStream) {
            el.srcObject = localStream
        }
    }, [localStream])
    const containerRef = useRef<HTMLDivElement | null>(null)
    const [maximized, setMaximized] = useState(false)
    const [isFullscreen, setIsFullscreen] = useState(false)
    const [aspectRatio, setAspectRatio] = useState<AspectRatio>('fill')

    // Attach whichever stream should currently be visible to the main video element
    useEffect(() => {
        if (mainVideoRef.current) {
            mainVideoRef.current.srcObject = isRaw ? localStream : remoteStream
        }
    }, [isRaw, localStream, remoteStream])

    useEffect(() => {
        const handler = () => setIsFullscreen(!!document.fullscreenElement)
        document.addEventListener('fullscreenchange', handler)
        return () => document.removeEventListener('fullscreenchange', handler)
    }, [])

    const handleFullscreen = useCallback(async () => {
        if (!document.fullscreenElement) {
            await containerRef.current?.requestFullscreen()
        } else {
            await document.exitFullscreen()
        }
    }, [])

    const videoStyle: React.CSSProperties = aspectRatio !== 'fill'
        ? { aspectRatio: aspectRatio.replace(':', '/'), maxHeight: '100%', maxWidth: '100%' }
        : {}

    return (
        <div
            ref={containerRef}
            className={cn(
                'relative flex flex-col rounded-xl border overflow-hidden transition-all',
                maximized && !isFullscreen ? 'fixed inset-4 z-50' : 'flex-1'
            )}
            style={{ background: '#000', borderColor: 'hsl(var(--app-border))' }}
        >
            {/* Main video — raw local feed when no AI mode is active, processed remote feed otherwise */}
            <video
                ref={mainVideoRef}
                autoPlay playsInline muted
                className={cn(
                    aspectRatio === 'fill' ? 'w-full h-full object-cover' : 'h-full object-contain mx-auto',
                    !isStreaming && 'hidden'
                )}
                style={videoStyle}
            />

            {/* Offline state */}
            {!isStreaming && (
                <div className="flex-1 flex flex-col items-center justify-center gap-3"
                    style={{ color: 'rgba(255,255,255,0.3)' }}
                >
                    <VideoOff size={40} strokeWidth={1.5} />
                    <p className="font-mono text-sm tracking-wider">VIDEO OFFLINE</p>
                    {!selectedCameraId && (
                        <p className="text-xs opacity-50">Select a camera in Devices panel</p>
                    )}
                </div>
            )}

            {/* OSD overlay — fly tab only */}
            {isStreaming && <VideoOSD stats={stats} />}

            {/* PiP local feed — only useful as a comparison while viewing the AI-processed remote feed */}
            {isStreaming && localStream && !isRaw && (
                <div className="absolute bottom-12 left-3 w-28 rounded-lg overflow-hidden border"
                    style={{ borderColor: 'rgba(255,255,255,0.15)', aspectRatio: '16/9' }}
                >
                    <video
                        ref={localVideoRef}
                        autoPlay playsInline muted
                        className="w-full h-full object-cover"
                    />
                    <div className="absolute bottom-1 left-1 text-[9px] font-mono px-1 rounded"
                        style={{ background: 'rgba(0,0,0,0.6)', color: '#fff' }}>
                        LOCAL
                    </div>
                </div>
            )}

            {/* Controls */}
            <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between px-3 py-2"
                style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.7), transparent)' }}
            >
                <RecordingControls videoRef={mainVideoRef} isStreaming={isStreaming} />
                <div className="flex items-center gap-1.5">
                    {isStreaming && (
                        <div className="flex gap-1">
                            {(['fill', '16:9', '4:3', '1:1'] as const).map(r => (
                                <button key={r} onClick={() => setAspectRatio(r)}
                                    className="px-2 py-1 rounded text-[10px] font-mono"
                                    style={{
                                        background: aspectRatio === r ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.5)',
                                        border: `1px solid ${aspectRatio === r ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.1)'}`,
                                        color: aspectRatio === r ? 'white' : 'rgba(255,255,255,0.5)',
                                    }}
                                >
                                    {r}
                                </button>
                            ))}
                        </div>
                    )}
                    <Button size="sm"
                        variant={isStreaming ? 'destructive' : 'default'}
                        className="font-mono text-xs gap-1.5 shadow-lg"
                        onClick={isStreaming ? stopStream : startStream}
                        disabled={isLoading || (!selectedCameraId && !isStreaming)}
                    >
                        {isLoading
                            ? <><Loader size={12} className="animate-spin" /> Starting...</>
                            : isStreaming
                                ? <><VideoOff size={12} /> Stop</>
                                : <><Video size={12} /> Start</>
                        }
                    </Button>
                    <Button size="sm" variant="outline" className="shadow-lg" onClick={() => setMaximized(m => !m)}>
                        {maximized ? <Minimize size={14} /> : <Maximize size={14} />}
                    </Button>
                    <Button size="sm" variant="outline" className="shadow-lg" onClick={handleFullscreen}>
                        {isFullscreen ? <Shrink size={14} /> : <Expand size={14} />}
                    </Button>
                </div>
            </div>
        </div>
    )
}