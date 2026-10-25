// IPC for the two QGroundControl-parity features that are not bridges:
// auto-connect (autoconnect/manager.ts) and firmware flashing
// (firmware/service.ts). Kept out of app-main.ts so that file only gains a
// couple of lines. Every handler checks the sender like the bridge handlers.

import { app, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { SerialPort } from 'serialport'
import { AutoConnectManager, type AutoConnectConfig, type AutoConnectEvent } from './autoconnect/manager'
import { loadAutoConnectConfig, realAutoConnectDeps, saveAutoConnectConfig } from './autoconnect/realDeps'
import { FirmwareService, type FirmwareEvent, type FlashSource } from './firmware/service'
import { openBootloaderPort } from './firmware/serialAdapter'

type Trusted = (evt: IpcMainEvent | IpcMainInvokeEvent) => boolean

const MAX_FIRMWARE_BYTES = 32 * 1024 * 1024

async function fetchText(url: string, onProgress: (f: number) => void): Promise<string> {
    const ctrl = new AbortController()
    let idle = setTimeout(() => ctrl.abort(), 30000)
    try {
        const res = await fetch(url, { signal: ctrl.signal })
        if (res.status === 404) throw new Error('there is no build of this firmware for this board on that channel')
        if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`)
        const total = Number(res.headers.get('content-length')) || 0
        const reader = res.body.getReader()
        const parts: Uint8Array[] = []
        let got = 0
        for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            clearTimeout(idle)
            idle = setTimeout(() => ctrl.abort(), 30000)
            parts.push(value)
            got += value.length
            if (got > MAX_FIRMWARE_BYTES) throw new Error('the download is far larger than any firmware file')
            if (total) onProgress(Math.min(1, got / total))
        }
        return Buffer.concat(parts.map(p => Buffer.from(p))).toString('utf8')
    } catch (err) {
        if ((err as Error).name === 'AbortError') throw new Error('the download stalled (no data for 30 s)')
        throw err
    } finally {
        clearTimeout(idle)
    }
}

export interface HardwareServices {
    autoConnect: AutoConnectManager
    firmware: FirmwareService
    /** Call before a bridge opens a port (see app-main.ts). */
    beforeBridgeStart(kind: string, config: Record<string, unknown>): Promise<void>
    shutdown(): Promise<void>
}

export function registerHardwareIpc(isTrusted: Trusted, mainContents: () => WebContents | null): HardwareServices {
    const send = (channel: string, payload: unknown) => {
        const wc = mainContents()
        if (wc && !wc.isDestroyed()) wc.send(channel, payload)
    }
    const configDir = app.getPath('userData')

    const autoConnect = new AutoConnectManager(realAutoConnectDeps(), (e: AutoConnectEvent) => send('hyrak-autoconnect-event', e))
    autoConnect.setConfig(loadAutoConnectConfig(configDir))

    const firmware = new FirmwareService({
        listPorts: () => SerialPort.list(),
        openPort: openBootloaderPort,
        fetchText,
        now: () => Date.now(),
        sleep: (ms) => new Promise(r => setTimeout(r, ms)),
        setBusy: (busy) => autoConnect.setFirmwareBusy(busy),
    }, (e: FirmwareEvent) => send('hyrak-firmware-event', e))

    // ---- auto-connect
    ipcMain.handle('hyrak-autoconnect-get', (evt) => {
        if (!isTrusted(evt)) return null
        return { config: autoConnect.getConfig(), ports: autoConnect.listPortsSnapshot() }
    })
    ipcMain.handle('hyrak-autoconnect-set', (evt, patch: Partial<AutoConnectConfig>) => {
        if (!isTrusted(evt)) return null
        const cfg = autoConnect.setConfig(patch ?? {})
        saveAutoConnectConfig(configDir, cfg)
        return cfg
    })
    ipcMain.on('hyrak-autoconnect-gate', (evt, gate: { ready?: boolean; linkActive?: boolean }) => {
        if (!isTrusted(evt)) return
        autoConnect.start()
        autoConnect.setGate(gate ?? {})
    })
    ipcMain.on('hyrak-autoconnect-suppress', (evt) => {
        if (isTrusted(evt)) autoConnect.suppressPresent()
    })
    ipcMain.on('hyrak-autoconnect-release', (evt, key: string) => {
        if (isTrusted(evt) && typeof key === 'string') autoConnect.release(key)
    })

    // ---- firmware
    ipcMain.handle('hyrak-firmware-status', (evt) => (isTrusted(evt) ? firmware.status() : null))
    ipcMain.handle('hyrak-firmware-start', (evt) => (isTrusted(evt) ? firmware.start() : { ok: false, error: 'untrusted sender' }))
    ipcMain.handle('hyrak-firmware-cancel', (evt) => (isTrusted(evt) ? firmware.cancel() : { ok: false, error: 'untrusted sender' }))
    ipcMain.handle('hyrak-firmware-flash', (evt, source: FlashSource) => {
        if (!isTrusted(evt)) return { ok: false, error: 'untrusted sender' }
        if (!source || (source.kind !== 'official' && source.kind !== 'custom')) return { ok: false, error: 'bad request' }
        if (source.kind === 'custom' && (typeof source.text !== 'string' || source.text.length > MAX_FIRMWARE_BYTES * 2)) {
            return { ok: false, error: 'that file is not a usable .px4 file' }
        }
        return firmware.flash(source)
    })

    return {
        autoConnect,
        firmware,
        async beforeBridgeStart(kind, config) {
            // A manual connect always wins over a probe in progress.
            await autoConnect.yieldResources(kind, config ?? {})
        },
        async shutdown() {
            await autoConnect.stop()
            await firmware.dispose()
        },
    }
}
