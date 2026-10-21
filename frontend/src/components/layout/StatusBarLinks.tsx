'use client'

// Video and telemetry pickers, inside the status bar.
//
// WHY THEY ARE HERE AND NOT ONLY ON FLY. Retasking a vehicle mid-session -
// swap to the gimbal camera, move the radio to another port - meant leaving
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
    videoSourcesFor, sourceGroupsFor,
} from '@/lib/videoSource'
import { useAccess } from '@/hooks/useAccess'
import { useLiveScope } from '@/hooks/useLiveScope'
import { VIEW_ONLY_TEXT } from '@/components/layout/ViewOnly'
import { isDesktopApp } from '@/lib/nativeBridge'
import { Camera, Satellite, Plug, PlugZap, Loader, RefreshCw, Plus } from 'lucide-react'
import { useClientValue } from '@/hooks/useClientValue'
import {
    Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue, SimpleSelect,
} from '@/components/ui/select'

// The shared Select, sized for the bar.
const SELECT_CLS = 'shrink-0 data-[size=default]:h-9 max-w-[150px] text-[13px] bg-app-surface-2'

function Label({ icon, text }: { icon: React.ReactNode; text: string }) {
    return (
        <span style={{
            display: 'flex', alignItems: 'center', gap: 4,
            fontSize: 13, fontWeight: 600, color: 'hsl(var(--app-text-muted))',
            whiteSpace: 'nowrap', flexShrink: 0,
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
            type="button"
            onClick={onClick}
            title={title}
            aria-label={title}
            style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                width: 32, height: 32, borderRadius: 6,
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
    // Customer-only accounts get the customer-safe sources (lib/videoSource).
    const { isCustomer } = useAccess()
    const catalogue = videoSourcesFor(isCustomer)
    // Connecting the drone link is a command: viewers watch only.
    const { viewOnly } = useLiveScope()
    const linkBlocked = !isConnected && (sitlNeedsDesktop || viewOnly)

    const {
        cameras, selectedCameraId, setSelectedCameraId, scanCameras,
        isStreaming, startStream, stopStream,
    } = useWebRTCContext()

    // getVideoSource touches localStorage, which does not exist while the
    // server renders this - read hydration-safely.
    // A pick made here overrides the stored value for this component's life.
    const savedSource: VideoSource = useClientValue(getVideoSource, 'camera')
    const [pickedSource, setVideoSourceState] = useState<VideoSource | null>(null)
    const videoSource = pickedSource ?? savedSource

    // CHANGING THE SOURCE OF A RUNNING STREAM MEANS RESTARTING IT. Nothing
    // reads these values after a stream has started - the source decides what
    // goes in the WebRTC offer and the camera id decides which device is
    // opened, both at start time. Elsewhere in the app the control is simply
    // DISABLED while streaming, which is honest but useless here: changing the
    // camera without leaving the AI page is the entire reason this exists. So
    // the restart is done explicitly, and the operator is told it will happen.
    // Held so a SECOND change cancels the first restart instead of racing it.
    // Without this, changing source and then camera within the delay fires two
    // startStream calls at a backend that has torn the session down once - the
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
            <Label icon={<Camera size={14} />} text="Video" />
            <Select value={videoSource} onValueChange={v => { if (v != null && v !== videoSource) changeVideoSource(v as VideoSource) }}>
                <SelectTrigger aria-label="Video source" className={SELECT_CLS}
                    title={isStreaming
                        ? 'Changing the video source restarts the running stream'
                        : 'Where the video feed comes from. The full list is in Settings.'}>
                    <SelectValue className="min-w-0 truncate">
                        {catalogue.find(v => v.value === videoSource)?.label ?? videoSource}
                    </SelectValue>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} align="start" className="w-auto min-w-(--anchor-width)">
                    {/* THE SAME CATALOGUE SETTINGS RENDERS, not a shortlist.
                        A hand-written subset here would omit whichever source is
                        added next - and the operator would find it selectable in
                        Settings, working, and absent from the bar. That exact bug
                        has already been shipped once in this app, which is why the
                        catalogue is data (see lib/videoSource.ts). */}
                    {sourceGroupsFor(isCustomer).map(group => (
                        <SelectGroup key={group}>
                            <SelectLabel>{group}</SelectLabel>
                            {catalogue.filter(v => v.group === group).map(v => (
                                <SelectItem key={v.value} value={v.value}>
                                    {v.label}{v.desktopOnly && !desktopApp ? '  (desktop)' : ''}
                                </SelectItem>
                            ))}
                        </SelectGroup>
                    ))}
                </SelectContent>
            </Select>

            {needsCamera && (
                <>
                    <SimpleSelect
                        value={selectedCameraId}
                        onValueChange={changeCamera}
                        ariaLabel="Camera"
                        className={SELECT_CLS}
                        title={isStreaming
                            ? 'Changing the camera restarts the running stream'
                            : 'Which camera on this machine'}
                        placeholder="No cameras"
                        options={cameras.map(c => ({ value: c.deviceId, label: c.label }))}
                    />
                    <IconButton onClick={scanCameras} title="Re-scan cameras on this device">
                        <RefreshCw size={14} />
                    </IconButton>
                </>
            )}

            <Label icon={<Satellite size={14} />} text="Link" />
            <SimpleSelect
                value={source}
                onValueChange={setSource}
                disabled={isConnected}
                ariaLabel="Telemetry link"
                className={SELECT_CLS}
                title={isConnected
                    ? 'Disconnect before changing the telemetry link'
                    : 'Which radio or bridge carries telemetry'}
                options={options.map(o => ({ value: o.value, label: o.label, disabled: o.disabled, title: o.note }))}
            />

            {/* Enumerating differs by shell, exactly as on the Fly tab:
                desktop lists every port outright, the browser needs a one-time
                grant through Chrome's picker. */}
            {desktop ? (
                <IconButton onClick={() => { void refreshNativeRadios() }} title="Re-scan serial ports">
                    <RefreshCw size={14} />
                </IconButton>
            ) : browserSerialSupported && (
                <IconButton onClick={() => { void addRadio() }} title="Add a USB radio plugged into this device">
                    <Plus size={16} />
                </IconButton>
            )}
            {!desktop && !browserSerialSupported && (
                <IconButton onClick={() => { void refreshRadios() }} title="Re-scan radios">
                    <RefreshCw size={14} />
                </IconButton>
            )}

            <button
                onClick={isConnected ? () => { void disconnect() } : connect}
                disabled={isConnecting || disconnecting || linkBlocked}
                title={viewOnly && !isConnected ? VIEW_ONLY_TEXT
                    : sitlNeedsDesktop && !isConnected
                    ? 'SITL needs the desktop app - a browser tab cannot reach udp:14540'
                    : isConnected ? 'Disconnect telemetry' : 'Connect telemetry'}
                style={{
                    display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                    height: 36, padding: '0 10px', borderRadius: 6,
                    fontSize: 13, fontWeight: 700,
                    background: linkBlocked ? 'hsl(var(--app-surface-2))' : 'transparent',
                    border: linkBlocked ? '1px solid hsl(var(--app-border))'
                        : `1px solid ${isConnected ? 'var(--app-danger)' : 'var(--app-ok)'}`,
                    color: linkBlocked ? 'hsl(var(--app-text-subtle))' : isConnected ? 'var(--app-danger)' : 'var(--app-ok)',
                    cursor: linkBlocked ? 'not-allowed' : (isConnecting || disconnecting) ? 'progress' : 'pointer', whiteSpace: 'nowrap',
                }}
            >
                {isConnecting || disconnecting
                    ? <><Loader size={14} className="animate-spin" />{isConnecting ? 'Connecting' : 'Disconnecting'}</>
                    : isConnected
                        ? <><PlugZap size={14} /> Disconnect</>
                        : <><Plug size={14} /> Connect</>}
            </button>
        </>
    )
}
