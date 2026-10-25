// The PX4 bootloader protocol, as spoken by PX4's own Tools/px_uploader.py
// and by QGroundControl's Bootloader.cc. Every PX4 flight controller (and
// most ArduPilot ChibiOS boards) runs this bootloader for a few seconds after
// power-up: talk to it in that window and it stays put until told to reboot.
//
// Wire format: a command byte, its arguments, then EOC (0x20). Every command
// is answered INSYNC (0x12) followed by OK (0x10), FAILED (0x11) or INVALID
// (0x13), with any data the command returns sent BEFORE that pair.
//
// Only protocol revisions 3 to 5 are supported: they verify with GET_CRC.
// Revision 2 (pre-2014 boards) needs read-back verification; such a board
// should get a bootloader update from QGC or px_uploader first, so it is
// refused with that explanation rather than half-supported.
//
// All I/O goes through BootloaderPort, so the same code runs against a real
// serial port (serialAdapter.ts) and against the emulated bootloader in
// test/fakeBootloader.js.

export const INSYNC = 0x12
export const EOC = 0x20
export const OK = 0x10
export const FAILED = 0x11
export const INVALID = 0x13
export const BAD_SILICON_REV = 0x14

export const NOP = 0x00
export const GET_SYNC = 0x21
export const GET_DEVICE = 0x22
export const CHIP_ERASE = 0x23
export const PROG_MULTI = 0x27
export const GET_CRC = 0x29
export const GET_CHIP_DES = 0x2e
export const REBOOT = 0x30

export const INFO_BL_REV = 1
export const INFO_BOARD_ID = 2
export const INFO_BOARD_REV = 3
export const INFO_FLASH_SIZE = 4

export const BL_REV_MIN = 3
export const BL_REV_MAX = 5
/** Protocol maximum is 255; must be a multiple of 4. */
export const PROG_MULTI_MAX = 252

export interface BootloaderPort {
    write(data: Uint8Array): Promise<void>
    /** Resolves with exactly n bytes, or rejects with a TimeoutError. */
    read(n: number, timeoutMs: number): Promise<Uint8Array>
    /** Drops anything received and not yet read. */
    discardInput(): void
    close(): Promise<void>
}

export class TimeoutError extends Error {
    constructor(msg: string) { super(msg); this.name = 'TimeoutError' }
}

/** A FIFO of received bytes with a timed read - the piece every adapter
 *  (real serial port, test fake) needs. */
export class ByteQueue {
    private chunks: Uint8Array[] = []
    private size = 0
    private waiter: { n: number; resolve: (b: Uint8Array) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null
    private closedWith: Error | null = null

    push(chunk: Uint8Array): void {
        if (!chunk.length) return
        this.chunks.push(chunk)
        this.size += chunk.length
        this.serve()
    }

    clear(): void {
        this.chunks = []
        this.size = 0
    }

    fail(err: Error): void {
        this.closedWith = err
        const w = this.waiter
        if (w) { clearTimeout(w.timer); this.waiter = null; w.reject(err) }
    }

    read(n: number, timeoutMs: number): Promise<Uint8Array> {
        if (this.waiter) return Promise.reject(new Error('concurrent read'))
        if (this.size >= n) return Promise.resolve(this.take(n))
        if (this.closedWith) return Promise.reject(this.closedWith)
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiter = null
                reject(new TimeoutError(`timed out waiting for ${n} byte${n === 1 ? '' : 's'} from the bootloader`))
            }, timeoutMs)
            this.waiter = { n, resolve, reject, timer }
        })
    }

    private serve(): void {
        const w = this.waiter
        if (!w || this.size < w.n) return
        clearTimeout(w.timer)
        this.waiter = null
        w.resolve(this.take(w.n))
    }

    private take(n: number): Uint8Array {
        const out = new Uint8Array(n)
        let off = 0
        while (off < n) {
            const c = this.chunks[0]
            const k = Math.min(c.length, n - off)
            out.set(c.subarray(0, k), off)
            off += k
            if (k === c.length) this.chunks.shift()
            else this.chunks[0] = c.subarray(k)
        }
        this.size -= n
        return out
    }
}

// ---- CRC ---------------------------------------------------------------------

const CRC_TABLE = (() => {
    const t = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
        let c = i
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        t[i] = c >>> 0
    }
    return t
})()

/** px_uploader's crc32: the zlib table, but seeded with the running state
 *  and with no final inversion. */
export function crc32Px4(bytes: Uint8Array, state = 0): number {
    let s = state >>> 0
    for (let i = 0; i < bytes.length; i++) s = (CRC_TABLE[(s ^ bytes[i]) & 0xff] ^ (s >>> 8)) >>> 0
    return s
}

const PAD = new Uint8Array([0xff, 0xff, 0xff, 0xff])

/** The CRC the bootloader reports over its whole flash area: the image, then
 *  erased (0xFF) words up to the flash size. Mirrors firmware.crc(padlen). */
export function expectedFlashCrc(image: Uint8Array, flashSize: number): number {
    let s = crc32Px4(image, 0)
    for (let i = image.length; i < flashSize - 1; i += 4) s = crc32Px4(PAD, s)
    return s
}

/** Pads to a multiple of 4 with 0xFF, as px_uploader does on load. */
export function padImage(image: Uint8Array): Uint8Array {
    if (image.length % 4 === 0) return image
    const out = new Uint8Array(image.length + (4 - (image.length % 4))).fill(0xff)
    out.set(image)
    return out
}

// ---- client --------------------------------------------------------------------

export interface BoardIdentity {
    blRev: number
    boardId: number
    boardRev: number
    flashSize: number
    /** "STM32F76xxx,..." on revision 5 bootloaders, else null. */
    chip: string | null
}

export type ProgressFn = (fraction: number) => void

export class Px4Bootloader {
    blRev = 0

    constructor(private port: BootloaderPort, private opts: { replyTimeoutMs?: number } = {}) {}

    private get t(): number { return this.opts.replyTimeoutMs ?? 1000 }

    private async getSync(timeoutMs = this.t): Promise<void> {
        const [a] = await this.port.read(1, timeoutMs)
        if (a !== INSYNC) throw new Error(`bootloader sent 0x${a.toString(16)} instead of INSYNC`)
        const [b] = await this.port.read(1, timeoutMs)
        if (b === INVALID) throw new Error('bootloader reports INVALID OPERATION')
        if (b === FAILED) throw new Error('bootloader reports OPERATION FAILED')
        if (b === BAD_SILICON_REV) throw new Error('this chip revision cannot be programmed (silicon errata)')
        if (b !== OK) throw new Error(`bootloader sent 0x${b.toString(16)} instead of OK`)
    }

    private async readU32(timeoutMs = this.t): Promise<number> {
        const b = await this.port.read(4, timeoutMs)
        return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0
    }

    /** One GET_SYNC round trip. Throws when nothing sane answers. */
    async sync(timeoutMs = 400): Promise<void> {
        this.port.discardInput()
        await this.port.write(Uint8Array.of(GET_SYNC, EOC))
        await this.getSync(timeoutMs)
    }

    /** Keeps trying GET_SYNC for up to `totalMs`. True when the bootloader
     *  answered. A board running its normal firmware simply never does. */
    async trySync(totalMs: number, sleep: (ms: number) => Promise<void>, now: () => number): Promise<boolean> {
        const deadline = now() + totalMs
        while (now() < deadline) {
            try {
                await this.sync(250)
                return true
            } catch {
                await sleep(50)
            }
        }
        return false
    }

    async getInfo(param: number): Promise<number> {
        await this.port.write(Uint8Array.of(GET_DEVICE, param, EOC))
        const v = await this.readU32()
        await this.getSync()
        return v
    }

    async identify(): Promise<BoardIdentity> {
        await this.sync()
        const blRev = await this.getInfo(INFO_BL_REV)
        this.blRev = blRev
        if (blRev < 2 || blRev > BL_REV_MAX) {
            throw new Error(`unsupported bootloader protocol revision ${blRev}`)
        }
        const boardId = await this.getInfo(INFO_BOARD_ID)
        const boardRev = await this.getInfo(INFO_BOARD_REV)
        const flashSize = await this.getInfo(INFO_FLASH_SIZE)
        let chip: string | null = null
        if (blRev >= 5) {
            try {
                await this.port.write(Uint8Array.of(GET_CHIP_DES, EOC))
                const len = await this.readU32()
                if (len > 0 && len < 128) {
                    chip = Buffer.from(await this.port.read(len, this.t)).toString('latin1')
                }
                await this.getSync()
            } catch {
                // Optional; some revision 5 builds omit it. Resync before going on.
                await this.sync().catch(() => { /* reported by the next command */ })
            }
        }
        return { blRev, boardId, boardRev, flashSize, chip }
    }

    /** CHIP_ERASE, then wait (up to 30 s, like px_uploader) for the answer. */
    async erase(onProgress: ProgressFn, now: () => number, usualMs = 15000): Promise<void> {
        await this.port.write(Uint8Array.of(CHIP_ERASE, EOC))
        const start = now()
        const deadline = start + 30000
        while (now() < deadline) {
            onProgress(Math.min(0.95, (now() - start) / usualMs))
            let a: number
            try {
                [a] = await this.port.read(1, 500)
            } catch (err) {
                if (err instanceof TimeoutError) continue
                throw err
            }
            if (a !== INSYNC) throw new Error(`bootloader sent 0x${a.toString(16)} during erase`)
            const [b] = await this.port.read(1, this.t)
            if (b === OK) { onProgress(1); return }
            if (b === FAILED) throw new Error('erase failed (bootloader reports OPERATION FAILED)')
            throw new Error(`bootloader sent 0x${b.toString(16)} after erase`)
        }
        throw new Error('timed out waiting for the flash erase to finish')
    }

    async program(image: Uint8Array, onProgress: ProgressFn): Promise<void> {
        const total = image.length
        let lastReport = -1
        for (let off = 0; off < total; off += PROG_MULTI_MAX) {
            const chunk = image.subarray(off, Math.min(total, off + PROG_MULTI_MAX))
            const frame = new Uint8Array(chunk.length + 3)
            frame[0] = PROG_MULTI
            frame[1] = chunk.length
            frame.set(chunk, 2)
            frame[frame.length - 1] = EOC
            await this.port.write(frame)
            try {
                await this.getSync()
            } catch (err) {
                throw new Error(`writing at offset ${off} of ${total}: ${(err as Error).message}`)
            }
            const pct = Math.floor(((off + chunk.length) / total) * 200)
            if (pct !== lastReport) { lastReport = pct; onProgress((off + chunk.length) / total) }
        }
    }

    /** Asks the bootloader for the CRC of its flash and compares it with
     *  what the image should produce. Returns the reported CRC. */
    async verify(image: Uint8Array, flashSize: number): Promise<number> {
        const expect = expectedFlashCrc(image, flashSize)
        await this.port.write(Uint8Array.of(GET_CRC, EOC))
        // The board computes this over the whole flash: allow it time.
        const got = await this.readU32(5000)
        await this.getSync()
        if (got !== expect) {
            throw new Error(`verify failed: board reports CRC 0x${got.toString(16)}, expected 0x${expect.toString(16)}`)
        }
        return got
    }

    /** Boots whatever is in flash. Revision 3+ answers first, and can refuse
     *  if the first flash word did not program. */
    async reboot(): Promise<void> {
        await this.port.write(Uint8Array.of(REBOOT, EOC))
        if (this.blRev >= 3) {
            try { await this.getSync() } catch (err) {
                if (!(err instanceof TimeoutError)) throw err
                // The USB device often vanishes before the reply makes it out.
            }
        }
    }
}
