// Just enough MAVLink to answer one question: "is a vehicle on the other end
// of this byte stream?" Used by auto-connect to probe a serial port or a UDP
// socket before claiming it, the way QGroundControl waits for a HEARTBEAT
// before it calls something a vehicle.
//
// Parses MAVLink v1 (0xFE) and v2 (0xFD) frames, checks the X.25 CRC with the
// HEARTBEAT CRC_EXTRA (50), and reports the sender. Every other message is
// skipped. Signed v2 frames carry 13 extra bytes, which are skipped too (the
// signature itself is not checked - this is detection, not trust).

export interface Heartbeat {
    sysid: number
    compid: number
    /** MAV_TYPE: 2 quad, 1 fixed wing, 6 GCS, ... */
    type: number
    /** MAV_AUTOPILOT: 12 PX4, 3 ArduPilot, 8 invalid (not an autopilot). */
    autopilot: number
    baseMode: number
    customMode: number
    mavlinkVersion: 1 | 2
}

const HEARTBEAT_ID = 0
const HEARTBEAT_CRC_EXTRA = 50
const HEARTBEAT_LEN = 9

/** MAV_TYPE values that are never a vehicle: ground stations, gimbals,
 *  ADS-B receivers, onboard controllers, cameras, ... */
const NON_VEHICLE_TYPES = new Set([6, 18, 26, 27, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40])
const MAV_AUTOPILOT_INVALID = 8

export function crcAccumulate(b: number, crc: number): number {
    let tmp = b ^ (crc & 0xff)
    tmp = (tmp ^ (tmp << 4)) & 0xff
    return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff
}

export function x25(bytes: Uint8Array, from: number, to: number, extra: number): number {
    let c = 0xffff
    for (let i = from; i < to; i++) c = crcAccumulate(bytes[i], c)
    return crcAccumulate(extra, c)
}

/** True when the heartbeat comes from an aircraft (or rover, boat, ...)
 *  rather than another ground station or a peripheral. */
export function isVehicleHeartbeat(hb: Heartbeat): boolean {
    return hb.autopilot !== MAV_AUTOPILOT_INVALID && !NON_VEHICLE_TYPES.has(hb.type)
}

/** Incremental frame scanner. Feed it chunks in arrival order; it returns the
 *  heartbeats completed by each chunk and keeps a partial frame between
 *  calls. Bounded: never holds more than one maximum-size frame. */
export class HeartbeatScanner {
    private buf = new Uint8Array(0)

    push(chunk: Uint8Array): Heartbeat[] {
        const merged = new Uint8Array(this.buf.length + chunk.length)
        merged.set(this.buf, 0)
        merged.set(chunk, this.buf.length)
        const out: Heartbeat[] = []
        let i = 0
        while (i < merged.length) {
            const stx = merged[i]
            if (stx !== 0xfe && stx !== 0xfd) { i++; continue }
            const v2 = stx === 0xfd
            const hdr = v2 ? 10 : 6
            if (merged.length - i < hdr) break
            const len = merged[i + 1]
            const incompat = v2 ? merged[i + 2] : 0
            const sigLen = v2 && (incompat & 0x01) ? 13 : 0
            const total = hdr + len + 2 + sigLen
            const msgid = v2
                ? merged[i + 7] | (merged[i + 8] << 8) | (merged[i + 9] << 16)
                : merged[i + 5]
            if (msgid !== HEARTBEAT_ID) {
                // Other messages cannot be verified without their CRC_EXTRA.
                // Skip one byte rather than the claimed length, so a false
                // start byte inside payload data never swallows a real frame.
                i++
                continue
            }
            if (merged.length - i < total) break
            const want = merged[i + hdr + len] | (merged[i + hdr + len + 1] << 8)
            if (x25(merged, i + 1, i + hdr + len, HEARTBEAT_CRC_EXTRA) !== want) { i++; continue }
            // v2 truncates trailing zero bytes of the payload; restore them.
            const p = new Uint8Array(HEARTBEAT_LEN)
            p.set(merged.subarray(i + hdr, i + hdr + Math.min(len, HEARTBEAT_LEN)))
            out.push({
                sysid: merged[i + (v2 ? 5 : 3)],
                compid: merged[i + (v2 ? 6 : 4)],
                customMode: (p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24)) >>> 0,
                type: p[4],
                autopilot: p[5],
                baseMode: p[6],
                mavlinkVersion: v2 ? 2 : 1,
            })
            i += total
        }
        // Keep at most one maximum frame (v2 signed: 10 + 255 + 2 + 13).
        const rest = merged.subarray(i)
        this.buf = rest.length > 280 ? rest.slice(rest.length - 280) : rest.slice()
        return out
    }
}

/** Builds a HEARTBEAT frame. Used by unit tests to simulate a vehicle. */
export function encodeHeartbeat(opts: {
    sysid: number; compid?: number; type?: number; autopilot?: number; v2?: boolean; seq?: number
}): Uint8Array {
    const payload = new Uint8Array(HEARTBEAT_LEN)
    payload[4] = opts.type ?? 2
    payload[5] = opts.autopilot ?? 12
    payload[6] = 0x51
    payload[8] = 3
    const v2 = opts.v2 ?? true
    const hdr = v2 ? 10 : 6
    const f = new Uint8Array(hdr + HEARTBEAT_LEN + 2)
    if (v2) {
        f.set([0xfd, HEARTBEAT_LEN, 0, 0, opts.seq ?? 0, opts.sysid, opts.compid ?? 1, 0, 0, 0])
    } else {
        f.set([0xfe, HEARTBEAT_LEN, opts.seq ?? 0, opts.sysid, opts.compid ?? 1, 0])
    }
    f.set(payload, hdr)
    const c = x25(f, 1, hdr + HEARTBEAT_LEN, HEARTBEAT_CRC_EXTRA)
    f[hdr + HEARTBEAT_LEN] = c & 0xff
    f[hdr + HEARTBEAT_LEN + 1] = c >> 8
    return f
}

const AUTOPILOT_NAMES: Record<number, string> = { 3: 'ArduPilot', 12: 'PX4' }
const TYPE_NAMES: Record<number, string> = {
    1: 'fixed wing', 2: 'quadcopter', 3: 'coaxial', 4: 'helicopter', 10: 'rover', 11: 'boat',
    12: 'submarine', 13: 'hexacopter', 14: 'octocopter', 15: 'tricopter', 19: 'VTOL', 20: 'VTOL',
    21: 'VTOL', 22: 'VTOL', 23: 'VTOL', 24: 'VTOL', 25: 'VTOL',
}

/** "PX4 quadcopter (system 1)" */
export function describeHeartbeat(hb: Heartbeat): string {
    const ap = AUTOPILOT_NAMES[hb.autopilot] ?? 'MAVLink'
    const ty = TYPE_NAMES[hb.type] ?? 'vehicle'
    return `${ap} ${ty} (system ${hb.sysid})`
}
