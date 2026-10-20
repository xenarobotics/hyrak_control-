'use client'

import { useRef, useEffect, useState, useCallback } from 'react'
import { useDroneStore } from '@/store/drone'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { useScreenWakeLock } from '@/hooks/useScreenWakeLock'
import { getSocket } from '@/lib/socket'
import { panelFor } from '@/components/vision/ModeSelector'
import { CvOverlayCanvas } from '@/components/vision/CvOverlayCanvas'
import { getVideoFit, setVideoFit, type VideoFit } from '@/lib/videoSettings'
import { ModulePerformance } from '@/components/vision/ModulePerformance'
import { RecordingControls } from '@/components/video/RecordingControls'
import {
    VideoOff, Loader, Square,
    ChevronDown, ChevronUp, Maximize, Minimize, Expand, Shrink, Ratio, Crop
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getVideoSource, isServerSourced, needsCameraSelection, specFor, type VideoSource } from '@/lib/videoSource'
import { useAirUnitPreview } from '@/lib/airUnitPreview'
import { useGstPreview } from '@/lib/gstPreview'
import { useReceiver, fallbackFromHevc } from '@/lib/hyrakReceiver'
import { useAttachVideo } from '@/hooks/useAttachVideo'
import { WebCodecsVideo } from '@/components/video/WebCodecsVideo'
import { Recon3DView } from '@/components/vision/Recon3DView'
import { useClientValue } from '@/hooks/useClientValue'
import { useUiMode } from '@/hooks/useUiMode'
import { ViewOnlyFence } from '@/components/layout/ViewOnly'
import { useDrone } from '@/hooks/useDrone'
import { useAiModule } from '@/components/command/useAiModule'
import { ModelLibrary } from '@/components/models/ModelLibrary'
import { AddModelPanel, type AddSource } from '@/components/models/AddModelPanel'
import { ModelDetailPanel } from '@/components/models/ModelDetailPanel'
import { CustomResultsPanel } from '@/components/models/CustomResultsPanel'
import { MapDetectionsControls } from '@/components/mapdetect/MapDetectionsUi'
import { useModelAccess, useModelLibrary, useModeName, type LibraryEntry } from '@/components/models/useModelLibrary'
import { css, Callout, useCmClass } from '@/components/models/ui'
import { customMode, isCustomMode, type CustomModel } from '@/lib/models'

function ResultsPanel() {
    const mode = useDroneStore(s => s.mode)
    if (isCustomMode(mode)) return <CustomResultsPanel mode={mode} />
    return panelFor(mode)
}

/** Why Run could not start the video, with the way out. */
type RunHelp = { title: string; body: string; settings?: boolean } | null

export default function ModulesPage() {
    const {
        remoteStream, localStream,
        isStreaming, overlayActive, isLoading, startPhase, startDetail, modelLoading, lastError,
        cameras, selectedCameraId, setSelectedCameraId, camerasScanned,
        stopStream,
    } = useWebRTCContext()

    // Server-sourced modes (air-unit UDP, SIYI RTSP) have no browser camera
    // at all - the camera dropdown and its "must have one selected" gate on
    // Start don't apply. Starts as 'camera' (matches server-rendered HTML,
    // which has no localStorage to read) and is set for real after mount -
    // reading getVideoSource() straight into the initial state would make
    // the server and client's first render disagree whenever a non-default
    // source is saved, which React flags as a hydration mismatch.
    const videoSource = useClientValue<VideoSource>(getVideoSource, 'camera')
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
    // Performance is a Dev-mode diagnostic; it starts folded.
    const [statsOpen, setStatsOpen] = useState(false)
    const [maximized, setMaximized] = useState(false)
    // Fill (cover) crops a 4:3 / 16:10 camera to fit a 16:9 panel - which
    // hides frame the AI is still analysing. Fit letterboxes instead so the
    // whole sensor is visible. The overlay canvas is handed the same value:
    // if the two disagree, boxes and clicks land in the wrong place.
    const savedFit = useClientValue<VideoFit>(getVideoFit, 'fill')
    const [pickedFit, setVideoFitState] = useState<VideoFit | null>(null)
    const videoFit = pickedFit ?? savedFit
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
    // Shared with the Command window's AI view - one attach rule, not two.
    useAttachVideo(remoteVideoRef, {
        wcUrl, overlayActive, localPreviewUrl, localStream, remoteStream,
        forceLiveEdge: !!gst?.previewUrl,
    })
    // The local preview URL is on src= and the WebCodecs path has no <video>:
    // neither has a MediaStream for the recorder to capture.
    const previewOnSrc = !!wcUrl || (overlayActive && !!localPreviewUrl && !localStream)

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

    const [uiMode] = useUiMode()
    const { root, normal } = useCmClass()
    const { setMode: sendMode } = useDrone()
    const ai = useAiModule()
    const lib = useModelLibrary()
    const access = useModelAccess()
    const modeName = useModeName(mode)
    const [runHelp, setRunHelp] = useState<RunHelp>(null)
    const [addOpen, setAddOpen] = useState(false)
    const [addSource, setAddSource] = useState<AddSource>('recommended')
    const openAdd = useCallback((src: AddSource) => { setAddSource(src); setAddOpen(true) }, [])
    const [detail, setDetail] = useState<{ id: string; open: boolean } | null>(null)
    const [highlight, setHighlight] = useState<string | null>(null)
    const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    // Mark a model of ours in the library for a moment: "this is where it went".
    const spotlight = useCallback((id: string) => {
        setHighlight(`ours:${id}`)
        if (highlightTimer.current) clearTimeout(highlightTimer.current)
        highlightTimer.current = setTimeout(() => setHighlight(null), 2500)
    }, [])
    useEffect(() => () => { if (highlightTimer.current) clearTimeout(highlightTimer.current) }, [])
    const [toast, setToast] = useState<string | null>(null)
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const flash = useCallback((text: string) => {
        setToast(text)
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 4000)
    }, [])
    useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

    // Run = the Command window's path: set the mode, and start (or restart)
    // the video around it. When there is no camera to start, say so and how
    // to fix it instead of pressing on into a silent failure.
    const runMode = useCallback((m: string) => {
        if (needsCamera && cameras.length === 0) {
            setRunHelp({
                title: 'No camera found',
                body: "Plug in a camera and allow camera access, or pick your drone's video as the source in Settings.",
                settings: true,
            })
            return
        }
        if (needsCamera && !selectedCameraId) {
            setRunHelp({ title: 'Choose a camera first', body: 'Pick a camera in the Video list above the picture, then press Run again.', settings: true })
            return
        }
        setRunHelp(null)
        ai.start(m)
    }, [needsCamera, cameras.length, selectedCameraId, ai])
    const onRun = useCallback((e: LibraryEntry) => runMode(e.mode), [runMode])
    const onStop = useCallback(() => {
        stopStream()
        sendMode('manual-control')
        setCvResults(null)
    }, [stopStream, sendMode, setCvResults])
    const running = mode !== 'manual-control' && (isStreaming || isLoading) ? mode : 'manual-control'
    const starting = isLoading && mode !== 'manual-control' ? mode : null

    const detailEntry = detail ? lib.entries.find(e => e.model?.id === detail.id) ?? null : null

    return (
        <div className={cn(root, css.page, normal && 'hy-simple')}>
            <aside className={css.pageAside} aria-label="Model library">
                <ModelLibrary
                    entries={lib.entries}
                    loading={lib.loading}
                    loadError={lib.loadError}
                    onRetryLoad={() => void lib.reload()}
                    runningMode={running}
                    startingMode={starting}
                    canRun={access.canRun}
                    canManage={access.canManage}
                    premiumEnabled={lib.premium.enabled}
                    onRun={onRun}
                    onStop={onStop}
                    onAdd={() => openAdd('recommended')}
                    onBrowse={() => openAdd('all')}
                    onOpen={e => e.model && setDetail({ id: e.model.id, open: true })}
                    highlightKey={highlight}
                />
            </aside>

            <div className={css.pageMain}>
                <div className={cn(css.panel, css.videoBar)}>
                    <span className={css.label}>Video</span>
                    {serverSourced ? (
                        <span className={css.muted} style={{ flex: 1, minWidth: 0 }}>
                            {specFor(videoSource)?.label ?? videoSource} - change it in <a href="/settings" className={css.link}>Settings</a>
                        </span>
                    ) : (
                        <select
                            className={css.input}
                            style={{ flex: 1, minWidth: 0, maxWidth: 320 }}
                            aria-label="Camera"
                            value={selectedCameraId}
                            onChange={e => { setSelectedCameraId(e.target.value); setRunHelp(null) }}
                            disabled={isStreaming}
                        >
                            {cameras.length === 0 && <option value="">{camerasScanned ? 'No cameras found' : 'Looking for cameras...'}</option>}
                            {cameras.map(c => (
                                <option key={c.deviceId} value={c.deviceId}>{c.label}</option>
                            ))}
                        </select>
                    )}
                    <span style={{ flex: serverSourced ? 0 : 1 }} />
                    {isLoading && (
                        <span className={css.muted} role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <Loader size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
                            {startPhase === 'model' ? `Loading ${modeName}` : 'Starting video'}
                        </span>
                    )}
                    {(isStreaming || isLoading) && (
                        <ViewOnlyFence note={false}>
                            <button type="button" className={css.btn} onClick={onStop}>
                                <Square size={13} aria-hidden /> Stop {mode !== 'manual-control' ? modeName : 'video'}
                            </button>
                        </ViewOnlyFence>
                    )}
                </div>

                {runHelp && (
                    <Callout tone="warn" title={runHelp.title}
                        actions={<>
                            {runHelp.settings && <a href="/settings" className={css.btn}>Open video settings</a>}
                            <button type="button" className={css.btn} onClick={() => setRunHelp(null)}>Dismiss</button>
                        </>}>
                        {runHelp.body}
                    </Callout>
                )}

                {/* What the connect is blocked on, so the wait is explained
                    instead of blamed on the model that was picked. */}
                {startDetail && !isStreaming && (
                    <Callout tone="warn">{startDetail}</Callout>
                )}

                <div
                    ref={containerRef}
                    className={cn(
                        'relative overflow-hidden',
                        maximized && !isFullscreen ? 'fixed inset-4 z-50' : ''
                    )}
                    style={{
                        flex: maximized && !isFullscreen ? undefined : 1,
                        borderRadius: 10,
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
                        <div className={css.idle}>
                            <VideoOff size={36} strokeWidth={1.5} aria-hidden />
                            {lastError ? (
                                <>
                                    <strong>The video did not start</strong>
                                    <p className={css.idleErr}>{lastError}</p>
                                    <p>Check the video source above, then press Run again.</p>
                                </>
                            ) : (
                                <>
                                    <strong>No video yet</strong>
                                    <p>Press Run on a model to start it.</p>
                                </>
                            )}
                        </div>
                    )}

                    {/* Model loading overlay */}
                    {isStreaming && modelLoading && (
                        <div className={css.vidScrim} role="status">
                            <Loader size={28} className="animate-spin motion-reduce:animate-none" style={{ color: 'var(--overlay-accent)' }} aria-hidden />
                            <p>Loading {modeName}...</p>
                        </div>
                    )}

                    {/* PiP - raw local feed (redundant when the main view IS the raw feed) */}
                    {isStreaming && localStream && !overlayActive && (
                        <div style={{
                            position: 'absolute', bottom: 44, left: 8,
                            width: 100, borderRadius: 6, overflow: 'hidden',
                            border: '1px solid var(--overlay-border)', aspectRatio: '16/9',
                        }}>
                            <video
                                ref={localVideoRef}
                                autoPlay playsInline muted
                                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                            />
                            <span className={css.vidTag}>RAW</span>
                        </div>
                    )}

                    {/* Bottom bar */}
                    {/* Over the video: fixed dark scrim and light text in
                        every theme (theme ink would vanish on black). */}
                    <div className={css.vidBar}>
                        {previewOnSrc
                            ? <span />
                            : <RecordingControls videoRef={remoteVideoRef} isStreaming={isStreaming} />}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <button type="button" className={css.vidBtn}
                                title={videoFit === 'fit'
                                    ? 'Showing the whole frame (letterboxed). Click to fill the panel.'
                                    : 'Filling the panel - a 4:3 or 16:10 camera is cropped. Click to show the whole frame.'}
                                onClick={() => {
                                    const next: VideoFit = videoFit === 'fit' ? 'fill' : 'fit'
                                    setVideoFitState(next); setVideoFit(next)
                                }}>
                                {videoFit === 'fit' ? <><Ratio size={14} aria-hidden /> Fit</> : <><Crop size={14} aria-hidden /> Fill</>}
                            </button>
                            <button type="button" className={css.vidBtn}
                                aria-label={maximized ? 'Restore video size' : 'Maximize video'}
                                title={maximized ? 'Restore video size' : 'Maximize video'}
                                onClick={() => setMaximized(m => !m)}>
                                {maximized ? <Minimize size={15} aria-hidden /> : <Maximize size={15} aria-hidden />}
                            </button>
                            <button type="button" className={css.vidBtn}
                                aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                                title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                                onClick={handleFullscreen}>
                                {isFullscreen ? <Shrink size={15} aria-hidden /> : <Expand size={15} aria-hidden />}
                            </button>
                        </div>
                    </div>
                </div>

                {/* Performance: a Dev-mode diagnostic. */}
                {uiMode === 'dev' && (
                    <div className={css.panel} style={{ flexShrink: 0, overflow: 'hidden' }}>
                        <button
                            type="button"
                            aria-expanded={statsOpen}
                            onClick={() => setStatsOpen(o => !o)}
                            className={css.perfToggle}
                            style={{ borderBottom: statsOpen ? '1px solid var(--cm-line)' : 'none' }}
                        >
                            <span className={css.label}>Performance</span>
                            {statsOpen ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
                        </button>
                        {statsOpen && (
                            <div style={{ padding: 12 }}>
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
                )}
            </div>

            {mode !== 'manual-control' && (
                <section className={cn(css.panel, css.pageResults)} data-active="true" aria-label="Results">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <h2 className={css.panelTitle}>{modeName}</h2>
                        {cvResults && (
                            <span className={cn(css.chip, css.chipOk)}><span className={css.dot} aria-hidden />Live</span>
                        )}
                    </div>
                    <div style={{ flex: 1, overflow: 'auto', minHeight: 0, minWidth: 0 }}>
                        <ViewOnlyFence note={false}><ResultsPanel /></ViewOnlyFence>
                        {/* Outside the fence: a viewer may still show or hide the
                            detections on their own map. Recording is gated inside. */}
                        <div style={{ marginTop: 12 }}><MapDetectionsControls /></div>
                    </div>
                </section>
            )}

            <AddModelPanel
                open={addOpen}
                onOpenChange={setAddOpen}
                premium={lib.premium}
                canManage={access.canManage}
                workspaceId={access.workspace?.id ?? null}
                workspaceName={access.workspace?.name ?? null}
                initialSource={addSource}
                canRun={access.canRun}
                onSaved={(m: CustomModel) => {
                    void lib.reload()
                    spotlight(m.id)
                    flash(`${m.name} is ready. Press Run to use it.`)
                }}
                onAdded={(m: CustomModel) => {
                    void lib.reload()
                    spotlight(m.id)
                }}
                onRun={m => {
                    spotlight(m.id)
                    runMode(customMode(m.id))
                }}
                onOpenModel={id => setDetail({ id, open: true })}
            />

            {detail && (
                <ModelDetailPanel
                    key={detail.id}
                    modelId={detail.id}
                    open={detail.open}
                    onOpenChange={o => setDetail(d => d && { ...d, open: o })}
                    editable={access.canManage && detailEntry?.group === 'ours'}
                    canPublish={access.canPublish && detailEntry?.group === 'ours'}
                    canRun={access.canRun}
                    running={running === customMode(detail.id)}
                    onRun={m => { setDetail(d => d && { ...d, open: false }); runMode(customMode(m.id)) }}
                    onDeleted={name => {
                        if (mode === customMode(detail.id)) onStop()
                        setDetail(d => d && { ...d, open: false })
                        flash(`Deleted model "${name}".`)
                    }}
                />
            )}

            {toast && <div className={css.toast} role="status">{toast}</div>}
        </div>
    )
}
