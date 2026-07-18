// Pre-flight fleet deconfliction: pairwise check of every drone's planned
// lane against every other. Two lanes conflict when any pair of their path
// segments comes within HORIZ_M horizontally while their altitude bands
// (segment endpoints ± VERT_M) overlap. Advisory only — the operator decides
// whether to re-route or stagger altitudes.

export interface Lane {
    id: number
    name: string
    wps: { lat: number; lng: number; altitude: number }[]
}

export interface LaneConflict {
    a: string           // drone name
    b: string
    distanceM: number   // closest horizontal approach found
}

const HORIZ_M = 10
const VERT_M = 3

// Local flat-earth projection around a reference latitude — plenty accurate
// at mission scale (< a few km).
function toXY(lat: number, lng: number, refLat: number): [number, number] {
    const mPerDegLat = 111_320
    const mPerDegLng = 111_320 * Math.cos((refLat * Math.PI) / 180)
    return [lng * mPerDegLng, lat * mPerDegLat]
}

// Minimum distance between two 2D segments.
function segSegDist(
    p1: [number, number], p2: [number, number],
    q1: [number, number], q2: [number, number],
): number {
    const ptSeg = (p: [number, number], a: [number, number], b: [number, number]) => {
        const dx = b[0] - a[0], dy = b[1] - a[1]
        const len2 = dx * dx + dy * dy
        const t = len2 === 0 ? 0
            : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
        const cx = a[0] + t * dx - p[0], cy = a[1] + t * dy - p[1]
        return Math.sqrt(cx * cx + cy * cy)
    }
    // Segments intersect → distance 0 (covered by endpoint checks being > 0
    // only when no crossing; do an explicit orientation test).
    const d = (o: [number, number], a: [number, number], b: [number, number]) =>
        (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    const d1 = d(q1, q2, p1), d2 = d(q1, q2, p2), d3 = d(p1, p2, q1), d4 = d(p1, p2, q2)
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
        ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0
    return Math.min(ptSeg(p1, q1, q2), ptSeg(p2, q1, q2), ptSeg(q1, p1, p2), ptSeg(q2, p1, p2))
}

/**
 * Returns one conflict entry per drone pair whose lanes come closer than
 * HORIZ_M horizontally at overlapping altitudes. Empty array = clear.
 */
export function findLaneConflicts(lanes: Lane[]): LaneConflict[] {
    const conflicts: LaneConflict[] = []
    const usable = lanes.filter(l => l.wps.length >= 2)
    if (usable.length < 2) return conflicts
    const refLat = usable[0].wps[0].lat

    for (let i = 0; i < usable.length; i++) {
        for (let j = i + 1; j < usable.length; j++) {
            const A = usable[i], B = usable[j]
            let worst = Infinity
            for (let s = 0; s < A.wps.length - 1 && worst > 0; s++) {
                const a1 = A.wps[s], a2 = A.wps[s + 1]
                const altA = [Math.min(a1.altitude, a2.altitude) - VERT_M,
                              Math.max(a1.altitude, a2.altitude) + VERT_M]
                const p1 = toXY(a1.lat, a1.lng, refLat), p2 = toXY(a2.lat, a2.lng, refLat)
                for (let t = 0; t < B.wps.length - 1; t++) {
                    const b1 = B.wps[t], b2 = B.wps[t + 1]
                    // Altitude bands must overlap for a real conflict
                    if (Math.max(b1.altitude, b2.altitude) < altA[0] ||
                        Math.min(b1.altitude, b2.altitude) > altA[1]) continue
                    const q1 = toXY(b1.lat, b1.lng, refLat), q2 = toXY(b2.lat, b2.lng, refLat)
                    const dist = segSegDist(p1, p2, q1, q2)
                    if (dist < HORIZ_M && dist < worst) worst = dist
                    if (worst === 0) break
                }
            }
            if (worst < HORIZ_M) {
                conflicts.push({ a: A.name, b: B.name, distanceM: Math.round(worst) })
            }
        }
    }
    return conflicts
}
