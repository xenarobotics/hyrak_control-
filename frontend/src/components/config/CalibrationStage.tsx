'use client'

// The calibration stage: what the operator looks at while holding an aircraft.
//
// ONE RULE RUNS THROUGH ALL OF IT. Nothing on this panel may show progress the
// autopilot has not reported. A side turns green because PX4 said that side is
// done, never because the animation reached the end of its loop — an operator
// who trusts a green square and sets the aircraft down mid-side gets a
// calibration that fails at the last step with no clue why.
//
// So the movement is decoration over state, and the state is carried by colour
// and words as well, which is also what makes the panel work with reduced
// motion turned on.

import { DroneModel3D, SIDE_NAMES, type Side } from '@/components/config/DroneModel3D'
import type { CalibrationState, CalSide, SideState } from '@/types/calibration'
import { Check, X, Loader, CircleAlert, RotateCw } from 'lucide-react'

const PENDING_C = '#4b5563'
const ACTIVE_C = '#fbbf24'
const DONE_C = '#4ade80'
const FAIL_C = '#f87171'

function sideColour(s: SideState | undefined): string {
    return s === 'done' ? DONE_C : s === 'active' ? ACTIVE_C : PENDING_C
}

/** The circular arrow that says "rotate this". Drawn as a dashed arc whose
 *  dashes march round the circle, so the DIRECTION is visible — a pulsing ring
 *  says "something is happening here" and leaves the operator guessing which
 *  way to turn, which is the one thing this control exists to answer. */
function RotationArrow({ colour, active, size }: {
    colour: string; active: boolean; size: number
}) {
    const r = size / 2 - 10
    return (
        <svg
            width={size} height={size}
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
            aria-hidden
        >
            <circle
                cx={size / 2} cy={size / 2} r={r}
                fill="none" stroke={colour} strokeOpacity={active ? 0.85 : 0.25}
                strokeWidth={2} strokeDasharray="10 8" strokeLinecap="round"
                className={active ? 'hyrak-cal-anim' : undefined}
                style={active ? { animation: 'hyrak-cal-arrow 1.1s linear infinite' } : undefined}
            />
            {/* Head, so the arc reads as an arrow rather than a dotted ring. */}
            <polygon
                points={`${size / 2 + r - 6},14 ${size / 2 + r + 6},14 ${size / 2 + r},26`}
                fill={colour} fillOpacity={active ? 0.9 : 0.3}
            />
        </svg>
    )
}

function SideChip({ side, state }: { side: CalSide; state: SideState | undefined }) {
    const c = sideColour(state)
    const isActive = state === 'active'
    return (
        <div
            className={isActive ? 'hyrak-cal-anim' : undefined}
            style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '6px 9px', borderRadius: 8,
                background: state === 'done' ? 'rgba(74,222,128,0.10)'
                    : isActive ? 'rgba(251,191,36,0.14)' : 'rgba(75,85,99,0.10)',
                border: `1px solid ${c}${state === 'pending' ? '40' : '66'}`,
                animation: isActive ? 'hyrak-cal-pulse 1.3s ease-in-out infinite' : undefined,
            }}
        >
            <span style={{
                width: 15, height: 15, borderRadius: 4, flexShrink: 0,
                background: state === 'done' ? DONE_C : 'transparent',
                border: `1.5px solid ${c}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
                {state === 'done' && <Check size={10} strokeWidth={3.5} color="#0b1220" />}
            </span>
            <span style={{
                fontSize: 11, fontFamily: 'monospace', fontWeight: isActive ? 700 : 500,
                color: state === 'pending' ? 'hsl(var(--app-text-muted))' : c,
                whiteSpace: 'nowrap',
            }}>
                {SIDE_NAMES[side as Side] ?? side}
            </span>
        </div>
    )
}

export function CalibrationStage({ state, onCancel, onDismiss }: {
    state: CalibrationState
    onCancel: () => void
    onDismiss: () => void
}) {
    const order = (state.side_order ?? ['down', 'up', 'left', 'right', 'front', 'back']) as CalSide[]
    const oriented = Object.keys(state.sides ?? {}).length > 0
    const running = state.phase === 'starting' || state.phase === 'running'
    const failed = state.phase === 'failed'
    const done = state.phase === 'done'
    const cancelled = state.phase === 'cancelled'

    // The model shows the side PX4 is asking for. With nothing asked yet it
    // rests level, which is where the aircraft already is.
    const shown = (state.active_side ?? 'down') as Side
    // A compass is the only one where the instruction is "turn it", so it is
    // the only one that spins. An accelerometer spinning would be telling the
    // operator to do the exact thing that ruins the reading.
    const spin = running && state.sensor === 'mag' && !!state.active_side

    const accent = failed ? FAIL_C : done ? DONE_C : running ? ACTIVE_C : '#22d3ee'

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', gap: 14,
            padding: 16, borderRadius: 12,
            background: 'hsl(var(--app-surface-2))',
            border: `1px solid ${accent}44`,
        }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                {running ? <Loader size={14} className="animate-spin" color={accent} />
                    : done ? <Check size={15} color={DONE_C} />
                    : failed ? <CircleAlert size={15} color={FAIL_C} />
                    : <X size={15} color={PENDING_C} />}
                <span style={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 700, color: accent }}>
                    {state.label || state.sensor.toUpperCase()}
                    {done ? ' — COMPLETE' : failed ? ' — FAILED' : cancelled ? ' — CANCELLED' : ''}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>
                    {typeof state.progress === 'number' ? `${state.progress}%` : ''}
                </span>
            </div>

            {/* Progress. A real bar off a real number — there is no indefinite
                shimmer here, because a bar that moves on its own is a bar that
                lies about a stalled calibration. */}
            <div style={{ height: 5, borderRadius: 3, background: 'hsl(var(--app-surface))', overflow: 'hidden' }}>
                <div style={{
                    height: '100%', width: `${Math.max(0, Math.min(100, state.progress ?? 0))}%`,
                    background: accent, borderRadius: 3,
                    transition: 'width 400ms ease-out',
                }} />
            </div>

            <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
                {/* The aircraft */}
                <div style={{ position: 'relative', width: 190, height: 190, flexShrink: 0 }}>
                    <DroneModel3D
                        side={shown} spin={spin} accent={accent} size={190}
                        dim={!running}
                    />
                    {state.sensor === 'mag' && (
                        <RotationArrow colour={accent} active={spin} size={190} />
                    )}
                </div>

                {/* What to do */}
                <div style={{ flex: 1, minWidth: 220, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <p style={{
                        fontSize: 13, fontWeight: 600, lineHeight: 1.5, margin: 0,
                        color: failed ? FAIL_C : 'hsl(var(--app-text))',
                    }}>
                        {state.instruction || (running ? 'Waiting for the autopilot…' : '')}
                    </p>

                    {oriented && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(112px,1fr))', gap: 6 }}>
                            {order.map(side => (
                                <SideChip key={side} side={side} state={state.sides?.[side]} />
                            ))}
                        </div>
                    )}

                    {/* THE AUTOPILOT'S OWN WORDS, kept beside our translation of
                        them. When a firmware changes wording the parser has not
                        caught up with, this line is the difference between a
                        panel that is one release behind and a panel that is
                        lying. */}
                    {state.detail && (
                        <p style={{
                            fontSize: 10, fontFamily: 'monospace', margin: 0,
                            color: 'hsl(var(--app-text-muted))', wordBreak: 'break-word',
                        }}>
                            FC: {state.detail}
                        </p>
                    )}
                    {state.error && (
                        <p style={{ fontSize: 11, fontFamily: 'monospace', color: FAIL_C, margin: 0 }}>
                            {state.error}
                        </p>
                    )}
                </div>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
                {running ? (
                    <button
                        onClick={onCancel}
                        style={btn(FAIL_C)}
                        title="Stop the calibration on the aircraft as well as here"
                    >
                        <X size={12} /> CANCEL
                    </button>
                ) : (
                    <>
                        <button onClick={onDismiss} style={btn('#22d3ee')}>
                            <Check size={12} /> CLOSE
                        </button>
                        {failed && (
                            <span style={{
                                fontSize: 10, fontFamily: 'monospace', alignSelf: 'center',
                                color: 'hsl(var(--app-text-muted))',
                            }}>
                                <RotateCw size={10} style={{ display: 'inline', marginRight: 4 }} />
                                Nothing was written to the aircraft — it is safe to try again
                            </span>
                        )}
                    </>
                )}
            </div>
        </div>
    )
}

function btn(colour: string): React.CSSProperties {
    return {
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 13px', borderRadius: 8,
        background: 'transparent', border: `1px solid ${colour}66`,
        color: colour, fontSize: 11, fontFamily: 'monospace', fontWeight: 600,
        cursor: 'pointer',
    }
}
