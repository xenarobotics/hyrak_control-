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

export function gpsFixColor(fixType: number): string {
    if (fixType >= 6) return '#22d3ee'
    if (fixType >= 3) return '#4ade80'
    if (fixType === 2) return '#facc15'
    return '#f87171'
}

export function batteryTextColor(pct: number): string {
    if (pct > 50) return '#4ade80'
    if (pct > 20) return '#facc15'
    return '#f87171'
}

export function batteryBorderColor(pct: number): string {
    if (pct > 50) return 'rgba(74,222,128,0.3)'
    if (pct > 20) return 'rgba(250,204,21,0.4)'
    return 'rgba(248,113,113,0.6)'
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

export function climbRateColor(rate: number): string {
    if (rate > 0.5) return '#4ade80'
    if (rate < -0.5) return '#f87171'
    return 'rgba(255,255,255,0.7)'
}

export function connectionQuality(rtt: number, packetLoss: number): 'excellent' | 'good' | 'fair' | 'poor' {
    if (rtt < 30 && packetLoss < 0.5) return 'excellent'
    if (rtt < 80 && packetLoss < 2) return 'good'
    if (rtt < 150 && packetLoss < 5) return 'fair'
    return 'poor'
}

export function connectionQualityColor(q: ReturnType<typeof connectionQuality>): string {
    switch (q) {
        case 'excellent': return '#22d3ee'
        case 'good': return '#4ade80'
        case 'fair': return '#facc15'
        case 'poor': return '#f87171'
    }
}

export function estimatedFlightTimeRemaining(
    remainingPct: number,
    elapsedSeconds: number
): string {
    if (remainingPct <= 0 || elapsedSeconds < 30) return '—'
    // Simple linear extrapolation from consumption rate
    const pctUsed = 100 - remainingPct
    if (pctUsed < 5) return '—'
    const secsPerPct = elapsedSeconds / pctUsed
    const remaining = Math.floor(remainingPct * secsPerPct)
    return formatDuration(remaining)
}