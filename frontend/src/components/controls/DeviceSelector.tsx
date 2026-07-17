'use client'

import { useCallback, useEffect, useState } from 'react'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import {
    browserSerialSupported, getSerialApi, listGrantedPorts,
    requestRadioPort, type GrantedRadio,
} from '@/lib/browserSerial'
import { useDrone } from '@/hooks/useDrone'
import {
    Select, SelectContent, SelectItem,
    SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { RefreshCw, Camera, Satellite, WifiOff, Wifi, Loader, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'

export function DeviceSelector() {
    const [mounted, setMounted] = useState(false)
    useEffect(() => { setMounted(true) }, [])
    const {
        cameras, selectedCameraId: camId, setSelectedCameraId: setCamId,
        isLoading: camLoading, scanCameras: scanCams
    } = useWebRTCContext()

    // Telemetry source is a CLIENT device, like the camera: radios plugged
    // into the user's machine, listed by name (QGC-style). The browser can
    // only enumerate ports the user granted once via the "+" picker; after
    // that grant they appear here automatically on every visit and update
    // live on plug/unplug. The server never has a radio — no server ports.
    const [radios, setRadios] = useState<GrantedRadio[]>([])
    const [source, setSource] = useState<string>('sitl') // 'sitl' | 'radio-<i>'

    const { telemetryStatus, connectTelemetry, connectBrowserSerial } = useDrone()

    const refreshRadios = useCallback(async () => {
        const list = await listGrantedPorts()
        setRadios(list)
        // Selected radio unplugged → fall back to SITL
        setSource(s => (s.startsWith('radio-') && !list[Number(s.slice(6))] ? 'sitl' : s))
    }, [])

    useEffect(() => {
        const api = getSerialApi()
        if (!api) return
        void refreshRadios()
        api.addEventListener?.('connect', refreshRadios)
        api.addEventListener?.('disconnect', refreshRadios)
        return () => {
            api.removeEventListener?.('connect', refreshRadios)
            api.removeEventListener?.('disconnect', refreshRadios)
        }
    }, [refreshRadios])

    // One-time grant: browser picker → radio joins the list permanently.
    const addRadio = async () => {
        const granted = await requestRadioPort()
        if (!granted) return // cancelled
        const list = await listGrantedPorts()
        setRadios(list)
        const idx = list.findIndex(r => r.port === granted)
        if (idx >= 0) setSource(`radio-${idx}`)
    }

    const isConnected = telemetryStatus === 'connected'
    const isConnecting = telemetryStatus === 'connecting'

    const handleConnect = () => {
        if (source.startsWith('radio-')) {
            const radio = radios[Number(source.slice(6))]
            if (radio) void connectBrowserSerial(radio.port)
            return
        }
        connectTelemetry('udp://:14540')
    }

    if (!mounted) {
        return <div className="space-y-3 min-h-[190px]" />
    }

    return (
        <div className="space-y-3">

            {/* Camera selector */}
            <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                    <Camera size={12} className="text-zinc-500" />
                    <span className="text-xs text-zinc-500 font-mono">CAMERA</span>
                    <button
                        onClick={scanCams}
                        className="ml-auto text-zinc-600 hover:text-zinc-400 transition-colors"
                        title="Refresh cameras"
                    >
                        <RefreshCw size={11} className={cn(camLoading && 'animate-spin')} />
                    </button>
                </div>

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
            </div>

            {/* Telemetry source — detected client radios (like the camera) or SITL */}
            <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                    <Satellite size={12} className="text-zinc-500" />
                    <span className="text-xs text-zinc-500 font-mono">TELEMETRY</span>
                    {browserSerialSupported() && (
                        <button
                            onClick={addRadio}
                            className="ml-auto text-zinc-600 hover:text-zinc-400 transition-colors"
                            title="Add a USB radio plugged into this device"
                        >
                            <Plus size={12} />
                        </button>
                    )}
                </div>

                <Select
                    value={source}
                    onValueChange={(v) => v && setSource(v)}
                    disabled={isConnected}
                >
                    <SelectTrigger className="h-8 w-full max-w-full text-xs font-mono bg-zinc-900 border-zinc-700 overflow-hidden [&>span]:truncate [&>span]:min-w-0 [&>span]:text-left">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
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
                            SITL — udp://:14540
                        </SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {/* Connect button */}
            <Button
                size="sm"
                className="w-full font-mono text-xs gap-2"
                variant={isConnected ? 'outline' : 'default'}
                disabled={isConnecting}
                onClick={handleConnect}
            >
                {isConnecting
                    ? <><Loader size={12} className="animate-spin" /> CONNECTING...</>
                    : isConnected
                        ? <><Wifi size={12} /> CONNECTED</>
                        : <><WifiOff size={12} /> CONNECT TELEMETRY</>
                }
            </Button>

        </div>
    )
}