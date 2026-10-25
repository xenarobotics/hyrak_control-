'use client'

// Auto-connect to vehicles, QGroundControl style.
//
// DESKTOP APP: the main process watches serial ports (every 2 s, classified by
// USB vendor/product id), probes each flight controller or SiK radio for a
// MAVLink heartbeat, and listens on UDP 14550 (desktop/src/autoconnect). It
// only reports; AutoConnectAgent then performs the SAME connect the operator
// would have clicked (connectNativeSerial / connectRemoteSitl), so the backend
// path is unchanged.
//
// BROWSER: Web Serial cannot open a port the user never granted - that needs
// the picker and a click. It CAN reopen ports granted before
// (navigator.serial.getPorts()) and hears them being plugged in ('connect'),
// so that is what auto-connect does in a browser tab.
//
// Never steals a link: nothing happens while this session has one, and when
// a link ends every port present at that moment is left alone until it is
// unplugged and plugged back in.

import { create } from 'zustand'
import { isDesktopApp, nativeAutoConnect } from '@/lib/nativeBridge'
import type { SerialPortLike } from '@/lib/browserSerial'

export interface AutoConnectConfig {
    enabled: boolean
    usb: boolean
    sik: boolean
    udp: boolean
    udpPort: number
    /** Accept UDP vehicles from other machines (off: this computer only). */
    udpLan: boolean
}

export const DEFAULT_AUTOCONNECT: AutoConnectConfig = { enabled: true, usb: true, sik: true, udp: true, udpPort: 14550, udpLan: false }

export type PortClass = 'fc' | 'sik' | 'other'

export interface AutoPort {
    path: string
    cls: PortClass
    name: string
    baud: number
    vendorId?: string
    productId?: string
    state: 'idle' | 'probing' | 'waiting' | 'found' | 'suppressed' | 'ignored'
}

export interface SerialVehicleEvent {
    type: 'vehicle'; link: 'serial'; key: string; path: string; baud: number
    cls: PortClass; name: string; vehicle: string
}
export interface UdpVehicleEvent {
    type: 'vehicle'; link: 'udp'; key: string; port: number; from: string
    systems: { sysid: number; vehicle: string; from: string }[]
}
export interface StatusEvent {
    type: 'status'; udp: 'off' | 'listening' | 'busy' | 'paused'; probing: string | null; paused: boolean; reason?: string
}
export type AutoConnectEvent =
    | { type: 'ports'; ports: AutoPort[] }
    | SerialVehicleEvent
    | UdpVehicleEvent
    | StatusEvent

export interface AutoToast {
    id: number
    tone: 'ok' | 'info' | 'warn'
    title: string
    body: string
    action?: 'disconnect' | 'fleet'
}

interface AutoConnectState {
    config: AutoConnectConfig
    loaded: boolean
    /** Desktop shell present but too old to have auto-connect. */
    unsupported: boolean
    ports: AutoPort[]
    status: StatusEvent | null
    toast: AutoToast | null
    /** Last automatic connection, for the settings page. */
    last: { at: number; what: string } | null
    setToast: (t: Omit<AutoToast, 'id'> | null) => void
}

let toastSeq = 0
export const useAutoConnectStore = create<AutoConnectState>((set) => ({
    config: DEFAULT_AUTOCONNECT,
    loaded: false,
    unsupported: false,
    ports: [],
    status: null,
    toast: null,
    last: null,
    setToast: (t) => set({ toast: t ? { ...t, id: ++toastSeq } : null }),
}))

// ---- settings -----------------------------------------------------------------

const LS_KEY = 'hyrak-autoconnect'

function readLocal(): AutoConnectConfig {
    try {
        const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
        return { ...DEFAULT_AUTOCONNECT, ...(raw && typeof raw === 'object' ? raw : {}) }
    } catch {
        return { ...DEFAULT_AUTOCONNECT }
    }
}

/** Loads the settings: from the desktop app's own config file, or from this
 *  browser's storage. */
export async function loadAutoConnectConfig(): Promise<AutoConnectConfig> {
    const api = nativeAutoConnect()
    if (isDesktopApp()) {
        if (!api) {
            useAutoConnectStore.setState({ unsupported: true, loaded: true })
            return useAutoConnectStore.getState().config
        }
        try {
            const r = await api.get() as { config?: AutoConnectConfig; ports?: AutoPort[] } | null
            const config = { ...DEFAULT_AUTOCONNECT, ...(r?.config ?? {}) }
            useAutoConnectStore.setState({ config, ports: r?.ports ?? [], loaded: true })
            return config
        } catch {
            useAutoConnectStore.setState({ loaded: true })
            return useAutoConnectStore.getState().config
        }
    }
    const config = readLocal()
    useAutoConnectStore.setState({ config, loaded: true })
    return config
}

export async function saveAutoConnectConfig(patch: Partial<AutoConnectConfig>): Promise<void> {
    const next = { ...useAutoConnectStore.getState().config, ...patch }
    useAutoConnectStore.setState({ config: next })
    const api = nativeAutoConnect()
    if (isDesktopApp() && api) {
        try {
            const saved = await api.set(patch) as AutoConnectConfig | null
            if (saved) useAutoConnectStore.setState({ config: { ...DEFAULT_AUTOCONNECT, ...saved } })
        } catch { /* keep the optimistic value */ }
        return
    }
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)) } catch { /* private window */ }
}

// ---- browser: reopen granted ports ---------------------------------------------

// Same chips as browserSerial.ts / the desktop classifier.
const FC_VENDORS = new Set([0x26ac, 0x2dae, 0x3162, 0x35a7, 0x3185, 0x1fc9, 0x27ac])
const FC_PRODUCTS = new Set(['1209:5740', '1209:db42', '0483:5740'])
const SIK_PRODUCTS = new Set(['0403:6015', '10c4:ea60', '0403:6001'])
const hex4 = (n?: number) => (n ?? 0).toString(16).padStart(4, '0')

export function classifyWebSerial(port: SerialPortLike): { cls: PortClass; baud: number } {
    const { usbVendorId: vid, usbProductId: pid } = port.getInfo()
    if (vid === undefined) return { cls: 'other', baud: 57600 }
    const key = `${hex4(vid)}:${hex4(pid)}`
    if (FC_PRODUCTS.has(key) || FC_VENDORS.has(vid)) return { cls: 'fc', baud: 115200 }
    if (SIK_PRODUCTS.has(key)) return { cls: 'sik', baud: 57600 }
    return { cls: 'other', baud: 57600 }
}

const NON_VEHICLE = new Set([6, 18, 26, 27, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40])

/** Minimal HEARTBEAT finder (msgid 0, CRC_EXTRA 50), v1 and v2. Same rules as
 *  desktop/src/mavlink/heartbeat.ts: ground stations and peripherals are not
 *  vehicles. */
export class HeartbeatFinder {
    private buf = new Uint8Array(0)
    push(chunk: Uint8Array): { sysid: number; type: number; autopilot: number } | null {
        const m = new Uint8Array(this.buf.length + chunk.length)
        m.set(this.buf); m.set(chunk, this.buf.length)
        let i = 0
        while (i < m.length) {
            const v2 = m[i] === 0xfd
            if (m[i] !== 0xfe && !v2) { i++; continue }
            const hdr = v2 ? 10 : 6
            if (m.length - i < hdr) break
            const len = m[i + 1]
            const msgid = v2 ? m[i + 7] | (m[i + 8] << 8) | (m[i + 9] << 16) : m[i + 5]
            if (msgid !== 0) { i++; continue }
            const sig = v2 && (m[i + 2] & 1) ? 13 : 0
            if (m.length - i < hdr + len + 2 + sig) break
            let c = 0xffff
            const acc = (b: number) => {
                let t = b ^ (c & 0xff)
                t = (t ^ (t << 4)) & 0xff
                c = ((c >> 8) ^ (t << 8) ^ (t << 3) ^ (t >> 4)) & 0xffff
            }
            for (let k = i + 1; k < i + hdr + len; k++) acc(m[k])
            acc(50)
            if ((m[i + hdr + len] | (m[i + hdr + len + 1] << 8)) !== c) { i++; continue }
            const p = new Uint8Array(9)
            p.set(m.subarray(i + hdr, i + hdr + Math.min(9, len)))
            const type = p[4], autopilot = p[5]
            const sysid = m[i + (v2 ? 5 : 3)]
            i += hdr + len + 2 + sig
            const nonVehicle = autopilot === 8 || NON_VEHICLE.has(type)
            if (!nonVehicle) { this.buf = new Uint8Array(0); return { sysid, type, autopilot } }
        }
        const rest = m.subarray(i)
        this.buf = rest.length > 280 ? rest.slice(rest.length - 280) : rest.slice()
        return null
    }
}

/** Opens a granted Web Serial port, listens up to `ms` for a vehicle
 *  heartbeat, and closes it again. Never writes. */
export async function probeWebSerial(port: SerialPortLike, baud: number, ms = 3000): Promise<boolean> {
    try {
        await port.open({ baudRate: baud, bufferSize: 16384 })
    } catch {
        return false
    }
    const finder = new HeartbeatFinder()
    const reader = port.readable?.getReader()
    let found = false
    if (reader) {
        const timer = setTimeout(() => { void reader.cancel().catch(() => { /* closed */ }) }, ms)
        try {
            for (;;) {
                const { value, done } = await reader.read()
                if (done) break
                if (value && finder.push(value)) { found = true; break }
            }
        } catch { /* cancelled or unplugged */ }
        clearTimeout(timer)
        try { await reader.cancel() } catch { /* already */ }
        try { reader.releaseLock() } catch { /* already */ }
    }
    try { await port.close() } catch { /* already closed */ }
    return found
}
