'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { getSocket } from '@/lib/socket'
import { useDroneStore } from '@/store/drone'
import { tuneVideoSender, videoConstraints, getVideoSettings } from '@/lib/videoSettings'

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
    const [stats, setStats] = useState<WebRTCStats | null>(null)

    const { setConnectionStatus } = useDroneStore()

    const cleanup = useCallback(() => {
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
        socket.off('answer')
        socket.off('ice_candidate')

        // Stop local camera tracks
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(t => t.stop())
            localStreamRef.current = null
        }

        setRemoteStream(null)
        setLocalStream(null)
        setStats(null)
        setIsStreaming(false)
    }, [])

    const startStream = useCallback(async (cameraStream: MediaStream) => {
        // Clean up any existing connection first
        cleanup()

        const socket = getSocket()
        localStreamRef.current = cameraStream
        setLocalStream(cameraStream)

        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        })
        pcRef.current = pc

        // Add camera tracks to peer connection
        cameraStream.getTracks().forEach(t => pc.addTrack(t, cameraStream))
        // Uplink quality: allow the bitrate the chosen resolution needs and
        // prefer dropping resolution over frame rate under congestion.
        tuneVideoSender(pc)

        // When we receive the processed video back from server
        pc.ontrack = (event) => {
            // Play received frames out immediately — the browser otherwise
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
                setConnectionStatus('connected')
            }
        }

        pc.oniceconnectionstatechange = () => {
            if (pc.iceConnectionState === 'failed' ||
                pc.iceConnectionState === 'disconnected' ||
                pc.iceConnectionState === 'closed') {
                setConnectionStatus('error')
                cleanup()
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

        socket.on('answer', handleAnswer)
        socket.on('ice_candidate', handleIce)

        try {
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            socket.emit('offer', {
                sdp: offer.sdp,
                type: offer.type,
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
            })
            setConnectionStatus('connecting')
        } catch (e) {
            console.error('WebRTC offer failed:', e)
            cleanup()
        }
    }, [cleanup, setConnectionStatus])

    const stopStream = useCallback(() => {
        getSocket().emit('stop_stream')
        cleanup()
        setConnectionStatus('disconnected')
    }, [cleanup, setConnectionStatus])

    // Re-apply the saved video settings to a LIVE stream (called from the
    // settings page) — reconfigures the camera track and sender in place,
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
        await tuneVideoSender(pcRef.current)
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
                reports.forEach((r: any) => {
                    if (r.type === 'inbound-rtp' && r.kind === 'video') {
                        const bytes = r.bytesReceived ?? 0
                        const ts = r.timestamp ?? 0
                        if (lastTs && ts > lastTs) {
                            out.bitrate = Math.round((bytes - lastBytes) * 8 / ((ts - lastTs) / 1000))
                        }
                        lastBytes = bytes
                        lastTs = ts
                        out.inputFps = r.framesPerSecond ?? 0
                        out.packetLoss = r.packetsLost ?? 0
                        out.jitter = r.jitter ?? 0
                    }
                    if (r.type === 'remote-inbound-rtp' && r.roundTripTime) {
                        out.roundTripTime = r.roundTripTime * 1000
                    }
                })
                setStats(out)
            } catch { }
        }, 1000)

        return () => {
            if (statsIntervalRef.current) clearInterval(statsIntervalRef.current)
        }
    }, [isStreaming])

    useEffect(() => { return () => { cleanup() } }, [cleanup])

    return { remoteStream, localStream, isStreaming, stats, startStream, stopStream, applyVideoSettings }
}