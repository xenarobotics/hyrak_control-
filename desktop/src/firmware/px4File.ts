// A .px4 firmware file: JSON written by PX4's px_mkfw.py. The flash image is
// zlib-compressed and base64-encoded in "image"; "board_id" says which board
// it was built for, and that must match what the bootloader reports.

import zlib from 'node:zlib'
import { padImage } from './protocol'

export interface Px4Firmware {
    boardId: number
    boardRevision: number
    /** Padded to a multiple of 4 bytes with 0xFF, ready to program. */
    image: Uint8Array
    imageSize: number
    imageMaxsize: number | null
    summary: string
    description: string
    version: string
    gitIdentity: string
    buildTime: number | null
}

export function parsePx4(text: string): Px4Firmware {
    let j: Record<string, unknown>
    try {
        j = JSON.parse(text)
    } catch {
        throw new Error('this is not a .px4 firmware file (it is not JSON)')
    }
    if (!j || typeof j !== 'object') throw new Error('this is not a .px4 firmware file')
    const boardId = j.board_id
    if (typeof boardId !== 'number' || !Number.isInteger(boardId)) {
        throw new Error('this .px4 file has no board_id, so it cannot be matched to a board')
    }
    if (typeof j.image !== 'string' || !j.image) throw new Error('this .px4 file has no firmware image')
    const summary = String(j.summary ?? '')
    const description = String(j.description ?? '')
    if (/bootloader/i.test(summary) || /bootloader/i.test(description)) {
        throw new Error('this file is a bootloader image, not flight firmware - it cannot be flashed from here')
    }
    let raw: Buffer
    try {
        raw = zlib.inflateSync(Buffer.from(j.image, 'base64'))
    } catch {
        throw new Error('the firmware image inside this .px4 file is damaged (it does not decompress)')
    }
    const imageSize = typeof j.image_size === 'number' ? j.image_size : raw.length
    if (imageSize !== raw.length) {
        throw new Error(`the firmware image is damaged: ${raw.length} bytes, but the file says ${imageSize}`)
    }
    if (raw.length === 0) throw new Error('the firmware image is empty')
    return {
        boardId,
        boardRevision: typeof j.board_revision === 'number' ? j.board_revision : 0,
        image: padImage(new Uint8Array(raw.buffer, raw.byteOffset, raw.length)),
        imageSize,
        imageMaxsize: typeof j.image_maxsize === 'number' ? j.image_maxsize : null,
        summary,
        description,
        version: String(j.version ?? ''),
        gitIdentity: String(j.git_identity ?? ''),
        buildTime: typeof j.build_time === 'number' ? j.build_time : null,
    }
}

/** Builds a .px4 file. Used by unit tests. */
export function buildPx4(opts: { boardId: number; image: Uint8Array; summary?: string; gitIdentity?: string; imageMaxsize?: number }): string {
    return JSON.stringify({
        magic: 'PX4FWv1',
        board_id: opts.boardId,
        board_revision: 0,
        summary: opts.summary ?? 'TEST',
        description: 'Firmware for a test board',
        version: '0.1',
        git_identity: opts.gitIdentity ?? 'v0.0.0-test',
        image_size: opts.image.length,
        image_maxsize: opts.imageMaxsize ?? 2064384,
        build_time: 0,
        image: zlib.deflateSync(Buffer.from(opts.image)).toString('base64'),
    })
}
