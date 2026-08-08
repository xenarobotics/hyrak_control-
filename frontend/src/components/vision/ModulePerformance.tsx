'use client'

// Shared performance readout for every AI module.
//
// Replaces the per-panel "{n}ms inference" chip, which was the only figure any
// module showed and was not enough to tell whether the system was healthy.
//
// The reason the old numbers appeared frozen is worth stating, because it is
// not obvious: the panels read WebRTC statistics, and in client-overlay mode
// NO VIDEO CROSSES THE PEERCONNECTION IN EITHER DIRECTION. The pilot's picture
// is local (GStreamer -> WebCodecs), the server pulls its own copy over SRT,
// and the only thing on the socket is detection JSON. So `pc.getStats()` has
// no inbound-rtp and no outbound-rtp to report, every field sits at 0 forever,
// and the readout is describing a transport the video does not use.
//
// So each figure here is sourced from wherever that video actually is, and a
// metric that genuinely does not apply to the active transport says so rather
// than showing a zero that looks like a failure.

import { useEffect, useRef, useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { useGstPreview } from '@/lib/gstPreview'
import { useReceiver } from '@/lib/hyrakReceiver'
import { useMedian, useEasedNumber } from '@/lib/panelSmoothing'
import { getVideoSource, isServerSourced } from '@/lib/videoSource'
import { Activity, Cpu, Gauge, Timer, Wifi } from 'lucide-react'

function Metric({
    icon, label, value, unit, tone = 'normal', title,
}: {
    icon: React.ReactNode
    label: string
    value: string | number
    unit?: string
    tone?: 'normal' | 'warn' | 'muted'
    title?: string
}) {
    const color = tone === 'warn'
        ? '#f59e0b'
        : tone === 'muted'
            ? 'hsl(var(--app-text-muted))'
            : 'hsl(var(--app-text))'
    return (
        <div
            title={title}
            style={{
                display: 'flex', flexDirection: 'column', gap: 2,
                padding: '8px 10px', borderRadius: 8,
                background: 'hsl(var(--app-surface-2))',
                border: '1px solid hsl(var(--app-border))',
                minWidth: 0,
            }}
        >
            <div style={{
                display: 'flex', alignItems: 'center', gap: 4,
                fontSize: 9, letterSpacing: 0.4,
                color: 'hsl(var(--app-text-muted))', textTransform: 'uppercase',
            }}>
                {icon}{label}
            </div>
            <div style={{
                fontFamily: 'var(--font-geist-mono)', fontSize: 15,
                fontWeight: 600, color, whiteSpace: 'nowrap',
                overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
                {value}
                {unit && <span style={{ fontSize: 10, opacity: 0.6 }}> {unit}</span>}
            </div>
        </div>
    )
}

/** Counts frames actually painted locally. This is the pilot's real frame
 *  rate in GStreamer mode and cannot be obtained any other way — the preview
 *  never touches WebRTC. */
function useLocalPaintFps(active: boolean): number {
    const [fps, setFps] = useState(0)
    const frames = useRef(0)

    useEffect(() => {
        if (!active) { setFps(0); return }
        // The WebCodecs renderer bumps this on every paint.
        const w = window as unknown as { __hyrakPaintCount?: number }
        let last = w.__hyrakPaintCount ?? 0
        frames.current = last
        const id = setInterval(() => {
            const now = w.__hyrakPaintCount ?? 0
            setFps(now - last)
            last = now
        }, 1000)
        return () => clearInterval(id)
    }, [active])

    return fps
}

export function ModulePerformance() {
    const cvResults = useDroneStore(s => s.cvResults)
    const { stats, isStreaming, overlayActive } = useWebRTCContext()
    const gst = useGstPreview()
    const receiver = useReceiver()

    const [source, setSource] = useState<string>('camera')
    useEffect(() => { setSource(getVideoSource()) }, [])

    // Either local-preview producer counts: both paint to the same canvas
    // and increment the same __hyrakPaintCount.
    const localPreview = !!gst?.previewUrl || !!receiver?.previewUrl
    const paintFps = useLocalPaintFps(localPreview && (!!gst?.webcodecs || !!receiver?.previewUrl))

    // Inference is noisy frame to frame; a median ignores the occasional
    // outlier instead of letting it drag the readout around.
    const inferenceMs = useMedian(cvResults?.analysis_time_ms ?? 0)
    const pipelineMs = useMedian(cvResults?.pipeline_ms ?? 0)
    const deliveredFps = useEasedNumber(cvResults?.delivered_fps ?? 0, 300, false)
    const sourceFps = useEasedNumber(cvResults?.source_fps ?? 0, 300, false)

    if (!isStreaming) {
        return (
            <div style={{
                padding: '10px 12px', borderRadius: 8,
                background: 'hsl(var(--app-surface-2))',
                border: '1px dashed hsl(var(--app-border))',
                fontSize: 11, fontFamily: 'monospace',
                color: 'hsl(var(--app-text-muted))',
            }}>
                Start analysis to see performance
            </div>
        )
    }

    // The server is keeping up when it forwards roughly what arrives. A
    // sustained gap means it is shedding backlog to hold the live edge.
    const keepingUp = sourceFps <= 0 || deliveredFps >= sourceFps * 0.75
    // Only meaningful when WebRTC is actually carrying video. In overlay mode
    // it is not, and reporting 0 kbps would read as a fault.
    const webrtcCarriesVideo = !overlayActive

    return (
        <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))',
            gap: 6,
        }}>
            <Metric
                icon={<Cpu size={10} />} label="Inference"
                value={inferenceMs > 0 ? inferenceMs.toFixed(0) : '—'} unit="ms"
                title="Model time per frame on the server (median). Excludes transport and encode."
            />
            <Metric
                icon={<Activity size={10} />} label="Analysed"
                value={deliveredFps > 0 ? deliveredFps.toFixed(1) : '—'} unit="fps"
                tone={keepingUp ? 'normal' : 'warn'}
                title={sourceFps > 0
                    ? `Server is analysing ${deliveredFps.toFixed(1)} of ${sourceFps.toFixed(1)} fps arriving.`
                    : 'Frames per second the server analysed and forwarded.'}
            />
            <Metric
                icon={<Gauge size={10} />} label="Source"
                value={sourceFps > 0 ? sourceFps.toFixed(1) : '—'} unit="fps"
                tone={keepingUp ? 'muted' : 'warn'}
                title="Frames per second arriving at the server. A gap versus Analysed means backlog is being shed to hold the live edge."
            />
            <Metric
                icon={<Timer size={10} />} label="Pipeline"
                value={pipelineMs > 0 ? pipelineMs.toFixed(1) : '—'} unit="ms"
                title="Server per-frame cost: colour conversion, overlay compose and snapshot. Excludes waiting for a frame."
            />

            {localPreview && (
                <Metric
                    icon={<Activity size={10} />} label="Preview"
                    value={paintFps > 0 ? paintFps : '—'} unit="fps"
                    title={`Frames painted locally per second (${gst?.accel ?? 'local'} decode). This is the picture you are watching — it never round-trips to the server.`}
                />
            )}
            {gst?.accel && (
                <Metric
                    icon={<Cpu size={10} />} label="Decode"
                    value={gst.accel === 'hardware' ? 'GPU' : 'CPU'}
                    tone={gst.accel === 'hardware' ? 'normal' : 'warn'}
                    title={gst.accel === 'hardware'
                        ? 'Hardware decode/encode via VAAPI.'
                        : 'Software fallback — hardware was unavailable or failed twice, which costs roughly ten times the CPU.'}
                />
            )}
            {/* The receiver picks its path per machine and can step down
                mid-session, so the label reports the live plan rather than a
                setting. `why` carries the full sentence for support. */}
            {receiver?.accel && (
                <Metric
                    icon={<Cpu size={10} />} label="Decode"
                    value={receiver.transcode === false
                        ? 'GPU'
                        : (receiver.accel === 'hardware' ? 'GPU*' : 'CPU')}
                    tone={receiver.transcode === false || receiver.accel === 'hardware' ? 'normal' : 'warn'}
                    title={receiver.why
                        ?? 'The decode path the HYRAK Receiver settled on for this machine.'}
                />
            )}

            {webrtcCarriesVideo ? (
                <>
                    <Metric
                        icon={<Wifi size={10} />} label="Link"
                        value={stats?.roundTripTime ? stats.roundTripTime.toFixed(0) : '—'} unit="ms rtt"
                        title="WebRTC round-trip time to the server."
                    />
                    <Metric
                        icon={<Gauge size={10} />} label="Bitrate"
                        value={stats?.bitrate ? (stats.bitrate / 1e6).toFixed(1) : '—'} unit="Mbps"
                        title="Video bitrate on the WebRTC downlink."
                    />
                </>
            ) : (
                <Metric
                    icon={<Wifi size={10} />} label="Downlink"
                    value="none" tone="muted"
                    title="Overlay mode: the video never crosses WebRTC. Your picture is decoded locally and only detection results come back from the server — so there is no downlink bitrate or RTT to report."
                />
            )}

            {isServerSourced(source as never) && !localPreview && (
                <Metric
                    icon={<Activity size={10} />} label="Transport"
                    value={source.replace(/_/g, ' ')} tone="muted"
                    title="Active video transport."
                />
            )}
        </div>
    )
}
