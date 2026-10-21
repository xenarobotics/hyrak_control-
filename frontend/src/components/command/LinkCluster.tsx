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
    VIDEO_SOURCES, videoSourcesFor, sourceGroupsFor,
} from '@/lib/videoSource'
import { useAccess } from '@/hooks/useAccess'
import { isDesktopApp } from '@/lib/nativeBridge'
import { setParams, type AvoidanceStatus } from '@/lib/avoidance'
import { PersonCalibration } from './PersonCalibration'
import { useLiveScope } from '@/hooks/useLiveScope'
import { VIEW_ONLY_TEXT } from '@/components/layout/ViewOnly'
import { FOCUS_LINK_EVENT } from '@/components/layout/StatusBar'
import { cn } from '@/lib/utils'
import { FOCUS } from '@/components/controls/flightStyles'
import { WhyDisabled } from '@/components/controls/WhyDisabled'
import { cameraLabel } from '@/components/video/cameraLabel'

function Pill({ on, busy, label, detail, onClick, disabled, title, icon, menuOpen, onMenu }: {
    on: boolean; busy: boolean; label: string; detail: string; onClick: () => void
    disabled?: boolean; title?: string; icon: React.ReactNode; menuOpen: boolean; onMenu: () => void
}) {
    // Live = green, ready to start = accent. Theme tokens, not fixed hex.
    const tone = on ? 'border-app-ok bg-app-ok-soft text-app-ok' : 'border-app-accent bg-app-accent-soft text-app-selected-ink'
    const off = disabled || busy
    return (
        <div className={cn('h-10 flex rounded-md border transition-colors duration-[140ms]', tone, off && !busy && 'border-app-border bg-app-surface-2 text-app-text-subtle')}>
            <WhyDisabled reason={off && !busy ? title : null} className="h-full">
                <button onClick={onClick} disabled={off} title={off ? undefined : title}
                    className={cn('h-full pl-3 pr-3 flex items-center gap-2 text-[13px] rounded-l-md transition-colors duration-[140ms] hover:bg-[color-mix(in_srgb,currentColor_8%,transparent)]', FOCUS)}>
                    {busy ? <Loader2 size={14} className="animate-spin" /> : icon}
                    <span className="flex flex-col items-start leading-[1.15]">
                        <span className="font-bold">{label}</span>
                        <span className="text-[12px] font-semibold text-app-text-muted max-w-[130px] truncate">{detail}</span>
                    </span>
                </button>
            </WhyDisabled>
            <button onClick={onMenu} aria-label="Choose source" aria-expanded={menuOpen} title="Choose source"
                className={cn('w-8 flex items-center justify-center border-l border-current/30 rounded-r-md transition-colors duration-[140ms] hover:bg-[color-mix(in_srgb,currentColor_8%,transparent)]', FOCUS,
                    menuOpen && 'bg-app-surface-2')}>
                <ChevronDown size={14} className={cn('transition-transform duration-[var(--dur)]', menuOpen && 'rotate-180')} />
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
        <div ref={ref} className="absolute left-0 top-[calc(100%+6px)] md:top-auto md:bottom-[calc(100%+6px)] z-[3000] w-[280px] animate-in fade-in-0 slide-in-from-bottom-1 duration-[180ms] max-h-[70vh] overflow-y-auto rounded-[10px] border border-app-border bg-app-raised p-1.5 text-[13px] text-app-text shadow-[var(--app-shadow)]">
            {children}
        </div>
    )
}

const Section = ({ title, action }: { title: string; action?: React.ReactNode }) => (
    <div className="flex items-center justify-between px-2 pt-2 pb-1 text-[13px] font-semibold text-app-text-muted">
        <span>{title}</span>{action}
    </div>
)

function Item({ active, label, sub, onClick, disabled }: {
    active: boolean; label: string; sub?: string; onClick: () => void; disabled?: boolean
}) {
    return (
        <button onClick={onClick} disabled={disabled} aria-pressed={active}
            className={cn('w-full min-h-8 flex items-start gap-2 px-2 py-1.5 rounded-md text-left disabled:text-app-text-subtle disabled:cursor-not-allowed', FOCUS,
                active ? 'bg-app-accent-soft text-app-selected-ink font-bold' : 'text-app-text hover:bg-app-surface-2')}>
            <span className="w-3.5 shrink-0 pt-0.5">{active && <Check size={13} />}</span>
            <span className="flex flex-col min-w-0">
                <span className="truncate">{label}</span>
                {sub && <span className="text-[12px] font-normal text-app-text-muted">{sub}</span>}
            </span>
        </button>
    )
}

const Mini = ({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) => (
    <button onClick={onClick} title={title} aria-label={title}
        className={cn('h-8 w-8 flex items-center justify-center rounded-md text-app-text-muted hover:text-app-text hover:bg-app-surface-2 normal-case', FOCUS)}>{children}</button>
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
    // Customer-only accounts get the customer-safe sources (lib/videoSource).
    const { isCustomer } = useAccess()
    const catalogue = videoSourcesFor(isCustomer)
    // Connecting the drone link is a command; viewers keep their video.
    const { viewOnly } = useLiveScope()
    const [menu, setMenu] = useState<'telem' | 'video' | null>(null)
    const [src, setSrc] = useState<VideoSource>(() => getVideoSource())
    const [sensorBusy, setSensorBusy] = useState(false)
    // The status bar's "Connect" (no drone) opens the telemetry menu here.
    useEffect(() => {
        const open = () => setMenu('telem')
        window.addEventListener(FOCUS_LINK_EVENT, open)
        return () => window.removeEventListener(FOCUS_LINK_EVENT, open)
    }, [])

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
    const camIdx = cameras.findIndex(c => c.deviceId === selectedCameraId)
    const camLabel = needsCam && camIdx >= 0 ? cameraLabel(cameras[camIdx].label, camIdx) : undefined
    const desktopApp = isDesktopApp()

    type Sense = 'range' | 'camera' | 'bench'
    const sense: Sense = avoid?.params?.use_range_sensor !== 0 ? 'range' : avoid?.params?.mono_bench ? 'bench' : 'camera'
    const setAvoidSensor = async (to: Sense) => {
        if (!avoid) return
        setSensorBusy(true)
        try {
            await setParams(avoid.drone_id,
                { use_range_sensor: to === 'range' ? 1 : 0, mono_bench: to === 'bench' ? 1 : 0 })
        } finally { setSensorBusy(false) }
    }

    return (
        <div className="flex items-center gap-1.5 shrink-0">
            <div className="relative">
                <Pill on={isConnected} busy={isConnecting || disconnecting}
                    icon={isConnected ? <PlugZap size={14} /> : <Plug size={14} />}
                    label={isConnected ? (link === false ? 'Telemetry lost' : 'Telemetry') : 'Connect'}
                    detail={radioLabel}
                    disabled={!isConnected && (sitlNeedsDesktop || viewOnly)}
                    title={isConnected ? 'Disconnect telemetry'
                        : viewOnly ? VIEW_ONLY_TEXT
                        : (telemetryError ?? `Connect telemetry (${radioLabel})`)}
                    onClick={() => (isConnected ? disconnect() : connect())}
                    menuOpen={menu === 'telem'} onMenu={() => setMenu(m => (m === 'telem' ? null : 'telem'))} />
                {menu === 'telem' && (
                    <Menu onClose={() => setMenu(null)}>
                        <Section title="Telemetry link" action={
                            desktop ? <Mini onClick={() => { void refreshNativeRadios() }} title="Re-scan serial ports"><RefreshCw size={14} /></Mini>
                                : browserSerialSupported ? <Mini onClick={() => { void addRadio() }} title="Add a USB radio plugged into this device"><Plus size={14} /></Mini>
                                    : <Mini onClick={() => { void refreshRadios() }} title="Re-scan radios"><RefreshCw size={14} /></Mini>} />
                        {isConnected && <p className="px-2 pb-1 text-[13px] text-app-warn">Disconnect to change the link.</p>}
                        {options.map(o => (
                            <Item key={o.value} active={o.value === source} label={o.label} sub={o.note} disabled={isConnected || o.disabled}
                                onClick={() => { setSource(o.value); setMenu(null) }} />
                        ))}
                        <p className="px-2 pt-1.5 pb-1 text-[12px] text-app-text-muted">Relay URL, baud and uplink host: Setup tab.</p>
                    </Menu>
                )}
            </div>

            <div className="relative">
                <Pill on={isStreaming} busy={isLoading}
                    icon={isStreaming ? <Video size={14} /> : <VideoOff size={14} />}
                    label={isStreaming ? 'Video on' : 'Start video'}
                    detail={camLabel ?? srcLabel}
                    disabled={camMissing}
                    title={camMissing ? 'Pick a camera in the menu first' : isStreaming ? 'Stop the video' : 'Start the video'}
                    onClick={() => (isStreaming ? stopStream() : startStream())}
                    menuOpen={menu === 'video'} onMenu={() => setMenu(m => (m === 'video' ? null : 'video'))} />
                {menu === 'video' && (
                    <Menu onClose={() => setMenu(null)}>
                        {isStreaming && <p className="px-2 pt-1 text-[13px] text-app-warn">Changing source or camera restarts the stream.</p>}
                        {sourceGroupsFor(isCustomer).map(group => (
                            <div key={group}>
                                <Section title={group} />
                                {catalogue.filter(v => v.group === group).map(v => (
                                    <Item key={v.value} active={v.value === src}
                                        label={v.label + (v.desktopOnly && !desktopApp ? '  (desktop)' : '')}
                                        onClick={() => pickSource(v.value)} />
                                ))}
                            </div>
                        ))}
                        {needsCam && (
                            <>
                                <Section title="Camera on this machine" action={
                                    <Mini onClick={scanCameras} title="Re-scan cameras"><RefreshCw size={14} /></Mini>} />
                                {cameras.length === 0 && <p className="px-2 pb-1 text-app-text-muted">No cameras found. Re-scan, or allow camera access.</p>}
                                {cameras.map((c, i) => (
                                    <Item key={c.deviceId} active={c.deviceId === selectedCameraId} label={cameraLabel(c.label, i)}
                                        onClick={() => pickCamera(c.deviceId)} />
                                ))}
                            </>
                        )}
                        {avoid?.enabled && !viewOnly && (
                            <>
                                <Section title="Avoidance senses with" action={sensorBusy ? <Loader2 size={11} className="animate-spin" /> : undefined} />
                                <Item active={sense === 'range'} label="Depth / range sensor when present"
                                    sub="the aircraft's own range data wins (default)" onClick={() => { void setAvoidSensor('range') }} />
                                <Item active={sense === 'camera'} label="This video stream (camera)"
                                    sub="flight mode: ground-calibrated, acts above 8 m" onClick={() => { void setAvoidSensor('camera') }} />
                                <Item active={sense === 'bench'} label="Camera bench test (fixed webcam)"
                                    sub="model metres x the person-ruler scale, camera level ~1 m up - hold things 0.5-3 m away. Not for flight."
                                    onClick={() => { void setAvoidSensor('bench') }} />
                                <Section title="Camera distance calibration" />
                                <PersonCalibration droneId={avoid.drone_id} />
                            </>
                        )}
                    </Menu>
                )}
            </div>
        </div>
    )
}
