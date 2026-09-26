'use client'

// The two links the operator brings up before a flight, side by side in the
// Command window's top bar: telemetry (Connect / Disconnect) and video
// (Start / Stop). Which radio and which camera stay chosen in SETUP - this is
// only the switch, using the same shared hooks as the Fly tab, so both places
// always agree.

import { Loader2, Plug, PlugZap, Video, VideoOff } from 'lucide-react'
import { useTelemetryLink } from '@/hooks/useTelemetryLink'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { useDroneStore } from '@/store/drone'
import { getVideoSource, needsCameraSelection } from '@/lib/videoSource'

function Pill({ on, busy, label, detail, onClick, disabled, title, icon }: {
    on: boolean; busy: boolean; label: string; detail: string; onClick: () => void
    disabled?: boolean; title?: string; icon: React.ReactNode
}) {
    return (
        <button onClick={onClick} disabled={disabled || busy} title={title}
            className="h-9 pl-2.5 pr-3 rounded-lg border flex items-center gap-2 text-[11px] font-mono transition-colors disabled:opacity-50"
            style={{
                background: on ? 'rgba(74,222,128,.10)' : 'rgba(34,211,238,.12)',
                borderColor: on ? 'rgba(74,222,128,.45)' : 'rgba(34,211,238,.55)',
                color: on ? '#bbf7d0' : '#a5f3fc',
            }}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : icon}
            <span className="flex flex-col items-start leading-[1.1]">
                <span className="font-bold tracking-wider">{label}</span>
                <span className="text-[9px] opacity-70">{detail}</span>
            </span>
        </button>
    )
}

export function LinkCluster() {
    const { connect, disconnect, disconnecting, isConnected, isConnecting, sitlNeedsDesktop, telemetryError, options, source } = useTelemetryLink()
    const { isStreaming, isLoading, startStream, stopStream, selectedCameraId } = useWebRTCContext()
    const link = useDroneStore(s => s.telemetry?.link_ok)
    const src = getVideoSource()
    const camMissing = needsCameraSelection(src) && !selectedCameraId && !isStreaming
    const radioLabel = options.find(o => o.value === source)?.label ?? source

    return (
        <div className="flex items-center gap-1.5 shrink-0">
            <Pill on={isConnected} busy={isConnecting || disconnecting}
                icon={isConnected ? <PlugZap size={14} /> : <Plug size={14} />}
                label={isConnected ? (link === false ? 'TELEM LOST' : 'TELEMETRY') : 'CONNECT'}
                detail={radioLabel.length > 18 ? radioLabel.slice(0, 17) + '..' : radioLabel}
                disabled={!isConnected && sitlNeedsDesktop}
                title={isConnected ? 'Disconnect telemetry' : (telemetryError ?? `Connect telemetry (${radioLabel}) - change the radio in SETUP`)}
                onClick={() => (isConnected ? disconnect() : connect())} />
            <Pill on={isStreaming} busy={isLoading}
                icon={isStreaming ? <Video size={14} /> : <VideoOff size={14} />}
                label={isStreaming ? 'VIDEO' : 'START VIDEO'}
                detail={src.replace(/_/g, ' ')}
                disabled={camMissing}
                title={camMissing ? 'Pick a camera in SETUP first' : isStreaming ? 'Stop the video' : 'Start the video'}
                onClick={() => (isStreaming ? stopStream() : startStream())} />
        </div>
    )
}
