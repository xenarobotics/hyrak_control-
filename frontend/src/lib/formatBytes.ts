// Byte / transfer-rate formatting for download progress UI.
// Shared so the update prompt and the Settings → About row can't drift into
// showing the same number two different ways.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** 15728640 → "15.0 MB". Binary steps (1024), decimal-ish labels — matching
 *  what electron-updater's own numbers mean and what installers conventionally
 *  display. */
export function formatBytes(bytes: number, decimals = 1): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1)
    const value = bytes / Math.pow(1024, i)
    // Whole bytes never need a decimal point.
    return `${value.toFixed(i === 0 ? 0 : decimals)} ${UNITS[i]}`
}

/** 2202009 → "2.1 MB/s" */
export function formatRate(bytesPerSecond: number): string {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
    return `${formatBytes(bytesPerSecond)}/s`
}

/** Remaining time from a byte total and a rate. Returns '' when it can't be
 *  computed or would be misleading (no rate, unknown total, absurd estimate). */
export function formatEta(transferred: number, total: number, bytesPerSecond: number): string {
    if (!bytesPerSecond || !total || transferred >= total) return ''
    const seconds = Math.round((total - transferred) / bytesPerSecond)
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) return ''
    if (seconds < 60) return `${seconds}s left`
    const m = Math.floor(seconds / 60)
    if (m < 60) return `${m}m ${seconds % 60}s left`
    return `${Math.floor(m / 60)}h ${m % 60}m left`
}
