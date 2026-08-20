'use client'

// Video and telemetry pickers, inside the status bar.
//
// WHY THEY ARE HERE AND NOT ONLY ON FLY. Retasking a vehicle mid-session —
// swap to the gimbal camera, move the radio to another port — meant leaving
// whatever you were doing on Mission or AI, walking to Fly, changing one
// dropdown, and walking back. On a live job that is a page change in the
// middle of the thing the page change interrupts.
//
// OPT-IN, off by default (Settings -> Status bar -> Link controls). These are
// setup controls, and setup controls sitting permanently beside a KILL button
// are clutter on the flights that never touch them.
//
// The selection itself is NOT owned here. It comes from useTelemetryLink,
// shared with the Fly tab's DeviceSelector, so the two can never show
// different answers to "which radio".

import { useEffect, useRef, useState } from 'react'

import { useTelemetryLink } from '@/hooks/useTelemetryLink'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import {
    getVideoSource, setVideoSource, needsCameraSelection, type VideoSource,
    VIDEO_SOURCES, SOURCE_GROUPS,
} from '@/lib/videoSource'
import { isDesktopApp } from '@/lib/nativeBridge'
import { Camera, Satellite, Plug, PlugZap, Loader, RefreshCw, Plus } from 'lucide-react'

const selectStyle: React.CSSProperties = {
    height: 26, maxWidth: 150, padding: '0 6px', borderRadius: 7,
    background: 'hsl(var(--app-surface-2))',
    border: '1px solid hsl(var(--app-border))',
    color: 'hsl(var(--app-text))',
    fontSize: 11, fontFamily: 'monospace', cursor: 'pointer',
    textOverflow: 'ellipsis',
}

function Label({ icon, text }: { icon: React.ReactNode; text: string }) {
    return (
        <span style={{
            display: 'flex', alignItems: 'center', gap: 4,
            fontSize: 10, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))',
            whiteSpace: 'nowrap',
        }}>
            {icon}{text}
        </span>
    )
}

function IconButton({ onClick, title, children }: {
    onClick: () => void; title: string; children: React.ReactNode
}) {
    return (
        <button
            onClick={onClick}
            title={title}
            style={{
                display: 'flex', alignItems: 'center', padding: 3, borderRadius: 5,
                background: 'transparent', border: 'none',
                color: 'hsl(var(--app-text-muted))', cursor: 'pointer',
            }}
        >
            {children}
        </button>
    )
}

export function StatusBarLinks() {
    const {
        desktop, options, source, setSource,
        refreshRadios, refreshNativeRadios, addRadio, browserSerialSupported,
        connect, disconnect, disconnecting, isConnected, isConnecting,
        sitlNeedsDesktop,
    } = useTelemetryLink()

    const {
        cameras, selectedCameraId, setSelectedCameraId, scanCameras,
        isStreaming, startStream, stopStream,
    } = useWebRTCContext()

    // Read on mount rather than during render: getVideoSource touches
    // localStorage, which does not exist while the server renders this.
    const [videoSource, setVideoSourceState] = useState<VideoSource>('camera')
    useEffect(() => { setVideoSourceState(getVideoSource()) }, [])

    // CHANGING THE SOURCE OF A RUNNING STREAM MEANS RESTARTING IT. Nothing
    // reads these values after a stream has started — the source decides what
    // goes in the WebRTC offer and the camera id decides which device is
    // opened, both at start time. Elsewhere in the app the control is simply
    // DISABLED while streaming, which is honest but useless here: changing the
    // camera without leaving the AI page is the entire reason this exists. So
    // the restart is done explicitly, and the operator is told it will happen.
    // Held so a SECOND change cancels the first restart instead of racing it.
    // Without this, changing source and then camera within the delay fires two
    // startStream calls at a backend that has torn the session down once — the
    // second offer arrives against a half-built session and the feed wedges,
    // which is worse than the state the operator was trying to leave.
    const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(() => () => { if (restartTimer.current) clearTimeout(restartTimer.current) }, [])

    const restart = () => {
        if (!isStreaming) return
        if (restartTimer.current) clearTimeout(restartTimer.current)
        stopStream()
        // One tick is not enough. stopStream tears down the PeerConnection
        // locally and emits stop_stream; the backend has to have finished with
        // the old session before it will accept a new offer from the same
        // client, and that round trip is what this waits for.
        restartTimer.current = setTimeout(() => {
            restartTimer.current = null
            void startStream()
        }, 600)
    }

    const changeVideoSource = (v: VideoSource) => {
        setVideoSourceState(v)
        setVideoSource(v)
        restart()
    }

    const changeCamera = (id: string) => {
        setSelectedCameraId(id)
        restart()
    }

    const needsCamera = needsCameraSelection(videoSource)
    const desktopApp = isDesktopApp()

    return (
        <>
            <Label icon={<Camera size={11} />} text="VIDEO" />
            <select
                value={videoSource}
                onChange={e => changeVideoSource(e.target.value as VideoSource)}
                style={selectStyle}
                title={isStreaming
                    ? 'Changing the video source restarts the running stream'
                    : 'Where the video feed comes from. The full list is in Settings.'}
            >
                {/* THE SAME CATALOGUE SETTINGS RENDERS, not a shortlist.
                    A hand-written subset here would omit whichever source is
                    added next — and the operator would find it selectable in
                    Settings, working, and absent from the bar. That exact bug
                    has already been shipped once in this app, which is why the
                    catalogue is data (see lib/videoSource.ts). */}
                {SOURCE_GROUPS.map(group => (
                    <optgroup key={group} label={group}>
                        {VIDEO_SOURCES.filter(v => v.group === group).map(v => (
                            <option key={v.value} value={v.value}>
                                {v.label}{v.desktopOnly && !desktopApp ? '  (desktop)' : ''}
                            </option>
                        ))}
                    </optgroup>
                ))}
            </select>

            {needsCamera && (
                <>
                    <select
                        value={selectedCameraId}
                        onChange={e => changeCamera(e.target.value)}
                        style={selectStyle}
                        title={isStreaming
                            ? 'Changing the camera restarts the running stream'
                            : 'Which camera on this machine'}
                    >
                        {cameras.length === 0 && <option value="">No cameras</option>}
                        {cameras.map(c => (
                            <option key={c.deviceId} value={c.deviceId}>{c.label}</option>
                        ))}
                    </select>
                    <IconButton onClick={scanCameras} title="Re-scan cameras on this device">
                        <RefreshCw size={11} />
                    </IconButton>
                </>
            )}

            <Label icon={<Satellite size={11} />} text="LINK" />
            <select
                value={source}
                onChange={e => setSource(e.target.value)}
                disabled={isConnected}
                style={{ ...selectStyle, opacity: isConnected ? 0.5 : 1 }}
                title={isConnected
                    ? 'Disconnect before changing the telemetry link'
                    : 'Which radio or bridge carries telemetry'}
            >
                {options.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                ))}
            </select>

            {/* Enumerating differs by shell, exactly as on the Fly tab:
                desktop lists every port outright, the browser needs a one-time
                grant through Chrome's picker. */}
            {desktop ? (
                <IconButton onClick={() => { void refreshNativeRadios() }} title="Re-scan serial ports">
                    <RefreshCw size={11} />
                </IconButton>
            ) : browserSerialSupported && (
                <IconButton onClick={() => { void addRadio() }} title="Add a USB radio plugged into this device">
                    <Plus size={12} />
                </IconButton>
            )}
            {!desktop && !browserSerialSupported && (
                <IconButton onClick={() => { void refreshRadios() }} title="Re-scan radios">
                    <RefreshCw size={11} />
                </IconButton>
            )}

            <button
                onClick={isConnected ? () => { void disconnect() } : connect}
                disabled={isConnecting || disconnecting || (!isConnected && sitlNeedsDesktop)}
                title={sitlNeedsDesktop && !isConnected
                    ? 'SITL needs the desktop app — a browser tab cannot reach udp:14540'
                    : isConnected ? 'Disconnect telemetry' : 'Connect telemetry'}
                style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '5px 10px', borderRadius: 7,
                    fontSize: 11, fontFamily: 'monospace', fontWeight: 600,
                    background: 'transparent',
                    border: `1px solid ${isConnected ? '#f8717160' : '#4ade8060'}`,
                    color: isConnected ? '#f87171' : '#4ade80',
                    cursor: 'pointer', whiteSpace: 'nowrap',
                    opacity: (isConnecting || disconnecting || (!isConnected && sitlNeedsDesktop)) ? 0.4 : 1,
                }}
            >
                {isConnecting || disconnecting
                    ? <><Loader size={12} className="animate-spin" />{isConnecting ? 'LINKING' : 'CLOSING'}</>
                    : isConnected
                        ? <><PlugZap size={12} /> DROP</>
                        : <><Plug size={12} /> LINK</>}
            </button>
        </>
    )
}
