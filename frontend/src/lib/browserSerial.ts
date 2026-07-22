// Web Serial relay — the telemetry counterpart of camera sharing in the
// cloud model. The user's radio (3DR/SiK) is plugged into THEIR device; the
// browser opens it via the Web Serial API and pipes raw MAVLink bytes to the
// backend over socket.io, where a loopback bridge feeds them into
// mavsdk_server (see backend app/telemetry/serial_bridge.py).
// Web Serial is Chrome/Edge desktop only — not Firefox/Safari/mobile.
//
// QGC-like port handling: the browser can only enumerate ports the user has
// granted ONCE (via the picker); after that, listGrantedPorts() returns every
// granted radio currently plugged in, and connecting needs no popup.

import { getSocket } from '@/lib/socket'

export type SerialPortLike = {
    open(opts: { baudRate: number; bufferSize?: number }): Promise<void>
    close(): Promise<void>
    getInfo(): { usbVendorId?: number; usbProductId?: number }
    readable: ReadableStream<Uint8Array> | null
    writable: WritableStream<Uint8Array> | null
}

export type GrantedRadio = { port: SerialPortLike; label: string }

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

export const isBrowserSerialActive = () => active

export const getSerialApi = (): SerialApi | null =>
    browserSerialSupported()
        ? (navigator as unknown as { serial: SerialApi }).serial
        : null

// Friendly names for common telemetry-radio USB bridge chips.
const VENDOR_NAMES: Record<number, string> = {
    0x0403: 'FTDI radio',        // 3DR ground module
    0x10c4: 'SiK radio (CP210x)',
    0x26ac: '3DR / PX4',
    0x067b: 'Prolific serial',
    0x1a86: 'CH340 serial',
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
        return { port: p, label: dupes.length > 1 ? `${name} #${i + 1}` : name }
    })
}

// One-time grant: opens the browser's picker (needs a user gesture). Returns
// the granted port, or null if the user cancelled. After this the radio shows
// up in listGrantedPorts() on every future visit — no more popups.
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
// gives ~2.7s of cushion at 57600 baud — comfortably more than any UI
// hiccup — at the cost of a little extra read latency, which MAVLink
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
    // The backend waits for the drone's heartbeat to arrive through this
    // relay, so start pumping bytes immediately — don't wait for status.
    socket.emit('connect_browser_serial', {})
    void readLoop()
}

// Per the Web Serial spec, these read() errors mean a few bytes were lost
// (radio momentarily outran the buffer) — the port itself is still fine.
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
                        socket.emit(
                            'serial_uplink',
                            value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
                        )
                    }
                }
            } catch (err) {
                const name = (err as { name?: string } | undefined)?.name
                if (name && _RECOVERABLE_SERIAL_ERRORS.has(name)) {
                    console.warn(`Serial ${name} — a few bytes were dropped, resuming`)
                } else {
                    throw err
                }
            } finally {
                reader.releaseLock()
                reader = null
            }
        }
    } catch (err) {
        console.error('Browser serial read failed — radio unplugged?', err)
    }
    if (active) void stopBrowserSerial()
}

function onDownlink(data: ArrayBuffer) {
    writer?.write(new Uint8Array(data)).catch(() => { /* port closing */ })
}

export async function stopBrowserSerial(): Promise<void> {
    if (!active && !port) return
    active = false
    getSocket().off('serial_downlink', onDownlink)
    try { await reader?.cancel() } catch { /* already released */ }
    try { writer?.releaseLock() } catch { /* already released */ }
    writer = null
    try { await port?.close() } catch { /* already closed */ }
    port = null
}
