// Web Serial relay - the telemetry counterpart of camera sharing in the
// cloud model. The user's radio (3DR/SiK) is plugged into THEIR device; the
// browser opens it via the Web Serial API and pipes raw MAVLink bytes to the
// backend over socket.io, where a loopback bridge feeds them into
// mavsdk_server (see backend app/telemetry/serial_bridge.py).
// Web Serial is Chrome/Edge desktop only - not Firefox/Safari/mobile.
//
// QGC-like port handling: the browser can only enumerate ports the user has
// granted ONCE (via the picker); after that, listGrantedPorts() returns every
// granted radio currently plugged in, and connecting needs no popup.

import { getSocket } from '@/lib/socket'
import { feedLocal, registerLocalLink, unregisterLocalLink } from '@/lib/localLink'

export type SerialPortLike = {
    open(opts: { baudRate: number; bufferSize?: number }): Promise<void>
    close(): Promise<void>
    getInfo(): { usbVendorId?: number; usbProductId?: number }
    readable: ReadableStream<Uint8Array> | null
    writable: WritableStream<Uint8Array> | null
}

export type GrantedRadio = { port: SerialPortLike; label: string; isFc?: boolean }

type SerialApi = {
    getPorts(): Promise<SerialPortLike[]>
    requestPort(): Promise<SerialPortLike>
    addEventListener?(type: string, cb: () => void): void
    removeEventListener?(type: string, cb: () => void): void
}

let port: SerialPortLike | null = null
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
let active = false

export const browserSerialSupported = () =>
    typeof navigator !== 'undefined' && 'serial' in navigator

/** Why the browser cannot open a USB port, in words the operator can act on.
 *  null when it can.
 *
 *  THE UI USED TO JUST HIDE THE BUTTON. A flight controller plugged straight
 *  into USB works in the desktop app and appears to be unsupported in the
 *  browser, with no control to press and nothing saying why - and the usual
 *  cause is not the browser at all. `navigator.serial` exists ONLY IN A SECURE
 *  CONTEXT, so reaching the dev server at http://192.168.x.x:3000 removes the
 *  entire Web Serial API while https://<the same machine> and
 *  http://localhost:3000 both keep it. That is invisible from the page and
 *  produces exactly the reported symptom.
 */
export function serialUnavailableReason(): string | null {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return null
    if ('serial' in navigator) return null
    if (!window.isSecureContext) {
        return (
            `This page is on ${window.location.origin}, which the browser does not ` +
            `treat as a secure context - USB access is switched off entirely. ` +
            `Open it over HTTPS, or as http://localhost:${window.location.port || '3000'} ` +
            `on the machine the cable is plugged into.`
        )
    }
    const ua = navigator.userAgent
    if (/Firefox\//.test(ua)) return 'Firefox does not implement Web Serial. Use Chrome or Edge.'
    if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return 'Safari does not implement Web Serial. Use Chrome or Edge.'
    if (/Android|iPhone|iPad/.test(ua)) return 'Mobile browsers do not implement Web Serial. Use a desktop browser or the desktop app.'
    return 'This browser does not implement Web Serial. Use Chrome or Edge, or the desktop app.'
}

export const isBrowserSerialActive = () => active

export const getSerialApi = (): SerialApi | null =>
    browserSerialSupported()
        ? (navigator as unknown as { serial: SerialApi }).serial
        : null

// USB devices this app expects to see. BOTH KINDS, because the port picker
// is the same one either way: a telemetry radio on the ground, or the flight
// controller itself on the end of a USB cable. The list said "radio"
// throughout, which reads as "this is not the control for a flight
// controller" - and the one thing an operator with a cable in their hand
// needs is to know that it is.
const VENDOR_NAMES: Record<number, string> = {
    0x0403: 'FTDI radio',        // 3DR ground module
    0x10c4: 'SiK radio (CP210x)',
    0x067b: 'Prolific serial',
    0x1a86: 'CH340 serial',
    // Flight controllers over USB CDC-ACM.
    0x26ac: 'PX4 / 3DR flight controller',
    0x1209: 'PX4 flight controller',
    0x2dae: 'Cube (Hex) flight controller',
    0x0483: 'STM32 flight controller',
    0x35a7: 'ARK flight controller',
}

/** True for vendor IDs that are a flight controller rather than a radio. USB
 *  CDC ignores the baud rate entirely, so offering a SiK radio's 57600 next to
 *  one is noise at best and a wrong lead when the link does not come up. */
const FC_VENDORS = new Set([0x26ac, 0x1209, 0x2dae, 0x0483, 0x35a7])

export function isFlightController(port: SerialPortLike): boolean {
    const vid = port.getInfo().usbVendorId
    return vid !== undefined && FC_VENDORS.has(vid)
}

const hex = (n?: number) =>
    n === undefined ? '????' : n.toString(16).padStart(4, '0')

// Radios the user has already granted AND that are currently plugged in.
export async function listGrantedPorts(): Promise<GrantedRadio[]> {
    const api = getSerialApi()
    if (!api) return []
    const ports = await api.getPorts()
    return ports.map((p, i) => {
        const { usbVendorId: vid, usbProductId: pid } = p.getInfo()
        const name = (vid !== undefined && VENDOR_NAMES[vid]) || `USB serial ${hex(vid)}:${hex(pid)}`
        // Disambiguate identical radios (two FTDI dongles, etc.)
        const dupes = ports.filter(q => {
            const info = q.getInfo()
            return info.usbVendorId === vid && info.usbProductId === pid
        })
        return {
            port: p,
            label: dupes.length > 1 ? `${name} #${i + 1}` : name,
            isFc: vid !== undefined && FC_VENDORS.has(vid),
        }
    })
}

// One-time grant: opens the browser's picker (needs a user gesture). Returns
// the granted port, or null if the user cancelled. After this the radio shows
// up in listGrantedPorts() on every future visit - no more popups.
export async function requestRadioPort(): Promise<SerialPortLike | null> {
    const api = getSerialApi()
    if (!api) return null
    try {
        return await api.requestPort()
    } catch {
        return null // picker cancelled
    }
}

// Opens the given (already granted) radio and starts relaying. Throws if the
// port can't be opened (busy in another app/tab, unplugged).
// Chrome's Web Serial defaults to a 255-byte internal buffer. A 3DR/SiK
// radio at 57600 baud fills that in ~45ms, so any main-thread stall of that
// length (a video frame decode, a canvas redraw, a GC pause) throws a
// buffer-overrun error and drops bytes out of the MAVLink stream. 16KB
// gives ~2.7s of cushion at 57600 baud - comfortably more than any UI
// hiccup - at the cost of a little extra read latency, which MAVLink
// doesn't care about.
const _SERIAL_BUFFER_SIZE = 16384

export async function startBrowserSerial(radio: SerialPortLike, baudRate = 57600): Promise<void> {
    if (active) return
    await radio.open({ baudRate, bufferSize: _SERIAL_BUFFER_SIZE })
    port = radio
    writer = radio.writable?.getWriter() ?? null
    active = true

    const socket = getSocket()
    socket.on('serial_downlink', onDownlink)
    registerLocalLink(localSend)
    // The backend waits for the drone's heartbeat to arrive through this
    // relay, so start pumping bytes immediately - don't wait for status.
    socket.emit('connect_browser_serial', { source: 'web-serial' })
    void readLoop()
}

// Per the Web Serial spec, these read() errors mean a few bytes were lost
// (radio momentarily outran the buffer) - the port itself is still fine.
// MAVLink resyncs on the next valid packet's start marker, so the right
// move is to grab a fresh reader and keep going, not tear down the link.
const _RECOVERABLE_SERIAL_ERRORS = new Set([
    'BufferOverrunError', 'ParityError', 'FramingError', 'BreakError',
])

async function readLoop() {
    const socket = getSocket()
    try {
        while (active && port?.readable) {
            reader = port.readable.getReader()
            try {
                for (;;) {
                    const { value, done } = await reader.read()
                    if (done || !active) break
                    if (value && value.byteLength > 0) {
                        feedLocal(value)
                        socket.volatile.emit(
                            'serial_uplink',
                            value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
                        )
                    }
                }
            } catch (err) {
                const name = (err as { name?: string } | undefined)?.name
                if (name && _RECOVERABLE_SERIAL_ERRORS.has(name)) {
                    console.warn(`Serial ${name} - a few bytes were dropped, resuming`)
                } else {
                    throw err
                }
            } finally {
                reader.releaseLock()
                reader = null
            }
        }
    } catch (err) {
        console.error('Browser serial read failed - radio unplugged?', err)
    }
    if (active) void stopBrowserSerial()
}

// The local link fallback (lib/localLink.ts) writes through the same path.
const localSend = (b: Uint8Array) => { writer?.write(b).catch(() => { /* port closing */ }) }

function onDownlink(data: ArrayBuffer) {
    writer?.write(new Uint8Array(data)).catch(() => { /* port closing */ })
}

export async function stopBrowserSerial(): Promise<void> {
    if (!active && !port) return
    active = false
    getSocket().off('serial_downlink', onDownlink)
    unregisterLocalLink(localSend)
    try { await reader?.cancel() } catch { /* already released */ }
    try { writer?.releaseLock() } catch { /* already released */ }
    writer = null
    try { await port?.close() } catch { /* already closed */ }
    port = null
}
