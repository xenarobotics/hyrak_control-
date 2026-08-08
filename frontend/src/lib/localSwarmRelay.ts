// Local swarm relay bridge — the multi-drone counterpart of localRfRelay.ts.
// A client's own PX4 SITL swarm runs entirely on THEIR machine (see
// simulation/swarm.sh); no browser API can read raw UDP sockets directly.
//
// Two ways this can be satisfied, both landing on the exact same backend
// events (swarm_relay_uplink / swarm_relay_downlink) so nothing else in the
// app needs to know which one is active:
//   - Inside the HYRAK desktop app (see desktop/): window.hyrakNative is
//     present, so this talks to the app's native UDP bridge DIRECTLY — no
//     separate process to run at all.
//   - In a plain browser tab: falls back to the original design — a local
//     relay agent (sitl_relay/swarm_relay.py, or its standalone .exe/binary
//     build) binds each drone's local MAVLink port and multiplexes them
//     over one ws://127.0.0.1 WebSocket, tagged [drone_id: 1 byte][bytes].
// backend/app/telemetry/swarm_relay_bridge.py doesn't know or care which
// path the browser used to get its bytes — same principle as
// serial_bridge.py already not caring how the browser got ITS bytes.

import { getSocket } from '@/lib/socket'
import { isDesktopApp, nativeBridge, type BridgeEvent } from '@/lib/nativeBridge'
import { portForDrone, FLEET_SCAN_COUNT } from '@/lib/fleet'

let ws: WebSocket | null = null
let active = false
let nativeUnsubscribe: (() => void) | null = null

export const DEFAULT_SWARM_RELAY_URL = 'ws://127.0.0.1:8766'
const URL_KEY = 'hyrak-swarm-relay-url'
const NATIVE_UDP_ID = 'swarm-relay'

export function getSwarmRelayUrl(): string {
    if (typeof window === 'undefined') return DEFAULT_SWARM_RELAY_URL
    try {
        return localStorage.getItem(URL_KEY) || DEFAULT_SWARM_RELAY_URL
    } catch {
        return DEFAULT_SWARM_RELAY_URL
    }
}

export function setSwarmRelayUrl(url: string): void {
    if (typeof window !== 'undefined') localStorage.setItem(URL_KEY, url)
}

export const isSwarmRelayActive = () => active

export async function startSwarmRelay(url: string = DEFAULT_SWARM_RELAY_URL): Promise<void> {
    if (active) return
    if (isDesktopApp()) {
        return startNativeSwarmRelay()
    }
    return startExternalSwarmRelay(url)
}

// ---- Desktop app path: native UDP bridge, no external process ------------

async function startNativeSwarmRelay(): Promise<void> {
    const bridge = nativeBridge()
    if (!bridge) throw new Error('Native bridge unavailable')
    const socket = getSocket()

    // Same drone_id -> port mapping the scan already probes (see
    // lib/fleet.ts's portForDrone), opened up front for the whole scan
    // range so no drone is missed regardless of how many actually respond.
    const ports = Array.from({ length: FLEET_SCAN_COUNT }, (_, i) => {
        const droneId = i + 1
        return { tag: droneId, port: portForDrone(droneId) }
    })

    const result = await bridge.start('udp', NATIVE_UDP_ID, { ports })
    if (!result.ok) {
        throw new Error(result.error || 'Could not start the native swarm relay')
    }

    nativeUnsubscribe = bridge.onEvent((event: BridgeEvent) => {
        if (event.bridge !== 'udp' || event.id !== NATIVE_UDP_ID || event.type !== 'data' || !event.data) return
        const tag = (event.meta?.tag as number | undefined) ?? 0
        const frame = new Uint8Array(event.data.length + 1)
        frame[0] = tag & 0xff
        frame.set(event.data, 1)
        socket.emit('swarm_relay_uplink', frame.buffer)
    })

    socket.on('swarm_relay_downlink', onNativeDownlink)
    socket.emit('connect_swarm_relay')
    active = true
}

function onNativeDownlink(data: ArrayBuffer) {
    const bytes = new Uint8Array(data)
    if (bytes.length < 1) return
    nativeBridge()?.send('udp', NATIVE_UDP_ID, bytes.slice(1), { tag: bytes[0] })
}

// ---- Browser path: external relay agent over a loopback WebSocket -------

async function startExternalSwarmRelay(url: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        let socket: WebSocket
        try {
            socket = new WebSocket(url)
        } catch (err) {
            reject(err)
            return
        }
        socket.binaryType = 'arraybuffer'

        socket.onopen = () => {
            ws = socket
            active = true
            const io = getSocket()
            io.on('swarm_relay_downlink', onExternalDownlink)
            socket.onmessage = onExternalRelayMessage
            socket.onclose = () => { if (active) void stopSwarmRelay() }
            socket.onerror = () => { /* handled via onclose */ }
            // Registers the bridge on the backend BEFORE any scan — the
            // scan handler checks for this and routes through it instead
            // of trying literal server-local ports.
            io.emit('connect_swarm_relay')
            resolve()
        }
        socket.onerror = () => {
            reject(new Error(`Couldn't reach the local swarm relay at ${url} — is swarm_relay running on this machine?`))
        }
    })
}

// Tagged frames from the relay agent — forward as-is, the backend bridge
// reads the leading drone_id byte itself.
function onExternalRelayMessage(event: MessageEvent) {
    if (event.data instanceof ArrayBuffer && event.data.byteLength > 0) {
        getSocket().emit('swarm_relay_uplink', event.data)
    }
}

// mavsdk's outgoing replies (commands to a specific drone), already tagged
// with that drone's id by the backend bridge — forward to the relay agent,
// which strips the tag and sends the bytes out to that drone's real peer.
function onExternalDownlink(data: ArrayBuffer) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(data)
    }
}

export async function stopSwarmRelay(): Promise<void> {
    if (!active) return
    active = false
    const socket = getSocket()

    if (nativeUnsubscribe) {
        nativeUnsubscribe()
        nativeUnsubscribe = null
        socket.off('swarm_relay_downlink', onNativeDownlink)
        await nativeBridge()?.stop('udp', NATIVE_UDP_ID)
        return
    }

    socket.off('swarm_relay_downlink', onExternalDownlink)
    try { ws?.close() } catch { /* already closed */ }
    ws = null
}
