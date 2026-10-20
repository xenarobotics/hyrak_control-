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
import { FOCUS } from '@/components/vision/panelStyle'

// The 3D scene needs literal colours (three.js cannot read CSS variables);
// the scene is drawn on its own dark-lit stage, so these stay fixed.
const ACTIVE_C = '#fbbf24'
const DONE_C = '#4ade80'
const FAIL_C = '#f87171'
const IDLE_C = '#22d3ee'

// Text and borders use the theme tokens, which pass contrast in both themes.
const T_ACTIVE = 'var(--app-warn)'
const T_DONE = 'var(--app-ok)'
const T_FAIL = 'var(--app-danger)'
const T_IDLE = 'var(--app-accent)'
const T_MUTED = 'hsl(var(--app-text-muted))'
const T_SUBTLE = 'hsl(var(--app-text-subtle))'
const textFor = (c: string) => c === ACTIVE_C ? T_ACTIVE : c === DONE_C ? T_DONE : c === FAIL_C ? T_FAIL : T_IDLE
const NUM: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' }

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

export function CalibrationStage({ state, onCancel, onDismiss, onRetry, onReboot }: {
    state: CalibrationState
    onCancel: () => void
    onDismiss: () => void
    onRetry: () => void
    /** Fired by the reboot prompt after a compass calibration. */
    onReboot?: () => void
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
    // finished agreeing. The autopilot still decides when the side is DONE -
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
    // panel - the words, the colour and the arrow cannot disagree.
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
    // is kept underneath rather than promoted - "hold vehicle still on a
    // pending side" is true and useless next to "On its LEFT side".
    const headline = idle ? 'Pick a calibration on the left'
        : done ? 'Calibration complete'
        : failed ? 'Calibration failed'
        : cancelled ? 'Calibration cancelled'
        : mode === 'rotate' ? 'Rotate it and keep turning'
        : mode === 'hold' ? 'Hold it still'
        : target ? `Turn it: ${SIDE_WORDS[target]}`
        : state.instruction || 'Waiting for the autopilot…'

    // PX4 applies a new compass calibration at BOOT - QGC prompts for the
    // reboot and so do we, or the operator flies on the old offsets while
    // the screen says calibrated.
    const wantsReboot = done && state.sensor === 'mag'

    const tone = textFor(accent)
    const subline = idle ? 'This model follows the real aircraft. Turn it and watch.'
        : wantsReboot ? 'Saved. Reboot before flying: PX4 loads compass changes at startup.'
        : done ? 'The new offsets are saved on the aircraft'
        : failed ? (state.error || 'The autopilot did not accept the calibration')
        : cancelled ? 'Nothing was written to the aircraft'
        : mode === 'rotate' ? 'Turn it steadily around the axis the arrow circles'
        : mode === 'hold' ? 'Keep it still until this position is ticked off'
        : mode === 'reorient' ? 'Match the position shown. The arrow shows which way.'
        : ''

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', gap: 12,
            padding: 16, borderRadius: 10,
            background: 'hsl(var(--app-surface-2))',
            border: `1px solid color-mix(in srgb, ${tone} 40%, transparent)`,
        }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {running ? <Loader size={16} className="animate-spin motion-reduce:animate-none" color={tone} aria-hidden />
                    : done ? <Check size={16} color={T_DONE} aria-hidden />
                    : failed ? <CircleAlert size={16} color={T_FAIL} aria-hidden />
                    : idle ? <Gauge size={16} color={tone} aria-hidden />
                    : <X size={16} color={T_MUTED} aria-hidden />}
                <span style={{ fontSize: 13, fontWeight: 700, color: tone }}>
                    {(() => { const t = state.label || state.sensor || 'Calibration'; return t.charAt(0).toUpperCase() + t.slice(1) })()}
                </span>
                {oriented && (
                    <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                        {/* SIX POSITIONS, EACH NAMED. Bare dots said how far
                            along the queue was and nothing about WHICH
                            positions were left - so an operator halfway
                            through could not tell whether they still owed it
                            nose-down or tail-down. Three letters is enough to
                            name it and short enough to fit. */}
                        <span style={{ display: 'flex', gap: 7 }}>
                            {order.map(side => {
                                const st = state.sides?.[side]
                                const c = st === 'done' ? T_DONE : st === 'active' ? T_ACTIVE : T_SUBTLE
                                return (
                                    <span key={side} title={SIDE_WORDS[side]} style={{
                                        display: 'flex', flexDirection: 'column',
                                        alignItems: 'center', gap: 3,
                                    }}>
                                        <span style={{
                                            width: 9, height: 9, borderRadius: '50%',
                                            background: st === 'done' || st === 'active' ? c : 'transparent',
                                            border: `1.5px solid ${c}`,
                                            transition: 'background-color var(--dur) var(--ease-out), border-color var(--dur) var(--ease-out)',
                                        }} />
                                        <span style={{
                                            fontSize: 12, color: st ? c : T_MUTED,
                                            fontWeight: st === 'active' ? 700 : 600,
                                        }}>
                                            {SIDE_ABBR[side]}
                                        </span>
                                    </span>
                                )
                            })}
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 700, ...NUM, color: T_MUTED }}>
                            {doneCount}/{order.length}
                        </span>
                    </span>
                )}
                {/* No number while nothing is running - an idle "0%" reads
                    as a stalled calibration. */}
                {!oriented && !idle && (
                    <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 700, ...NUM, color: T_MUTED }}>
                        {state.progress ?? 0}%
                    </span>
                )}
            </div>

            {/* Progress off a real number. No indefinite shimmer - a bar that
                moves on its own is a bar that lies about a stalled run. */}
            <div style={{ height: 4, borderRadius: 2, background: 'hsl(var(--app-surface))', overflow: 'hidden', opacity: idle ? 0 : 1 }}>
                <div style={{
                    height: '100%', width: '100%', transformOrigin: 'left',
                    transform: `scaleX(${Math.max(0, Math.min(100, state.progress ?? 0)) / 100})`,
                    background: tone, transition: 'transform var(--dur-slow) var(--ease-out)',
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
                        position: 'absolute', left: 12, bottom: 10, maxWidth: '60%',
                        fontSize: 13, color: T_MUTED,
                    }}>
                        No attitude data: showing the position to match
                    </span>
                )}
                <span style={{
                    position: 'absolute', right: 12, bottom: 10,
                    fontSize: 12, color: T_MUTED,
                }}>
                    Drag to orbit
                </span>
            </div>

            {/* One instruction */}
            <div>
                <p style={{
                    fontSize: 18, fontWeight: 700, margin: 0, lineHeight: 1.35,
                    color: failed ? T_FAIL : matched ? T_DONE : 'hsl(var(--app-text))',
                }}>
                    {headline}
                </p>
                {subline && (
                    <p style={{ fontSize: 13, margin: '4px 0 0', color: T_MUTED, lineHeight: 1.5 }}>
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
                    <p style={{ fontSize: 13, margin: '8px 0 0', lineHeight: 1.6, color: T_MUTED }}>
                        {doneList.length > 0 && (
                            <>
                                <span style={{ color: T_DONE, fontWeight: 700 }}>Done:</span>
                                <span> {doneList.join(', ')}</span>
                            </>
                        )}
                        {doneList.length > 0 && pendingList.length > 0 && <br />}
                        {pendingList.length > 0 && (
                            <>
                                <span style={{ fontWeight: 700 }}>Still to do:</span>
                                <span> {pendingList.join(', ')}</span>
                            </>
                        )}
                        {pendingList.length === 0 && doneList.length > 0 && (
                            <span style={{ color: T_DONE }}>. That was the last one.</span>
                        )}
                    </p>
                )}
                {/* THE AUTOPILOT'S OWN WORDS, small and last. When a firmware
                    changes wording the parser has not caught up with, this line
                    is the difference between a panel one release behind and a
                    panel that is lying. */}
                {state.detail && (
                    <p style={{ fontSize: 12, margin: '6px 0 0', color: T_MUTED, wordBreak: 'break-word' }}>
                        Flight controller: <span className="font-code">{state.detail}</span>
                    </p>
                )}
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {idle ? null : running ? (
                    <button type="button" onClick={onCancel} style={btn(T_FAIL)} className={FOCUS}
                        title="Stops the routine on the aircraft as well as here">
                        <X size={14} aria-hidden /> Cancel
                    </button>
                ) : (
                    <>
                        {wantsReboot && onReboot && (
                            <button type="button" onClick={() => { onReboot(); onDismiss() }} style={btn(T_ACTIVE)} className={FOCUS}
                                title="Restarts the flight controller. Only works while disarmed; the link drops and reconnects.">
                                <RotateCw size={14} aria-hidden /> Reboot flight controller
                            </button>
                        )}
                        <button type="button" onClick={onDismiss} style={btn(T_IDLE)} className={FOCUS}>
                            <Check size={14} aria-hidden /> {wantsReboot ? 'Later' : 'Done'}
                        </button>
                        {(failed || cancelled) && (
                            <button type="button" onClick={onRetry} style={btn(T_ACTIVE)} className={FOCUS}>
                                <RotateCw size={14} aria-hidden /> Try again
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
        minHeight: 32, padding: '0 14px', borderRadius: 6,
        background: 'transparent', border: `1px solid color-mix(in srgb, ${colour} 55%, transparent)`,
        color: colour, fontSize: 14, fontWeight: 600,
        cursor: 'pointer',
    }
}
