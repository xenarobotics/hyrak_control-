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
import { useAccess, useActiveWorkspace } from '@/hooks/useAccess'
import { requestCloudSimStatus, startCloudSim, stopCloudSim, useCloudSimStore } from '@/store/cloudSim'
import { getLocalRelayUrl } from '@/lib/localRfRelay'
import { getSiyiTelemetryTarget, startSiyiTelemetry } from '@/lib/siyiTelemetryRelay'
import { isDesktopApp } from '@/lib/nativeBridge'
import { listNativeSerialPorts, type NativeRadio } from '@/lib/nativeSerialRelay'
import {

    getTelemetryBaud, setTelemetryBaud,
    getTelemetrySource, setTelemetrySource, LINK_CHANGE_EVENT, STAFF_ONLY_LINKS,
    DEFAULT_TELEMETRY_SOURCE,
} from '@/lib/linkSettings'

export interface LinkOption {
    value: string
    label: string
    /** Shown but not selectable, with the reason as a note. */
    disabled?: boolean
    note?: string
}

/** The server-launched per-session simulator (docs/ACCESS_MODEL.md 8b).
 *  A premium extra, below the desktop "SITL" link, which stays the default
 *  way to fly a simulator. Never merged with 'sitl' or 'sitl-server'. */
export const CLOUD_SIM_LINK = 'cloud-sim'
export const CLOUD_SIM_PREMIUM_NOTE = 'Premium feature, not enabled for this workspace. Your own PX4 / Gazebo connects free through the SITL link.'


export function useTelemetryLink() {
    const desktop = isDesktopApp()
    // Customer-only accounts never see server-side links (STAFF_ONLY_LINKS).
    const { isCustomer } = useAccess()
    const [radios, setRadios] = useState<GrantedRadio[]>([])
    const [nativeRadios, setNativeRadios] = useState<NativeRadio[]>([])
    // Read from storage rather than defaulted, so a link picked in the bar is
    // still the one selected after navigating to Fly.
    const [storedSource, setSourceState] = useState<string>(() => getTelemetrySource())
    const source = isCustomer && STAFF_ONLY_LINKS.includes(storedSource) ? DEFAULT_TELEMETRY_SOURCE : storedSource
    const [baud, setBaudState] = useState(() => getTelemetryBaud())
    const [disconnecting, setDisconnecting] = useState(false)
    // Cloud simulator entitlement: staff always; a customer workspace only
    // with the cloud_sim feature (the server's status is the authority).
    const { workspace } = useActiveWorkspace()
    const simStatus = useCloudSimStore(st => st.status)
    const cloudSimEntitled = !isCustomer || (simStatus?.entitled ?? workspace?.features?.cloud_sim === true)
    const cloudSimEnabled = simStatus?.enabled ?? true
    useEffect(() => { requestCloudSimStatus() }, [])

    const {
        telemetryStatus, telemetryError, setTelemetryError,
        connectBrowserSerial, connectNativeSerial, connectNativeRf,
        connectLocalRelay, connectRemoteSitl, connectTelemetry, disconnectTelemetry,
    } = useDrone()

    const setSource = useCallback((v: string) => {
        setSourceState(v)
        setTelemetrySource(v)
    }, [])

    // Selected radio unplugged: fall back to SITL AND persist it. Changing
    // only the local state left the dead index in storage, so the next mount
    // re-selected the missing radio and Connect silently did nothing.
    const dropMissing = useCallback((prefix: string, present: number) => {
        const s = getTelemetrySource()
        if (!s.startsWith(prefix)) return
        if (Number(s.slice(prefix.length)) < present) return
        setSource('sitl')
        setTelemetryError('The selected radio is not present')
    }, [setSource, setTelemetryError])

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
        dropMissing('radio-', list.length)
    }, [dropMissing])

    const refreshNativeRadios = useCallback(async () => {
        const list = await listNativeSerialPorts()
        setNativeRadios(list)
        dropMissing('nradio-', list.length)
    }, [dropMissing])

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
        if (source === CLOUD_SIM_LINK) {
            // The server starts the sim and links this session when it is up.
            startCloudSim()
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
        try {
            await disconnectTelemetry()
            // The cloud sim is the link: releasing it ends the sim too.
            if (source === CLOUD_SIM_LINK) stopCloudSim()
        } finally { setDisconnecting(false) }
    }, [disconnectTelemetry, source])

    /** Every link this shell can offer, in the order DeviceSelector shows
     *  them. One list so the bar and the Fly panel cannot offer different
     *  sets - which is the failure mode of having written it out twice. */
    const allOptions: LinkOption[] = [
        ...nativeRadios.map((r, i) => ({ value: `nradio-${i}`, label: r.label })),
        ...radios.map((r, i) => ({ value: `radio-${i}`, label: r.label })),
        // Two different links that both say "sim" - never merge or relabel:
        // sitl-server is the backend binding udp:14600 on its own machine,
        // sitl is the desktop relay of the client's own SITL on udp:14540.
        { value: 'sitl-server', label: 'Gazebo sim on server (udp:14600)' },
        { value: 'sitl', label: 'SITL' },
        // Below SITL on purpose: SITL (the customer's own simulator through
        // the desktop app) is the default; the cloud sim is a premium extra.
        ...(cloudSimEnabled ? [{
            value: CLOUD_SIM_LINK,
            label: 'Cloud simulator (premium)',
            disabled: !cloudSimEntitled,
            note: cloudSimEntitled ? undefined : CLOUD_SIM_PREMIUM_NOTE,
        }] : []),
        // Native first: same ground station as local-relay but with no relay
        // agent to start. Desktop only.
        ...(desktop ? [{ value: 'air-unit-udp', label: 'Air unit (UDP, direct)' }] : []),
        { value: 'local-relay', label: 'Local RF relay (air unit)' },
        { value: 'siyi-udp', label: 'SIYI ground unit (UDP)' },
    ]
    const options = isCustomer ? allOptions.filter(o => !STAFF_ONLY_LINKS.includes(o.value)) : allOptions

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
