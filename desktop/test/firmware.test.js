// PX4 bootloader protocol and the firmware flow, against an emulated
// bootloader. Run with `npm test` (builds first). Never touches a real port.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { FakeBootloader } = require('./fakeBootloader')
const { Px4Bootloader, crc32Px4, expectedFlashCrc, padImage, ByteQueue, TimeoutError } = require('../dist/firmware/protocol')
const { parsePx4, buildPx4 } = require('../dist/firmware/px4File')
const { targetsForBoard, firmwareUrl } = require('../dist/firmware/boards')
const { FirmwareService } = require('../dist/firmware/service')

const image = (n, seed = 7) => {
    const a = new Uint8Array(n)
    let x = seed
    for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; a[i] = x >>> 24 }
    return a
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

test('crc32Px4 is CRC-32 without the final inversion', () => {
    const data = Buffer.from('123456789')
    // Standard CRC-32 ("123456789") = 0xCBF43926 = ~crc(data, ~0).
    assert.equal((~crc32Px4(data, 0xffffffff)) >>> 0, 0xcbf43926)
})

test('expected flash CRC equals the CRC over the image padded with 0xFF to flash size', () => {
    const img = padImage(image(1001))
    assert.equal(img.length % 4, 0)
    const full = new Uint8Array(4096).fill(0xff)
    full.set(img)
    assert.equal(expectedFlashCrc(img, 4096), crc32Px4(full, 0))
})

test('ByteQueue serves partial chunks and times out', async () => {
    const q = new ByteQueue()
    q.push(Uint8Array.of(1, 2)); q.push(Uint8Array.of(3))
    assert.deepEqual([...await q.read(3, 50)], [1, 2, 3])
    await assert.rejects(q.read(1, 20), TimeoutError)
})

test('.px4 parse: round trip, damaged and bootloader files refused', () => {
    const img = image(5000)
    const fw = parsePx4(buildPx4({ boardId: 50, image: img, gitIdentity: 'v1.17.0' }))
    assert.equal(fw.boardId, 50)
    assert.equal(fw.imageSize, 5000)
    assert.equal(fw.image.length, 5000)
    assert.deepEqual(fw.image.subarray(0, 10), img.subarray(0, 10))
    assert.throws(() => parsePx4('not json'), /not a \.px4/)
    assert.throws(() => parsePx4(JSON.stringify({ board_id: 50, image: 'AAAA' })), /damaged/)
    assert.throws(() => parsePx4(buildPx4({ boardId: 50, image: img, summary: 'PX4 bootloader' })), /bootloader image/)
    assert.throws(() => parsePx4(JSON.stringify({ image: 'x' })), /board_id/)
})

test('.px4 parse: a real PX4 build, if one was downloaded for the test', { skip: !process.env.PX4_SAMPLE }, () => {
    const fw = parsePx4(fs.readFileSync(process.env.PX4_SAMPLE, 'utf8'))
    assert.ok(fw.boardId > 0)
    assert.equal(fw.image.length % 4, 0)
    assert.ok(fw.imageSize > 100000)
})

test('board table: id 9 picks FMUv2 or v3 by flash size; urls are QGC-style', () => {
    assert.equal(targetsForBoard(9, 2080768)[0].target, 'px4_fmu-v3')
    assert.equal(targetsForBoard(9, 1032192)[0].target, 'px4_fmu-v2')
    assert.equal(targetsForBoard(140, 2 << 20)[0].target, 'cubepilot_cubeorange')
    assert.deepEqual(targetsForBoard(424242, 0), [])
    assert.equal(firmwareUrl('stable', 'px4_fmu-v5'), 'https://px4-travis.s3.amazonaws.com/Firmware/stable/px4_fmu-v5_default.px4')
    assert.throws(() => firmwareUrl('stable', '../x'))
})

test('protocol: identify, erase, program, verify, reboot', async () => {
    const fake = new FakeBootloader({ boardId: 50, flashSize: 64 * 1024 })
    const bl = new Px4Bootloader(fake.port())
    const id = await bl.identify()
    assert.deepEqual({ ...id }, { blRev: 5, boardId: 50, boardRev: 0, flashSize: 65536, chip: 'STM32F76xxx,Z' })
    const img = padImage(image(10001))
    const prog = []
    await bl.erase(() => {}, Date.now)
    await bl.program(img, (f) => prog.push(f))
    assert.equal(prog[prog.length - 1], 1)
    await bl.verify(img, id.flashSize)
    await bl.reboot()
    assert.ok(fake.rebooted)
    assert.deepEqual(fake.flash.subarray(0, img.length), img)
    // 252-byte chunks, never more.
    assert.equal(fake.chunks, Math.ceil(img.length / 252))
})

test('protocol: a bad write is reported, a corrupted flash fails verify', async () => {
    let fake = new FakeBootloader({ failProgramAtChunk: 3 })
    let bl = new Px4Bootloader(fake.port())
    await bl.identify()
    await bl.erase(() => {}, Date.now)
    await assert.rejects(bl.program(padImage(image(4000)), () => {}), /OPERATION FAILED/)

    fake = new FakeBootloader({ corruptAt: 777 })
    bl = new Px4Bootloader(fake.port())
    const id = await bl.identify()
    const img = padImage(image(4000))
    await bl.erase(() => {}, Date.now)
    await bl.program(img, () => {})
    await assert.rejects(bl.verify(img, id.flashSize), /verify failed/)
})

test('protocol: a board running its normal firmware never syncs', async () => {
    const fake = new FakeBootloader({ mode: 'app' })
    const bl = new Px4Bootloader(fake.port())
    assert.equal(await bl.trySync(400, sleep, Date.now), false)
})

// ---- the whole flow -------------------------------------------------------

function harness(opts = {}) {
    const ports = [...(opts.initialPorts ?? [])]
    const fakes = new Map()
    const opened = []
    const events = []
    const busy = []
    const svc = new FirmwareService({
        listPorts: async () => ports.slice(),
        openPort: async (path) => {
            opened.push(path)
            const f = fakes.get(path)
            if (!f) throw new Error('no such port')
            return f.port()
        },
        fetchText: async (url) => { harness.lastUrl = url; return opts.download ?? buildPx4({ boardId: 50, image: image(20000) }) },
        now: Date.now,
        sleep,
        setBusy: (b) => busy.push(b),
    }, (e) => events.push(e))
    const plug = (info, fake) => { fakes.set(info.path, fake); ports.push(info) }
    const unplug = (path) => { const i = ports.findIndex(p => p.path === path); if (i >= 0) ports.splice(i, 1) }
    const waitFor = async (pred, ms = 4000) => {
        const end = Date.now() + ms
        while (Date.now() < end) { if (pred(svc.status())) return svc.status(); await sleep(20) }
        throw new Error(`timed out; state ${svc.status().state}: ${svc.status().message}`)
    }
    return { svc, plug, unplug, waitFor, opened, events, busy }
}

const FC = (path, extra = {}) => ({ path, vendorId: '26ac', productId: '0032', manufacturer: '3D Robotics', ...extra })

test('flow: waits for a NEW port, identifies the bootloader, flashes the official build', async () => {
    const h = harness({ initialPorts: [FC('/dev/ttyACM9')] })
    assert.equal((await h.svc.start()).ok, true)
    assert.equal(h.busy[0], true, 'auto-connect paused')
    await sleep(400)
    assert.deepEqual(h.opened, [], 'a port present before Start is never opened')

    const fake = new FakeBootloader({ boardId: 50, flashSize: 64 * 1024 })
    h.plug(FC('/dev/ttyACM0'), fake)
    const ready = await h.waitFor(s => s.state === 'ready')
    assert.equal(ready.board.boardId, 50)
    assert.equal(ready.targets[0].target, 'px4_fmu-v5')
    assert.equal(fake.erased, false, 'nothing erased before the operator confirms')

    const r = await h.svc.flash({ kind: 'official', channel: 'stable', target: 'px4_fmu-v5' })
    assert.equal(r.ok, true, r.error)
    assert.match(harness.lastUrl, /Firmware\/stable\/px4_fmu-v5_default\.px4$/)
    assert.equal(h.svc.status().state, 'done')
    assert.ok(fake.rebooted && fake.closed)
    assert.equal(h.busy[h.busy.length - 1], false, 'auto-connect resumed')
    const states = h.events.filter(e => e.type === 'status').map(e => e.status.state)
    for (const s of ['waiting', 'connecting', 'ready', 'downloading', 'erasing', 'programming', 'verifying', 'rebooting', 'done']) {
        assert.ok(states.includes(s), `went through ${s}`)
    }
})

test('flow: wrong board id is refused before anything is erased', async () => {
    const h = harness({ download: buildPx4({ boardId: 140, image: image(1000) }) })
    await h.svc.start()
    const fake = new FakeBootloader({ boardId: 50 })
    h.plug(FC('/dev/ttyACM0'), fake)
    await h.waitFor(s => s.state === 'ready')
    const r = await h.svc.flash({ kind: 'custom', fileName: 'cube.px4', text: buildPx4({ boardId: 140, image: image(1000) }) })
    assert.equal(r.ok, false)
    assert.match(r.error, /board id 140.*id 50/)
    assert.equal(fake.erased, false)
    assert.ok(!fake.commands.includes(0x23), 'no CHIP_ERASE sent')
    assert.equal(h.svc.status().state, 'ready', 'still ready for another choice')
    await h.svc.cancel()
    assert.ok(fake.rebooted, 'cancel boots the existing firmware')
})

test('flow: too large an image, and an old bootloader, are refused', async () => {
    const h = harness()
    await h.svc.start()
    const fake = new FakeBootloader({ boardId: 50, flashSize: 4096 })
    h.plug(FC('/dev/ttyACM0'), fake)
    await h.waitFor(s => s.state === 'ready')
    const r = await h.svc.flash({ kind: 'custom', fileName: 'big.px4', text: buildPx4({ boardId: 50, image: image(8000) }) })
    assert.match(r.error, /larger than the board's flash/)
    assert.equal(fake.erased, false)
    await h.svc.cancel()

    const h2 = harness()
    await h2.svc.start()
    const old = new FakeBootloader({ boardId: 50, blRev: 2 })
    h2.plug(FC('/dev/ttyACM1'), old)
    await h2.waitFor(s => s.state === 'ready')
    const r2 = await h2.svc.flash({ kind: 'custom', fileName: 'x.px4', text: buildPx4({ boardId: 50, image: image(100) }) })
    assert.match(r2.error, /old bootloader/)
    assert.equal(old.erased, false)
    await h2.svc.cancel()
})

test('flow: a board that boots its firmware too fast goes back to waiting', async () => {
    const h = harness()
    await h.svc.start()
    h.plug(FC('/dev/ttyACM0'), new FakeBootloader({ mode: 'app' }))
    await h.waitFor(s => s.state === 'connecting')
    const st = await h.waitFor(s => s.state === 'waiting', 6000)
    assert.match(st.message, /Unplug it and plug it back in/)
    await h.svc.cancel()
})

test('flow: non flight-controller ports are ignored; cancel during flashing is refused', async () => {
    const h = harness()
    await h.svc.start()
    h.plug({ path: '/dev/ttyUSB0', vendorId: '1a86', productId: '7523' }, new FakeBootloader())
    await sleep(500)
    assert.deepEqual(h.opened, [])
    const fake = new FakeBootloader({ boardId: 50, eraseMs: 600 })
    h.plug(FC('/dev/ttyACM0'), fake)
    await h.waitFor(s => s.state === 'ready')
    const p = h.svc.flash({ kind: 'custom', fileName: 'ok.px4', text: buildPx4({ boardId: 50, image: image(3000) }) })
    await h.waitFor(s => s.state === 'erasing')
    const c = await h.svc.cancel()
    assert.equal(c.ok, false)
    assert.match(c.error, /Wait for the flash to finish/)
    assert.equal((await p).ok, true)
})

test('flow: a failure part way ends in a clear error and resumes auto-connect', async () => {
    const h = harness()
    await h.svc.start()
    h.plug(FC('/dev/ttyACM0'), new FakeBootloader({ boardId: 50, failProgramAtChunk: 2 }))
    await h.waitFor(s => s.state === 'ready')
    const r = await h.svc.flash({ kind: 'custom', fileName: 'ok.px4', text: buildPx4({ boardId: 50, image: image(3000) }) })
    assert.equal(r.ok, false)
    assert.equal(h.svc.status().state, 'error')
    assert.match(h.svc.status().message, /can always be flashed again/)
    assert.equal(h.busy[h.busy.length - 1], false)
})
