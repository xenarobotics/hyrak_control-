'use client'

// The telemetry link selection, owned in ONE place.
//
// This logic lived entirely inside DeviceSelector, which was right while the
// Fly tab was the only place a link could be picked. The status bar now offers
// the same choice from Mission and AI, and the alternative to a shared hook is
// two components each keeping their own idea of which radio is selected - the
// operator switches port in the bar, walks to Fly, and finds the old one still
// showing. This codebase has already paid for that mistake once, in the seven
// hand-copied copies of the pursuit-analyzer list that silently drifted apart.
//
// WHAT IS DELIBERATELY NOT HERE: the relay URL, the SIYI target, the RF fanout
// port and the uplink host. Those are text fields with one editor each on the
// Fly tab, and they are already persisted at the moment they are typed - so
// connect() reads them back from storage rather than needing them passed in.
// Putting them in the hook would mean the compact bar had to render four text
// inputs it has no room for, or silently drop them.

import { useCallback, useEffect, useState } from 'react'

import {
    browserSerialSupported, getSerialApi, listGrantedPorts,
    requestRadioPort, serialUnavailableReason, type GrantedRadio,
} from '@/lib/browserSerial'
// Backend-side bind for a SITL on the server's own machine (see hyrak_sim.sh).
// 14600, NOT 1454x/1455x: the fleet and swarm scanners probe 14541..14561
// for SITL instances and adopted the session's port as a phantom drone.
export const SERVER_SITL_ADDRESS = 'udp://:14600'
import { useDrone } from '@/hooks/useDrone'
import { getLocalRelayUrl } from '@/lib/localRfRelay'
import { getSiyiTelemetryTarget, startSiyiTelemetry } from '@/lib/siyiTelemetryRelay'
import { isDesktopApp } from '@/lib/nativeBridge'
import { listNativeSerialPorts, type NativeRadio } from '@/lib/nativeSerialRelay'
import {

    getTelemetryBaud, setTelemetryBaud,
    getTelemetrySource, setTelemetrySource, LINK_CHANGE_EVENT,
} from '@/lib/linkSettings'

export interface LinkOption {
    value: string
    label: string
}

export function useTelemetryLink() {
    const desktop = isDesktopApp()
    const [radios, setRadios] = useState<GrantedRadio[]>([])
    const [nativeRadios, setNativeRadios] = useState<NativeRadio[]>([])
    // Read from storage rather than defaulted, so a link picked in the bar is
    // still the one selected after navigating to Fly.
    const [source, setSourceState] = useState<string>(() => getTelemetrySource())
    const [baud, setBaudState] = useState(() => getTelemetryBaud())
    const [disconnecting, setDisconnecting] = useState(false)

    const {
        telemetryStatus, telemetryError,
        connectBrowserSerial, connectNativeSerial, connectNativeRf,
        connectLocalRelay, connectRemoteSitl, connectTelemetry, disconnectTelemetry,
    } = useDrone()

    const setSource = useCallback((v: string) => {
        setSourceState(v)
        setTelemetrySource(v)
    }, [])

    const setBaud = useCallback((v: number) => {
        setBaudState(v)
        setTelemetryBaud(v)
    }, [])

    // localStorage fires no event in the tab that wrote it, so the writer
    // announces the change itself and every other mounted picker follows.
    useEffect(() => {
        const onChange = (e: Event) => {
            const v = (e as CustomEvent<string>).detail
            if (typeof v === 'string') setSourceState(v)
        }
        window.addEventListener(LINK_CHANGE_EVENT, onChange)
        return () => window.removeEventListener(LINK_CHANGE_EVENT, onChange)
    }, [])

    const refreshRadios = useCallback(async () => {
        const list = await listGrantedPorts()
        setRadios(list)
        // Selected radio unplugged → fall back to SITL rather than leaving a
        // dead index selected, which connects to nothing and says nothing.
        setSourceState(s => (s.startsWith('radio-') && !list[Number(s.slice(6))] ? 'sitl' : s))
    }, [])

    const refreshNativeRadios = useCallback(async () => {
        const list = await listNativeSerialPorts()
        setNativeRadios(list)
        setSourceState(s => (s.startsWith('nradio-') && !list[Number(s.slice(7))] ? 'sitl' : s))
    }, [])

    useEffect(() => {
        if (desktop) {
            // No plug/unplug event to subscribe to natively - the refresh
            // button re-lists, which is all QGC does too.
            void refreshNativeRadios()
            return
        }
        const api = getSerialApi()
        if (!api) return
        void refreshRadios()
        api.addEventListener?.('connect', refreshRadios)
        api.addEventListener?.('disconnect', refreshRadios)
        return () => {
            api.removeEventListener?.('connect', refreshRadios)
            api.removeEventListener?.('disconnect', refreshRadios)
        }
    }, [desktop, refreshRadios, refreshNativeRadios])

    /** One-time grant: browser picker → radio joins the list permanently. */
    const addRadio = useCallback(async () => {
        const granted = await requestRadioPort()
        if (!granted) return // cancelled
        const list = await listGrantedPorts()
        setRadios(list)
        const idx = list.findIndex(r => r.port === granted)
        if (idx >= 0) setSource(`radio-${idx}`)
    }, [setSource])

    const connect = useCallback(() => {
        if (source.startsWith('nradio-')) {
            const radio = nativeRadios[Number(source.slice(7))]
            if (radio) void connectNativeSerial(radio.path, baud)
            return
        }
        if (source.startsWith('radio-')) {
            const radio = radios[Number(source.slice(6))]
            if (radio) void connectBrowserSerial(radio.port, baud)
            return
        }
        if (source === 'air-unit-udp') {
            void connectNativeRf()
            return
        }
        if (source === 'local-relay') {
            void connectLocalRelay(getLocalRelayUrl())
            return
        }
        if (source === 'siyi-udp') {
            // Its own path rather than connectLocalRelay: that one dials a
            // WebSocket relay agent, this binds a UDP socket natively.
            void startSiyiTelemetry(getSiyiTelemetryTarget())
            return
        }
        if (source === 'sitl-server') {
            // The SITL runs on the SAME machine as the backend (dev box, demo
            // sim): let the server bind it directly. No desktop relay, no
            // learned/pinned uplink peer - MAVSDK answers whoever sends to
            // udp:14560, which hyrak_sim.sh points a PX4 link at.
            connectTelemetry(SERVER_SITL_ADDRESS)
            return
        }
        void connectRemoteSitl()
    }, [source, baud, radios, nativeRadios, connectNativeSerial, connectBrowserSerial,
        connectNativeRf, connectLocalRelay, connectRemoteSitl, connectTelemetry])

    const disconnect = useCallback(async () => {
        setDisconnecting(true)
        try { await disconnectTelemetry() } finally { setDisconnecting(false) }
    }, [disconnectTelemetry])

    /** Every link this shell can offer, in the order DeviceSelector shows
     *  them. One list so the bar and the Fly panel cannot offer different
     *  sets - which is the failure mode of having written it out twice. */
    const options: LinkOption[] = [
        ...nativeRadios.map((r, i) => ({ value: `nradio-${i}`, label: r.label })),
        ...radios.map((r, i) => ({ value: `radio-${i}`, label: r.label })),
        { value: 'sitl-server', label: 'Gazebo sim on server (udp:14600)' },
        { value: 'sitl', label: 'SITL' },
        // Native first: same ground station as local-relay but with no relay
        // agent to start. Desktop only.
        ...(desktop ? [{ value: 'air-unit-udp', label: 'Air unit (UDP, direct)' }] : []),
        { value: 'local-relay', label: 'Local RF relay (air unit)' },
        { value: 'siyi-udp', label: 'SIYI ground unit (UDP)' },
    ]

    const isSerial = source.startsWith('radio-') || source.startsWith('nradio-')
    const selectedIsFc = source.startsWith('radio-')
        ? !!radios[Number(source.slice(6))]?.isFc
        : false

    return {
        desktop,
        radios, nativeRadios, options,
        source, setSource,
        baud, setBaud, isSerial, selectedIsFc,
        refreshRadios, refreshNativeRadios, addRadio,
        browserSerialSupported: browserSerialSupported(),
        // Named rather than merely absent. A flight controller on a USB cable
        // works in the desktop app and looks unsupported here, and the cause
        // is usually the page's origin rather than the browser - see
        // serialUnavailableReason.
        serialUnavailable: serialUnavailableReason(),
        connect, disconnect, disconnecting,
        telemetryStatus, telemetryError,
        isConnected: telemetryStatus === 'connected',
        isConnecting: telemetryStatus === 'connecting',
        // SITL bridges the CLIENT'S own SITL through the desktop app's native
        // UDP bridge - a plain browser tab has no way to reach udp:14540.
        sitlNeedsDesktop: source === 'sitl' && !desktop,
    }
}
