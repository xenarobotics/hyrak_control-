// Persisted defaults for the telemetry / command links.
//
// These were previously literals at their point of use — `useState('udp://:14540')`
// in TelemetryConnect, `useState(DEFAULT_SERIAL_BAUD)` in DeviceSelector — so
// an operator whose radio runs at 115200, or whose vehicle is not on the SITL
// default port, retyped the same value on every single connect. Saving them is
// the whole feature; nothing else about the connect flow changes.

const ADDRESS_KEY = 'hyrak-telemetry-address'
const BAUD_KEY = 'hyrak-telemetry-baud'

/** PX4 SITL's default MAVLink port — the right guess for a dev machine, and
 *  harmless anywhere else since it is only a prefill. */
export const DEFAULT_TELEMETRY_ADDRESS = 'udp://:14540'

/** Standard for SiK-family radios. RFD900 and some clones ship at 115200. */
export const DEFAULT_TELEMETRY_BAUD = 57600

export const BAUD_OPTIONS = [9600, 19200, 38400, 57600, 115200, 230400, 921600]

export function getTelemetryAddress(): string {
    if (typeof window === 'undefined') return DEFAULT_TELEMETRY_ADDRESS
    try {
        const v = localStorage.getItem(ADDRESS_KEY)
        return v && v.trim() ? v : DEFAULT_TELEMETRY_ADDRESS
    } catch {
        return DEFAULT_TELEMETRY_ADDRESS
    }
}

export function setTelemetryAddress(v: string): void {
    if (typeof window !== 'undefined') localStorage.setItem(ADDRESS_KEY, v)
}

export function getTelemetryBaud(): number {
    if (typeof window === 'undefined') return DEFAULT_TELEMETRY_BAUD
    try {
        const v = Number(localStorage.getItem(BAUD_KEY))
        // Validated against the known list rather than a range: a typo'd baud
        // opens the port successfully and then delivers nothing but garbage,
        // which presents as "the radio is dead" and is miserable to diagnose.
        return BAUD_OPTIONS.includes(v) ? v : DEFAULT_TELEMETRY_BAUD
    } catch {
        return DEFAULT_TELEMETRY_BAUD
    }
}

export function setTelemetryBaud(v: number): void {
    if (typeof window !== 'undefined') localStorage.setItem(BAUD_KEY, String(v))
}
