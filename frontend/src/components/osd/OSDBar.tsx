'use client'

// The Fly page's readouts: altitude, speed, heading, distance home, climb
// and battery as big numbers beside the video, at eye level.
//
// The status chips this used to carry (link, armed, mode, GPS, time) live in
// the one global status bar now (components/layout/StatusBar.tsx), so they
// are not repeated here. With no drone each tile shows a quiet placeholder
// rule and its unit.

import { Battery, Gauge, Navigation, Home, Compass, MoveVertical } from 'lucide-react'
import { useDroneStore } from '@/store/drone'
import { headingToCardinal, climbRate } from '@/lib/osd'
import { cn } from '@/lib/utils'

type Tone = 'ok' | 'warn' | 'danger'
const TONE_TEXT: Record<Tone, string> = { ok: 'text-app-ok', warn: 'text-app-warn', danger: 'text-app-danger' }

/** A readout: small sentence-case label, big bold value, small muted unit. */
function Readout({ icon, label, value, unit, tone, title, placeholderUnit = unit }: {
    icon: React.ReactNode; label: string; value: string | null; unit?: string; tone?: Tone; title?: string
    /** Unit shown beside the placeholder while there is no reading. */
    placeholderUnit?: string
}) {
    return (
        <div title={title} className="flex flex-col min-w-0 gap-0.5 px-2.5 py-2 rounded-[10px] bg-app-surface-2">
            <span className="flex items-center gap-1.5 text-[12px] font-semibold text-app-text-muted">
                {icon}{label}
            </span>
            {value == null ? (
                // No drone: a calm placeholder at the readout's size (a short
                // rule where the number goes, then the unit), not a tiny "-".
                <span className="flex items-center gap-1.5 h-[24px] min-w-0" aria-label="No reading">
                    <span aria-hidden className="h-[3px] w-6 rounded-full bg-app-border-strong opacity-50" />
                    {placeholderUnit && <span className="text-[12px] font-semibold text-app-text-subtle">{placeholderUnit}</span>}
                </span>
            ) : (
                <span className="flex items-baseline gap-1 min-w-0">
                    <span className={cn('text-[22px] leading-[1.1] font-extrabold tabular-nums truncate',
                        tone ? TONE_TEXT[tone] : 'text-app-text')}>
                        {value}
                    </span>
                    {unit && <span className="text-[12px] font-semibold text-app-text-muted">{unit}</span>}
                </span>
            )}
        </div>
    )
}

function batteryTone(pct: number): Tone {
    return pct > 50 ? 'ok' : pct > 20 ? 'warn' : 'danger'
}

export function OSDBar({ className }: { className?: string }) {
    // Per-field selector: a telemetry packet re-renders the readouts, a
    // cvResults update or an FC message does not.
    const telemetry = useDroneStore(s => s.telemetry)
    const linked = useDroneStore(s => s.telemetryStatus) === 'connected'
    const t = linked ? telemetry : null

    const hdg = t?.heading_deg ?? 0
    const climb = t ? climbRate(t.velocity.down_m_s) : 0

    return (
        <div className={cn('grid grid-cols-3 gap-2', className)}>
            <Readout icon={<Navigation size={13} />} label="Altitude" value={t ? t.position.relative_altitude_m.toFixed(1) : null} unit="m"
                title="Altitude above home" />
            <Readout icon={<Gauge size={13} />} label="Speed" value={t ? t.groundspeed_m_s.toFixed(1) : null} unit="m/s"
                title="Ground speed" />
            <Readout icon={<Compass size={13} />} label="Heading"
                value={t ? `${Math.round(hdg).toString().padStart(3, '0')}°` : null} unit={headingToCardinal(hdg)} placeholderUnit="°" title="Heading" />
            <Readout icon={<MoveVertical size={13} />} label="Climb" value={t ? climb.toFixed(1) : null} unit="m/s"
                title="Vertical speed, up is positive" />
            <Readout icon={<Home size={13} />} label="Home" value={t ? t.home_distance_m.toFixed(0) : null} unit="m"
                title="Distance to home" />
            <Readout icon={<Battery size={13} />} label="Battery" value={t ? `${t.battery.remaining_percent.toFixed(0)}%` : null}
                unit={t ? `${t.battery.voltage_v.toFixed(1)} V` : undefined} tone={t ? batteryTone(t.battery.remaining_percent) : undefined}
                placeholderUnit="%" title="Battery" />
        </div>
    )
}
