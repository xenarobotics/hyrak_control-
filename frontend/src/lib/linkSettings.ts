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

// ── Which link the operator picked ───────────────────────────────────────────
//
// PERSISTED SO TWO CONTROLS CAN SHOW THE SAME CHOICE. This used to live only
// in DeviceSelector's `useState('sitl')`, which was fine while the Fly tab was
// the only place a link could be picked. The status bar now offers the same
// choice from Mission and AI, and two components each holding their own copy
// of "which radio" is how they end up disagreeing about which one is
// connected — the operator switches port in the bar, walks to Fly, and finds
// the old one still selected.
const SOURCE_KEY = 'hyrak-telemetry-source'

/** Fired when the link selection changes, so a control mounted elsewhere
 *  updates immediately rather than on next mount. Same pattern the status-bar
 *  toggle already uses — localStorage has no in-tab change event. */
export const LINK_CHANGE_EVENT = 'hyrak-link-changed'

/** 'sitl' | 'radio-<i>' (Web Serial) | 'nradio-<i>' (native serial)
 *  | 'air-unit-udp' | 'local-relay' | 'siyi-udp' */
export const DEFAULT_TELEMETRY_SOURCE = 'sitl'

export function getTelemetrySource(): string {
    if (typeof window === 'undefined') return DEFAULT_TELEMETRY_SOURCE
    try {
        return localStorage.getItem(SOURCE_KEY) || DEFAULT_TELEMETRY_SOURCE
    } catch {
        return DEFAULT_TELEMETRY_SOURCE
    }
}

export function setTelemetrySource(v: string): void {
    if (typeof window === 'undefined') return
    localStorage.setItem(SOURCE_KEY, v)
    window.dispatchEvent(new CustomEvent<string>(LINK_CHANGE_EVENT, { detail: v }))
}
