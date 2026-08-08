// Annex-B access-unit framing, shared by every bridge that feeds WebCodecs.
//
// A pipe does not preserve buffer boundaries: `alignment=au` means each WRITE
// from GStreamer (or ffmpeg) is one access unit, but reads coalesce and split
// arbitrarily. So the boundaries have to be recovered from the bitstream
// itself, which is what this file does.
//
// Extracted from gstreamerBridge when receiverBridge needed the same framing
// for H.265. The H.264 rules are unchanged from the shipped version; H.265 is
// new, and needs genuinely different rules rather than a wider type mask —
// see splitAnnexB.
//
// Wire format handed to the renderer (components/video/WebCodecsVideo.tsx):
//
//   [uint32 length][uint8 keyframe][uint32 sequence][Annex-B access unit]

export type AnnexBCodec = 'h264' | 'hevc'

export const AU_HEADER_BYTES = 9   // 4 length + 1 flags + 4 sequence

export interface AccessUnit {
    data: Buffer
    key: boolean
}

interface Mark {
    at: number          // offset of the start code
    skip: number        // 3 or 4 byte start code
    type: number        // NAL unit type, already codec-decoded
    firstSlice: boolean // H.265 only: first_slice_segment_in_pic_flag
}

/** Locates every NAL start code and decodes the unit type that follows it. */
function scan(buf: Buffer, codec: AnnexBCodec): Mark[] {
    const marks: Mark[] = []
    for (let i = 0; i + 3 < buf.length; i++) {
        if (buf[i] !== 0 || buf[i + 1] !== 0) continue
        let skip = 0
        if (buf[i + 2] === 1) skip = 3
        else if (buf[i + 2] === 0 && buf[i + 3] === 1) skip = 4
        else continue
        const b0 = buf[i + skip]
        if (b0 === undefined) break
        if (codec === 'h264') {
            // first_mb_in_slice is the first ue(v) of the slice header, one
            // byte past the NAL header. ue(v)==0 is encoded as a single set
            // bit, so a leading 1 bit means "this slice starts a picture" —
            // the H.264 equivalent of H.265's
            // first_slice_segment_in_pic_flag, and just as necessary.
            const b1 = buf[i + skip + 1]
            marks.push({
                at: i, skip, type: b0 & 0x1f,
                firstSlice: b1 !== undefined && (b1 & 0x80) !== 0,
            })
        } else {
            // H.265 has a TWO byte NAL header: forbidden_zero(1),
            // nal_unit_type(6), nuh_layer_id(6), nuh_temporal_id_plus1(3).
            const type = (b0 >> 1) & 0x3f
            // first_slice_segment_in_pic_flag is the very first bit of the
            // slice segment header, which follows both header bytes.
            const b2 = buf[i + skip + 2]
            marks.push({
                at: i, skip, type,
                firstSlice: b2 !== undefined && (b2 & 0x80) !== 0,
            })
        }
        i += skip - 1
    }
    return marks
}

// H.264: 1 = non-IDR slice, 5 = IDR slice, 7 = SPS, 8 = PPS, 9 = AUD.
//
// A keyframe is an AU containing an IDR SLICE — nothing else. This used to
// also count SPS (7), and an earlier version of the AU-boundary rule counted
// the access-unit delimiter (9) too, which was catastrophic against an
// encoder that emits an AUD before every frame: openh264 does, so all 180
// delta frames in a 6-second capture were flagged as keyframes. WebCodecs is
// then handed delta frames declared `type: 'key'` and answers with
// "Decoding error" and a black pane. Parameter sets and delimiters describe
// the picture that follows; they do not make it a random-access point.
const h264IsVcl = (t: number) => t === 1 || t === 5
const h264IsKey = (t: number) => t === 5

// H.265: VCL is 0-31. IRAP (any random-access point, so any usable start
// frame) is 16-23. Parameter sets are VPS 32, SPS 33, PPS 34; AUD is 35.
// Same rule as H.264: only an IRAP *slice* makes the AU a keyframe.
const hevcIsVcl = (t: number) => t < 32
const hevcIsIrap = (t: number) => t >= 16 && t <= 23
const hevcIsParamSet = (t: number) => t >= 32 && t <= 34

/** Splits a rolling Annex-B buffer into complete access units, returning
 *  whatever tail could not yet be closed.
 *
 *  The two codecs need different rules, not a shared one with a wider mask:
 *
 *  H.264 has no picture-start marker in the NAL header, but it does have one
 *  in the slice header: first_mb_in_slice == 0. A VCL NAL closes the previous
 *  access unit only when it carries that, so the slices of one multi-slice
 *  frame stay together. Parameter sets and SEI belong to the picture that
 *  FOLLOWS them and so must not close the current unit.
 *
 *  H.265 does carry the marker: first_slice_segment_in_pic_flag is set on the
 *  first slice of every picture. That is authoritative, and it matters here
 *  because 1080p H.265 from the air unit is routinely multi-slice — inferring
 *  boundaries the H.264 way would cut a picture into as many "access units" as
 *  it has slices, and a decoder handed those emits nothing. */
export function splitAnnexB(
    buf: Buffer,
    codec: AnnexBCodec = 'h264',
): { units: AccessUnit[]; rest: Buffer } {
    const marks = scan(buf, codec)
    if (marks.length < 2) return { units: [], rest: buf }

    const units: AccessUnit[] = []
    let auStart = -1
    let sawVcl = false
    let auKey = false
    let consumed = 0

    const close = (at: number) => {
        units.push({ data: buf.subarray(auStart, at), key: auKey })
        consumed = at
        auStart = at
    }

    for (const m of marks) {
        const isVcl = codec === 'h264' ? h264IsVcl(m.type) : hevcIsVcl(m.type)
        const isKeyNal = codec === 'h264' ? h264IsKey(m.type) : hevcIsIrap(m.type)

        if (auStart < 0) {
            auStart = m.at
            sawVcl = isVcl
            auKey = isKeyNal
            continue
        }

        if (codec === 'hevc') {
            // Authoritative boundary: the first slice of the next picture.
            if (isVcl && m.firstSlice && sawVcl) {
                close(m.at)
                sawVcl = true
                auKey = hevcIsIrap(m.type)
                continue
            }
            // A parameter set after a finished picture opens the next one —
            // this is how a keyframe with its VPS/SPS/PPS stays one unit. The
            // new AU is NOT marked key here; the IRAP slice that follows does
            // that, and marking it up front would flag any AU that merely
            // carried repeated parameter sets.
            if (hevcIsParamSet(m.type) && sawVcl) {
                close(m.at)
                sawVcl = false
                auKey = false
                continue
            }
            if (isVcl) sawVcl = true
            if (isKeyNal) auKey = true
            continue
        }

        // A VCL NAL after we already have one starts the NEXT picture — but
        // ONLY if it is the first slice of that picture. Without the
        // first_mb_in_slice check every slice of a multi-slice frame became
        // its own "access unit", so a decoder received fragments and emitted
        // nothing. Encoders slice by default whenever they thread (openh264's
        // slice-mode=auto is one slice per core), so this is the common case,
        // not an exotic one.
        if (isVcl && m.firstSlice && sawVcl) {
            close(m.at)
            sawVcl = true
            auKey = m.type === 5
            continue
        }
        // Parameter sets and access-unit delimiters after a complete picture
        // also open the next one — without marking it key, for the reason
        // given at h264IsKey.
        if ((m.type === 7 || m.type === 9) && sawVcl) {
            close(m.at)
            sawVcl = false
            auKey = false
            continue
        }
        if (isVcl) sawVcl = true
        if (isKeyNal) auKey = true
    }

    return { units, rest: buf.subarray(consumed) }
}

/** [uint32 length][uint8 flags][uint32 sequence] then the Annex-B bytes.
 *
 *  Sequence rather than a real PTS: WebCodecs only requires timestamps be
 *  monotonic, frames are painted the moment they decode, and carrying the
 *  pipeline's clock through a pipe would buy nothing a counter does not. */
export function frameAu(data: Buffer, key: boolean, seq: number): Buffer {
    const head = Buffer.allocUnsafe(AU_HEADER_BYTES)
    head.writeUInt32BE(data.length, 0)
    head.writeUInt8(key ? 1 : 0, 4)
    head.writeUInt32BE(seq >>> 0, 5)
    return Buffer.concat([head, data])
}
