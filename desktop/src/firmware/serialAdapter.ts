// BootloaderPort over a real serialport handle. Used only by the firmware
// service, only on a port that appeared after the operator was asked to
// plug the board in, and only once they pressed the button to start.

import { SerialPort } from 'serialport'
import { ByteQueue, type BootloaderPort } from './protocol'

export function openBootloaderPort(path: string): Promise<BootloaderPort> {
    return new Promise((resolve, reject) => {
        // 115200 matches px_uploader's default; USB CDC ignores it anyway.
        const port = new SerialPort({ path, baudRate: 115200, autoOpen: false })
        const q = new ByteQueue()
        port.open((err) => {
            if (err) { reject(err); return }
            port.on('data', (b: Buffer) => q.push(new Uint8Array(b)))
            port.on('close', () => q.fail(new Error('the board disconnected')))
            port.on('error', (e) => q.fail(e))
            resolve({
                write: (data) => new Promise<void>((res, rej) => {
                    port.write(Buffer.from(data), (e) => {
                        if (e) { rej(e); return }
                        port.drain((e2) => (e2 ? rej(e2) : res()))
                    })
                }),
                read: (n, timeoutMs) => q.read(n, timeoutMs),
                discardInput: () => q.clear(),
                close: () => new Promise<void>((res) => {
                    if (!port.isOpen) { res(); return }
                    port.close(() => res())
                }),
            })
        })
    })
}
