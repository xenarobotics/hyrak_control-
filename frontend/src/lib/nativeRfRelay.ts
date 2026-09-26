// Custom RF air unit (wfb-ng) telemetry, read NATIVELY over UDP.
//
// This is the desktop replacement for localRfRelay.ts. Both consume the same
// two ports from a wfb-ng ground station (see wfb-gs's start-gs.sh):
//
//   udp <local>:14550        wfb_rx  -> MAVLink downlink from the aircraft
//   udp <uplink-host>:14551  wfb_tx  -> MAVLink uplink to the aircraft
//
// The uplink host is NOT loopback in general - see getRfUplinkHost(). It is
// loopback only while the RF decoder runs on this machine.
//
// The difference is what sits in between. localRfRelay.ts needs a separate
// telemetry_relay.py running alongside, purely because a browser tab cannot
// open a raw UDP socket - the agent re-exposes 14550/14551 as a loopback
// WebSocket. The desktop app has no such limitation, so this binds the ports
// directly through the native UDP bridge and the agent disappears: one fewer
// process for the operator to start, one fewer thing to be "not running" when
// telemetry silently fails.
//
// Zero backend changes, for the same reason every other telemetry path needed
// none: the bytes go up on the EXISTING `serial_uplink` and come back on
// `serial_downlink`, and backend/app/telemetry/serial_bridge.py has never cared
// where a client's MAVLink came from. Same shape as siyiTelemetryRelay.ts.
//
//   wfb_rx :14550 --> udpBridge --serial_uplink--> backend
//   wfb_tx :14551 <--          <-- serial_downlink
//
// ADDRESSING - the one real difference from the SIYI path. A SIYI ground unit
// is a single endpoint that both sends and receives, so the bridge's usual
// "learn the peer and reply to it" is correct there. A wfb-ng ground station is
// two processes on two fixed ports: wfb_rx sends to us from an EPHEMERAL source
// port, so replying to the learned peer would miss wfb_tx entirely. Hence
// pinRemote - always send to 14551, never to whoever was last heard from.

import { getSocket } from '@/lib/socket'
import { startHyrakRegistration, stopHyrakRegistration } from '@/lib/hyrakRegister'
import { isDesktopApp, nativeBridge, type BridgeEvent } from '@/lib/nativeBridge'
import { getRfDownlinkPort, getRfUplinkPort, getRfUplinkHost, getRfFanoutPort, isRfUplinkAuto } from '@/lib/rfBridge'

const NATIVE_UDP_ID = 'air-unit-telemetry'

let active = false
let unsubscribe: (() => void) | null = null
let silenceTimer: ReturnType<typeof setTimeout> | null = null
let sawTraffic = false

// Binding 14550 succeeds whether or not the ground station is running - an
// unstarted start-gs.sh, a monitor-mode NIC that never came up, or an aircraft
// that is powered down all bind perfectly and deliver nothing. Report that with
// its actual causes instead of waiting out mavsdk's generic timeout. Same
// reasoning as remoteSitlRelay.ts and nativeSerialRelay.ts.
const SILENCE_TIMEOUT_MS = 8000

export type RfSilenceHandler = (message: string) => void
let onSilence: RfSilenceHandler | null = null
export function setRfSilenceHandler(h: RfSilenceHandler | null) { onSilence = h }

export const isNativeRfRelayActive = () => active

function onDownlink(data: ArrayBuffer | Uint8Array) {
    // Backend -> wfb_tx:14551 -> RF -> aircraft.
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    nativeBridge()?.send('udp', NATIVE_UDP_ID, bytes)
}

/** Binds the ground station's MAVLink ports and relays both directions. */
export async function startNativeRfRelay(
    downlinkPort = getRfDownlinkPort(),
    uplinkPort = getRfUplinkPort(),
    uplinkHost = getRfUplinkHost(),
): Promise<void> {
    if (!isDesktopApp()) {
        throw new Error(
            'Native RF telemetry needs the HYRAK desktop app - a browser tab cannot read a raw '
            + 'UDP socket. Use the WebSocket relay agent option instead, or run the desktop app.',
        )
    }
    if (active) await stopNativeRfRelay()

    const bridge = nativeBridge()
    // One socket: bound to the downlink port, sending to the uplink port. Two
    // ports, but only ONE local socket is needed - we never receive on 14551,
    // that is wfb_tx's own bind.
    // THE UPLINK HOST WAS THE ONE THING NOT CONFIGURABLE, AND IT IS THE ONE
    // THING THAT MOVED. The port has always been a setting; the host was a
    // literal. That was correct only while wfb_tx ran on this same PC - which
    // it did, back when the RTL8812EU was plugged straight in. It now runs on
    // the Luckfox decoder at its own address, and 127.0.0.1:14551 on this PC
    // is a black hole with nothing bound to it.
    //
    // The resulting failure is silent and one-directional, which is why it
    // cost a whole evening: UDP reports nothing when a datagram goes nowhere,
    // the downlink is a separate socket and keeps working perfectly, and every
    // byte counter along the way - including the one I added on the server -
    // faithfully reports the commands as SENT. They are sent. They are sent
    // into loopback. getRfUplinkHost() already existed, defaulted correctly,
    // and had a field on the telemetry page; this relay just never read it.
    const result = await bridge?.start('udp', NATIVE_UDP_ID, {
        ports: [{
            tag: 0,
            port: downlinkPort,
            // "auto" = QGC behaviour: no pinned target, the bridge replies to
            // the address:port the downlink arrives from (udpBridge's learned
            // peer). Otherwise pin the uplink to wfb_tx at TX HOST:port.
            ...(isRfUplinkAuto(uplinkHost)
                ? {}
                : { remoteHost: uplinkHost, remotePort: uplinkPort, pinRemote: true }),
            // Lets QGroundControl watch the same downlink - see getRfFanoutPort.
            fanoutPort: getRfFanoutPort() || undefined,
        }],
    })
    if (result && !result.ok) {
        throw new Error(
            `${result.error}. Only one program can receive a UDP port - if QGroundControl, `
            + 'MAVProxy or telemetry_relay.py is already reading '
            + `${downlinkPort}, close it first.`,
        )
    }

    // Tell the decoder to point its feeds at THIS machine. Without it the
    // decoder infers the destination from its DHCP lease file, which cannot
    // see a statically addressed PC at all and keeps aiming at a departed
    // machine for up to 12 hours after it leaves. Best-effort and never
    // fatal: it is UDP, the feeds run regardless, and a browser session has
    // no socket to send it with.
    void startHyrakRegistration(uplinkHost, 'telemetry')

    const socket = getSocket()
    sawTraffic = false
    unsubscribe = bridge?.onEvent((event: BridgeEvent) => {
        if (event.bridge !== 'udp' || event.id !== NATIVE_UDP_ID) return
        if (event.type !== 'data' || !event.data) return
        if (!sawTraffic) {
            sawTraffic = true
            if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null }
        }
        // volatile: dropped while the socket is down, never replayed stale on reconnect
        socket.volatile.emit('serial_uplink', event.data)
    }) ?? null

    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = setTimeout(() => {
        if (!active || sawTraffic) return
        onSilence?.(
            `Bound udp:${downlinkPort}, but no MAVLink arrived in `
            + `${SILENCE_TIMEOUT_MS / 1000}s. Usually the ground station is not running `
            + '(start-gs.sh - it needs the RTL8812EU dongle in monitor mode), the aircraft '
            + 'is powered down, or the two ends are on different wfb-ng channels or keys.',
        )
    }, SILENCE_TIMEOUT_MS)

    socket.on('serial_downlink', onDownlink)
    // Same event every other telemetry path sends - from here they are identical.
    socket.emit('connect_browser_serial', { source: 'native-rf' })
    active = true
}

export async function stopNativeRfRelay(): Promise<void> {
    active = false
    sawTraffic = false
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null }
    if (unsubscribe) { unsubscribe(); unsubscribe = null }
    try { getSocket().off('serial_downlink', onDownlink) } catch { /* socket gone */ }
    // Drop this link's claim. Note this does NOT un-register: the decoder
    // never expires a client, so the feeds keep flowing - what stops is the
    // self-healing tick, and only once video has let go too.
    await stopHyrakRegistration('telemetry')
    if (isDesktopApp()) {
        try { await nativeBridge()?.stop('udp', NATIVE_UDP_ID) } catch { /* not running */ }
    }
}
