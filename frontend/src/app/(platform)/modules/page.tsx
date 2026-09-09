'use client'

import { useRef, useEffect, useState, useCallback } from 'react'
import { useDroneStore } from '@/store/drone'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { useScreenWakeLock } from '@/hooks/useScreenWakeLock'
import { getSocket } from '@/lib/socket'
import { ModeSelector } from '@/components/vision/ModeSelector'
import { ObjectDetectionPanel } from '@/components/vision/ObjectDetectionPanel'
import { HumanTrackingPanel } from '@/components/vision/HumanTrackingPanel'
import { DepthMappingPanel } from '@/components/vision/DepthMappingPanel'
import { PersonTrackerPanel } from '@/components/vision/PersonTrackerPanel'
import { EnhancePanel } from '@/components/vision/EnhancePanel'
import { CrowdManagementPanel } from '@/components/vision/CrowdManagementPanel'
import { TrafficManagementPanel } from '@/components/vision/TrafficManagementPanel'
import { VehiclePlateTrackingPanel } from '@/components/vision/VehiclePlateTrackingPanel'
import { CvOverlayCanvas } from '@/components/vision/CvOverlayCanvas'
import { getVideoFit, setVideoFit, type VideoFit } from '@/lib/videoSettings'
import { ModulePerformance } from '@/components/vision/ModulePerformance'
import { RecordingControls } from '@/components/video/RecordingControls'
import { Button } from '@/components/ui/button'
import {
    Video, VideoOff, Loader,
    ChevronDown, ChevronUp, Maximize, Minimize, Expand, Shrink, Ratio, Crop
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getVideoSource, isServerSourced, needsCameraSelection, getLiveEdgeClamp, type VideoSource } from '@/lib/videoSource'
import { useAirUnitPreview } from '@/lib/airUnitPreview'
import { useGstPreview } from '@/lib/gstPreview'
import { useReceiver, fallbackFromHevc } from '@/lib/hyrakReceiver'
import { clampToLiveEdge } from '@/lib/liveEdge'
import { WebCodecsVideo } from '@/components/video/WebCodecsVideo'
import { Reconstruction3DPanel } from '@/components/vision/Reconstruction3DPanel'
import { Recon3DView } from '@/components/vision/Recon3DView'

const SOURCE_LABELS: Record<string, string> = {
    air_unit_udp: 'Air unit (UDP) - set in Settings',
    siyi_rtsp: 'SIYI (RTSP) - set in Settings',
    rtsp_relay: 'RTSP relay (this machine) - set in Settings',
    rtsp_camera: 'RTSP as camera - set in Settings',
    air_unit_datachannel: 'Air unit (DataChannel) - set in Settings',
    rtsp_datachannel: 'RTSP (DataChannel) - set in Settings',
    air_unit_srt: 'Air unit (SRT relay) - set in Settings',
    air_unit_gst: 'Air unit (GStreamer) - set in Settings',
    hyrak_receiver: 'HYRAK Receiver (ground decoder) - set in Settings',
}

function ResultsPanel() {
    const mode = useDroneStore(s => s.mode)
    switch (mode) {
        case 'object-detection': return <ObjectDetectionPanel />
        case 'human-tracking': return <HumanTrackingPanel />
        case 'depth-mapping': return <DepthMappingPanel />
        case 'person-tracking': return <PersonTrackerPanel />
        case 'enhance': return <EnhancePanel />
        case 'crowd-management': return <CrowdManagementPanel />
        case 'vehicle-plate-tracking': return <VehiclePlateTrackingPanel />
        case 'traffic-management': return <TrafficManagementPanel />
        case '3d-reconstruction': return <Reconstruction3DPanel />
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
        isStreaming, overlayActive, isLoading, startPhase, startDetail, modelLoading, lastError,
        cameras, selectedCameraId, setSelectedCameraId,
        startStream, stopStream,
    } = useWebRTCContext()

    // Server-sourced modes (air-unit UDP, SIYI RTSP) have no browser camera
    // at all - the camera dropdown and its "must have one selected" gate on
    // Start don't apply. Starts as 'camera' (matches server-rendered HTML,
    // which has no localStorage to read) and is set for real after mount -
    // reading getVideoSource() straight into the initial state would make
    // the server and client's first render disagree whenever a non-default
    // source is saved, which React flags as a hydration mismatch.
    const [videoSource, setVideoSource] = useState<VideoSource>('camera')
    useEffect(() => { setVideoSource(getVideoSource()) }, [])
    const serverSourced = isServerSourced(videoSource)
    const needsCamera = needsCameraSelection(videoSource)

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

    // Keep the screen awake while capturing - a slow scan means nobody is
    // touching the display, and its auto-lock stops the camera mid-scan
    // (the ~75 s freeze). Especially load-bearing for 3D reconstruction.
    useScreenWakeLock(isStreaming)

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
    // Fill (cover) crops a 4:3 / 16:10 camera to fit a 16:9 panel - which
    // hides frame the AI is still analysing. Fit letterboxes instead so the
    // whole sensor is visible. The overlay canvas is handed the same value:
    // if the two disagree, boxes and clicks land in the wrong place.
    const [videoFit, setVideoFitState] = useState<VideoFit>('fill')
    useEffect(() => { setVideoFitState(getVideoFit()) }, [])
    const [isFullscreen, setIsFullscreen] = useState(false)

    // Attach streams to video elements. Client-overlay feed shows the
    // LOCAL picture (sharp, zero-latency) with AI results drawn on a
    // canvas; processed feed shows the server-rendered remote stream.
    // "Local picture" is the webcam MediaStream for camera sources, or the
    // air unit's in-app preview (lib/airUnitPreview.ts) - a loopback HTTP
    // URL, so it goes on `src` and srcObject must be cleared, or srcObject
    // wins and the pane stays black.
    const airUnitPreviewUrl = useAirUnitPreview()
    const gst = useGstPreview()
    const receiver = useReceiver()
    const localPreviewUrl = gst?.previewUrl ?? receiver?.previewUrl ?? airUnitPreviewUrl
    // Canvas path - no <video>, no live-edge clamp. The overlay canvas sits on
    // top of it exactly as before, since CvOverlayCanvas positions absolutely
    // and scales by CSS.
    //
    // Gated on overlayActive, NOT merely on the pipeline running. In PROCESSED
    // feed mode the pane must show the server's annotated video (remoteStream),
    // and rendering the local preview instead means the annotated frames - the
    // entire point of that mode - are never displayed at all. Depth-mapping and
    // enhance are always processed, since they transform the frame itself.
    const wcUrl = overlayActive
        ? (gst?.webcodecs ? gst.previewUrl : (receiver?.previewUrl ?? null))
        : null
    // Read from the receiver's status, not assumed: it chooses H.265
    // passthrough or an H.264 transcode per machine, and can change mid-session.
    const wcCodec = gst?.webcodecs ? 'h264' : (receiver?.codec ?? 'h264')
    useEffect(() => {
        const el = remoteVideoRef.current
        if (!el) return
        if (wcUrl) { el.removeAttribute('src'); el.srcObject = null; return }
        if (overlayActive && localPreviewUrl && !localStream) {
            el.srcObject = null
            if (el.src !== localPreviewUrl) el.src = localPreviewUrl
            // Same live-edge drain as the fly tab - a progressive stream in a
            // <video> otherwise settles a few hundred ms behind live.
            // Forced on for the GStreamer preview - see VideoStream.tsx.
            return (gst?.previewUrl || getLiveEdgeClamp()) ? clampToLiveEdge(el) : undefined
        }
        el.removeAttribute('src')
        el.srcObject = overlayActive ? localStream : remoteStream
    }, [overlayActive, localStream, remoteStream, localPreviewUrl, gst?.previewUrl, wcUrl])

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

            {/* LEFT - mode selector */}
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
                        {/* Mode buttons - disabled while streaming */}
                        <div style={{ opacity: isStreaming ? 0.5 : 1, pointerEvents: isStreaming ? 'none' : 'auto' }}>
                            <ModeSelector />
                        </div>

                        {/* Camera selector - not applicable to server-sourced feeds */}
                        {serverSourced ? (
                            <div style={{ padding: '0 2px' }}>
                                <p style={{
                                    fontSize: 10, color: 'hsl(var(--app-text-muted))',
                                    fontFamily: 'monospace', marginBottom: 6,
                                }}>
                                    VIDEO SOURCE
                                </p>
                                <div style={{
                                    padding: '6px 8px', borderRadius: 8, fontSize: 11, fontFamily: 'monospace',
                                    background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                                    color: 'hsl(var(--app-text-muted))',
                                }}>
                                    {SOURCE_LABELS[videoSource]}
                                </div>
                            </div>
                        ) : (
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
                        )}

                        {/* Start/Stop */}
                        <div style={{ padding: '0 2px' }}>
                            <Button
                                size="sm"
                                variant={isStreaming ? 'destructive' : 'default'}
                                className="w-full font-mono text-xs gap-2"
                                onClick={isStreaming ? stopStream : startStream}
                                disabled={isLoading || (needsCamera && !selectedCameraId && !isStreaming)}
                            >
                                {isLoading
                                    ? <><Loader size={12} className="animate-spin" />
                                        {startPhase === 'model' ? 'Loading model...' : 'Connecting...'}</>
                                    : isStreaming
                                        ? <><VideoOff size={12} /> Stop</>
                                        : <><Video size={12} /> Start Analysis</>
                                }
                            </Button>
                        </div>

                        {/* What the connect is blocked on. Without this the
                            operator watches "Connecting" for 25s and learns
                            nothing - and blames whichever mode they picked,
                            because the wait is the same for all of them. */}
                        {startDetail && !isStreaming && (
                            <div style={{
                                padding: '6px 10px', borderRadius: 8,
                                background: 'rgba(251,191,36,0.10)',
                                border: '1px solid rgba(251,191,36,0.35)',
                                fontSize: 10, fontFamily: 'monospace', color: '#fbbf24',
                                lineHeight: 1.5, wordBreak: 'break-word',
                            }}>
                                {startDetail}
                            </div>
                        )}

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

            {/* CENTER - processed video, NO OSD */}
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
                    {/* Main video - clean, no OSD */}
                    {wcUrl ? (
                        <WebCodecsVideo
                            src={wcUrl}
                            codec={wcCodec}
                            onDecodeError={wcCodec === 'hevc' ? fallbackFromHevc : undefined}
                            style={{ width: '100%', height: '100%',
                                     objectFit: videoFit === 'fit' ? 'contain' : 'cover' }}
                        />
                    ) : (
                        <video
                            ref={remoteVideoRef}
                            autoPlay playsInline muted
                            style={{
                                width: '100%', height: '100%',
                                objectFit: videoFit === 'fit' ? 'contain' : 'cover',
                                display: isStreaming ? 'block' : 'none',
                            }}
                        />
                    )}

                    {/* Client-side AI overlay on the raw local feed */}
                    {isStreaming && overlayActive && mode !== '3d-reconstruction' &&
                        <CvOverlayCanvas fit={videoFit} />}

                    {/* 3D SCAN: the map IS the main view - the live point
                        cloud growing over the camera pane, camera in PiP. */}
                    {isStreaming && mode === '3d-reconstruction' && <Recon3DView />}

                    {!isStreaming && !isLoading && (
                        <div style={{
                            position: 'absolute', inset: 0,
                            display: 'flex', flexDirection: 'column',
                            alignItems: 'center', justifyContent: 'center', gap: 10,
                            color: 'rgba(255,255,255,0.3)',
                        }}>
                            <VideoOff size={36} strokeWidth={1.5} />
                            <p style={{ fontFamily: 'monospace', fontSize: 12, letterSpacing: 2 }}>NO VIDEO</p>
                            {lastError && (
                                <p style={{ fontFamily: 'monospace', fontSize: 11, color: '#f87171', textAlign: 'center', maxWidth: 280, padding: '0 12px' }}>{lastError}</p>
                            )}
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

                    {/* PiP - raw local feed (redundant when the main view IS the raw feed) */}
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
                            <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]"
                                title={videoFit === 'fit'
                                    ? 'Showing the whole frame (letterboxed). Click to fill the panel.'
                                    : 'Filling the panel - a 4:3 or 16:10 camera is cropped. Click to show the whole frame.'}
                                onClick={() => {
                                    const next: VideoFit = videoFit === 'fit' ? 'fill' : 'fit'
                                    setVideoFitState(next); setVideoFit(next)
                                }}>
                                {videoFit === 'fit' ? <><Ratio size={12} /> Fit</> : <><Crop size={12} /> Fill</>}
                            </Button>
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
                        <div style={{ padding: '10px 12px' }}>
                            {/* Every row here used to come from pc.getStats(), which
                                reports NOTHING in overlay mode - no video crosses the
                                PeerConnection, so FPS/bitrate/RTT/jitter/loss all sat
                                at zero permanently and looked like a broken feed.
                                ModulePerformance sources each figure from wherever the
                                video actually is. */}
                            <ModulePerformance />
                        </div>
                    )}
                </div>
            </div>

            {/* RIGHT - results */}
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