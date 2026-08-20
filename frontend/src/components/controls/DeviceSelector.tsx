'use client'

import { useEffect, useState } from 'react'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { getLocalRelayUrl, setLocalRelayUrl, DEFAULT_LOCAL_RELAY_URL } from '@/lib/localRfRelay'
import { getSiyiTelemetryTarget, setSiyiTelemetryTarget, DEFAULT_SIYI_TELEMETRY_TARGET } from '@/lib/siyiTelemetryRelay'
// The link selection itself lives in a hook, shared with the status bar's
// compact picker — two copies of "which radio is selected" is how the two
// controls end up disagreeing. See hooks/useTelemetryLink.ts.
import { useTelemetryLink } from '@/hooks/useTelemetryLink'
import { getRfDownlinkPort, getRfUplinkPort, getRfFanoutPort, setRfFanoutPort,
         getRfUplinkHost, setRfUplinkHost, DEFAULT_RF_UPLINK_HOST } from '@/lib/rfBridge'
import {
    Select, SelectContent, SelectItem,
    SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { RefreshCw, Camera, Satellite, WifiOff, Wifi, Loader, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getVideoSource, isServerSourced, needsCameraSelection } from '@/lib/videoSource'

const SOURCE_LABELS: Record<string, string> = {
    air_unit_udp: 'Air unit (UDP) — set in Settings',
    siyi_rtsp: 'SIYI (RTSP) — set in Settings',
    rtsp_relay: 'RTSP relay (this machine) — set in Settings',
    rtsp_camera: 'RTSP as camera — set in Settings',
}

export function DeviceSelector() {
    const [mounted, setMounted] = useState(false)
    useEffect(() => { setMounted(true) }, [])
    const {
        cameras, selectedCameraId: camId, setSelectedCameraId: setCamId,
        isLoading: camLoading, scanCameras: scanCams
    } = useWebRTCContext()

    // Server-sourced feeds (air-unit UDP, SIYI RTSP) don't use a browser
    // camera — the source is picked once in Settings, not per-tab here.
    const [videoSource] = useState(() => getVideoSource())
    const serverSourced = isServerSourced(videoSource)
    // rtsp_camera isn't server-sourced, but it still has no device to pick.
    const needsCamera = needsCameraSelection(videoSource)

    // Telemetry source is a CLIENT device, like the camera: radios plugged
    // into the user's machine, listed by name (QGC-style). The server never
    // has a radio — no server ports. How they're enumerated differs by shell:
    //
    //   browser  "+" opens Chrome's picker; the one-time grant makes the radio
    //            appear here on every future visit, live on plug/unplug.
    //   desktop  every port is listed immediately — no grant, no picker.
    //            Electron ships navigator.serial but no chooser UI behind it,
    //            so "+" opened nothing at all; the native SerialBridge's
    //            list() is used instead (see lib/nativeSerialRelay.ts).
    //
    // Either way this is INDEPENDENT of the video source above: a USB radio
    // for telemetry with a SIYI or HYRAK air-unit feed for video is a normal
    // combination, not a special case.
    const {
        desktop, radios, nativeRadios, source, setSource, baud, setBaud,
        refreshNativeRadios, addRadio, browserSerialSupported, serialUnavailable,
        selectedIsFc,
        connect: handleConnect, disconnect: handleDisconnect, disconnecting,
        telemetryStatus, telemetryError, isConnected, isConnecting, sitlNeedsDesktop,
    } = useTelemetryLink()

    // These four are text fields with exactly one editor — this panel — and
    // they are persisted the moment they are typed, so the hook's connect()
    // reads them back from storage rather than being handed them.
    const [relayUrl, setRelayUrl] = useState(() => getLocalRelayUrl())
    const [siyiTarget, setSiyiTarget] = useState(() => getSiyiTelemetryTarget())
    const [rfFanout, setRfFanout] = useState(() => getRfFanoutPort())
    const [rfUplinkHost, setRfUplinkHostState] = useState(() => getRfUplinkHost())

    if (!mounted) {
        return <div className="space-y-3 min-h-[190px]" />
    }

    return (
        <div className="space-y-3">

            {/* Camera selector — not applicable to server-sourced feeds */}
            <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                    <Camera size={12} className="text-zinc-500" />
                    <span className="text-xs text-zinc-500 font-mono">{needsCamera ? 'CAMERA' : 'VIDEO SOURCE'}</span>
                    {needsCamera && (
                        <button
                            onClick={scanCams}
                            className="ml-auto text-zinc-600 hover:text-zinc-400 transition-colors"
                            title="Refresh cameras"
                        >
                            <RefreshCw size={11} className={cn(camLoading && 'animate-spin')} />
                        </button>
                    )}
                </div>

                {!needsCamera ? (
                    <div className="h-8 flex items-center px-2 rounded text-xs font-mono bg-zinc-900 border border-zinc-700 text-zinc-500 truncate">
                        {SOURCE_LABELS[videoSource]}
                    </div>
                ) : (
                    <Select
                            value={camId}
                            onValueChange={(v) => v && setCamId(v)}
                            disabled={cameras.length === 0}
                        >
                            {/* w-full + truncate keeps long webcam labels from
                                widening the side panel into horizontal scroll */}
                            <SelectTrigger className="h-8 w-full max-w-full text-xs font-mono bg-zinc-900 border-zinc-700 overflow-hidden [&>span]:truncate [&>span]:min-w-0 [&>span]:text-left">
                                <SelectValue placeholder={camLoading ? 'Scanning...' : 'No cameras found'} />
                            </SelectTrigger>
                            <SelectContent>
                                {cameras.map(cam => (
                                    <SelectItem key={cam.deviceId} value={cam.deviceId} className="text-xs font-mono max-w-[280px] [&>span:last-child]:truncate">
                                        {cam.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                )}
            </div>

            {/* Telemetry source — detected client radios (like the camera) or SITL */}
            <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                    <Satellite size={12} className="text-zinc-500" />
                    <span className="text-xs text-zinc-500 font-mono">TELEMETRY</span>
                    {/* Desktop needs no grant, so "+" (which opens nothing in
                        Electron) is replaced by a plain re-scan. */}
                    {desktop ? (
                        <button
                            onClick={() => { void refreshNativeRadios() }}
                            className="ml-auto text-zinc-600 hover:text-zinc-400 transition-colors"
                            title="Re-scan serial ports on this device"
                        >
                            <RefreshCw size={11} />
                        </button>
                    ) : browserSerialSupported && (
                        <button
                            onClick={addRadio}
                            className="ml-auto text-zinc-600 hover:text-zinc-400 transition-colors"
                            title="Add a USB radio or flight controller plugged into this device"
                        >
                            <Plus size={12} />
                        </button>
                    )}
                </div>

                {/* WHY THERE IS NO "+" TO PRESS. Hiding the control left a
                    flight controller that works in the desktop app looking
                    simply unsupported in the browser, and the usual cause is
                    the page's ORIGIN rather than the browser. */}
                {serialUnavailable && (
                    <p className="text-[10px] font-mono text-amber-400/80 leading-relaxed mb-1.5 break-words">
                        {serialUnavailable}
                    </p>
                )}

                <Select
                    value={source}
                    onValueChange={(v) => v && setSource(v)}
                    disabled={isConnected}
                >
                    <SelectTrigger className="h-8 w-full max-w-full text-xs font-mono bg-zinc-900 border-zinc-700 overflow-hidden [&>span]:truncate [&>span]:min-w-0 [&>span]:text-left">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {nativeRadios.map((radio, i) => (
                            <SelectItem
                                key={`nradio-${i}`}
                                value={`nradio-${i}`}
                                className="text-xs font-mono max-w-[280px] [&>span:last-child]:truncate"
                            >
                                {radio.label}
                            </SelectItem>
                        ))}
                        {radios.map((radio, i) => (
                            <SelectItem
                                key={`radio-${i}`}
                                value={`radio-${i}`}
                                className="text-xs font-mono max-w-[280px] [&>span:last-child]:truncate"
                            >
                                {radio.label}
                            </SelectItem>
                        ))}
                        <SelectItem value="sitl" className="text-xs font-mono">
                            SITL
                        </SelectItem>
                        {/* Native first: same ground station as local-relay but
                            with no relay agent to start. Desktop only. */}
                        {desktop && (
                            <SelectItem value="air-unit-udp" className="text-xs font-mono">
                                Air unit (UDP, direct)
                            </SelectItem>
                        )}
                        <SelectItem value="local-relay" className="text-xs font-mono">
                            Local RF relay (air unit)
                        </SelectItem>
                        <SelectItem value="siyi-udp" className="text-xs font-mono">
                            SIYI ground unit (UDP)
                        </SelectItem>
                    </SelectContent>
                </Select>
                {/* Baud only applies to a real serial radio. 57600 is the SiK
                    default and what PX4's TELEM ports ship at; 115200 is the
                    other one people actually hit. */}
                {selectedIsFc && (
                    <p className="mt-1.5 text-[10px] font-mono text-zinc-500 leading-relaxed">
                        Flight controller over USB — the baud rate is ignored by
                        the CDC serial link, so there is nothing to match.
                    </p>
                )}
                {!selectedIsFc && (source.startsWith('radio-') || source.startsWith('nradio-')) && (
                    <div className="mt-1.5 flex items-center gap-1.5">
                        <span className="text-[10px] font-mono text-zinc-500">BAUD</span>
                        <Select
                            value={String(baud)}
                            onValueChange={(v) => { if (v) setBaud(Number(v)) }}
                            disabled={isConnected}
                        >
                            <SelectTrigger className="h-7 flex-1 text-[11px] font-mono bg-zinc-900 border-zinc-700">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {[57600, 115200, 921600, 38400, 9600].map(b => (
                                    <SelectItem key={b} value={String(b)} className="text-xs font-mono">
                                        {b}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                )}
                {desktop && nativeRadios.length === 0 && (
                    <p className="mt-1.5 text-[10px] font-mono text-zinc-500 leading-relaxed">
                        No serial ports found. Plug the radio in and hit refresh — on Linux you
                        may also need to be in the <span className="text-zinc-400">dialout</span> group.
                    </p>
                )}
                {source === 'air-unit-udp' && (
                    <>
                        <p className="mt-1.5 text-[10px] font-mono text-zinc-500 leading-relaxed">
                            Reads udp:{getRfDownlinkPort()} / sends to {rfUplinkHost}:{getRfUplinkPort()} —
                            no relay agent needed. Just run start-gs.sh.
                        </p>
                        {/* THE SETTING THAT COSTS A FLIGHT WHEN IT IS WRONG, and
                            it used to be a literal in the code. Downlink needs no
                            address — it is a bind, so it hears whoever sends. The
                            uplink is a send TO somewhere, and if that somewhere is
                            this PC while wfb_tx runs on a decoder board, every
                            command vanishes into loopback with no error anywhere
                            and telemetry keeps streaming perfectly. */}
                        <div className="mt-1.5 flex items-center gap-1.5">
                            <span className="text-[10px] font-mono text-zinc-500 shrink-0">TX HOST</span>
                            <input
                                value={rfUplinkHost}
                                onChange={e => {
                                    setRfUplinkHostState(e.target.value)
                                    setRfUplinkHost(e.target.value)
                                }}
                                disabled={isConnected}
                                placeholder={DEFAULT_RF_UPLINK_HOST}
                                title="Where wfb_tx listens. This machine only if the RF decoder runs here — put the decoder's address here otherwise, or commands go nowhere while telemetry keeps working."
                                className="h-7 w-full rounded px-2 text-[11px] font-mono bg-zinc-900 border border-zinc-700 text-zinc-300 outline-none disabled:opacity-60"
                            />
                        </div>
                        <div className="mt-1.5 flex items-center gap-1.5">
                            <span className="text-[10px] font-mono text-zinc-500 shrink-0">QGC PORT</span>
                            <input
                                type="number"
                                min={0}
                                max={65535}
                                value={rfFanout}
                                onChange={e => {
                                    const v = Number(e.target.value)
                                    setRfFanout(v)
                                    if (v >= 0 && v < 65536) setRfFanoutPort(v)
                                }}
                                disabled={isConnected}
                                className="h-7 w-full rounded px-2 text-[11px] font-mono bg-zinc-900 border border-zinc-700 text-zinc-300 outline-none disabled:opacity-60"
                            />
                        </div>
                        <p className="mt-1 text-[10px] font-mono text-zinc-500 leading-relaxed">
                            {rfFanout > 0
                                ? `Copy of the downlink sent to udp:${rfFanout} — point QGC's UDP link at that port instead of ${getRfDownlinkPort()} (only one program can own a port). Downlink only: QGC can read params and download the mission, but cannot command the aircraft through this.`
                                : `0 = off. Set a port (e.g. ${getRfDownlinkPort() + 2}) to let QGroundControl watch the same telemetry alongside HYRAK.`}
                        </p>
                    </>
                )}
                {source === 'local-relay' && (
                    <input
                        value={relayUrl}
                        onChange={e => { setRelayUrl(e.target.value); setLocalRelayUrl(e.target.value) }}
                        disabled={isConnected}
                        placeholder={DEFAULT_LOCAL_RELAY_URL}
                        className="mt-1.5 h-7 w-full rounded px-2 text-[11px] font-mono bg-zinc-900 border border-zinc-700 text-zinc-300 outline-none disabled:opacity-60"
                    />
                )}
                {source === 'siyi-udp' && (
                    <>
                        <input
                            value={siyiTarget}
                            onChange={e => { setSiyiTarget(e.target.value); setSiyiTelemetryTarget(e.target.value) }}
                            disabled={isConnected}
                            placeholder={DEFAULT_SIYI_TELEMETRY_TARGET}
                            className="mt-1.5 h-7 w-full rounded px-2 text-[11px] font-mono bg-zinc-900 border border-zinc-700 text-zinc-300 outline-none disabled:opacity-60"
                        />
                        <p className="mt-1 text-[10px] font-mono text-zinc-500 leading-relaxed">
                            Target host:port, same as QGC&apos;s UDP link. Local port is ephemeral — the ground unit replies to us.
                        </p>
                    </>
                )}
                {sitlNeedsDesktop && (
                    <p className="mt-1.5 text-[10px] font-mono text-zinc-500 leading-relaxed">
                        SITL requires the HYRAK desktop app — <a href="/" className="underline text-zinc-400 hover:text-zinc-200">download it here</a>, then connect to the PX4 SITL running on your machine.
                    </p>
                )}
            </div>

            {/* Connect / Disconnect.
                THE CONNECTED STATE HAD NO WAY OUT. This button showed
                "CONNECTED" and still called handleConnect, so the only thing
                a connected operator could do here was connect again — and
                releasing the radio (to hand it to QGC, to power-cycle it, to
                switch sources) meant reloading the page. Settings has always
                had a Disconnect, and its own help text claimed the link
                "can be released from here or from the Fly tab", which was
                simply not true. Now it is. */}
            {isConnected ? (
                <div className="flex gap-2">
                    <div className="flex-1 flex items-center justify-center gap-2 rounded-md border border-green-500/40 text-green-500 font-mono text-xs h-8">
                        <Wifi size={12} /> CONNECTED
                    </div>
                    <Button
                        size="sm"
                        variant="outline"
                        className="font-mono text-xs gap-2"
                        disabled={disconnecting}
                        onClick={handleDisconnect}
                        title="Release the drone link and stop whichever local relay owns the radio"
                    >
                        {disconnecting
                            ? <><Loader size={12} className="animate-spin" /> …</>
                            : <><WifiOff size={12} /> DISCONNECT</>}
                    </Button>
                </div>
            ) : (
                <Button
                    size="sm"
                    className="w-full font-mono text-xs gap-2"
                    disabled={isConnecting || sitlNeedsDesktop}
                    onClick={handleConnect}
                >
                    {isConnecting
                        ? <><Loader size={12} className="animate-spin" /> CONNECTING...</>
                        : <><WifiOff size={12} /> CONNECT TELEMETRY</>
                    }
                </Button>
            )}

            {/* Why the last attempt failed — a silent spinner-stop tells the
                operator nothing; the actual reason always does. */}
            {telemetryError && !isConnected && !isConnecting && (
                <p className="text-[10px] font-mono text-red-400/90 leading-relaxed break-words">
                    {telemetryError}
                </p>
            )}

        </div>
    )
}