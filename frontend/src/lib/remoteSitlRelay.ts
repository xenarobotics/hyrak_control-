// Single-drone SITL bridge — desktop app ONLY. The native UDP bridge binds
// PX4's classic default MAVLink port (14540) on the CLIENT's machine and
// relays raw bytes to the backend's existing serial_uplink/serial_downlink
// events, so the server needs no SITL-specific handling (same principle as
// localSwarmRelay.ts; swarm numbering starts at 14541 and skips 14540, so
// that path doesn't cover the lone-instance case).
//
// There is deliberately NO browser fallback here: SITL is a desktop-app
// feature. A plain browser tab can't open UDP sockets, and the old
// workaround (a separate sitl_relay/single_relay.py process the client had
// to run) was removed from the UI as confusing — browser users are pointed
// at the desktop app download instead (see DeviceSelector.tsx).

import { getSocket } from '@/lib/socket'
import { isDesktopApp, nativeBridge, type BridgeEvent } from '@/lib/nativeBridge'

let active = false
let nativeUnsubscribe: (() => void) | null = null
let silenceTimer: ReturnType<typeof setTimeout> | null = null

const NATIVE_UDP_ID = 'remote-sitl'

// Binding the port always succeeds whether or not SITL is actually sending
// anything to it, so a misconfigured SITL produced no error at all — just
// "connecting" until the backend's own 25s mavsdk timeout eventually fired
// with a generic message that named none of the likely causes. Fail fast and
// specifically instead.
const SILENCE_TIMEOUT_MS = 8000

export const isRemoteSitlRelayActive = () => active

/** Set when the bridge binds but no SITL traffic ever arrives. Read by
 *  useDrone's connect handler to replace the generic backend timeout. */
export type SitlSilenceHandler = (message: string) => void
let onSilence: SitlSilenceHandler | null = null
export function setSitlSilenceHandler(h: SitlSilenceHandler | null) { onSilence = h }

export async function startRemoteSitlRelay(port = 14540): Promise<void> {
    if (active) return
    if (!isDesktopApp()) {
        throw new Error('SITL requires the desktop app')
    }
    const bridge = nativeBridge()
    if (!bridge) throw new Error('Native bridge unavailable')
    const socket = getSocket()

    const result = await bridge.start('udp', NATIVE_UDP_ID, { ports: [{ tag: 0, port }] })
    if (!result.ok) {
        if (result.error?.includes('EADDRINUSE')) {
            throw new Error(
                `Port ${port} is already in use on this computer — close QGroundControl, ` +
                'a relay script, or any other ground station software, then try again.'
            )
        }
        throw new Error(result.error || `Could not bind udp:${port}`)
    }

    silenceTimer = setTimeout(() => {
        silenceTimer = null
        onSilence?.(
            `Bound udp:${port} on this computer, but your SITL hasn't sent anything to it. ` +
            `PX4 SITL's API link sends to 127.0.0.1:${port} by default (see px4-rc.mavlink: ` +
            `mavlink start -u 14580 -m onboard -o ${port}). If SITL is running inside WSL, ` +
            `Docker, or a VM, its packets never reach this machine — set PX4's target address ` +
            `to this computer's IP and make sure your firewall allows inbound UDP ${port}.`
        )
    }, SILENCE_TIMEOUT_MS)

    nativeUnsubscribe = bridge.onEvent((event: BridgeEvent) => {
        if (event.bridge !== 'udp' || event.id !== NATIVE_UDP_ID) return
        // First real packet — SITL is alive, so cancel the silence warning.
        if (event.type === 'status' && event.meta?.receiving && silenceTimer) {
            clearTimeout(silenceTimer)
            silenceTimer = null
        }
        if (event.type !== 'data' || !event.data) return
        // Pass the Uint8Array itself, not .buffer — .buffer could include
        // bytes outside this view if it's not exactly-sized (unlike
        // localSwarmRelay.ts's native path, which sends a freshly
        // allocated, exact-size buffer). socket.io-client serializes a
        // TypedArray correctly on its own.
        socket.emit('serial_uplink', event.data)
    })

    socket.on('serial_downlink', onNativeDownlink)
    socket.emit('connect_browser_serial', { source: 'remote-sitl' })
    active = true
}

function onNativeDownlink(data: ArrayBuffer) {
    nativeBridge()?.send('udp', NATIVE_UDP_ID, new Uint8Array(data), { tag: 0 })
}

export async function stopRemoteSitlRelay(): Promise<void> {
    if (!active) return
    active = false
    const socket = getSocket()

    if (silenceTimer) {
        clearTimeout(silenceTimer)
        silenceTimer = null
    }
    if (nativeUnsubscribe) {
        nativeUnsubscribe()
        nativeUnsubscribe = null
    }
    socket.off('serial_downlink', onNativeDownlink)
    await nativeBridge()?.stop('udp', NATIVE_UDP_ID)
}
