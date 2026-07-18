// Turn-radius path expansion for mission uploads — shared by the single-drone
// upload flow (mission page) and the fleet mission panel so every drone flies
// the same geometry the map displays.

import type { Waypoint } from '@/types/mission'

export type UploadWp = {
    lat: number; lng: number; altitude: number; speed: number
    hold_time: number; type: string; yaw: number | null; turn_radius: number
}

// Bearing (true heading, deg, 0=N clockwise) between two WGS-84 points.
function computeBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const φ1 = (lat1 * Math.PI) / 180
    const φ2 = (lat2 * Math.PI) / 180
    const Δλ = ((lng2 - lng1) * Math.PI) / 180
    const y = Math.sin(Δλ) * Math.cos(φ2)
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

// Converts a waypoint list with turn radii into a dense list of intermediate
// waypoints that trace the Bezier curves shown on the map. Without this the
// drone flies the raw corners; with it the uploaded mission matches the display.
// When autoHeading is true, each point's yaw is set to the bearing toward the
// next point along the actual flight path (including Bezier arc tangents).
export function expandWaypointsWithTurnRadius(allWaypoints: Waypoint[], autoHeading = false): UploadWp[] {
    // RTL is a separate, non-mission control now (see rtlPosition in the mission
    // store) — defensively strip any legacy 'rtl'-type entries before building
    // the uploaded mission so they never end up as a mission item.
    const waypoints = allWaypoints.filter(w => w.type !== 'rtl')

    const flat = (wp: Waypoint): UploadWp => ({
        lat: wp.lat, lng: wp.lng, altitude: wp.altitude,
        speed: wp.speed, hold_time: wp.holdTime, type: wp.type, yaw: wp.yaw,
        turn_radius: 0,
    })

    // No expansion needed if < 3 points or no turn radii set
    if (waypoints.length < 3 || !waypoints.some(w => (w.turnRadius ?? 0) > 0)) {
        return waypoints.map(flat)
    }

    const cLat = waypoints.reduce((s, w) => s + w.lat, 0) / waypoints.length
    const cLng = waypoints.reduce((s, w) => s + w.lng, 0) / waypoints.length
    const mPerDegLat = 111_320
    const mPerDegLng = 111_320 * Math.cos((cLat * Math.PI) / 180)

    const pts = waypoints.map(w => ({
        x: (w.lng - cLng) * mPerDegLng,
        y: (w.lat - cLat) * mPerDegLat,
    }))

    const result: UploadWp[] = [flat(waypoints[0])]

    for (let i = 1; i < waypoints.length - 1; i++) {
        const prev = pts[i - 1], curr = pts[i], next = pts[i + 1]
        const r = waypoints[i].turnRadius ?? 0

        if (r <= 0) { result.push(flat(waypoints[i])); continue }

        const toPrev = { x: prev.x - curr.x, y: prev.y - curr.y }
        const toNext = { x: next.x - curr.x, y: next.y - curr.y }
        const lenPrev = Math.sqrt(toPrev.x ** 2 + toPrev.y ** 2)
        const lenNext = Math.sqrt(toNext.x ** 2 + toNext.y ** 2)

        if (lenPrev === 0 || lenNext === 0) { result.push(flat(waypoints[i])); continue }

        const maxR = Math.min(lenPrev * 0.4, lenNext * 0.4, r)
        const uP = { x: toPrev.x / lenPrev, y: toPrev.y / lenPrev }
        const uN = { x: toNext.x / lenNext, y: toNext.y / lenNext }
        const arcS = { x: curr.x + uP.x * maxR, y: curr.y + uP.y * maxR }
        const arcE = { x: curr.x + uN.x * maxR, y: curr.y + uN.y * maxR }

        const a0 = waypoints[i - 1].altitude
        const a1 = waypoints[i].altitude
        const a2 = waypoints[i + 1].altitude
        const altS = a1 + (a0 - a1) * (maxR / lenPrev)
        const altE = a1 + (a2 - a1) * (maxR / lenNext)

        // Each intermediate Bezier point gets an acceptance radius ≈ half the arc
        // step spacing so the drone flows through the arc without stopping at each
        // point. PX4 for multirotors has no built-in turn-radius arc generator —
        // `acceptance_radius_m` only controls when to switch to the next waypoint.
        // With is_fly_through=True + a proper acceptance radius the drone naturally
        // blends through consecutive points and traces the Bezier shape.
        const arcStepAcceptance = Math.max(1.5, maxR * 0.12)

        for (let s = 0; s <= 8; s++) {
            const t = s / 8, it = 1 - t
            const bx = it * it * arcS.x + 2 * it * t * curr.x + t * t * arcE.x
            const by = it * it * arcS.y + 2 * it * t * curr.y + t * t * arcE.y
            result.push({
                lat: Math.round((cLat + by / mPerDegLat) * 1e7) / 1e7,
                lng: Math.round((cLng + bx / mPerDegLng) * 1e7) / 1e7,
                altitude: it * it * altS + 2 * it * t * a1 + t * t * altE,
                speed: waypoints[i].speed,
                hold_time: 0,
                type: 'waypoint',
                yaw: null,
                turn_radius: arcStepAcceptance,
            })
        }
    }

    result.push(flat(waypoints[waypoints.length - 1]))

    // Auto-heading: bearing from each expanded point toward the next, so arc
    // tangents are naturally accounted for by the intermediate Bezier steps.
    if (autoHeading && result.length >= 2) {
        for (let i = 0; i < result.length - 1; i++) {
            result[i].yaw = computeBearing(result[i].lat, result[i].lng, result[i + 1].lat, result[i + 1].lng)
        }
        result[result.length - 1].yaw = result[result.length - 2].yaw!
    }

    return result
}
