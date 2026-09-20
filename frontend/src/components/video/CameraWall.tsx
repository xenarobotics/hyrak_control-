'use client'

// Camera wall: every mesh unit that is delivering video, live, in one grid.
// A SECOND peer connection (the single view keeps its own): the browser
// offers one recvonly transceiver per unit, the backend attaches a shared
// feed track per port (feeds.py) and answers with a mid -> port map so each
// incoming track can be labelled. Tapping a tile makes that unit the main
// view (air-unit port + stream restart) and closes the wall.
import { useCallback, useEffect, useRef, useState } from 'react'
import { getSocket } from '@/lib/socket'
import { getServerUrl } from '@/lib/server-url'
import { setAirUnitVideoPort } from '@/lib/videoSource'
import { useWebRTCContext } from '@/contexts/WebRTCContext'

type MeshUnit = { id: number; port: number; live: boolean; in_use: boolean; kbps: number | null; source: string | null }

async function iceServers(): Promise<RTCIceServer[]> {
    try {
        const r = await fetch(`${getServerUrl()}/api/webrtc/ice-servers`, { signal: AbortSignal.timeout(5000) })
        const j = await r.json()
        if (Array.isArray(j.iceServers) && j.iceServers.length) return j.iceServers
    } catch { /* stun only */ }
    return [{ urls: 'stun:stun.l.google.com:19302' }]
}

export function CameraWall({ onClose }: { onClose: () => void }) {
    const { isStreaming, startStream, stopStream } = useWebRTCContext()
    const [units, setUnits] = useState<MeshUnit[]>([])
    const [streams, setStreams] = useState<Record<number, MediaStream>>({})
    const [status, setStatus] = useState('finding units...')
    const pcRef = useRef<RTCPeerConnection | null>(null)
    const midsRef = useRef<Record<string, number>>({})
    const pendingTracks = useRef<{ mid: string; stream: MediaStream }[]>([])
    const videoRefs = useRef<Record<number, HTMLVideoElement | null>>({})

    // Which units are up right now (probed from the actual sockets).
    useEffect(() => {
        let alive = true
        fetch(`${getServerUrl()}/api/video/mesh-units?max_units=8`).then(r => r.json()).then(j => {
            if (!alive) return
            const live = (j.units ?? []).filter((u: MeshUnit) => u.live || u.in_use)
            setUnits(live)
            if (!live.length) setStatus('no unit is delivering video')
        }).catch(() => setStatus('backend unreachable'))
        return () => { alive = false }
    }, [])

    // Negotiate once the unit list is known.
    useEffect(() => {
        if (!units.length) return
        const socket = getSocket()
        let closed = false
        const attach = (mid: string, stream: MediaStream) => {
            const port = midsRef.current[mid]
            if (port === undefined) { pendingTracks.current.push({ mid, stream }); return }
            setStreams(s => ({ ...s, [port]: stream }))
        }
        const onAnswer = async (a: { sdp: string; type: RTCSdpType; mids: Record<string, number> }) => {
            const pc = pcRef.current
            if (!pc || closed) return
            midsRef.current = a.mids || {}
            await pc.setRemoteDescription({ sdp: a.sdp, type: a.type })
            for (const p of pendingTracks.current.splice(0)) attach(p.mid, p.stream)
            setStatus(`${Object.keys(a.mids || {}).length} feed(s)`)
        }
        const onIce = async (c: RTCIceCandidateInit) => {
            try { await pcRef.current?.addIceCandidate(c) } catch { /* late candidate */ }
        }
        const onErr = (e: { error: string }) => setStatus(`wall failed: ${e.error}`)
        socket.on('wall_answer', onAnswer)
        socket.on('wall_ice_candidate', onIce)
        socket.on('wall_error', onErr)
        ;(async () => {
            const ice = await iceServers()
            if (closed) return
            const pc = new RTCPeerConnection({ iceServers: ice })
            pcRef.current = pc
            for (let i = 0; i < units.length; i++) pc.addTransceiver('video', { direction: 'recvonly' })
            pc.ontrack = ev => {
                const mid = ev.transceiver.mid ?? ''
                const stream = ev.streams[0] ?? new MediaStream([ev.track])
                attach(mid, stream)
            }
            pc.onicecandidate = ev => { if (ev.candidate) socket.emit('wall_ice_candidate', ev.candidate.toJSON()) }
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            setStatus('connecting...')
            socket.emit('wall_offer', { sdp: offer.sdp, type: offer.type, ports: units.map(u => u.port), iceServers: ice })
        })()
        return () => {
            closed = true
            socket.off('wall_answer', onAnswer); socket.off('wall_ice_candidate', onIce); socket.off('wall_error', onErr)
            socket.emit('wall_close')
            pcRef.current?.close(); pcRef.current = null
        }
    }, [units])

    // Bind streams to their <video> elements.
    useEffect(() => {
        for (const [port, el] of Object.entries(videoRefs.current)) {
            const s = streams[Number(port)]
            if (el && s && el.srcObject !== s) { el.srcObject = s; el.play().catch(() => {}) }
        }
    }, [streams])

    const pick = useCallback(async (u: MeshUnit) => {
        setAirUnitVideoPort(u.port)
        onClose()
        if (isStreaming) { stopStream(); await new Promise(r => setTimeout(r, 400)); await startStream() }
    }, [isStreaming, startStream, stopStream, onClose])

    const cols = units.length <= 1 ? 1 : units.length <= 4 ? 2 : 3
    return (
        <div className="relative flex-1 min-w-0 flex flex-col rounded-xl overflow-hidden" style={{ background: '#000' }}>
            <div className="flex items-center justify-between px-3 py-1.5 text-[10px] font-mono" style={{ color: '#a1a1aa', background: 'rgba(17,19,24,.9)' }}>
                <span>CAMERA WALL - {status}</span>
                <button onClick={onClose} className="px-2 py-0.5 rounded border" style={{ borderColor: '#22d3ee55', color: '#22d3ee' }}>SINGLE VIEW</button>
            </div>
            <div className="flex-1 grid gap-1 p-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
                {units.map(u => (
                    <button key={u.port} onClick={() => pick(u)} title={`Unit ${u.id} - udp ${u.port} - tap for single view`}
                        className="relative rounded overflow-hidden" style={{ background: '#0a0a0a', minHeight: 120 }}>
                        <video ref={el => { videoRefs.current[u.port] = el }} autoPlay muted playsInline className="w-full h-full object-contain" />
                        <span className="absolute left-2 top-1.5 text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: 'rgba(0,0,0,.6)', color: streams[u.port] ? '#4ade80' : '#fbbf24' }}>
                            UNIT {u.id}{u.kbps ? ` - ${u.kbps} k` : ''}{streams[u.port] ? '' : ' - waiting'}
                        </span>
                    </button>
                ))}
            </div>
        </div>
    )
}
