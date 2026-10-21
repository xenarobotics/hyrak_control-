'use client'

import { apiFetch } from '@/lib/api'
import { useEffect, useState } from 'react'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { getLocalRelayUrl, setLocalRelayUrl, DEFAULT_LOCAL_RELAY_URL } from '@/lib/localRfRelay'
import { getSiyiTelemetryTarget, setSiyiTelemetryTarget, DEFAULT_SIYI_TELEMETRY_TARGET } from '@/lib/siyiTelemetryRelay'
// The link selection itself lives in a hook, shared with the status bar's
// compact picker - two copies of "which radio is selected" is how the two
// controls end up disagreeing. See hooks/useTelemetryLink.ts.
import { useTelemetryLink, CLOUD_SIM_LINK } from '@/hooks/useTelemetryLink'
import { CloudSimNote } from '@/components/controls/CloudSimNote'
import { BAUD_OPTIONS } from '@/lib/linkSettings'
import { getRfDownlinkPort, getRfUplinkPort, getRfFanoutPort, setRfFanoutPort, isRfUplinkAuto,
         getRfUplinkHost, setRfUplinkHost, DEFAULT_RF_UPLINK_HOST } from '@/lib/rfBridge'
import {
    Select, SelectContent, SelectItem,
    SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { RefreshCw, Camera, Satellite, WifiOff, Wifi, Loader, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getVideoSource, isServerSourced, needsCameraSelection, getAirUnitVideoPort, setAirUnitVideoPort, specFor } from '@/lib/videoSource'
import { getServerUrl } from '@/lib/server-url'
import { visibleInterval } from '@/lib/poll'
import { useHydrated } from '@/hooks/useClientValue'
import Link from 'next/link'
import { useLiveScope } from '@/hooks/useLiveScope'
import { ViewOnlyNote } from '@/components/layout/ViewOnly'
import { FOCUS, DISABLED } from './flightStyles'
import { WhyDisabled } from './WhyDisabled'
import { cameraLabel } from '@/components/video/cameraLabel'

/** `strip`: camera, telemetry and Connect side by side (the Fly page's
 *  one-time setup strip under the video); `stack` (default): one column. */
export function DeviceSelector({ layout = 'stack' }: { layout?: 'stack' | 'strip' } = {}) {
    const mounted = useHydrated()
    const {
        cameras, selectedCameraId: camId, setSelectedCameraId: setCamId,
        isLoading: camLoading, scanCameras: scanCams,
        isStreaming, startStream, stopStream,
    } = useWebRTCContext()

    // Mesh air units: every unit sends to udp 5600 + node id on the ground
    // station, so the backend can tell which are delivering video right now.
    // One tap switches the reader to that unit (a restart of the stream).
    type MeshUnit = { id: number; port: number; live: boolean; in_use: boolean; kbps: number | null; source: string | null }
    const [meshUnits, setMeshUnits] = useState<MeshUnit[]>([])
    const [airPort, setAirPort] = useState(() => getAirUnitVideoPort())
    const [switching, setSwitching] = useState(false)
    const videoSourceNow = getVideoSource()
    useEffect(() => {
        if (videoSourceNow !== 'air_unit_udp') return
        let alive = true
        const poll = async () => {
            try {
                const j = await apiFetch(`${getServerUrl()}/api/video/mesh-units?max_units=8`).then(r => r.json())
                if (alive) setMeshUnits((j.units ?? []).filter((u: MeshUnit) => u.live || u.in_use || u.port === airPort))
            } catch { /* backend away */ }
        }
        poll()
        return () => { alive = false }
    }, [videoSourceNow, airPort])
    useEffect(() => {
        if (videoSourceNow !== 'air_unit_udp') return
        return visibleInterval(async () => {
            try {
                const j = await apiFetch(`${getServerUrl()}/api/video/mesh-units?max_units=8`).then(r => r.json())
                setMeshUnits((j.units ?? []).filter((u: MeshUnit) => u.live || u.in_use || u.port === airPort))
            } catch { /* backend away */ }
        }, 3000)
    }, [videoSourceNow, airPort])
    const pickUnit = async (u: MeshUnit) => {
        if (switching || u.port === airPort) return
        setSwitching(true)
        try {
            setAirUnitVideoPort(u.port)
            setAirPort(u.port)
            if (isStreaming) {
                stopStream()
                await new Promise(r => setTimeout(r, 400))   // let the old reader release the port
                await startStream()
            }
        } finally { setSwitching(false) }
    }

    // Server-sourced feeds (air-unit UDP, SIYI RTSP) don't use a browser
    // camera - the source is picked once in Settings, not per-tab here.
    const [videoSource] = useState(() => getVideoSource())
    const serverSourced = isServerSourced(videoSource)
    // rtsp_camera isn't server-sourced, but it still has no device to pick.
    const needsCamera = needsCameraSelection(videoSource)

    // Telemetry source is a CLIENT device, like the camera: radios plugged
    // into the user's machine, listed by name (QGC-style). The server never
    // has a radio - no server ports. How they're enumerated differs by shell:
    //
    //   browser  "+" opens Chrome's picker; the one-time grant makes the radio
    //            appear here on every future visit, live on plug/unplug.
    //   desktop  every port is listed immediately - no grant, no picker.
    //            Electron ships navigator.serial but no chooser UI behind it,
    //            so "+" opened nothing at all; the native SerialBridge's
    //            list() is used instead (see lib/nativeSerialRelay.ts).
    //
    // Either way this is INDEPENDENT of the video source above: a USB radio
    // for telemetry with a SIYI or HYRAK air-unit feed for video is a normal
    // combination, not a special case.
    const {
        desktop, radios, nativeRadios, options, source, setSource, baud, setBaud,
        refreshNativeRadios, addRadio, browserSerialSupported, serialUnavailable,
        selectedIsFc,
        connect: handleConnect, disconnect: handleDisconnect, disconnecting,
        telemetryStatus, telemetryError, isConnected, isConnecting, sitlNeedsDesktop,
    } = useTelemetryLink()

    // These four are text fields with exactly one editor - this panel - and
    // they are persisted the moment they are typed, so the hook's connect()
    // reads them back from storage rather than being handed them.
    const [relayUrl, setRelayUrl] = useState(() => getLocalRelayUrl())
    const [siyiTarget, setSiyiTarget] = useState(() => getSiyiTelemetryTarget())
    const [rfFanout, setRfFanout] = useState(() => getRfFanoutPort())
    const [rfUplinkHost, setRfUplinkHostState] = useState(() => getRfUplinkHost())
    // Connecting the drone link is a command: viewers watch only
    // (docs/ACCESS_MODEL.md section 8a). The camera above stays theirs.
    const { viewOnly } = useLiveScope()

    const camIdx = cameras.findIndex(c => c.deviceId === camId)
    // The trigger shows the option's label, not its raw value ("sitl", "radio-0").
    const telLabel = source.startsWith('nradio-') ? nativeRadios[Number(source.slice(7))]?.label ?? source
        : source.startsWith('radio-') ? radios[Number(source.slice(6))]?.label ?? source
            : options.find(o => o.value === source)?.label ?? source

    if (!mounted) {
        return <div className={layout === 'strip' ? 'min-h-[72px]' : 'space-y-3 min-h-[190px]'} />
    }

    return (
        <div className={layout === 'strip'
            ? 'grid gap-x-4 gap-y-3 items-start md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(180px,auto)] md:[&>*:nth-child(3)]:mt-[38px] md:[&>*:nth-child(n+4)]:col-span-3'
            : 'space-y-3'}>

            {/* Camera selector - not applicable to server-sourced feeds */}
            <div>
                <div className="flex items-center gap-1.5 mb-1.5 min-h-8">
                    <Camera size={14} className="text-app-text-muted" />
                    <span id="dev-cam-label" className="text-[13px] font-semibold text-app-text-muted">{needsCamera ? 'Camera' : 'Video source'}</span>
                    {needsCamera && (
                        <button
                            onClick={scanCams}
                            className={cn('ml-auto h-8 w-8 flex items-center justify-center rounded-md text-app-text-muted hover:text-app-text hover:bg-app-surface-2 transition-colors duration-[var(--dur-fast)]', FOCUS)}
                            title="Refresh cameras"
                            aria-label="Refresh cameras"
                        >
                            <RefreshCw size={15} className={cn(camLoading && 'animate-spin')} />
                        </button>
                    )}
                </div>

                {!needsCamera ? (
                    <div className="h-9 flex items-center px-2.5 rounded-md text-[14px] bg-app-surface-2 border border-app-border text-app-text-muted truncate">
                        {specFor(videoSource)?.label ?? videoSource} - set in Settings
                    </div>
                ) : (
                    <Select
                            value={camId}
                            onValueChange={(v) => v && setCamId(v)}
                            disabled={cameras.length === 0}
                        >
                            {/* w-full + truncate keeps long webcam labels from
                                widening the side panel into horizontal scroll */}
                            <SelectTrigger aria-labelledby="dev-cam-label" className={cn('data-[size=default]:h-9 w-full max-w-full text-[14px] bg-app-surface border-app-border-strong rounded-md overflow-hidden [&>span]:truncate [&>span]:min-w-0 [&>span]:text-left disabled:opacity-100 data-[disabled]:opacity-100 disabled:border-app-border data-[disabled]:border-app-border disabled:bg-app-surface-2 data-[disabled]:bg-app-surface-2 disabled:text-app-text-subtle data-[disabled]:text-app-text-subtle', FOCUS)}>
                                {/* Show a friendly name, never the raw device id the value holds. */}
                                <SelectValue placeholder={camLoading ? 'Scanning...' : 'No cameras found'}>
                                    {camIdx >= 0 ? cameraLabel(cameras[camIdx].label, camIdx) : (camLoading ? 'Scanning...' : 'No cameras found')}
                                </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                                {cameras.map((cam, i) => (
                                    <SelectItem key={cam.deviceId} value={cam.deviceId} title={cam.label || undefined} className="text-[14px] max-w-[280px] [&>span:last-child]:truncate">
                                        {cameraLabel(cam.label, i)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                )}
                {videoSourceNow === 'air_unit_udp' && meshUnits.length > 0 && (
                    <div className="mt-1.5">
                        <div className="text-[13px] font-semibold text-app-text-muted mb-1" title="Port 5600 + unit id">Mesh units</div>
                        <div className="flex flex-wrap gap-1.5">
                            {meshUnits.map(u => {
                                const active = u.port === airPort
                                return (
                                    <button key={u.id} onClick={() => pickUnit(u)} disabled={switching || !u.live && !u.in_use}
                                        title={`udp ${u.port}${u.source ? ` from ${u.source}` : ''}${u.kbps ? ` - ${u.kbps} kbit/s` : ''}${u.in_use ? ' - on screen' : ''}`}
                                        aria-pressed={active}
                                        className={cn('h-8 px-2.5 rounded-full border text-[13px] font-semibold flex items-center gap-1.5 disabled:border-app-border disabled:bg-app-surface-2 disabled:text-app-text-subtle disabled:cursor-not-allowed', FOCUS,
                                            active ? 'border-app-accent bg-app-accent-soft text-app-selected-ink' : 'border-app-border-strong bg-app-surface text-app-text')}>
                                        <span className={cn('w-2 h-2 rounded-full', (u.live || u.in_use) ? 'bg-app-ok' : 'bg-app-text-subtle')} />
                                        {u.id === 0 ? 'Sim / 5600' : `Unit ${u.id}`}{u.kbps ? <span className="text-app-text-muted">{u.kbps} k</span> : null}
                                    </button>
                                )
                            })}
                        </div>
                    </div>
                )}
            </div>

            {/* Telemetry source - detected client radios (like the camera) or SITL */}
            <div>
                <div className="flex items-center gap-1.5 mb-1.5 min-h-8">
                    <Satellite size={14} className="text-app-text-muted" />
                    <span id="dev-tel-label" className="text-[13px] font-semibold text-app-text-muted">Telemetry</span>
                    {/* Desktop needs no grant, so "+" (which opens nothing in
                        Electron) is replaced by a plain re-scan. */}
                    {desktop ? (
                        <button
                            onClick={() => { void refreshNativeRadios() }}
                            className={cn('ml-auto h-8 w-8 flex items-center justify-center rounded-md text-app-text-muted hover:text-app-text hover:bg-app-surface-2 transition-colors duration-[var(--dur-fast)]', FOCUS)}
                            title="Re-scan serial ports on this device"
                            aria-label="Re-scan serial ports"
                        >
                            <RefreshCw size={15} />
                        </button>
                    ) : browserSerialSupported && (
                        <button
                            onClick={addRadio}
                            className={cn('ml-auto h-8 w-8 flex items-center justify-center rounded-md text-app-text-muted hover:text-app-text hover:bg-app-surface-2 transition-colors duration-[var(--dur-fast)]', FOCUS)}
                            title="Add a USB radio or flight controller plugged into this device"
                            aria-label="Add a USB radio"
                        >
                            <Plus size={16} />
                        </button>
                    )}
                </div>

                {/* WHY THERE IS NO "+" TO PRESS. Hiding the control left a
                    flight controller that works in the desktop app looking
                    simply unsupported in the browser, and the usual cause is
                    the page's ORIGIN rather than the browser. */}
                {serialUnavailable && (
                    <p className="text-[13px] text-app-warn leading-snug mb-1.5 break-words">
                        {serialUnavailable}
                    </p>
                )}

                <Select
                    value={source}
                    onValueChange={(v) => v && setSource(v)}
                    disabled={isConnected}
                >
                    <SelectTrigger aria-labelledby="dev-tel-label" className={cn('data-[size=default]:h-9 w-full max-w-full text-[14px] bg-app-surface border-app-border-strong rounded-md overflow-hidden [&>span]:truncate [&>span]:min-w-0 [&>span]:text-left disabled:opacity-100 data-[disabled]:opacity-100 disabled:border-app-border data-[disabled]:border-app-border disabled:bg-app-surface-2 data-[disabled]:bg-app-surface-2 disabled:text-app-text-subtle data-[disabled]:text-app-text-subtle', FOCUS)}>
                        <SelectValue>{telLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        {nativeRadios.map((radio, i) => (
                            <SelectItem
                                key={`nradio-${i}`}
                                value={`nradio-${i}`}
                                className="text-[14px] max-w-[280px] [&>span:last-child]:truncate"
                            >
                                {radio.label}
                            </SelectItem>
                        ))}
                        {radios.map((radio, i) => (
                            <SelectItem
                                key={`radio-${i}`}
                                value={`radio-${i}`}
                                className="text-[14px] max-w-[280px] [&>span:last-child]:truncate"
                            >
                                {radio.label}
                            </SelectItem>
                        ))}
                        {/* The non-radio links come from the hook's single
                            option list, so this select can never drift from
                            LinkCluster / the status bar. The hand-written
                            copy here had lost "Gazebo sim on server"
                            (udp:14600), which is a separate link from
                            "SITL" (the desktop relay on udp:14540) and must
                            stay one: a remote client cannot reach a desktop
                            SITL through the server-side link. */}
                        {options
                            .filter(o => !o.value.startsWith('radio-') && !o.value.startsWith('nradio-'))
                            .map(o => (
                                <SelectItem key={o.value} value={o.value} disabled={o.disabled} className="text-[14px]">
                                    {o.label}
                                </SelectItem>
                            ))}
                    </SelectContent>
                </Select>
                {/* Baud only applies to a real serial radio. 57600 is the SiK
                    default and what PX4's TELEM ports ship at; 115200 is the
                    other one people actually hit. */}
                {selectedIsFc && (
                    <p className="mt-1.5 text-[13px] text-app-text-muted leading-snug">
                        Flight controller over USB - the baud rate is ignored by
                        the CDC serial link, so there is nothing to match.
                    </p>
                )}
                {!selectedIsFc && (source.startsWith('radio-') || source.startsWith('nradio-')) && (
                    <div className="mt-1.5 flex items-center gap-1.5">
                        <span className="text-[13px] font-semibold text-app-text-muted">Baud</span>
                        <Select
                            value={String(baud)}
                            onValueChange={(v) => { if (v) setBaud(Number(v)) }}
                            disabled={isConnected}
                        >
                            <SelectTrigger aria-label="Baud rate" className={cn('flex-1 data-[size=default]:h-9 w-full max-w-full text-[14px] bg-app-surface border-app-border-strong rounded-md overflow-hidden [&>span]:truncate [&>span]:min-w-0 [&>span]:text-left disabled:opacity-100 data-[disabled]:opacity-100 disabled:border-app-border data-[disabled]:border-app-border disabled:bg-app-surface-2 data-[disabled]:bg-app-surface-2 disabled:text-app-text-subtle data-[disabled]:text-app-text-subtle', FOCUS)}>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {BAUD_OPTIONS.map(b => (
                                    <SelectItem key={b} value={String(b)} className="text-[14px]">
                                        {b}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                )}
                {desktop && nativeRadios.length === 0 && (
                    <p className="mt-1.5 text-[13px] text-app-text-muted leading-snug">
                        No serial ports found. Plug the radio in and hit refresh - on Linux you
                        may also need to be in the <span className="font-code text-app-text">dialout</span> group.
                    </p>
                )}
                {source === 'air-unit-udp' && (
                    <>
                        <p className="mt-1.5 text-[13px] text-app-text-muted leading-snug">
                            Reads udp:{getRfDownlinkPort()} / {isRfUplinkAuto(rfUplinkHost)
                                ? 'replies to whoever sends (QGC style)'
                                : `sends to ${rfUplinkHost}:${getRfUplinkPort()}`} -
                            no relay agent needed. Just run start-gs.sh.
                        </p>
                        {/* THE SETTING THAT COSTS A FLIGHT WHEN IT IS WRONG, and
                            it used to be a literal in the code. Downlink needs no
                            address - it is a bind, so it hears whoever sends. The
                            uplink is a send TO somewhere, and if that somewhere is
                            this PC while wfb_tx runs on a decoder board, every
                            command vanishes into loopback with no error anywhere
                            and telemetry keeps streaming perfectly. */}
                        <div className="mt-1.5 flex items-center gap-1.5">
                            <span className="text-[13px] font-semibold text-app-text-muted shrink-0 w-[72px]">TX host</span>
                            <input
                                value={rfUplinkHost}
                                onChange={e => {
                                    setRfUplinkHostState(e.target.value)
                                    setRfUplinkHost(e.target.value)
                                }}
                                disabled={isConnected}
                                placeholder={`${DEFAULT_RF_UPLINK_HOST} or auto`}
                                title="Where commands are sent. wfb-ng: the decoder running wfb_tx (this machine only if the decoder runs here - otherwise commands go nowhere while telemetry keeps working). 'auto': reply to the sender, like QGroundControl - use for SITL or a single-process ground station. Editable only while disconnected."
                                className="h-9 w-full rounded-md px-2.5 text-[14px] bg-app-surface border border-app-border-strong text-app-text outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app-bg disabled:bg-app-surface-2 disabled:text-app-text-subtle disabled:border-app-border font-code"
                            />
                        </div>
                        <div className="mt-1.5 flex items-center gap-1.5">
                            <span className="text-[13px] font-semibold text-app-text-muted shrink-0 w-[72px]">QGC port</span>
                            <input
                                type="number"
                                min={0}
                                max={65535}
                                value={rfFanout}
                                onChange={e => {
                                    const v = Number(e.target.value)
                                    setRfFanout(v)
                                    // Never the uplink port: the fan-out would feed the
                                    // aircraft its own telemetry and drown every command.
                                    if (v >= 0 && v < 65536 && v !== getRfUplinkPort()) setRfFanoutPort(v)
                                }}
                                disabled={isConnected}
                                className="h-9 w-full rounded-md px-2.5 text-[14px] bg-app-surface border border-app-border-strong text-app-text outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app-bg disabled:bg-app-surface-2 disabled:text-app-text-subtle disabled:border-app-border font-code"
                            />
                        </div>
                        <p className="mt-1 text-[13px] text-app-text-muted leading-snug">
                            {rfFanout === getRfUplinkPort()
                                ? `${rfFanout} is the uplink port - a copy of the downlink sent there goes straight back into the aircraft. Use another port, or 0.`
                                : rfFanout > 0
                                ? `Copy of the downlink sent to udp:${rfFanout} - point QGC's UDP link at that port instead of ${getRfDownlinkPort()} (only one program can own a port). Downlink only: QGC can read params and download the mission, but cannot command the aircraft through this.`
                                : `0 = off. Set a port (e.g. ${getRfDownlinkPort() + 2}) to let QGroundControl watch the same telemetry alongside HYRAK.`}
                        </p>
                    </>
                )}
                {source === CLOUD_SIM_LINK && (
                    <CloudSimNote entitled={!options.find(o => o.value === CLOUD_SIM_LINK)?.disabled}
                        className="mt-1.5 text-[13px] text-app-text-muted leading-snug" />
                )}
                {source === 'local-relay' && (
                    <input
                        value={relayUrl}
                        onChange={e => { setRelayUrl(e.target.value); setLocalRelayUrl(e.target.value) }}
                        disabled={isConnected}
                        placeholder={DEFAULT_LOCAL_RELAY_URL}
                        className="mt-1.5 h-9 w-full rounded-md px-2.5 text-[14px] bg-app-surface border border-app-border-strong text-app-text outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app-bg disabled:bg-app-surface-2 disabled:text-app-text-subtle disabled:border-app-border font-code"
                    />
                )}
                {source === 'siyi-udp' && (
                    <>
                        <input
                            value={siyiTarget}
                            onChange={e => { setSiyiTarget(e.target.value); setSiyiTelemetryTarget(e.target.value) }}
                            disabled={isConnected}
                            placeholder={DEFAULT_SIYI_TELEMETRY_TARGET}
                            className="mt-1.5 h-9 w-full rounded-md px-2.5 text-[14px] bg-app-surface border border-app-border-strong text-app-text outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app-bg disabled:bg-app-surface-2 disabled:text-app-text-subtle disabled:border-app-border font-code"
                        />
                        <p className="mt-1 text-[13px] text-app-text-muted leading-snug">
                            Target host:port, same as QGC&apos;s UDP link. Local port is ephemeral - the ground unit replies to us.
                        </p>
                    </>
                )}
                {sitlNeedsDesktop && (
                    <p className="mt-1.5 text-[13px] text-app-text-muted leading-snug">
                        SITL requires the HYRAK desktop app - <Link href="/" className="underline font-semibold text-app-accent rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent">download it here</Link>, then connect to the PX4 SITL running on your machine.
                    </p>
                )}
            </div>

            {/* Connect / Disconnect.
                THE CONNECTED STATE HAD NO WAY OUT. This button showed
                "CONNECTED" and still called handleConnect, so the only thing
                a connected operator could do here was connect again - and
                releasing the radio (to hand it to QGC, to power-cycle it, to
                switch sources) meant reloading the page. Settings has always
                had a Disconnect, and its own help text claimed the link
                "can be released from here or from the Fly tab", which was
                simply not true. Now it is. */}
            {isConnected ? (
                <div className="flex gap-2">
                    <div className="flex-1 flex items-center justify-center gap-2 rounded-md border border-app-ok bg-app-ok-soft text-app-ok text-[13px] font-bold h-9">
                        <Wifi size={15} /> Connected
                    </div>
                    <Button
                        size="sm"
                        variant="outline"
                        className={cn('h-9 rounded-md text-[13px] font-bold gap-2 text-app-text', FOCUS, DISABLED)}
                        disabled={disconnecting}
                        onClick={handleDisconnect}
                        title="Release the drone link and stop whichever local relay owns the radio"
                    >
                        {disconnecting
                            ? <><Loader size={12} className="animate-spin" /> …</>
                            : <><WifiOff size={15} /> Disconnect</>}
                    </Button>
                </div>
            ) : viewOnly ? (
                <ViewOnlyNote />
            ) : (
                <WhyDisabled reason={isConnecting ? 'Connecting' : sitlNeedsDesktop ? 'SITL needs the HYRAK desktop app' : null}>
                    <Button
                        size="sm"
                        className={cn('w-full h-9 rounded-md text-[14px] font-bold gap-2 bg-app-accent text-[var(--app-accent-ink)] hover:bg-app-accent hover:brightness-110', FOCUS, DISABLED)}
                        disabled={isConnecting || sitlNeedsDesktop}
                        onClick={handleConnect}
                    >
                        {isConnecting
                            ? <><Loader size={15} className="animate-spin" /> Connecting...</>
                            : <><Wifi size={15} /> Connect telemetry</>
                        }
                    </Button>
                </WhyDisabled>
            )}

            {/* Why the last attempt failed - a silent spinner-stop tells the
                operator nothing; the actual reason always does. */}
            {telemetryError && !isConnected && !isConnecting && (
                <p role="alert" className="text-[13px] text-app-danger leading-snug break-words">
                    {telemetryError}
                </p>
            )}

        </div>
    )
}