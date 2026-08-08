import net from 'node:net'
import dgram from 'node:dgram'
import os from 'node:os'

// Answers "can this machine actually reach the drone hardware?" before a stream
// is started, instead of after a timeout.
//
// This exists because of a long, avoidable debugging session. A laptop roamed
// between seven WiFi networks in one evening, and each time it left the ground
// unit's network the camera and telemetry both failed — with errors that
// described the symptom (no frames, no MAVLink) rather than the cause (wrong
// network). Every round cost a measurement cycle to rediscover.
//
// Deliberately reports the SUBNET, not the SSID. The SSID was actively
// misleading: a bridging ground unit can hand out addresses from the phone it
// is uplinked to, and can rebroadcast the phone's SSID, so "connected to SIYI"
// was true while the camera sat on an entirely different subnet. What actually
// determines reachability is whether the target shares a subnet with one of
// this machine's addresses — so that is what gets measured and shown.

export interface ProbeTarget {
    label: string
    host: string
    port: number
    kind: 'tcp' | 'udp'
}

export interface ProbeResult extends ProbeTarget {
    ok: boolean
    ms: number
    // True when the target shares a subnet with one of our addresses, i.e. it
    // is reached by ARP with no gateway involved. This is the single best
    // predictor of a link that keeps working: a routed target depends on some
    // other device choosing to forward, which is what kept breaking.
    onLink: boolean
    error?: string
}

export interface ProbeReport {
    addresses: { iface: string; address: string; cidr: string }[]
    results: ProbeResult[]
}

const PROBE_TIMEOUT_MS = 2500

function localAddresses(): ProbeReport['addresses'] {
    const out: ProbeReport['addresses'] = []
    for (const [iface, infos] of Object.entries(os.networkInterfaces())) {
        for (const info of infos ?? []) {
            if (info.family !== 'IPv4' || info.internal) continue
            out.push({ iface, address: info.address, cidr: info.cidr ?? info.address })
        }
    }
    return out
}

function toInt(ip: string): number | null {
    const parts = ip.split('.').map(Number)
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
        return null
    }
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

/** Same-subnet test against every local IPv4 address. */
function isOnLink(host: string, addresses: ProbeReport['addresses']): boolean {
    const target = toInt(host)
    if (target === null) return false
    for (const { cidr } of addresses) {
        const [base, bitsRaw] = cidr.split('/')
        const bits = Number(bitsRaw)
        const baseInt = toInt(base)
        if (baseInt === null || !Number.isInteger(bits) || bits < 1 || bits > 32) continue
        const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0
        if ((target & mask) === (baseInt & mask)) return true
    }
    return false
}

function probeTcp(host: string, port: number): Promise<{ ok: boolean; ms: number; error?: string }> {
    return new Promise((resolve) => {
        const started = Date.now()
        const socket = new net.Socket()
        const done = (ok: boolean, error?: string) => {
            socket.destroy()
            resolve({ ok, ms: Date.now() - started, error })
        }
        socket.setTimeout(PROBE_TIMEOUT_MS)
        socket.once('connect', () => done(true))
        socket.once('timeout', () => done(false, 'timed out'))
        socket.once('error', (err: NodeJS.ErrnoException) => done(false, err.code ?? err.message))
        socket.connect(port, host)
    })
}

/** UDP has no handshake, so "ok" means a reply came back. No reply is reported
 *  as such rather than as failure — but for a MAVLink endpoint, which answers
 *  as soon as it hears from us, silence is the meaningful signal. */
function probeUdp(host: string, port: number): Promise<{ ok: boolean; ms: number; error?: string }> {
    return new Promise((resolve) => {
        const started = Date.now()
        const socket = dgram.createSocket('udp4')
        let settled = false
        const done = (ok: boolean, error?: string) => {
            if (settled) return
            settled = true
            try { socket.close() } catch { /* already closed */ }
            resolve({ ok, ms: Date.now() - started, error })
        }
        const timer = setTimeout(() => done(false, 'no reply'), PROBE_TIMEOUT_MS)
        timer.unref?.()
        socket.once('message', () => { clearTimeout(timer); done(true) })
        socket.once('error', (err: NodeJS.ErrnoException) => {
            clearTimeout(timer)
            done(false, err.code ?? err.message)
        })
        // One zero byte, same opening datagram the telemetry bridge sends: enough
        // for the far end to learn our address, discarded by a MAVLink parser.
        socket.send(Buffer.of(0), port, host, (err) => {
            if (err) { clearTimeout(timer); done(false, err.message) }
        })
    })
}

export async function probeNetwork(targets: ProbeTarget[]): Promise<ProbeReport> {
    const addresses = localAddresses()
    const results = await Promise.all(targets.map(async (t): Promise<ProbeResult> => {
        const onLink = isOnLink(t.host, addresses)
        const r = t.kind === 'udp'
            ? await probeUdp(t.host, t.port)
            : await probeTcp(t.host, t.port)
        return { ...t, onLink, ok: r.ok, ms: r.ms, error: r.error }
    }))
    return { addresses, results }
}
