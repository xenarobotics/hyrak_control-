// Auto-connect detection, with fake serial ports, fake UDP sockets and a fake
// clock. No real port or socket is opened.

const test = require('node:test')
const assert = require('node:assert/strict')
const { HeartbeatScanner, encodeHeartbeat, isVehicleHeartbeat } = require('../dist/mavlink/heartbeat')
const { classifyPort } = require('../dist/autoconnect/classify')
const { AutoConnectManager, PROBE_MS, UDP_GATHER_MS, UDP_QUIET_MS, UDP_HOLD_MS } = require('../dist/autoconnect/manager')

test('heartbeat scanner: v1 and v2, split across chunks, with noise', () => {
    const sc = new HeartbeatScanner()
    const a = encodeHeartbeat({ sysid: 1, v2: true })
    const b = encodeHeartbeat({ sysid: 7, v2: false, type: 1, autopilot: 3 })
    const stream = Uint8Array.from([0x55, 0xfd, 0x01, ...a, 0xfe, 0x00, ...b])
    const out = []
    for (let i = 0; i < stream.length; i += 5) out.push(...sc.push(stream.subarray(i, i + 5)))
    assert.deepEqual(out.map(h => [h.sysid, h.mavlinkVersion, h.autopilot]), [[1, 2, 12], [7, 1, 3]])
})

test('heartbeat scanner: bad CRC rejected; ground stations are not vehicles', () => {
    const f = encodeHeartbeat({ sysid: 3 })
    f[f.length - 1] ^= 0xff
    assert.deepEqual(new HeartbeatScanner().push(f), [])
    const gcs = new HeartbeatScanner().push(encodeHeartbeat({ sysid: 255, type: 6, autopilot: 8 }))[0]
    assert.equal(isVehicleHeartbeat(gcs), false)
    const quad = new HeartbeatScanner().push(encodeHeartbeat({ sysid: 1 }))[0]
    assert.equal(isVehicleHeartbeat(quad), true)
})

test('classify: flight controllers, SiK radios, everything else', () => {
    assert.equal(classifyPort({ path: 'a', vendorId: '26AC', productId: '0011' }).cls, 'fc')
    assert.equal(classifyPort({ path: 'a', vendorId: '2dae', productId: '1016' }).cls, 'fc')
    assert.equal(classifyPort({ path: 'a', vendorId: '3162', productId: '004b' }).cls, 'fc')
    assert.equal(classifyPort({ path: 'a', vendorId: '26ac', productId: '0011' }).baud, 115200)
    const sik = classifyPort({ path: 'a', vendorId: '0403', productId: '6015' })
    assert.deepEqual([sik.cls, sik.baud, sik.generic], ['sik', 57600, false])
    assert.equal(classifyPort({ path: 'a', vendorId: '10c4', productId: 'ea60' }).cls, 'sik')
    assert.equal(classifyPort({ path: 'a', vendorId: '1209', productId: '0001' }).cls, 'other')
    assert.equal(classifyPort({ path: 'a', vendorId: '2341', productId: '0043' }).cls, 'other') // Arduino
    assert.equal(classifyPort({ path: '/dev/ttyS0' }).cls, 'other')
})

// ---- manager harness ---------------------------------------------------------

function harness() {
    let t = 0
    const timers = new Set()
    const ports = []
    const probes = []        // { path, baud, push, closed }
    const sockets = []       // { port, push, closed }
    const events = []
    let bindBusy = false
    const deps = {
        listPorts: async () => ports.slice(),
        openProbe: async (path, baud) => {
            const p = { path, baud, cb: null, closed: false }
            probes.push(p)
            return { onData: (cb) => { p.cb = cb }, close: async () => { p.closed = true } }
        },
        createUdp: () => {
            const s = { port: 0, cb: null, closed: false }
            return {
                bind: async (port, address) => { if (bindBusy) throw new Error('EADDRINUSE'); s.port = port; s.address = address; sockets.push(s) },
                onMessage: (cb) => { s.cb = cb },
                close: async () => { s.closed = true },
            }
        },
        now: () => t,
        setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.add(h); return h },
        clearTimer: (h) => { timers.delete(h) },
    }
    const m = new AutoConnectManager(deps, (e) => events.push(e))
    const flush = () => new Promise(r => setImmediate(r))
    const advance = async (ms) => {
        const end = t + ms
        for (;;) {
            const due = [...timers].filter(h => h.at <= end).sort((a, b) => a.at - b.at)[0]
            if (!due) break
            t = due.at
            timers.delete(due)
            due.fn()
            await flush(); await flush()
        }
        t = end
        await flush()
    }
    const vehicles = () => events.filter(e => e.type === 'vehicle')
    return {
        m, ports, probes, sockets, events, vehicles, advance, flush,
        tick: async () => { await flush(); await flush(); await m.tick(); await flush(); await flush() },
        setBusy: (b) => { bindBusy = b },
    }
}

const FC = { path: '/dev/ttyACM0', vendorId: '26ac', productId: '0032' }
const SIK = { path: '/dev/ttyUSB0', vendorId: '0403', productId: '6015' }
const ARDUINO = { path: '/dev/ttyACM5', vendorId: '2341', productId: '0043' }
const NO_UDP = { udp: false }

test('a flight controller is probed read-only at 115200 and reported on heartbeat', async () => {
    const h = harness()
    h.m.setConfig(NO_UDP)
    h.m.setGate({ ready: true, linkActive: false })
    h.ports.push(FC, ARDUINO)
    await h.tick()
    assert.equal(h.probes.length, 1)
    assert.deepEqual([h.probes[0].path, h.probes[0].baud], ['/dev/ttyACM0', 115200])
    h.probes[0].cb(encodeHeartbeat({ sysid: 1 }))
    await h.flush(); await h.flush()
    const v = h.vehicles()
    assert.equal(v.length, 1)
    assert.equal(v[0].key, 'serial:/dev/ttyACM0')
    assert.match(v[0].vehicle, /PX4 quadcopter \(system 1\)/)
    assert.ok(h.probes[0].closed, 'probe port closed before the page connects')
    // Reported once only, and the Arduino is never opened.
    await h.advance(30000)
    await h.tick()
    assert.equal(h.vehicles().length, 1)
    assert.ok(h.probes.every(p => p.path !== ARDUINO.path))
})

test('no heartbeat in 3 s: closed, retried later; a GCS heartbeat does not count', async () => {
    const h = harness()
    h.m.setConfig(NO_UDP)
    h.m.setGate({ ready: true })
    h.ports.push(SIK)
    await h.tick()
    assert.equal(h.probes[0].baud, 57600)
    h.probes[0].cb(encodeHeartbeat({ sysid: 255, type: 6, autopilot: 8 }))
    await h.advance(PROBE_MS + 10)
    assert.ok(h.probes[0].closed)
    assert.equal(h.vehicles().length, 0)
    await h.tick()
    assert.equal(h.probes.length, 1, 'not re-probed immediately')
    await h.advance(9000)
    await h.tick()
    assert.equal(h.probes.length, 2, 're-probed after the retry delay')
})

test('nothing is probed before the page is ready, while a link is up, or for disabled types', async () => {
    const h = harness()
    h.m.setConfig(NO_UDP)
    h.ports.push(FC, SIK)
    await h.tick()
    assert.equal(h.probes.length, 0, 'not ready')
    h.m.setGate({ ready: true, linkActive: true })
    await h.tick()
    assert.equal(h.probes.length, 0, 'link active')
    h.m.setConfig({ usb: false })
    h.m.setGate({ linkActive: false })
    await h.tick()
    assert.equal(h.probes.length, 1)
    assert.equal(h.probes[0].path, SIK.path, 'USB flight controllers switched off')
    h.m.setConfig({ enabled: false })
    await h.tick()
    assert.ok(h.probes[0].closed, 'switching auto-connect off aborts the probe')
})

test('after a link ends, present ports stay suppressed until unplugged and replugged', async () => {
    const h = harness()
    h.m.setConfig(NO_UDP)
    h.m.setGate({ ready: true, linkActive: true })
    h.ports.push(FC)
    await h.tick()
    h.m.suppressPresent()           // operator pressed Disconnect
    h.m.setGate({ linkActive: false })
    await h.tick()
    await h.advance(20000)
    await h.tick()
    assert.equal(h.probes.length, 0)
    h.ports.splice(0, 1)            // unplug
    await h.tick()
    h.ports.push(FC)                // replug
    await h.tick()
    assert.equal(h.probes.length, 1)
})

test('release() makes a reported vehicle eligible again; a manual connect aborts a probe', async () => {
    const h = harness()
    h.m.setConfig(NO_UDP)
    h.m.setGate({ ready: true })
    h.ports.push(FC)
    await h.tick()
    h.probes[0].cb(encodeHeartbeat({ sysid: 1 }))
    await h.flush(); await h.flush()
    assert.equal(h.vehicles().length, 1)
    h.m.release('serial:/dev/ttyACM0')
    await h.flush()
    await h.tick()
    assert.equal(h.probes.length, 2)
    await h.m.yieldResources('serial', { path: '/dev/ttyACM0' })
    assert.ok(h.probes[1].closed, 'probe yielded to the manual connect')
})

test('UDP 14550: one vehicle reported, port released for the real link', async () => {
    const h = harness()
    h.m.setConfig({ usb: false, sik: false, udpPort: 24550 })
    h.m.setGate({ ready: true })
    await h.tick()
    assert.equal(h.sockets.length, 1)
    assert.equal(h.sockets[0].port, 24550)
    h.sockets[0].cb(encodeHeartbeat({ sysid: 255, type: 6, autopilot: 8 }), { address: '127.0.0.1', port: 9 })
    h.sockets[0].cb(encodeHeartbeat({ sysid: 1 }), { address: '127.0.0.1', port: 18570 })
    await h.advance(UDP_GATHER_MS + 10)
    const v = h.vehicles()
    assert.equal(v.length, 1)
    assert.equal(v[0].link, 'udp')
    assert.equal(v[0].systems.length, 1)
    assert.equal(v[0].from, '127.0.0.1:18570')
    assert.ok(h.sockets[0].closed, 'listener closed so the relay can bind')
    await h.tick()
    assert.equal(h.sockets.length, 1, 'held free for the page')
    await h.advance(UDP_HOLD_MS + 10)
    await h.tick()
    assert.equal(h.sockets.length, 2, 'listening again after the hold')
    // Still suppressed: the same vehicle keeps talking, nothing new reported.
    h.sockets[1].cb(encodeHeartbeat({ sysid: 1 }), { address: '127.0.0.1', port: 18570 })
    await h.advance(UDP_GATHER_MS + 10)
    assert.equal(h.vehicles().length, 1)
    // It goes quiet long enough: forgotten, so the next one is reported.
    await h.advance(UDP_QUIET_MS + 100)
    await h.tick()
    h.sockets[1].cb(encodeHeartbeat({ sysid: 1 }), { address: '127.0.0.1', port: 18570 })
    await h.advance(UDP_GATHER_MS + 10)
    assert.equal(h.vehicles().length, 2)
})

test('UDP: several vehicles are reported together; a busy port is retried', async () => {
    const h = harness()
    h.m.setConfig({ usb: false, sik: false, udpPort: 24551 })
    h.setBusy(true)
    h.m.setGate({ ready: true })
    await h.tick()
    assert.equal(h.sockets.length, 0)
    assert.ok(h.events.some(e => e.type === 'status' && e.udp === 'busy'))
    h.setBusy(false)
    await h.advance(10001)
    await h.tick()
    assert.equal(h.sockets.length, 1)
    for (const id of [1, 2, 3]) h.sockets[0].cb(encodeHeartbeat({ sysid: id }), { address: '127.0.0.1', port: 18569 + id })
    await h.advance(UDP_GATHER_MS + 10)
    const v = h.vehicles()
    assert.equal(v[0].systems.length, 3)
    assert.deepEqual(v[0].systems.map(s => s.sysid), [1, 2, 3])
})

test('UDP listener closes while a link is active and when a bridge wants the port', async () => {
    const h = harness()
    h.m.setConfig({ usb: false, sik: false, udpPort: 24552 })
    h.m.setGate({ ready: true })
    await h.tick()
    h.m.setGate({ linkActive: true })
    await h.tick()
    assert.ok(h.sockets[0].closed)
    h.m.setGate({ linkActive: false })
    await h.tick()
    assert.equal(h.sockets.length, 2)
    await h.m.yieldResources('udp', { ports: [{ tag: 0, port: 24552 }] })
    assert.ok(h.sockets[1].closed)
})

test('UDP: a heartbeat from another machine is ignored unless the LAN switch is on', async () => {
    const h = harness()
    h.m.setConfig({ usb: false, sik: false, udpPort: 24553 })
    h.m.setGate({ ready: true })
    await h.tick()
    assert.equal(h.sockets[0].address, '127.0.0.1', 'loopback only by default')
    h.sockets[0].cb(encodeHeartbeat({ sysid: 1 }), { address: '192.168.1.50', port: 14550 })
    await h.advance(UDP_GATHER_MS + 10)
    assert.equal(h.vehicles().length, 0, 'a LAN sender must not be auto-connected')

    h.m.setConfig({ udpLan: true })
    await h.tick()
    const s = h.sockets[h.sockets.length - 1]
    assert.equal(s.address, '0.0.0.0', 'rebound on every interface after opt-in')
    s.cb(encodeHeartbeat({ sysid: 1 }), { address: '192.168.1.50', port: 14550 })
    await h.advance(UDP_GATHER_MS + 10)
    assert.equal(h.vehicles().length, 1)
})

test('isLoopback', () => {
    const { isLoopback } = require('../dist/autoconnect/manager')
    for (const a of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(a), true, a)
    for (const a of ['192.168.1.5', '10.0.0.1', '::ffff:192.168.1.5', '0.0.0.0', '128.0.0.1']) assert.equal(isLoopback(a), false, a)
})

test('UDP: turning the LAN switch off while listening rebinds to loopback', async () => {
    const h = harness()
    h.m.setConfig({ usb: false, sik: false, udpPort: 24554, udpLan: true })
    h.m.setGate({ ready: true })
    await h.tick()
    assert.equal(h.sockets[h.sockets.length - 1].address, '0.0.0.0')
    h.m.setConfig({ udpLan: false })
    await h.tick()
    await h.tick()
    const s = h.sockets[h.sockets.length - 1]
    assert.equal(s.address, '127.0.0.1')
    s.cb(encodeHeartbeat({ sysid: 1 }), { address: '10.0.0.9', port: 14550 })
    await h.advance(UDP_GATHER_MS + 10)
    assert.equal(h.vehicles().length, 0)
})
