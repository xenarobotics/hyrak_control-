'use client'

// Settings > Video > DETECTIONS ON THE MAP: where this device's camera
// points, for placing AI detections on the map. Saved on this device and
// sent to the session; a gimbal that reports its pitch overrides it.

import { useState } from 'react'
import { PrefRow, S_INPUT, S_NOTE } from '@/components/settings/primitives'
import { saveCameraPref, type CameraPref } from '@/lib/mapSightings'
import { useCameraPref } from './useLiveSightings'
import { FOCUS } from '@/components/mission/ui'

type Direction = 'down' | 'forward'

function Seg({ value, onChange }: { value: Direction; onChange: (v: Direction) => void }) {
    const opts: { v: Direction; label: string }[] = [
        { v: 'down', label: 'Straight down' },
        { v: 'forward', label: 'Forward, tilted' },
    ]
    return (
        <div role="radiogroup" aria-label="Camera direction" style={{ display: 'flex', gap: 4 }}>
            {opts.map(o => (
                <button key={o.v} type="button" role="radio" aria-checked={value === o.v}
                    onClick={() => onChange(o.v)}
                    className={FOCUS}
                    style={{
                        minHeight: 32, padding: '0 12px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                        border: `1px solid ${value === o.v ? 'color-mix(in srgb, var(--app-accent) 55%, transparent)' : 'hsl(var(--app-border))'}`,
                        background: value === o.v ? 'var(--app-accent-soft)' : 'transparent',
                        color: value === o.v ? 'var(--app-selected-ink)' : 'hsl(var(--app-text))',
                        transition: 'background-color 120ms, color 120ms',
                    }}>
                    {o.label}
                </button>
            ))}
        </div>
    )
}

function NumberField({ label, value, min, max, unit, onCommit }: {
    label: string; value: number; min: number; max: number; unit: string; onCommit: (v: number) => void
}) {
    const [draft, setDraft] = useState<string | null>(null)
    const [err, setErr] = useState(false)
    const commit = () => {
        if (draft === null) return
        const v = Number(draft)
        if (!Number.isFinite(v) || v < min || v > max) { setErr(true); return }
        setErr(false)
        setDraft(null)
        onCommit(v)
    }
    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="number" inputMode="decimal" aria-label={label} min={min} max={max}
                    value={draft ?? String(value)} aria-invalid={err}
                    onChange={e => { setDraft(e.target.value); setErr(false) }}
                    onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit() }}
                    style={{ ...S_INPUT, width: 76, borderColor: err ? 'var(--app-danger)' : undefined }} />
                <span style={S_NOTE}>{unit}</span>
            </div>
            {err && <span role="alert" style={{ ...S_NOTE, color: 'var(--app-danger)' }}>Enter {min} to {max}</span>}
        </div>
    )
}

export function MapCameraGroup() {
    const pref = useCameraPref()
    const direction: Direction = pref.pitch_deg <= -89.5 ? 'down' : 'forward'
    const save = (patch: Partial<CameraPref>) => {
        const next = { ...pref, ...patch }
        saveCameraPref({ pitch_deg: next.pitch_deg, hfov_deg: next.hfov_deg, stabilised: next.stabilised })
    }
    return (
        <>
            {!pref.set && (
                <p style={{ ...S_NOTE, color: 'var(--app-warn)', fontWeight: 600, padding: '8px 0 2px' }}>
                    Not set yet: detections assume a straight-down camera with an 80° lens.
                </p>
            )}
            <PrefRow label="Camera direction"
                sub="Where the lens points when the drone is level"
                tip="AI detections are placed on the map by following the camera's line of sight to the ground. A wrong angle moves every detection, the further the more the camera looks ahead."
                right={<Seg value={direction} onChange={d => save({ pitch_deg: d === 'down' ? -90 : -45 })} />} />
            {direction === 'forward' && (
                <PrefRow label="Tilt below the horizon"
                    sub="0 is level, 89 is almost straight down"
                    right={<NumberField label="Tilt below the horizon" value={Math.round(-pref.pitch_deg)}
                        min={0} max={89} unit="deg" onCommit={v => save({ pitch_deg: -v })} />} />
            )}
            <PrefRow label="Lens field of view"
                sub="Horizontal, edge to edge"
                tip="Measure it: fill the frame edge to edge with a target of known width W at distance D, then FOV = 2 x atan(W / 2D). Most drone cameras are 70 to 90."
                right={<NumberField label="Lens field of view" value={pref.hfov_deg} min={10} max={170} unit="deg"
                    onCommit={v => save({ hfov_deg: v })} />} />
            <PrefRow label="Camera stays level"
                sub="On a stabilising gimbal, so the drone tilting does not move it"
                right={<input type="checkbox" aria-label="Camera stays level" checked={pref.stabilised}
                    onChange={e => save({ stabilised: e.target.checked })}
                    className={FOCUS} style={{ accentColor: 'var(--app-accent)', width: 18, height: 18 }} />} />
        </>
    )
}
