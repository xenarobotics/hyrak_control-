'use client'

// Paints the air-unit preview with WebCodecs instead of a <video> element.
//
// Why this exists: a <video> playing a progressive fMP4 stream buffers on
// Chromium's schedule and offers no way to say "don't". Every latency
// mechanism we built downstream of it — the live-edge controller,
// playbackRate draining, the adaptive drift target — existed to fight that
// buffer, and measurement showed the fight was unwinnable AND self-defeating:
// the producer was provably smooth (p50 50ms, p99 58ms at 20fps) while the
// browser's drift swung 128-444ms and periodically spiked past 3s, because a
// controller that plays faster than the source necessarily starves the buffer
// and stalls.
//
// WebCodecs deletes the buffer rather than managing it. Each access unit
// arrives framed from the bridge, becomes an EncodedVideoChunk, decodes, and
// is painted immediately. There is no queue that can grow, so latency stops
// being a control problem and becomes a fixed cost: decode + one paint.
//
// Wire format (desktop/src/bridges/gstreamerBridge.ts, frameAu):
//   [uint32 length][uint8 keyframe][uint32 sequence][Annex-B access unit]

import { useEffect, useRef, useState } from 'react'
import { codecString } from '@/lib/codecString'

const HEADER_BYTES = 9

export interface WebCodecsVideoProps {
    /** Loopback URL serving framed access units. */
    src: string
    /** Which codec those access units carry. Comes from the BRIDGE's status
     *  meta, never from what the caller asked for: the HYRAK Receiver picks
     *  H.265 passthrough or an H.264 transcode based on what this machine
     *  turned out to support, and can step down mid-session. Configuring the
     *  wrong one produces a black pane with no error at all. */
    codec?: 'h264' | 'hevc'
    className?: string
    style?: React.CSSProperties
    /** Reported once decoding starts, for diagnostics. */
    onStatus?: (s: { codec: string; hardware?: boolean }) => void
    /** The decoder FAILED, as opposed to never having been offered. Lets the
     *  caller fall back to a codec this machine can actually handle — see
     *  fallbackFromHevc in lib/hyrakReceiver.ts for why a support query is not
     *  enough on its own. */
    onDecodeError?: (reason: string) => void
}

export function WebCodecsVideo({ src, codec: wireCodec = 'h264', className, style, onStatus, onDecodeError }: WebCodecsVideoProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        if (typeof window === 'undefined' || !('VideoDecoder' in window)) {
            setError('This build of Chromium has no WebCodecs — falling back is handled by the caller.')
            return
        }

        const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
        let decoder: VideoDecoder | null = null
        let cancelled = false
        const abort = new AbortController()

        // Chromium can advertise a decoder it cannot actually run — measured
        // on the reference laptop, where enabling VA-API produced exactly one
        // decoded frame out of 180 and then "Decoding error". So a failure is
        // not necessarily fatal: rebuild once in software before giving up.
        // This is ADR-005's rule (attempt, then degrade, never fail outright)
        // applied to the browser's decoder rather than ffmpeg's.
        let accel: HardwareAcceleration = 'no-preference'
        let softwareRetried = false
        let needsRebuild = false

        // Only ONE frame is ever held. If a frame is still being painted when
        // the next decodes, the older is dropped — the newest picture is the
        // only one a pilot wants, and queueing is precisely the behaviour this
        // component exists to avoid.
        let pending: VideoFrame | null = null
        let painting = false
        const paint = () => {
            if (painting || !pending || !ctx) return
            painting = true
            const frame = pending
            pending = null
            if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                canvas.width = frame.displayWidth
                canvas.height = frame.displayHeight
            }
            ctx.drawImage(frame, 0, 0)
            // Painted-frame counter for ModulePerformance. This is the only
            // way to know the pilot's real frame rate in GStreamer mode — the
            // preview never crosses WebRTC, so pc.getStats() cannot see it.
            // A plain counter on window rather than state: incrementing React
            // state 30x/second would re-render the video pane for a number
            // that is only sampled once a second.
            const w = window as unknown as { __hyrakPaintCount?: number }
            w.__hyrakPaintCount = (w.__hyrakPaintCount ?? 0) + 1
            frame.close()
            painting = false
            if (pending) paint()
        }

        ;(async () => {
            try {
                const res = await fetch(src, { signal: abort.signal, cache: 'no-store' })
                if (!res.body) throw new Error('preview stream has no body')
                const reader = res.body.getReader()
                let buf = new Uint8Array(0)
                let configured = false

                while (!cancelled) {
                    const { done, value } = await reader.read()
                    if (done) break
                    if (!value) continue
                    const next = new Uint8Array(buf.length + value.length)
                    next.set(buf); next.set(value, buf.length)
                    buf = next

                    for (;;) {
                        if (buf.length < HEADER_BYTES) break
                        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
                        const len = dv.getUint32(0)
                        if (buf.length < HEADER_BYTES + len) break
                        const key = dv.getUint8(4) === 1
                        const seq = dv.getUint32(5)
                        const au = buf.slice(HEADER_BYTES, HEADER_BYTES + len)
                        buf = buf.slice(HEADER_BYTES + len)

                        // A decoder that errored is torn down and rebuilt at
                        // the next keyframe — mid-GOP frames reference pictures
                        // the new decoder never saw.
                        if (needsRebuild) {
                            needsRebuild = false
                            configured = false
                            try { decoder?.close() } catch { /* already closed */ }
                            decoder = null
                        }

                        if (!configured) {
                            // Nothing can be decoded before a keyframe, and a
                            // decoder fed a delta frame first errors out
                            // rather than waiting.
                            if (!key) continue
                            const codec = codecString(au, wireCodec)
                            if (!codec) continue
                            decoder = new VideoDecoder({
                                output: (frame) => {
                                    if (pending) pending.close()   // newest wins
                                    pending = frame
                                    paint()
                                },
                                error: (e) => {
                                    if (!softwareRetried) {
                                        // Retry in software from the next
                                        // keyframe. Nothing is reported to the
                                        // caller yet — a fallback that works is
                                        // not an error worth surfacing.
                                        softwareRetried = true
                                        accel = 'prefer-software'
                                        needsRebuild = true
                                        console.warn('[webcodecs] hardware decode failed, '
                                            + `retrying in software: ${e.message}`)
                                        return
                                    }
                                    setError(`decoder: ${e.message}`)
                                    onDecodeError?.(e.message)
                                },
                            })
                            try {
                                decoder.configure({
                                    codec,
                                    // H.265 reaches this component only when
                                    // the platform decoder claimed it, so
                                    // asking for hardware states intent rather
                                    // than gambling. Chromium falls back on its
                                    // own if it has to.
                                    hardwareAcceleration: accel,
                                    // The single most important flag here:
                                    // tells Chromium not to build a
                                    // reordering/lookahead queue. Without it
                                    // the decoder introduces exactly the
                                    // latency this component removes.
                                    optimizeForLatency: true,
                                })
                            } catch (e) {
                                // configure() throws synchronously on a codec
                                // string the build cannot accept — a different
                                // failure from the async `error` callback
                                // above, and one that would otherwise leave
                                // this loop spinning on an unconfigured
                                // decoder forever.
                                const msg = (e as Error).message
                                setError(`decoder: ${msg}`)
                                onDecodeError?.(msg)
                                return
                            }
                            configured = true
                            onStatus?.({ codec })
                        }

                        if (!decoder || decoder.state !== 'configured') continue
                        // Backpressure valve: if the decoder is already behind,
                        // skip deltas rather than piling work on it. Dropping a
                        // frame costs one frame; queueing costs every frame
                        // that follows.
                        if (decoder.decodeQueueSize > 2 && !key) continue
                        decoder.decode(new EncodedVideoChunk({
                            type: key ? 'key' : 'delta',
                            // Microseconds, and only required to be monotonic —
                            // frames are painted on arrival, never scheduled.
                            timestamp: seq * 1000,
                            data: au,
                        }))
                    }
                }
            } catch (e) {
                if (!cancelled) setError((e as Error).message)
            }
        })()

        return () => {
            cancelled = true
            abort.abort()
            try { decoder?.close() } catch { /* already closed */ }
            pending?.close()
        }
    }, [src, wireCodec, onStatus, onDecodeError])

    return (
        <>
            <canvas ref={canvasRef} className={className} style={style} />
            {error && (
                <p className="absolute bottom-14 left-3 text-xs font-mono"
                    style={{ color: '#f87171' }}>{error}</p>
            )}
        </>
    )
}
