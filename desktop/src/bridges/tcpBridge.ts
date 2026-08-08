import net from 'node:net'
import type { NativeBridge, EmitFn } from './types'

// TCP cousin of udpBridge.ts — some flight-controller links and gimbal/
// camera control APIs (unlike SITL's MAVLink, which is UDP) speak MAVLink
// or a vendor protocol over a plain TCP connection. Same shape, connect-out
// instead of bind-and-wait since TCP is inherently a client/server model.

interface TcpStartConfig {
    host: string
    port: number
}

export class TcpBridge implements NativeBridge {
    readonly kind = 'tcp'
    private conns = new Map<string, net.Socket>()

    async start(id: string, config: Record<string, unknown>, emit: EmitFn): Promise<{ ok: boolean; error?: string }> {
        const { host, port } = config as unknown as TcpStartConfig
        if (!host || !port) return { ok: false, error: 'host and port required' }
        await this.stop(id)

        const socket = new net.Socket()
        try {
            await new Promise<void>((resolve, reject) => {
                socket.once('error', reject)
                socket.connect(port, host, () => resolve())
            })
        } catch (err) {
            return { ok: false, error: `couldn't connect to ${host}:${port} — ${(err as Error).message}` }
        }

        socket.on('data', (data) => {
            emit({ bridge: 'tcp', id, type: 'data', data: new Uint8Array(data) })
        })
        socket.on('close', () => {
            emit({ bridge: 'tcp', id, type: 'status', meta: { connected: false } })
            this.conns.delete(id)
        })
        socket.on('error', (err) => {
            emit({ bridge: 'tcp', id, type: 'error', meta: { message: err.message } })
        })

        this.conns.set(id, socket)
        emit({ bridge: 'tcp', id, type: 'status', meta: { connected: true, host, port } })
        return { ok: true }
    }

    async stop(id: string): Promise<void> {
        const socket = this.conns.get(id)
        if (!socket) return
        socket.destroy()
        this.conns.delete(id)
    }

    send(id: string, data: Uint8Array): void {
        const socket = this.conns.get(id)
        if (socket && !socket.destroyed) socket.write(Buffer.from(data))
    }
}
