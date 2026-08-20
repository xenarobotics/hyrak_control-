'use client'

// What the operator looks at while holding an aircraft.
//
// SIMPLER THAN THE FIRST ATTEMPT, ON PURPOSE. That one showed six labelled
// side chips at once and asked the operator to work out which of them was
// being requested. QGroundControl asks for one position at a time and that is
// the right shape: a calibration is a queue, not a dashboard. Six dots say how
// far along it is; the aircraft and the arrow say what to do next.
//
// ONE RULE RUNS THROUGH ALL OF IT: nothing here may show progress the
// autopilot has not reported. A dot fills because PX4 said that side is done,
// never because an animation reached the end of its loop.

import { useMemo } from 'react'

import { DroneScene } from '@/components/config/DroneScene'
import { orientationFor } from '@/components/config/DroneScene'
import { useDroneStore } from '@/store/drone'
import type { CalibrationState, CalSide } from '@/types/calibration'
import { Check, X, Loader, CircleAlert, RotateCw } from 'lucide-react'
import * as THREE from 'three'

const ACTIVE_C = '#fbbf24'
const DONE_C = '#4ade80'
const FAIL_C = '#f87171'
const IDLE_C = '#22d3ee'

/** Plain-language name for the position being asked for. "back" and "front"
 *  name which face points DOWN and read backwards to most people the first
 *  time, so the words on screen describe the aircraft, not the enum. */
const SIDE_WORDS: Record<CalSide, string> = {
    down: 'Level, sitting normally',
    up: 'Upside down',
    left: 'On its LEFT side',
    right: 'On its RIGHT side',
    front: 'Nose down, tail up',
    back: 'Tail down, nose up',
}

/** How close counts as holding the requested position. Generous: PX4's own
 *  detector is looser than this, so a "hold it there" that appeared only at a
 *  tighter tolerance than the autopilot's would have the operator still
 *  adjusting while the calibration was already counting. */
const MATCH_DEGREES = 22

export function CalibrationStage({ state, onCancel, onDismiss, onRetry }: {
    state: CalibrationState
    onCancel: () => void
    onDismiss: () => void
    onRetry: () => void
}) {
    const attitude = useDroneStore(s => s.telemetry?.attitude)
    const running = state.phase === 'starting' || state.phase === 'running'
    const failed = state.phase === 'failed'
    const done = state.phase === 'done'
    const cancelled = state.phase === 'cancelled'

    const order = (state.side_order ?? ['down', 'up', 'left', 'right', 'front', 'back']) as CalSide[]
    const oriented = Object.keys(state.sides ?? {}).length > 0
    const doneCount = order.filter(s => state.sides?.[s] === 'done').length
    const target = (state.active_side ?? null) as CalSide | null

    const live = attitude
        ? { roll: attitude.roll_deg ?? 0, pitch: attitude.pitch_deg ?? 0, yaw: attitude.yaw_deg ?? 0 }
        : null

    // IS THE OPERATOR ALREADY HOLDING IT RIGHT? Answered from the IMU rather
    // than waited for from PX4, so the aircraft turns green the moment the
    // position is reached instead of a second later when the autopilot has
    // finished agreeing. The autopilot still decides when the side is DONE —
    // this only decides when to stop telling them to keep turning.
    const matched = useMemo(() => {
        if (!target || !live) return false
        const e = new THREE.Euler(
            THREE.MathUtils.degToRad(live.pitch),
            THREE.MathUtils.degToRad(-live.yaw),
            THREE.MathUtils.degToRad(-live.roll),
            'YXZ',
        )
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion().setFromEuler(e))
        const want = new THREE.Vector3(0, 1, 0).applyQuaternion(orientationFor(target))
        return THREE.MathUtils.radToDeg(up.angleTo(want)) < MATCH_DEGREES
    }, [target, live?.roll, live?.pitch, live?.yaw])

    const accent = failed ? FAIL_C : done ? DONE_C : matched ? DONE_C : running ? ACTIVE_C : IDLE_C

    // ONE SENTENCE, and it is the position when there is one. PX4's own line
    // is kept underneath rather than promoted — "hold vehicle still on a
    // pending side" is true and useless next to "On its LEFT side".
    const headline = done ? 'Calibration complete'
        : failed ? 'Calibration failed'
        : cancelled ? 'Calibration cancelled'
        : target ? SIDE_WORDS[target]
        : state.instruction || 'Waiting for the autopilot…'

    const subline = done ? 'The new offsets are saved on the aircraft'
        : failed ? (state.error || 'The autopilot did not accept the calibration')
        : cancelled ? 'Nothing was written to the aircraft'
        : target ? (matched ? 'Hold it there — do not move it' : 'Turn the aircraft to match the outline')
        : ''

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', gap: 12,
            padding: 16, borderRadius: 12,
            background: 'hsl(var(--app-surface-2))',
            border: `1px solid ${accent}44`,
            // Capped and centred. Left to fill a wide monitor the aircraft
            // ends up a small object adrift in a very large empty box, which
            // is the same legibility problem as drawing it too small.
            maxWidth: 1020, width: '100%', margin: '0 auto',
        }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                {running ? <Loader size={14} className="animate-spin" color={accent} />
                    : done ? <Check size={15} color={DONE_C} />
                    : failed ? <CircleAlert size={15} color={FAIL_C} />
                    : <X size={15} color="#6b7280" />}
                <span style={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 700, color: accent, letterSpacing: 0.4 }}>
                    {(state.label || state.sensor).toUpperCase()}
                </span>
                {oriented && (
                    <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                        {/* Six dots. Position in the queue, nothing else — the
                            first version labelled all six and made the operator
                            hunt for the one being asked for. */}
                        <span style={{ display: 'flex', gap: 4 }}>
                            {order.map(side => {
                                const st = state.sides?.[side]
                                return (
                                    <span key={side} style={{
                                        width: 8, height: 8, borderRadius: '50%',
                                        background: st === 'done' ? DONE_C : st === 'active' ? ACTIVE_C : 'transparent',
                                        border: `1.5px solid ${st === 'done' ? DONE_C : st === 'active' ? ACTIVE_C : '#4b5563'}`,
                                        transition: 'background 250ms, border-color 250ms',
                                    }} />
                                )
                            })}
                        </span>
                        <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>
                            {doneCount}/{order.length}
                        </span>
                    </span>
                )}
                {!oriented && (
                    <span style={{ marginLeft: 'auto', fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>
                        {state.progress ?? 0}%
                    </span>
                )}
            </div>

            {/* Progress off a real number. No indefinite shimmer — a bar that
                moves on its own is a bar that lies about a stalled run. */}
            <div style={{ height: 4, borderRadius: 2, background: 'hsl(var(--app-surface))', overflow: 'hidden' }}>
                <div style={{
                    height: '100%', width: `${Math.max(0, Math.min(100, state.progress ?? 0))}%`,
                    background: accent, transition: 'width 400ms ease-out',
                }} />
            </div>

            {/* The aircraft */}
            <div style={{ position: 'relative' }}>
                <DroneScene
                    attitude={live}
                    targetSide={running ? target : null}
                    accent={accent}
                    matched={matched}
                    live={running}
                    height={430}
                />
                {!live && running && (
                    <span style={{
                        position: 'absolute', left: 12, bottom: 10,
                        fontSize: 10, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))',
                    }}>
                        No attitude telemetry — showing the requested position instead of the live one
                    </span>
                )}
                <span style={{
                    position: 'absolute', right: 12, bottom: 10,
                    fontSize: 10, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))',
                }}>
                    drag to orbit
                </span>
            </div>

            {/* One instruction */}
            <div>
                <p style={{
                    fontSize: 17, fontWeight: 600, margin: 0, lineHeight: 1.35,
                    color: failed ? FAIL_C : matched ? DONE_C : 'hsl(var(--app-text))',
                }}>
                    {headline}
                </p>
                {subline && (
                    <p style={{ fontSize: 12, margin: '4px 0 0', color: 'hsl(var(--app-text-muted))', lineHeight: 1.5 }}>
                        {subline}
                    </p>
                )}
                {/* THE AUTOPILOT'S OWN WORDS, small and last. When a firmware
                    changes wording the parser has not caught up with, this line
                    is the difference between a panel one release behind and a
                    panel that is lying. */}
                {state.detail && (
                    <p style={{ fontSize: 10, fontFamily: 'monospace', margin: '6px 0 0', color: 'hsl(var(--app-text-muted))', opacity: 0.75, wordBreak: 'break-word' }}>
                        FC: {state.detail}
                    </p>
                )}
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {running ? (
                    <button onClick={onCancel} style={btn(FAIL_C)}
                        title="Stops the routine on the aircraft as well as here">
                        <X size={12} /> CANCEL
                    </button>
                ) : (
                    <>
                        <button onClick={onDismiss} style={btn(IDLE_C)}>
                            <Check size={12} /> DONE
                        </button>
                        {(failed || cancelled) && (
                            <button onClick={onRetry} style={btn(ACTIVE_C)}>
                                <RotateCw size={12} /> TRY AGAIN
                            </button>
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
        padding: '7px 15px', borderRadius: 8,
        background: 'transparent', border: `1px solid ${colour}66`,
        color: colour, fontSize: 11, fontFamily: 'monospace', fontWeight: 600,
        cursor: 'pointer',
    }
}
