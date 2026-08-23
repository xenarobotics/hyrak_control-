// Temporal smoothing for client-drawn AI overlays.
//
// The problem this solves is not network loss - it is that inference is a
// SAMPLED signal being drawn as if it were continuous. cv_results arrives at
// the analyzer's rate (~10-15Hz) while the video runs at 20-30fps, and the
// canvas previously redrew only when a payload landed, clearing first. Two
// artefacts follow, and the operator reads both as "the app is glitching":
//
//   * BLANKING. One payload where a detection falls under the confidence
//     threshold - a person turning, a plate glaring, a partial occlusion -
//     removes the box completely for one interval. Detectors are stochastic
//     frame to frame; a UI that mirrors that literally will strobe.
//   * TELEPORTING. Boxes jump between inference results instead of moving,
//     because nothing renders between them.
//
// So: keep a short-lived track per object, interpolate its box continuously,
// and fade rather than cut. A box that genuinely leaves the frame still
// disappears - just over ~250ms instead of instantly, which reads as the
// object leaving rather than the software failing.
//
// Deliberately client-side only. The server keeps emitting exactly what it
// detected, unsmoothed and unembellished - this must never invent a detection
// that inference did not produce, only hold and move ones it did. Anything
// else would put fiction in front of a pilot.

export type Box = [number, number, number, number]

export interface RawItem {
    box: Box
    /** Stable identity when the module has one (tracker id, plate text). */
    id?: number | string
    /** Class/label, used to constrain IoU matching when there is no id. */
    name?: string
    [k: string]: unknown
}

/** A raw item plus the fields the renderer needs. `box` is interpolated. */
export interface SmoothedItem extends RawItem {
    /** 0..1 - fade in on appearance, out on disappearance. */
    _a: number
}

// How long a track survives with no confirming detection before it starts to
// fade. Sized at ~4 inference intervals at 12Hz: long enough to ride out the
// isolated misses that cause the strobing, short enough that a real departure
// still feels immediate.
const HOLD_MS = 320
const FADE_OUT_MS = 260
const FADE_IN_MS = 110

// Identity-bearing overlays hold for far less time.
//
// The generic hold exists to stop boxes strobing when a detector misses a
// frame - worth ~580ms of latency for a box. It is NOT worth it for a NAME:
// a label that lingers half a second after somebody leaves frame is asserting
// that a specific person is somewhere they are not, which is worse than a
// flickering box and is what "it still shows him after he walks out" is.
const IDENTITY_HOLD_MS = 60
const IDENTITY_FADE_OUT_MS = 90

// Per-mode box hold.
//
// The default 320+260ms exists to stop boxes strobing when a detector drops a
// frame, and for a crowd or a traffic scene that is the right trade: a box
// flickering on twenty people reads as broken software.
//
// It is the wrong trade when the boxes ARE the subject. In person-ID and the
// single-target trackers, a box outliving the person by half a second looks
// like the drone still sees somebody who has walked out of frame - and in a
// mode whose whole job is "who is that", a stale box is a claim about a
// person. Those modes get a much shorter hold; the crowd keeps the long one.
export const MODE_HOLD_MS: Record<string, [hold: number, fade: number]> = {
    'person-tracking':        [80, 120],
    'human-tracking':         [120, 160],
    'vehicle-plate-tracking': [140, 180],
    // crowd-management and traffic-management deliberately keep the default:
    // many small boxes, where anti-strobe matters more than staleness.
}

// Exponential position smoothing time constant. Frame-rate independent via
// 1 - exp(-dt/TAU), so behaviour does not change with display refresh rate.
// 55ms is roughly "catches up within one inference interval" - tight enough
// that the box never visibly trails a moving subject, loose enough to absorb
// the coordinate noise a detector produces on a static one.
const TAU_MS = 55

// Minimum overlap to consider two boxes the same object across frames when
// the module provides no id. 0.3 is permissive on purpose: a missed match
// creates a duplicate ghost, which is far more noticeable than an occasional
// slightly-wrong association between same-class boxes.
const IOU_MATCH = 0.3

// Fallback association when IoU fails outright.
//
// IoU alone is not enough, and the failure is exactly the one that shows up in
// the field: the detector misses a moving person for two or three intervals,
// they travel further than their own width, and the returning detection does
// not overlap the held box AT ALL. IoU is then 0, no match is found, a second
// track is created - and because the first is still inside its hold window,
// the operator sees the SAME PERSON boxed twice, in two places.
//
// So a track also matches if the new box's centre is within this multiple of
// the track's own size. Scaling by size rather than using a fixed pixel
// budget keeps it resolution- and distance-independent: a person close to the
// camera is allowed to move further between frames than one far away, which
// is exactly how their pixel motion behaves.
const CENTRE_DIST_FACTOR = 1.6

// Velocity is used for ASSOCIATION only, never to move what is drawn.
// Predicting where a track should be lets a re-appearing detection match even
// after a long gap; extrapolating what is DRAWN would slide a box across the
// screen on no evidence, which is the failure mode this module exists to
// avoid. Capped so a bad velocity estimate cannot make a track claim a
// detection on the far side of the frame.
const MAX_PREDICT_MS = 500
const VELOCITY_SMOOTHING = 0.5

function centre(b: Box): [number, number] {
    return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]
}

function size(b: Box): number {
    return Math.max(1, Math.hypot(b[2] - b[0], b[3] - b[1]))
}

function iou(a: Box, b: Box): number {
    const x1 = Math.max(a[0], b[0])
    const y1 = Math.max(a[1], b[1])
    const x2 = Math.min(a[2], b[2])
    const y2 = Math.min(a[3], b[3])
    const w = x2 - x1, h = y2 - y1
    if (w <= 0 || h <= 0) return 0
    const inter = w * h
    const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1])
    const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
    const union = areaA + areaB - inter
    return union > 0 ? inter / union : 0
}

interface Track {
    key: string | null          // explicit identity, when available
    name?: string
    shown: Box                  // what is on screen right now
    target: Box                 // newest measurement
    item: RawItem               // newest payload, for non-geometric fields
    vx: number                  // px/ms, association only
    vy: number
    firstSeen: number
    lastSeen: number
    gone: number | null         // when it stopped being confirmed
}

/** Where this track probably is now, given how it was last moving. Used only
 *  to decide whether an incoming detection belongs to it. */
function predictedCentre(t: Track, now: number): [number, number] {
    const dt = Math.min(now - t.lastSeen, MAX_PREDICT_MS)
    const [cx, cy] = centre(t.target)
    return [cx + t.vx * dt, cy + t.vy * dt]
}

/** Association score: higher is better, -1 means "not the same object".
 *  IoU first (reliable when the object barely moved), then a size-scaled
 *  centre-distance test that survives the object having moved clear of its
 *  previous box. */
function association(t: Track, box: Box, now: number): number {
    const overlap = iou(t.target, box)
    if (overlap >= IOU_MATCH) return 1 + overlap        // always beats distance

    const [px, py] = predictedCentre(t, now)
    const [bx, by] = centre(box)
    const dist = Math.hypot(bx - px, by - py)
    const budget = CENTRE_DIST_FACTOR * Math.max(size(t.target), size(box))
    if (dist > budget) return -1
    return 1 - dist / budget                            // 0..1
}

/** Tracks one list of boxes (detections, persons, people, plates …) across
 *  payloads and samples it continuously. One instance per list. */
export class BoxSmoother {
    /** Hold/fade are per-instance so an identity list can be far snappier
     *  than a plain box list - see IDENTITY_HOLD_MS. */
    constructor(
        private holdMs = HOLD_MS,
        private fadeOutMs = FADE_OUT_MS,
    ) {}

    setTiming(holdMs: number, fadeOutMs: number): void {
        this.holdMs = holdMs
        this.fadeOutMs = fadeOutMs
    }

    private tracks: Track[] = []
    private lastSample = 0

    /** Feed a fresh payload. Items absent from it begin to fade. */
    ingest(items: RawItem[], now = performance.now()): void {
        const unmatched = new Set(this.tracks)

        // Explicit ids first - when a module supplies one it is authoritative
        // and must never be overridden by a geometric guess.
        const geometric: RawItem[] = []
        for (const item of items) {
            if (item.id === undefined) { geometric.push(item); continue }
            const key = String(item.id)
            const track = this.tracks.find(t => t.key === key && unmatched.has(t))
            if (track) {
                unmatched.delete(track)
                this.confirm(track, item, now)
            } else {
                this.tracks.push(this.spawn(key, item, now))
            }
        }

        // Then geometry, GLOBALLY best-first rather than in payload order.
        // Taking the first acceptable match per item lets an early item claim
        // a track that a later one fits far better, which produces exactly the
        // duplicate-and-swap artefacts this is meant to remove.
        const pairs: { item: RawItem; track: Track; score: number }[] = []
        for (const item of geometric) {
            for (const t of unmatched) {
                if (t.key !== null || t.name !== item.name) continue
                const score = association(t, item.box, now)
                if (score > 0) pairs.push({ item, track: t, score })
            }
        }
        pairs.sort((a, b) => b.score - a.score)

        const claimedItems = new Set<RawItem>()
        for (const p of pairs) {
            if (claimedItems.has(p.item) || !unmatched.has(p.track)) continue
            claimedItems.add(p.item)
            unmatched.delete(p.track)
            this.confirm(p.track, p.item, now)
        }
        for (const item of geometric) {
            if (!claimedItems.has(item)) this.tracks.push(this.spawn(null, item, now))
        }

        for (const t of unmatched) {
            if (t.gone === null) t.gone = now
        }
    }

    private spawn(key: string | null, item: RawItem, now: number): Track {
        return {
            key, name: item.name,
            // Starts where it was measured - fading in from the right place,
            // rather than sliding in from a previous object's.
            shown: [...item.box] as Box,
            target: item.box,
            item, vx: 0, vy: 0,
            firstSeen: now, lastSeen: now, gone: null,
        }
    }

    private confirm(t: Track, item: RawItem, now: number): void {
        const dt = now - t.lastSeen
        if (dt > 0 && dt <= MAX_PREDICT_MS) {
            const [ox, oy] = centre(t.target)
            const [nx, ny] = centre(item.box)
            t.vx += ((nx - ox) / dt - t.vx) * VELOCITY_SMOOTHING
            t.vy += ((ny - oy) / dt - t.vy) * VELOCITY_SMOOTHING
        }
        t.target = item.box
        t.item = item
        t.name = item.name
        t.lastSeen = now
        t.gone = null
    }

    /** Current on-screen state. Call once per animation frame. */
    sample(now = performance.now()): SmoothedItem[] {
        const dt = this.lastSample ? Math.min(now - this.lastSample, 200) : 16
        this.lastSample = now
        const k = 1 - Math.exp(-dt / TAU_MS)

        const out: SmoothedItem[] = []
        const keep: Track[] = []

        for (const t of this.tracks) {
            const since = now - t.lastSeen
            let alpha = 1

            if (t.gone !== null && since > this.holdMs) {
                const fading = since - this.holdMs
                if (fading >= this.fadeOutMs) continue   // fully gone - drop it
                alpha = 1 - fading / this.fadeOutMs
            }

            const age = now - t.firstSeen
            if (age < FADE_IN_MS) alpha = Math.min(alpha, age / FADE_IN_MS)

            for (let i = 0; i < 4; i++) {
                t.shown[i] += (t.target[i] - t.shown[i]) * k
            }

            keep.push(t)
            out.push({
                ...t.item,
                box: [t.shown[0], t.shown[1], t.shown[2], t.shown[3]],
                _a: alpha,
            })
        }

        this.tracks = keep
        return out
    }

    reset(): void {
        this.tracks = []
        this.lastSample = 0
    }
}

/** Smoothers for every list a CVResult can carry, keyed by field name. */
export class OverlaySmoothers {
    private byField = new Map<string, BoxSmoother>()

    private mode = ''

    private get(field: string): BoxSmoother {
        let s = this.byField.get(field)
        if (!s) {
            // A NAME must not outlive the person it names. Holding a box for
            // half a second after a missed detection is good; holding a
            // label that long asserts somebody is somewhere they are not.
            s = field === 'identities'
                ? new BoxSmoother(IDENTITY_HOLD_MS, IDENTITY_FADE_OUT_MS)
                : new BoxSmoother()
            this.byField.set(field, s)
        }
        return s
    }

    /** Apply a mode's hold/fade to the smoothers it owns. Called when the
     *  mode changes; a no-op for modes that keep the defaults. */
    setMode(mode: string): void {
        const tuning = MODE_HOLD_MS[mode]
        for (const [field, s] of this.byField) {
            if (field === 'identities') continue      // has its own, snappier pair
            s.setTiming(...(tuning ?? [HOLD_MS, FADE_OUT_MS]))
        }
        this.mode = mode
    }

    ingest(field: string, items: RawItem[] | undefined, now?: number): void {
        const s = this.get(field)
        if (field !== 'identities') {
            const t = MODE_HOLD_MS[this.mode]
            s.setTiming(...(t ?? [HOLD_MS, FADE_OUT_MS]))
        }
        s.ingest(items ?? [], now)
    }

    sample(field: string, now?: number): SmoothedItem[] {
        return this.get(field).sample(now)
    }

    reset(): void {
        for (const s of this.byField.values()) s.reset()
    }
}

/** Eases a scalar (a count, a density alpha) with the same time constant, so
 *  numeric HUD elements do not step. */
export function easeToward(current: number, target: number, dtMs: number): number {
    return current + (target - current) * (1 - Math.exp(-dtMs / TAU_MS))
}
