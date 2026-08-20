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

import { DroneScene, orientationFor, type StageMode } from '@/components/config/DroneScene'
import { useDroneStore } from '@/store/drone'
import type { CalibrationState, CalSide } from '@/types/calibration'
import { Check, X, Loader, CircleAlert, RotateCw, Gauge } from 'lucide-react'
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

/** Short names for the done / still-to-do lists. Long enough to be a
 *  position, short enough that six of them fit on one line. */
const SIDE_SHORT: Record<CalSide, string> = {
    down: 'level', up: 'inverted', left: 'left side', right: 'right side',
    front: 'nose down', back: 'tail down',
}

/** Three letters per position, so the queue names itself. */
const SIDE_ABBR: Record<CalSide, string> = {
    down: 'LVL', up: 'INV', left: 'LFT', right: 'RGT', front: 'NSE', back: 'TAL',
}

/** How close counts as holding the requested position. Generous: PX4's own
 *  detector is looser than this, so a "hold it there" that appeared only at a
 *  tighter tolerance than the autopilot's would have the operator still
 *  adjusting while the calibration was already counting. */
const MATCH_DEGREES = 22

export function CalibrationStage({ state, onCancel, onDismiss, onRetry, children }: {
    state: CalibrationState
    onCancel: () => void
    onDismiss: () => void
    onRetry: () => void
    /** The calibration options, rendered underneath the aircraft. */
    children?: React.ReactNode
}) {
    const attitude = useDroneStore(s => s.telemetry?.attitude)
    const idle = state.phase === 'idle'
    const running = state.phase === 'starting' || state.phase === 'running'
    const failed = state.phase === 'failed'
    const done = state.phase === 'done'
    const cancelled = state.phase === 'cancelled'

    const order = (state.side_order ?? ['down', 'up', 'left', 'right', 'front', 'back']) as CalSide[]
    const oriented = Object.keys(state.sides ?? {}).length > 0
    const doneCount = order.filter(s => state.sides?.[s] === 'done').length
    const doneList = order.filter(s => state.sides?.[s] === 'done').map(s => SIDE_SHORT[s])
    const pendingList = order.filter(s => state.sides?.[s] === 'pending').map(s => SIDE_SHORT[s])
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

    // WHAT IS BEING ASKED FOR, decided once and used by every part of the
    // panel — the words, the colour and the arrow cannot disagree.
    //
    // A COMPASS IS NOT AN ACCELEROMETER. PX4 detects an orientation and then
    // wants the aircraft ROTATED about it; an accelerometer wants it held dead
    // still in the same position. Reaching the position therefore means
    // opposite things for the two, which is why arriving used to make the
    // arrow disappear on a compass at exactly the moment it became the
    // instruction.
    const isCompass = state.sensor === 'mag'
    const mode: StageMode = !running || !target ? 'idle'
        : !matched ? 'reorient'
        : isCompass ? 'rotate'
        : 'hold'

    const accent = failed ? FAIL_C
        : done ? DONE_C
        : mode === 'rotate' ? ACTIVE_C
        : mode === 'hold' ? DONE_C
        : running ? ACTIVE_C : IDLE_C

    // ONE SENTENCE, and it is the position when there is one. PX4's own line
    // is kept underneath rather than promoted — "hold vehicle still on a
    // pending side" is true and useless next to "On its LEFT side".
    const headline = idle ? 'Pick a calibration below'
        : done ? 'Calibration complete'
        : failed ? 'Calibration failed'
        : cancelled ? 'Calibration cancelled'
        : mode === 'rotate' ? 'Now ROTATE it — keep turning'
        : mode === 'hold' ? 'HOLD IT STILL'
        : target ? `Turn it: ${SIDE_WORDS[target]}`
        : state.instruction || 'Waiting for the autopilot…'

    const subline = idle ? 'The aircraft above follows your live attitude — turn the real one and it turns with it'
        : done ? 'The new offsets are saved on the aircraft'
        : failed ? (state.error || 'The autopilot did not accept the calibration')
        : cancelled ? 'Nothing was written to the aircraft'
        : mode === 'rotate' ? 'Turn it steadily about the axis the arrow circles, at about the speed shown'
        : mode === 'hold' ? 'Do not move it until this position is ticked off'
        : mode === 'reorient' ? 'Match the position shown — the arrow is the way round'
        : ''

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', gap: 12,
            padding: 16, borderRadius: 12,
            background: 'hsl(var(--app-surface-2))',
            border: `1px solid ${accent}44`,
        }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                {running ? <Loader size={14} className="animate-spin" color={accent} />
                    : done ? <Check size={15} color={DONE_C} />
                    : failed ? <CircleAlert size={15} color={FAIL_C} />
                    : idle ? <Gauge size={14} color={accent} />
                    : <X size={15} color="#6b7280" />}
                <span style={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 700, color: accent, letterSpacing: 0.4 }}>
                    {(state.label || state.sensor || 'CALIBRATION').toUpperCase()}
                </span>
                {oriented && (
                    <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                        {/* SIX POSITIONS, EACH NAMED. Bare dots said how far
                            along the queue was and nothing about WHICH
                            positions were left — so an operator halfway
                            through could not tell whether they still owed it
                            nose-down or tail-down. Three letters is enough to
                            name it and short enough to fit. */}
                        <span style={{ display: 'flex', gap: 7 }}>
                            {order.map(side => {
                                const st = state.sides?.[side]
                                const c = st === 'done' ? DONE_C : st === 'active' ? ACTIVE_C : '#4b5563'
                                return (
                                    <span key={side} title={SIDE_WORDS[side]} style={{
                                        display: 'flex', flexDirection: 'column',
                                        alignItems: 'center', gap: 3,
                                    }}>
                                        <span style={{
                                            width: 9, height: 9, borderRadius: '50%',
                                            background: st === 'done' ? DONE_C : st === 'active' ? ACTIVE_C : 'transparent',
                                            border: `1.5px solid ${c}`,
                                            transition: 'background 250ms, border-color 250ms',
                                        }} />
                                        <span style={{
                                            fontSize: 8.5, fontFamily: 'monospace', color: c,
                                            fontWeight: st === 'active' ? 700 : 400, letterSpacing: 0.3,
                                        }}>
                                            {SIDE_ABBR[side]}
                                        </span>
                                    </span>
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
            <div style={{ height: 4, borderRadius: 2, background: 'hsl(var(--app-surface))', overflow: 'hidden', opacity: idle ? 0 : 1 }}>
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
                    mode={mode}
                    accent={accent}
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
                {/* NAMED, not just counted. "2/6" says how far along the queue
                    is and nothing about which positions are still owed, so an
                    operator halfway through cannot tell whether they have
                    already done nose-down. The dots carry the same fact as
                    colour; this carries it as words, which is what someone
                    reads when they are trying to plan the next move. */}
                {running && oriented && (
                    <p style={{ fontSize: 11, margin: '7px 0 0', lineHeight: 1.6, fontFamily: 'monospace' }}>
                        {doneList.length > 0 && (
                            <>
                                <span style={{ color: DONE_C }}>Done</span>
                                <span style={{ color: 'hsl(var(--app-text-muted))' }}> {doneList.join(' · ')}</span>
                            </>
                        )}
                        {doneList.length > 0 && pendingList.length > 0 && (
                            <span style={{ color: 'hsl(var(--app-text-muted))' }}>{'   '}</span>
                        )}
                        {pendingList.length > 0 && (
                            <>
                                <span style={{ color: '#94a3b8' }}>Still to do</span>
                                <span style={{ color: 'hsl(var(--app-text-muted))' }}> {pendingList.join(' · ')}</span>
                            </>
                        )}
                        {pendingList.length === 0 && doneList.length > 0 && (
                            <span style={{ color: DONE_C }}>   — that was the last one</span>
                        )}
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
                {idle ? null : running ? (
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

            {children}
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
