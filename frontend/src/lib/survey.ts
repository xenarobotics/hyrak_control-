import type { SurveyConfig, SurveyPoint } from '@/types/mission'

// ── Survey line generation ──────────────────────────────────────────────────
// Lawnmower scan lines for a polygon. Every line is returned start→end in the
// SAME direction (no serpentine) so callers can partition first and apply the
// serpentine ordering within each partition.

export function generateSurveyLines(
  polygon: SurveyPoint[],
  config: Pick<SurveyConfig, 'spacing' | 'angle' | 'overshoot'>,
): SurveyPoint[][] {
  if (polygon.length < 3) return []

  const { spacing, angle, overshoot } = config
  const rad = (angle * Math.PI) / 180

  // Convert lat/lng to local metres (equirectangular projection from centroid)
  const cLat = polygon.reduce((s, p) => s + p.lat, 0) / polygon.length
  const cLng = polygon.reduce((s, p) => s + p.lng, 0) / polygon.length
  const mPerDegLat = 111_320
  const mPerDegLng = 111_320 * Math.cos((cLat * Math.PI) / 180)

  const local = polygon.map(p => ({
    x: (p.lng - cLng) * mPerDegLng,
    y: (p.lat - cLat) * mPerDegLat,
  }))

  // Rotate to align grid with scan angle
  const rotated = local.map(p => ({
    x: p.x * Math.cos(rad) + p.y * Math.sin(rad),
    y: -p.x * Math.sin(rad) + p.y * Math.cos(rad),
  }))

  let minX = Infinity, maxX = -Infinity
  for (const p of rotated) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
  }

  const unrotate = (rx: number, ry: number) => ({
    x: rx * Math.cos(rad) - ry * Math.sin(rad),
    y: rx * Math.sin(rad) + ry * Math.cos(rad),
  })
  const toLatLng = (m: { x: number; y: number }): SurveyPoint => ({
    lat: Math.round((cLat + m.y / mPerDegLat) * 1e7) / 1e7,
    lng: Math.round((cLng + m.x / mPerDegLng) * 1e7) / 1e7,
  })

  const lines: SurveyPoint[][] = []
  const numLines = Math.ceil((maxX - minX) / spacing) + 1

  for (let i = 0; i <= numLines; i++) {
    const x = minX + i * spacing

    // Intersections of this scan line with polygon edges (rotated space)
    const intersections: number[] = []
    for (let j = 0; j < rotated.length; j++) {
      const a = rotated[j]
      const b = rotated[(j + 1) % rotated.length]
      if ((a.x <= x && b.x > x) || (b.x <= x && a.x > x)) {
        const t = (x - a.x) / (b.x - a.x)
        intersections.push(a.y + t * (b.y - a.y))
      }
    }
    if (intersections.length < 2) continue
    intersections.sort((a, b) => a - b)

    const yStart = intersections[0] - overshoot
    const yEnd = intersections[intersections.length - 1] + overshoot
    const p1 = unrotate(x, yStart)
    const p2 = unrotate(x, yEnd)
    lines.push([toLatLng(p1), toLatLng(p2)])
  }

  return lines
}

/** Alternate line direction and flatten to a single lawnmower path. */
export function serpentine(lines: SurveyPoint[][]): SurveyPoint[] {
  return lines
    .map((line, i) => (i % 2 === 0 ? line : [...line].reverse()))
    .flat()
}

/** Haversine distance in metres. */
export function distanceM(a: SurveyPoint, b: SurveyPoint): number {
  const R = 6_371_000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

export function pathLengthM(points: SurveyPoint[]): number {
  let d = 0
  for (let i = 1; i < points.length; i++) d += distanceM(points[i - 1], points[i])
  return Math.round(d)
}

// ── Fleet partitioning ──────────────────────────────────────────────────────
// Split ordered scan lines into n CONTIGUOUS groups balanced by summed line
// length. Contiguity gives every drone one spatially disjoint strip of the
// area, so paths never interleave with a neighbour's.

export function partitionSurveyLines(
  lines: SurveyPoint[][],
  n: number,
): SurveyPoint[][][] {
  if (n <= 1 || lines.length <= 1) return lines.length ? [lines] : []
  const groups = Math.min(n, lines.length)

  const lengths = lines.map(l => distanceM(l[0], l[1]))
  const total = lengths.reduce((a, b) => a + b, 0)
  const target = total / groups

  const partitions: SurveyPoint[][][] = []
  let current: SurveyPoint[][] = []
  let acc = 0

  for (let i = 0; i < lines.length; i++) {
    current.push(lines[i])
    acc += lengths[i]
    const remainingLines = lines.length - i - 1
    const remainingGroups = groups - partitions.length - 1
    // Close the group once it reaches its share — but never starve the
    // remaining groups of at least one line each.
    if (
      remainingGroups > 0 &&
      (acc >= target || remainingLines <= remainingGroups) &&
      remainingLines >= remainingGroups
    ) {
      partitions.push(current)
      current = []
      acc = 0
    }
  }
  if (current.length) partitions.push(current)
  return partitions
}
