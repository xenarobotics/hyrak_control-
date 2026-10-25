// A small reader for PX4's ULog flight logs (.ulg), run in the browser so a
// log never leaves the user's computer. It follows the published format
// (docs.px4.io "ULog File Format"): a 16 byte header, then messages of
// [uint16 size][uint8 type][payload]. Definitions (F formats, I info,
// P parameters) come first; A messages subscribe a topic to a message id and
// D messages carry its samples.
//
// Parsing builds an index only (where each sample starts); values are read
// from the file buffer when a field is asked for, so a 100 MB log costs a
// few MB of index on top of the file itself.

export interface ULogField {
    /** Flattened name: "x", "q[2]", "esc[3].esc_rpm". */
    name: string
    type: string
    offset: number
}

export interface ULogTopic {
    msgId: number
    name: string
    multiId: number
    fields: ULogField[]
    /** Payload start of each sample in the file buffer. */
    starts: number[]
    lengths: number[]
    /** Offset of the uint64 timestamp field, or -1. */
    tsOffset: number
}

export interface ULogText { t: number; level: number; text: string }

export interface ULog {
    version: number
    info: Record<string, string | number>
    params: Record<string, number>
    topics: ULogTopic[]
    messages: ULogText[]
    dropouts: number
    dropoutMs: number
    /** First and last sample time, microseconds of autopilot clock. */
    firstUs: number
    lastUs: number
    truncated: boolean
    view: DataView
}

const MAGIC = [0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35]

const PRIM: Record<string, number> = {
    int8_t: 1, uint8_t: 1, bool: 1, char: 1,
    int16_t: 2, uint16_t: 2,
    int32_t: 4, uint32_t: 4, float: 4,
    int64_t: 8, uint64_t: 8, double: 8,
}

const dec = new TextDecoder('utf-8', { fatal: false })

function str(view: DataView, off: number, len: number): string {
    return dec.decode(new Uint8Array(view.buffer, view.byteOffset + off, Math.max(0, len)))
}

export function readPrim(view: DataView, off: number, type: string): number {
    switch (type) {
        case 'int8_t': return view.getInt8(off)
        case 'uint8_t': case 'bool': case 'char': return view.getUint8(off)
        case 'int16_t': return view.getInt16(off, true)
        case 'uint16_t': return view.getUint16(off, true)
        case 'int32_t': return view.getInt32(off, true)
        case 'uint32_t': return view.getUint32(off, true)
        case 'float': return view.getFloat32(off, true)
        case 'double': return view.getFloat64(off, true)
        case 'int64_t': return Number(view.getBigInt64(off, true))
        case 'uint64_t': return Number(view.getBigUint64(off, true))
        default: return NaN
    }
}

interface RawField { type: string; name: string; arr: number | null }

function parseFormat(s: string): { name: string; fields: RawField[] } | null {
    const colon = s.indexOf(':')
    if (colon <= 0) return null
    const fields: RawField[] = []
    for (const part of s.slice(colon + 1).split(';')) {
        const p = part.trim()
        if (!p) continue
        const sp = p.lastIndexOf(' ')
        if (sp <= 0) continue
        let type = p.slice(0, sp).trim()
        const name = p.slice(sp + 1).trim()
        let arr: number | null = null
        const m = /^(.+)\[(\d+)\]$/.exec(type)
        if (m) { type = m[1]; arr = Number(m[2]) }
        fields.push({ type, name, arr })
    }
    return { name: s.slice(0, colon), fields }
}

/** Flatten a format into primitive fields with byte offsets. Char arrays
 *  (strings) and padding are skipped but still take their space. */
function flatten(fmtName: string, formats: Map<string, RawField[]>, prefix = '', base = 0, depth = 0,
    out: ULogField[] = []): { fields: ULogField[]; size: number } {
    const raw = formats.get(fmtName)
    if (!raw || depth > 8) return { fields: out, size: 0 }
    let off = base
    for (const f of raw) {
        const n = f.arr ?? 1
        const prim = PRIM[f.type]
        if (prim) {
            const skip = f.name.startsWith('_padding') || (f.type === 'char' && f.arr != null)
            if (!skip) {
                if (f.arr == null) out.push({ name: prefix + f.name, type: f.type, offset: off })
                else for (let i = 0; i < n; i++) out.push({ name: `${prefix}${f.name}[${i}]`, type: f.type, offset: off + i * prim })
            }
            off += prim * n
        } else {
            for (let i = 0; i < n; i++) {
                const sub = flatten(f.type, formats, `${prefix}${f.name}${f.arr != null ? `[${i}]` : ''}.`, off, depth + 1, out)
                off = Math.max(off, sub.size)
            }
        }
    }
    return { fields: out, size: off }
}

/** Parse a whole .ulg file. Throws on a file that is not ULog. */
export function parseULog(buf: ArrayBuffer): ULog {
    const view = new DataView(buf)
    if (buf.byteLength < 16 || MAGIC.some((b, i) => view.getUint8(i) !== b)) {
        throw new Error('This is not a PX4 ULog file (.ulg)')
    }
    const version = view.getUint8(7)
    const formats = new Map<string, RawField[]>()
    const flat = new Map<string, { fields: ULogField[]; size: number }>()
    const byId = new Map<number, ULogTopic>()
    const topics: ULogTopic[] = []
    const info: Record<string, string | number> = {}
    const params: Record<string, number> = {}
    const messages: ULogText[] = []
    let dropouts = 0, dropoutMs = 0
    let firstUs = Infinity, lastUs = -Infinity
    let truncated = false
    let pos = 16
    const end = buf.byteLength

    const keyValue = (off: number, len: number): { key: string; type: string; value: string | number } | null => {
        const klen = view.getUint8(off)
        if (1 + klen > len) return null
        const key = str(view, off + 1, klen)
        const sp = key.lastIndexOf(' ')
        if (sp <= 0) return null
        const tdecl = key.slice(0, sp), name = key.slice(sp + 1)
        const vOff = off + 1 + klen, vLen = len - 1 - klen
        const m = /^(.+)\[(\d+)\]$/.exec(tdecl)
        if (m && m[1] === 'char') return { key: name, type: tdecl, value: str(view, vOff, vLen).replace(/\0+$/, '') }
        const size = PRIM[tdecl]
        if (!size || vLen < size) return { key: name, type: tdecl, value: '' }
        return { key: name, type: tdecl, value: readPrim(view, vOff, tdecl) }
    }

    while (pos + 3 <= end) {
        const size = view.getUint16(pos, true)
        const type = view.getUint8(pos + 2)
        const p = pos + 3
        if (p + size > end) { truncated = true; break }
        switch (type) {
            case 0x46: { // 'F' format
                const f = parseFormat(str(view, p, size))
                if (f) formats.set(f.name, f.fields)
                break
            }
            case 0x49: { // 'I' info
                const kv = keyValue(p, size)
                if (kv) info[kv.key] = kv.value
                break
            }
            case 0x50: { // 'P' parameter (later ones are changes in flight; keep the first)
                const kv = keyValue(p, size)
                if (kv && typeof kv.value === 'number' && !(kv.key in params)) params[kv.key] = kv.value
                break
            }
            case 0x41: { // 'A' add logged message
                if (size < 3) break
                const multiId = view.getUint8(p)
                const msgId = view.getUint16(p + 1, true)
                const name = str(view, p + 3, size - 3)
                let fl = flat.get(name)
                if (!fl) { fl = flatten(name, formats); flat.set(name, fl) }
                const ts = fl.fields.find(f => f.name === 'timestamp' && f.type === 'uint64_t')
                const topic: ULogTopic = { msgId, name, multiId, fields: fl.fields.filter(f => f !== ts), starts: [], lengths: [], tsOffset: ts ? ts.offset : -1 }
                byId.set(msgId, topic)
                topics.push(topic)
                break
            }
            case 0x44: { // 'D' data
                if (size < 2) break
                const topic = byId.get(view.getUint16(p, true))
                if (!topic) break
                const start = p + 2, len = size - 2
                topic.starts.push(start)
                topic.lengths.push(len)
                if (topic.tsOffset >= 0 && topic.tsOffset + 8 <= len) {
                    const t = Number(view.getBigUint64(start + topic.tsOffset, true))
                    if (t > 0) { if (t < firstUs) firstUs = t; if (t > lastUs) lastUs = t }
                }
                break
            }
            case 0x4c: { // 'L' logged string
                if (size < 9) break
                const lv = view.getUint8(p)
                messages.push({ t: Number(view.getBigUint64(p + 1, true)), level: lv >= 0x30 ? lv - 0x30 : lv, text: str(view, p + 9, size - 9) })
                break
            }
            case 0x43: { // 'C' tagged logged string
                if (size < 11) break
                const lv = view.getUint8(p)
                messages.push({ t: Number(view.getBigUint64(p + 3, true)), level: lv >= 0x30 ? lv - 0x30 : lv, text: str(view, p + 11, size - 11) })
                break
            }
            case 0x4f: { // 'O' dropout
                if (size >= 2) { dropouts++; dropoutMs += view.getUint16(p, true) }
                break
            }
            case 0x42: case 0x4d: case 0x51: case 0x52: case 0x53:
                break // flags, multi info, default params, remove, sync
            default:
                // Not a ULog message: the file is cut or corrupt from here.
                truncated = true
        }
        if (truncated) break
        pos = p + size
    }
    if (!Number.isFinite(firstUs)) { firstUs = 0; lastUs = 0 }
    // The header's timestamp is when logging started. A topic logged once
    // with an old sample (home position, a parameter update) would
    // otherwise stretch the time axis back to before the log began.
    const startUs = Number(view.getBigUint64(8, true))
    if (startUs > 0 && startUs > firstUs && startUs < lastUs) firstUs = startUs
    return { version, info, params, topics, messages, dropouts, dropoutMs, firstUs, lastUs, truncated, view }
}

/** Display name of a topic: "vehicle_attitude", or "sensor_accel 1" for a second instance. */
export function topicLabel(t: ULogTopic): string {
    return t.multiId > 0 ? `${t.name} ${t.multiId}` : t.name
}

/** One field over time: t in seconds since the log's first sample. */
export function readSeries(log: ULog, topic: ULogTopic, fieldName: string): { t: Float64Array; v: Float64Array } {
    const f = topic.fields.find(x => x.name === fieldName)
    const n = topic.starts.length
    const t = new Float64Array(n), v = new Float64Array(n)
    if (!f || topic.tsOffset < 0) return { t: t.subarray(0, 0), v: v.subarray(0, 0) }
    const size = PRIM[f.type]
    let k = 0
    for (let i = 0; i < n; i++) {
        const s = topic.starts[i], len = topic.lengths[i]
        if (topic.tsOffset + 8 > len || f.offset + size > len) continue // trailing padding cut by the logger
        const ts = Number(log.view.getBigUint64(s + topic.tsOffset, true))
        const val = readPrim(log.view, s + f.offset, f.type)
        if (!Number.isFinite(val)) continue
        t[k] = (ts - log.firstUs) / 1e6
        v[k] = val
        k++
    }
    return { t: t.subarray(0, k), v: v.subarray(0, k) }
}

/** Min / max per pixel bucket inside [a, b], so a line over a whole log
 *  keeps its spikes while drawing at most 2 x buckets points. */
export function decimate(t: Float64Array, v: Float64Array, a: number, b: number, buckets: number): { t: number; v: number }[] {
    const out: { t: number; v: number }[] = []
    if (!t.length || b <= a) return out
    // First index at or after a (minus one, so the line enters the window).
    let lo = 0, hi = t.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < a) lo = m + 1; else hi = m }
    let i = Math.max(0, lo - 1)
    const w = (b - a) / buckets
    while (i < t.length) {
        const bi = Math.floor((t[i] - a) / w)
        let minI = i, maxI = i, j = i
        while (j < t.length && Math.floor((t[j] - a) / w) === bi) {
            if (v[j] < v[minI]) minI = j
            if (v[j] > v[maxI]) maxI = j
            j++
        }
        const [p, q] = minI <= maxI ? [minI, maxI] : [maxI, minI]
        out.push({ t: t[p], v: v[p] })
        if (q !== p) out.push({ t: t[q], v: v[q] })
        if (t[i] > b) break
        i = j
    }
    return out
}

// ── camera triggers, for GeoTag ─────────────────────────────────────────

export interface Trigger { t: number; lat: number; lon: number; alt: number; seq: number }

function col(log: ULog, topic: ULogTopic, name: string) { return readSeries(log, topic, name) }

/** Every photo the autopilot logged, with where it was taken. PX4 logs
 *  camera_capture (with position) when it gets the camera's feedback, and
 *  camera_trigger (time only) when it fires the trigger; for the latter the
 *  position is interpolated from vehicle_global_position. */
export function extractTriggers(log: ULog): { source: 'camera_capture' | 'camera_trigger' | null; list: Trigger[] } {
    const cap = log.topics.find(t => t.name === 'camera_capture' && t.starts.length)
    if (cap) {
        const lat = col(log, cap, 'lat'), lon = col(log, cap, 'lon'), alt = col(log, cap, 'alt'), seq = col(log, cap, 'seq')
        const res = cap.fields.some(f => f.name === 'result') ? col(log, cap, 'result') : null
        const list: Trigger[] = []
        for (let i = 0; i < lat.t.length; i++) {
            if (res && res.v[i] === 0) continue // the camera said it failed
            if (!lat.v[i] && !lon.v[i]) continue
            list.push({ t: lat.t[i], lat: lat.v[i], lon: lon.v[i], alt: alt.v[i] ?? 0, seq: seq.v[i] ?? i })
        }
        if (list.length) return { source: 'camera_capture', list }
    }
    const trig = log.topics.find(t => t.name === 'camera_trigger' && t.starts.length)
    const gpos = log.topics.find(t => t.name === 'vehicle_global_position' && t.multiId === 0 && t.starts.length)
    if (trig && gpos) {
        const seq = col(log, trig, 'seq')
        const la = col(log, gpos, 'lat'), lo = col(log, gpos, 'lon'), al = col(log, gpos, 'alt')
        const list: Trigger[] = []
        let j = 0
        for (let i = 0; i < seq.t.length; i++) {
            const t = seq.t[i]
            while (j + 1 < la.t.length && la.t[j + 1] < t) j++
            if (j + 1 >= la.t.length || la.t[j] > t) continue
            const f = (t - la.t[j]) / Math.max(1e-6, la.t[j + 1] - la.t[j])
            const lerp = (a: Float64Array) => a[j] + (a[j + 1] - a[j]) * f
            list.push({ t, lat: lerp(la.v), lon: lerp(lo.v), alt: lerp(al.v), seq: seq.v[i] })
        }
        return { source: 'camera_trigger', list }
    }
    return { source: null, list: [] }
}
