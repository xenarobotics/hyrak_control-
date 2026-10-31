'use client'

// Frame-accurate client overlay.
//
// In overlay mode the <video> shows the LOCAL camera live, while each
// cv_results payload describes a frame that left the browser a while ago:
// encode + uplink + server decode + inference + the socket back. Measured on
// the preview (barcoded pan clip, 30 fps): results land ~100 ms after their
// frame with the analyser keeping up, 150-190 ms under load, plus up to one
// result interval when analysis runs slower than the camera. The old overlay
// drew each result on whatever frame was on screen when it landed and then
// eased towards it, so a moving object's box was painted where it USED to be:
// ~180 ms behind on average, 300 ms+ at p90.
//
// The fix puts results back on the frames they were computed on:
//
//   1. The server echoes the analysed frame's pts (in cv_results). aiortc
//      rebases RTP timestamps to start at 0 on the first packet it receives,
//      so pts is the RTP timestamp minus an origin only the server knows; the
//      browser recovers that origin exactly, since pts + origin must equal
//      one of the RTP timestamps it actually sent.
//   2. An RTCRtpScriptTransform on the video sender reports each encoded
//      frame's RTP timestamp as it leaves. Paired with the capture timestamps
//      of the local frames that gives a fixed RTP -> capture offset (see
//      settle()), so a result's pts names the exact local frame it describes.
//   3. The AI views play the local camera through a short buffer, delayed by
//      the measured result latency plus one result interval, so that for the
//      frame on screen the results either side of it have already arrived.
//   4. The overlay draws each box interpolated between those two results.
//
// Measured after: boxes within a frame of the picture (mean ~17 ms) with the
// picture ~150 ms behind live. Nothing is extrapolated: a box is only ever
// drawn between two places the detector reported. The delay is capped at
// MAX_DELAY_MS and applies to the AI views only; the raw view, flight video
// and copilot stay live, and without the browser APIs or a pts everything
// falls back to the previous behaviour. Settings > "Keep AI boxes on the
// video" turns it off.

const SYNC_KEY = 'hyrak-overlay-sync'
export const OVERLAY_SYNC_EVENT = 'hyrak-overlay-sync-change'

/** A delay longer than this is not worth the stale picture; boxes then trail
 *  by the remainder instead. */
const MAX_DELAY_MS = 600

export function getOverlaySync(): boolean {
    if (typeof window === 'undefined') return true
    try { return localStorage.getItem(SYNC_KEY) !== 'false' } catch { return true }
}

export function setOverlaySync(v: boolean): void {
    try { localStorage.setItem(SYNC_KEY, String(v)) } catch { /* not critical */ }
    window.dispatchEvent(new CustomEvent(OVERLAY_SYNC_EVENT, { detail: v }))
}

type ProcessorCtor = new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> }
type GeneratorCtor = new (o: { kind: 'video' }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> }
type ScriptTransformCtor = new (worker: Worker, options?: unknown) => unknown

function apis() {
    const g = globalThis as unknown as {
        MediaStreamTrackProcessor?: ProcessorCtor
        MediaStreamTrackGenerator?: GeneratorCtor
        RTCRtpScriptTransform?: ScriptTransformCtor
    }
    return g.MediaStreamTrackProcessor && g.MediaStreamTrackGenerator && g.RTCRtpScriptTransform ? g : null
}

/** Whether this browser can run the synced overlay at all. */
export function frameSyncSupported(): boolean {
    return typeof window !== 'undefined' && apis() !== null
}

function wrapDiff(a: number, b: number): number {
    // Signed difference of two uint32 RTP timestamps.
    return ((((a - b) >>> 0) + 0x80000000) >>> 0) - 0x80000000
}

function quantile(xs: number[], q: number): number {
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}

// ── RTP timestamp -> local capture timestamp ───────────────────────────────

// Runs in the encoder's transform worker: report each outgoing frame's RTP
// timestamp, pass the frame on untouched.
const WORKER_SRC = `self.onrtctransform = e => {
  const t = e.transformer
  t.readable.pipeThrough(new TransformStream({ transform(f, c) {
    let r; try { r = f.getMetadata().rtpTimestamp } catch (_) {}
    if (r === undefined) r = f.timestamp
    self.postMessage({ rtp: r >>> 0, at: performance.timeOrigin + performance.now() })
    c.enqueue(f)
  } })).pipeTo(t.writable)
}`

interface Read { ts: number; at: number }

class FrameClock {
    private worker: Worker | null = null
    // Unwrapped RTP timeline in ms, advanced on every outgoing frame.
    private lastRtp: number | null = null
    private lastRel = 0
    // Capture timestamps (ms, VideoFrame clock) and when each was read here.
    private reads: Read[] = []
    // rel(rtp) - capture ts once the pairing is settled.
    private offset: number | null = null
    // Latency of each result (arrival - read time of its frame) and the gap
    // between results, which together set the picture delay.
    private lags: number[] = []
    private gaps: number[] = []
    private lastResultAt = 0
    private delay = 0
    // RTP timestamps recently sent, and the server's pts origin once agreed.
    private sent: number[] = []
    // Each sent frame (rel ms on the RTP timeline) with the capture
    // timestamps of the newest four frames read before it left.
    private left: { rel: number; cands: number[] }[] = []
    private sinceSettle = 0
    private origin: number | null = null
    private votes = new Map<number, number>()
    private misses = 0

    tagSender(sender: RTCRtpSender): void {
        const a = apis()
        if (!a || !getOverlaySync()) return
        try {
            if (!this.worker) {
                this.worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })))
                this.worker.onmessage = (e: MessageEvent<{ rtp: number; at: number }>) =>
                    this.emerged(e.data.rtp, e.data.at - performance.timeOrigin)
            }
            ;(sender as unknown as { transform: unknown }).transform = new a.RTCRtpScriptTransform!(this.worker)
        } catch (e) {
            console.warn('Overlay sync unavailable (sender transform):', e)
        }
    }

    noteRead(ts: number, at: number): void {
        this.reads.push({ ts, at })
        if (this.reads.length > 120) this.reads.shift()
    }

    private rel(rtp: number): number | null {
        return this.lastRtp === null ? null : this.lastRel + wrapDiff(rtp, this.lastRtp) / 90
    }

    private emerged(rtp: number, at: number): void {
        this.lastRel = this.rel(rtp) ?? 0
        this.lastRtp = rtp
        this.sent.push(rtp)
        if (this.sent.length > 300) this.sent.shift()
        // Which local frame is this? One read before it left: the newest,
        // or older when the encoder took longer than a frame period. Keep
        // the candidates; offset() decides between them.
        const i = this.reads.findLastIndex(r => r.at <= at)
        if (i >= 0) {
            this.left.push({ rel: this.lastRel, cands: [0, 1, 2, 3].map(m => this.reads[i - m]?.ts ?? NaN) })
            if (this.left.length > 120) this.left.shift()
            if (this.left.length >= 15 && ++this.sinceSettle >= 15) { this.sinceSettle = 0; this.offset = this.settle() }
        }
    }

    /** RTP time minus capture time is the same for every frame - but only
     *  under the right pairing. Paired a frame off, it picks up the jitter
     *  between frame intervals (~1 ms on a camera, never zero). So the right
     *  pairing is the one with the tightest spread. Timing alone cannot
     *  decide this: a slow software encoder takes about a frame period, and
     *  "newest read before it left" is then wrong half the time. */
    private settle(): number | null {
        let best: number | null = null, bestSpread = Infinity
        for (let m = 0; m < 4; m++) {
            const o = this.left.map(e => e.rel - e.cands[m]).filter(x => Number.isFinite(x))
            if (o.length < 10) continue
            const mid = quantile(o, 0.5)
            const spread = quantile(o.map(x => Math.abs(x - mid)), 0.5)
            if (spread < bestSpread) { bestSpread = spread; best = mid }
        }
        return best
    }

    /** Capture timestamp (ms, VideoFrame clock) of the frame a result's pts
     *  describes, or null while the mapping is not established. */
    frameTs(pts: number): number | null {
        const rtp = this.toRtp(pts)
        if (rtp === null) return null
        const r = this.rel(rtp)
        return r === null || this.offset === null ? null : r - this.offset
    }

    /** The RTP timestamp a server pts stands for. The origin is the value
     *  every result agrees on; a renegotiated stream gets a new one. */
    private toRtp(pts: number): number | null {
        const p = pts % 0x100000000
        if (this.origin !== null) {
            const rtp = (this.origin + p) >>> 0
            if (this.sent.includes(rtp)) { this.misses = 0; return rtp }
            if (++this.misses < 10) return rtp
            this.origin = null
            this.votes.clear()
        }
        for (const s of this.sent.slice(-150)) {
            const o = (s - p) >>> 0
            this.votes.set(o, (this.votes.get(o) ?? 0) + 1)
        }
        let best = 0, bestN = 0
        for (const [o, n] of this.votes) if (n > bestN) { best = o; bestN = n }
        if (bestN >= 5) { this.origin = best; this.votes.clear(); this.misses = 0 }
        if (this.votes.size > 20000) this.votes.clear()
        return null
    }

    /** Record a result's arrival against its frame, for the delay estimate. */
    noteResult(frameTs: number): void {
        const now = performance.now()
        const read = this.reads.find(r => Math.abs(r.ts - frameTs) < 2)
        if (read) {
            this.lags.push(now - read.at)
            if (this.lags.length > 90) this.lags.shift()
        }
        if (this.lastResultAt) {
            this.gaps.push(now - this.lastResultAt)
            if (this.gaps.length > 90) this.gaps.shift()
        }
        this.lastResultAt = now
        if (this.lags.length >= 8) {
            const want = quantile(this.lags, 0.9) + quantile(this.gaps, 0.5) + 8
            this.delay = Math.min(MAX_DELAY_MS, Math.max(0, want))
        }
    }

    ready(): boolean { return this.offset !== null }
    delayMs(): number { return this.delay }

    reset(): void {
        this.lastRtp = null
        this.reads = []
        this.offset = null
        this.lags = []
        this.gaps = []
        this.lastResultAt = 0
        this.delay = 0
        this.sent = []
        this.left = []
        this.sinceSettle = 0
        this.origin = null
        this.votes.clear()
        this.misses = 0
    }
}

export const frameClock = new FrameClock()

// ── Delayed local picture ──────────────────────────────────────────────────

// A delayed frame is held as a copy of its pixels, never as the camera's own
// VideoFrame: the capturer has a small pool of buffers, and holding ~18 of
// them for 600 ms starves it - measured, the camera fell from 30 to ~3 fps,
// which also slowed what was sent for analysis. Only an opaque GPU frame (no
// readable format) is held as is.
interface Buffered { pixels: Uint8Array | null; init: VideoFrameBufferInit | null; frame: VideoFrame | null; ts: number; at: number }

function release(b: Buffered): void { b.frame?.close() }
function materialise(b: Buffered): VideoFrame {
    return b.frame ?? new VideoFrame(b.pixels!, b.init!)
}

class DelayedVideo {
    readonly stream: MediaStream
    /** Capture timestamp (ms) of the frame on screen now. */
    shownTs: number | null = null
    users = 0
    private queue: Buffered[] = []
    private timer: ReturnType<typeof setTimeout> | null = null
    private applied = 0
    private closed = false
    private writer: WritableStreamDefaultWriter<VideoFrame>
    private source: MediaStreamTrack

    constructor(track: MediaStreamTrack) {
        const a = apis()!
        this.source = track.clone()
        const gen = new a.MediaStreamTrackGenerator!({ kind: 'video' })
        this.writer = gen.writable.getWriter()
        this.stream = new MediaStream([gen])
        void this.read(new a.MediaStreamTrackProcessor!({ track: this.source }).readable.getReader())
    }

    private async read(reader: ReadableStreamDefaultReader<VideoFrame>): Promise<void> {
        while (!this.closed) {
            const { value, done } = await reader.read()
            if (done || !value) break
            const at = performance.now()
            const ts = value.timestamp / 1000
            frameClock.noteRead(ts, at)
            let b: Buffered = { pixels: null, init: null, frame: value, ts, at }
            if (value.format) {
                try {
                    const pixels = new Uint8Array(value.allocationSize())
                    const layout = await value.copyTo(pixels)
                    b = { pixels, frame: null, ts, at, init: {
                        format: value.format, codedWidth: value.codedWidth, codedHeight: value.codedHeight,
                        timestamp: value.timestamp, layout, displayWidth: value.displayWidth, displayHeight: value.displayHeight,
                        colorSpace: value.colorSpace.toJSON(),
                    } }
                    value.close()
                } catch { /* keep the frame itself */ }
            }
            this.queue.push(b)
            // Never hold more than ~1 s of frames, whatever the delay says.
            while (this.queue.length > 40) release(this.queue.shift()!)
            this.pump()
        }
        reader.releaseLock()
    }

    private pump = (): void => {
        if (this.closed) return
        if (this.timer) { clearTimeout(this.timer); this.timer = null }
        // Ease towards the wanted delay a little per frame, so a change in
        // the estimate never shows as a stutter or a jump.
        const want = frameClock.delayMs()
        this.applied += Math.max(-3, Math.min(3, want - this.applied))
        const now = performance.now()
        let due: Buffered | null = null
        while (this.queue.length && this.queue[0].at + this.applied <= now) {
            if (due) release(due)
            due = this.queue.shift()!
        }
        if (due) {
            this.shownTs = due.ts
            const f = materialise(due)
            this.writer.write(f).catch(() => f.close())
        }
        if (this.queue.length) {
            this.timer = setTimeout(this.pump, Math.max(1, this.queue[0].at + this.applied - now))
        }
    }

    close(): void {
        this.closed = true
        if (this.timer) clearTimeout(this.timer)
        for (const b of this.queue) release(b)
        this.queue = []
        this.source.stop()
        void this.writer.close().catch(() => {})
    }
}

let delayed: { trackId: string; v: DelayedVideo } | null = null

/** The delayed picture for this local stream, shared by every AI view that
 *  shows it. Pair with releaseDelayedStream. Null when unsupported or off. */
export function acquireDelayedStream(local: MediaStream): MediaStream | null {
    const track = local.getVideoTracks()[0]
    if (!track || !frameSyncSupported() || !getOverlaySync()) return null
    if (!delayed || delayed.trackId !== track.id) {
        delayed?.v.close()
        delayed = { trackId: track.id, v: new DelayedVideo(track) }
    }
    delayed.v.users += 1
    return delayed.v.stream
}

export function releaseDelayedStream(local: MediaStream): void {
    const track = local.getVideoTracks()[0]
    if (!delayed || !track || delayed.trackId !== track.id) return
    delayed.v.users -= 1
    if (delayed.v.users <= 0) { delayed.v.close(); delayed = null }
}

// The frame the <video> actually presented (requestVideoFrameCallback's
// mediaTime is the timestamp of our own VideoFrame), which runs a frame or
// more behind the one last handed to the generator.
let presented: { ts: number; at: number } | null = null

/** Called by the AI view for every frame its <video> presents. */
export function notePresented(mediaTimeS: number): void {
    presented = { ts: mediaTimeS * 1000, at: performance.now() }
}

/** Capture timestamp of the frame the synced AI view is showing, or null when
 *  no synced picture is on screen (the overlay then draws as before). */
export function shownFrameTs(): number | null {
    if (!delayed || !frameClock.ready()) return null
    if (presented && performance.now() - presented.at < 250) return presented.ts
    return delayed.v.shownTs
}
