// Native serial telemetry - the desktop-app counterpart of browserSerial.ts.
//
// Both open the SAME physical radio (3DR/SiK on USB) and both end up emitting
// raw MAVLink on the existing `serial_uplink` / `serial_downlink` events, so
// backend/app/telemetry/serial_bridge.py needs no changes and cannot tell the
// two apart. The difference is purely how the port is obtained:
//
//   browser  -> navigator.serial.requestPort()  (Chrome's picker, one-time grant)
//   desktop  -> serialport's SerialPort.list()  (every port, no grant, no picker)
//
// This exists because Web Serial does NOT work in the desktop app. Electron
// ships navigator.serial, so browserSerialSupported() returns true and the "+"
// button appeared - but Electron has no built-in port-chooser UI, and unless the
// main process handles session's 'select-serial-port' event, requestPort() never
// resolves with a port. Result: clicking "+" did nothing at all, and
// listGrantedPorts() stayed empty forever because no grant could ever happen.
//
// Rather than implement a picker in the main process, the desktop app uses the
// SerialBridge that was already registered (desktop/src/bridges/serialBridge.ts)
// and has always exposed list(). That is strictly better than the browser path:
// no permission dance, all ports visible immediately, QGroundControl-style.
//
// Telemetry here is completely independent of the video source - video is picked
// in Settings (videoSource.ts), telemetry is picked in DeviceSelector. A 3DR
// radio for telemetry alongside a SIYI or HYRAK air-unit feed for video is a
// supported combination, not a special case.

import { getSocket } from '@/lib/socket'
import { isDesktopApp, nativeBridge, type BridgeEvent } from '@/lib/nativeBridge'

const NATIVE_SERIAL_ID = 'telemetry-radio'

export const DEFAULT_SERIAL_BAUD = 57600

let active = false
let unsubscribe: (() => void) | null = null
let silenceTimer: ReturnType<typeof setTimeout> | null = null
let sawTraffic = false

// Opening a serial port succeeds whether or not anything is on the other end -
// a radio that is unpaired, on the wrong air-side baud, or whose netID doesn't
// match the aircraft opens perfectly and delivers zero bytes. Say so instead of
// waiting out the backend's generic mavsdk timeout. Same reasoning as
// remoteSitlRelay.ts's SILENCE_TIMEOUT_MS.
const SILENCE_TIMEOUT_MS = 8000

export type SerialSilenceHandler = (message: string) => void
let onSilence: SerialSilenceHandler | null = null
export function setSerialSilenceHandler(h: SerialSilenceHandler | null) { onSilence = h }

export const isNativeSerialActive = () => active

/** What serialport's SerialPort.list() gives back, as much of it as we use. */
interface NativePortInfo {
    path: string
    manufacturer?: string
    serialNumber?: string
    vendorId?: string
    productId?: string
}

export interface NativeRadio {
    path: string
    label: string
}

// Same chips browserSerial.ts names, keyed by the hex STRING serialport
// reports rather than the numeric id Web Serial reports.
const VENDOR_NAMES: Record<string, string> = {
    '0403': 'FTDI radio',
    '10c4': 'SiK radio (CP210x)',
    '26ac': '3DR / PX4',
    '067b': 'Prolific serial',
    '1a86': 'CH340 serial',
}

// Ports that are never a telemetry radio and only make the list harder to read.
// On Linux every machine has a few /dev/ttyS* legacy UARTs that aren't wired to
// anything; a real USB radio always reports a vendorId.
function isPlausibleRadio(p: NativePortInfo): boolean {
    if (p.vendorId) return true
    return !/^\/dev\/ttyS\d+$/.test(p.path)
}

function labelFor(p: NativePortInfo): string {
    const vendor = p.vendorId ? VENDOR_NAMES[p.vendorId.toLowerCase()] : undefined
    const name = vendor || p.manufacturer || 'Serial port'
    // The path is what distinguishes two identical radios, so it always shows.
    return `${name} (${p.path})`
}

/** Every serial port on this machine. Desktop only - returns [] in a browser
 *  tab, where the caller should be using browserSerial.ts instead. */
export async function listNativeSerialPorts(): Promise<NativeRadio[]> {
    const bridge = nativeBridge()
    if (!isDesktopApp() || !bridge) return []
    try {
        const ports = (await bridge.list('serial')) as NativePortInfo[]
        return ports
            .filter(p => p && typeof p.path === 'string' && isPlausibleRadio(p))
            .map(p => ({ path: p.path, label: labelFor(p) }))
    } catch (err) {
        console.warn('Could not list serial ports', err)
        return []
    }
}

function onDownlink(data: ArrayBuffer | Uint8Array) {
    // mavsdk's replies (commands to the aircraft) -> radio -> air side.
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    nativeBridge()?.send('serial', NATIVE_SERIAL_ID, bytes)
}

/** Opens the radio and relays MAVLink both ways. Throws with the real reason
 *  when the port can't be opened (busy in QGC, unplugged, no permission). */
export async function startNativeSerial(
    path: string,
    baudRate = DEFAULT_SERIAL_BAUD,
): Promise<void> {
    if (!isDesktopApp()) {
        throw new Error(
            'Native serial needs the HYRAK desktop app - in a browser tab use the "+" '
            + 'button to grant a radio via Web Serial instead.',
        )
    }
    if (active) await stopNativeSerial()

    const bridge = nativeBridge()
    const result = await bridge?.start('serial', NATIVE_SERIAL_ID, { path, baudRate })
    if (result && !result.ok) {
        throw new Error(
            `${result.error}. Only one program can hold a serial port - if QGroundControl, `
            + 'Mission Planner or another HYRAK window has this radio open, close it first.'
            + (path.startsWith('/dev/')
                ? ' On Linux you may also need to be in the "dialout" group.'
                : ''),
        )
    }

    const socket = getSocket()
    sawTraffic = false
    unsubscribe = bridge?.onEvent((event: BridgeEvent) => {
        if (event.bridge !== 'serial' || event.id !== NATIVE_SERIAL_ID) return
        if (event.type !== 'data' || !event.data) return
        if (!sawTraffic) {
            sawTraffic = true
            if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null }
        }
        socket.emit('serial_uplink', event.data)
    }) ?? null

    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = setTimeout(() => {
        if (!active || sawTraffic) return
        onSilence?.(
            `Opened ${path} at ${baudRate} baud, but no MAVLink arrived in `
            + `${SILENCE_TIMEOUT_MS / 1000}s. Usually the baud rate is wrong (SiK radios are `
            + '57600 by default, some are 115200), the two radios are not paired '
            + '(NETID/frequency mismatch - the green link LED would be off), or the '
            + 'aircraft is powered down.',
        )
    }, SILENCE_TIMEOUT_MS)

    socket.on('serial_downlink', onDownlink)
    // Same event a Web Serial radio sends - from here the paths are identical.
    socket.emit('connect_browser_serial', { source: 'native-serial' })
    active = true
}

export async function stopNativeSerial(): Promise<void> {
    active = false
    sawTraffic = false
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null }
    if (unsubscribe) { unsubscribe(); unsubscribe = null }
    try { getSocket().off('serial_downlink', onDownlink) } catch { /* socket gone */ }
    if (isDesktopApp()) {
        try { await nativeBridge()?.stop('serial', NATIVE_SERIAL_ID) } catch { /* not running */ }
    }
}
