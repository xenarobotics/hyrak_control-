// Keeps a <video> playing a LIVE progressive stream pinned near its newest
// frame instead of drifting a fixed distance behind it.
//
// The problem this solves is the single largest term in the RTSP preview's
// glass-to-glass budget. Chromium buffers generously when it starts a
// progressive stream - a few hundred milliseconds of decoded video sit
// between what ffmpeg has already delivered and what the element is showing.
// For a recorded file that buffer is invisible. For a live camera it is
// permanent delay, and it never drains on its own, because frames arrive at
// exactly the rate they are consumed: whatever backlog exists at startup is
// the backlog forever.
//
// The obvious fix - seek to buffered.end() - is the wrong one here. A seek on
// a progressive live stream makes Chromium issue a Range request, and the
// loopback preview server serves one endless response with no Content-Length
// and no Range support, so the seek kills the stream outright.
//
// So drain instead of jump: run playback slightly fast until the backlog is
// spent, then return to 1.0x. The speed-up is imperceptible at these rates
// and self-terminating - once drift is at target the rate goes back to normal
// and stays there.

// STARTING point for how far behind the newest buffered frame to sit; the
// controller raises it on a real stall (see `target` below).
//
// Briefly lowered to 0.05 and reverted: it is below what Chromium needs to
// play without underrunning, so the controller could never reach it and hunted
// permanently - measured as drift swinging 128-444ms and reported as the
// picture feeling WORSE. Zero is ideal and unstable for the same reason.
const TARGET_DRIFT_S = 0.1

// Playing faster than this is visible as sped-up motion, and - more
// importantly - outruns the producer and forces an underrun. Lowered 1.5 ->
// 1.15: the source delivers at exactly 1.0x, so any sustained rate above it
// must eventually starve the buffer. 1.15x still drains a 400ms backlog in
// ~2.7s, which is fast enough for a startup transient and slow enough never
// to overshoot.
const MAX_CATCHUP_RATE = 1.15

// Pathological backlog - a backgrounded tab whose rAF/decode was throttled,
// or a decoder that stalled and resumed. Draining tens of seconds at 1.5x
// would take minutes, so allow a harder catch-up. Still no seek: a fast,
// ugly recovery beats a dead stream.
const LARGE_DRIFT_S = 2
const MAX_RECOVERY_RATE = 4

// 150ms, ~3x faster than fragments arrive at 20fps. Note this alone did NOT
// fix the swinging - the oscillation was the controller's own feedback loop,
// not a sampling-rate problem. Kept because the windowed minimum below needs
// several samples per second to be meaningful.
const POLL_MS = 150

let lastDriftMs = 0

/** Drift measured at the most recent poll, in ms. Diagnostic only - this is
 *  the number to watch when tuning the preview pipeline, since it isolates
 *  the browser's contribution from ffmpeg's and the camera's. */
export function getLiveEdgeDriftMs(): number {
    return lastDriftMs
}

// Readable from the DevTools console as `__hyrakLiveEdge()`. Without this the
// function above is unreachable at runtime, which makes it not a diagnostic
// at all: the whole point is to answer "is the remaining delay in the browser
// or upstream of it?" from a live stream, and that question can't wait for a
// UI to be built around it. A low number here (~100ms) with a high
// glass-to-glass delay means the delay is NOT ours - look at the RTSP hop.
if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__hyrakLiveEdge = getLiveEdgeDriftMs
}

/** Starts clamping `el` to the live edge. Returns a stop function; call it
 *  when the element is torn down or its source changes. */
export function clampToLiveEdge(el: HTMLVideoElement): () => void {
    // Rolling window of recent drift samples. Correcting on the INSTANTANEOUS
    // value was the defect: measured drift swings 128-444ms on a producer that
    // is provably smooth (p50 50ms, p99 58ms at 20fps), because the swing is
    // this controller's own doing. Raise the rate, the buffer drains faster
    // than it fills, the element underruns and stalls, the buffer rebuilds,
    // drift jumps - a sawtooth the controller drives itself.
    //
    // The MINIMUM over a window is the honest measure of standing backlog:
    // transient spikes are delivery jitter and must not be drained, but a
    // floor that stays high is real, permanent delay. Draining only the excess
    // above that floor removes the feedback loop entirely.
    const window_: number[] = []
    const WINDOW = 12                       // ~1.8s at POLL_MS

    // Adaptive target. There is a minimum buffer Chromium needs to play
    // without underrunning, it differs per machine and codec, and targeting
    // below it guarantees permanent hunting. So: start at TARGET_DRIFT_S and
    // raise the floor whenever the element actually stalls. Self-tuning beats
    // a constant that is wrong on somebody else's hardware.
    let target = TARGET_DRIFT_S
    const onStall = () => {
        target = Math.min(target + 0.05, 0.4)
        el.playbackRate = 1
    }
    el.addEventListener('waiting', onStall)
    el.addEventListener('stalled', onStall)

    const timer = window.setInterval(() => {
        const ranges = el.buffered
        if (!ranges.length || el.paused || el.readyState < 2) return

        const drift = ranges.end(ranges.length - 1) - el.currentTime
        lastDriftMs = Math.round(drift * 1000)

        window_.push(drift)
        if (window_.length > WINDOW) window_.shift()
        // Not enough history yet - do nothing rather than react to noise.
        if (window_.length < WINDOW) return

        const floor = Math.min(...window_)
        const excess = floor - target
        if (excess <= 0.02) {
            if (el.playbackRate !== 1) el.playbackRate = 1
            return
        }
        // Gentle and bounded. 1.5x drains 400ms in 800ms but is visible as
        // sped-up motion and overshoots into an underrun; 1.15x drains the
        // same backlog in ~2.7s without ever outrunning the producer. A live
        // view that is smooth at 150ms beats one that stutters at 80ms.
        const cap = floor > LARGE_DRIFT_S ? MAX_RECOVERY_RATE : MAX_CATCHUP_RATE
        el.playbackRate = Math.min(cap, 1 + Math.min(excess, 0.15))
    }, POLL_MS)

    return () => {
        clearInterval(timer)
        el.removeEventListener('waiting', onStall)
        el.removeEventListener('stalled', onStall)
        try { el.playbackRate = 1 } catch { /* element already gone */ }
    }
}
