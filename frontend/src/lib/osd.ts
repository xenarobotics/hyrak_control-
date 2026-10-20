export function headingToCardinal(deg: number): string {
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
    return dirs[Math.round(deg / 22.5) % 16]
}

export function gpsFixLabel(fixType: number): string {
    switch (fixType) {
        case 0: case 1: return 'NO FIX'
        case 2: return '2D'
        case 3: return '3D'
        case 4: return 'DGPS'
        case 5: return 'RTK~'
        case 6: return 'RTK'
        default: return '?'
    }
}

// Status colours. Over video and map tiles ('overlay', the default) they
// come from the --overlay-* set; on themed panels ('app') from the theme
// tokens, so both read in light, dark and midnight without a remap.
export type ColorOn = 'overlay' | 'app'
type StatusTone = 'accent' | 'ok' | 'warn' | 'danger'
export function statusColor(tone: StatusTone, on: ColorOn = 'overlay'): string {
    return on === 'overlay' ? `var(--overlay-${tone})` : `var(--app-${tone})`
}

export function gpsFixColor(fixType: number, on: ColorOn = 'overlay'): string {
    if (fixType >= 6) return statusColor('accent', on)
    if (fixType >= 3) return statusColor('ok', on)
    if (fixType === 2) return statusColor('warn', on)
    return statusColor('danger', on)
}

export function batteryTextColor(pct: number, on: ColorOn = 'overlay'): string {
    if (pct > 50) return statusColor('ok', on)
    if (pct > 20) return statusColor('warn', on)
    return statusColor('danger', on)
}

export function batteryBorderColor(pct: number, on: ColorOn = 'overlay'): string {
    const mix = pct > 50 ? 30 : pct > 20 ? 40 : 60
    return `color-mix(in srgb, ${batteryTextColor(pct, on)} ${mix}%, transparent)`
}

export function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0')
    const s = Math.floor(seconds % 60).toString().padStart(2, '0')
    return `${m}:${s}`
}

export function climbRate(downMs: number): number {
    // MAVSDK velocity_ned: positive down = descending
    return -downMs
}

export function climbRateColor(rate: number, on: ColorOn = 'overlay'): string {
    if (rate > 0.5) return statusColor('ok', on)
    if (rate < -0.5) return statusColor('danger', on)
    return on === 'overlay' ? 'var(--overlay-text)' : 'hsl(var(--app-text))'
}

export function connectionQuality(rtt: number, packetLoss: number): 'excellent' | 'good' | 'fair' | 'poor' {
    if (rtt < 30 && packetLoss < 0.5) return 'excellent'
    if (rtt < 80 && packetLoss < 2) return 'good'
    if (rtt < 150 && packetLoss < 5) return 'fair'
    return 'poor'
}

export function connectionQualityColor(q: ReturnType<typeof connectionQuality>, on: ColorOn = 'overlay'): string {
    switch (q) {
        case 'excellent': return statusColor('accent', on)
        case 'good': return statusColor('ok', on)
        case 'fair': return statusColor('warn', on)
        case 'poor': return statusColor('danger', on)
    }
}

export function estimatedFlightTimeRemaining(
    remainingPct: number,
    elapsedSeconds: number
): string {
    if (remainingPct <= 0 || elapsedSeconds < 30) return '-'
    // Simple linear extrapolation from consumption rate
    const pctUsed = 100 - remainingPct
    if (pctUsed < 5) return '-'
    const secsPerPct = elapsedSeconds / pctUsed
    const remaining = Math.floor(remainingPct * secsPerPct)
    return formatDuration(remaining)
}