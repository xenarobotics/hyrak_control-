'use client'

// The two links the operator brings up before a flight, side by side in the
// Command window's top bar: telemetry (CONNECT) and video (START VIDEO). Each
// has a small menu beside it to switch the source without leaving the page:
//   telemetry  which radio / bridge (locked while connected)
//   video      which source, then - for a camera on this machine - which
//              device, and which sensor avoidance senses with
// Same shared hooks and catalogue as the Fly tab, Settings and the status bar
// (useTelemetryLink, lib/videoSource), so every place shows the same answer.
// Changing the video source or device restarts a running stream - nothing
// reads them after a stream has started.

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Loader2, Plug, PlugZap, Plus, RefreshCw, Video, VideoOff } from 'lucide-react'
import { useTelemetryLink } from '@/hooks/useTelemetryLink'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { useDroneStore } from '@/store/drone'
import {
    getVideoSource, setVideoSource, needsCameraSelection, type VideoSource,
    VIDEO_SOURCES, SOURCE_GROUPS,
} from '@/lib/videoSource'
import { isDesktopApp } from '@/lib/nativeBridge'
import { setEnabled, type AvoidanceStatus } from '@/lib/avoidance'

function Pill({ on, busy, label, detail, onClick, disabled, title, icon, menuOpen, onMenu }: {
    on: boolean; busy: boolean; label: string; detail: string; onClick: () => void
    disabled?: boolean; title?: string; icon: React.ReactNode; menuOpen: boolean; onMenu: () => void
}) {
    const tone = on
        ? { background: 'rgba(74,222,128,.10)', borderColor: 'rgba(74,222,128,.45)', color: '#bbf7d0' }
        : { background: 'rgba(34,211,238,.12)', borderColor: 'rgba(34,211,238,.55)', color: '#a5f3fc' }
    return (
        <div className="h-9 flex rounded-lg border overflow-hidden" style={tone}>
            <button onClick={onClick} disabled={disabled || busy} title={title}
                className="pl-2.5 pr-2.5 flex items-center gap-2 text-[11px] font-mono disabled:opacity-50 hover:brightness-125">
                {busy ? <Loader2 size={14} className="animate-spin" /> : icon}
                <span className="flex flex-col items-start leading-[1.1]">
                    <span className="font-bold tracking-wider">{label}</span>
                    <span className="text-[9px] opacity-70 max-w-[120px] truncate">{detail}</span>
                </span>
            </button>
            <button onClick={onMenu} aria-label="Choose source" aria-expanded={menuOpen}
                className="w-7 flex items-center justify-center border-l hover:brightness-125"
                style={{ borderColor: tone.borderColor, background: menuOpen ? 'rgba(255,255,255,.08)' : undefined }}>
                <ChevronDown size={13} className={menuOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
            </button>
        </div>
    )
}

function Menu({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
    const ref = useRef<HTMLDivElement>(null)
    useEffect(() => {
        const down = (e: MouseEvent) => { if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose() }
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('mousedown', down)
        window.addEventListener('keydown', key)
        return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key) }
    }, [onClose])
    return (
        <div ref={ref} className="absolute right-0 top-[calc(100%+6px)] z-[3000] w-[280px] max-h-[70vh] overflow-y-auto rounded-xl border p-1.5 font-mono text-[11px] shadow-2xl"
            style={{ background: '#0d1117', borderColor: 'rgba(255,255,255,.12)' }}>
            {children}
        </div>
    )
}

const Section = ({ title, action }: { title: string; action?: React.ReactNode }) => (
    <div className="flex items-center justify-between px-2 pt-2 pb-1 text-[9px] tracking-[0.2em] text-zinc-500">
        <span>{title}</span>{action}
    </div>
)

function Item({ active, label, sub, onClick, disabled }: {
    active: boolean; label: string; sub?: string; onClick: () => void; disabled?: boolean
}) {
    return (
        <button onClick={onClick} disabled={disabled}
            className="w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left disabled:opacity-40 hover:bg-white/5"
            style={active ? { background: 'rgba(34,211,238,.12)', color: '#a5f3fc' } : { color: '#d4d4d8' }}>
            <span className="w-3.5 shrink-0 pt-px">{active && <Check size={12} />}</span>
            <span className="flex flex-col min-w-0">
                <span className="truncate">{label}</span>
                {sub && <span className="text-[9.5px] text-zinc-500">{sub}</span>}
            </span>
        </button>
    )
}

const Mini = ({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) => (
    <button onClick={onClick} title={title} className="p-1 rounded text-zinc-400 hover:text-zinc-100">{children}</button>
)

export function LinkCluster({ avoid }: { avoid: AvoidanceStatus | null }) {
    const {
        desktop, options, source, setSource, refreshRadios, refreshNativeRadios, addRadio, browserSerialSupported,
        connect, disconnect, disconnecting, isConnected, isConnecting, sitlNeedsDesktop, telemetryError,
    } = useTelemetryLink()
    const {
        cameras, selectedCameraId, setSelectedCameraId, scanCameras,
        isStreaming, isLoading, startStream, stopStream,
    } = useWebRTCContext()
    const link = useDroneStore(s => s.telemetry?.link_ok)
    const [menu, setMenu] = useState<'telem' | 'video' | null>(null)
    const [src, setSrc] = useState<VideoSource>(() => getVideoSource())
    const [sensorBusy, setSensorBusy] = useState(false)

    // One restart at a time: a second change cancels the first (see
    // StatusBarLinks for the wedged-feed story behind this).
    const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(() => () => { if (restartTimer.current) clearTimeout(restartTimer.current) }, [])
    const restart = () => {
        if (!isStreaming) return
        if (restartTimer.current) clearTimeout(restartTimer.current)
        stopStream()
        restartTimer.current = setTimeout(() => { restartTimer.current = null; void startStream() }, 600)
    }
    const pickSource = (v: VideoSource) => { setSrc(v); setVideoSource(v); restart() }
    const pickCamera = (id: string) => { setSelectedCameraId(id); restart() }

    const needsCam = needsCameraSelection(src)
    const camMissing = needsCam && !selectedCameraId && !isStreaming
    const radioLabel = options.find(o => o.value === source)?.label ?? source
    const srcLabel = VIDEO_SOURCES.find(v => v.value === src)?.label ?? src
    const camLabel = needsCam ? cameras.find(c => c.deviceId === selectedCameraId)?.label : undefined
    const desktopApp = isDesktopApp()

    type Sense = 'range' | 'camera' | 'bench'
    const sense: Sense = avoid?.params?.use_range_sensor !== 0 ? 'range' : avoid?.params?.mono_bench ? 'bench' : 'camera'
    const setAvoidSensor = async (to: Sense) => {
        if (!avoid) return
        setSensorBusy(true)
        try {
            await setEnabled(avoid.drone_id, avoid.enabled,
                { use_range_sensor: to === 'range' ? 1 : 0, mono_bench: to === 'bench' ? 1 : 0 })
        } finally { setSensorBusy(false) }
    }

    return (
        <div className="flex items-center gap-1.5 shrink-0">
            <div className="relative">
                <Pill on={isConnected} busy={isConnecting || disconnecting}
                    icon={isConnected ? <PlugZap size={14} /> : <Plug size={14} />}
                    label={isConnected ? (link === false ? 'TELEM LOST' : 'TELEMETRY') : 'CONNECT'}
                    detail={radioLabel}
                    disabled={!isConnected && sitlNeedsDesktop}
                    title={isConnected ? 'Disconnect telemetry' : (telemetryError ?? `Connect telemetry (${radioLabel})`)}
                    onClick={() => (isConnected ? disconnect() : connect())}
                    menuOpen={menu === 'telem'} onMenu={() => setMenu(m => (m === 'telem' ? null : 'telem'))} />
                {menu === 'telem' && (
                    <Menu onClose={() => setMenu(null)}>
                        <Section title="TELEMETRY LINK" action={
                            desktop ? <Mini onClick={() => { void refreshNativeRadios() }} title="Re-scan serial ports"><RefreshCw size={11} /></Mini>
                                : browserSerialSupported ? <Mini onClick={() => { void addRadio() }} title="Add a USB radio plugged into this device"><Plus size={12} /></Mini>
                                    : <Mini onClick={() => { void refreshRadios() }} title="Re-scan radios"><RefreshCw size={11} /></Mini>} />
                        {isConnected && <p className="px-2 pb-1 text-[10px] text-amber-300/90">Disconnect to change the link.</p>}
                        {options.map(o => (
                            <Item key={o.value} active={o.value === source} label={o.label} disabled={isConnected}
                                onClick={() => { setSource(o.value); setMenu(null) }} />
                        ))}
                        <p className="px-2 pt-1.5 pb-1 text-[9.5px] text-zinc-500">Relay URL, baud and uplink host: SETUP tab.</p>
                    </Menu>
                )}
            </div>

            <div className="relative">
                <Pill on={isStreaming} busy={isLoading}
                    icon={isStreaming ? <Video size={14} /> : <VideoOff size={14} />}
                    label={isStreaming ? 'VIDEO' : 'START VIDEO'}
                    detail={camLabel ?? srcLabel}
                    disabled={camMissing}
                    title={camMissing ? 'Pick a camera in the menu first' : isStreaming ? 'Stop the video' : 'Start the video'}
                    onClick={() => (isStreaming ? stopStream() : startStream())}
                    menuOpen={menu === 'video'} onMenu={() => setMenu(m => (m === 'video' ? null : 'video'))} />
                {menu === 'video' && (
                    <Menu onClose={() => setMenu(null)}>
                        {isStreaming && <p className="px-2 pt-1 text-[10px] text-amber-300/90">Changing source or camera restarts the stream.</p>}
                        {SOURCE_GROUPS.map(group => (
                            <div key={group}>
                                <Section title={group.toUpperCase()} />
                                {VIDEO_SOURCES.filter(v => v.group === group).map(v => (
                                    <Item key={v.value} active={v.value === src}
                                        label={v.label + (v.desktopOnly && !desktopApp ? '  (desktop)' : '')}
                                        onClick={() => pickSource(v.value)} />
                                ))}
                            </div>
                        ))}
                        {needsCam && (
                            <>
                                <Section title="CAMERA ON THIS MACHINE" action={
                                    <Mini onClick={scanCameras} title="Re-scan cameras"><RefreshCw size={11} /></Mini>} />
                                {cameras.length === 0 && <p className="px-2 pb-1 text-zinc-500">No cameras found - re-scan, or allow camera access.</p>}
                                {cameras.map(c => (
                                    <Item key={c.deviceId} active={c.deviceId === selectedCameraId} label={c.label || 'Camera'}
                                        onClick={() => pickCamera(c.deviceId)} />
                                ))}
                            </>
                        )}
                        {avoid?.enabled && (
                            <>
                                <Section title="AVOIDANCE SENSES WITH" action={sensorBusy ? <Loader2 size={11} className="animate-spin" /> : undefined} />
                                <Item active={sense === 'range'} label="Depth / range sensor when present"
                                    sub="the aircraft's own range data wins (default)" onClick={() => { void setAvoidSensor('range') }} />
                                <Item active={sense === 'camera'} label="This video stream (camera)"
                                    sub="flight mode: ground-calibrated, acts above 8 m" onClick={() => { void setAvoidSensor('camera') }} />
                                <Item active={sense === 'bench'} label="Camera bench test (fixed webcam)"
                                    sub="model metres as-is, camera level ~1 m up - hold things 0.5-3 m away. Not for flight."
                                    onClick={() => { void setAvoidSensor('bench') }} />
                            </>
                        )}
                    </Menu>
                )}
            </div>
        </div>
    )
}
