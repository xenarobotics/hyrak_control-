// Just enough JPEG / EXIF handling for GeoTag: read when a photo was taken,
// and add a GPS position to a copy of it without re-encoding the image or
// moving any existing metadata.
//
// Adding GPS: the existing EXIF block (a TIFF structure) is kept byte for
// byte. A new first directory (IFD0) is appended after it, holding the old
// IFD0's entries plus a pointer to a new GPS directory, and the TIFF header
// is pointed at the new IFD0. Every existing offset stays valid because
// nothing before the end moves, so maker notes and thumbnails survive.

const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0, 0] // "Exif\0\0"

interface Seg { marker: number; start: number; end: number; data: number } // data = payload start

function segments(b: Uint8Array): Seg[] {
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new Error('Not a JPEG file')
    const out: Seg[] = []
    let p = 2
    while (p + 4 <= b.length) {
        if (b[p] !== 0xff) break
        const marker = b[p + 1]
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { p += 2; continue }
        if (marker === 0xff) { p += 1; continue }
        const len = (b[p + 2] << 8) | b[p + 3]
        out.push({ marker, start: p, end: p + 2 + len, data: p + 4 })
        if (marker === 0xda) break // start of scan: image data follows
        p += 2 + len
    }
    return out
}

function exifSeg(b: Uint8Array, segs: Seg[]): Seg | null {
    for (const s of segs) {
        if (s.marker === 0xe1 && EXIF_ID.every((c, i) => b[s.data + i] === c)) return s
    }
    return null
}

class Tiff {
    v: DataView
    le: boolean
    constructor(public b: Uint8Array) {
        this.v = new DataView(b.buffer, b.byteOffset, b.byteLength)
        const bo = String.fromCharCode(b[0], b[1])
        if (bo !== 'II' && bo !== 'MM') throw new Error('Bad EXIF byte order')
        this.le = bo === 'II'
    }
    u16(o: number) { return this.v.getUint16(o, this.le) }
    u32(o: number) { return this.v.getUint32(o, this.le) }
    ifd0() { return this.u32(4) }
    /** Entries of the directory at `off`: [tag, type, count, raw value / offset field position]. */
    entries(off: number): { tag: number; type: number; count: number; at: number }[] {
        if (off + 2 > this.b.length) return []
        const n = this.u16(off)
        const out = []
        for (let i = 0; i < n; i++) {
            const at = off + 2 + i * 12
            if (at + 12 > this.b.length) break
            out.push({ tag: this.u16(at), type: this.u16(at + 2), count: this.u32(at + 4), at })
        }
        return out
    }
    next(off: number) { const n = this.u16(off); const at = off + 2 + n * 12; return at + 4 <= this.b.length ? this.u32(at) : 0 }
    ascii(e: { count: number; at: number }): string {
        const off = e.count <= 4 ? e.at + 8 : this.u32(e.at + 8)
        let s = ''
        for (let i = 0; i < e.count && off + i < this.b.length; i++) { const c = this.b[off + i]; if (!c) break; s += String.fromCharCode(c) }
        return s
    }
}

/** When the photo was taken, by the camera's own clock, as milliseconds
 *  (UTC-naive: the camera's local time read as if UTC), or null. */
export function photoTime(head: Uint8Array): number | null {
    try {
        const segs = segments(head)
        const s = exifSeg(head, segs)
        if (!s) return null
        const t = new Tiff(head.subarray(s.data + 6, Math.min(s.end, head.length)))
        const ifd0 = t.entries(t.ifd0())
        let when = '', sub = ''
        const exifPtr = ifd0.find(e => e.tag === 0x8769)
        if (exifPtr) {
            const ex = t.entries(t.u32(exifPtr.at + 8))
            const dto = ex.find(e => e.tag === 0x9003)
            if (dto) when = t.ascii(dto)
            const ss = ex.find(e => e.tag === 0x9291)
            if (ss) sub = t.ascii(ss).trim()
        }
        if (!when) { const dt = ifd0.find(e => e.tag === 0x0132); if (dt) when = t.ascii(dt) }
        const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(when)
        if (!m) return null
        const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
        const frac = /^\d+$/.test(sub) ? Number('0.' + sub) * 1000 : 0
        return Number.isFinite(ms) ? ms + frac : null
    } catch {
        return null
    }
}

function rationals(vals: [number, number][], le: boolean): Uint8Array {
    const out = new Uint8Array(vals.length * 8)
    const v = new DataView(out.buffer)
    vals.forEach(([n, d], i) => { v.setUint32(i * 8, n, le); v.setUint32(i * 8 + 4, d, le) })
    return out
}

function dms(deg: number): [number, number][] {
    const a = Math.abs(deg)
    const d = Math.floor(a)
    const mf = (a - d) * 60
    const m = Math.floor(mf)
    const s = Math.round((mf - m) * 60 * 10000)
    return [[d, 1], [m, 1], [s, 10000]]
}

/** A GPS directory placed at `at` (TIFF offset), with its data after it. */
function gpsIfd(at: number, lat: number, lon: number, alt: number, le: boolean): Uint8Array {
    const n = 7
    const dirSize = 2 + n * 12 + 4
    const latData = rationals(dms(lat), le), lonData = rationals(dms(lon), le)
    const altData = rationals([[Math.round(Math.abs(alt) * 1000), 1000]], le)
    const out = new Uint8Array(dirSize + latData.length + lonData.length + altData.length)
    const v = new DataView(out.buffer)
    v.setUint16(0, n, le)
    let k = 0
    const entry = (tag: number, type: number, count: number, fill: (o: number) => void) => {
        const o = 2 + k * 12
        v.setUint16(o, tag, le); v.setUint16(o + 2, type, le); v.setUint32(o + 4, count, le)
        fill(o + 8)
        k++
    }
    const latAt = at + dirSize, lonAt = latAt + latData.length, altAt = lonAt + lonData.length
    entry(0x0000, 1, 4, o => { out.set([2, 3, 0, 0], o) })                               // GPSVersionID
    entry(0x0001, 2, 2, o => { out[o] = (lat >= 0 ? 'N' : 'S').charCodeAt(0) })         // GPSLatitudeRef
    entry(0x0002, 5, 3, o => v.setUint32(o, latAt, le))                                   // GPSLatitude
    entry(0x0003, 2, 2, o => { out[o] = (lon >= 0 ? 'E' : 'W').charCodeAt(0) })         // GPSLongitudeRef
    entry(0x0004, 5, 3, o => v.setUint32(o, lonAt, le))                                   // GPSLongitude
    entry(0x0005, 1, 1, o => { out[o] = alt < 0 ? 1 : 0 })                                // GPSAltitudeRef
    entry(0x0006, 5, 1, o => v.setUint32(o, altAt, le))                                   // GPSAltitude
    v.setUint32(2 + n * 12, 0, le)
    out.set(latData, dirSize); out.set(lonData, dirSize + latData.length); out.set(altData, dirSize + latData.length + lonData.length)
    return out
}

/** A copy of the JPEG with GPS position set (degrees, metres above sea level). */
export function withGps(jpeg: Uint8Array, lat: number, lon: number, alt: number): Uint8Array {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('No valid position for this photo')
    const segs = segments(jpeg)
    const old = exifSeg(jpeg, segs)
    let tiff: Uint8Array
    if (old) {
        const src = new Tiff(jpeg.subarray(old.data + 6, old.end))
        const le = src.le
        const base = src.b.length + (src.b.length & 1)              // keep word alignment
        const kept = src.entries(src.ifd0()).filter(e => e.tag !== 0x8825)
        const n = kept.length + 1
        const ifdSize = 2 + n * 12 + 4
        const gpsAt = base + ifdSize
        const gps = gpsIfd(gpsAt, lat, lon, alt, le)
        tiff = new Uint8Array(gpsAt + gps.length)
        tiff.set(src.b, 0)
        const v = new DataView(tiff.buffer)
        v.setUint16(base, n, le)
        const rows = [...kept.map(e => ({ tag: e.tag, bytes: src.b.subarray(e.at, e.at + 12) })), { tag: 0x8825, bytes: null as Uint8Array | null }]
            .sort((a, b) => a.tag - b.tag)
        rows.forEach((r, i) => {
            const o = base + 2 + i * 12
            if (r.bytes) tiff.set(r.bytes, o)
            else { v.setUint16(o, 0x8825, le); v.setUint16(o + 2, 4, le); v.setUint32(o + 4, 1, le); v.setUint32(o + 8, gpsAt, le) }
        })
        v.setUint32(base + 2 + n * 12, src.next(src.ifd0()), le)   // IFD1 (thumbnail) unchanged
        tiff.set(gps, gpsAt)
        v.setUint32(4, base, le)
    } else {
        const head = new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0])
        const ifdSize = 2 + 12 + 4
        const gpsAt = 8 + ifdSize
        const gps = gpsIfd(gpsAt, lat, lon, alt, true)
        tiff = new Uint8Array(gpsAt + gps.length)
        tiff.set(head, 0)
        const v = new DataView(tiff.buffer)
        v.setUint16(8, 1, true)
        v.setUint16(10, 0x8825, true); v.setUint16(12, 4, true); v.setUint32(14, 1, true); v.setUint32(18, gpsAt, true)
        v.setUint32(22, 0, true)
        tiff.set(gps, gpsAt)
    }
    const segLen = 2 + 6 + tiff.length
    if (segLen > 0xffff) throw new Error('The photo\'s existing metadata is too large to add GPS to')
    const app1 = new Uint8Array(2 + segLen)
    app1[0] = 0xff; app1[1] = 0xe1; app1[2] = segLen >> 8; app1[3] = segLen & 0xff
    app1.set(EXIF_ID, 4)
    app1.set(tiff, 10)
    let cutFrom: number, cutTo: number
    if (old) { cutFrom = old.start; cutTo = old.end }
    else {
        // After a leading JFIF APP0 if there is one, else straight after SOI.
        const first = segs[0]
        cutFrom = cutTo = first && first.marker === 0xe0 ? first.end : 2
    }
    const out = new Uint8Array(cutFrom + app1.length + (jpeg.length - cutTo))
    out.set(jpeg.subarray(0, cutFrom), 0)
    out.set(app1, cutFrom)
    out.set(jpeg.subarray(cutTo), cutFrom + app1.length)
    return out
}

// ── a plain zip (stored, no compression: JPEGs do not shrink) ────────────

const CRC = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
    return t
})()

export function crc32(b: Uint8Array): number {
    let c = 0xffffffff
    for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
}

/** Builds a stored zip from files added one by one. Keep each archive well
 *  under 4 GB (no zip64); GeoTag splits into parts of about 1 GB. */
export class ZipWriter {
    private parts: BlobPart[] = []
    private central: Uint8Array[] = []
    private offset = 0
    count = 0
    get size() { return this.offset }

    add(name: string, data: Uint8Array, when = new Date()) {
        const nameB = new TextEncoder().encode(name)
        const crc = crc32(data)
        const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1)
        const date = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()
        const local = new Uint8Array(30 + nameB.length)
        const lv = new DataView(local.buffer)
        lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true)
        lv.setUint16(10, time, true); lv.setUint16(12, date, true); lv.setUint32(14, crc, true)
        lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, nameB.length, true); lv.setUint16(28, 0, true)
        local.set(nameB, 30)
        const cen = new Uint8Array(46 + nameB.length)
        const cv = new DataView(cen.buffer)
        cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true)
        cv.setUint16(12, time, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true)
        cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, nameB.length, true)
        cv.setUint32(42, this.offset, true)
        cen.set(nameB, 46)
        this.parts.push(local as BlobPart, data as BlobPart)
        this.central.push(cen)
        this.offset += local.length + data.length
        this.count++
    }

    finish(): Blob {
        const cenSize = this.central.reduce((a, c) => a + c.length, 0)
        const end = new Uint8Array(22)
        const ev = new DataView(end.buffer)
        ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, this.count, true); ev.setUint16(10, this.count, true)
        ev.setUint32(12, cenSize, true); ev.setUint32(16, this.offset, true)
        return new Blob([...this.parts, ...(this.central as BlobPart[]), end as BlobPart], { type: 'application/zip' })
    }
}
