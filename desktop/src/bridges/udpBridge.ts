import dgram from 'node:dgram'
import type { NativeBridge, EmitFn } from './types'

// Generalizes air_unit_relay/telemetry_relay.py (one port) and
// sitl_relay/swarm_relay.py (N ports, tag-multiplexed) into a single
// bridge: bind any number of local UDP ports, each tagged with a small
// integer id, remember each port's live peer address from its first
// packet, and relay both directions. One drone's telemetry, an air unit's
// video+telemetry, or a whole SITL swarm are all just different `ports`
// configs to the SAME bridge — no protocol-specific code needed per case.

interface UdpPortConfig {
    tag: number    // identifies this port's traffic in emitted/sent events
    port: number   // local port to bind. 0 = ephemeral, chosen by the OS
    // Where to send when no peer has been LEARNED yet.
    //
    // Needed for endpoints that never transmit unsolicited — a SIYI ground unit
    // is configured with a target the way QGroundControl is ("Listening Port 0,
    // target 192.168.144.20:19856"): the GCS sends first, and the unit replies
    // to whatever source address that came from. Without this the bridge can
    // only ever answer, so nothing is ever received and nothing is ever sent —
    // a silent deadlock. MAVSDK on our backend is `udpin://` and also waits for
    // a heartbeat, so neither side would ever speak first.
    //
    // A learned peer always takes precedence: once the far end replies from a
    // concrete port, that is authoritative.
    remoteHost?: string
    remotePort?: number
    // Never learn a peer for this port — always send to remoteHost/remotePort,
    // and skip the opening punch.
    //
    // The learned-peer rule above assumes ONE endpoint that both sends and
    // receives, which is true of a SIYI ground unit and of MAVSDK. A wfb-ng
    // ground station is not like that: downlink and uplink are two separate
    // processes on two fixed ports (`wfb_rx -u 14550` and `wfb_tx -u 14551`,
    // see wfb-gs's start-gs.sh). wfb_rx sends to us from an EPHEMERAL source
    // port, so learning it and replying there would send the uplink into a
    // black hole instead of to wfb_tx. The punch is equally pointless: wfb_tx
    // is a fixed local listener with nothing to learn, and a stray zero byte
    // would just be injected over the RF uplink to the aircraft.
    pinRemote?: boolean
    // Re-send every received datagram verbatim to 127.0.0.1:<this>.
    //
    // Same reasoning as the video fan-out (webrtcSenderBridge's udpFanoutPort):
    // exactly one process can receive a unicast UDP port, so binding 14550 to
    // relay MAVLink takes it away from anything else that wants it —
    // QGroundControl being the case that came up, pointed at 127.0.0.1:14550 to
    // load parameters and upload missions. This gives QGC a port of its own to
    // listen on while HYRAK keeps the real one.
    //
    // Downlink only. Uplink stays exclusively HYRAK's: two ground stations both
    // COMMANDING one aircraft is a genuinely bad idea, and forwarding QGC's
    // outbound frames back into wfb_tx would do exactly that. QGC gets a
    // read-only view unless the operator points it at the aircraft directly.
    fanoutPort?: number
}

interface UdpStartConfig {
    ports: UdpPortConfig[]
    // Interface to bind. Defaults to 0.0.0.0 (all interfaces) — NOT
    // 127.0.0.1, which was the original default and silently dropped every
    // packet that didn't arrive on loopback. That broke the common case of a
    // client running PX4 SITL inside WSL2, Docker, or a VM: those send from a
    // separate network namespace, so the packets land on a vEthernet/bridge
    // interface and a loopback-scoped bind never sees them at all — the port
    // binds fine, no error anywhere, and no byte ever arrives. (WSL2's
    // localhost forwarding is TCP-only, so "just use 127.0.0.1" genuinely
    // cannot work there.) Overridable for anyone who wants to keep the port
    // off their LAN.
    bindAddress?: string
}

interface UdpSocketEntry {
    socket: dgram.Socket
    peer: { address: string; port: number } | null
    sawTraffic: boolean
    remote: { address: string; port: number } | null
    pinRemote: boolean
    fanout: dgram.Socket | null
    fanoutPort: number | null
    // Repeats the opening datagram until the far end answers; cleared on the
    // first inbound packet. The far end may not be listening yet when we start.
    punchTimer: NodeJS.Timeout | null
}

interface UdpConn {
    sockets: Map<number, UdpSocketEntry>
}

export class UdpBridge implements NativeBridge {
    readonly kind = 'udp'
    private conns = new Map<string, UdpConn>()

    async start(id: string, config: Record<string, unknown>, emit: EmitFn): Promise<{ ok: boolean; error?: string }> {
        const cfg = config as unknown as UdpStartConfig
        if (!cfg.ports || cfg.ports.length === 0) {
            return { ok: false, error: 'no ports configured' }
        }
        await this.stop(id) // replace any previous connection under this id

        const bindAddress = cfg.bindAddress || '0.0.0.0'
        const conn: UdpConn = { sockets: new Map() }
        for (const { tag, port, remoteHost, remotePort, pinRemote, fanoutPort } of cfg.ports) {
            const socket = dgram.createSocket('udp4')
            const remote = remoteHost
                ? { address: remoteHost, port: remotePort ?? port }
                : null
            // Errors ignored: nothing may be listening yet (QGC not started), and
            // a missing observer must never disturb the link that IS working.
            let fanout: dgram.Socket | null = null
            if (fanoutPort && fanoutPort > 0 && fanoutPort !== port) {
                fanout = dgram.createSocket('udp4')
                fanout.on('error', () => { /* no listener — ICMP port unreachable */ })
                fanout.unref()
            }
            const entry: UdpSocketEntry = {
                socket, peer: null, sawTraffic: false, remote,
                pinRemote: !!pinRemote, punchTimer: null,
                fanout, fanoutPort: fanout ? fanoutPort! : null,
            }

            socket.on('message', (data, rinfo) => {
                entry.peer = { address: rinfo.address, port: rinfo.port }
                if (entry.fanout && entry.fanoutPort) {
                    entry.fanout.send(data, entry.fanoutPort, '127.0.0.1', () => { /* no listener */ })
                }
                // Announce the FIRST packet per port. Binding successfully and
                // receiving nothing are indistinguishable to the renderer
                // otherwise, which is exactly the state a misconfigured SITL
                // leaves you in — so callers can't tell "waiting for traffic"
                // from "traffic flowing" and neither can the operator.
                if (!entry.sawTraffic) {
                    entry.sawTraffic = true
                    if (entry.punchTimer) {
                        clearInterval(entry.punchTimer)
                        entry.punchTimer = null
                    }
                    emit({
                        bridge: 'udp', id, type: 'status',
                        meta: { tag, port, receiving: true, from: `${rinfo.address}:${rinfo.port}` },
                    })
                }
                emit({ bridge: 'udp', id, type: 'data', data: new Uint8Array(data), meta: { tag, port } })
            })
            socket.on('error', (err) => {
                emit({ bridge: 'udp', id, type: 'error', meta: { tag, port, message: err.message } })
            })

            try {
                await new Promise<void>((resolve, reject) => {
                    socket.once('error', reject)
                    socket.bind(port, bindAddress, () => resolve())
                })
            } catch (err) {
                for (const e of conn.sockets.values()) e.socket.close()
                return { ok: false, error: `couldn't bind udp:${port} — ${(err as Error).message}` }
            }
            // Announce ourselves so a target-configured endpoint learns where to
            // reply. One zero byte: enough for the far end's UDP layer to record
            // the source address, and discarded by any MAVLink parser as not a
            // frame start. Repeated until the far end answers, because it may
            // not be up yet when the operator hits Connect.
            if (entry.remote && !entry.pinRemote) {
                const punch = () => {
                    if (entry.sawTraffic || !entry.remote) return
                    try {
                        entry.socket.send(Buffer.of(0), entry.remote.port, entry.remote.address)
                    } catch { /* interface not ready yet; the interval retries */ }
                }
                punch()
                entry.punchTimer = setInterval(punch, 1000)
                entry.punchTimer.unref?.()
            }
            conn.sockets.set(tag, entry)
        }

        this.conns.set(id, conn)
        emit({ bridge: 'udp', id, type: 'status', meta: { connected: true, ports: cfg.ports, bindAddress } })
        return { ok: true }
    }

    async stop(id: string): Promise<void> {
        const conn = this.conns.get(id)
        if (!conn) return
        for (const entry of conn.sockets.values()) {
            if (entry.punchTimer) clearInterval(entry.punchTimer)
            try { entry.socket.close() } catch { /* already closed */ }
            try { entry.fanout?.close() } catch { /* already closed */ }
        }
        this.conns.delete(id)
    }

    send(id: string, data: Uint8Array, meta?: Record<string, unknown>): void {
        const conn = this.conns.get(id)
        if (!conn) return
        const tag = (meta?.tag as number | undefined) ?? 0
        const entry = conn.sockets.get(tag)
        if (!entry) return
        // Learned peer wins; fall back to the configured target so the first
        // outbound frame can go out before anything has been received. Unless
        // the remote is pinned, in which case the peer is deliberately ignored
        // — see pinRemote.
        const dest = entry.pinRemote ? entry.remote : (entry.peer ?? entry.remote)
        if (!dest) return // nothing learned and no target configured
        entry.socket.send(Buffer.from(data), dest.port, dest.address)
    }
}
