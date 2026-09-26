// SIYI ground-unit telemetry over UDP.
//
// The SIYI air unit carries MAVLink alongside video, and the ground unit
// re-emits it as UDP on the hotspot - the same network the RTSP camera is on.
// No browser API can read a raw UDP socket, so this uses the desktop app's
// native UDP bridge (desktop/src/bridges/udpBridge.ts), exactly as
// localSwarmRelay.ts does for a SITL fleet.
//
// It needs NO backend changes, which is the reason it is shaped this way: the
// bytes go up on the EXISTING `serial_uplink` event and come back down on
// `serial_downlink`, and backend/app/telemetry/serial_bridge.py has never cared
// where a client's MAVLink came from. Same principle as localRfRelay.ts.
//
//   SIYI ground unit --UDP--> udpBridge --serial_uplink--> backend
//                          <--------- serial_downlink <---
//
// Addressed the way the same link is set up in QGroundControl: local port 0
// (ephemeral) plus a TARGET of 192.168.144.20:19856. That direction matters -
// the ground unit does not transmit unsolicited, and MAVSDK on the backend is
// `udpin://` and also waits for a heartbeat, so without someone speaking first
// the link deadlocks silently. udpBridge sends an opening datagram to the target
// and then prefers the learned peer once the unit replies.

import { getSocket } from '@/lib/socket'
import { isDesktopApp, nativeBridge, type BridgeEvent } from '@/lib/nativeBridge'
import { feedLocal, registerLocalLink, unregisterLocalLink } from '@/lib/localLink'

const NATIVE_UDP_ID = 'siyi-telemetry'
const TARGET_KEY = 'hyrak-siyi-telemetry-target'
const LOCAL_PORT_KEY = 'hyrak-siyi-telemetry-local-port'

// Mirrors how the same link is configured in QGroundControl: a UDP link with
// "Listening Port: 0" and a target host of 192.168.144.20:19856. Port 0 means
// "let the OS pick" - the ground unit does not transmit unsolicited, so it is
// the TARGET that matters, and the unit replies to whatever ephemeral source
// port we send from.
export const DEFAULT_SIYI_TELEMETRY_TARGET = '192.168.144.20:19856'
// 0 = ephemeral. A fixed local port is only needed if something else has to
// find us, which nothing does here.
export const DEFAULT_SIYI_LOCAL_PORT = 0

let active = false
let unsubscribe: (() => void) | null = null
let silenceTimer: ReturnType<typeof setTimeout> | null = null
let sawTraffic = false
let lastTelemetryError: string | null = null

// Starting the relay and RECEIVING telemetry are different things, and the UI
// conflated them: the socket connects, the port binds, the status goes green -
// and MAVSDK on the backend sits there logging "Connection timed out" because
// not one MAVLink byte ever arrived. Reported here so the operator learns it
// from the app instead of from a server log.
const FIRST_TELEMETRY_TIMEOUT_MS = 8000

export function getLastTelemetryError(): string | null {
    return lastTelemetryError
}

export function getSiyiTelemetryTarget(): string {
    if (typeof window === 'undefined') return DEFAULT_SIYI_TELEMETRY_TARGET
    try {
        return localStorage.getItem(TARGET_KEY) || DEFAULT_SIYI_TELEMETRY_TARGET
    } catch {
        return DEFAULT_SIYI_TELEMETRY_TARGET
    }
}

export function setSiyiTelemetryTarget(target: string): void {
    if (typeof window !== 'undefined') localStorage.setItem(TARGET_KEY, target)
}

export function getSiyiLocalPort(): number {
    if (typeof window === 'undefined') return DEFAULT_SIYI_LOCAL_PORT
    try {
        const v = Number(localStorage.getItem(LOCAL_PORT_KEY))
        return v >= 0 && v < 65536 ? v : DEFAULT_SIYI_LOCAL_PORT
    } catch {
        return DEFAULT_SIYI_LOCAL_PORT
    }
}

export function setSiyiLocalPort(port: number): void {
    if (typeof window !== 'undefined') localStorage.setItem(LOCAL_PORT_KEY, String(port))
}

/** Splits "host:port". Returns null when unusable, so the caller can say so
 *  rather than binding something meaningless. */
function parseTarget(target: string): { host: string; port: number } | null {
    const m = target.trim().match(/^\[?([^\]]+?)\]?:(\d{1,5})$/)
    if (!m) return null
    const port = Number(m[2])
    if (!(port > 0 && port < 65536)) return null
    return { host: m[1], port }
}

export function isSiyiTelemetryActive(): boolean {
    return active
}


// The local link fallback (lib/localLink.ts) writes through the same path.
const localSend = (b: Uint8Array) => onDownlink(b)
function onDownlink(data: ArrayBuffer | Uint8Array) {
    // Backend -> ground unit -> aircraft. Sent to the last peer seen on the
    // port; if none has been seen the bridge drops it rather than guessing.
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    nativeBridge()?.send('udp', NATIVE_UDP_ID, bytes)
}

/** Binds the SIYI telemetry UDP port and relays MAVLink both ways. */
export async function startSiyiTelemetry(
    target = getSiyiTelemetryTarget(),
    localPort = getSiyiLocalPort(),
): Promise<void> {
    if (!isDesktopApp()) {
        throw new Error(
            'SIYI UDP telemetry needs the HYRAK desktop app - a browser tab cannot read a raw '
            + 'UDP socket. Use a serial radio, or run the desktop app.',
        )
    }
    const dest = parseTarget(target)
    if (!dest) {
        throw new Error(
            `"${target}" is not host:port - expected something like ${DEFAULT_SIYI_TELEMETRY_TARGET}.`,
        )
    }
    if (active) await stopSiyiTelemetry()

    const bridge = nativeBridge()
    // tag 0: a single stream. The tag exists for the swarm case, where one
    // bridge instance fans out several drones' ports.
    //
    // remoteHost/remotePort make the bridge speak FIRST, which this link
    // requires: the ground unit only replies to an address it has heard from,
    // and MAVSDK on the backend is udpin:// and equally waits. See udpBridge.ts.
    const result = await bridge?.start('udp', NATIVE_UDP_ID, {
        ports: [{ tag: 0, port: localPort, remoteHost: dest.host, remotePort: dest.port }],
    })
    if (result && !result.ok) {
        throw new Error(
            `${result.error}. If the port is taken, QGroundControl or the SIYI app may `
            + 'still be holding it - only one process can own a UDP port.',
        )
    }

    const socket = getSocket()
    unsubscribe = bridge?.onEvent((event: BridgeEvent) => {
        if (event.bridge !== 'udp' || event.id !== NATIVE_UDP_ID) return
        if (event.type !== 'data' || !event.data) return
        if (!sawTraffic) {
            sawTraffic = true
            if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null }
        }
        // volatile: dropped while the socket is down, never replayed stale on reconnect
        feedLocal(event.data)
        socket.volatile.emit('serial_uplink', event.data)
    }) ?? null

    sawTraffic = false
    lastTelemetryError = null
    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = setTimeout(() => {
        if (!active || sawTraffic) return
        lastTelemetryError =
            `Bound the port and sent to ${dest.host}:${dest.port}, but no MAVLink came back in `
            + `${FIRST_TELEMETRY_TIMEOUT_MS / 1000}s. Either this machine cannot reach `
            + `${dest.host} (check it is on the ground unit's network - the same one the RTSP `
            + 'camera is on), or the target port is wrong, or another program (QGroundControl, '
            + 'the SIYI app) already owns the link.'
        console.warn('SIYI telemetry:', lastTelemetryError)
    }, FIRST_TELEMETRY_TIMEOUT_MS)

    socket.on('serial_downlink', onDownlink)
    registerLocalLink(localSend)
    // Tells the backend to spin up its MAVLink parser for this session. The same
    // event a Web Serial radio sends, because from here on the paths are
    // identical.
    socket.emit('connect_browser_serial', { source: 'siyi-udp' })
    active = true
}

export async function stopSiyiTelemetry(): Promise<void> {
    active = false
    sawTraffic = false
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null }
    if (unsubscribe) { unsubscribe(); unsubscribe = null }
    try { getSocket().off('serial_downlink', onDownlink) } catch { /* socket gone */ }
    unregisterLocalLink(localSend)
    if (isDesktopApp()) {
        try { await nativeBridge()?.stop('udp', NATIVE_UDP_ID) } catch { /* not running */ }
    }
}
