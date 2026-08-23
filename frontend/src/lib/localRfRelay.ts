// Local RF relay bridge - the wfb-ng counterpart of browserSerial.ts. Your
// own air unit's ground-station side (start-gs.sh) delivers raw MAVLink
// over UDP on THIS laptop's loopback (127.0.0.1:14550 downlink,
// :14551 uplink) - no browser API can read a raw UDP socket directly. A
// tiny local relay agent (see air_unit_relay/telemetry_relay.py) re-exposes
// that over a plain ws://127.0.0.1 WebSocket - loopback only, never the
// internet - and this connects to THAT the same way browserSerial.ts opens
// a serial port, then relays raw MAVLink bytes to the backend over the
// EXISTING serial_uplink/serial_downlink events. backend/app/telemetry/
// serial_bridge.py doesn't know or care where the bytes came from, so this
// needed zero backend changes.

import { getSocket } from '@/lib/socket'

let ws: WebSocket | null = null
let active = false

export const DEFAULT_LOCAL_RELAY_URL = 'ws://127.0.0.1:8765'
const URL_KEY = 'hyrak-local-relay-url'

export function getLocalRelayUrl(): string {
    if (typeof window === 'undefined') return DEFAULT_LOCAL_RELAY_URL
    try {
        return localStorage.getItem(URL_KEY) || DEFAULT_LOCAL_RELAY_URL
    } catch {
        return DEFAULT_LOCAL_RELAY_URL
    }
}

export function setLocalRelayUrl(url: string): void {
    if (typeof window !== 'undefined') localStorage.setItem(URL_KEY, url)
}

export const isLocalRelayActive = () => active

export async function startLocalRelay(url: string = DEFAULT_LOCAL_RELAY_URL): Promise<void> {
    if (active) return
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
            io.on('serial_downlink', onDownlink)
            socket.onmessage = onRelayMessage
            socket.onclose = () => { if (active) void stopLocalRelay() }
            socket.onerror = () => { /* handled via onclose */ }
            // Backend waits for the drone's heartbeat through this relay -
            // start it the moment the socket is up, same as browserSerial.
            io.emit('connect_browser_serial', { source: 'local-rf-agent' })
            resolve()
        }
        socket.onerror = () => {
            reject(new Error(`Couldn't reach the local relay agent at ${url} - is telemetry_relay.py running on this machine?`))
        }
    })
}

// Bytes from the relay agent are the drone's downlink telemetry (it read
// them off wfb_rx's UDP 14550) - "uplink" here matches serial_bridge.py's
// existing naming: data flowing UP to feed mavsdk_server, same as a real
// radio's received bytes always were.
function onRelayMessage(event: MessageEvent) {
    if (event.data instanceof ArrayBuffer && event.data.byteLength > 0) {
        getSocket().emit('serial_uplink', event.data)
    }
}

// mavsdk's outgoing replies (commands to the drone) - forward to the relay
// agent, which sends them out as UDP to wfb_tx's uplink listener (:14551).
function onDownlink(data: ArrayBuffer) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(data)
    }
}

export async function stopLocalRelay(): Promise<void> {
    if (!active && !ws) return
    active = false
    getSocket().off('serial_downlink', onDownlink)
    try { ws?.close() } catch { /* already closed */ }
    ws = null
}
