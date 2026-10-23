// Colour and icon for a PX4 parameter group, the way the earlier HYRAK
// parameter browser drew them. PX4 has about 75 groups; each family of
// groups (estimation, control, safety, outputs, ...) shares one colour so the
// sidebar and the cards stay calm while still telling groups apart.

import type React from 'react'
import {
    AlertTriangle, Battery, Camera, CornerDownLeft, Cpu, Gauge, LayoutList, Move,
    Navigation, Plane, Radio, RotateCcw, Shield, SlidersHorizontal, Terminal, Thermometer, Zap,
} from 'lucide-react'

export interface GroupStyle { color: string; icon: React.ElementType }

const BLUE = 'light-dark(#1d4ed8, #60a5fa)'
const ORANGE = 'light-dark(#c2410c, #fb923c)'
const VIOLET = 'light-dark(#6d28d9, #a78bfa)'
const PURPLE = 'light-dark(#7e22ce, #c084fc)'
const MAGENTA = 'light-dark(#a21caf, #e879f9)'
const INDIGO = 'light-dark(#4338ca, #818cf8)'
const TEAL = 'light-dark(#0f766e, #2dd4bf)'
const MUTED = 'hsl(var(--app-text-muted))'

// First match wins, so the specific patterns come before the broad ones.
const RULES: [RegExp, GroupStyle][] = [
    [/circuit breaker|failure detector/i, { color: 'var(--app-danger)', icon: AlertTriangle }],
    [/commander|geofence/i, { color: 'var(--app-danger)', icon: Shield }],
    [/battery/i, { color: 'var(--app-warn)', icon: Battery }],
    [/return/i, { color: 'var(--app-accent)', icon: CornerDownLeft }],
    [/thermal/i, { color: MUTED, icon: Thermometer }],
    [/land detector/i, { color: 'var(--app-ok)', icon: Plane }],
    [/attitude q|estimator|ekf/i, { color: INDIGO, icon: Gauge }],
    [/sensor|calibration|gps|airspeed|septentrio|magnetometer/i, { color: BLUE, icon: Gauge }],
    [/rate control|attitude control|acro|autotune/i, { color: ORANGE, icon: RotateCcw }],
    [/position|slow mode|hover thrust|flight task|follow|precision land|velocity control/i, { color: 'var(--app-ok)', icon: Move }],
    [/mission|navigation|pure pursuit|npfg|lateral|longitudinal/i, { color: VIOLET, icon: Navigation }],
    [/actuator|pwm|mixer|geometry|motor|esc/i, { color: ORANGE, icon: Zap }],
    [/radio|rc |manual control|mavlink|uxrce|uavcan|adsb/i, { color: PURPLE, icon: Radio }],
    [/vtol|^fw |runway|takeoff|landing|rover|uuv/i, { color: MAGENTA, icon: Plane }],
    [/camera|mount|payload|osd/i, { color: TEAL, icon: Camera }],
    [/log|events|testing|simul|sitl/i, { color: MUTED, icon: Terminal }],
    [/system/i, { color: 'var(--app-accent)', icon: Cpu }],
]

const cache = new Map<string, GroupStyle>()
const FALLBACK: GroupStyle = { color: 'var(--app-accent)', icon: SlidersHorizontal }

export const ALL_STYLE: GroupStyle = { color: 'var(--app-accent)', icon: LayoutList }

export function groupStyle(group: string): GroupStyle {
    let s = cache.get(group)
    if (!s) {
        s = RULES.find(([re]) => re.test(group))?.[1] ?? FALLBACK
        cache.set(group, s)
    }
    return s
}

/** Groups a newcomer never needs. Hidden until Expert is switched on. */
export const EXPERT_GROUPS = new Set([
    'Thermal Compensation', 'Testing', 'Simulation In Hardware', 'Simulator', 'Simulation', 'SITL', 'Circuit Breaker', 'Events',
])
