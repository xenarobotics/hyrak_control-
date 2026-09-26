// Local link fallback - the operator's own machine keeps the aircraft's link
// alive when the cloud is unreachable.
//
// HYRAK's companion computer is the cloud: telemetry from the radio (or SITL)
// on this machine is relayed up to it and every command comes back down the
// same way. When the internet path drops, that relay has nobody on the other
// end - the aircraft stops hearing a ground station and, after COM_DL_LOSS_T,
// runs its link-loss failsafe even though the operator is sitting right next
// to a working radio.
//
// This module sits beside every relay (it sees the same bytes both ways) and,
// only while the cloud socket is down:
//   - decodes the aircraft's own HEARTBEAT / SYS_STATUS / GLOBAL_POSITION_INT
//     / COMMAND_ACK so the operator still sees mode, armed, altitude, battery;
//   - sends a ground-station HEARTBEAT (1 Hz) straight down the local link, so
//     a cloud blip does not abort a mission the aircraft is flying on its own;
//   - offers HOLD / RETURN / LAND as MAV_CMD_DO_SET_MODE sent locally.
// When the cloud comes back it stops talking and the cloud's MAVSDK owns the
// link again. Parsing runs always (cheap), so the panel has data the moment
// it is needed.

type SendFn = (bytes: Uint8Array) => void

export interface LocalState {
    sysid: number | null
    mode: string
    armed: boolean
    altM: number | null
    lat: number | null
    lon: number | null
    batteryPct: number | null
    lastRxMs: number          // Date.now() of the last packet from the aircraft
    lastAck: { command: number; result: number; atMs: number } | null
}

const GCS_SYSID = 250          // distinct from the cloud's MAVSDK links (245, fleet 200+i)
const GCS_COMPID = 190         // MAV_COMP_ID_MISSIONPLANNER
const CRC_EXTRA: Record<number, number> = { 0: 50, 1: 124, 33: 104, 76: 152, 77: 143 }

let sender: SendFn | null = null
let seq = 0
let cloudUp = true
let hbTimer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()
const state: LocalState = {
    sysid: null, mode: '-', armed: false, altM: null, lat: null, lon: null,
    batteryPct: null, lastRxMs: 0, lastAck: null,
}
let buf = new Uint8Array(0)

// ---------------------------------------------------------------- CRC (X.25)
function crcAccumulate(b: number, crc: number): number {
    let tmp = b ^ (crc & 0xff)
    tmp = (tmp ^ (tmp << 4)) & 0xff
    return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff
}
function crc(bytes: Uint8Array, from: number, to: number, extra: number): number {
    let c = 0xffff
    for (let i = from; i < to; i++) c = crcAccumulate(bytes[i], c)
    return crcAccumulate(extra, c)
}

// ---------------------------------------------------------------- decode
const PX4_MAIN: Record<number, string> = { 1: 'MANUAL', 2: 'ALTCTL', 3: 'POSCTL', 4: 'AUTO', 5: 'ACRO', 6: 'OFFBOARD', 7: 'STABILIZED' }
const PX4_AUTO: Record<number, string> = { 1: 'READY', 2: 'TAKEOFF', 3: 'HOLD', 4: 'MISSION', 5: 'RTL', 6: 'LAND', 8: 'FOLLOW' }
function px4Mode(custom: number): string {
    const main = (custom >>> 16) & 0xff, sub = (custom >>> 24) & 0xff
    if (main === 4) return PX4_AUTO[sub] ?? `AUTO.${sub}`
    return PX4_MAIN[main] ?? `MODE ${main}`
}

function handle(msgid: number, sysid: number, compid: number, p: DataView) {
    if (msgid === 0) {
        const type = p.getUint8(4), autopilot = p.getUint8(5)
        if (type === 6 || autopilot === 8 || compid !== 1) return     // a GCS, not the aircraft
        state.sysid = sysid
        state.mode = px4Mode(p.getUint32(0, true))
        state.armed = (p.getUint8(6) & 0x80) !== 0
    } else if (msgid === 1) {
        const b = p.getInt8(30)
        state.batteryPct = b >= 0 ? b : null
    } else if (msgid === 33) {
        state.lat = p.getInt32(4, true) / 1e7
        state.lon = p.getInt32(8, true) / 1e7
        state.altM = p.getInt32(16, true) / 1000
    } else if (msgid === 77) {
        state.lastAck = { command: p.getUint16(0, true), result: p.getUint8(2), atMs: Date.now() }
    } else {
        return
    }
    state.lastRxMs = Date.now()
    listeners.forEach(l => l())
}

const FULL_LEN: Record<number, number> = { 0: 9, 1: 43, 33: 28, 77: 10 }

/** Every relay calls this with each packet it receives from the aircraft. */
export function feedLocal(chunk: Uint8Array | ArrayBuffer): void {
    const inb = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
    const merged = new Uint8Array(buf.length + inb.length)
    merged.set(buf); merged.set(inb, buf.length)
    let i = 0
    while (i < merged.length) {
        const stx = merged[i]
        if (stx !== 0xfd && stx !== 0xfe) { i++; continue }
        const v2 = stx === 0xfd
        if (merged.length - i < (v2 ? 12 : 8)) break
        const len = merged[i + 1]
        const signed = v2 && (merged[i + 2] & 0x01) !== 0
        const hdr = v2 ? 10 : 6
        const total = hdr + len + 2 + (signed ? 13 : 0)
        if (merged.length - i < total) break
        const sysid = merged[i + (v2 ? 5 : 3)], compid = merged[i + (v2 ? 6 : 4)]
        const msgid = v2 ? (merged[i + 7] | (merged[i + 8] << 8) | (merged[i + 9] << 16)) : merged[i + 5]
        const extra = CRC_EXTRA[msgid]
        if (extra !== undefined) {
            const want = merged[i + hdr + len] | (merged[i + hdr + len + 1] << 8)
            if (crc(merged, i + 1, i + hdr + len, extra) !== want) { i++; continue }   // not a frame
            const full = new Uint8Array(Math.max(len, FULL_LEN[msgid] ?? len))   // v2 trims trailing zeros
            full.set(merged.subarray(i + hdr, i + hdr + len))
            handle(msgid, sysid, compid, new DataView(full.buffer))
        }
        i += total
    }
    buf = merged.slice(i)
    if (buf.length > 4096) buf = new Uint8Array(0)
}

// ---------------------------------------------------------------- encode
function frame(msgid: number, payload: Uint8Array): Uint8Array {
    const hdr = 10, out = new Uint8Array(hdr + payload.length + 2)
    out[0] = 0xfd; out[1] = payload.length; out[2] = 0; out[3] = 0
    out[4] = seq++ & 0xff; out[5] = GCS_SYSID; out[6] = GCS_COMPID
    out[7] = msgid & 0xff; out[8] = (msgid >> 8) & 0xff; out[9] = (msgid >> 16) & 0xff
    out.set(payload, hdr)
    const c = crc(out, 1, hdr + payload.length, CRC_EXTRA[msgid])
    out[hdr + payload.length] = c & 0xff; out[hdr + payload.length + 1] = c >> 8
    return out
}

function heartbeat(): Uint8Array {
    const p = new Uint8Array(9)
    p[4] = 6          // MAV_TYPE_GCS
    p[5] = 8          // MAV_AUTOPILOT_INVALID
    p[7] = 4          // MAV_STATE_ACTIVE
    p[8] = 3          // mavlink_version
    return frame(0, p)
}

function commandLong(command: number, params: number[]): Uint8Array {
    const p = new Uint8Array(33), dv = new DataView(p.buffer)
    for (let k = 0; k < 7; k++) dv.setFloat32(k * 4, params[k] ?? 0, true)
    dv.setUint16(28, command, true)
    p[30] = state.sysid ?? 1
    p[31] = 1          // autopilot component
    return frame(76, p)
}

// ---------------------------------------------------------------- control
export type LocalCommand = 'hold' | 'rtl' | 'land'
const SUB: Record<LocalCommand, number> = { hold: 3, rtl: 5, land: 6 }

/** Send a mode change straight down the local link (no cloud involved). */
export function sendLocalCommand(cmd: LocalCommand): boolean {
    if (!sender || state.sysid === null) return false
    // MAV_CMD_DO_SET_MODE: custom mode enabled, PX4 main AUTO, sub-mode
    sender(commandLong(176, [1, 4, SUB[cmd]]))
    return true
}

export function registerLocalLink(send: SendFn): void {
    sender = send
    syncHeartbeat()
}

export function unregisterLocalLink(send?: SendFn): void {
    if (send && sender !== send) return
    sender = null
    syncHeartbeat()
}

export function hasLocalLink(): boolean {
    return sender !== null
}

/** useDrone tells us whether the cloud socket is up. */
export function setCloudUp(up: boolean): void {
    if (cloudUp === up) return
    cloudUp = up
    syncHeartbeat()
    listeners.forEach(l => l())
}
export function isCloudUp(): boolean { return cloudUp }

function syncHeartbeat() {
    const want = !cloudUp && sender !== null
    if (want && !hbTimer) {
        sender?.(heartbeat())
        hbTimer = setInterval(() => sender?.(heartbeat()), 1000)
    } else if (!want && hbTimer) {
        clearInterval(hbTimer)
        hbTimer = null
    }
}

export function getLocalState(): LocalState { return state }
export function subscribeLocal(fn: () => void): () => void {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
}

// Test hooks (pure frame building / parsing, no link needed).
export const __test = { frame, heartbeat, commandLong, crc, px4Mode, state }
