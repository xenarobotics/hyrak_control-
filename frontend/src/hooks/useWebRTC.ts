'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { getSocket } from '@/lib/socket'
import { getServerUrl } from '@/lib/server-url'
import { isServerFeedReady } from '@/lib/serverHevcFeed'
import { useDroneStore } from '@/store/drone'
import { tuneVideoSender, videoConstraints, getVideoSettings, wantsClientOverlay, wantsEcoUplink } from '@/lib/videoSettings'
import { getVideoSource, getSiyiRtspUrl, getAirUnitVideoPort, isServerSourced, usesDataChannelSender } from '@/lib/videoSource'
import { isDesktopApp, nativeBridge } from '@/lib/nativeBridge'
import { allocateRelay, releaseRelay, getLastRelayError, clearLastRelayError, RTSP_RELAY_BRIDGE_ID } from '@/hooks/useRtspRelayBridge'
import { startDataChannelSender, stopDataChannelSender, getLastSenderError, clearLastSenderError } from '@/hooks/useDataChannelSender'
import { getAirUnitPreviewUrl } from '@/lib/airUnitPreview'
import { startGstPipeline, stopGstPipeline, getGstPreviewUrl, getLastGstError } from '@/lib/gstPreview'
import { startReceiver, stopReceiver, getReceiverPreviewUrl, getLastReceiverError } from '@/lib/hyrakReceiver'
import { AIR_UNIT_BRIDGE_ID } from '@/hooks/useAirUnitVideoBridge'

const STUN_ONLY: RTCIceServer[] = [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
]

// STUN + TURN from the backend. TURN relay (over TCP/TLS) is what makes
// video work on UDP-blocking networks like campus WiFi - the backend mints
// short-lived Cloudflare TURN credentials so none live in frontend code.
async function fetchIceServers(): Promise<RTCIceServer[]> {
    try {
        const res = await fetch(`${getServerUrl()}/api/webrtc/ice-servers`, {
            signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
            return data.iceServers
        }
    } catch (e) {
        console.warn('ICE server fetch failed, using STUN only:', e)
    }
    return STUN_ONLY
}

/** The handful of RTCStats fields the panel reads, across inbound-rtp,
 *  outbound-rtp and remote-inbound-rtp - the DOM lib types each report as a
 *  bare RTCStats, so the shape is spelled out here. */
interface RtpStatsLike {
    type: string
    kind?: string
    timestamp?: number
    bytesReceived?: number
    bytesSent?: number
    framesPerSecond?: number
    packetsLost?: number
    jitter?: number
    roundTripTime?: number
}

export interface WebRTCStats {
    inputFps: number
    bitrate: number
    roundTripTime: number
    jitter: number
    packetLoss: number
}

export function useWebRTC() {
    const pcRef = useRef<RTCPeerConnection | null>(null)
    const statsIntervalRef = useRef<NodeJS.Timeout | null>(null)
    const localStreamRef = useRef<MediaStream | null>(null)

    // Store streams in state so consumers can react to changes
    const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
    const [localStream, setLocalStream] = useState<MediaStream | null>(null)
    const [isStreaming, setIsStreaming] = useState(false)
    // True while the current stream is client-overlay: local camera on
    // screen, AI results drawn browser-side, no downlink video.
    const [overlayActive, setOverlayActive] = useState(false)
    const [stats, setStats] = useState<WebRTCStats | null>(null)
    // Server-side failures (e.g. a server-sourced video open that never got
    // a real frame) arrive as a socket 'error' event, not a WebRTC/promise
    // rejection - nothing was listening for it before, so a failed start
    // just silently reverted to idle with zero feedback.
    const [lastError, setLastError] = useState<string | null>(null)
    // The socket handlers this hook registered, so cleanup can remove exactly
    // those and nothing else.
    const handlersRef = useRef<{
        answer?: (a: { sdp: string; type: RTCSdpType }) => void
        ice?: (c: RTCIceCandidateInit) => void
        error?: (e: { msg?: string }) => void
        stopped?: (d?: { reason?: string }) => void
    }>({})
    // ICE 'disconnected' is transient on a WiFi hiccup and usually recovers
    // by itself; only tear down if it has not come back within this grace.
    const iceGraceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const ICE_GRACE_MS = 5000

    const setStreamStatus = useDroneStore(s => s.setStreamStatus)

    // `keepRelay` distinguishes "tearing down to immediately restart" from
    // "the operator stopped". Releasing the relay on a restart is actively
    // harmful: the server hands out a NEW port on the next allocate, so a
    // laptop already pushing to the old one is left talking to nothing -
    // which is what produced the storm of moving ports in the logs.
    const cleanup = useCallback((keepRelay = false) => {
        if (statsIntervalRef.current) {
            clearInterval(statsIntervalRef.current)
            statsIntervalRef.current = null
        }
        if (pcRef.current) {
            pcRef.current.oniceconnectionstatechange = null
            pcRef.current.ontrack = null
            pcRef.current.onicecandidate = null
            try { pcRef.current.close() } catch { }
            pcRef.current = null
        }
        const socket = getSocket()
        // Only OUR handlers. A bare socket.off('error') removed every 'error'
        // listener on the page, including useDrone's (the one that un-sticks
        // a refused telemetry connect) and FollowControls' refusal text -
        // after the first video start they were gone for good.
        const h = handlersRef.current
        if (h.answer) socket.off('answer', h.answer)
        if (h.ice) socket.off('ice_candidate', h.ice)
        if (h.error) socket.off('error', h.error)
        if (h.stopped) socket.off('stream_stopped', h.stopped)
        handlersRef.current = {}
        if (iceGraceRef.current) {
            clearTimeout(iceGraceRef.current)
            iceGraceRef.current = null
        }

        // Stop local camera tracks
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(t => t.stop())
            localStreamRef.current = null
        }

        // Relay mode leaves an ffmpeg running on this machine and a listener
        // (plus its own ffmpeg) held on the server - neither is tied to the
        // peer connection, so closing the pc alone would leak both.
        // The sender owns its own PeerConnection and an ffmpeg (or a bound UDP
        // port), none of which the browser's pc teardown touches.
        if (!keepRelay && usesDataChannelSender(getVideoSource())) {
            void stopDataChannelSender()
        }
        // air_unit_srt was MISSING here and only rtsp_relay was listed, even
        // though both drive the same 'rtsp-relay' bridge - so stopping an
        // air_unit_srt stream left its ffmpeg alive holding udp:5600 forever.
        // Nothing surfaced it until a second mode wanted that port: the
        // orphan keeps the socket, the newcomer binds with SO_REUSEADDR,
        // receives nothing, and looks like a dead radio link.
        if (!keepRelay && (getVideoSource() === 'rtsp_relay' || getVideoSource() === 'air_unit_srt')) {
            if (isDesktopApp()) void nativeBridge()?.stop('rtsp-relay', RTSP_RELAY_BRIDGE_ID)
            releaseRelay()
        }
        // The GStreamer pipeline holds udp:5600 exclusively and an ffmpeg-class
        // child process; neither is tied to the browser's PeerConnection, so
        // closing the pc alone would leave the port bound and block the next
        // start with "Address already in use".
        if (!keepRelay && getVideoSource() === 'air_unit_gst') {
            void stopGstPipeline()
            releaseRelay()
        }
        // Same reasoning for the receiver: it holds a child process, a loopback
        // preview server and (on the udp transport) an exclusive UDP port, none
        // of which the browser's pc teardown touches. Leaving the port bound
        // blocks the next start with "Address already in use".
        if (!keepRelay && getVideoSource() === 'hyrak_receiver') {
            void stopReceiver()
            releaseRelay()
        }

        setRemoteStream(null)
        setLocalStream(null)
        setStats(null)
        setIsStreaming(false)
        setOverlayActive(false)
    }, [])

    const startStream = useCallback(async (cameraStream: MediaStream | null) => {
        // Clean up any existing connection first - but leave the relay alone,
        // it is reused rather than reallocated (see cleanup's keepRelay).
        cleanup(true)
        setLastError(null)

        const socket = getSocket()
        const videoSource = getVideoSource()

        // Stop EVERY local video producer, not just this source's.
        //
        // cleanup() can only tidy up the source that is selected NOW, and the
        // operator changes that in Settings between sessions - so switching
        // from air_unit_srt to hyrak_receiver runs the receiver's cleanup and
        // never the relay's, leaving the previous mode's ffmpeg alive. These
        // producers compete for the SAME udp:5600, and the loser binds with
        // SO_REUSEADDR and silently receives nothing, which is indisitinguishable
        // from the radio being off.
        //
        // Unconditional and idempotent: stopping a bridge that is not running
        // is a no-op, and it costs one IPC round trip against a failure mode
        // that reads as broken hardware.
        if (isDesktopApp()) {
            await Promise.allSettled([
                nativeBridge()?.stop('rtsp-relay', RTSP_RELAY_BRIDGE_ID),
                stopGstPipeline(),
                stopReceiver(),
                // The virtual-webcam bridge (Settings > Native air-unit video
                // bridge) holds udp:5600 AND 5601 (ffmpeg's RTCP port+1). It is
                // only wanted when the source IS that webcam; for every other
                // source it just makes the server reader fail "port in use".
                ...(videoSource !== 'camera'
                    ? [nativeBridge()?.stop('air-unit-video', AIR_UNIT_BRIDGE_ID)] : []),
            ])
        }
        const serverSourced = isServerSourced(videoSource)

        // Relay mode: this machine pushes the camera's original bytes to a
        // backend listener. Both steps must complete BEFORE the offer - the
        // server's offer handler attaches to an already-arriving stream and
        // gives up if no frame shows within its timeout.
        // air_unit_srt rides the SAME relay: allocate a listener, then push to
        // it with `-c copy`. Only ffmpeg's input differs (wfb_rx's RTP on
        // udp:5600 vs an RTSP pull), which is a flag on the bridge - see
        // `source` in desktop/src/bridges/rtspRelayBridge.ts.
        // GStreamer mode: one pipeline owns udp:5600 and does BOTH the local
        // preview and the SRT uplink, so there is no separate sender to start.
        // It still needs the relay allocated first, for the same reason the
        // others do - the server must be listening before we push, and pushing
        // must precede the offer.
        if (videoSource === 'air_unit_gst') {
            try {
                const alloc = await allocateRelay()
                if (!alloc.hostConfigured) {
                    throw new Error(
                        'Server has no relay_public_host configured, so there is nowhere to '
                        + 'push video. Set it in the backend config.',
                    )
                }
                await startGstPipeline(alloc)
                // Let the pipeline actually put packets on the wire before the
                // offer - the server opens the ingest with a blocking probe
                // and fails outright on a silent port.
                await new Promise((r) => setTimeout(r, 1500))
            } catch (e) {
                const msg = getLastGstError() ?? (e as Error).message
                console.error('[air-unit-gst] start failed:', msg)
                setLastError(msg)
                setStreamStatus('error')
                return
            }
        }

        // The HYRAK Receiver is the same shape as air_unit_gst - one process
        // owning both the pilot's picture and the server's uplink - but it
        // reads the ground DECODER over Ethernet rather than a local wfb_rx,
        // and it runs on any platform.
        if (videoSource === 'hyrak_receiver') {
            try {
                const alloc = await allocateRelay()
                if (!alloc.hostConfigured) {
                    throw new Error(
                        'Server has no relay_public_host configured, so there is nowhere to '
                        + 'push video. Set it in the backend config.',
                    )
                }
                const status = await startReceiver(alloc)
                // startReceiver already waited to SEE video before returning,
                // so this only covers the SRT uplink's own handshake to the
                // server - the offer handler probes that port and fails
                // outright on a silent one.
                if (!status.receiving) {
                    console.warn('[hyrak-receiver]', status.warning ?? 'no video yet')
                }
                await new Promise((r) => setTimeout(r, 1000))
            } catch (e) {
                const msg = getLastReceiverError() ?? (e as Error).message
                console.error('[hyrak-receiver] start failed:', msg)
                setLastError(msg)
                setStreamStatus('error')
                return
            }
        }

        const isRelay = videoSource === 'rtsp_relay' || videoSource === 'air_unit_srt'
        if (isRelay) {
            const fromAirUnit = videoSource === 'air_unit_srt'
            if (!isDesktopApp()) {
                const msg = 'Relay video needs the HYRAK desktop app - a browser tab can\'t run the relay.'
                setLastError(msg)
                setStreamStatus('error')
                return
            }
            try {
                const alloc = await allocateRelay()
                if (!alloc.hostConfigured) {
                    throw new Error(
                        'Server has no relay_public_host configured, so there is no reachable address '
                        + 'to push video to. Set it in the backend config (the relay does NOT go '
                        + 'through the HTTP tunnel).',
                    )
                }
                const started = await nativeBridge()?.start('rtsp-relay', RTSP_RELAY_BRIDGE_ID, {
                    ...(fromAirUnit
                        ? { source: 'udp' as const, udpPort: getAirUnitVideoPort(), url: '' }
                        : { source: 'rtsp' as const, url: getSiyiRtspUrl() }),
                    host: alloc.host,
                    port: alloc.port,
                    transport: alloc.transport,
                    latencyMs: alloc.latencyMs,
                    streamId: alloc.streamId,
                    // The air unit is H.265 and the preview branch would have to
                    // transcode it for Chromium (no software HEVC decoder). The
                    // operator already has a zero-cost local view via the
                    // fan-out port, so paying for a second encode here would be
                    // waste - see getAirUnitFanoutPort.
                    preview: !fromAirUnit,
                })
                if (started && !started.ok) throw new Error(started.error ?? 'Relay failed to start')
                clearLastRelayError()
            } catch (e) {
                const msg = (e as Error).message
                console.error('Relay start failed:', msg)
                setLastError(msg)
                setStreamStatus('error')
                return
            }
        }

        // DataChannel sender modes: the desktop app negotiates its OWN
        // PeerConnection carrying raw RTP, so H.265 reaches the server bit-exact
        // (a DataChannel negotiates no codec; aiortc's media-track codecs are
        // VP8/H.264 only). Like the relay, all of it has to finish before the
        // offer below - the server opens the loopback port with a synchronous
        // probe and fails on a silent one. See hooks/useDataChannelSender.ts.
        if (usesDataChannelSender(videoSource)) {
            try {
                await startDataChannelSender(videoSource)
                clearLastSenderError()
            } catch (e) {
                const msg = getLastSenderError() ?? (e as Error).message
                console.error('DataChannel sender start failed:', msg)
                setLastError(msg)
                setStreamStatus('error')
                return
            }
        }

        if (cameraStream) {
            localStreamRef.current = cameraStream
            setLocalStream(cameraStream)
        }

        // Feed choice is locked in per stream (modes can't change while
        // streaming): client-overlay sends camera up but receives no video
        // back - the page shows the local stream + a results canvas.
        //
        // Server-sourced feeds were excluded wholesale ("no local image to
        // draw on"), which was true until the air unit got an in-app local
        // preview (lib/airUnitPreview.ts). With that preview live, overlay
        // is not just possible but the whole point: the pilot's video stays
        // local (~10ms class instead of a 300-500ms round trip, and no
        // second-generation encode), the DataChannel still feeds the server,
        // and only detection JSON comes back. Gated on the preview actually
        // running - overlay with no local picture would be boxes on black.
        const mode = useDroneStore.getState().mode
        const overlayableServerSourced =
            (videoSource === 'air_unit_datachannel' && !!getAirUnitPreviewUrl())
            // Server-read air unit with the bit-exact WebCodecs path: the
            // picture is decoded locally from the unit's own H.265, so the
            // server can keep its frames for AI and send only results back.
            || (videoSource === 'air_unit_udp' && isServerFeedReady())
            // GStreamer mode is overlay-capable for the same reason: there IS
            // a local picture to draw on, so the server can skip the return
            // encode entirely and send only detection JSON.
            || (videoSource === 'air_unit_gst' && !!getGstPreviewUrl())
            // And the receiver, for the same reason: there is a local picture
            // to draw on, so the server sends detection JSON instead of a
            // re-encoded video leg.
            || (videoSource === 'hyrak_receiver' && !!getReceiverPreviewUrl())
        const clientOverlay = (!serverSourced || overlayableServerSourced) && wantsClientOverlay(mode)
        if (videoSource === 'air_unit_datachannel' && !clientOverlay) {
            // Loud on purpose (console.error reaches frontend.log via the
            // [browser] forwarder): without overlay this session falls back to
            // the server round trip - exactly the 500ms+ path the local
            // preview exists to avoid - and WHY must be diagnosable from the
            // server side, because the client is typically remote.
            console.error(
                '[air-unit-preview] client-overlay NOT engaged - falling back to the '
                + `server round-trip feed. preview=${getAirUnitPreviewUrl() ?? 'none'}, `
                + `feedModeWantsOverlay=${wantsClientOverlay(mode)}, mode=${mode}`,
            )
        }
        setOverlayActive(clientOverlay)

        const iceServers = await fetchIceServers()
        const pc = new RTCPeerConnection({ iceServers })
        pcRef.current = pc

        if (serverSourced) {
            // No local media to send - just ask for video back. The backend
            // sources frames itself (air unit UDP stream, or an RTSP pull
            // from a SIYI-style camera) instead of waiting on an inbound
            // browser track.
            pc.addTransceiver('video', { direction: 'recvonly' })
        } else if (cameraStream) {
            if (clientOverlay) {
                cameraStream.getTracks().forEach(t =>
                    pc.addTransceiver(t, { direction: 'sendonly', streams: [cameraStream] })
                )
            } else {
                cameraStream.getTracks().forEach(t => pc.addTrack(t, cameraStream))
            }
            // Uplink quality: allow the bitrate the chosen resolution needs
            // and prefer dropping resolution over frame rate under congestion.
            // Manual control may drop to thumbnail quality - the server just
            // makes admin previews from it, and a full-res software encode
            // can starve a weak CPU that's also decoding the RF video (see
            // wantsEcoUplink for how that's decided).
            const camLabel = cameraStream.getVideoTracks()[0]?.label ?? ''
            tuneVideoSender(pc, mode === 'manual-control' && wantsEcoUplink(camLabel),
                            mode === '3d-reconstruction')
        }

        // When we receive the processed video back from server
        pc.ontrack = (event) => {
            // Play received frames out immediately - the browser otherwise
            // grows a smoothing jitter buffer over time, which shows up as
            // slowly accumulating glass-to-glass latency.
            try {
                const receiver = event.receiver as unknown as Record<string, unknown>
                if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0
                if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = 0
            } catch { /* best-effort; not supported in every browser */ }
            const stream = event.streams?.[0]
            if (stream) {
                setRemoteStream(stream)
                setIsStreaming(true)
                setStreamStatus('connected')
            }
        }

        pc.oniceconnectionstatechange = () => {
            // No return track in overlay mode, so ontrack never fires -
            // the connection itself is the "streaming" signal.
            if (clientOverlay &&
                (pc.iceConnectionState === 'connected' ||
                    pc.iceConnectionState === 'completed')) {
                setIsStreaming(true)
                setStreamStatus('connected')
            }
            if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                if (iceGraceRef.current) {
                    clearTimeout(iceGraceRef.current)
                    iceGraceRef.current = null
                }
            }
            if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
                setStreamStatus('error')
                cleanup()
            } else if (pc.iceConnectionState === 'disconnected' && !iceGraceRef.current) {
                iceGraceRef.current = setTimeout(() => {
                    iceGraceRef.current = null
                    if (pcRef.current === pc && pc.iceConnectionState === 'disconnected') {
                        setLastError('Video connection lost')
                        setStreamStatus('error')
                        cleanup()
                    }
                }, ICE_GRACE_MS)
            }
        }

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('ice_candidate', event.candidate.toJSON())
            }
        }

        const handleAnswer = (answer: { sdp: string; type: RTCSdpType }) => {
            pc.setRemoteDescription(new RTCSessionDescription(answer)).catch(console.error)
        }
        const handleIce = (candidate: RTCIceCandidateInit) => {
            pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.error)
        }
        const handleError = (err: { msg?: string }) => {
            // The relay's own failure is both faster and more specific than
            // the server noticing nothing arrived - prefer it when present.
            const relayErr = videoSource === 'rtsp_relay' ? getLastRelayError()
                : usesDataChannelSender(videoSource) ? getLastSenderError()
                : null
            const msg = relayErr || err?.msg || 'Stream failed to start'
            console.error('Server rejected offer:', msg)
            setLastError(msg)
            setStreamStatus('error')
            cleanup()
        }

        // The server stops a stream on its own when its source dies or the
        // session is evicted; nothing listened for it, so the button kept
        // saying Stop and the last boxes stayed on screen.
        const handleStopped = (d?: { reason?: string }) => {
            if (pcRef.current !== pc) return
            if (d?.reason) setLastError(d.reason)
            cleanup()
        }

        socket.on('answer', handleAnswer)
        socket.on('ice_candidate', handleIce)
        socket.on('error', handleError)
        socket.on('stream_stopped', handleStopped)
        handlersRef.current = { answer: handleAnswer, ice: handleIce, error: handleError, stopped: handleStopped }

        try {
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            socket.emit('offer', {
                sdp: offer.sdp,
                type: offer.type,
                // Server-side aiortc uses the same list (first STUN + first
                // TURN entry) so both peers can reach the relay.
                iceServers,
                clientOverlay,
                videoSource,
                ...(videoSource === 'siyi_rtsp' ? { rtspUrl: getSiyiRtspUrl() } : {}),
                ...(videoSource === 'air_unit_udp' ? { airUnitVideoPort: getAirUnitVideoPort() } : {}),
            })
            setStreamStatus('connecting')
        } catch (e) {
            console.error('WebRTC offer failed:', e)
            // Without a message `pending` stayed true until the 35 s backstop.
            setLastError((e as Error)?.message || 'Could not start the video connection')
            cleanup()
        }
    }, [cleanup, setStreamStatus])

    const stopStream = useCallback(() => {
        getSocket().emit('stop_stream')
        cleanup()
        setStreamStatus('idle')
    }, [cleanup, setStreamStatus])

    // Renegotiate on the SAME local producers. A session resume only loses
    // the peer connection (the server drops media with the socket); the
    // local gst/receiver/datachannel processes and the relay port are still
    // fine, and a full stop/start would kill them and get a NEW relay port -
    // leaving a laptop that is already pushing to the old one talking to
    // nothing. startStream already does cleanup(true), so this is just
    // "tell the server, keep everything local".
    const restartStream = useCallback(async (cameraStream: MediaStream | null) => {
        getSocket().emit('stop_stream')
        cleanup(true)
        setStreamStatus('connecting')
        await startStream(cameraStream)
    }, [cleanup, setStreamStatus, startStream])

    // Re-apply the saved video settings to a LIVE stream (called from the
    // settings page) - reconfigures the camera track and sender in place,
    // no renegotiation needed.
    const applyVideoSettings = useCallback(async () => {
        const track = localStreamRef.current?.getVideoTracks()[0]
        if (!track || !pcRef.current) return
        const { fps } = getVideoSettings()
        try {
            const deviceId = track.getSettings().deviceId ?? ''
            const c = videoConstraints(deviceId)
            await track.applyConstraints({
                width: c.width, height: c.height,
                frameRate: { ideal: fps, max: fps },
            })
        } catch (e) {
            console.warn('applyConstraints failed:', e)
        }
        // Re-evaluate the standby throttle too - this is also how changing
        // the Standby-uplink setting live-applies to a running stream.
        await tuneVideoSender(
            pcRef.current,
            useDroneStore.getState().mode === 'manual-control' && wantsEcoUplink(track.label),
            useDroneStore.getState().mode === '3d-reconstruction',
        )
    }, [])

    // Stats collection
    useEffect(() => {
        if (!isStreaming || !pcRef.current) return
        const pc = pcRef.current
        let lastBytes = 0
        let lastTs = 0

        statsIntervalRef.current = setInterval(async () => {
            try {
                const reports = await pc.getStats()
                const out: WebRTCStats = {
                    inputFps: 0, bitrate: 0, roundTripTime: 0, jitter: 0, packetLoss: 0
                }
                let inbound: RtpStatsLike | null = null
                let outbound: RtpStatsLike | null = null
                let remoteIn: RtpStatsLike | null = null
                for (const r of reports.values() as Iterable<RtpStatsLike>) {
                    if (r.type === 'inbound-rtp' && r.kind === 'video') inbound = r
                    if (r.type === 'outbound-rtp' && r.kind === 'video') outbound = r
                    if (r.type === 'remote-inbound-rtp' && r.kind === 'video') remoteIn = r
                }
                // Overlay streams have no inbound video - report the uplink
                // instead (fps/bitrate sent, loss/jitter as the server sees it).
                const src = inbound ?? outbound
                if (src) {
                    const bytes = inbound ? (src.bytesReceived ?? 0) : (src.bytesSent ?? 0)
                    const ts = src.timestamp ?? 0
                    if (lastTs && ts > lastTs) {
                        out.bitrate = Math.round((bytes - lastBytes) * 8 / ((ts - lastTs) / 1000))
                    }
                    lastBytes = bytes
                    lastTs = ts
                    out.inputFps = src.framesPerSecond ?? 0
                    out.packetLoss = inbound ? (inbound.packetsLost ?? 0) : (remoteIn?.packetsLost ?? 0)
                    out.jitter = inbound ? (inbound.jitter ?? 0) : (remoteIn?.jitter ?? 0)
                }
                if (remoteIn?.roundTripTime) {
                    out.roundTripTime = remoteIn.roundTripTime * 1000
                }
                setStats(out)
            } catch { }
        }, 1000)

        return () => {
            if (statsIntervalRef.current) clearInterval(statsIntervalRef.current)
        }
    }, [isStreaming])

    useEffect(() => { return () => { cleanup() } }, [cleanup])

    return { remoteStream, localStream, isStreaming, overlayActive, stats, lastError, startStream, stopStream, restartStream, applyVideoSettings }
}