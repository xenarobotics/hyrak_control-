// The real I/O behind AutoConnectManager: serialport for listing and probing,
// node:dgram for the UDP listener, a JSON file in the app's user-data folder
// for the settings. Kept apart from manager.ts so the logic loads in plain
// Node under unit tests without the native serialport binding.

import dgram from 'node:dgram'
import fs from 'node:fs'
import path from 'node:path'
import { SerialPort } from 'serialport'
import type { AutoConnectDeps, AutoConnectConfig, ProbeHandle, UdpLike } from './manager'
import { DEFAULT_AUTOCONNECT_CONFIG } from './manager'

export function realAutoConnectDeps(): AutoConnectDeps {
    return {
        listPorts: () => SerialPort.list(),
        openProbe: (portPath, baud) => new Promise<ProbeHandle>((resolve, reject) => {
            // Read-only probe. hupcl:false leaves DTR alone on close where the
            // driver allows it, so a radio is not reset by being looked at.
            const port = new SerialPort({ path: portPath, baudRate: baud, autoOpen: false, hupcl: false })
            port.open((err) => {
                if (err) { reject(err); return }
                port.on('error', () => { /* surfaced as silence; the probe times out */ })
                resolve({
                    onData: (cb) => { port.on('data', (b: Buffer) => cb(new Uint8Array(b))) },
                    close: () => new Promise<void>((r) => {
                        if (!port.isOpen) { r(); return }
                        port.close(() => r())
                    }),
                })
            })
        }),
        createUdp: (): UdpLike => {
            const sock = dgram.createSocket('udp4')
            let closed = false
            return {
                bind: (port, address) => new Promise<void>((resolve, reject) => {
                    const onErr = (e: Error) => reject(e)
                    sock.once('error', onErr)
                    sock.bind(port, address, () => {
                        sock.off('error', onErr)
                        sock.on('error', () => { /* ICMP noise */ })
                        resolve()
                    })
                }),
                onMessage: (cb) => { sock.on('message', (d, r) => cb(new Uint8Array(d), { address: r.address, port: r.port })) },
                close: () => new Promise<void>((r) => {
                    if (closed) { r(); return }
                    closed = true
                    try { sock.close(() => r()) } catch { r() }
                }),
            }
        },
        now: () => Date.now(),
        setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
        clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
    }
}

// ---- settings file ---------------------------------------------------------

export function loadAutoConnectConfig(dir: string): AutoConnectConfig {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, 'autoconnect.json'), 'utf8'))
        return { ...DEFAULT_AUTOCONNECT_CONFIG, ...pick(raw) }
    } catch {
        return { ...DEFAULT_AUTOCONNECT_CONFIG }
    }
}

export function saveAutoConnectConfig(dir: string, cfg: AutoConnectConfig): void {
    try {
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'autoconnect.json'), JSON.stringify(cfg, null, 2))
    } catch (err) {
        console.warn('could not save auto-connect settings', err)
    }
}

function pick(raw: unknown): Partial<AutoConnectConfig> {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const out: Partial<AutoConnectConfig> = {}
    for (const k of ['enabled', 'usb', 'sik', 'udp'] as const) if (typeof o[k] === 'boolean') out[k] = o[k] as boolean
    if (typeof o.udpPort === 'number') out.udpPort = o.udpPort
    return out
}
