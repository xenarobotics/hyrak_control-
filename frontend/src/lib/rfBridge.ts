// Configurable ports for the "Custom RF air unit (wfb-ng)" telemetry
// preset — see backend/app/telemetry/rf_bridge.py. Defaults match
// communication/start-gs.sh's fixed ports (video 5600 lives in
// videoSource.ts, alongside the other video-source settings); editable
// here in case a ground-station config uses different ports.

const DOWNLINK_KEY = 'hyrak-rf-downlink-port'
const UPLINK_KEY = 'hyrak-rf-uplink-port'
const UPLINK_HOST_KEY = 'hyrak-rf-uplink-host'

export const DEFAULT_RF_DOWNLINK_PORT = 14550
export const DEFAULT_RF_UPLINK_PORT = 14551
// Loopback, because the original rig had the RTL dongle plugged into the same
// PC as the backend — wfb_tx was a process on this machine.
//
// It stops being loopback the moment the decoder moves off-box. With the
// ground decoder on its own board (Luckfox over Ethernet), the downlink still
// arrives here unchanged — it is a UDP send TO us, and we bind 0.0.0.0 — but
// the uplink is a send FROM us to a listener that is now on another host. Sent
// to 127.0.0.1 it goes nowhere: telemetry reads perfectly and no command,
// mission upload or parameter write ever reaches the aircraft.
export const DEFAULT_RF_UPLINK_HOST = '127.0.0.1'

function getPort(key: string, fallback: number): number {
    if (typeof window === 'undefined') return fallback
    try {
        const v = Number(localStorage.getItem(key))
        return v > 0 && v < 65536 ? v : fallback
    } catch {
        return fallback
    }
}

export function getRfDownlinkPort(): number {
    return getPort(DOWNLINK_KEY, DEFAULT_RF_DOWNLINK_PORT)
}
export function setRfDownlinkPort(port: number): void {
    if (typeof window !== 'undefined') localStorage.setItem(DOWNLINK_KEY, String(port))
}
export function getRfUplinkPort(): number {
    return getPort(UPLINK_KEY, DEFAULT_RF_UPLINK_PORT)
}
export function setRfUplinkPort(port: number): void {
    if (typeof window !== 'undefined') localStorage.setItem(UPLINK_KEY, String(port))
}

/** Host running the uplink listener (wfb_tx / the ground decoder). */
export function getRfUplinkHost(): string {
    if (typeof window === 'undefined') return DEFAULT_RF_UPLINK_HOST
    try {
        return localStorage.getItem(UPLINK_HOST_KEY)?.trim() || DEFAULT_RF_UPLINK_HOST
    } catch {
        return DEFAULT_RF_UPLINK_HOST
    }
}
export function setRfUplinkHost(host: string): void {
    if (typeof window !== 'undefined') {
        localStorage.setItem(UPLINK_HOST_KEY, host.trim() || DEFAULT_RF_UPLINK_HOST)
    }
}

// Optional verbatim copy of the MAVLink DOWNLINK to another local UDP port.
//
// Only one process can receive a unicast UDP port, so HYRAK binding 14550
// takes it away from anything else pointed there — QGroundControl being the
// case that came up (to load the full parameter set and upload missions).
// Set this and point QGC at the fan-out port instead: HYRAK keeps the real
// link, QGC gets its own copy of the same downlink.
//
// Read-only for QGC by design. The fan-out carries downlink only — the uplink
// stays exclusively HYRAK's, because two ground stations commanding one
// aircraft is a genuinely bad idea. QGC will show telemetry, parameters and the
// mission it downloads, but its writes do not reach the aircraft through here.
const FANOUT_KEY = 'hyrak-rf-fanout-port'
export const DEFAULT_RF_FANOUT_PORT = 0   // 0 = off

export function getRfFanoutPort(): number {
    return getPort(FANOUT_KEY, DEFAULT_RF_FANOUT_PORT)
}
export function setRfFanoutPort(port: number): void {
    if (typeof window !== 'undefined') localStorage.setItem(FANOUT_KEY, String(port))
}
