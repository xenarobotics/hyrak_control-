// The lowest altitude at which avoidance may steer, mirroring the backend's
// AvoidanceController.acting_floor_m(): the height the current sensor is
// trusted to see from. null when avoidance is unknown or off.

import type { AvoidanceStatus } from '@/lib/avoidance'

export function actingFloorM(a: AvoidanceStatus | null): number | null {
    if (!a || !a.enabled) return null
    const p = a.params
    if (a.sensor_mode === 'range') return p.range_min_alt_m ?? 2
    if (a.sensor_mode === 'mono') return p.mono_min_alt_m ?? 8
    return 3
}
