// Builds the RFC 6381 codec strings WebCodecs needs, by reading the stream's
// own parameter sets.
//
// Hardcoding a codec string is tempting and wrong. VideoDecoder.configure()
// rejects a mismatch outright, and the profile and level depend on the
// encoder, the GPU and the resolution - so a hardcoded value fails on exactly
// the machines we cannot test, which for this app is most of them. Reading it
// from the bitstream always matches whatever actually arrived.

/** Strips H.26x emulation-prevention bytes (00 00 03 -> 00 00) so fixed
 *  offsets into the RBSP mean what the spec says they mean. Only the first
 *  `limit` output bytes are produced; every field read here is near the start
 *  of the parameter set. */
function rbsp(buf: Uint8Array, start: number, limit: number): Uint8Array {
    const out = new Uint8Array(limit)
    let n = 0
    let zeros = 0
    for (let i = start; i < buf.length && n < limit; i++) {
        const b = buf[i]
        if (zeros >= 2 && b === 0x03) { zeros = 0; continue }
        out[n++] = b
        zeros = b === 0 ? zeros + 1 : 0
    }
    return out.subarray(0, n)
}

/** Offsets of every Annex-B start code in `au`, with the byte that follows. */
function* nals(au: Uint8Array): Generator<{ at: number; head: number }> {
    for (let i = 0; i + 3 < au.length; i++) {
        if (au[i] !== 0 || au[i + 1] !== 0) continue
        const skip = au[i + 2] === 1 ? 3 : (au[i + 2] === 0 && au[i + 3] === 1 ? 4 : 0)
        if (!skip) continue
        yield { at: i + skip, head: au[i + skip] }
        i += skip - 1
    }
}

const hex = (n: number) => n.toString(16).padStart(2, '0')

/** `avc1.PPCCLL` from an H.264 SPS. */
export function h264CodecString(au: Uint8Array): string | null {
    for (const { at, head } of nals(au)) {
        if ((head & 0x1f) !== 7) continue            // not SPS
        const r = rbsp(au, at + 1, 3)
        if (r.length < 3) return null
        return `avc1.${hex(r[0])}${hex(r[1])}${hex(r[2])}`
    }
    return null
}

/** `hvc1.A.B.C.D` from an H.265 SPS, per ISO/IEC 14496-15 annex E.
 *
 *  The layout is byte-aligned once the two-byte NAL header and the first RBSP
 *  byte are skipped, so no bit reader is needed:
 *
 *    rbsp[0]      sps_video_parameter_set_id(4) max_sub_layers_minus1(3)
 *                 temporal_id_nesting(1)
 *    rbsp[1]      general_profile_space(2) general_tier_flag(1)
 *                 general_profile_idc(5)
 *    rbsp[2..5]   general_profile_compatibility_flag[32]
 *    rbsp[6..11]  constraint flags
 *    rbsp[12]     general_level_idc
 */
export function hevcCodecString(au: Uint8Array): string | null {
    for (const { at, head } of nals(au)) {
        if (((head >> 1) & 0x3f) !== 33) continue    // not SPS
        const r = rbsp(au, at + 2, 13)
        if (r.length < 13) return null

        const profileSpace = (r[1] >> 6) & 0x3
        const tier = (r[1] >> 5) & 0x1
        const profileIdc = r[1] & 0x1f

        // The 32 compatibility flags are written as a hex number in REVERSED
        // bit order. Getting this backwards yields a plausible-looking string
        // that configure() rejects, so it is worth being explicit.
        let compat = 0
        for (let i = 0; i < 4; i++) {
            for (let b = 0; b < 8; b++) {
                if (r[2 + i] & (0x80 >> b)) compat |= 1 << (i * 8 + b)
            }
        }

        // Constraint bytes, trailing zero bytes omitted.
        const constraints: string[] = []
        for (let i = 11; i >= 6; i--) {
            if (r[i] !== 0 || constraints.length) constraints.unshift(hex(r[i]))
        }

        const space = profileSpace === 0 ? '' : String.fromCharCode(64 + profileSpace)
        return [
            'hvc1',
            `${space}${profileIdc}`,
            (compat >>> 0).toString(16),
            `${tier ? 'H' : 'L'}${r[12]}`,
            ...(constraints.length ? [constraints.join('.')] : []),
        ].join('.')
    }
    return null
}

export function codecString(au: Uint8Array, codec: 'h264' | 'hevc'): string | null {
    return codec === 'hevc' ? hevcCodecString(au) : h264CodecString(au)
}

/** Can Chromium on THIS machine decode H.265?
 *
 *  Asked at run time and never inferred from the platform. Chromium's HEVC
 *  support is gated on the OS, the GPU and the build, and the answer decides
 *  whether the receiver can pass H.265 straight through or has to transcode it
 *  to H.264 first - a difference of roughly a whole CPU core at 1080p30.
 *
 *  Several candidate strings because a decoder may accept Main but not Main10,
 *  or advertise a level ceiling: one `false` proves nothing on its own. */
export async function canDecodeHevc(): Promise<boolean> {
    if (typeof window === 'undefined' || !('VideoDecoder' in window)) return false
    const candidates = [
        'hvc1.1.6.L93.B0',    // Main, level 3.1 - 1080p30 lives here
        'hvc1.1.6.L120.B0',   // Main, level 4.0
        'hev1.1.6.L93.B0',
        'hvc1.1.6.L153.B0',   // Main, level 5.1 - 4K
    ]
    for (const codec of candidates) {
        // 'no-preference' as well as 'prefer-hardware', and that is not
        // belt-and-braces. Measured on Electron 32 / Chromium 128: without the
        // platform-decoder switches (see desktop/src/app-main.ts) even H.264
        // reports false for 'prefer-hardware' while 'no-preference' reports
        // true. Probing only the strict form would reject a codec Chromium can
        // decode perfectly well.
        //
        // Accepting a SOFTWARE HEVC decoder here is deliberate too: passing
        // H.265 through to a software decoder in Chromium still beats
        // transcoding it, which costs a decode AND an encode.
        for (const hardwareAcceleration of ['prefer-hardware', 'no-preference'] as const) {
            try {
                const r = await VideoDecoder.isConfigSupported({ codec, hardwareAcceleration })
                if (r.supported) return true
            } catch { /* malformed for this build; try the next */ }
        }
    }
    return false
}
