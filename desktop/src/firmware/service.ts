// Firmware flashing, the QGroundControl way:
//
//   1. the operator presses "Start" with the board UNPLUGGED;
//   2. they plug it in; the new USB serial port is caught within ~250 ms and
//      the bootloader (which only listens for a few seconds after power-up)
//      is greeted with GET_SYNC until it answers;
//   3. the board is identified (board id, flash size), the matching firmware
//      is offered, and only after a second explicit press is anything erased.
//
// Nothing here ever opens a port that was already present when "Start" was
// pressed, and auto-connect is paused for the whole session so it cannot
// grab the bootloader port.
//
// I/O comes in through FirmwareDeps so the flow runs under unit tests against
// an emulated bootloader (test/firmware.test.js).

import { Px4Bootloader, type BoardIdentity, type BootloaderPort } from './protocol'
import { parsePx4, type Px4Firmware } from './px4File'
import { CHANNEL_LABEL, firmwareUrl, targetsForBoard, type BoardTarget, type FirmwareChannel } from './boards'
import { classifyPort, type PortInfoLike } from '../autoconnect/classify'

export type FirmwareState =
    | 'idle' | 'waiting' | 'connecting' | 'ready'
    | 'downloading' | 'erasing' | 'programming' | 'verifying' | 'rebooting'
    | 'done' | 'error'

export interface FirmwareStatus {
    state: FirmwareState
    message: string
    board: (BoardIdentity & { path: string }) | null
    targets: BoardTarget[]
    progress: number
    /** Filled after a successful flash. */
    flashed: { gitIdentity: string; summary: string; seconds: number } | null
}

export type FirmwareEvent =
    | { type: 'status'; status: FirmwareStatus }
    | { type: 'log'; line: string; level: 'info' | 'warn' | 'error' }

export interface FirmwareDeps {
    listPorts(): Promise<PortInfoLike[]>
    openPort(path: string): Promise<BootloaderPort>
    fetchText(url: string, onProgress: (fraction: number) => void): Promise<string>
    now(): number
    sleep(ms: number): Promise<void>
    /** Pauses auto-connect while a firmware session is open. */
    setBusy(busy: boolean): void
}

export type FlashSource =
    | { kind: 'official'; channel: FirmwareChannel; target: string }
    | { kind: 'custom'; fileName: string; text: string }

const WATCH_MS = 250
const SYNC_WINDOW_MS = 3000
const FLASHING: FirmwareState[] = ['downloading', 'erasing', 'programming', 'verifying', 'rebooting']

export class FirmwareService {
    private st: FirmwareStatus = { state: 'idle', message: '', board: null, targets: [], progress: 0, flashed: null }
    private known = new Set<string>()
    private watching = false
    private session = 0
    private port: BootloaderPort | null = null
    private bl: Px4Bootloader | null = null

    constructor(private deps: FirmwareDeps, private emit: (e: FirmwareEvent) => void) {}

    status(): FirmwareStatus { return { ...this.st, targets: [...this.st.targets] } }

    private set(patch: Partial<FirmwareStatus>): void {
        this.st = { ...this.st, ...patch }
        this.emit({ type: 'status', status: this.status() })
    }

    private log(line: string, level: 'info' | 'warn' | 'error' = 'info'): void {
        this.emit({ type: 'log', line, level })
    }

    get busy(): boolean { return FLASHING.includes(this.st.state) }

    /** Begin waiting for a board to be plugged in. */
    async start(): Promise<{ ok: boolean; error?: string }> {
        if (this.busy) return { ok: false, error: 'a flash is in progress' }
        await this.releasePort()
        const my = ++this.session
        this.deps.setBusy(true)
        try {
            const now = await this.deps.listPorts()
            this.known = new Set(now.map(p => p.path))
        } catch (err) {
            this.deps.setBusy(false)
            return { ok: false, error: `could not list serial ports: ${(err as Error).message}` }
        }
        this.set({ state: 'waiting', message: 'Plug the flight controller into USB now.', board: null, targets: [], progress: 0, flashed: null })
        this.log('Waiting for a board. If it is plugged in, unplug it and plug it back in.')
        if (!this.watching) void this.watch(my)
        return { ok: true }
    }

    /** Stop waiting, or let an identified board boot its current firmware.
     *  Refused while erasing or writing: the operator is told to wait. */
    async cancel(): Promise<{ ok: boolean; error?: string }> {
        if (this.busy) return { ok: false, error: 'Wait for the flash to finish. Stopping now would leave the board without firmware.' }
        this.session++
        if (this.bl && this.st.state === 'ready') {
            try { await this.bl.reboot() } catch { /* board may already be gone */ }
            this.log('Board left unchanged and restarted with its current firmware.')
        }
        await this.releasePort()
        this.deps.setBusy(false)
        this.set({ state: 'idle', message: '', board: null, targets: [], progress: 0 })
        return { ok: true }
    }

    private async releasePort(): Promise<void> {
        const p = this.port
        this.port = null
        this.bl = null
        if (p) { try { await p.close() } catch { /* gone */ } }
    }

    private isCandidate(p: PortInfoLike): boolean {
        if (classifyPort(p).cls === 'fc') return true
        const text = `${p.manufacturer ?? ''} ${p.pnpId ?? ''} ${p.friendlyName ?? ''}`
        return /\bBL\b|bootloader/i.test(text)
    }

    private async watch(my: number): Promise<void> {
        this.watching = true
        try {
            while (my === this.session && (this.st.state === 'waiting' || this.st.state === 'ready' || this.st.state === 'connecting')) {
                let list: PortInfoLike[] = []
                try { list = await this.deps.listPorts() } catch { /* try again */ }
                const present = new Set(list.map(p => p.path))
                // Unplugged ports leave `known`, so plugging the same board back
                // in (same /dev path) counts as new.
                for (const k of [...this.known]) if (!present.has(k)) this.known.delete(k)
                if (this.st.state === 'ready' && this.st.board && !present.has(this.st.board.path)) {
                    await this.releasePort()
                    this.set({ state: 'waiting', message: 'The board was unplugged. Plug it back in to try again.', board: null, targets: [] })
                    this.log('Board unplugged before flashing. Nothing was changed.', 'warn')
                }
                if (this.st.state === 'waiting') {
                    for (const p of list) {
                        if (this.known.has(p.path)) continue
                        this.known.add(p.path)
                        if (!this.isCandidate(p)) {
                            this.log(`Ignoring ${p.path}: not a flight controller USB id (${p.vendorId ?? '?'}:${p.productId ?? '?'}).`)
                            continue
                        }
                        await this.tryBootloader(p, my)
                        if (this.st.state !== 'waiting') break
                    }
                }
                await this.deps.sleep(WATCH_MS)
            }
        } finally {
            this.watching = false
        }
    }

    private async tryBootloader(p: PortInfoLike, my: number): Promise<void> {
        this.set({ state: 'connecting', message: `Found ${p.path}. Talking to the bootloader...` })
        this.log(`New USB device ${p.path} (${p.vendorId ?? '?'}:${p.productId ?? '?'}${p.manufacturer ? `, ${p.manufacturer}` : ''}).`)
        let port: BootloaderPort | null = null
        // The device node can take a moment to become openable after it appears.
        const openDeadline = this.deps.now() + 1500
        while (!port && this.deps.now() < openDeadline && my === this.session) {
            try { port = await this.deps.openPort(p.path) } catch { await this.deps.sleep(100) }
        }
        if (!port) {
            this.log(`Could not open ${p.path}. Another program may have it open, or on Linux you may need to be in the "dialout" group.`, 'warn')
            this.set({ state: 'waiting', message: 'Could not open the board. Close other ground station programs, then unplug and plug it back in.' })
            return
        }
        const bl = new Px4Bootloader(port)
        const ok = await bl.trySync(SYNC_WINDOW_MS, this.deps.sleep, this.deps.now)
        if (my !== this.session) { await port.close().catch(() => { /* gone */ }); return }
        if (!ok) {
            await port.close().catch(() => { /* gone */ })
            this.log(`${p.path} did not answer as a bootloader. It may have started its normal firmware already.`, 'warn')
            this.set({ state: 'waiting', message: 'The board started its normal firmware before HYRAK could catch the bootloader. Unplug it and plug it back in.' })
            return
        }
        let id: BoardIdentity
        try {
            id = await bl.identify()
        } catch (err) {
            await port.close().catch(() => { /* gone */ })
            this.log(`Bootloader on ${p.path} answered but could not be identified: ${(err as Error).message}`, 'error')
            this.set({ state: 'waiting', message: 'The bootloader answered but did not identify itself. Unplug and plug the board back in to retry.' })
            return
        }
        this.port = port
        this.bl = bl
        const targets = targetsForBoard(id.boardId, id.flashSize)
        this.log(`Bootloader v${id.blRev}, board id ${id.boardId} rev ${id.boardRev}, flash ${Math.round(id.flashSize / 1024)} KB${id.chip ? `, ${id.chip}` : ''}.`)
        if (!targets.length) this.log(`Board id ${id.boardId} has no official PX4 build listed here. A custom .px4 file built for it can still be flashed.`, 'warn')
        this.set({
            state: 'ready', board: { ...id, path: p.path }, targets,
            message: targets.length ? `Found ${targets[0].name}. Choose the firmware to install.` : `Found a board with id ${id.boardId}. Choose a .px4 file built for it.`,
        })
    }

    /** Download (or take) the firmware, check it fits this board, then erase,
     *  write, verify and reboot. */
    async flash(source: FlashSource): Promise<{ ok: boolean; error?: string }> {
        if (this.st.state !== 'ready' || !this.bl || !this.st.board) {
            return { ok: false, error: 'No board is ready. Press Start and plug the board in first.' }
        }
        const board = this.st.board
        const bl = this.bl
        const started = this.deps.now()
        let fw: Px4Firmware
        try {
            if (source.kind === 'custom') {
                this.log(`Reading ${source.fileName}.`)
                fw = parsePx4(source.text)
            } else {
                if (!this.st.targets.some(t => t.target === source.target)) {
                    return { ok: false, error: 'That build is not one of the matches for this board.' }
                }
                const url = firmwareUrl(source.channel, source.target)
                this.set({ state: 'downloading', message: `Downloading ${CHANNEL_LABEL[source.channel]} for ${source.target}...`, progress: 0 })
                this.log(`Downloading ${url}`)
                const text = await this.deps.fetchText(url, (f) => this.set({ progress: f }))
                fw = parsePx4(text)
            }
        } catch (err) {
            return this.failBeforeErase(`Could not get the firmware: ${(err as Error).message}`)
        }
        this.log(`Firmware ${fw.gitIdentity || fw.version || ''} for board id ${fw.boardId}, ${fw.imageSize} bytes${fw.summary ? ` (${fw.summary})` : ''}.`)
        if (fw.boardId !== board.boardId) {
            return this.failBeforeErase(`This firmware is for board id ${fw.boardId}, but the connected board is id ${board.boardId}. Nothing was changed.`)
        }
        if (bl.blRev < 3) {
            return this.failBeforeErase(`This board has an old bootloader (protocol ${bl.blRev}) that HYRAK cannot verify. Update its bootloader with QGroundControl once, then flash here.`)
        }
        if (fw.image.length > board.flashSize) {
            return this.failBeforeErase(`The firmware (${fw.image.length} bytes) is larger than the board's flash (${board.flashSize} bytes). Nothing was changed.`)
        }
        if (fw.boardId === 9 && bl.blRev < 5 && fw.imageSize > 1032192) {
            return this.failBeforeErase('This Pixhawk has a bootloader that cannot tell whether more than 1 MB of flash is safe to use. Choose the FMUv2 build, or update the bootloader first. Nothing was changed.')
        }

        try {
            this.set({ state: 'erasing', message: 'Erasing the old firmware. Do not unplug the board.', progress: 0 })
            this.log('Erasing flash...')
            await bl.erase((f) => this.set({ progress: f }), this.deps.now)
            this.set({ state: 'programming', message: 'Writing the new firmware. Do not unplug the board.', progress: 0 })
            this.log('Writing...')
            await bl.program(fw.image, (f) => this.set({ progress: f }))
            this.set({ state: 'verifying', message: 'Checking what was written.', progress: 0.5 })
            const crc = await bl.verify(fw.image, board.flashSize)
            this.log(`Verified (CRC 0x${crc.toString(16)}).`)
            this.set({ state: 'rebooting', message: 'Restarting the board.', progress: 1 })
            await bl.reboot()
        } catch (err) {
            await this.releasePort()
            this.deps.setBusy(false)
            this.log(`Flash failed: ${(err as Error).message}`, 'error')
            this.set({
                state: 'error', progress: 0,
                message: 'Flashing failed part way. The bootloader is not touched by flashing, so the board can always be flashed again: press Start, then unplug and plug it back in.',
            })
            return { ok: false, error: (err as Error).message }
        }
        await this.releasePort()
        const seconds = Math.round((this.deps.now() - started) / 1000)
        this.log(`Done in ${seconds} s. The board is restarting with the new firmware.`)
        this.deps.setBusy(false)
        this.set({
            state: 'done', progress: 1, board,
            flashed: { gitIdentity: fw.gitIdentity || fw.version, summary: fw.summary, seconds },
            message: 'Firmware installed. The board is restarting; it reconnects by itself if auto-connect is on.',
        })
        return { ok: true }
    }

    private failBeforeErase(msg: string): { ok: boolean; error: string } {
        // The board is untouched and still in its bootloader: stay ready so
        // the operator can pick another build without replugging.
        this.log(msg, 'error')
        this.set({ state: 'ready', message: msg, progress: 0 })
        // The watch loop stops while downloading; resume unplug detection.
        if (!this.watching) void this.watch(this.session)
        return { ok: false, error: msg }
    }

    async dispose(): Promise<void> {
        this.session++
        await this.releasePort()
    }
}
