'use client'

import { useRef, useEffect, useState, useCallback } from 'react'
import { useDroneStore } from '@/store/drone'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { getSocket } from '@/lib/socket'
import { ModeSelector } from '@/components/vision/ModeSelector'
import { ObjectDetectionPanel } from '@/components/vision/ObjectDetectionPanel'
import { HumanTrackingPanel } from '@/components/vision/HumanTrackingPanel'
import { DepthMappingPanel } from '@/components/vision/DepthMappingPanel'
import { PersonTrackerPanel } from '@/components/vision/PersonTrackerPanel'
import { EnhancePanel } from '@/components/vision/EnhancePanel'
import { CvOverlayCanvas } from '@/components/vision/CvOverlayCanvas'
import { RecordingControls } from '@/components/video/RecordingControls'
import { Button } from '@/components/ui/button'
import {
    Video, VideoOff, Loader,
    ChevronDown, ChevronUp, Maximize, Minimize, Expand, Shrink
} from 'lucide-react'
import { cn } from '@/lib/utils'

function StatRow({ label, value, unit }: {
    label: string; value: string | number; unit?: string
}) {
    return (
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
            <span style={{ fontSize: 11, color: 'hsl(var(--app-text-muted))', fontFamily: 'monospace' }}>
                {label}
            </span>
            <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text))' }}>
                {value}{unit && <span style={{ color: 'hsl(var(--app-text-muted))', marginLeft: 3 }}>{unit}</span>}
            </span>
        </div>
    )
}

function ResultsPanel() {
    const mode = useDroneStore(s => s.mode)
    switch (mode) {
        case 'object-detection': return <ObjectDetectionPanel />
        case 'human-tracking': return <HumanTrackingPanel />
        case 'depth-mapping': return <DepthMappingPanel />
        case 'person-tracking': return <PersonTrackerPanel />
        case 'enhance': return <EnhancePanel />
        default:
            return (
                <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    height: 100, color: 'hsl(var(--app-text-muted))',
                    fontSize: 12, fontFamily: 'monospace', textAlign: 'center',
                }}>
                    Select a vision mode to see results
                </div>
            )
    }
}

export default function ModulesPage() {
    const {
        remoteStream, localStream,
        isStreaming, overlayActive, isLoading, modelLoading, stats,
        cameras, selectedCameraId, setSelectedCameraId,
        startStream, stopStream,
    } = useWebRTCContext()

    const remoteVideoRef = useRef<HTMLVideoElement | null>(null)
    const localVideoRef = useCallback((el: HTMLVideoElement | null) => {
        if (el && localStream) {
            el.srcObject = localStream
        }
    }, [localStream])

    const cvResults = useDroneStore(s => s.cvResults)
    const mode = useDroneStore(s => s.mode)
    const setMode = useDroneStore(s => s.setMode)
    const setCvResults = useDroneStore(s => s.setCvResults)

    // Safety net: if user navigates away via browser back/URL while streaming,
    // stop the analysis and reset mode so fly tab shows clean raw feed.
    const isStreamingRef = useRef(isStreaming)
    const stopStreamRef = useRef(stopStream)
    useEffect(() => { isStreamingRef.current = isStreaming }, [isStreaming])
    useEffect(() => { stopStreamRef.current = stopStream }, [stopStream])
    useEffect(() => {
        return () => {
            if (isStreamingRef.current) {
                stopStreamRef.current()
                getSocket().emit('set_analysis_mode', { mode: 'manual-control' })
                setMode('manual-control')
                setCvResults(null)
            }
        }
    }, []) // eslint-disable-line react-hooks/exhaustive-deps

    const containerRef = useRef<HTMLDivElement | null>(null)
    const [statsOpen, setStatsOpen] = useState(true)
    const [modesOpen, setModesOpen] = useState(true)
    const [maximized, setMaximized] = useState(false)
    const [isFullscreen, setIsFullscreen] = useState(false)

    // Attach streams to video elements. Client-overlay feed shows the
    // LOCAL camera (sharp, zero-latency) with AI results drawn on a
    // canvas; processed feed shows the server-rendered remote stream.
    useEffect(() => {
        if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = overlayActive ? localStream : remoteStream
        }
    }, [overlayActive, localStream, remoteStream])

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

    return (
        <div style={{ display: 'flex', height: '100%', gap: 10, overflow: 'hidden' }}>

            {/* LEFT — mode selector */}
            <div style={{
                width: modesOpen ? 190 : 36, flexShrink: 0,
                transition: 'width 0.2s',
                display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden',
            }}>
                <button
                    onClick={() => setModesOpen(o => !o)}
                    style={{
                        display: 'flex', alignItems: 'center',
                        justifyContent: modesOpen ? 'space-between' : 'center',
                        padding: '7px 10px', borderRadius: 10,
                        background: 'hsl(var(--app-surface))',
                        border: '1px solid hsl(var(--app-border))',
                        cursor: 'pointer', color: 'hsl(var(--app-text-muted))',
                        fontSize: 10, fontFamily: 'monospace', whiteSpace: 'nowrap',
                    }}
                >
                    {modesOpen && <span>AI MODES</span>}
                    {modesOpen ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
                </button>

                {modesOpen && (
                    <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {/* Mode buttons — disabled while streaming */}
                        <div style={{ opacity: isStreaming ? 0.5 : 1, pointerEvents: isStreaming ? 'none' : 'auto' }}>
                            <ModeSelector />
                        </div>

                        {/* Camera selector */}
                        <div style={{ padding: '0 2px' }}>
                            <p style={{
                                fontSize: 10, color: 'hsl(var(--app-text-muted))',
                                fontFamily: 'monospace', marginBottom: 6,
                            }}>
                                CAMERA
                            </p>
                            <select
                                value={selectedCameraId}
                                onChange={e => setSelectedCameraId(e.target.value)}
                                disabled={isStreaming}
                                style={{
                                    width: '100%', padding: '6px 8px', borderRadius: 8,
                                    background: 'hsl(var(--app-surface-2))',
                                    border: '1px solid hsl(var(--app-border))',
                                    color: 'hsl(var(--app-text))',
                                    fontSize: 11, fontFamily: 'monospace',
                                    opacity: isStreaming ? 0.5 : 1,
                                }}
                            >
                                {cameras.length === 0 && <option value="">No cameras found</option>}
                                {cameras.map(c => (
                                    <option key={c.deviceId} value={c.deviceId}>{c.label}</option>
                                ))}
                            </select>
                        </div>

                        {/* Start/Stop */}
                        <div style={{ padding: '0 2px' }}>
                            <Button
                                size="sm"
                                variant={isStreaming ? 'destructive' : 'default'}
                                className="w-full font-mono text-xs gap-2"
                                onClick={isStreaming ? stopStream : startStream}
                                disabled={isLoading || (!selectedCameraId && !isStreaming)}
                            >
                                {isLoading
                                    ? <><Loader size={12} className="animate-spin" /> Starting...</>
                                    : isStreaming
                                        ? <><VideoOff size={12} /> Stop</>
                                        : <><Video size={12} /> Start Analysis</>
                                }
                            </Button>
                        </div>

                        {/* Model loading */}
                        {modelLoading && (
                            <div style={{
                                padding: '6px 10px', borderRadius: 8,
                                background: '#E6F1FB18', border: '1px solid #85B7EB',
                                display: 'flex', alignItems: 'center', gap: 6,
                                fontSize: 10, fontFamily: 'monospace', color: '#60a5fa',
                            }}>
                                <Loader size={10} className="animate-spin" />
                                Loading {mode.replace(/-/g, ' ')}...
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* CENTER — processed video, NO OSD */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
                <div
                    ref={containerRef}
                    className={cn(
                        'relative overflow-hidden',
                        maximized && !isFullscreen ? 'fixed inset-4 z-50' : ''
                    )}
                    style={{
                        flex: maximized && !isFullscreen ? undefined : 1,
                        borderRadius: 12,
                        background: '#000', border: '1px solid hsl(var(--app-border))',
                        minHeight: 0,
                    }}
                >
                    {/* Main video — clean, no OSD */}
                    <video
                        ref={remoteVideoRef}
                        autoPlay playsInline muted
                        style={{
                            width: '100%', height: '100%', objectFit: 'cover',
                            display: isStreaming ? 'block' : 'none',
                        }}
                    />

                    {/* Client-side AI overlay on the raw local feed */}
                    {isStreaming && overlayActive && <CvOverlayCanvas />}

                    {!isStreaming && !isLoading && (
                        <div style={{
                            position: 'absolute', inset: 0,
                            display: 'flex', flexDirection: 'column',
                            alignItems: 'center', justifyContent: 'center', gap: 10,
                            color: 'rgba(255,255,255,0.3)',
                        }}>
                            <VideoOff size={36} strokeWidth={1.5} />
                            <p style={{ fontFamily: 'monospace', fontSize: 12, letterSpacing: 2 }}>NO VIDEO</p>
                        </div>
                    )}

                    {/* Model loading overlay */}
                    {isStreaming && modelLoading && (
                        <div style={{
                            position: 'absolute', inset: 0,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
                        }}>
                            <div style={{
                                display: 'flex', flexDirection: 'column',
                                alignItems: 'center', gap: 10,
                                color: 'white', fontFamily: 'monospace',
                            }}>
                                <Loader size={28} className="animate-spin" style={{ color: '#60a5fa' }} />
                                <p style={{ fontSize: 12 }}>
                                    Loading {mode.replace(/-/g, ' ')}...
                                </p>
                            </div>
                        </div>
                    )}

                    {/* PiP — raw local feed (redundant when the main view IS the raw feed) */}
                    {isStreaming && localStream && !overlayActive && (
                        <div style={{
                            position: 'absolute', bottom: 44, left: 8,
                            width: 100, borderRadius: 6, overflow: 'hidden',
                            border: '1px solid rgba(255,255,255,0.15)', aspectRatio: '16/9',
                        }}>
                            <video
                                ref={localVideoRef}
                                autoPlay playsInline muted
                                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                            />
                            <span style={{
                                position: 'absolute', bottom: 2, left: 3,
                                fontSize: 8, background: 'rgba(0,0,0,0.7)', color: '#fff',
                                padding: '1px 4px', borderRadius: 3, fontFamily: 'monospace',
                            }}>
                                RAW
                            </span>
                        </div>
                    )}

                    {/* Bottom bar */}
                    <div style={{
                        position: 'absolute', bottom: 0, left: 0, right: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '8px 10px',
                        background: 'linear-gradient(to top, rgba(0,0,0,0.7), transparent)',
                    }}>
                        <RecordingControls videoRef={remoteVideoRef} isStreaming={isStreaming} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Button size="sm" variant="outline" className="h-7 w-7 p-0"
                                onClick={() => setMaximized(m => !m)}>
                                {maximized ? <Minimize size={13} /> : <Maximize size={13} />}
                            </Button>
                            <Button size="sm" variant="outline" className="h-7 w-7 p-0"
                                onClick={handleFullscreen}>
                                {isFullscreen ? <Shrink size={13} /> : <Expand size={13} />}
                            </Button>
                        </div>
                    </div>
                </div>

                {/* Stats */}
                <div style={{
                    borderRadius: 10, flexShrink: 0,
                    background: 'hsl(var(--app-surface))',
                    border: '1px solid hsl(var(--app-border))',
                    overflow: 'hidden',
                }}>
                    <button
                        onClick={() => setStatsOpen(o => !o)}
                        style={{
                            width: '100%', display: 'flex', alignItems: 'center',
                            justifyContent: 'space-between', padding: '7px 12px',
                            background: 'none', border: 'none', cursor: 'pointer',
                            color: 'hsl(var(--app-text-muted))', fontSize: 10, fontFamily: 'monospace',
                            borderBottom: statsOpen ? '1px solid hsl(var(--app-border))' : 'none',
                        }}
                    >
                        <span>PERFORMANCE</span>
                        {statsOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </button>
                    {statsOpen && (
                        <div style={{ padding: '8px 12px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 20px' }}>
                            <StatRow label="FPS" value={stats?.inputFps?.toFixed(0) ?? '—'} />
                            <StatRow label="Bitrate" value={stats ? (stats.bitrate / 1e6).toFixed(2) : '—'} unit="Mbps" />
                            <StatRow label="RTT" value={stats?.roundTripTime?.toFixed(1) ?? '—'} unit="ms" />
                            <StatRow label="Jitter" value={stats ? (stats.jitter * 1000).toFixed(1) : '—'} unit="ms" />
                            <StatRow label="Pkt loss" value={stats?.packetLoss?.toFixed(1) ?? '—'} unit="%" />
                            <StatRow label="Inference" value={cvResults?.analysis_time_ms?.toFixed(0) ?? '—'} unit="ms" />
                        </div>
                    )}
                </div>
            </div>

            {/* RIGHT — results */}
            <div style={{
                width: 250, flexShrink: 0,
                borderRadius: 12,
                background: 'hsl(var(--app-surface))',
                border: '1px solid hsl(var(--app-border))',
                padding: '12px 14px',
                display: 'flex', flexDirection: 'column', gap: 10, overflow: 'hidden',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <p style={{
                        fontSize: 10, fontFamily: 'monospace',
                        letterSpacing: '0.08em', textTransform: 'uppercase',
                        color: 'hsl(var(--app-text-muted))',
                    }}>
                        {mode.replace(/-/g, ' ').toUpperCase()}
                    </p>
                    {cvResults && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontFamily: 'monospace', color: '#4ade80' }}>
                            <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#4ade80' }} />
                            LIVE
                        </div>
                    )}
                </div>
                <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
                    <ResultsPanel />
                </div>
            </div>

        </div>
    )
}