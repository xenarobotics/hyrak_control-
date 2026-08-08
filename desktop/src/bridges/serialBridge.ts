import { SerialPort } from 'serialport'
import type { NativeBridge, EmitFn } from './types'

// Native alternative to the browser's Web Serial API for a real USB
// telemetry radio (3DR/SiK). Same physical hardware, same bytes — this
// exists because the desktop app CAN talk to serial ports directly (no
// permission-prompt dance, works the same on every OS/driver combo Web
// Serial has quirks with) whereas the browser build still uses Web Serial
// directly, since that already works fine there with zero native code.

interface SerialStartConfig {
    path: string
    baudRate?: number
}

export class SerialBridge implements NativeBridge {
    readonly kind = 'serial'
    private conns = new Map<string, SerialPort>()

    async list(): Promise<unknown[]> {
        return SerialPort.list()
    }

    async start(id: string, config: Record<string, unknown>, emit: EmitFn): Promise<{ ok: boolean; error?: string }> {
        const { path, baudRate } = config as unknown as SerialStartConfig
        if (!path) return { ok: false, error: 'serial path required' }
        await this.stop(id)

        const port = new SerialPort({ path, baudRate: baudRate ?? 57600, autoOpen: false })
        try {
            await new Promise<void>((resolve, reject) => {
                port.open((err) => (err ? reject(err) : resolve()))
            })
        } catch (err) {
            return { ok: false, error: `couldn't open ${path} — ${(err as Error).message}` }
        }

        port.on('data', (data: Buffer) => {
            emit({ bridge: 'serial', id, type: 'data', data: new Uint8Array(data) })
        })
        port.on('close', () => {
            emit({ bridge: 'serial', id, type: 'status', meta: { connected: false } })
            this.conns.delete(id)
        })
        port.on('error', (err) => {
            emit({ bridge: 'serial', id, type: 'error', meta: { message: err.message } })
        })

        this.conns.set(id, port)
        emit({ bridge: 'serial', id, type: 'status', meta: { connected: true, path, baudRate: baudRate ?? 57600 } })
        return { ok: true }
    }

    async stop(id: string): Promise<void> {
        const port = this.conns.get(id)
        if (!port) return
        if (port.isOpen) port.close()
        this.conns.delete(id)
    }

    send(id: string, data: Uint8Array): void {
        const port = this.conns.get(id)
        if (port && port.isOpen) port.write(Buffer.from(data))
    }
}
