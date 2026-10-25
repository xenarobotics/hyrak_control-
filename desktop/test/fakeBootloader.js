// An emulated PX4 bootloader behind a fake serial port, for unit tests.
// Speaks the same protocol as PX4's bootloader (bl.c): commands end in EOC,
// every answer ends in INSYNC + OK/FAILED/INVALID. Flash is a byte array.
// No real port is ever touched.

const { ByteQueue, crc32Px4 } = require('../dist/firmware/protocol')

const INSYNC = 0x12, EOC = 0x20, OK = 0x10, FAILED = 0x11, INVALID = 0x13

class FakeBootloader {
    constructor(opts = {}) {
        this.boardId = opts.boardId ?? 50
        this.boardRev = opts.boardRev ?? 0
        this.blRev = opts.blRev ?? 5
        this.flashSize = opts.flashSize ?? 64 * 1024
        this.chip = opts.chip ?? 'STM32F76xxx,Z'
        this.eraseMs = opts.eraseMs ?? 20
        // 'bootloader' answers; 'app' (normal firmware running) never does.
        this.mode = opts.mode ?? 'bootloader'
        this.failProgramAtChunk = opts.failProgramAtChunk ?? -1
        this.corruptAt = opts.corruptAt ?? -1
        this.flash = new Uint8Array(this.flashSize).fill(0xff)
        this.ptr = 0
        this.chunks = 0
        this.erased = false
        this.rebooted = false
        this.commands = []
        this.rx = new Uint8Array(0)
        this.q = new ByteQueue()
        this.closed = false
    }

    /** The BootloaderPort the code under test uses. */
    port() {
        return {
            write: async (data) => { this.receive(data) },
            read: (n, t) => this.q.read(n, t),
            discardInput: () => this.q.clear(),
            close: async () => { this.closed = true },
        }
    }

    reply(...bytes) { this.q.push(Uint8Array.from(bytes)) }
    u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff] }

    receive(data) {
        if (this.mode !== 'bootloader') return
        const merged = new Uint8Array(this.rx.length + data.length)
        merged.set(this.rx); merged.set(data, this.rx.length)
        this.rx = merged
        for (;;) {
            const used = this.step()
            if (!used) break
            this.rx = this.rx.subarray(used)
        }
    }

    /** Handles one complete command at the head of rx; returns bytes used. */
    step() {
        const b = this.rx
        if (!b.length) return 0
        const cmd = b[0]
        const need = (n) => (b.length >= n ? n : 0)
        switch (cmd) {
            case 0x00: return 1
            case 0x21: case 0x29: case 0x30: case 0x2e: case 0x23: {
                if (!need(2)) return 0
                this.commands.push(cmd)
                if (b[1] !== EOC) { this.reply(INSYNC, INVALID); return 2 }
                if (cmd === 0x21) this.reply(INSYNC, OK)
                if (cmd === 0x29) {
                    const flash = this.flash.slice()
                    this.reply(...this.u32(crc32Px4(flash, 0)), INSYNC, OK)
                }
                if (cmd === 0x30) { this.rebooted = true; this.reply(INSYNC, OK) }
                if (cmd === 0x2e) {
                    const s = Buffer.from(this.chip, 'latin1')
                    this.reply(...this.u32(s.length), ...s, INSYNC, OK)
                }
                if (cmd === 0x23) {
                    setTimeout(() => {
                        this.flash.fill(0xff); this.ptr = 0; this.erased = true
                        this.reply(INSYNC, OK)
                    }, this.eraseMs)
                }
                return 2
            }
            case 0x22: {
                if (!need(3)) return 0
                this.commands.push(cmd)
                const param = b[1]
                const v = { 1: this.blRev, 2: this.boardId, 3: this.boardRev, 4: this.flashSize }[param]
                if (b[2] !== EOC || v === undefined) { this.reply(INSYNC, INVALID); return 3 }
                this.reply(...this.u32(v), INSYNC, OK)
                return 3
            }
            case 0x27: {
                if (b.length < 2) return 0
                const len = b[1]
                if (b.length < len + 3) return 0
                this.commands.push(cmd)
                if (b[len + 2] !== EOC || len % 4 !== 0) { this.reply(INSYNC, INVALID); return len + 3 }
                if (this.chunks === this.failProgramAtChunk || !this.erased || this.ptr + len > this.flashSize) {
                    this.chunks++
                    this.reply(INSYNC, FAILED)
                    return len + 3
                }
                const data = b.subarray(2, 2 + len)
                this.flash.set(data, this.ptr)
                if (this.corruptAt >= this.ptr && this.corruptAt < this.ptr + len) this.flash[this.corruptAt] ^= 0x01
                this.ptr += len
                this.chunks++
                this.reply(INSYNC, OK)
                return len + 3
            }
            default:
                // Unknown byte: the real bootloader discards it.
                return 1
        }
    }
}

module.exports = { FakeBootloader }
