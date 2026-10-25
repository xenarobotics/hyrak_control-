// Auto-connect, QGroundControl style: notice a vehicle the moment it is
// plugged in (or starts talking on UDP 14550) and hand it to the page, which
// connects it through exactly the path the operator would have clicked.
//
// This class only DETECTS. It never relays telemetry and never talks to the
// backend - the renderer (frontend/src/lib/autoConnect.ts) owns the decision
// to connect, because only the page knows whether this session already has a
// link, who is signed in and whether they may fly.
//
// Detection rules:
//   - serial ports are listed every 2 s; a new port is classified by USB
//     VID/PID (classify.ts) and only flight controllers and SiK radios are
//     ever opened;
//   - "opened" means a read-only probe: open, listen up to 3 s for a vehicle
//     HEARTBEAT, close. Nothing is written to the port;
//   - UDP: listen on 14550 (PX4 SITL and most companions send there) and
//     report the vehicles heard;
//   - everything stops while the page reports a link, while the firmware
//     page is flashing, or before the page says it is ready;
//   - a port the page has seen a link end on is suppressed until it is
//     unplugged and plugged back in (UDP: until it goes quiet for 5 s).
//
// All I/O comes in through AutoConnectDeps so the logic runs under unit tests
// with fake ports and fake sockets (test/autoconnect.test.js).

import { HeartbeatScanner, isVehicleHeartbeat, describeHeartbeat, type Heartbeat } from '../mavlink/heartbeat'
import { classifyPort, type PortClass, type PortInfoLike } from './classify'

export interface AutoConnectConfig {
    enabled: boolean
    usb: boolean
    sik: boolean
    udp: boolean
    udpPort: number
}

export const DEFAULT_AUTOCONNECT_CONFIG: AutoConnectConfig = {
    enabled: true, usb: true, sik: true, udp: true, udpPort: 14550,
}

export interface ProbeHandle {
    onData(cb: (chunk: Uint8Array) => void): void
    close(): Promise<void>
}

export interface UdpLike {
    bind(port: number, address: string): Promise<void>
    onMessage(cb: (data: Uint8Array, from: { address: string; port: number }) => void): void
    close(): Promise<void>
}

export interface AutoConnectDeps {
    listPorts(): Promise<PortInfoLike[]>
    openProbe(path: string, baud: number): Promise<ProbeHandle>
    createUdp(): UdpLike
    now(): number
    setTimer(fn: () => void, ms: number): unknown
    clearTimer(t: unknown): void
}

export interface AutoPort {
    path: string
    cls: PortClass
    name: string
    baud: number
    vendorId?: string
    productId?: string
    state: 'idle' | 'probing' | 'waiting' | 'found' | 'suppressed' | 'ignored'
}

export type AutoConnectEvent =
    | { type: 'ports'; ports: AutoPort[] }
    | {
        type: 'vehicle'; link: 'serial'; key: string; path: string; baud: number
        cls: PortClass; name: string; vehicle: string; heartbeat: Heartbeat
    }
    | {
        type: 'vehicle'; link: 'udp'; key: string; port: number; from: string
        systems: { sysid: number; vehicle: string; from: string }[]
    }
    | { type: 'status'; udp: 'off' | 'listening' | 'busy' | 'paused'; probing: string | null; paused: boolean; reason?: string }

export const POLL_MS = 2000
export const PROBE_MS = 3000
/** Collect UDP heartbeats this long after the first, to spot several vehicles. */
export const UDP_GATHER_MS = 1500
/** A suppressed UDP source is forgotten after this much silence. */
export const UDP_QUIET_MS = 5000
/** After reporting a UDP vehicle, keep the port free this long so the page
 *  can bind it for the real link. */
export const UDP_HOLD_MS = 15000
const RETRY_MS: Record<'fc' | 'sik', number> = { fc: 5000, sik: 8000 }
const GENERIC_MAX_ATTEMPTS = 3

interface PortEntry {
    info: PortInfoLike
    cls: PortClass
    name: string
    baud: number
    generic: boolean
    attempts: number
    nextProbeAt: number
    suppressed: boolean
    found: boolean
}

export class AutoConnectManager {
    private cfg: AutoConnectConfig = { ...DEFAULT_AUTOCONNECT_CONFIG }
    private ports = new Map<string, PortEntry>()
    private ready = false
    private linkActive = false
    private firmwareBusy = false
    private pollTimer: unknown = null
    private running = false
    private polling = false

    private probe: { path: string; handle: ProbeHandle | null; abort: () => void; done: Promise<void> } | null = null

    private udp: UdpLike | null = null
    private udpState: 'off' | 'listening' | 'busy' | 'paused' = 'off'
    private udpBoundPort = 0
    private udpSuppressed = false
    private udpLastHeartbeat = 0
    private udpHoldUntil = 0
    private udpRetryAt = 0
    private udpGather: { systems: Map<number, { hb: Heartbeat; from: string }>; timer: unknown } | null = null
    private udpOpening: Promise<void> | null = null

    constructor(private deps: AutoConnectDeps, private emit: (e: AutoConnectEvent) => void) {}

    // ---- control surface (IPC) -------------------------------------------

    getConfig(): AutoConnectConfig { return { ...this.cfg } }

    setConfig(next: Partial<AutoConnectConfig>): AutoConnectConfig {
        const port = Number(next.udpPort ?? this.cfg.udpPort)
        this.cfg = {
            enabled: next.enabled ?? this.cfg.enabled,
            usb: next.usb ?? this.cfg.usb,
            sik: next.sik ?? this.cfg.sik,
            udp: next.udp ?? this.cfg.udp,
            udpPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : this.cfg.udpPort,
        }
        void this.tick()
        return this.getConfig()
    }

    /** ready: the page is signed in, has a session and may fly.
     *  linkActive: the session has (or is opening) a telemetry link. */
    setGate(gate: { ready?: boolean; linkActive?: boolean }): void {
        if (gate.ready !== undefined) this.ready = gate.ready
        if (gate.linkActive !== undefined) this.linkActive = gate.linkActive
        void this.tick()
    }

    setFirmwareBusy(busy: boolean): void {
        this.firmwareBusy = busy
        void this.tick()
    }

    /** A link just ended: nothing currently present is auto-connected again
     *  until it is unplugged and replugged (UDP: until it goes quiet). This
     *  is what keeps a manual Disconnect from being undone 2 s later. */
    suppressPresent(): void {
        for (const p of this.ports.values()) p.suppressed = true
        this.udpSuppressed = true
        this.emitPorts()
    }

    /** The page decided not to use a reported vehicle (not signed in yet, a
     *  link appeared meanwhile): make it eligible again. */
    release(key: string): void {
        if (key.startsWith('udp:')) {
            this.udpSuppressed = false
            this.udpHoldUntil = 0
        } else {
            const p = this.ports.get(key.replace(/^serial:/, ''))
            if (p) { p.suppressed = false; p.found = false; p.attempts = 0; p.nextProbeAt = 0 }
        }
        void this.tick()
    }

    /** Called before any bridge opens a port, so a probe or the UDP listener
     *  never makes a manual connect fail with "port busy". */
    async yieldResources(kind: string, config: Record<string, unknown>): Promise<void> {
        if (kind === 'serial' && typeof config.path === 'string' && this.probe?.path === config.path) {
            await this.abortProbe()
        }
        if (kind === 'udp' && Array.isArray(config.ports)) {
            const wanted = (config.ports as { port?: number }[]).some(p => p?.port === this.udpBoundPort || p?.port === this.cfg.udpPort)
            if (wanted) {
                this.udpHoldUntil = this.deps.now() + UDP_HOLD_MS
                await this.closeUdp('off')
            }
        }
    }

    start(): void {
        if (this.running) return
        this.running = true
        const loop = () => {
            if (!this.running) return
            void this.tick().finally(() => {
                if (this.running) this.pollTimer = this.deps.setTimer(loop, POLL_MS)
            })
        }
        loop()
    }

    async stop(): Promise<void> {
        this.running = false
        if (this.pollTimer) this.deps.clearTimer(this.pollTimer)
        this.pollTimer = null
        await this.abortProbe()
        await this.closeUdp('off')
    }

    listPortsSnapshot(): AutoPort[] {
        return [...this.ports.values()].map(p => this.toAutoPort(p))
    }

    // ---- the loop ---------------------------------------------------------

    private paused(): string | null {
        if (!this.cfg.enabled) return 'auto-connect is off'
        if (this.firmwareBusy) return 'firmware update in progress'
        if (!this.ready) return 'waiting for sign-in'
        if (this.linkActive) return 'a vehicle is already connected'
        return null
    }

    /** One pass: refresh the port list, then probe or listen as allowed. */
    async tick(): Promise<void> {
        if (this.polling) return
        this.polling = true
        try {
            await this.refreshPorts()
            const reason = this.paused()
            if (reason) {
                if (this.probe) await this.abortProbe()
                await this.closeUdp(this.cfg.enabled && this.cfg.udp ? 'paused' : 'off')
                this.emitStatus(reason)
                return
            }
            await this.syncUdp()
            if (!this.probe) this.startNextProbe()
            this.emitStatus()
        } finally {
            this.polling = false
        }
    }

    private async refreshPorts(): Promise<void> {
        let list: PortInfoLike[]
        try {
            list = await this.deps.listPorts()
        } catch {
            return
        }
        const seen = new Set<string>()
        let changed = false
        for (const info of list) {
            if (!info || typeof info.path !== 'string') continue
            seen.add(info.path)
            if (this.ports.has(info.path)) continue
            const c = classifyPort(info)
            this.ports.set(info.path, {
                info, cls: c.cls, name: c.name, baud: c.baud, generic: c.generic,
                attempts: 0, nextProbeAt: 0, suppressed: false, found: false,
            })
            changed = true
        }
        for (const path of [...this.ports.keys()]) {
            if (seen.has(path)) continue
            // Unplugged: forget everything, including suppression - the
            // replug is the operator's way of saying "try this one again".
            this.ports.delete(path)
            if (this.probe?.path === path) await this.abortProbe()
            changed = true
        }
        if (changed) this.emitPorts()
    }

    private eligible(p: PortEntry): boolean {
        if (p.suppressed || p.found) return false
        if (p.cls === 'fc') return this.cfg.usb
        if (p.cls === 'sik') return this.cfg.sik
        return false
    }

    private startNextProbe(): void {
        const now = this.deps.now()
        for (const p of this.ports.values()) {
            if (!this.eligible(p) || p.nextProbeAt > now) continue
            if (p.generic && p.attempts >= GENERIC_MAX_ATTEMPTS) continue
            this.runProbe(p)
            return
        }
    }

    private runProbe(p: PortEntry): void {
        const path = p.info.path
        p.attempts++
        let finish!: () => void
        const done = new Promise<void>(r => { finish = r })
        let handle: ProbeHandle | null = null
        let timer: unknown = null
        let settled = false
        const state = { path, handle: null as ProbeHandle | null, abort: () => { /* set below */ }, done }
        this.probe = state

        const end = async (hb: Heartbeat | null) => {
            if (settled) return
            settled = true
            if (timer) this.deps.clearTimer(timer)
            try { await handle?.close() } catch { /* already gone */ }
            if (this.probe === state) this.probe = null
            const entry = this.ports.get(path)
            if (entry) {
                if (hb && !this.paused()) {
                    entry.found = true
                    // Reported once; the page connects or releases it.
                    entry.suppressed = true
                    this.emit({
                        type: 'vehicle', link: 'serial', key: `serial:${path}`, path, baud: entry.baud,
                        cls: entry.cls, name: entry.name, vehicle: describeHeartbeat(hb), heartbeat: hb,
                    })
                } else {
                    entry.nextProbeAt = this.deps.now() + (entry.cls === 'sik' ? RETRY_MS.sik : RETRY_MS.fc)
                }
            }
            this.emitPorts()
            finish()
        }
        state.abort = () => { void end(null) }

        this.emitPorts()
        this.deps.openProbe(path, p.baud).then((h) => {
            handle = h
            state.handle = h
            if (settled) { void h.close().catch(() => { /* gone */ }); return }
            const scanner = new HeartbeatScanner()
            h.onData((chunk) => {
                if (settled) return
                const hb = scanner.push(chunk).find(isVehicleHeartbeat)
                if (hb) void end(hb)
            })
            timer = this.deps.setTimer(() => { void end(null) }, PROBE_MS)
        }, () => {
            // Busy (another program has it), no permission, vanished: try later.
            void end(null)
        })
    }

    private async abortProbe(): Promise<void> {
        const p = this.probe
        if (!p) return
        p.abort()
        await p.done
    }

    // ---- UDP ----------------------------------------------------------------

    private async syncUdp(): Promise<void> {
        const now = this.deps.now()
        const want = this.cfg.udp && now >= this.udpHoldUntil
        if (!want) { await this.closeUdp('off'); return }
        if (this.udp && this.udpBoundPort !== this.cfg.udpPort) await this.closeUdp('off')
        if (this.udpSuppressed && this.udpLastHeartbeat && now - this.udpLastHeartbeat > UDP_QUIET_MS) {
            this.udpSuppressed = false
        }
        if (this.udp || this.udpOpening) return
        if (now < this.udpRetryAt) return
        this.udpOpening = this.openUdp().finally(() => { this.udpOpening = null })
        await this.udpOpening
    }

    private async openUdp(): Promise<void> {
        const sock = this.deps.createUdp()
        const port = this.cfg.udpPort
        try {
            await sock.bind(port, '0.0.0.0')
        } catch {
            // Another ground station (QGC, Mission Planner, a relay) holds it.
            try { await sock.close() } catch { /* never bound */ }
            this.udpState = 'busy'
            this.udpRetryAt = this.deps.now() + 10000
            return
        }
        this.udp = sock
        this.udpBoundPort = port
        this.udpState = 'listening'
        // A fresh listen starts with no memory of who was talking: quiet
        // detection must not compare against a heartbeat from long ago.
        this.udpLastHeartbeat = this.udpSuppressed ? this.deps.now() : 0
        const scanners = new Map<string, HeartbeatScanner>()
        sock.onMessage((data, from) => {
            if (this.udp !== sock) return
            const k = `${from.address}:${from.port}`
            let sc = scanners.get(k)
            if (!sc) { sc = new HeartbeatScanner(); scanners.set(k, sc) }
            for (const hb of sc.push(data)) {
                if (!isVehicleHeartbeat(hb)) continue
                this.udpLastHeartbeat = this.deps.now()
                if (this.udpSuppressed || this.paused()) continue
                this.gatherUdp(hb, k)
            }
        })
    }

    private gatherUdp(hb: Heartbeat, from: string): void {
        if (!this.udpGather) {
            const systems = new Map<number, { hb: Heartbeat; from: string }>()
            const timer = this.deps.setTimer(() => { void this.finishUdpGather() }, UDP_GATHER_MS)
            this.udpGather = { systems, timer }
        }
        if (!this.udpGather.systems.has(hb.sysid)) this.udpGather.systems.set(hb.sysid, { hb, from })
    }

    private async finishUdpGather(): Promise<void> {
        const g = this.udpGather
        this.udpGather = null
        if (!g || this.paused() || this.udpSuppressed) return
        const port = this.udpBoundPort
        const systems = [...g.systems.values()]
            .sort((a, b) => a.hb.sysid - b.hb.sysid)
            .map(s => ({ sysid: s.hb.sysid, vehicle: describeHeartbeat(s.hb), from: s.from }))
        if (!systems.length) return
        // Release the port before telling the page, so its relay can bind it.
        this.udpSuppressed = true
        this.udpHoldUntil = this.deps.now() + UDP_HOLD_MS
        await this.closeUdp('off')
        this.emit({ type: 'vehicle', link: 'udp', key: `udp:${port}`, port, from: systems[0].from, systems })
        this.emitStatus()
    }

    private async closeUdp(state: 'off' | 'paused'): Promise<void> {
        if (this.udpGather) { this.deps.clearTimer(this.udpGather.timer); this.udpGather = null }
        const s = this.udp
        this.udp = null
        if (s) { try { await s.close() } catch { /* already closed */ } }
        if (s || this.udpState !== 'busy' || state === 'paused') this.udpState = state
    }

    // ---- reporting ----------------------------------------------------------

    private toAutoPort(p: PortEntry): AutoPort {
        const state: AutoPort['state'] = p.found ? 'found'
            : this.probe?.path === p.info.path ? 'probing'
            : p.suppressed ? 'suppressed'
            : (p.cls === 'other' || (p.generic && p.attempts >= GENERIC_MAX_ATTEMPTS)) ? 'ignored'
            : p.attempts > 0 ? 'waiting' : 'idle'
        return {
            path: p.info.path, cls: p.cls, name: p.name, baud: p.baud,
            vendorId: p.info.vendorId, productId: p.info.productId, state,
        }
    }

    private emitPorts(): void {
        this.emit({ type: 'ports', ports: this.listPortsSnapshot() })
    }

    private lastStatus = ''
    private emitStatus(reason?: string): void {
        const e: AutoConnectEvent = {
            type: 'status', udp: this.udpState, probing: this.probe?.path ?? null,
            paused: !!reason, reason,
        }
        const sig = JSON.stringify(e)
        if (sig === this.lastStatus) return
        this.lastStatus = sig
        this.emit(e)
    }
}
