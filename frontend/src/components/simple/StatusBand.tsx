'use client'

// The one sentence that says what is happening, coloured by what it means:
// green = fine, amber = pay attention, red = act now, blue-grey = waiting.
// Battery and signal sit at the right edge in words and a simple gauge.

import type { FlightState, Tone } from './useFlightState'

const TONES: Record<Tone, { bg: string; fg: string; dot: string }> = {
    good:      { bg: 'var(--s-green-soft)', fg: 'var(--s-ink)', dot: 'var(--s-green)' },
    attention: { bg: 'var(--s-amber-soft)', fg: 'var(--s-amber-ink)', dot: '#E0A400' },
    stop:      { bg: 'var(--s-red-soft)', fg: '#7A140D', dot: 'var(--s-red)' },
    neutral:   { bg: 'var(--s-blue-soft)', fg: 'var(--s-ink)', dot: 'var(--s-blue)' },
}

function Battery({ pct }: { pct: number | null }) {
    if (pct == null) return null
    const col = pct <= 20 ? 'var(--s-red)' : pct <= 30 ? '#E0A400' : 'var(--s-green)'
    return (
        <div className="flex items-center gap-2" title={`Battery ${pct}%`}>
            <svg width="38" height="20" viewBox="0 0 38 20" aria-hidden="true">
                <rect x="1" y="1" width="32" height="18" rx="4" fill="none" stroke="var(--s-ink)" strokeWidth="2" />
                <rect x="34" y="6" width="3" height="8" rx="1" fill="var(--s-ink)" />
                <rect x="4" y="4" width={Math.max(2, 26 * pct / 100)} height="12" rx="2" fill={col} />
            </svg>
            <span className="text-[18px] font-bold">{pct}%</span>
        </div>
    )
}

export function StatusBand({ s, onSwitchMode }: { s: FlightState; onSwitchMode: () => void }) {
    const c = TONES[s.tone]
    return (
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--s-radius)] px-5 py-3 min-h-[76px]"
            style={{ background: c.bg, color: c.fg }} role="status" aria-live="polite">
            <span className="w-4 h-4 rounded-full shrink-0" style={{ background: c.dot }} aria-hidden="true" />
            <div className="flex-1 min-w-[220px]">
                <p className="text-[26px] font-bold leading-tight">{s.headline}</p>
                {s.detail && <p className="text-[16px] mt-0.5" style={{ color: s.tone === 'good' || s.tone === 'neutral' ? 'var(--s-ink-2)' : c.fg }}>{s.detail}</p>}
            </div>
            {s.altitude != null && s.inAir && (
                <div className="text-right leading-tight shrink-0" title="Height above the take-off point">
                    <span className="block text-[14px]" style={{ color: 'var(--s-ink-2)' }}>Height</span>
                    <span className="text-[22px] font-bold">{Math.max(0, s.altitude).toFixed(1)} m</span>
                </div>
            )}
            <Battery pct={s.battery} />
            <button type="button" onClick={onSwitchMode}
                className="shrink-0 rounded-lg px-3 min-h-[44px] text-[14px] font-medium border"
                style={{ borderColor: 'var(--s-line)', background: 'var(--s-panel)', color: 'var(--s-ink-2)' }}
                title="Switch to the full engineering interface">
                Switch to Dev view
            </button>
        </header>
    )
}
